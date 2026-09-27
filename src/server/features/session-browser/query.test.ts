import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { parseSessionBrowserQuery } from "./query.ts";

Deno.test("session browser query preserves default pagination and filters", () => {
  deepStrictEqual(parseSessionBrowserQuery({}), {
    value: {
      page: 1,
      pageSize: 10,
      harness: "all",
      missFilters: undefined,
      models: [],
      sort: undefined,
    },
  });
});

Deno.test("session browser query preserves pagination coercion and bounds", () => {
  for (
    const [page, pageSize, expectedPage, expectedPageSize] of [
      ["-2", "500", 1, 100],
      ["invalid", "invalid", 1, 10],
      ["0", "0", 1, 10],
      ["2.5", "-1", 2, 1],
      ["3", "25", 3, 25],
    ] as const
  ) {
    const result = parseSessionBrowserQuery({ page, pageSize });
    strictEqual(result.value?.page, expectedPage);
    strictEqual(result.value?.pageSize, expectedPageSize);
  }
});

Deno.test("session browser query preserves sort defaults and explicit direction", () => {
  for (
    const key of [
      "name",
      "model",
      "activity",
      "input",
      "output",
      "cost",
      "cacheMisses",
    ]
  ) {
    deepStrictEqual(parseSessionBrowserQuery({ sortBy: key }).value?.sort, {
      key,
      direction: key === "name" || key === "model" ? "asc" : "desc",
    });
    deepStrictEqual(
      parseSessionBrowserQuery({ sortBy: key, sortDirection: "asc" }).value
        ?.sort,
      { key, direction: "asc" },
    );
  }
  strictEqual(
    parseSessionBrowserQuery({ sortDirection: "asc" }).value?.sort,
    undefined,
  );
});

Deno.test("session browser query parses harness and cache miss selections", () => {
  const result = parseSessionBrowserQuery({
    harness: "pi",
    misses: "model-change",
  });
  strictEqual(result.value?.harness, "pi");
  deepStrictEqual(result.value?.missFilters, ["model-change"]);
  for (const misses of [undefined, "", "all"]) {
    strictEqual(
      parseSessionBrowserQuery({ misses }).value?.missFilters,
      undefined,
    );
  }
  deepStrictEqual(
    parseSessionBrowserQuery({ misses: "none" }).value?.missFilters,
    [],
  );
});

Deno.test("session browser query parses and validates model selections", () => {
  deepStrictEqual(
    parseSessionBrowserQuery({}, ["a/b", "c", "a/b"]).value?.models,
    ["a/b", "c"],
  );
  for (
    const models of [
      [""],
      ["x".repeat(513)],
      Array.from({ length: 101 }, () => "model"),
    ]
  ) {
    strictEqual(
      parseSessionBrowserQuery({}, models).error,
      "Invalid model selection",
    );
  }
});

Deno.test("session browser query rejects invalid filters and sorting", () => {
  for (const field of ["harness", "misses", "sortBy", "sortDirection"]) {
    const result = parseSessionBrowserQuery({ [field]: "invalid" });
    match(result.error ?? "", /^Invalid /);
    strictEqual(result.value, undefined);
  }
});
