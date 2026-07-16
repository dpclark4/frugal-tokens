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

## Production Build

```sh
deno task build
deno task start
```

Open `http://localhost:9000`.
