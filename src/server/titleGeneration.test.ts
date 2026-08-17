import { strictEqual } from "node:assert/strict";
import { titleGenerationEligible } from "./titleGeneration.ts";

Deno.test("generates a title when the imported title is the first user prompt", () => {
  strictEqual(
    titleGenerationEligible({
      imported_title: "Inspect sessions and summarize the results",
      input: "  Inspect sessions\nand summarize the results  ",
    }),
    true,
  );
});

Deno.test("does not generate over an authoritative imported title", () => {
  strictEqual(
    titleGenerationEligible({
      imported_title: "Build Python Robot Arena",
      input: "Look at ROBOT.cpp and port it to Python",
    }),
    false,
  );
});

Deno.test("generates over known generic harness fallback titles", () => {
  strictEqual(
    titleGenerationEligible({
      imported_title: "Pi session project",
      input: "Inspect sessions",
    }),
    true,
  );
  strictEqual(
    titleGenerationEligible({
      imported_title: "OpenCode session abc123",
      input: "Inspect sessions",
    }),
    true,
  );
});
