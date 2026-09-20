import { resolveCarrier, isValidTrackingUrl } from "./carriers";

/**
 * Tracking hygiene score, spec 4.3.
 *
 * The formula is shown in the UI verbatim. Weights are a judgement call, documented here so
 * a merchant can argue with them: AWB presence and a recognised carrier dominate because
 * without either, Shopify never polls the shipment and the entire audit goes blind.
 */
export const HYGIENE_WEIGHTS = {
  awbPresent: 0.35,
  carrierRecognized: 0.35,
  statusFreshness: 0.2,
  noDuplicates: 0.1,
} as const;

export const HYGIENE_FORMULA =
  "100 × (0.35 × AWB present + 0.35 × recognised carrier or valid URL + 0.20 × status fresh + 0.10 × no duplicate AWB)";

export type HygieneShipment = {
  fulfillmentId: string;
  awb: string | null;
  carrierRaw: string | null;
  trackingUrl: string | null;
  lastEventAt: Date | null;
  createdAt: Date;
  currentStatus: string;
};

export type HygieneReport = {
  totalFulfillments: number;
  missingAwb: number;
  missingCarrier: number;
  unrecognizedCarrier: number;
  duplicateAwb: number;
  invalidUrl: number;
  staleTracking: number;
  score: number;
  formula: string;
};

/** A shipment is "stale" if it is not terminal and has had no event for > 5 days. */
const STALE_DAYS = 5;

export function computeHygiene(shipments: HygieneShipment[], now: Date): HygieneReport {
  const total = shipments.length;
  if (total === 0) {
    return {
      totalFulfillments: 0,
      missingAwb: 0,
      missingCarrier: 0,
      unrecognizedCarrier: 0,
      duplicateAwb: 0,
      invalidUrl: 0,
      staleTracking: 0,
      score: 0,
      formula: HYGIENE_FORMULA,
    };
  }

  const awbCounts = new Map<string, number>();
  for (const s of shipments) {
    if (s.awb) awbCounts.set(s.awb, (awbCounts.get(s.awb) ?? 0) + 1);
  }

  let missingAwb = 0;
  let missingCarrier = 0;
  let unrecognizedCarrier = 0;
  let duplicateAwb = 0;
  let invalidUrl = 0;
  let staleTracking = 0;

  for (const s of shipments) {
    if (!s.awb) missingAwb += 1;
    if (!s.carrierRaw) missingCarrier += 1;
    else if (!resolveCarrier(s.carrierRaw)) unrecognizedCarrier += 1;

    if (s.awb && (awbCounts.get(s.awb) ?? 0) > 1) duplicateAwb += 1;
    if (s.trackingUrl && !isValidTrackingUrl(s.trackingUrl)) invalidUrl += 1;

    const terminal = s.currentStatus === "DELIVERED" || s.currentStatus === "CANCELED";
    const reference = s.lastEventAt ?? s.createdAt;
    const ageDays = (now.getTime() - reference.getTime()) / 86400_000;
    if (!terminal && ageDays > STALE_DAYS) staleTracking += 1;
  }

  // Carrier leg is satisfied by a recognised carrier OR a usable tracking URL — a merchant
  // using an aggregator's own tracking link is not blind, just non-standard.
  const carrierOk = shipments.filter(
    (s) => resolveCarrier(s.carrierRaw) !== null || isValidTrackingUrl(s.trackingUrl),
  ).length;

  const score =
    100 *
    (HYGIENE_WEIGHTS.awbPresent * ((total - missingAwb) / total) +
      HYGIENE_WEIGHTS.carrierRecognized * (carrierOk / total) +
      HYGIENE_WEIGHTS.statusFreshness * ((total - staleTracking) / total) +
      HYGIENE_WEIGHTS.noDuplicates * ((total - duplicateAwb) / total));

  return {
    totalFulfillments: total,
    missingAwb,
    missingCarrier,
    unrecognizedCarrier,
    duplicateAwb,
    invalidUrl,
    staleTracking,
    score: Number(score.toFixed(1)),
    formula: HYGIENE_FORMULA,
  };
}
