export function createTitleWorker(generate: () => Promise<void>) {
  let active: Promise<void> | undefined;
  return function start() {
    if (active) {
      console.info("[generate titles] background worker already running");
      return active;
    }
    console.info("[generate titles] background worker started");
    active = Promise.resolve().then(generate).catch((error) => {
      console.error("[generate titles] background worker failed", error);
    }).finally(() => {
      active = undefined;
      console.info("[generate titles] background worker finished");
    });
    return active;
  };
}
