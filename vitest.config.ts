import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "forks",
    maxWorkers: 4,
    reporters: ["dot"],
    silent: "passed-only",
    projects: [
      {
        test: {
          name: "unit",
          include: [
            "src/**/*.test.ts",
            "scripts/**/*.test.ts",
            "tools/**/*.test.ts",
          ],
        },
      },
      {
        test: {
          name: "http",
          include: ["e2e/tests/**/*.test.ts"],
          fileParallelism: false,
          testTimeout: 90_000,
          hookTimeout: 90_000,
        },
      },
    ],
  },
});
