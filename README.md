# Frugal Tokens

A local, read-only view of token usage and reported cost in OpenCode, Claude
Code, PI, Codex, and Cursor sessions.

Requires Node 26 and pnpm 12.10.1. Deno 2.9.2 is needed only for formatting.
Node 24 is not supported because the application uses native `Temporal`.

If you use a version manager, [fnm](https://github.com/Schniz/fnm) reads the
repository's `.node-version`:

```sh
fnm install
fnm use
```

With [nvm](https://github.com/nvm-sh/nvm), use `nvm install 26` and `nvm use 26`
instead. A version manager is optional; an existing Node 26 installation works.

Install the pinned package manager, then start the app:

```sh
npm install --global pnpm@12.10.1
pnpm install --frozen-lockfile
cp .env.example .env
pnpm build && pnpm start
```

Then open <http://localhost:9000>.

Use `.env` to override the default session locations. To use a different API
port (e.g. if 9000 is already taken on your machine), set `PORT` in `.env` (e.g.
`PORT=9001`). This is also the port Railway (or any host that auto-injects
`PORT`) will route traffic to, so don't rename it.

For development with automatic client and server reloads, run `pnpm dev` and
open <http://localhost:5273>. Note: `pnpm dev` computes its own API port from
the web port you pass it and ignores `PORT` in `.env`; to change the dev API
port, pass a different web port instead, e.g. `pnpm dev 5274`.

## Contributor commands

```sh
pnpm run setup       # Install Git hooks using the local prek dependency.
pnpm check
pnpm lint
pnpm test
pnpm test:e2e
```

Use `pnpm run setup`, not pnpm's unrelated built-in `pnpm setup` command.
`pnpm fmt` and `pnpm fmt:check` still use Deno; formatter migration is separate.

Existing task names are preserved as pnpm scripts. Database commands (`db:new`,
`db:migrate`, `db:rollback`, `db:status`) use the exported
`FRUGAL_TOKENS_DATABASE_URL`; `dev` and `start` load `.env`. The final
destructive migration is not SQL-reversible: restore the matching
database/application backup rather than running rollback followed by migrate.

See the [demo deployment guide](docs/demo-deployment.md) for hosted demo
maintenance and [migration checkpoints](docs/node-migration.md) for the
formatter follow-up.
