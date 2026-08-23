import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { importedTitleNeedsGeneration } from "./sessionTitles.ts";
import { formatTiming } from "./timing.ts";

const enabledKey = "generate_session_titles";
const enabledAtKey = "generate_session_titles_enabled_at";
const model = "gpt-5.6-luna";
const reasoningEffort = "low";
const backfillTarget = 25;
const generationBatchSize = 10;

type Candidate = {
  id: number;
  harness: "pi" | "claude-code" | "codex" | "opencode";
  imported_title: string;
  input: string;
};

type Usage = {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
};

const codexOutputEventSchema = z.object({
  type: z.string(),
  item: z.object({
    type: z.string(),
    text: z.string().optional(),
  }).optional(),
  usage: z.object({
    input_tokens: z.number().optional(),
    cached_input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
  }).optional(),
});

function setting(db: DatabaseSync, key: string) {
  return (db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined)?.value;
}

function setSetting(db: DatabaseSync, key: string, value: string) {
  db.prepare(`
    INSERT INTO app_settings (key, value) VALUES (?, ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

export function titleGenerationEnabled(db: DatabaseSync) {
  return setting(db, enabledKey) === "true";
}

export function setTitleGenerationEnabled(
  db: DatabaseSync,
  enabled: boolean,
) {
  const wasEnabled = titleGenerationEnabled(db);
  setSetting(db, enabledKey, String(enabled));
  if (enabled && !wasEnabled && setting(db, enabledAtKey) === undefined) {
    setSetting(db, enabledAtKey, String(Date.now()));
  }
}

function candidateRows(
  db: DatabaseSync,
  period: "backfill" | "new",
): Candidate[] {
  const enabledAt = Number(setting(db, enabledAtKey) ?? Date.now());
  const comparison = period === "backfill" ? "<" : ">=";
  return db.prepare(`
    SELECT ss.id, so.harness, c.title AS imported_title,
      (
        SELECT entry.content_preview
        FROM conversation_entries entry
        WHERE entry.conversation_id = c.id
          AND entry.role = 'user' AND entry.content_kind = 'text'
          AND TRIM(COALESCE(entry.content_preview, '')) <> ''
        ORDER BY entry.id
        LIMIT 1
      ) AS input
    FROM conversations c
    JOIN sources so ON so.id = c.source_id
    JOIN conversation_branches branch ON branch.id = (
      SELECT candidate.id
      FROM conversation_branches candidate
      WHERE candidate.conversation_id = c.id
      ORDER BY candidate.updated_at DESC, candidate.id DESC
      LIMIT 1
    )
    JOIN source_sessions ss ON ss.id = branch.source_session_id
    WHERE ss.generated_title IS NULL
      AND so.harness IN ('pi', 'claude-code', 'codex', 'opencode')
      AND ss.first_seen_at ${comparison} ?
      AND NOT EXISTS (
        SELECT 1 FROM conversation_subagent_launches launch
        WHERE launch.child_conversation_id = c.id
      )
      AND EXISTS (
        SELECT 1 FROM conversation_entries entry
        WHERE entry.conversation_id = c.id
          AND entry.role = 'user' AND entry.content_kind = 'text'
          AND TRIM(COALESCE(entry.content_preview, '')) <> ''
      )
    ORDER BY c.updated_at DESC, ss.id DESC
  `).all(enabledAt) as Candidate[];
}

function completedBackfillCount(db: DatabaseSync) {
  const enabledAt = Number(setting(db, enabledAtKey) ?? Date.now());
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM source_sessions ss
    JOIN sources so ON so.id = ss.source_id
    WHERE ss.generated_title IS NOT NULL
      AND ss.first_seen_at < ?
      AND so.harness IN ('pi', 'claude-code', 'codex', 'opencode')
      AND EXISTS (
        SELECT 1 FROM conversation_branches branch
        WHERE branch.source_session_id = ss.id
      )
  `).get(enabledAt) as { count: number };
  return row.count;
}

export function titleGenerationEligible(
  candidate: Pick<Candidate, "imported_title" | "input">,
) {
  return importedTitleNeedsGeneration(
    candidate.imported_title,
    candidate.input,
  );
}

function parseCodexOutput(stdout: string) {
  let title: string | undefined;
  const usage: Usage = {};
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let event: z.infer<typeof codexOutputEventSchema>;
    try {
      const parsed = codexOutputEventSchema.safeParse(JSON.parse(line));
      if (!parsed.success) continue;
      event = parsed.data;
    } catch {
      continue;
    }
    const item = event.item;
    if (
      event.type === "item.completed" && item?.type === "agent_message" &&
      item.text !== undefined
    ) title = item.text;
    if (event.type === "turn.completed") {
      const tokens = event.usage;
      if (tokens?.input_tokens !== undefined) {
        usage.inputTokens = tokens.input_tokens;
      }
      if (tokens?.cached_input_tokens !== undefined) {
        usage.cachedInputTokens = tokens.cached_input_tokens;
      }
      if (tokens?.output_tokens !== undefined) {
        usage.outputTokens = tokens.output_tokens;
      }
    }
  }
  return { title, usage };
}

function normalizedTitle(value: string | undefined) {
  const title = value?.replace(/\s+/g, " ").trim()
    .replace(/^["“”']+|["“”']+$/g, "");
  if (!title) throw new Error("Codex returned an empty title");
  return title.slice(0, 160);
}

async function generateTitle(input: string) {
  const prompt =
    `Summarize the user's main request as a concise, natural title. Distinguish the request from background or pasted context, prioritizing the user's explicit question or instruction. Do not invent actions or outcomes. Preserve useful names. Return only the title.\n\n<user_input>\n${input}\n</user_input>`;
  const command = new Deno.Command("codex", {
    args: [
      "exec",
      "--model",
      model,
      "--config",
      `model_reasoning_effort=\"${reasoningEffort}\"`,
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--color",
      "never",
      "--json",
      prompt,
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  const stdout = new TextDecoder().decode(output.stdout);
  const stderr = new TextDecoder().decode(output.stderr).trim();
  const parsed = parseCodexOutput(stdout);
  if (!output.success) {
    throw Object.assign(
      new Error(stderr || `Codex exited with status ${output.code}`),
      { exitCode: output.code, usage: parsed.usage },
    );
  }
  return {
    title: normalizedTitle(parsed.title),
    usage: parsed.usage,
    exitCode: output.code,
  };
}

async function generateCandidateTitle(db: DatabaseSync, candidate: Candidate) {
  if (!titleGenerationEnabled(db)) return;

  const startedAt = Date.now();
  const runID = Number(
    (db.prepare(`
      INSERT INTO title_generation_runs (
        source_session_id, started_at, status, model, reasoning_effort,
        input_characters
      ) VALUES (?, ?, 'running', ?, ?, ?)
      RETURNING id
    `).get(
      candidate.id,
      startedAt,
      model,
      reasoningEffort,
      candidate.input.length,
    ) as { id: number }).id,
  );

  try {
    const result = await generateTitle(candidate.input);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(`
        UPDATE source_sessions SET generated_title = ? WHERE id = ?
      `).run(result.title, candidate.id);
      db.prepare(`
        UPDATE title_generation_runs
        SET completed_at = ?, status = 'succeeded', output_title = ?,
          input_tokens = ?, cached_input_tokens = ?, output_tokens = ?,
          exit_code = ?
        WHERE id = ?
      `).run(
        Date.now(),
        result.title,
        result.usage.inputTokens ?? null,
        result.usage.cachedInputTokens ?? null,
        result.usage.outputTokens ?? null,
        result.exitCode,
        runID,
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    console.info(
      `[generate titles] harness=${candidate.harness} sourceSession=${candidate.id} status=succeeded title=${
        JSON.stringify(result.title)
      } runtime=${formatTiming(Date.now() - startedAt)}`,
    );
  } catch (error) {
    const detail = error as Error & { exitCode?: number; usage?: Usage };
    db.prepare(`
      UPDATE title_generation_runs
      SET completed_at = ?, status = 'failed', input_tokens = ?,
        cached_input_tokens = ?, output_tokens = ?, exit_code = ?, error = ?
      WHERE id = ?
    `).run(
      Date.now(),
      detail.usage?.inputTokens ?? null,
      detail.usage?.cachedInputTokens ?? null,
      detail.usage?.outputTokens ?? null,
      detail.exitCode ?? null,
      detail.message,
      runID,
    );
    console.error(
      `[generate titles] harness=${candidate.harness} sourceSession=${candidate.id} status=failed runtime=${
        formatTiming(Date.now() - startedAt)
      } error=${detail.message}`,
    );
  }
}

export async function generateMissingSessionTitles(db: DatabaseSync) {
  if (!titleGenerationEnabled(db)) return;
  const remainingBackfill = Math.max(
    0,
    backfillTarget - completedBackfillCount(db),
  );
  const backfill = candidateRows(db, "backfill").filter(titleGenerationEligible)
    .slice(
      0,
      remainingBackfill,
    );
  const candidates = [
    ...backfill,
    ...candidateRows(db, "new").filter(titleGenerationEligible),
  ];

  for (let index = 0; index < candidates.length; index += generationBatchSize) {
    if (!titleGenerationEnabled(db)) break;
    await Promise.all(
      candidates.slice(index, index + generationBatchSize).map((candidate) =>
        generateCandidateTitle(db, candidate)
      ),
    );
  }
}
