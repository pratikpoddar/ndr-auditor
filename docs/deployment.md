# Deploying to Fly.io

Two processes from one image: `web` (embedded app + webhook endpoint) and `worker` (drains the
Postgres job queue). Primary region is `bom` (Mumbai) because the merchants and their stores
are in India.

## Why the web machine never scales to zero

`auto_stop_machines = false` and `min_machines_running = 1` are deliberate. Shopify times a
webhook out after a few seconds; a cold start would blow that budget on the first delivery
after any quiet period. Shopify would retry and the receipt table makes retries safe, but NDR
detection latency would drift well past the two-minute target in the spec.

## One-time setup

```bash
export PATH="$HOME/.fly/bin:$PATH"
fly auth login                      # browser
fly apps create ndr-auditor
fly postgres create --name ndr-auditor-db --region bom --initial-cluster-size 1 --vm-size shared-cpu-1x --volume-size 1
fly postgres attach ndr-auditor-db --app ndr-auditor    # sets DATABASE_URL
```

Then the secrets. `fly secrets set` writes them directly to the platform — they never enter the
repo, a build arg, or a log.

```bash
fly secrets set --app ndr-auditor \
  SHOPIFY_API_KEY="<client id from shopify.app.toml>" \
  SHOPIFY_API_SECRET="<client secret from the Partner dashboard>" \
  SHOPIFY_APP_URL="https://ndr-auditor.fly.dev" \
  APP_ENCRYPTION_KEY="$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))')"
```

> `APP_ENCRYPTION_KEY` encrypts buyer address corrections. Generate it **once**. Rotating it
> makes every previously encrypted value undecryptable — there is no recovery path.

## Deploy

```bash
fly deploy --app ndr-auditor
fly scale count web=1 worker=1 --app ndr-auditor
fly logs --app ndr-auditor
curl https://ndr-auditor.fly.dev/healthz     # {"status":"ok"}
```

Migrations run automatically on boot via `prisma migrate deploy`, which only applies committed
migrations — it never generates or resets, so a bad deploy cannot drop merchant data the way
`prisma db push` can.

## Point Shopify at the deployed app

```bash
npx shopify app deploy      # pushes application_url, redirect URLs and webhook subscriptions
```

Confirm in `shopify.app.toml` that `application_url` is the Fly domain, not a tunnel.

## After deploying

- [ ] `/healthz` returns 200
- [ ] `fly logs` shows `worker started`
- [ ] Install on a dev store; confirm a `Shop` row, granted scopes, and `backfillState`
- [ ] Fire a test webhook and confirm a `WebhookReceipt` row plus a drained job
- [ ] Confirm the webhook endpoint rejects a bad HMAC with 401

## Cost

Roughly $3–6/month: two shared-cpu-1x/256–512MB machines plus a 1GB Postgres volume. The worker
could scale to zero since jobs are durable in Postgres, but leaving it running is what keeps
NDR detection inside the two-minute target.

## Scaling later

The queue is Postgres-backed, so `fly scale count worker=2` is safe — `claimNext` locks each job
with a state-guarded `updateMany`, so two workers racing produce one winner and one no-op.
