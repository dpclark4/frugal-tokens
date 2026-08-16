import { toBlob } from "html-to-image";

const pageBackground = "#f4f0e8";

function inheritedCustomProperties(element: HTMLElement) {
  const properties: Record<string, string> = {};
  const names = [
    "--mono",
    "--dashboard-bg",
    "--dashboard-panel",
    "--dashboard-ink",
    "--dashboard-muted",
    "--dashboard-rule",
    "--dashboard-signal",
    "--dashboard-spend",
  ];
  const sources = [document.documentElement, element];
  for (const source of sources) {
    const styles = getComputedStyle(source);
    for (const name of names) {
      const value = styles.getPropertyValue(name);
      if (value) properties[name] = value;
    }
  }
  return properties;
}

export async function copyElementScreenshot(element: HTMLElement) {
  if (
    !globalThis.isSecureContext ||
    !navigator.clipboard?.write ||
    !globalThis.ClipboardItem
  ) {
    throw new Error("Image clipboard access is unavailable");
  }

  const bounds = element.getBoundingClientRect();
  // Keep the page's current layout width; scrollWidth can include an
  // overflowing chart or table and make the cloned page unexpectedly wider.
  const width = Math.ceil(bounds.width);
  const excluded = element.querySelector<HTMLElement>(
    "[data-screenshot-exclude]",
  );
  const height = excluded
    ? Math.ceil(excluded.getBoundingClientRect().top - bounds.top)
    : Math.ceil(Math.max(element.scrollHeight, bounds.height));
  const blob = toBlob(element, {
    backgroundColor: pageBackground,
    cacheBust: true,
    filter: (node) =>
      !(node instanceof Element && (
        node.hasAttribute("data-screenshot-control") ||
        node.hasAttribute("data-screenshot-exclude")
      )),
    height,
    pixelRatio: 2,
    style: {
      ...inheritedCustomProperties(element),
      backgroundColor: pageBackground,
    } as Partial<CSSStyleDeclaration>,
    width,
  }).then((result) => {
    if (!result) throw new Error("Screenshot rendering returned no image");
    return result;
  });

  await navigator.clipboard.write([
    new ClipboardItem({ "image/png": blob }),
  ]);
}
