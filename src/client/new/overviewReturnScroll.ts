export const overviewReturnScrollKey = "frugal-tokens:overview-return-scroll";
export const overviewRefreshScrollKey = "frugal-tokens:overview-refresh-scroll";

type SavedOverviewScroll = {
  href: string;
  scrollY: number;
};

export function readOverviewRefreshScroll() {
  try {
    const saved = JSON.parse(
      sessionStorage.getItem(overviewRefreshScrollKey) ?? "null",
    ) as SavedOverviewScroll | null;
    sessionStorage.removeItem(overviewRefreshScrollKey);
    return saved?.href === globalThis.location.href &&
        Number.isFinite(saved.scrollY)
      ? saved.scrollY
      : undefined;
  } catch {
    return undefined;
  }
}

export function saveOverviewRefreshScroll() {
  try {
    sessionStorage.setItem(
      overviewRefreshScrollKey,
      JSON.stringify({
        href: globalThis.location.href,
        scrollY: globalThis.scrollY,
      }),
    );
  } catch {
    // Native browser restoration remains the fallback.
  }
}

export function saveOverviewReturnScroll() {
  try {
    sessionStorage.setItem(
      overviewReturnScrollKey,
      JSON.stringify({
        href: globalThis.location.href,
        scrollY: globalThis.scrollY,
      }),
    );
  } catch {
    // Router scroll restoration remains the fallback when storage is unavailable.
  }
}
