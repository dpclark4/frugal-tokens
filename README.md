# Frugal Tokens

A local, read-only view of token usage and reported cost in OpenCode sessions.

## Development

Requires Deno 2.9 or newer.

```sh
deno task dev
```

Open `http://localhost:5273`. The API reads
`~/.local/share/opencode/opencode.db` and listens on port 9000.

Set `OPENCODE_DB_PATH` to use a different database or `PORT` to change the API
port. If the API port changes during development, update the proxy target in
`vite.config.ts` as well. `CLAUDE_CODE_PROJECT_PATH` must point to one Claude
Code project directory containing its session JSONL files. Local development
loads this value from the ignored `.env` file.

## Production Build

```sh
deno task build
deno task start
```

Open `http://localhost:9000`.
