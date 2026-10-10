# Frugal Tokens

A local, read-only view of token usage and reported cost in OpenCode, Claude
Code, PI, Codex, and Cursor sessions.

Requires Node 26 and pnpm 12.10.1. Deno 2.9.2 remains temporarily for tests,
formatting, and unmigrated tooling; see the
[migration checkpoints](docs/node-migration.md).

```sh
pnpm install --frozen-lockfile
cp .env.example .env
pnpm build && pnpm start
```

Then open <http://localhost:9000>.

Use `.env` to override the default session locations. To use a different API
port (e.g. if 9000 is already taken on your machine), set `PORT` in `.env`
(e.g. `PORT=9001`). This is also the port Railway (or any host that
auto-injects `PORT`) will route traffic to, so don't rename it.

For development with automatic client and server reloads, run `pnpm dev`
and open <http://localhost:5273>. Note: `pnpm dev` computes its own API
port from the web port you pass it and ignores `PORT` in `.env`; to change
the dev API port, pass a different web port instead, e.g. `pnpm dev 5274`.

See the [demo deployment guide](docs/demo-deployment.md) for hosted demo maintenance.
