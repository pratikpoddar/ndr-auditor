# Three-minute demo script

## Before the room

```bash
docker compose up -d
npm run seed          # backup store, in case the live install fails
npm run verify        # confirm the numbers reconcile
npm run worker &      # jobs must be draining during the live install
npm run demo:token    # one recovery link, pre-minted
```

- One QR code / install URL ready.
- One merchant WhatsApp test recipient, **or** `ALERT_PROVIDER=console` and the recovery link
  opened straight from the app. Do not let template approval gate the core story.
- Pre-warm infra but **do not pre-install** the app — the live install is the demo.
- 90-second screen recording on the laptop in case venue internet fails.

## Script

| Time | Action and words |
|------|------------------|
| 0:00–0:20 | "You already pay for shipping software. I am not replacing it. I am showing you what the common Shopify data says across all your couriers." → **Install the app.** |
| 0:20–0:45 | Grant scopes. "No Shiprocket login, no Delhivery login, no CSV." Show the scan progress banner and the **actual coverage dates**. |
| 0:45–1:20 | Dashboard. "Tracking coverage, attempted deliveries, likely RTO with a confidence qualifier, and rupees at risk. Every card shows its window and its denominator." |
| 1:20–1:55 | Click the worst courier → drill to one AWB timeline. **"This block is source evidence from Shopify. This label is our inference — and here is the rule that produced it."** |
| 1:55–2:20 | Tracking hygiene. Show an unrecognized carrier name and the correction preview. "Bad carrier naming means Shopify cannot watch the shipment at all." Run a **dry run**, not the write. |
| 2:20–2:45 | Replay one failed attempt → merchant alert + recovery link. Open the link on a phone. |
| 2:45–3:00 | "I need ten brands for a 30-day founding cohort. ₹4,999, only if we identify at least 3× the fee in recoverable leakage." Show QR. |

## Demo integrity — non-negotiable

These are the moments where it is tempting to overclaim. Don't.

- **Backfill incomplete at 3:00?** Show partial results with the progress banner. That is the
  honest state, and newest-first means the interesting rows are already on screen.
- **Store has no NDR evidence?** Say so, and lead with the tracking-hygiene score instead. An
  empty recovery queue is a real finding, not a failed demo.
- **Do not call refunds RTO.** The app does not, and neither should you.
- **Do not imply the recovery button triggers a courier reattempt.** It does not. It captures buyer
  intent and hands it to the merchant.
- If asked for an exact RTO count, give the confidence breakdown, not a single number.

## If someone asks "how is this different from Shipway / Pragma?"

"They are shipping and communication suites — they run your operations. I am a neutral
measurement layer that scores whatever tracking reaches Shopify, across every courier you use,
with no courier configuration. They will have reason codes and reattempt APIs I do not, because
they integrate directly. I will tell you which of your couriers is actually costing you money,
without being one of them."

## Founding cohort offer

| Plan | Monthly | Includes |
|------|---------|----------|
| Founding 10 | ₹4,999 | Up to 2,000 shipments, audit where API access allows, live NDR alerts, recovery links, weekly scorecard, direct founder support |
| Growth | ₹9,999 | Up to 10,000 shipments, multi-user ops, exports, higher alert volume, priority support |

**Guarantee wording:** "In the first 30 days, if the app does not identify at least ₹14,997 of
**high- or medium-confidence** recoverable leakage using the agreed definition, we waive the fee."

Tie the promise to *identified opportunities*, not realised deliveries — the app cannot force
courier action, and promising an outcome you do not control is how a founding cohort turns into a
refund queue. Define "identify", eligible shipments, window and exclusions in writing before the
first invoice.
