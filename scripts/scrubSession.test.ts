import {
  deepStrictEqual,
  ok,
  rejects,
  strictEqual,
  throws,
} from "node:assert/strict";
import { join } from "node:path";
import { scrubFile, scrubSession } from "./scrubSession.ts";
import {
  CLIPBOARD_IMAGE_TEXT,
  isClipboardImageReference,
  SYNTHETIC_IMAGE_DATA,
  SYNTHETIC_IMAGE_MIME_TYPE,
} from "./scrubSession.ts";
import { normalizePiSession } from "../src/server/piRepository.ts";
import { normalizeCodexSession } from "../src/server/codexRepository.ts";

const secret = "PRIVATE_SOURCE_AND_CREDENTIAL";
const jsonl = (rows: unknown[]) =>
  rows.map((row) => JSON.stringify(row)).join("\n");
const pi = jsonl([
  {
    type: "session",
    id: secret,
    timestamp: "2026-07-25T12:00:00Z",
    cwd: `/private/${secret}`,
  },
  {
    type: "message",
    id: "assistant",
    parentId: secret,
    timestamp: "2026-07-25T12:00:01Z",
    message: {
      role: "assistant",
      timestamp: Date.parse("2026-07-25T12:00:01Z"),
      content: [
        { type: "thinking", thinking: secret, thinkingSignature: secret },
        {
          type: "toolCall",
          id: "call",
          name: "read",
          arguments: { path: `/private/${secret}` },
        },
      ],
      usage: {
        input: 25000,
        output: 20,
        cacheRead: 1000,
        cost: { total: 0.25 },
      },
      responseId: secret,
    },
  },
  {
    type: "message",
    id: "result",
    parentId: "assistant",
    timestamp: "2026-07-25T12:00:02Z",
    message: {
      role: "toolResult",
      toolCallId: "call",
      toolName: "read",
      content: [{ type: "text", text: secret }],
      details: { secret },
    },
  },
]);

Deno.test("scrubs Pi content while preserving links, paths, usage, and time gaps", () => {
  const result = scrubSession("pi", pi, "example");
  ok(!result.jsonl.includes(secret));
  ok(result.omittedFields > 0);
  const rows = result.jsonl.trim().split("\n").map((line) => JSON.parse(line));
  strictEqual(rows[0].timestamp, "2026-01-15T12:00:00.000Z");
  strictEqual(rows[1].parentId, rows[0].id);
  strictEqual(rows[2].parentId, rows[1].id);
  strictEqual(rows[1].message.content[1].arguments.path, rows[0].cwd);
  strictEqual(rows[1].message.content[1].id, rows[2].message.toolCallId);
  strictEqual(rows[1].message.timestamp, Date.parse(rows[1].timestamp));
  strictEqual(
    Date.parse(rows[2].timestamp) - Date.parse(rows[0].timestamp),
    2000,
  );
  deepStrictEqual(rows[1].message.usage, {
    input: 25000,
    output: 20,
    cacheRead: 1000,
    cost: { total: 0.25 },
  });
  strictEqual(result.jsonl, scrubSession("pi", pi, "example").jsonl);
  ok(!scrubSession("pi", pi, "another").jsonl.includes('"example-id-1"'));
});

Deno.test("scrubs batched edit arguments without retaining patches", () => {
  const source = jsonl([
    { type: "session", timestamp: "2026-07-25T12:00:00Z" },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{
          type: "toolCall",
          id: "edit-1",
          name: "edit",
          arguments: {
            path: `/private/${secret}`,
            edits: [{ oldText: secret, newText: secret }],
          },
        }],
      },
    },
  ]);
  const result = scrubSession("pi", source, "edits");
  ok(!result.jsonl.includes(secret));
  const call =
    JSON.parse(result.jsonl.trim().split("\n")[1]).message.content[0];
  strictEqual(call.name, "edit");
  deepStrictEqual(call.arguments.edits, [{
    oldText: "Original example content.",
    newText: "Updated example content.",
  }]);
  throws(() =>
    scrubSession("pi", source.replace('"oldText":', '"unknown":'), "edits")
  );
});

Deno.test("scrubs Codex outputs and metadata, retaining reasoning and numeric timing", () => {
  const source = jsonl([
    {
      type: "session_meta",
      timestamp: "2026-08-01T00:00:00Z",
      payload: {
        id: secret,
        cwd: `/private/${secret}`,
        git: { repository_url: secret },
        base_instructions: { text: secret },
      },
    },
    {
      type: "turn_context",
      timestamp: "2026-08-01T00:00:01Z",
      payload: {
        model: "gpt-5.6-sol",
        effort: "low",
        thread_settings: {
          reasoning_effort: "medium",
          collaboration_mode: {
            mode: "default",
            settings: {
              reasoning_effort: "medium",
              developer_instructions: secret,
            },
          },
        },
      },
    },
    {
      type: "response_item",
      timestamp: "2026-08-01T00:00:02Z",
      payload: {
        type: "custom_tool_call",
        name: "exec",
        call_id: secret,
        input: secret,
      },
    },
    {
      type: "response_item",
      timestamp: "2026-08-01T00:00:03Z",
      payload: {
        type: "custom_tool_call_output",
        call_id: secret,
        output: [{ type: "input_text", text: secret }],
      },
    },
    {
      type: "event_msg",
      timestamp: "2026-08-01T00:00:04Z",
      payload: {
        type: "task_complete",
        started_at: Date.parse("2026-08-01T00:00:01Z") / 1000,
        completed_at_ms: Date.parse("2026-08-01T00:00:04Z"),
        duration_ms: 3000,
        last_agent_message: secret,
      },
    },
    {
      type: "event_msg",
      timestamp: "2026-08-01T00:00:04Z",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: { input_tokens: 50000, cached_input_tokens: 0 },
        },
        rate_limits: { secret },
      },
    },
  ]);
  const result = scrubSession("codex", source, "codex-example");
  ok(!result.jsonl.includes(secret));
  const rows = result.jsonl.trim().split("\n").map((line) => JSON.parse(line));
  strictEqual(rows[2].payload.call_id, rows[3].payload.call_id);
  strictEqual(rows[1].payload.thread_settings.reasoning_effort, "medium");
  strictEqual(
    rows[4].payload.completed_at_ms - rows[4].payload.started_at * 1000,
    3000,
  );
  strictEqual(rows[4].payload.duration_ms, 3000);
  strictEqual(rows[5].payload.info.last_token_usage.input_tokens, 50000);
});

Deno.test("scrubs Pi compactions while retaining boundaries and summary usage", () => {
  const source = jsonl([
    { type: "session", id: "root", timestamp: "2026-07-25T12:00:00Z" },
    { type: "thinking_level_change", thinkingLevel: "max" },
    {
      type: "message",
      id: "kept",
      parentId: "root",
      message: { role: "user", content: [{ type: "text", text: secret }] },
    },
    {
      type: "compaction",
      id: "compact",
      parentId: "kept",
      firstKeptEntryId: "kept",
      summary: secret,
      tokensBefore: 345311,
      fromHook: false,
      details: {
        readFiles: [`/private/${secret}`],
        modifiedFiles: [`/private/${secret}`],
      },
      usage: {
        input: 85020,
        output: 3639,
        reasoning: 3106,
        cost: { total: 0.25 },
      },
    },
  ]);
  const result = scrubSession("pi", source, "compaction");
  ok(!result.jsonl.includes(secret));
  const rows = result.jsonl.trim().split("\n").map((line) => JSON.parse(line));
  strictEqual(rows[1].thinkingLevel, "max");
  const compact = rows[3];
  strictEqual(compact.firstKeptEntryId, rows[2].id);
  strictEqual(compact.parentId, rows[2].id);
  strictEqual(compact.tokensBefore, 345311);
  strictEqual(compact.fromHook, false);
  deepStrictEqual(compact.details.readFiles, compact.details.modifiedFiles);
  deepStrictEqual(compact.usage, {
    input: 85020,
    output: 3639,
    reasoning: 3106,
    cost: { total: 0.25 },
  });
  throws(() =>
    scrubSession(
      "pi",
      source.replace('"tokensBefore":', '"retainedTail":[],"tokensBefore":'),
      "compaction",
    )
  );
});

Deno.test("preserves Pi clipboard-image detection without retaining paths", () => {
  const source = jsonl([
    { type: "session", timestamp: "2026-07-25T12:00:00Z" },
    {
      type: "message",
      message: {
        role: "user",
        content: [
          { type: "text", text: `Review /private/${secret}.png please` },
          { type: "text", text: secret },
        ],
      },
    },
  ]);
  const result = scrubSession("pi", source, "clipboard");
  ok(!result.jsonl.includes(secret));
  const content =
    JSON.parse(result.jsonl.trim().split("\n")[1]).message.content;
  strictEqual(
    content[0].text,
    "Example attachment: /workspace/example/image.png",
  );
  strictEqual(content[1].text, "Example session content.");
});

Deno.test("replaces images with a fixed synthetic PNG", () => {
  const source = jsonl([
    { type: "session", timestamp: "2026-07-25T12:00:00Z" },
    {
      type: "message",
      message: {
        role: "user",
        content: [
          {
            type: "image",
            mimeType: "image/jpeg",
            data: secret,
            filename: secret,
          },
          { type: "image", mimeType: "image/png", data: secret },
        ],
      },
    },
  ]);
  const result = scrubSession("pi", source, "images");
  ok(!result.jsonl.includes(secret));
  const images = JSON.parse(result.jsonl.trim().split("\n")[1]).message.content;
  strictEqual(images.length, 2);
  deepStrictEqual(images[0], images[1]);
  strictEqual(images[0].type, "image");
  strictEqual(images[0].mimeType, "image/png");
  ok(atob(images[0].data).startsWith("\x89PNG"));
});

Deno.test("clipboard-image heuristic matches attachment paths, not prose", () => {
  ok(isClipboardImageReference("Review /tmp/shot.png please"));
  ok(isClipboardImageReference('see ("/tmp/a.jpg")'));
  ok(!isClipboardImageReference("Example session content."));
  ok(!isClipboardImageReference("not an image.png.exe visible"));
  strictEqual(
    CLIPBOARD_IMAGE_TEXT,
    "Example attachment: /workspace/example/image.png",
  );
});

Deno.test("synthetic image is a fixed PNG placeholder", () => {
  strictEqual(SYNTHETIC_IMAGE_MIME_TYPE, "image/png");
  ok(atob(SYNTHETIC_IMAGE_DATA).startsWith("\x89PNG"));
});

Deno.test("rejects unsupported shapes and malformed telemetry without echoing source", () => {
  for (
    const input of [
      pi.replace('"type":"session"', '"type":"unknown"'),
      pi.replace('"type":"thinking"', '"type":"audio"'),
      pi.replace('"path":', '"privateArgument":'),
      pi.replace('"input":25000', `"input":"${secret}"`),
      pi.replace('"name":"read"', `"name":"${secret}"`),
      '{"secret":"' + secret,
    ]
  ) {
    let threw = false;
    try {
      scrubSession("pi", input, "example");
    } catch (caught) {
      threw = true;
      if (!(caught instanceof Error)) throw caught;
      ok(!caught.message.includes(secret));
    }
    ok(threw);
  }
});

Deno.test("malformed JSON reports only the line number, not parser diagnostics", () => {
  for (const harness of ["pi", "codex"] as const) {
    for (
      const invalid of ["PRIVATE_MARKER", '{"secret":PRIVATE_MARKER}', "[]"]
    ) {
      throws(() => scrubSession(harness, invalid, "example"), {
        message: "Invalid JSON object at nonblank line 1",
      });
      throws(() => scrubSession(harness, `{}\n\n${invalid}`, "example"), {
        message: "Invalid JSON object at nonblank line 2",
      });
    }
  }
});

Deno.test("never overwrites source or existing output, including aliases", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const input = join(directory, "input.jsonl");
    const output = join(directory, "output.jsonl");
    await Deno.writeTextFile(input, pi);
    await rejects(() => scrubFile("pi", input, input, "example"));
    await scrubFile("pi", input, output, "example");
    await rejects(() => scrubFile("pi", input, output, "example"));
    const alias = join(directory, "alias.jsonl");
    await Deno.link(input, alias);
    await rejects(() => scrubFile("pi", input, alias, "example"));
    strictEqual(await Deno.readTextFile(input), pi);
    const invalid = join(directory, "invalid.jsonl");
    await Deno.writeTextFile(invalid, "not JSON");
    const absent = join(directory, "absent.jsonl");
    await rejects(() => scrubFile("pi", invalid, absent, "example"));
    await rejects(() => Deno.stat(absent), Deno.errors.NotFound);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

for (const harness of ["pi", "codex"] as const) {
  Deno.test(`${harness} fixture keeps imported analytics after scrubbing`, async () => {
    const filename = harness === "pi"
      ? "haiku-thinking2-full1.jsonl"
      : "rollout-sol-terra-thinking1.jsonl";
    const source = await Deno.readTextFile(
      new URL(`../e2e/fixtures/${harness}/${filename}`, import.meta.url),
    );
    const normalize = harness === "pi"
      ? normalizePiSession
      : normalizeCodexSession;
    const candidate = {
      id: "example",
      path: "example",
      artifactPath: "example",
      updatedAt: 0,
      size: 0,
    };
    function metrics(input: string) {
      const session = normalize(candidate, input);
      return {
        tokens: session.summary.tokens,
        cost: session.summary.reportedCost,
        turns: session.turns.map((turn) =>
          turn.calls.map((call) => ({
            tokens: call.tokens,
            model: call.model,
            provider: call.provider,
            reasoning: call.reasoningSetting,
          }))
        ),
      };
    }
    deepStrictEqual(
      metrics(scrubSession(harness, source, "example").jsonl),
      metrics(source),
    );
  });
}
