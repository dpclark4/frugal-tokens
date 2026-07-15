import { dirname } from "node:path";
import { sqlitePath } from "../src/server/database.ts";

const databaseURL = Deno.env.get("FRUGAL_TOKENS_DATABASE_URL");
if (!databaseURL) {
  throw new Error("FRUGAL_TOKENS_DATABASE_URL is not set");
}

Deno.mkdirSync(dirname(sqlitePath(databaseURL)), { recursive: true });
