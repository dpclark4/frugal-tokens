# Frugal Tokens

A local, read-only view of token usage and reported cost in OpenCode, Claude
Code, PI, and Codex sessions.

Requires Deno 2.9 or newer.

```sh
cp .env.example .env
deno task dev
```

Then open <http://localhost:5273>.

Edit `.env` to set the sources you use; unavailable paths are ignored.

See the [demo deployment guide](docs/demo-deployment.md) for hosted demo maintenance.
