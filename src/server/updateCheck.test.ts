import { describe, expect, it, vi } from "vitest";
import { createUpdateChecker } from "./updateCheck.ts";

const base = "a".repeat(40);
const latest = "b".repeat(40);

describe("update check", () => {
  it.each([
    ["ahead", "available"],
    ["behind", "current"],
    ["identical", "current"],
    ["diverged", "unknown"],
  ])("handles GitHub comparison %s", async (status, expected) => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ sha: latest }))
      .mockResolvedValueOnce(Response.json({ status }));
    const check = createUpdateChecker(request);
    expect(await check(base)).toEqual({
      status: expected,
      currentCommit: base,
      latestCommit: latest,
    });
    expect(request.mock.calls[1]?.[0]).toBe(
      `https://api.github.com/repos/dpclark4/frugal-tokens/compare/${base}...${latest}`,
    );
    await check(base);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["current", 3 * 60 * 60 * 1000],
    ["unknown", 5 * 60 * 1000],
  ])("expires cached %s results", async (status, duration) => {
    vi.useFakeTimers();
    try {
      const request = vi.fn<typeof fetch>().mockImplementation(async () =>
        status === "current"
          ? Response.json({ sha: base })
          : new Response(null, { status: 403 })
      );
      const check = createUpdateChecker(request);
      await check(base);
      vi.advanceTimersByTime(duration - 1);
      await check(base);
      expect(request).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      await check(base);
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips comparison for an identical head", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ sha: base }),
    );
    expect((await createUpdateChecker(request)(base)).status).toBe("current");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("deduplicates concurrent requests", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ sha: base }),
    );
    const check = createUpdateChecker(request);
    await Promise.all([check(base), check(base)]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid identities without contacting GitHub", async () => {
    const request = vi.fn<typeof fetch>();
    expect((await createUpdateChecker(request)("main")).status).toBe("unknown");
    expect(request).not.toHaveBeenCalled();
  });

  it.each([403, 404, 500])("fails quietly on HTTP %s", async (status) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, { status }),
    );
    expect((await createUpdateChecker(request)(base)).status).toBe("unknown");
  });

  it("fails quietly on network errors and malformed responses", async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValue(
      new Error("offline"),
    );
    expect((await createUpdateChecker(request)(base)).status).toBe("unknown");
    request.mockResolvedValue(Response.json({ sha: "invalid" }));
    expect((await createUpdateChecker(request)(base)).status).toBe("unknown");
  });
});
