import { createRoot } from "react-dom/client";
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

const rootRoute = createRootRoute({ component: () => <Outlet /> });
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch: z.object({
    page: z.coerce.number().int().positive().catch(1),
    harness: z.enum(["all", "opencode", "claude-code", "pi"]).catch("all"),
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
