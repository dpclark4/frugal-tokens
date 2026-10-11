/** Per-dashboard hover channel; only the SVG highlight overlay subscribes. */
export function createSpendHighlight() {
  let dates: string[] | undefined;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => dates,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(next: string[] | undefined) {
      if (dates === next) return;
      dates = next;
      for (const listener of listeners) listener();
    },
  };
}
export type SpendHighlight = ReturnType<typeof createSpendHighlight>;
