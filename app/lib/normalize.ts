import { resolveCarrier, isValidTrackingUrl } from "./carriers";
import { matchesRto, matchesRtoDelivered } from "./inference/reasons";

/**
 * Normalized shipment status vocabulary.
 *
 * Shopify exposes several overlapping status enums (FulfillmentStatus,
 * FulfillmentDisplayStatus, FulfillmentEventStatus) whose exact members vary by API
 * version. We collapse them into one vocabulary here so the inference engine never has to
 * know which enum a value came from. Anything we do not recognise becomes UNKNOWN and stays
 * visible in the UI — it is never silently dropped.
 */
export const STATUS = {
  PENDING: "PENDING",
  LABEL_PRINTED: "LABEL_PRINTED",
  IN_TRANSIT: "IN_TRANSIT",
  OUT_FOR_DELIVERY: "OUT_FOR_DELIVERY",
  ATTEMPTED_DELIVERY: "ATTEMPTED_DELIVERY",
  DELIVERED: "DELIVERED",
  /**
   * A delivery scan for the RETURN leg: the parcel reached the origin, not the buyer.
   * Couriers report this with status=delivered and only the message distinguishes it, so we
   * split it here, once, at ingestion. Downstream this keeps it out of deliveredAt, out of
   * the delivered% metric, and out of the engine's "delivered beats everything" rule.
   */
  RTO_DELIVERED: "RTO_DELIVERED",
  FAILURE: "FAILURE",
  CANCELED: "CANCELED",
  UNKNOWN: "UNKNOWN",
} as const;

export type ShipmentStatus = (typeof STATUS)[keyof typeof STATUS];

const STATUS_MAP: Record<string, ShipmentStatus> = {
  // FulfillmentEventStatus
  label_printed: STATUS.LABEL_PRINTED,
  label_purchased: STATUS.LABEL_PRINTED,
  attempted_delivery: STATUS.ATTEMPTED_DELIVERY,
  ready_for_pickup: STATUS.OUT_FOR_DELIVERY,
  picked_up: STATUS.IN_TRANSIT,
  confirmed: STATUS.PENDING,
  in_transit: STATUS.IN_TRANSIT,
  out_for_delivery: STATUS.OUT_FOR_DELIVERY,
  delivered: STATUS.DELIVERED,
  failure: STATUS.FAILURE,
  // FulfillmentDisplayStatus / FulfillmentStatus
  submitted: STATUS.PENDING,
  open: STATUS.PENDING,
  pending: STATUS.PENDING,
  success: STATUS.DELIVERED,
  fulfilled: STATUS.IN_TRANSIT,
  not_delivered: STATUS.FAILURE,
  canceled: STATUS.CANCELED,
  cancelled: STATUS.CANCELED,
  error: STATUS.FAILURE,
};

export function normalizeStatus(raw: string | null | undefined): ShipmentStatus {
  if (!raw) return STATUS.UNKNOWN;
  const key = raw.toLowerCase().replace(/[\s-]+/g, "_").trim();
  return STATUS_MAP[key] ?? STATUS.UNKNOWN;
}

/**
 * Status for a single event, taking the message into account.
 *
 * Only ever DOWNGRADES a delivered scan to RTO_DELIVERED when the message says the parcel
 * went back to origin. It never promotes anything to delivered — a message must not be able
 * to manufacture a delivery that the carrier's own status did not report.
 */
export function classifyEventStatus(
  raw: string | null | undefined,
  message: string | null | undefined,
): ShipmentStatus {
  const status = normalizeStatus(raw);
  if (status !== STATUS.DELIVERED) return status;
  return matchesRtoDelivered(message) || matchesRto(message) ? STATUS.RTO_DELIVERED : status;
}

/** Statuses that mean the parcel is moving and has not yet reached a terminal state. */
export const IN_FLIGHT: ShipmentStatus[] = [
  STATUS.IN_TRANSIT,
  STATUS.OUT_FOR_DELIVERY,
  STATUS.ATTEMPTED_DELIVERY,
];

// ---------------------------------------------------------------------------
// Payment mode
// ---------------------------------------------------------------------------

/**
 * COD detection is rule-driven and per-shop editable, because gateway naming is merchant
 * specific ("Cash on Delivery (COD)", "COD", "manual", custom app gateways). Ambiguity
 * returns UNKNOWN rather than guessing PREPAID — an unknown bucket stays visible in the
 * dashboard, a wrong guess silently distorts the COD-vs-prepaid cut.
 */
export type PaymentMode = "COD" | "PREPAID" | "UNKNOWN";

export function derivePaymentMode(gatewayNames: string[], codRules: string[]): PaymentMode {
  if (!gatewayNames || gatewayNames.length === 0) return "UNKNOWN";
  const rules = codRules.map((r) => r.toLowerCase().trim()).filter(Boolean);
  const names = gatewayNames.map((g) => (g ?? "").toLowerCase().trim()).filter(Boolean);
  if (names.length === 0) return "UNKNOWN";

  const anyCod = names.some((n) => rules.some((r) => n === r || n.includes(r)));
  if (anyCod) return "COD";

  // A recognised prepaid gateway is a positive signal; an unrecognised one is not.
  const KNOWN_PREPAID = ["razorpay", "payu", "cashfree", "stripe", "paypal", "shopify_payments", "shopify payments", "phonepe", "paytm", "ccavenue", "instamojo", "juspay", "billdesk", "gokwik", "simpl"];
  const anyPrepaid = names.some((n) => KNOWN_PREPAID.some((p) => n.includes(p)));
  return anyPrepaid ? "PREPAID" : "UNKNOWN";
}

// ---------------------------------------------------------------------------
// Pincode
// ---------------------------------------------------------------------------

export function pincodePrefix(zip: string | null | undefined): string | null {
  if (!zip) return null;
  const digits = zip.replace(/\D/g, "");
  if (digits.length < 3) return null;
  return digits.slice(0, 3);
}

export function normalizePincode(zip: string | null | undefined): string | null {
  if (!zip) return null;
  const digits = zip.replace(/\D/g, "");
  return digits.length === 6 ? digits : null;
}

// ---------------------------------------------------------------------------
// Trackability
// ---------------------------------------------------------------------------

export type TrackabilityInput = {
  awb: string | null | undefined;
  carrierRaw: string | null | undefined;
  trackingUrl: string | null | undefined;
  eventCount: number;
};

/**
 * trackable = AWB present AND (carrier recognised OR valid tracking URL) AND at least one
 * post-fulfillment event. All three legs matter: an AWB with no events means nobody is
 * watching the parcel, which is exactly the leak the hygiene report exists to name.
 */
export function isTrackable(input: TrackabilityInput): boolean {
  const hasAwb = Boolean(input.awb && input.awb.trim().length >= 5);
  if (!hasAwb) return false;
  const carrierOk = resolveCarrier(input.carrierRaw) !== null || isValidTrackingUrl(input.trackingUrl);
  if (!carrierOk) return false;
  return input.eventCount > 0;
}

// ---------------------------------------------------------------------------
// Identity helpers
// ---------------------------------------------------------------------------

/** Last 4 of an AWB, for alerts. Never put a full AWB in a group message. */
export function maskAwb(awb: string | null | undefined): string {
  if (!awb) return "n/a";
  const s = awb.trim();
  return s.length <= 4 ? s : s.slice(-4);
}

export function maskOrderName(name: string): string {
  return name;
}

/** Numeric ID from a Shopify GID such as gid://shopify/Order/12345. */
export function gidToId(gid: string | null | undefined): string {
  if (!gid) return "";
  const parts = gid.split("/");
  return parts[parts.length - 1] ?? gid;
}
