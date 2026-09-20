# NDR Auditor

A carrier-neutral RTO audit and recovery layer for Indian D2C brands on Shopify. It reads
**only Shopify** — no CSV upload, no Shiprocket or Delhivery login — and shows where delivery
attempts and returns are leaking revenue, which shipments Shopify cannot track, and what to act
on now.

> **What this is not.** It does not create shipments, buy labels, allocate couriers, or trigger a
> courier reattempt. It is a measurement and recovery layer that sits alongside your existing
> shipping software, not a replacement for it.

## The honesty constraint

Shopify has **no native structured RTO state and no standard NDR reason code**. This product
infers, scores and explains — it never pretends. Three rules are enforced in code, not just in
copy:

- **"Confirmed RTO" requires explicit evidence.** A return-to-origin phrase plus movement toward
  origin, or a delivery scan on the return leg. Never a refund. Never a cancellation. Never silence.
- **Every inferred row shows its evidence**, the rule that fired, the matched text, and a rule
  version. See any shipment's timeline page.
- **Every number carries its denominator.** A rate with a zero denominator renders as `—`, never
  as `0%`.

Low-confidence (staleness-only) findings are excluded from the headline RTO rate by default, and
`N4` "stuck / investigate" findings are never counted as delivery failures.

## Quick start

```bash
docker compose up -d
cp .env.example .env
cp shopify.app.example.toml shopify.app.toml   # then: npx shopify app config link
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"  # -> APP_ENCRYPTION_KEY
npx prisma db push
npm run seed      # 500-order demo store with realistic Indian courier data
npm run verify    # metric integrity checks
npm run dev       # or: npm run dev:remix
npm run worker    # background jobs, in a second terminal
```

`npm run dev` uses the Shopify CLI and needs `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` from a real
app. `npm run dev:remix` runs the Remix server alone, which is enough to work on the buyer
recovery page and to inspect seeded data.

## Architecture

```
Shopify ──webhook──> /webhooks ──> Job queue (Postgres) ──> worker
                      HMAC + receipt          │
                      (idempotency barrier)   ├─> ingest   (facts: orders, shipments, events)
                                              ├─> derive   (incidents, confidence, evidence)
                                              ├─> rollups  (scorecards, hygiene)
                                              └─> alert    (WhatsApp / console)
```

**Ingestion and derivation are deliberately separate.** Facts are what Shopify said; derivation is
what we concluded. That split is why `npm run reinfer` can replay every stored shipment under a new
rule version without spending a single Shopify API call — which is exactly what you need after the
Day-1 gate replaces the placeholder reason dictionary with real observed phrases.

| Layer | Choice | Why |
|-------|--------|-----|
| App | Remix + Shopify App Bridge + Polaris | Fastest supported embedded-app path |
| API | Admin **GraphQL** only (`removeRest: true`) | REST Admin API is legacy |
| Database | PostgreSQL + Prisma | Relational analytics, idempotent upserts |
| Jobs | **Postgres-backed queue**, not BullMQ/Redis | One less service to provision and one less thing to be down during a live demo. Jobs survive restarts because they were never only in memory. Revisit under sustained webhook volume. |
| Alerts | Pluggable: `console` (default), `twilio`, `meta` | The console provider keeps the install-to-audit demo working with zero WhatsApp setup, so business verification and template approval can never block the core story. |

## Data coverage is stated, never assumed

Without the `read_all_orders` scope (which needs Shopify approval) Shopify exposes only ~60 days of
orders. The app detects this at install and sets its window to what it can actually deliver — the
dashboard says *"60-day audit until extended order access is approved"* rather than claiming 90 and
quietly returning less.

## Commands

| Command | What it does |
|---------|--------------|
| `npm run dev` | Shopify CLI dev (tunnel + embedded app) |
| `npm run dev:remix` | Remix dev server only |
| `npm run worker` | Background job worker |
| `npm run seed` | Seed the 500-order demo store |
| `npm run verify` | Metric integrity checks (launch checklist) |
| `npm run reinfer` | Replay inference under the current rule version |
| `npm run demo:token` | Mint a recovery link for demo rehearsal |
| `npm test` | 65 unit tests |
| `npm run typecheck` | `tsc --noEmit` |

## Security and privacy

- Shopify offline tokens encrypted at rest; buyer address corrections encrypted with AES-256-GCM.
- Raw webhook bodies retained **7 days** for debugging, then purged.
- Recovery links: 32 bytes of entropy, stored **only as SHA-256**, 48-hour expiry, looked up by
  hash so there is no ID space to enumerate. Missing and expired tokens return an identical 404 so
  the page cannot be used as an oracle.
- Merchant alerts never contain a full AWB, full phone number, or the buyer's address.
- Every write to Shopify is logged before/after with an actor, and is reversible by hand.
- CSV export neutralises formula injection (`=`, `+`, `-`, `@`) — courier messages are
  attacker-influenceable free text that lands directly in an Excel cell.
- Mandatory compliance webhooks implemented: `customers/data_request`, `customers/redact`,
  `shop/redact`, `app/uninstalled`.

## Before you demo or sell

1. **Run the [Day-1 validation gate](docs/day-1-validation.md).** It overrides every assumption in
   this repo, and the reason dictionary is a placeholder until it is done.
2. Confirm `app/lib/shopify/queries.ts` against the pinned API version's live schema.
3. Verify the carrier alias table against Shopify's current supported-carrier list.
4. See [docs/demo-script.md](docs/demo-script.md) for the three-minute run of show.

## Status

Implemented: OAuth + tenant bootstrap, resumable newest-first backfill, webhook pipeline with HMAC
and idempotency, inference engine (N1–N4 + RTO levels + reason classes + confidence), audit
dashboard with courier/pincode/SKU/payment/week cuts, tracking hygiene + carrier correction with
dry run, live NDR alerts with dedupe and quiet hours, buyer recovery page, outcome labelling, CSV
evidence export, seeded demo store, 65 tests.

Not implemented (deliberately deferred per the spec's cut list): PDF export, direct buyer WhatsApp,
bulk auto-fix without confirmation, courier reattempt APIs.
