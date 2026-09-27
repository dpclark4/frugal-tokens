import { strictEqual as assertEquals } from "node:assert/strict";
import { toolTarget } from "./toolTarget.ts";

Deno.test("tool targets recognize Claude Code and Pi file arguments", () => {
  for (const key of ["file_path", "filePath", "path"]) {
    assertEquals(
      toolTarget(JSON.stringify({ [key]: "src/example.ts" })),
      "src/example.ts",
    );
  }
});

Deno.test("tool targets prefer descriptions and fall back to commands", () => {
  assertEquals(
    toolTarget('{"description":"Show changes","command":"git diff"}'),
    "Show changes",
  );
  assertEquals(
    toolTarget('{"description":"","command":"git diff"}'),
    "git diff",
  );
});

Deno.test("missing and truncated structured arguments have no target", () => {
  for (
    const value of [
      undefined,
      "",
      "{}",
      '{"replace_all":false,"file_path":"src/…',
      "[]",
    ]
  ) {
    assertEquals(toolTarget(value), undefined);
  }
});

Deno.test("truncated edits retain complete file paths", () => {
  const input = JSON.stringify({
    replace_all: false,
    file_path: "src/NetworkedIdentityResolver.java",
    old_string: "old body".repeat(300),
    new_string: "new body",
  });
  assertEquals(
    toolTarget(`${input.slice(0, 500)}…`),
    "src/NetworkedIdentityResolver.java",
  );
});

Deno.test("truncated inputs respect escaping and nested field boundaries", () => {
  const path = 'src/a,"quoted"\\file.ts';
  const input = JSON.stringify({
    metadata: { file_path: "not-the-target.ts", values: [1, 2] },
    path,
    content: 'text with commas, braces }, and "quotes"'.repeat(100),
  });
  assertEquals(toolTarget(`${input.slice(0, 300)}…`), path);
  assertEquals(
    toolTarget('{"metadata":{"file_path":"nested.ts"},"content":"cut…'),
    undefined,
  );
  assertEquals(toolTarget('{"file_path":"incomplete…'), undefined);
});

Deno.test("escaped quotes cannot turn string contents into field boundaries", () => {
  const input = JSON.stringify({
    file_path: 'src/a",b.ts',
    old_string: 'a quote " followed by commas, and braces }'.repeat(100),
  });
  assertEquals(toolTarget(`${input.slice(0, 150)}…`), 'src/a",b.ts');
});

Deno.test("preview cutoff retains a complete final target field", () => {
  const empty = JSON.stringify({ old_string: "", file_path: "src/x.ts" });
  const input = JSON.stringify({
    old_string: "x".repeat(2049 - empty.length),
    file_path: "src/x.ts",
  });
  assertEquals(input.length, 2049);
  assertEquals(toolTarget(input.slice(0, 2048)), "src/x.ts");
  assertEquals(toolTarget(input.slice(0, 2047)), undefined);
  assertEquals(toolTarget('{"file_path":"src/x.ts"'), "src/x.ts");
});

Deno.test("closing a preview does not recover incomplete or nested-only targets", () => {
  assertEquals(toolTarget('{"metadata":{"file_path":"nested.ts"}'), undefined);
  assertEquals(toolTarget('{"metadata":{"file_path":"nested.ts"'), undefined);
  assertEquals(toolTarget('{"file_path":"src/x.ts'), undefined);
  assertEquals(toolTarget('{"file_path":'), undefined);
  assertEquals(
    toolTarget('{"file_path":"src/x.ts","old_string":'),
    "src/x.ts",
  );
});

Deno.test("plain text and JSON string targets remain readable", () => {
  assertEquals(toolTarget("git diff"), "git diff");
  assertEquals(toolTarget('"src/example.ts"'), "src/example.ts");
});
