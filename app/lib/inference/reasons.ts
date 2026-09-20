import { RULE_VERSION } from "./version";

/**
 * Reason-class dictionary.
 *
 * Deliberately regex/dictionary-based, not an LLM: every classification must be explainable
 * and reproducible, and we have no labelled Indian courier corpus yet. The phrase list below
 * is a STARTING POINT seeded from common courier vocabulary — per the Day-1 gate it must be
 * replaced with phrases actually observed in the design-partner store's event messages
 * before any of it is trusted in a headline number.
 */

export const REASON = {
  CUSTOMER_UNAVAILABLE: "CUSTOMER_UNAVAILABLE",
  ADDRESS_ISSUE: "ADDRESS_ISSUE",
  CUSTOMER_REFUSED: "CUSTOMER_REFUSED",
  PAYMENT_ISSUE: "PAYMENT_ISSUE",
  CARRIER_CAPACITY: "CARRIER_CAPACITY",
  UNKNOWN: "UNKNOWN",
} as const;

export type ReasonClass = (typeof REASON)[keyof typeof REASON];

export const REASON_LABEL: Record<ReasonClass, string> = {
  CUSTOMER_UNAVAILABLE: "Customer unavailable",
  ADDRESS_ISSUE: "Address issue",
  CUSTOMER_REFUSED: "Customer refused",
  PAYMENT_ISSUE: "COD / payment issue",
  CARRIER_CAPACITY: "Carrier or route delay",
  UNKNOWN: "Reason unknown",
};

type ReasonRule = {
  id: string;
  reason: ReasonClass;
  pattern: RegExp;
};

/**
 * Order matters: the first match wins, so the more specific and more actionable classes are
 * listed before the general ones. REFUSED before UNAVAILABLE because "customer refused as he
 * was not available" is a refusal, not an availability problem.
 */
export const REASON_RULES: ReasonRule[] = [
  // --- Explicit refusal ---
  { id: "R-REF-1", reason: REASON.CUSTOMER_REFUSED, pattern: /\b(refus(ed|al)|rejected by (the )?(customer|consignee)|denied acceptance|consignee refused|order cancelled by (customer|consignee)|do(es)? not want)\b/i },
  { id: "R-REF-2", reason: REASON.CUSTOMER_REFUSED, pattern: /\bcancel+ed by (the )?(customer|consignee|receiver)\b/i },

  // --- COD / payment ---
  { id: "R-PAY-1", reason: REASON.PAYMENT_ISSUE, pattern: /\b(cod|cash on delivery)\b.{0,40}\b(not ready|unavailable|arrange|amount|refused|issue|declin)/i },
  { id: "R-PAY-2", reason: REASON.PAYMENT_ISSUE, pattern: /\b(payment|cash|amount) (not ready|not arranged|unavailable|not available|issue|pending)\b/i },
  { id: "R-PAY-3", reason: REASON.PAYMENT_ISSUE, pattern: /\b(no change|exact change|cheque not ready)\b/i },

  // --- Address ---
  { id: "R-ADD-1", reason: REASON.ADDRESS_ISSUE, pattern: /\b(incomplete|wrong|incorrect|invalid|insufficient) address\b/i },
  { id: "R-ADD-2", reason: REASON.ADDRESS_ISSUE, pattern: /\b(unable to locate|could not locate|address not found|not traceable|untraceable|no such (address|consignee)|door locked|premises locked)\b/i },
  { id: "R-ADD-3", reason: REASON.ADDRESS_ISSUE, pattern: /\b(landmark|address) (needed|required|missing)\b/i },
  { id: "R-ADD-4", reason: REASON.ADDRESS_ISSUE, pattern: /\b(pin ?code|pincode) (mismatch|not serviceable|invalid|wrong)\b/i },
  { id: "R-ADD-5", reason: REASON.ADDRESS_ISSUE, pattern: /\b(out of delivery area|non[- ]serviceable|not serviceable|ods\b)/i },
  { id: "R-ADD-6", reason: REASON.ADDRESS_ISSUE, pattern: /\b(shifted|moved|relocated|left the address)\b/i },

  // --- Availability ---
  { id: "R-UNA-1", reason: REASON.CUSTOMER_UNAVAILABLE, pattern: /\b(customer|consignee|recipient) (not available|unavailable|not at home|not present|out of station|travell?ing)\b/i },
  { id: "R-UNA-2", reason: REASON.CUSTOMER_UNAVAILABLE, pattern: /\b(not reachable|unreachable|phone (not reachable|switched off|unanswered|not responding)|no response from (customer|consignee)|number busy|call not (picked|answered))\b/i },
  { id: "R-UNA-3", reason: REASON.CUSTOMER_UNAVAILABLE, pattern: /\b(premises closed|office closed|shop closed|closed on arrival|holiday)\b/i },
  { id: "R-UNA-4", reason: REASON.CUSTOMER_UNAVAILABLE, pattern: /\b(requested (for )?(future|later) delivery|reschedul|deliver (later|tomorrow)|future delivery)\b/i },

  // --- Carrier / operational ---
  { id: "R-CAP-1", reason: REASON.CARRIER_CAPACITY, pattern: /\b(operational (delay|issue)|route (issue|disruption|diverted)|vehicle (breakdown|issue)|capacity|misroute[d]?|missort(ed)?|bag (left|missed)|connection missed)\b/i },
  { id: "R-CAP-2", reason: REASON.CARRIER_CAPACITY, pattern: /\b(weather|flood|rain|strike|bandh|curfew|natural calamity|law and order|lockdown)\b/i },
  { id: "R-CAP-3", reason: REASON.CARRIER_CAPACITY, pattern: /\b(out of delivery time|late arrival|delivery not attempted due to (time|late))\b/i },
];

export type ReasonMatch = {
  reason: ReasonClass;
  ruleId: string | null;
  /** The verbatim snippet that matched, retained as evidence shown in the UI. */
  matched: string | null;
  ruleVersion: string;
};

/**
 * Classify a free-text courier message. Returns UNKNOWN rather than a best guess when no
 * rule fires — an honest unknown is a supported product state, a fabricated reason is not.
 */
export function classifyReason(message: string | null | undefined): ReasonMatch {
  const base = { ruleVersion: RULE_VERSION };
  if (!message || !message.trim()) {
    return { reason: REASON.UNKNOWN, ruleId: null, matched: null, ...base };
  }
  const text = normalizeMessage(message);
  for (const rule of REASON_RULES) {
    const m = text.match(rule.pattern);
    if (m) {
      return { reason: rule.reason, ruleId: rule.id, matched: m[0], ...base };
    }
  }
  return { reason: REASON.UNKNOWN, ruleId: null, matched: null, ...base };
}

/**
 * Light normalization only — collapse whitespace and strip the courier's own status prefix.
 * Transliteration and spelling-variant handling is deliberately deferred until we have seen
 * real messages; inventing variants now would just be guessing.
 */
export function normalizeMessage(message: string): string {
  return message
    .replace(/\s+/g, " ")
    .replace(/^[A-Z_]{3,}\s*[:\-]\s*/, "")
    .trim();
}

/**
 * Phrases that, on their own, indicate a failed delivery attempt even when the structured
 * status is uninformative. Used by opening rule N3.
 */
export const FAILED_ATTEMPT_PHRASES: RegExp[] = [
  /\b(delivery (attempt(ed)?|not done|failed|unsuccessful)|attempted delivery|undelivered|could not be delivered|unable to deliver|delivery exception|ndr\b)/i,
  /\b(no attempt|attempt failed|failed attempt|1st attempt|2nd attempt|3rd attempt|re-?attempt)\b/i,
];

export function matchesFailedAttempt(message: string | null | undefined): string | null {
  if (!message) return null;
  const text = normalizeMessage(message);
  for (const p of FAILED_ATTEMPT_PHRASES) {
    const m = text.match(p);
    if (m) return m[0];
  }
  return null;
}

/**
 * Return-to-origin phrases. These are the ONLY basis for a "Confirmed RTO" label — never a
 * refund, never a cancellation, never staleness.
 */
export const RTO_PHRASES: RegExp[] = [
  /\b(return(ed)? to (origin|shipper|seller|sender|warehouse)|rto\b|returning to origin|return initiated|return to origin initiated)\b/i,
  /\b(returned to (the )?(client|merchant)|shipment returned|rts\b)\b/i,
];

export function matchesRto(message: string | null | undefined): string | null {
  if (!message) return null;
  const text = normalizeMessage(message);
  for (const p of RTO_PHRASES) {
    const m = text.match(p);
    if (m) return m[0];
  }
  return null;
}

/** RTO *delivered* back at origin — the strongest possible signal short of courier API data. */
export const RTO_DELIVERED_PHRASES: RegExp[] = [
  /\b(rto delivered|return delivered|returned and delivered|rto received|return received at origin)\b/i,
];

export function matchesRtoDelivered(message: string | null | undefined): string | null {
  if (!message) return null;
  const text = normalizeMessage(message);
  for (const p of RTO_DELIVERED_PHRASES) {
    const m = text.match(p);
    if (m) return m[0];
  }
  return null;
}
