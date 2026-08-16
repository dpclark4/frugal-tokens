import type { SessionSummary } from "../shared/sessionSchemas.ts";
import { harnessName } from "./harness.ts";

export function HarnessOptions({
  harnesses,
  allLabel = "All harnesses",
}: {
  harnesses: SessionSummary["harness"][];
  allLabel?: string;
}) {
  return (
    <>
      <option value="all">{allLabel}</option>
      {[...harnesses]
        .sort((a, b) => harnessName(b).localeCompare(harnessName(a)))
        .map((harness) => (
          <option value={harness} key={harness}>{harnessName(harness)}</option>
        ))}
    </>
  );
}
