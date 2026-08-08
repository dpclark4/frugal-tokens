import { createRoot } from "react-dom/client";
import { lazy, Suspense, version as reactVersion } from "react";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  redirect,
} from "@tanstack/react-router";
import { z } from "zod";
import "./styles.css";

const SessionsPage = lazy(() =>
  import("./SessionsPage.tsx").then(({ SessionsPage }) => ({
    default: SessionsPage,
  }))
);
const NewPage = lazy(() =>
  import("./NewPage.tsx").then(({ NewPage }) => ({
    default: NewPage,
  }))
);
const PerformancePage = lazy(() =>
  import("./PerformancePage.tsx").then(({ PerformancePage }) => ({
    default: PerformancePage,
  }))
);
const ToolCallsPage = lazy(() =>
  import("./ToolCallsPage.tsx").then(({ ToolCallsPage }) => ({
    default: ToolCallsPage,
  }))
);
const SessionDetailPage = lazy(() =>
  import("./SessionDetailPage.tsx").then(({ SessionDetailPage }) => ({
    default: SessionDetailPage,
  }))
);

function AppError({ error, reset }: { error: unknown; reset: () => void }) {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  const diagnostics = JSON.stringify(
    {
      capturedAt: new Date().toISOString(),
      message,
      stack,
      url: window.location.href,
      userAgent: navigator.userAgent,
      reactVersion,
      scripts: Array.from(document.scripts, (script) => script.src).filter(
        Boolean,
      ),
    },
    null,
    2,
  );

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
  component: () => (
    <Suspense fallback={<main>Loading…</main>}>
      <Outlet />
    </Suspense>
  ),
  errorComponent: AppError,
});
const oldRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/old",
  validateSearch: z.object({
    harness: z.enum(["all", "opencode", "claude-code", "pi", "codex", "cursor"]).catch(
      "all",
    ),
    misses: z.string().optional(),
  }),
  component: SessionsPage,
});
const newRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch: z.object({
    harness: z.enum(["all", "opencode", "claude-code", "pi", "codex", "cursor"]).catch(
      "all",
    ),
    range: z.coerce.number().pipe(z.union([z.literal(30), z.literal(90)]))
      .catch(30),
    misses: z.string().optional(),
  }),
  component: NewPage,
});
const newRedirectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/new",
  beforeLoad: () => {
    throw redirect({
      to: "/",
      search: { harness: "all", range: 30 },
    });
  },
});
const performanceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/performance",
  validateSearch: z.object({
    harness: z.enum(["all", "opencode", "claude-code", "pi", "codex", "cursor"]).catch(
      "all",
    ),
    openai: z.string().catch("all"),
    anthropic: z.string().catch("all"),
  }),
  component: PerformancePage,
});
const toolCallsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tool-calls",
  validateSearch: z.object({
    harness: z.enum(["all", "opencode", "claude-code", "pi", "codex", "cursor"]).catch(
      "all",
    ),
    range: z.coerce.number().pipe(
      z.union([z.literal(7), z.literal(30), z.literal(90)]),
    ).catch(30),
    expanded: z.preprocess(
      (value) => value === true || value === "true",
      z.boolean(),
    ).catch(false),
  }),
  component: ToolCallsPage,
});
const sessionDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sessions/$harness/$sessionId",
  validateSearch: z.object({
    misses: z.string().optional(),
    paths: z.enum(["absolute", "relative"]).catch("relative"),
    color: z.enum(["none", "time", "cost", "input", "output"]).catch(
      "time",
    ),
    model: z.string().catch("recorded"),
    thinking: z.string().catch("recorded"),
  }),
  parseParams: (params) => ({
    harness: z.enum(["opencode", "claude-code", "pi", "codex", "cursor"]).parse(
      params.harness,
    ),
    sessionId: params.sessionId,
  }),
  component: SessionDetailPage,
});
const router = createRouter({
  routeTree: rootRoute.addChildren([
    oldRoute,
    newRoute,
    newRedirectRoute,
    performanceRoute,
    toolCallsRoute,
    sessionDetailRoute,
  ]),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");
createRoot(root).render(<RouterProvider router={router} />);
