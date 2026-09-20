import crypto from "node:crypto";

/**
 * Shopify does not always expose a stable ID for fulfillment events. Hashing the immutable
 * content of the event gives us an idempotency key, so re-ingesting the same timeline (on a
 * webhook retry or a backfill re-run) does not duplicate rows.
 *
 * Server-only: it lives here rather than in normalize.ts so that node:crypto never reaches
 * the client bundle — normalize.ts is imported by the inference engine, which the dashboard
 * imports for its status labels.
 */
export function deterministicEventId(parts: {
  fulfillmentId: string;
  status: string;
  happenedAt: string | Date;
  message?: string | null;
  city?: string | null;
}): string {
  const at = parts.happenedAt instanceof Date ? parts.happenedAt.toISOString() : String(parts.happenedAt);
  const basis = [parts.fulfillmentId, parts.status, at, parts.message ?? "", parts.city ?? ""].join("|");
  return "h_" + crypto.createHash("sha256").update(basis).digest("hex").slice(0, 32);
}
