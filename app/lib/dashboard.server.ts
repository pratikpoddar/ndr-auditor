import type { PrismaClient, Shop } from "@prisma/client";
import { countsTowardHeadlineRto, countsTowardNdr } from "./inference/engine";
import { carrierLabel } from "./carriers";
import { emptyRow, finalizeRows, rankByLeakage, rate, type SegmentRow } from "./metrics";

/**
 * Dashboard aggregation.
 *
 * Every figure returned here carries its denominator, and every rate is null (rendered as
 * "—") rather than 0 when the denominator is zero. A 0% NDR rate on zero shipments is a lie
 * the merchant would reasonably act on.
 */

export type Filters = {
  carrier?: string | null;
  paymentMode?: string | null;
  pincodePrefix?: string | null;
  sku?: string | null;
};

export type Headline = {
  windowFrom: Date;
  windowTo: Date;
  coverageFrom: Date | null;
  shippedOrders: number;
  fulfillments: number;
  trackable: number;
  trackingCoveragePct: number | null;
  ndrCount: number;
  ndrRatePct: number | null;
  stuckCount: number;
  rtoHeadlineCount: number;
  rtoRatePct: number | null;
  rtoLowCount: number;
  valueAtRisk: number;
  recoveredValue: number;
  recoveredCount: number;
  eligibleForRecovery: number;
  recoveryRatePct: number | null;
  currency: string;
  unknownCarrier: number;
  unknownPaymentMode: number;
};

function windowFor(shop: Shop): { from: Date; to: Date } {
  const to = new Date();
  const from = new Date(to.getTime() - shop.auditWindowDays * 86400_000);
  return { from, to };
}

function whereClause(shop: Shop, from: Date, to: Date, f: Filters) {
  return {
    shopId: shop.id,
    order: {
      createdAt: { gte: from, lte: to },
      ...(f.paymentMode ? { paymentMode: f.paymentMode } : {}),
      ...(f.pincodePrefix ? { pincodePrefix: f.pincodePrefix } : {}),
      ...(f.sku ? { items: { some: { sku: f.sku } } } : {}),
    },
    ...(f.carrier ? { carrierNormalized: f.carrier === "unknown" ? null : f.carrier } : {}),
  };
}

export type AuditData = {
  headline: Headline;
  byCarrier: SegmentRow[];
  byPincode: SegmentRow[];
  bySku: SegmentRow[];
  byPaymentMode: SegmentRow[];
  byWeek: SegmentRow[];
};

export async function loadAudit(prisma: PrismaClient, shop: Shop, filters: Filters = {}): Promise<AuditData> {
  const { from, to } = windowFor(shop);

  const shipments = await prisma.shipment.findMany({
    where: whereClause(shop, from, to, filters),
    include: {
      order: { include: { items: true } },
      incidents: { include: { outcomes: true } },
    },
  });

  const headline: Headline = {
    windowFrom: from,
    windowTo: to,
    coverageFrom: shop.backfillCoverageFrom,
    shippedOrders: new Set(shipments.map((s) => s.orderId)).size,
    fulfillments: shipments.length,
    trackable: 0,
    trackingCoveragePct: null,
    ndrCount: 0,
    ndrRatePct: null,
    stuckCount: 0,
    rtoHeadlineCount: 0,
    rtoRatePct: null,
    rtoLowCount: 0,
    valueAtRisk: 0,
    recoveredValue: 0,
    recoveredCount: 0,
    eligibleForRecovery: 0,
    recoveryRatePct: null,
    currency: shop.currency,
    unknownCarrier: 0,
    unknownPaymentMode: 0,
  };

  const carriers = new Map<string, SegmentRow>();
  const pincodes = new Map<string, SegmentRow>();
  const skus = new Map<string, SegmentRow>();
  const payments = new Map<string, SegmentRow>();
  const weeks = new Map<string, SegmentRow>();

  const bump = (map: Map<string, SegmentRow>, key: string, label: string): SegmentRow => {
    if (!map.has(key)) map.set(key, emptyRow(key, label));
    return map.get(key)!;
  };

  for (const s of shipments) {
    const inc = s.incidents[0];
    const isNdr = inc ? countsTowardNdr(inc.openRule, inc.openRule === "N4") : false;
    const isHeadlineRto = inc ? countsTowardHeadlineRto(inc.rtoLevel as any) : false;
    const risk = isHeadlineRto ? Number(inc!.riskValue) : 0;
    const deliveryDays =
      s.deliveredAt && s.firstShippedAt
        ? (s.deliveredAt.getTime() - s.firstShippedAt.getTime()) / 86400_000
        : null;

    if (s.trackable) headline.trackable += 1;
    if (!s.carrierNormalized) headline.unknownCarrier += 1;
    if (s.order.paymentMode === "UNKNOWN") headline.unknownPaymentMode += 1;
    if (isNdr) headline.ndrCount += 1;
    if (inc && inc.openRule === "N4") headline.stuckCount += 1;
    if (isHeadlineRto) headline.rtoHeadlineCount += 1;
    if (inc && inc.rtoLevel === "LOW") headline.rtoLowCount += 1;
    headline.valueAtRisk += risk;

    if (inc) {
      // Eligibility for the recovery rate is stated explicitly: a genuine NDR that we could
      // still act on. Naturally-resolved deliveries are excluded from both sides.
      const claimed = inc.outcomes.find((o) => o.outcome === "RECOVERED");
      if (isNdr) headline.eligibleForRecovery += 1;
      if (claimed) {
        headline.recoveredCount += 1;
        headline.recoveredValue += Number(claimed.realizedValue);
      }
    }

    const apply = (row: SegmentRow) => {
      row.shipped += 1;
      if (s.trackable) row.trackable += 1;
      if (isNdr) row.ndr += 1;
      if (inc?.rtoLevel === "HIGH" || inc?.rtoLevel === "CONFIRMED") row.rtoHigh += 1;
      if (inc?.rtoLevel === "MEDIUM") row.rtoMedium += 1;
      if (s.deliveredAt) row.delivered += 1;
      row.valueAtRisk += risk;
      if (deliveryDays !== null) row.deliveryDays.push(deliveryDays);
    };

    const carrierKey = s.carrierNormalized ?? "unknown";
    apply(bump(carriers, carrierKey, s.carrierNormalized ? carrierLabel(carrierKey) : `Unrecognized: ${s.carrierRaw ?? "none"}`));

    const pinKey = s.order.pincodePrefix ?? "unknown";
    apply(bump(pincodes, pinKey, pinKey === "unknown" ? "Unknown pincode" : `${pinKey}xxx`));

    const payKey = s.order.paymentMode;
    apply(bump(payments, payKey, payKey === "UNKNOWN" ? "Unknown payment mode" : payKey));

    const weekKey = isoWeek(s.order.createdAt);
    apply(bump(weeks, weekKey, weekKey));

    // A shipment is counted once per distinct SKU it contains, so SKU rows do not
    // double-count a multi-line order's shipment against itself.
    const seen = new Set<string>();
    for (const item of s.order.items) {
      const key = item.sku ?? "no-sku";
      if (seen.has(key)) continue;
      seen.add(key);
      apply(bump(skus, key, item.sku ?? `${item.title ?? "Untitled"} (no SKU)`));
    }
  }

  headline.trackingCoveragePct = rate(headline.trackable, headline.fulfillments);
  headline.ndrRatePct = rate(headline.ndrCount, headline.fulfillments);
  headline.rtoRatePct = rate(headline.rtoHeadlineCount, headline.fulfillments);
  headline.recoveryRatePct = rate(headline.recoveredCount, headline.eligibleForRecovery);

  return {
    headline,
    byCarrier: rankByLeakage(finalizeRows([...carriers.values()])),
    byPincode: rankByLeakage(finalizeRows([...pincodes.values()])).slice(0, 15),
    bySku: rankByLeakage(finalizeRows([...skus.values()])).slice(0, 15),
    byPaymentMode: finalizeRows([...payments.values()]),
    byWeek: finalizeRows([...weeks.values()]).sort((a, b) => a.key.localeCompare(b.key)),
  };
}

function isoWeek(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
