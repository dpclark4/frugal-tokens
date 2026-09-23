// Keep time-dependent HTTP aggregates stable and include every fixture date.
const now = Date.parse("2026-02-01T12:00:00.000Z");
globalThis.Date = new Proxy(Date, {
  construct(target, args) {
    return Reflect.construct(target, args.length === 0 ? [now] : args);
  },
});
Date.now = () => now;

await import("../../src/server/main.ts");
