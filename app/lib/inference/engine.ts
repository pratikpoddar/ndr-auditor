import { STATUS, type ShipmentStatus } from "../normalize";
import { RULE_VERSION } from "./version";
import {
  classifyReason,
  matchesFailedAttempt,
  matchesRto,
  matchesRtoDelivered,
  REASON,
  type ReasonClass,
} from "./reasons";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EventInput = {
  id: string;
  status: ShipmentStatus;
  happenedAt: Date;
  message?: string | null;
  city?: string | null;
};

export type ShipmentInput = {
  fulfillmentId: string;
  currentStatus: ShipmentStatus;
  firstShippedAt?: Date | null;
  events: EventInput[];
};

export type OrderInput = {
  value: number;
  cancelledAt?: Date | null;
  refundAmount: number;
  lastRefundAt?: Date | null;
};

export type InferenceConfig = {
  /** N4: hours out-for-delivery with no progress before we call it "stuck". */
  staleOfdHours: number;
  /** RTO-Low: days with no event after a failed attempt before "unresolved". */
  staleNoEventDays: number;
  /** RTO-High: window in which a return phrase still attributes to this attempt. */
  rtoReturnWindowDays: number;
  /** RTO-Medium: days with no delivery before a cancel/refund may correlate. */
  refundCorrelationDays: number;
  /** Auto-recovery attribution window after an incident opens. */
  recoveryWindowDays: number;
  now: Date;
};

export const DEFAULT_CONFIG: Omit<InferenceConfig, "now"> = {
  staleOfdHours: 36,
  staleNoEventDays: 10,
  rtoReturnWindowDays: 21,
  refundCorrelationDays: 7,
  recoveryWindowDays: 7,
};

export type ConfidenceBand = "HIGH" | "MEDIUM" | "LOW";

export type RtoLevel = "CONFIRMED" | "HIGH" | "MEDIUM" | "LOW" | "NOT_RTO" | "NONE";

export type IncidentState =
  | "OBSERVED"
  | "NDR_OPEN"
  | "CONTACTED"
  | "DELIVERED_RECOVERED"
  | "LIKELY_RTO"
  | "CONFIRMED_RTO"
  | "EXPIRED";

export type Evidence = {
  rule: string;
  ruleVersion: string;
  matched: string | null;
  eventIds: string[];
  notes: string[];
};

export type InferenceResult = {
  /** null = no incident should exist for this shipment. */
  incident: {
    openedAt: Date;
    triggerEventId: string | null;
    openRule: "N1" | "N2" | "N3" | "N4";
    reasonClass: ReasonClass;
    reasonEvidence: string | null;
    confidence: number;
    confidenceBand: ConfidenceBand;
    evidence: Evidence;
    ruleVersion: string;
    state: IncidentState;
    rtoLevel: RtoLevel;
    rtoRule: string | null;
    riskValue: number;
    /** N4 "stuck" findings are investigate-only and excluded from NDR headline counts. */
    isStuckOnly: boolean;
  } | null;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HOUR = 3600_000;
const DAY = 24 * HOUR;

function hoursBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / HOUR;
}
function daysBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / DAY;
}

function sortedEvents(events: EventInput[]): EventInput[] {
  return [...events].sort((a, b) => a.happenedAt.getTime() - b.happenedAt.getTime());
}

function bandFor(confidence: number): ConfidenceBand {
  if (confidence >= 0.85) return "HIGH";
  if (confidence >= 0.6) return "MEDIUM";
  return "LOW";
}

// ---------------------------------------------------------------------------
// NDR opening rules (spec 3: N1..N4)
// ---------------------------------------------------------------------------

type OpenMatch = {
  rule: "N1" | "N2" | "N3" | "N4";
  event: EventInput | null;
  openedAt: Date;
  confidence: number;
  matched: string | null;
  notes: string[];
  isStuckOnly: boolean;
};

function findOpeningEvent(shipment: ShipmentInput, cfg: InferenceConfig): OpenMatch | null {
  const events = sortedEvents(shipment.events);

  // N1 — structured attempted_delivery. Strongest available signal in Shopify.
  const attempted = events.find((e) => e.status === STATUS.ATTEMPTED_DELIVERY);
  if (attempted) {
    return {
      rule: "N1",
      event: attempted,
      openedAt: attempted.happenedAt,
      confidence: 0.95,
      matched: attempted.message ?? null,
      notes: ["Structured attempted_delivery status reported by the carrier."],
      isStuckOnly: false,
    };
  }

  // N2 — failure that follows in-transit/out-for-delivery. A failure before the parcel ever
  // moved is a label/booking error, not a delivery exception, so we require prior movement.
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.status !== STATUS.FAILURE) continue;
    const movedBefore = events
      .slice(0, i)
      .some((p) => p.status === STATUS.IN_TRANSIT || p.status === STATUS.OUT_FOR_DELIVERY);
    if (movedBefore) {
      return {
        rule: "N2",
        event: e,
        openedAt: e.happenedAt,
        confidence: 0.86,
        matched: e.message ?? null,
        notes: ["Failure status after the shipment was in transit or out for delivery."],
        isStuckOnly: false,
      };
    }
  }

  // N3 — free-text failed-attempt phrase on a shipment that is not delivered.
  if (shipment.currentStatus !== STATUS.DELIVERED) {
    for (const e of events) {
      const matched = matchesFailedAttempt(e.message);
      if (matched) {
        return {
          rule: "N3",
          event: e,
          openedAt: e.happenedAt,
          confidence: 0.7,
          matched,
          notes: [`Matched failed-attempt phrase in carrier message: "${matched}".`],
          isStuckOnly: false,
        };
      }
    }
  }

  // N4 — staleness. Explicitly NOT an NDR: surfaced as "stuck / investigate" only.
  const last = events[events.length - 1];
  if (last && shipment.currentStatus !== STATUS.DELIVERED && shipment.currentStatus !== STATUS.CANCELED) {
    const idleHours = hoursBetween(last.happenedAt, cfg.now);
    if (last.status === STATUS.OUT_FOR_DELIVERY && idleHours > cfg.staleOfdHours) {
      return {
        rule: "N4",
        event: last,
        openedAt: last.happenedAt,
        confidence: 0.4,
        matched: null,
        notes: [`Out for delivery with no further event for ${Math.floor(idleHours)}h (threshold ${cfg.staleOfdHours}h).`],
        isStuckOnly: true,
      };
    }
    if (last.status === STATUS.IN_TRANSIT && idleHours > cfg.staleNoEventDays * 24) {
      return {
        rule: "N4",
        event: last,
        openedAt: last.happenedAt,
        confidence: 0.35,
        matched: null,
        notes: [`In transit with no event for ${Math.floor(idleHours / 24)} days (threshold ${cfg.staleNoEventDays} days).`],
        isStuckOnly: true,
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// RTO inference (spec 3)
// ---------------------------------------------------------------------------

type RtoVerdict = {
  level: RtoLevel;
  rule: string | null;
  matched: string | null;
  eventIds: string[];
  note: string;
  /** Confidence contribution; null means "leave the NDR confidence alone". */
  confidence: number | null;
};

function inferRto(
  shipment: ShipmentInput,
  order: OrderInput,
  open: OpenMatch,
  cfg: InferenceConfig,
): RtoVerdict {
  const events = sortedEvents(shipment.events);
  const afterOpen = events.filter((e) => e.happenedAt.getTime() >= open.openedAt.getTime());

  // CONFIRMED — a delivery scan on the RETURN leg. Checked before the delivered rule below,
  // because such an event carries status=delivered and would otherwise read as a success.
  const rtoDeliveredEvent = afterOpen.find((e) => e.status === STATUS.RTO_DELIVERED);
  if (rtoDeliveredEvent) {
    return {
      level: "CONFIRMED",
      rule: "RTO-CONFIRMED-0",
      matched: rtoDeliveredEvent.message ?? null,
      eventIds: [rtoDeliveredEvent.id],
      note: "Carrier recorded a delivery scan on the return leg: the parcel was delivered back to origin.",
      confidence: 0.97,
    };
  }

  // NOT RTO — a genuine delivery to the buyer after the incident always wins.
  const deliveredAfter = afterOpen.find((e) => e.status === STATUS.DELIVERED);
  if (deliveredAfter) {
    return {
      level: "NOT_RTO",
      rule: "RTO-NOT",
      matched: null,
      eventIds: [deliveredAfter.id],
      note: "Delivered event recorded after the exception; the shipment reached the buyer.",
      confidence: null,
    };
  }

  // CONFIRMED — explicit return-delivered phrasing, or a return phrase followed by movement.
  for (const e of afterOpen) {
    const rtoDelivered = matchesRtoDelivered(e.message);
    if (rtoDelivered) {
      return {
        level: "CONFIRMED",
        rule: "RTO-CONFIRMED-1",
        matched: rtoDelivered,
        eventIds: [e.id],
        note: `Carrier message explicitly reports the return completed: "${rtoDelivered}".`,
        confidence: 0.97,
      };
    }
  }
  for (let i = 0; i < afterOpen.length; i++) {
    const e = afterOpen[i];
    const rtoPhrase = matchesRto(e.message);
    if (!rtoPhrase) continue;
    // A return phrase followed by at least one further movement event is a return in progress
    // that the carrier kept scanning — strong enough to call confirmed.
    const movementAfter = afterOpen
      .slice(i + 1)
      .some((n) => n.status === STATUS.IN_TRANSIT || n.status === STATUS.RTO_DELIVERED);
    if (movementAfter) {
      return {
        level: "CONFIRMED",
        rule: "RTO-CONFIRMED-2",
        matched: rtoPhrase,
        eventIds: [e.id],
        note: `Return-to-origin phrase "${rtoPhrase}" followed by further carrier movement toward origin.`,
        confidence: 0.93,
      };
    }
    // HIGH — return phrase within the attribution window, no later delivery.
    if (daysBetween(open.openedAt, e.happenedAt) <= cfg.rtoReturnWindowDays) {
      return {
        level: "HIGH",
        rule: "RTO-HIGH",
        matched: rtoPhrase,
        eventIds: [e.id],
        note: `Return phrase "${rtoPhrase}" within ${cfg.rtoReturnWindowDays} days of the failed attempt, with no later delivery.`,
        confidence: 0.88,
      };
    }
  }

  // MEDIUM — refund/cancel correlated. Only valid AFTER the attempt and inside the window.
  // Never fires on refund alone: `open` already proves a shipment exception occurred.
  const noDeliveryDays = daysBetween(open.openedAt, cfg.now);
  if (noDeliveryDays >= cfg.refundCorrelationDays) {
    const cancelAfter = order.cancelledAt && order.cancelledAt.getTime() > open.openedAt.getTime();
    const refundAfter = order.lastRefundAt && order.lastRefundAt.getTime() > open.openedAt.getTime();
    // "Substantially refunded" = at least 80% of order value, so partial/goodwill refunds
    // and single-item returns on a multi-item order do not get counted as an RTO.
    const substantialRefund = order.value > 0 && order.refundAmount / order.value >= 0.8;

    if (cancelAfter) {
      return {
        level: "MEDIUM",
        rule: "RTO-MEDIUM-CANCEL",
        matched: null,
        eventIds: [],
        note: `Order cancelled ${order.cancelledAt!.toISOString().slice(0, 10)}, after the failed attempt, with no delivery for ${Math.floor(noDeliveryDays)} days.`,
        confidence: 0.72,
      };
    }
    if (refundAfter && substantialRefund) {
      return {
        level: "MEDIUM",
        rule: "RTO-MEDIUM-REFUND",
        matched: null,
        eventIds: [],
        note: `Order substantially refunded after the failed attempt, with no delivery for ${Math.floor(noDeliveryDays)} days.`,
        confidence: 0.68,
      };
    }
  }

  // LOW — silence after a failed attempt. Weakest signal; excluded from headline RTO.
  const lastEvent = events[events.length - 1];
  if (lastEvent && daysBetween(lastEvent.happenedAt, cfg.now) >= cfg.staleNoEventDays) {
    return {
      level: "LOW",
      rule: "RTO-LOW",
      matched: null,
      eventIds: [lastEvent.id],
      note: `No carrier event for ${Math.floor(daysBetween(lastEvent.happenedAt, cfg.now))} days after the failed attempt.`,
      confidence: 0.45,
    };
  }

  return {
    level: "NONE",
    rule: null,
    matched: null,
    eventIds: [],
    note: "Exception is still live; no return signal yet.",
    confidence: null,
  };
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

/**
 * Source events always win over stored workflow state. A merchant or buyer label is retained
 * as evidence elsewhere (RecoveryOutcome / BuyerResponse) but never overwrites what the
 * carrier reported — that separation is what keeps the audit defensible.
 */
function deriveState(rto: RtoVerdict, open: OpenMatch, contactedAt: Date | null | undefined): IncidentState {
  if (rto.level === "NOT_RTO") return "DELIVERED_RECOVERED";
  if (rto.level === "CONFIRMED") return "CONFIRMED_RTO";
  if (rto.level === "HIGH" || rto.level === "MEDIUM") return "LIKELY_RTO";
  if (open.isStuckOnly) return "OBSERVED";
  if (contactedAt) return "CONTACTED";
  return "NDR_OPEN";
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function inferShipment(
  shipment: ShipmentInput,
  order: OrderInput,
  cfg: InferenceConfig,
  existing?: { contactedAt?: Date | null },
): InferenceResult {
  const open = findOpeningEvent(shipment, cfg);
  if (!open) return { incident: null };

  const rto = inferRto(shipment, order, open, cfg);

  // Reason classification uses the triggering event's message, falling back to the nearest
  // message around the attempt when the trigger event itself carries no text.
  const reasonSource =
    open.event?.message ??
    sortedEvents(shipment.events)
      .filter((e) => Math.abs(hoursBetween(e.happenedAt, open.openedAt)) <= 24)
      .map((e) => e.message)
      .find((m) => Boolean(m && m.trim())) ??
    null;

  const reason = classifyReason(reasonSource);

  // Confidence: the RTO verdict, when it has one, supersedes the opening confidence because
  // it is derived from strictly more evidence. Otherwise the opening rule's score stands.
  const confidence = rto.confidence ?? open.confidence;

  const notes = [...open.notes, rto.note];
  if (reason.ruleId) {
    notes.push(`Reason rule ${reason.ruleId} matched "${reason.matched}".`);
  } else {
    notes.push("No reason phrase matched; reason recorded as unknown.");
  }

  const eventIds = [...new Set([...(open.event ? [open.event.id] : []), ...rto.eventIds])];

  const state = deriveState(rto, open, existing?.contactedAt ?? null);

  return {
    incident: {
      openedAt: open.openedAt,
      triggerEventId: open.event?.id ?? null,
      openRule: open.rule,
      reasonClass: open.isStuckOnly ? REASON.UNKNOWN : reason.reason,
      reasonEvidence: reason.matched,
      confidence: Number(confidence.toFixed(2)),
      confidenceBand: bandFor(confidence),
      evidence: {
        rule: rto.rule ? `${open.rule} + ${rto.rule}` : open.rule,
        ruleVersion: RULE_VERSION,
        matched: rto.matched ?? open.matched,
        eventIds,
        notes,
      },
      ruleVersion: RULE_VERSION,
      state,
      rtoLevel: rto.level,
      rtoRule: rto.rule,
      riskValue: order.value,
      isStuckOnly: open.isStuckOnly,
    },
  };
}

// ---------------------------------------------------------------------------
// UI labels — the exact wording the spec requires. Never "confirmed RTO" for an inference.
// ---------------------------------------------------------------------------

export const RTO_LABEL: Record<RtoLevel, string> = {
  CONFIRMED: "Confirmed RTO",
  HIGH: "Likely RTO — high confidence",
  MEDIUM: "Likely RTO — refund/cancel correlated",
  LOW: "Unresolved shipment — possible RTO",
  NOT_RTO: "Recovered / delivered",
  NONE: "Open exception",
};

/**
 * Headline RTO rate counts CONFIRMED + HIGH + MEDIUM only. LOW is staleness-only evidence
 * and would inflate the number with shipments we simply cannot see.
 */
export function countsTowardHeadlineRto(level: RtoLevel): boolean {
  return level === "CONFIRMED" || level === "HIGH" || level === "MEDIUM";
}

/** N4 findings are "stuck / investigate", not delivery failures. */
export function countsTowardNdr(openRule: string, isStuckOnly: boolean): boolean {
  return !isStuckOnly && openRule !== "N4";
}
