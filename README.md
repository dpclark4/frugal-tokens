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

Use `.env` to override the default session locations.

For development with automatic client and server reloads, run `deno task dev`
and open <http://localhost:5273>.

See the [demo deployment guide](docs/demo-deployment.md) for hosted demo maintenance.
