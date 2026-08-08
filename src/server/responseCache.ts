import type { MiddlewareHandler } from "hono";

export function createResponseCache(maxEntries = 250) {
  const responses = new Map<string, Response>();
  let generation = 0;

  const clear = () => {
    responses.clear();
    generation++;
  };

  const middleware: MiddlewareHandler = async (context, next) => {
    if (context.req.method !== "GET") {
      await next();
      return;
    }

    const url = new URL(context.req.url);
    const key = `${url.pathname}${url.search}`;
    const cached = responses.get(key);
    if (cached !== undefined) {
      context.res = cached.clone();
      context.header("Server-Timing", 'cache;desc="hit"');
      context.header("X-Cache", "HIT");
      return;
    }

    const requestGeneration = generation;
    await next();
    context.header("X-Cache", "MISS");

    const contentType = context.res.headers.get("content-type");
    if (
      requestGeneration !== generation || !context.res.ok ||
      !contentType?.includes("application/json")
    ) return;

    if (responses.size >= maxEntries) {
      const oldestKey = responses.keys().next().value;
      if (oldestKey !== undefined) responses.delete(oldestKey);
    }
    responses.set(key, context.res.clone());
  };

  return { clear, middleware };
}
