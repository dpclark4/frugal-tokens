import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";

export function sqlitePath(databaseURL: string) {
  if (!databaseURL.startsWith("sqlite:")) {
    throw new Error("FRUGAL_TOKENS_DATABASE_URL must use the sqlite: scheme");
  }
  const path = decodeURIComponent(databaseURL.slice("sqlite:".length));
  if (!path) throw new Error("FRUGAL_TOKENS_DATABASE_URL has no database path");
  return path;
}

export function openArchiveDatabase(path: string) {
  Deno.mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA synchronous = NORMAL");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
