import { deepStrictEqual } from "node:assert/strict";
import { openArchiveDatabase } from "./database.ts";
import { migrateTestDatabase } from "./databaseTestUtils.ts";
import { SessionReadPool } from "./sessionReadPool.ts";

Deno.test("serves archive reads through multiple workers", async () => {
  const directory = Deno.makeTempDirSync();
  const path = `${directory}/archive.sqlite`;
  const writer = openArchiveDatabase(path);
  migrateTestDatabase(writer);
  const readers = new SessionReadPool(path, 2);

  try {
    const [sessions, calls] = await Promise.all([
      readers.listSessions(1, 25),
      readers.listUsageCalls(),
    ]);
    deepStrictEqual(sessions, {
      items: [],
      pagination: { page: 1, pageSize: 25, totalItems: 0, totalPages: 0 },
    });
    deepStrictEqual(calls, []);
  } finally {
    readers.close();
    writer.close();
    Deno.removeSync(directory, { recursive: true });
  }
});
