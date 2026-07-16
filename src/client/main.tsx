import { createRoot } from "react-dom/client";
import { version as reactVersion } from "react";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { z } from "zod";
import { SessionsPage } from "./SessionsPage.tsx";
import "./styles.css";

function AppError({ error, reset }: { error: unknown; reset: () => void }) {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  const diagnostics = JSON.stringify({
    capturedAt: new Date().toISOString(),
    message,
    stack,
    url: window.location.href,
    userAgent: navigator.userAgent,
    reactVersion,
    scripts: Array.from(document.scripts, (script) => script.src).filter(Boolean),
  }, null, 2);

  return (
    <main className="app-error">
      <p className="eyebrow">Render failure</p>
      <h1>Something went wrong</h1>
      <p className="app-error-message">{message}</p>
      <div className="app-error-actions">
        <button type="button" onClick={reset}>Try again</button>
        <button type="button" onClick={() => window.location.reload()}>
          Reload page
        </button>
        {navigator.clipboard && (
          <button
            type="button"
            onClick={() => void navigator.clipboard.writeText(diagnostics)}
          >
            Copy diagnostics
          </button>
        )}
      </div>
      <details>
        <summary>Diagnostic details</summary>
        <pre>{diagnostics}</pre>
      </details>
    </main>
  );
}

const rootRoute = createRootRoute({
  component: () => <Outlet />,
  errorComponent: AppError,
});
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch: z.object({
    page: z.coerce.number().int().positive().catch(1),
    harness: z.enum(["all", "opencode", "claude-code", "pi", "codex"]).catch("all"),
  }),
  component: SessionsPage,
});
const router = createRouter({ routeTree: rootRoute.addChildren([indexRoute]) });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");
createRoot(root).render(<RouterProvider router={router} />);
