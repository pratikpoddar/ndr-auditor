import type { PrismaClient, Shop } from "@prisma/client";
import {
  DEFAULT_CONFIG,
  inferShipment,
  countsTowardHeadlineRto,
  countsTowardNdr,
  type InferenceConfig,
  type RtoLevel,
} from "./inference/engine";
import type { ShipmentStatus } from "./normalize";
import { computeHygiene } from "./hygiene";
import { median } from "./metrics";

/**
 * Derivation pass: read facts, run the pure inference engine, persist incidents.
 *
 * Nothing here talks to Shopify. That is intentional — `npm run reinfer` can replay every
 * stored shipment under a new RULE_VERSION without spending a single API call.
 */

export function configFor(shop: Shop, now = new Date()): InferenceConfig {
  return {
    ...DEFAULT_CONFIG,
    staleOfdHours: shop.staleOfdHours,
    staleNoEventDays: shop.staleNoEventDays,
    now,
  };
}

export type DeriveResult = {
  incidentId: string | null;
  created: boolean;
  /** True when this pass moved the incident into a state worth alerting on. */
  alertable: boolean;
};

/**
 * Recompute the incident for one shipment. Always driven by source events, so a later
 * delivered event reverses an earlier RTO inference rather than leaving a stale label.
 */
export async function deriveShipment(
  prisma: PrismaClient,
  shop: Shop,
  shipmentId: string,
  now = new Date(),
): Promise<DeriveResult> {
  const shipment = await prisma.shipment.findUnique({
    where: { id: shipmentId },
    include: { events: true, order: true, incidents: true },
  });
  if (!shipment) return { incidentId: null, created: false, alertable: false };

  const existing = shipment.incidents[0] ?? null;

  const result = inferShipment(
    {
      fulfillmentId: shipment.fulfillmentId,
      currentStatus: shipment.currentStatus as ShipmentStatus,
      firstShippedAt: shipment.firstShippedAt,
      events: shipment.events.map((e) => ({
        id: e.id,
        status: e.status as ShipmentStatus,
        happenedAt: e.happenedAt,
        message: e.message,
        city: e.city,
      })),
    },
    {
      value: Number(shipment.order.value),
      cancelledAt: shipment.order.cancelledAt,
      refundAmount: Number(shipment.order.refundAmount),
      lastRefundAt: shipment.order.lastRefundAt,
    },
    configFor(shop, now),
    { contactedAt: existing?.contactedAt ?? null },
  );

  // No incident should exist. If one does (rules changed, or the shipment was corrected),
  // remove it rather than leaving an orphan claim on the dashboard.
  if (!result.incident) {
    if (existing) await prisma.nDRIncident.delete({ where: { id: existing.id } });
    return { incidentId: null, created: false, alertable: false };
  }

  const inc = result.incident;
  const payload = {
    shopId: shop.id,
    shipmentId: shipment.id,
    openedAt: inc.openedAt,
    triggerEventId: inc.triggerEventId,
    openRule: inc.openRule,
    reasonClass: inc.reasonClass,
    reasonEvidence: inc.reasonEvidence,
    confidence: inc.confidence,
    confidenceBand: inc.confidenceBand,
    evidence: inc.evidence as any,
    ruleVersion: inc.ruleVersion,
    rtoLevel: inc.rtoLevel,
    rtoRule: inc.rtoRule,
    riskValue: inc.riskValue,
    recomputedAt: now,
  };

  if (existing) {
    // Preserve workflow state that a source event does not override: once CONTACTED, the
    // engine's freshly-computed NDR_OPEN must not erase the fact that we reached out.
    const state =
      inc.state === "NDR_OPEN" && existing.contactedAt ? "CONTACTED" : inc.state;

    const updated = await prisma.nDRIncident.update({
      where: { id: existing.id },
      data: { ...payload, state },
    });

    // Auto-close: a delivery inside the attribution window after contact is a recovery;
    // a delivery before contact is a natural resolution we do not take credit for.
    if (inc.rtoLevel === "NOT_RTO") {
      await recordAutoOutcome(prisma, updated.id, shipment.deliveredAt, existing.contactedAt, Number(shipment.order.value), now, shop);
    }

    return { incidentId: updated.id, created: false, alertable: false };
  }

  const created = await prisma.nDRIncident.create({
    data: {
      ...payload,
      state: inc.state,
      actionDueAt: new Date(inc.openedAt.getTime() + 24 * 3600_000),
    },
  });

  // Only genuine delivery failures are alertable. N4 "stuck" findings go to the dashboard,
  // never to WhatsApp — paging an ops lead about a quiet tracking feed destroys trust fast.
  const alertable =
    countsTowardNdr(inc.openRule, inc.isStuckOnly) && inc.rtoLevel !== "NOT_RTO";

  return { incidentId: created.id, created: true, alertable };
}

async function recordAutoOutcome(
  prisma: PrismaClient,
  incidentId: string,
  deliveredAt: Date | null,
  contactedAt: Date | null,
  orderValue: number,
  now: Date,
  shop: Shop,
) {
  const existing = await prisma.recoveryOutcome.findFirst({
    where: { incidentId, evidenceType: "AUTO_DELIVERED_EVENT" },
  });
  if (existing) return;

  const incident = await prisma.nDRIncident.findUnique({ where: { id: incidentId } });
  if (!incident || !deliveredAt) return;

  const windowMs = DEFAULT_CONFIG.recoveryWindowDays * 86400_000;
  const withinWindow = deliveredAt.getTime() - incident.openedAt.getTime() <= windowMs;
  const afterContact = Boolean(contactedAt && deliveredAt.getTime() >= contactedAt.getTime());

  // Attribution rule (spec 4.6): we claim credit only when we intervened first and the
  // delivery landed inside the window. Everything else is logged as naturally resolved.
  const claimed = withinWindow && afterContact;

  await prisma.recoveryOutcome.create({
    data: {
      incidentId,
      outcome: claimed ? "RECOVERED" : "NATURALLY_RESOLVED",
      outcomeAt: deliveredAt,
      evidenceType: "AUTO_DELIVERED_EVENT",
      actor: "system",
      finalStatus: "DELIVERED",
      realizedValue: claimed ? orderValue : 0,
      note: claimed
        ? `Delivered ${Math.round((deliveredAt.getTime() - incident.openedAt.getTime()) / 86400_000)}d after the exception and after merchant contact.`
        : afterContact
          ? "Delivered outside the attribution window; not counted as recovered."
          : "Delivered without any intervention from this app; not counted as recovered.",
    },
  });
}

// ---------------------------------------------------------------------------
// Rollups
// ---------------------------------------------------------------------------

export async function recomputeRollups(
  prisma: PrismaClient,
  shop: Shop,
  windowStart: Date,
  windowEnd: Date,
): Promise<void> {
  const shipments = await prisma.shipment.findMany({
    where: { shopId: shop.id, order: { createdAt: { gte: windowStart, lt: windowEnd } } },
    include: { order: true, incidents: true },
  });

  // --- courier scorecards ---
  type Acc = {
    shipped: number; trackable: number; attempted: number; failed: number;
    high: number; medium: number; delivered: number; days: number[]; risk: number;
  };
  const byCarrier = new Map<string, Acc>();
  const acc = (k: string): Acc => {
    if (!byCarrier.has(k)) {
      byCarrier.set(k, { shipped: 0, trackable: 0, attempted: 0, failed: 0, high: 0, medium: 0, delivered: 0, days: [], risk: 0 });
    }
    return byCarrier.get(k)!;
  };

  for (const s of shipments) {
    // Unknown carriers get their own bucket and are never dropped from the denominator.
    const a = acc(s.carrierNormalized ?? "unknown");
    a.shipped += 1;
    if (s.trackable) a.trackable += 1;
    if (s.deliveredAt) {
      a.delivered += 1;
      if (s.firstShippedAt) {
        a.days.push((s.deliveredAt.getTime() - s.firstShippedAt.getTime()) / 86400_000);
      }
    }
    const inc = s.incidents[0];
    if (inc) {
      const isNdr = countsTowardNdr(inc.openRule, inc.openRule === "N4");
      if (isNdr) a.attempted += 1;
      if (inc.openRule === "N2") a.failed += 1;
      if (inc.rtoLevel === "HIGH" || inc.rtoLevel === "CONFIRMED") a.high += 1;
      if (inc.rtoLevel === "MEDIUM") a.medium += 1;
      if (countsTowardHeadlineRto(inc.rtoLevel as RtoLevel)) a.risk += Number(inc.riskValue);
    }
  }

  for (const [carrier, a] of byCarrier) {
    const data = {
      shopId: shop.id, windowStart, windowEnd, carrier,
      shipped: a.shipped, trackable: a.trackable, attempted: a.attempted, failed: a.failed,
      inferredRtoHigh: a.high, inferredRtoMedium: a.medium, delivered: a.delivered,
      medianDeliveryDays: median(a.days), valueAtRisk: a.risk, computedAt: new Date(),
    };
    await prisma.courierScorecard.upsert({
      where: { shopId_windowStart_windowEnd_carrier: { shopId: shop.id, windowStart, windowEnd, carrier } },
      create: data,
      update: data,
    });
  }

  // --- hygiene ---
  const hygiene = computeHygiene(
    shipments.map((s) => ({
      fulfillmentId: s.fulfillmentId,
      awb: s.awb,
      carrierRaw: s.carrierRaw,
      trackingUrl: s.trackingUrl,
      lastEventAt: s.lastEventAt,
      createdAt: s.createdAt,
      currentStatus: s.currentStatus,
    })),
    new Date(),
  );

  const hygieneData = {
    shopId: shop.id, windowStart, windowEnd,
    totalFulfillments: hygiene.totalFulfillments,
    missingAwb: hygiene.missingAwb,
    missingCarrier: hygiene.missingCarrier,
    unrecognizedCarrier: hygiene.unrecognizedCarrier,
    duplicateAwb: hygiene.duplicateAwb,
    invalidUrl: hygiene.invalidUrl,
    staleTracking: hygiene.staleTracking,
    score: hygiene.score,
    computedAt: new Date(),
  };
  await prisma.trackingHygieneReport.upsert({
    where: { shopId_windowStart_windowEnd: { shopId: shop.id, windowStart, windowEnd } },
    create: hygieneData,
    update: hygieneData,
  });
}

/** Replay inference over every stored shipment for a shop, under the current rule version. */
export async function reinferShop(prisma: PrismaClient, shop: Shop, now = new Date()): Promise<number> {
  const ids = await prisma.shipment.findMany({ where: { shopId: shop.id }, select: { id: true } });
  for (const { id } of ids) {
    await deriveShipment(prisma, shop, id, now);
  }
  return ids.length;
}
