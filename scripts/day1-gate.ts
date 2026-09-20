/**
 * Day-1 validation gate (spec section 6).
 *
 * Answers the only question that matters before this product can be sold: does Shopify
 * actually carry enough evidence, on a real Indian store, to detect failed deliveries and
 * infer returns?
 *
 * Measures coverage, then — most importantly — dumps every distinct carrier event message and
 * shows which ones the current reason dictionary matches. The unmatched list is the raw
 * material for rewriting app/lib/inference/reasons.ts with phrases couriers really write,
 * instead of the placeholder vocabulary shipped today.
 *
 * Usage:
 *   npm run day1 -- <shop-domain> [sampleSize]     fetch a fresh sample from Shopify
 *   npm run day1 -- <shop-domain> --from-db        analyse data already ingested
 *
 * --from-db costs no API calls and works after a backfill, so the reason-dictionary analysis
 * can be re-run every time the rules change.
 */
import { resolveCarrier } from "../app/lib/carriers";
import { classifyReason, matchesFailedAttempt, matchesRto } from "../app/lib/inference/reasons";
import { classifyEventStatus, normalizeStatus, STATUS } from "../app/lib/normalize";
import { writeFileSync } from "node:fs";
import prisma from "../app/db.server";

const shopDomain = process.argv[2];
const fromDb = process.argv.includes("--from-db");
const sampleSize = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 50);

if (!shopDomain) {
  console.error("Usage: npm run day1 -- <shop-domain>.myshopify.com [sampleSize]");
  process.exit(1);
}

const out: string[] = [];
const say = (line = "") => { console.log(line); out.push(line); };

say(`# Day-1 validation report`);
say(`Store: ${shopDomain}`);
say(`Run:   ${new Date().toISOString()}`);
say();

// ---------------------------------------------------------------------------
// Pull the sample
// ---------------------------------------------------------------------------
let orders: any[] = [];

if (fromDb) {
  // Reshape stored facts into the same node shape the GraphQL query returns, so the analysis
  // below is identical whichever source the data came from.
  const shop = await prisma.shop.findUniqueOrThrow({ where: { domain: shopDomain } });
  const rows = await prisma.orderFact.findMany({
    where: { shopId: shop.id },
    include: { shipments: { include: { events: { orderBy: { happenedAt: "asc" } } } } },
    orderBy: { createdAt: "desc" },
    take: sampleSize,
  });
  orders = rows.map((o) => ({
    fulfillments: o.shipments.map((s) => ({
      status: s.rawStatus,
      displayStatus: s.rawStatus,
      trackingInfo: [{ company: s.carrierRaw, number: s.awb, url: s.trackingUrl }],
      events: { nodes: s.events.map((e) => ({ status: e.rawStatus ?? e.status, message: e.message, happenedAt: e.happenedAt })) },
    })),
  }));
  say(`Source: local database (${rows.length} most recent orders, no API calls)`);
  say();
} else {
  // Imported lazily: initialising the Shopify client requires app credentials, which
  // --from-db runs do not need and should not demand.
  const { unauthenticated } = await import("../app/shopify.server");
  const { ORDERS_PAGE_QUERY } = await import("../app/lib/shopify/queries");
  const { admin } = await unauthenticated.admin(shopDomain);
  const since = new Date(Date.now() - 90 * 86400_000).toISOString();
  const res = await admin.graphql(ORDERS_PAGE_QUERY, {
    variables: { first: Math.min(sampleSize, 50), after: null, query: `created_at:>=${since}` },
  });
  const body: any = await res.json();
  if (body.errors) {
    console.error("Query failed:", JSON.stringify(body.errors).slice(0, 500));
    process.exit(1);
  }
  orders = body.data?.orders?.nodes ?? [];
  say(`Source: Shopify Admin API (live sample)`);
  say();
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------
let fulfillments = 0, withAwb = 0, withCarrier = 0, recognisedCarrier = 0, withEvents = 0;
const statusCounts = new Map<string, number>();
const carrierRaw = new Map<string, number>();
const eventMessages = new Map<string, { count: number; statuses: Set<string> }>();
const eventCountDist: number[] = [];
let attemptedOrFailure = 0, deliveredCount = 0, rtoPhraseCount = 0;

for (const o of orders) {
  for (const f of o.fulfillments ?? []) {
    fulfillments += 1;
    const t = (f.trackingInfo ?? [])[0] ?? {};
    if (t.number) withAwb += 1;
    if (t.company) {
      withCarrier += 1;
      carrierRaw.set(t.company, (carrierRaw.get(t.company) ?? 0) + 1);
      if (resolveCarrier(t.company)) recognisedCarrier += 1;
    }
    const evs = f.events?.nodes ?? [];
    eventCountDist.push(evs.length);
    if (evs.length > 0) withEvents += 1;

    const headline = normalizeStatus(f.displayStatus ?? f.status);
    statusCounts.set(headline, (statusCounts.get(headline) ?? 0) + 1);

    for (const e of evs) {
      const st = classifyEventStatus(e.status, e.message);
      statusCounts.set(`event:${st}`, (statusCounts.get(`event:${st}`) ?? 0) + 1);
      if (st === STATUS.ATTEMPTED_DELIVERY || st === STATUS.FAILURE) attemptedOrFailure += 1;
      if (st === STATUS.DELIVERED) deliveredCount += 1;
      if (matchesRto(e.message)) rtoPhraseCount += 1;
      if (e.message && e.message.trim()) {
        const key = e.message.trim();
        const rec = eventMessages.get(key) ?? { count: 0, statuses: new Set<string>() };
        rec.count += 1;
        rec.statuses.add(st);
        eventMessages.set(key, rec);
      }
    }
  }
}

const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${((n / d) * 100).toFixed(1)}%`);

say(`## Coverage (denominators are explicit)`);
say();
say(`| Measure | Count | Of | Rate |`);
say(`|---|---|---|---|`);
say(`| Orders sampled | ${orders.length} | — | — |`);
say(`| Fulfillments | ${fulfillments} | ${orders.length} orders | — |`);
say(`| AWB present | ${withAwb} | ${fulfillments} | ${pct(withAwb, fulfillments)} |`);
say(`| Carrier name present | ${withCarrier} | ${fulfillments} | ${pct(withCarrier, fulfillments)} |`);
say(`| Carrier RECOGNISED by alias table | ${recognisedCarrier} | ${fulfillments} | ${pct(recognisedCarrier, fulfillments)} |`);
say(`| Has >=1 tracking event | ${withEvents} | ${fulfillments} | ${pct(withEvents, fulfillments)} |`);
say(`| Events with a message | ${[...eventMessages.values()].reduce((a, b) => a + b.count, 0)} | — | — |`);
say();
const avgEvents = eventCountDist.length ? (eventCountDist.reduce((a, b) => a + b, 0) / eventCountDist.length).toFixed(1) : "0";
say(`Events per fulfillment: avg ${avgEvents}, max ${Math.max(0, ...eventCountDist)}, zero-event fulfillments ${eventCountDist.filter(n => n === 0).length}`);
say();

say(`## Raw carrier strings seen`);
say();
say(`| Raw value in Shopify | Count | Resolves? |`);
say(`|---|---|---|`);
for (const [name, count] of [...carrierRaw.entries()].sort((a, b) => b[1] - a[1])) {
  say(`| \`${name}\` | ${count} | ${resolveCarrier(name) ? "yes -> " + resolveCarrier(name)!.slug : "**NO**"} |`);
}
if (carrierRaw.size === 0) say(`| _(none)_ | | |`);
say();

say(`## NDR evidence`);
say();
say(`- attempted_delivery or failure events: **${attemptedOrFailure}**`);
say(`- delivered events: ${deliveredCount}`);
say(`- events matching a return-to-origin phrase: **${rtoPhraseCount}**`);
say();

// ---------------------------------------------------------------------------
// The important part: does the reason dictionary actually match reality?
// ---------------------------------------------------------------------------
type Bucket = { msg: string; count: number; detail: string };
const withReason: Bucket[] = [];
const rtoPhrase: Bucket[] = [];
const exceptionNoReason: Bucket[] = [];
const informational: Bucket[] = [];

for (const [msg, rec] of eventMessages.entries()) {
  const r = classifyReason(msg);
  const rto = matchesRto(msg);
  const failedAttempt = matchesFailedAttempt(msg);
  // A message attached to an attempted_delivery or failure event is one the reason
  // classifier is expected to understand. Anything else is transit chatter.
  const onException =
    rec.statuses.has(STATUS.ATTEMPTED_DELIVERY) || rec.statuses.has(STATUS.FAILURE) || Boolean(failedAttempt);

  if (r.reason !== "UNKNOWN") {
    withReason.push({ msg, count: rec.count, detail: `${r.reason} via ${r.ruleId} on "${r.matched}"` });
  } else if (rto) {
    rtoPhrase.push({ msg, count: rec.count, detail: `RTO phrase "${rto}"` });
  } else if (onException) {
    exceptionNoReason.push({ msg, count: rec.count, detail: [...rec.statuses].join(",") });
  } else {
    informational.push({ msg, count: rec.count, detail: [...rec.statuses].join(",") });
  }
}

const table = (rows: Bucket[], cols: string) => {
  say(`| Message | n | ${cols} |`);
  say(`|---|---|---|`);
  for (const b of rows.sort((a, z) => z.count - a.count)) {
    say(`| ${b.msg.replace(/\|/g, "/")} | ${b.count} | ${b.detail.replace(/\|/g, "/")} |`);
  }
  say();
};

say(`## Reason dictionary coverage`);
say();
say(`Distinct messages: ${eventMessages.size}`);
say(`- classified with a reason: **${withReason.length}**`);
say(`- recognised as return-to-origin: **${rtoPhrase.length}**`);
say(`- **exception messages with NO reason class: ${exceptionNoReason.length}** <- the work`);
say(`- informational transit/delivery messages (no reason class needed): ${informational.length}`);
say();

if (exceptionNoReason.length) {
  say(`### Exception messages the dictionary does not understand`);
  say();
  say(`These sit on a failed-attempt or failure event, so the app shows "Reason unknown" for them.`);
  say(`Add rules in \`app/lib/inference/reasons.ts\`, bump RULE_VERSION, then \`npm run reinfer\`.`);
  say();
  table(exceptionNoReason, "Seen on status");
} else {
  say(`### No unexplained exception messages`);
  say();
  say(`Every message on a failed-attempt or failure event was classified. Note this only proves`);
  say(`the dictionary covers what THIS store's couriers wrote in THIS sample.`);
  say();
}

if (withReason.length) {
  say(`### Classified`);
  say();
  table(withReason.slice(0, 40), "Class");
}
if (rtoPhrase.length) {
  say(`### Return-to-origin phrases detected`);
  say();
  table(rtoPhrase, "Matched");
}
if (informational.length) {
  say(`<details><summary>Informational messages (${informational.length}) — no action needed</summary>`);
  say();
  table(informational, "Seen on status");
  say(`</details>`);
  say();
}

// ---------------------------------------------------------------------------
// Go / no-go
// ---------------------------------------------------------------------------
const awbRate = fulfillments ? withAwb / fulfillments : 0;
const carrierRate = fulfillments ? recognisedCarrier / fulfillments : 0;
const coverage = Math.min(awbRate, carrierRate);

say(`## Verdict`);
say();
let verdict: string;
if (fulfillments === 0) {
  verdict = "**NO DATA** — this store has no fulfillments in the window. It cannot validate anything. Recruit a different store.";
} else if (coverage >= 0.7 && attemptedOrFailure > 0) {
  verdict = "**GO — full MVP.** AWB and carrier coverage are sufficient and Shopify is receiving failed-attempt evidence.";
} else if (awbRate >= 0.7 && attemptedOrFailure === 0) {
  verdict = "**GO — audit + tracking hygiene only.** AWB coverage is good but no NDR evidence appeared. Describe live NDR as beta and do not quote an RTO rate.";
} else if (coverage < 0.4) {
  verdict = "**PIVOT.** AWB/carrier coverage is below 40%. Lead with tracking-hygiene repair; do not sell RTO precision on this store.";
} else {
  verdict = "**MARGINAL.** Coverage is between 40% and 70%. Usable for a hygiene-led demo; be explicit about the denominator.";
}
say(verdict);
say();
if (exceptionNoReason.length > 0) {
  say(`> ${exceptionNoReason.length} exception message(s) have no reason class. Those incidents will`);
  say(`> display "Reason unknown". Fix the dictionary before showing reason classes to this merchant.`);
  say();
}

const file = `day1-report-${shopDomain.split(".")[0]}-${new Date().toISOString().slice(0, 10)}.md`;
writeFileSync(file, out.join("\n"));
console.log(`\nReport written to ${file}`);
