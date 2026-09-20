# Day-1 validation gate

**This gate decides whether the core data thesis is true on real Indian stores. Run it before
writing any inference rule against real data.** Nothing downstream of here is trustworthy until
this is filled in with real numbers from a real store.

The code already written assumes this gate passes. If it does not, the decision table at the
bottom says what to build instead — that is a product decision, not a bug.

## Why this exists

Shopify has no native RTO field and no standard NDR reason code. This product infers both. The
inference is only as good as the evidence Shopify actually receives from Indian couriers and
aggregators, and that varies per store. Assume nothing; measure it.

## Checklist

Record the answers in the table below. Do not skip a row because it "obviously" works.

| # | Check | How | Result |
|---|-------|-----|--------|
| 1 | Consenting dev/design-partner store with recent Delhivery / XpressBees / Ecom Express / Blue Dart / DTDC / Ekart shipments | | |
| 2 | App installed; granted scopes and API version recorded | Settings page shows both | |
| 3 | 50 recent orders pulled; fulfillments enumerated | `npm run verify` | |
| 4 | % fulfillments with AWB present | | |
| 5 | % fulfillments with carrier present | | |
| 6 | % fulfillments whose carrier string **resolves** in `app/lib/carriers.ts` | Hygiene page | |
| 7 | Event count distribution per fulfillment | | |
| 8 | ≥5 known-delivered AWBs verified to show delivered in Shopify | | |
| 9 | ≥3 known failed-attempt AWBs verified to show `attempted_delivery`, `failure`, or useful free text | | |
| 10 | Aggregator behaviour: did Shiprocket/Delhivery create the Shopify fulfillment and AWB? Is the spelling recognised? | | |
| 11 | Fulfillment update webhook: HMAC verified, receipt time, payload shape, re-fetch result | | |
| 12 | One tracking-info correction on a dev fulfillment; number + URL preserved; tracking improves | Hygiene page → Dry run → Apply | |
| 13 | Are 90-day orders accessible without `read_all_orders`? If not, the app must show 60 days | Settings page badge | |
| 14 | Real NDR phrases observed in event messages, collected verbatim | | |
| 15 | Confirm aggregator returns do **not** appear as a structured Shopify RTO | | |

## Critical: rebuild the reason dictionary from observed data

`app/lib/inference/reasons.ts` ships with phrases seeded from common courier vocabulary. **They
are a placeholder.** After check 14, replace them with phrases actually observed, then:

```bash
# bump RULE_VERSION in app/lib/inference/version.ts, then:
npm run reinfer
```

Because ingestion and derivation are separate, this costs zero Shopify API calls and re-derives
every stored incident. `npm run reinfer` prints a before/after distribution so a rule change that
moves large numbers of shipments between confidence bands is visible immediately.

## Also confirm against the pinned API version

`API_VERSION` in `app/shopify.server.ts` is pinned to the newest stable version the installed
`@shopify/shopify-api` client supports. Confirm every field in `app/lib/shopify/queries.ts`
exists in that version's schema — fulfillment **event** shape is the most likely to differ. If a
field is absent, delete it from the query rather than defending against it downstream.

## Go / no-go thresholds

| Result | Decision |
|--------|----------|
| ≥70% fulfillments have AWB + carrier, and known NDRs produce attempted/failure evidence | **Go** with the full MVP |
| AWB coverage good, NDR event coverage weak | **Go** with audit + tracking hygiene; describe live NDR as beta |
| AWB/carrier coverage <40% | **Pivot** the demo to tracking-hygiene repair first; do not sell RTO precision |
| No merchant can supply known NDR examples | **Do not code inference blind.** Recruit a second store |

## Output required before Day 2

A one-page report with exact denominators and 10 redacted AWB timelines. Export them with the
CSV button on any shipment page.
