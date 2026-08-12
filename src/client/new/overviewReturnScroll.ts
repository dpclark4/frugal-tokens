export const overviewReturnScrollKey = "frugal-tokens:overview-return-scroll";

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
