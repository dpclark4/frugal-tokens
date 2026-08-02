import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { extractUsageShape } from "./usage.ts";

function response(usage: unknown) {
  return { id: "resp_fixture", status: "completed", usage };
}

Deno.test("extracts a nonzero cached token count", () => {
  const shape = extractUsageShape(response({
    input_tokens: 200,
    output_tokens: 20,
    input_tokens_details: { cached_tokens: 123 },
  }));

  strictEqual(shape.classification, "nonzero");
  strictEqual(shape.cachedTokens.state, "value");
  strictEqual(shape.cachedTokens.value, 123);
  deepStrictEqual(shape.inputTokensDetailsKeys, ["cached_tokens"]);
});

Deno.test("keeps explicit zero distinct from omitted cache metadata", () => {
  const explicitZero = extractUsageShape(response({
    input_tokens: 200,
    input_tokens_details: { cached_tokens: 0 },
  }));
  const detailsOmitted = extractUsageShape(response({ input_tokens: 200 }));
  const cachedKeyOmitted = extractUsageShape(response({
    input_tokens: 200,
    input_tokens_details: {},
  }));

  strictEqual(explicitZero.classification, "explicit-zero");
  strictEqual(explicitZero.cachedTokens.state, "value");
  strictEqual(explicitZero.cachedTokens.value, 0);
  strictEqual(detailsOmitted.classification, "omitted-cache-details");
  strictEqual(detailsOmitted.inputTokensDetailsPresent, false);
  strictEqual(detailsOmitted.cachedTokens.state, "missing");
  strictEqual(cachedKeyOmitted.classification, "omitted-cached-tokens");
  strictEqual(cachedKeyOmitted.inputTokensDetailsPresent, true);
  strictEqual(cachedKeyOmitted.cachedTokens.state, "missing");
});

Deno.test("reports missing usage separately", () => {
  const shape = extractUsageShape({ id: "resp_fixture", status: "completed" });

  strictEqual(shape.classification, "usage-missing");
  strictEqual(shape.usagePresent, false);
  strictEqual(shape.cachedTokens.state, "missing");
});

Deno.test("reports malformed cache fields without normalizing them", () => {
  const shape = extractUsageShape(response({
    input_tokens: 200,
    input_tokens_details: {
      cached_tokens: null,
      cache_write_tokens: "not-a-count",
    },
  }));

  strictEqual(shape.classification, "malformed/unexpected");
  deepStrictEqual(shape.cachedTokens, { state: "null", value: null });
  deepStrictEqual(shape.cacheWriteTokens, {
    state: "value",
    value: "not-a-count",
  });
  deepStrictEqual(shape.malformedFields, [
    "input_tokens_details.cached_tokens",
    "input_tokens_details.cache_write_tokens",
  ]);
});
