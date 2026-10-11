import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { SpendCompositionData } from "../../shared/sessionSchemas.ts";
import { CompositionTooltip } from "./SpendComposition.tsx";
import { otherModelColor } from "./modelColors.ts";

const data: SpendCompositionData = {
  spend: 999,
  processedInput: 999_000,
  hasUnpricedCost: false,
  models: [],
  other: { spend: 999, processedInput: 999_000, hasUnpricedCost: false },
  days: [],
};
const source = {
  date: "2026-07-13",
  endDate: "2026-07-19",
  models: [],
  otherSpend: 12,
  otherProcessedInput: 300,
  otherHasUnpricedCost: false,
  otherModels: [{
    model: "gpt-5.6-sol",
    provider: "openai" as const,
    tier: "sol",
    tierRank: 0,
    spend: 12,
    processedInput: 300,
    hasUnpricedCost: false,
  }],
};

function render(metric: "spend" | "tokens", bucket = source) {
  return renderToStaticMarkup(createElement(CompositionTooltip, {
    active: true,
    data,
    metric,
    payload: [{
      payload: {
        index: 0,
        date: bucket.date,
        source: bucket,
        total: 12,
      },
    }],
  }));
}

for (const metric of ["spend", "tokens"] as const) {
  test(`${metric} tooltip shows the bucket's gray Other subtotal and uncolored children`, () => {
    const html = render(metric);
    expect(html).toContain(`background-color:${otherModelColor}`);
    expect(html).toContain(
      `<span>Other</span><strong>${
        metric === "spend" ? "$12.00" : "300"
      }</strong>`,
    );
    expect(html).toContain(
      'class="composition-tooltip-other-model"><span>GPT 5.6 Sol</span>',
    );
    expect(html.match(/<i /g)).toHaveLength(1);
    expect(html).not.toContain("999");
  });
}

test("omits Other when the hovered bucket has no Other usage", () => {
  expect(render("spend", {
    ...source,
    otherSpend: 0,
    otherProcessedInput: 0,
    otherModels: [],
  })).not.toContain("composition-tooltip-other");
});
