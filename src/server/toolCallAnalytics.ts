import type { ToolCallsResponse } from "../shared/sessionSchemas.ts";
import { z } from "zod";

const commandInputSchema = z.union([
  z.string(),
  z.object({
    command: z.string().optional(),
    cmd: z.string().optional(),
  }),
]);

export type ToolCallObservation = {
  modelCallID: number;
  name: string;
  inputPreview?: string;
  startedAt?: number;
  completedAt?: number;
  modelStartedAt: number;
  modelCompletedAt?: number;
};

function commandFromInput(input?: string) {
  if (!input) return undefined;
  let command: string | undefined;
  try {
    const parsed = commandInputSchema.safeParse(JSON.parse(input));
    if (parsed.success) {
      command = typeof parsed.data === "string"
        ? parsed.data
        : parsed.data.command ?? parsed.data.cmd;
    }
  } catch {
    // Truncated JSON and Codex's JavaScript wrapper are handled below.
  }
  if (command === undefined) {
    const embedded = input.match(
      /(?:["']?(?:command|cmd)["']?)\s*:\s*["']([^"']*)/i,
    );
    command = embedded?.[1] ?? input;
  }
  const match = command.trim().match(/^(?:["']([^"']+)["']|([^\s;&|]+))/);
  const executable = match?.[1] ?? match?.[2];
  return executable?.split(/[\\/]/).at(-1);
}

export function toolGroupName(
  name: string,
  inputPreview: string | undefined,
  expandTools: boolean,
) {
  const normalized = name.toLowerCase();
  const expandable = normalized === "bash" ||
    normalized.includes("exec_command");
  if (!expandable) return name;
  const command = expandTools ? commandFromInput(inputPreview) : undefined;
  const baseName = normalized === "bash" ? "bash" : name;
  return command ? `${baseName} ${command}` : baseName;
}

function percentile(sorted: number[], quantile: number) {
  if (sorted.length === 1) return sorted[0];
  const index = (sorted.length - 1) * quantile;
  const lower = Math.floor(index);
  const remainder = index - lower;
  return sorted[lower] + (sorted[lower + 1] - sorted[lower]) * remainder;
}

function distribution(values: number[]) {
  if (values.length === 0) return undefined;
  const sorted = values.toSorted((a, b) => a - b);
  return {
    average: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
  };
}

export function aggregateToolCalls(
  calls: ToolCallObservation[],
  rangeDays: 7 | 30 | 90,
  startAt: number,
  endAt: number,
  expanded: boolean,
): ToolCallsResponse {
  type Group = {
    count: number;
    toolRuntimes: number[];
    modelCallIDs: Set<number>;
    modelRuntimes: Map<number, number>;
  };
  const groups = new Map<string, Group>();
  for (const call of calls) {
    const name = toolGroupName(call.name, call.inputPreview, expanded);
    const group: Group = groups.get(name) ?? {
      count: 0,
      toolRuntimes: [],
      modelCallIDs: new Set(),
      modelRuntimes: new Map(),
    };
    group.count++;
    group.modelCallIDs.add(call.modelCallID);
    if (
      call.startedAt !== undefined && call.completedAt !== undefined &&
      call.completedAt >= call.startedAt
    ) group.toolRuntimes.push(call.completedAt - call.startedAt);
    if (
      call.modelCompletedAt !== undefined &&
      call.modelCompletedAt >= call.modelStartedAt
    ) {
      group.modelRuntimes.set(
        call.modelCallID,
        call.modelCompletedAt - call.modelStartedAt,
      );
    }
    groups.set(name, group);
  }
  return {
    rangeDays,
    startAt,
    endAt,
    expanded,
    tools: [...groups.entries()].map(([tool, group]) => ({
      tool,
      count: group.count,
      modelCalls: group.modelCallIDs.size,
      callsPerModelCall: group.count / group.modelCallIDs.size,
      toolRuntime: distribution(group.toolRuntimes),
      modelRuntime: distribution([...group.modelRuntimes.values()]),
    })).sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool)),
  };
}
