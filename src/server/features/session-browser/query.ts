import {
  harnessSchema,
  parseSessionMissFilters,
  type SessionMissFilter,
  sessionMissFilterSchema,
  type SessionSortDirection,
  sessionSortDirectionSchema,
  type SessionSortKey,
  sessionSortKeySchema,
  type SessionSummary,
} from "../../../shared/sessionSchemas.ts";

import { sessionModelSelectionSchema } from "../../../shared/sessionBrowserSchemas.ts";

function defaultSortDirection(key: SessionSortKey): SessionSortDirection {
  return key === "model" ? "asc" : "desc";
}

type SessionBrowserQuery = {
  page: number;
  pageSize: number;
  harness: SessionSummary["harness"] | "all";
  missFilters: SessionMissFilter[] | undefined;
  models: string[];
  sort: { key: SessionSortKey; direction: SessionSortDirection } | undefined;
};

export function parseSessionBrowserQuery(
  query: Record<string, string | undefined>,
  models: string[] = [],
): { value: SessionBrowserQuery; error?: never } | {
  error: string;
  value?: never;
} {
  const page = Math.max(
    1,
    Number.parseInt(query.page ?? "1", 10) || 1,
  );
  const requestedPageSize = Number.parseInt(query.pageSize ?? "10", 10) || 10;
  const pageSize = Math.min(100, Math.max(1, requestedPageSize));
  const harness = query.harness ?? "all";
  const parsedHarness = harnessSchema.safeParse(harness);
  if (harness !== "all" && !parsedHarness.success) {
    return { error: "Invalid harness" };
  }
  const parsedModels = sessionModelSelectionSchema.safeParse(models);
  if (!parsedModels.success) return { error: "Invalid model selection" };
  const misses = query.misses;
  const missFilters = parseSessionMissFilters(misses);
  if (
    misses !== undefined && misses !== "" && misses !== "all" &&
    misses !== "none" && missFilters === undefined
  ) {
    return {
      error: `Invalid miss filter; expected ${
        sessionMissFilterSchema.options.join(", ")
      }`,
    };
  }
  const sortByParam = query.sortBy;
  const parsedSortBy = sessionSortKeySchema.safeParse(sortByParam);
  if (sortByParam !== undefined && !parsedSortBy.success) {
    return {
      error: `Invalid sortBy; expected ${
        sessionSortKeySchema.options.join(", ")
      }`,
    };
  }
  const sortDirectionParam = query.sortDirection;
  const parsedSortDirection = sessionSortDirectionSchema.safeParse(
    sortDirectionParam,
  );
  if (sortDirectionParam !== undefined && !parsedSortDirection.success) {
    return {
      error: `Invalid sortDirection; expected ${
        sessionSortDirectionSchema.options.join(", ")
      }`,
    };
  }
  const sort = parsedSortBy.success
    ? {
      key: parsedSortBy.data,
      direction: parsedSortDirection.success
        ? parsedSortDirection.data
        : defaultSortDirection(parsedSortBy.data),
    }
    : undefined;
  return {
    value: {
      page,
      pageSize,
      harness: parsedHarness.success ? parsedHarness.data : "all",
      missFilters,
      models: [...new Set(parsedModels.data)],
      sort,
    },
  };
}
