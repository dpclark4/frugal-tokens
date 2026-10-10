# Demo deployment

These commands maintain the hosted demo. The demo frontend is deployed to Pages,
and its API runs as a Railway service with a mounted volume.

## Configuration

Copy the demo environment template and update its values:

```sh
cp .env.demo.example .env.demo
```

The deployment tasks load `.env.demo`. The database creation task loads `.env`.
`FRUGAL_TOKENS_DATABASE_URL` should point to the local archive used as the
source for demo database snapshots.

The `demo-api` Railway service must mount the `demo-api-volume` volume at
`/data`. Railpack uses the explicit Node provider in `railpack.json`, Node 26
from `package.json`, and pinned pnpm. The API starts with `pnpm start:api`,
which applies existing migrations before listening on `PORT`; Pages remains
separate. Remove any hosting-side Deno command or runtime-version overrides
before deploying. Sleep configuration and the API domain are managed in Railway.

## Deploy

With deployment values in `.env.demo`, run `pnpm demo:deploy:frontend` to
publish Pages, `pnpm demo:deploy:backend` to deploy the API, and
`pnpm demo:deploy:data` to publish a new demo database. The data task uploads a
versioned snapshot, updates the production `FRUGAL_TOKENS_DATABASE_URL` to point
to it, and redeploys the API; the prior snapshot remains on the volume as a
fallback.

The data generator still requires the local `sqlite3` CLI for compaction. Create
a sanitized contributor database with:

```sh
pnpm demo:db:create -- --output contributor.sqlite
```

The generator replaces source locations and conversation working directories
with per-run random aliases such as `~/amber-finch`. The same original path
receives the same alias everywhere in that generated database, while the
original path is not retained. Imported and generated session titles are
replaced, while requested reasoning settings are retained for analytics.
Message, response, reasoning, and tool previews are replaced with typed
placeholders that retain their original character counts. Generate a fresh
snapshot rather than merging archives; canonical branch, occurrence, and lineage
identifiers are scoped to the source database.
