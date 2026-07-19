# Frugal Tokens

A local, read-only view of token usage and reported cost in OpenCode, Claude
Code, PI, and Codex sessions.

## Development

Requires Deno 2.9 or newer.

```sh
cp .env.example .env
deno task dev
```

Configure any session sources you use: `OPENCODE_DB_PATH` for the OpenCode
SQLite database, `CLAUDE_CODE_PROJECT_PATH` for the Claude Code projects directory,
`PI_SESSION_DIR` for the PI session root (usually `~/.pi/agent/sessions`), and
`CODEX_SESSION_DIR` for the Codex session root (usually `~/.codex/sessions`).
Pi session JSONL files may be directly in `PI_SESSION_DIR` or grouped one level
below it in project directories.
Missing or inaccessible sources are disabled with a startup warning. Local
development loads these values from the ignored `.env` file.

Open `http://localhost:5273`. The API listens on port 9000. Set `PORT` to change
the API port; if it changes during development, update the proxy target in
`vite.config.ts` as well.

## Demo Deployment

The `demo-api` Railway service must mount the `demo-api-volume` volume at
`/data` and have `FRUGAL_TOKENS_DATABASE_URL=sqlite:/data/demo.sqlite` set in
its production environment. Sleep configuration and the API domain are managed
in Railway.

With deployment values in `.env`, run `deno task deploy:demo` to publish Pages,
`deno task deploy:railway` to deploy the API, and `deno task deploy:demo-data`
to replace the demo database. Publishing data briefly takes the API down before
replacing `/data/demo.sqlite` and redeploying it.

Create a sanitized contributor database with `deno task demo:database --
--output contributor.sqlite`. To add it to an existing sanitized demo database,
run `deno task demo:merge -- --target demo.sqlite --source contributor.sqlite`.
The merge modifies the target in place, requires matching schemas and sanitized
inputs, and skips sessions whose retained source checksum is already present.

## Production Build

```sh
deno task build
deno task start
```

Open `http://localhost:9000`.
