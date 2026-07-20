export function SiteHeader({ active }: { active: "overview" | "performance" }) {
  return (
    <header className="page-header site-header">
      <div>
        <p className="eyebrow">Local agent economics</p>
        <h1>Frugal Tokens</h1>
      </div>
      <nav className="page-tabs" aria-label="Primary navigation">
        <a className={active === "overview" ? "active" : undefined} href="/">
          Overview
        </a>
        <a
          className={active === "performance" ? "active" : undefined}
          href="/performance"
        >
          Performance
        </a>
      </nav>
    </header>
  );
}
