import { z } from "zod";
import type { UpdateStatus } from "../shared/updateStatus.ts";

const repository = "https://api.github.com/repos/dpclark4/frugal-tokens";
const unghBranches = "https://ungh.cc/repos/dpclark4/frugal-tokens/branches";
const commitSchema = z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) });
const branchesSchema = z.object({
  branches: z.array(z.object({ name: z.string(), commit: commitSchema })),
});
const comparisonSchema = z.object({ status: z.string() });
const hour = 60 * 60 * 1000;
const retryDelay = 5 * 60 * 1000;

export function createUpdateChecker(request: typeof fetch = fetch) {
  const cache = new Map<
    string,
    { expires: number; result: Promise<UpdateStatus> }
  >();
  const heads = new Map<string, { expires: number; result: Promise<string> }>();
  let githubBlockedUntil = 0;
  let budgetResetsAt = 0;
  let githubRequests = 0;

  async function github(path: string) {
    const now = Date.now();
    if (now < githubBlockedUntil) throw new Error("GitHub cooldown");
    if (now >= budgetResetsAt) {
      budgetResetsAt = now + hour;
      githubRequests = 0;
    }
    // Shared across caller-supplied commits, including concurrent requests.
    // Leave most of the anonymous IP quota available to other applications.
    if (githubRequests >= 20) {
      githubBlockedUntil = budgetResetsAt;
      throw new Error("GitHub request budget exhausted");
    }
    githubRequests++;
    const response = await request(`${repository}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "frugal-tokens-update-check",
      },
      signal: AbortSignal.timeout(5000),
    });
    if (
      response.status === 429 || (response.status === 403 && (
        response.headers.get("x-ratelimit-remaining") === "0" ||
        response.headers.has("retry-after")
      ))
    ) {
      const retry = response.headers.get("retry-after");
      const seconds = retry === null ? NaN : Number(retry);
      const retryAt = Number.isFinite(seconds)
        ? now + seconds * 1000
        : Date.parse(retry ?? "");
      const resetAt = Number(response.headers.get("x-ratelimit-reset")) * 1000;
      githubBlockedUntil = Math.max(
        githubBlockedUntil,
        now + retryDelay,
        Number.isFinite(retryAt) ? retryAt : 0,
        Number.isFinite(resetAt) ? resetAt : 0,
      );
    }
    if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
    return response.json();
  }

  function head(fallback: boolean): Promise<string> {
    const key = fallback ? "ungh" : "github";
    const cached = heads.get(key);
    if (cached && cached.expires > Date.now()) return cached.result;
    const entry = {
      expires: Date.now() + (fallback ? retryDelay : 3 * hour),
      result: fetchHead(fallback),
    };
    heads.set(key, entry);
    void entry.result.catch(() => {
      entry.expires = Date.now() + retryDelay;
    });
    return entry.result;
  }

  async function fetchHead(fallback: boolean): Promise<string> {
    if (!fallback) return commitSchema.parse(await github("/commits/main")).sha;
    const response = await request(unghBranches, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`UNGH returned ${response.status}`);
    const main = branchesSchema.parse(await response.json()).branches.find(
      (branch) => branch.name === "main",
    );
    if (!main) throw new Error("UNGH main branch missing");
    return main.commit.sha;
  }

  async function compare(currentCommit: string): Promise<UpdateStatus> {
    try {
      const latestCommit = await head(false);
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
      if (Date.now() < githubBlockedUntil) {
        try {
          const latestCommit = await head(true);
          return {
            status: latestCommit === currentCommit ? "current" : "possible",
            currentCommit,
            latestCommit,
          };
        } catch {
          // Both providers failed; the application remains usable.
        }
      }
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
    // Evict only the oldest entry, never the shared head cache or request budget.
    if (cache.size >= 64) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    const entry = {
      expires: Date.now() + 3 * hour,
      result: compare(currentCommit),
    };
    cache.set(currentCommit, entry);
    void entry.result.then((result) => {
      if (
        result.status === "unknown" || result.status === "possible" ||
        Date.now() < githubBlockedUntil
      ) {
        entry.expires = Date.now() + retryDelay;
      }
    });
    return entry.result;
  };
}
