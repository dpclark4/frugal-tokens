# Demo deployment

These commands maintain the hosted demo. The demo frontend is deployed to Pages,
and its API runs as a Railway service with a mounted volume.

## Configuration

Copy the demo environment template and update its values:

```sh
cp .env.demo.example .env.demo
```

The demo tasks load `.env.demo`. `FRUGAL_TOKENS_DATABASE_URL` should point to
the local archive used as the source for demo database snapshots.

The `demo-api` Railway service must mount the `demo-api-volume` volume at
`/data`. Sleep configuration and the API domain are managed in Railway.

## Deploy

With deployment values in `.env.demo`, run `deno task demo:deploy:frontend` to
publish Pages, `deno task demo:deploy:backend` to deploy the API, and
`deno task demo:deploy:data` to publish a new demo database. The data task
uploads a versioned snapshot, updates the production
`FRUGAL_TOKENS_DATABASE_URL` to point to it, and redeploys the API; the prior
snapshot remains on the volume as a fallback.

Create a sanitized contributor database with:

```sh
deno task demo:db:create -- --output contributor.sqlite
```

To add it to an existing sanitized demo database, run:

```sh
deno task demo:db:merge -- --target demo.sqlite --source contributor.sqlite
```

The merge modifies the target in place, requires matching schemas and sanitized
inputs, and skips sessions whose retained source checksum is already present.
