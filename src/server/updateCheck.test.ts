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

  it.each([
    [429, {}],
    [403, { "x-ratelimit-remaining": "0" }],
    [403, { "retry-after": "600" }],
  ])("falls back on rate-limited HTTP %s", async (status, headers) => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status, headers }))
      .mockResolvedValueOnce(Response.json({
        branches: [{ name: "main", commit: { sha: latest } }],
      }));
    const check = createUpdateChecker(request);
    expect((await check(base)).status).toBe("possible");
    expect((await check(latest)).status).toBe("current");
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[0]).toBe(
      "https://ungh.cc/repos/dpclark4/frugal-tokens/branches",
    );
  });

  it("falls back when the comparison is rate-limited", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ sha: latest }))
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(Response.json({
        branches: [{ name: "main", commit: { sha: latest } }],
      }));
    expect((await createUpdateChecker(request)(base)).status).toBe("possible");
  });

  it("shares head requests and bounds upstream traffic across arbitrary commits", async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (String(url).includes("ungh.cc")) {
        return Response.json({
          branches: [{ name: "main", commit: { sha: latest } }],
        });
      }
      if (String(url).endsWith("/commits/main")) {
        return Response.json({ sha: latest });
      }
      return Response.json({ status: "ahead" });
    });
    const check = createUpdateChecker(request);
    const results = await Promise.all(
      Array.from(
        { length: 100 },
        (_, i) => check(i.toString(16).padStart(40, "0")),
      ),
    );
    expect(results.some((result) => result.status === "possible")).toBe(true);
    expect(
      request.mock.calls.filter(([url]) =>
        String(url).includes("api.github.com")
      ),
    ).toHaveLength(20);
    expect(
      request.mock.calls.filter(([url]) =>
        String(url).endsWith("/commits/main")
      ),
    ).toHaveLength(1);
    expect(
      request.mock.calls.filter(([url]) => String(url).includes("ungh.cc")),
    ).toHaveLength(1);
    await check("c".repeat(40));
    expect(request).toHaveBeenCalledTimes(21);
  });

  it("honors Retry-After and resumes GitHub checks afterward", async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response(null, {
            status: 429,
            headers: { "retry-after": "600" },
          }),
        )
        .mockResolvedValueOnce(
          Response.json({
            branches: [{ name: "main", commit: { sha: latest } }],
          }),
        )
        .mockResolvedValueOnce(
          Response.json({
            branches: [{ name: "main", commit: { sha: latest } }],
          }),
        )
        .mockResolvedValueOnce(Response.json({ sha: base }));
      const check = createUpdateChecker(request);
      expect((await check(base)).status).toBe("possible");
      vi.advanceTimersByTime(5 * 60 * 1000);
      expect((await check(base)).status).toBe("possible");
      expect(
        request.mock.calls.filter(([url]) =>
          String(url).includes("api.github.com")
        ),
      ).toHaveLength(1);
      vi.advanceTimersByTime(5 * 60 * 1000);
      expect((await check(base)).status).toBe("current");
      expect(request).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    new Response(null, { status: 500 }),
    Response.json({ branches: [] }),
    Response.json({ branches: [{ name: "main", commit: { sha: "invalid" } }] }),
  ])("stays quiet when the fallback fails", async (fallback) => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(fallback);
    expect((await createUpdateChecker(request)(base)).status).toBe("unknown");
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
