# Frugal Tokens

A local, read-only view of token usage and reported cost in OpenCode, Claude
Code, PI, Codex, and Cursor sessions.

Requires [Deno 2.9 or newer](https://docs.deno.com/runtime/getting_started/installation/).

Install Deno on macOS or Linux if needed:

```sh
curl -fsSL https://deno.land/install.sh | sh
```

```sh
cp .env.example .env
deno task build && deno task start
```

Then open <http://localhost:9000>.

Use `.env` to override the default session locations. To use a different API
port (e.g. if 9000 is already taken on your machine), set
`FRUGAL_TOKENS_API_PORT` in `.env`.

For development with automatic client and server reloads, run `deno task dev`
and open <http://localhost:5273>. Note: `deno task dev` computes its own API
port from the web port you pass it and ignores `FRUGAL_TOKENS_API_PORT` in
`.env`; to change the dev API port, pass a different web port instead, e.g.
`deno task dev 5274`.

See the [demo deployment guide](docs/demo-deployment.md) for hosted demo maintenance.
