import { useEffect, useState } from "react";
import type { ReactNode } from "react";

export function SiteHeader({ active, action }: {
  active: "overview" | "old" | "performance" | "tool-calls";
  action?: ReactNode;
}) {
  const [showSecondaryPages, setShowSecondaryPages] = useState(
    () => sessionStorage.getItem("frugal-tokens:show-secondary-pages") === "true",
  );

  useEffect(() => {
    const toggle = () => {
      setShowSecondaryPages((visible) => {
        const next = !visible;
        if (next) {
          sessionStorage.setItem("frugal-tokens:show-secondary-pages", "true");
        } else {
          sessionStorage.removeItem("frugal-tokens:show-secondary-pages");
        }
        return next;
      });
    };
    window.addEventListener("frugal-tokens:toggle-secondary-pages", toggle);
    return () =>
      window.removeEventListener("frugal-tokens:toggle-secondary-pages", toggle);
  }, []);

  return (
    <header className="page-header site-header">
      <div>
        <p className="eyebrow">Local agent economics</p>
        <h1>Frugal Tokens</h1>
      </div>
      <nav className="page-tabs" aria-label="Primary navigation">
        <a
          className={active === "overview" ? "active" : undefined}
          href="/"
        >
          Overview
        </a>
        {showSecondaryPages && (
          <>
            <a className={active === "old" ? "active" : undefined} href="/old">
              Old
            </a>
            <a
              className={active === "performance" ? "active" : undefined}
              href="/performance"
            >
              Performance
            </a>
            <a
              className={active === "tool-calls" ? "active" : undefined}
              href="/tool-calls"
            >
              Tool calls
            </a>
          </>
        )}
      </nav>
      {action && <div className="site-header-action">{action}</div>}
    </header>
  );
}
