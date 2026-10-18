import { z } from "zod";
import type { UpdateStatus } from "../shared/updateStatus.ts";

const repository = "https://api.github.com/repos/dpclark4/frugal-tokens";
const commitSchema = z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) });
const comparisonSchema = z.object({ status: z.string() });

export function createUpdateChecker(request: typeof fetch = fetch) {
  const cache = new Map<
    string,
    { expires: number; result: Promise<UpdateStatus> }
  >();

  async function github(path: string) {
    const response = await request(`${repository}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "frugal-tokens-update-check",
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
    return response.json();
  }

  async function compare(currentCommit: string): Promise<UpdateStatus> {
    try {
      const { sha: latestCommit } = commitSchema.parse(
        await github("/commits/main"),
      );
      if (currentCommit === latestCommit) {
        return { status: "current", currentCommit, latestCommit };
      }
      const comparison = comparisonSchema.parse(
        await github(`/compare/${currentCommit}...${latestCommit}`),
      );
      const status = comparison.status === "ahead"
        ? "available"
        : comparison.status === "identical" || comparison.status === "behind"
        ? "current"
        : "unknown";
      return { status, currentCommit, latestCommit };
    } catch {
      return { status: "unknown", currentCommit, latestCommit: null };
    }
  }

  return function check(currentCommit: string): Promise<UpdateStatus> {
    if (!/^[a-f0-9]{40}$/.test(currentCommit)) {
      return Promise.resolve({
        status: "unknown",
        currentCommit,
        latestCommit: null,
      });
    }
    const cached = cache.get(currentCommit);
    if (cached && cached.expires > Date.now()) return cached.result;
    // Bound memory even when callers supply arbitrary commit IDs.
    if (cache.size >= 64) cache.clear();
    const entry = {
      expires: Date.now() + 3 * 60 * 60 * 1000,
      result: compare(currentCommit),
    };
    cache.set(currentCommit, entry);
    void entry.result.then((result) => {
      if (result.status === "unknown") {
        entry.expires = Date.now() + 5 * 60 * 1000;
      }
    });
    return entry.result;
  };
}
