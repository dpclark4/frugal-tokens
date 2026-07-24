import { sqlitePath } from "../src/server/database.ts";

const databaseURL = Deno.env.get("FRUGAL_TOKENS_DATABASE_URL");
if (!databaseURL) {
  throw new Error("FRUGAL_TOKENS_DATABASE_URL is not set");
}

const environment = {
  ...Deno.env.toObject(),
  FRUGAL_TOKENS_DATABASE_URL: `sqlite:${sqlitePath(databaseURL)}`,
};
const result = await new Deno.Command(Deno.execPath(), {
  args: [
    "run",
    "-A",
    "npm:dbmate@^2.28.0",
    "--migrations-dir",
    "db/migrations",
    "--env",
    "FRUGAL_TOKENS_DATABASE_URL",
    ...Deno.args,
  ],
  env: environment,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
}).output();

if (!result.success) Deno.exit(result.code);
