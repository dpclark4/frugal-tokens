# Frugal Tokens

A local, read-only view of token usage and reported cost in OpenCode sessions.

## Development

Requires Deno 2.9 or newer.

```sh
cp .env.example .env
deno task dev
```

Set `OPENCODE_DB_PATH` to the OpenCode SQLite database and
`CLAUDE_CODE_PROJECT_PATH` to a Claude Code project directory containing its
session JSONL files. Local development loads both values from the ignored
`.env` file.

Open `http://localhost:5273`. The API listens on port 9000. Set `PORT` to change
the API port; if it changes during development, update the proxy target in
`vite.config.ts` as well.

## Production Build

```sh
deno task build
deno task start
```

Open `http://localhost:9000`.
