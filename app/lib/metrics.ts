/**
 * Aggregation helpers. Two rules run through all of this:
 *   1. Every number carries its denominator — a rate with no base is not evidence.
 *   2. Low-volume segments are labelled "insufficient sample" and never ranked as worst.
 */

/** Below this shipment count, a segment cannot be ranked. */
export const MIN_SAMPLE = 20;

export type SegmentRow = {
  key: string;
  label: string;
  shipped: number;
  trackable: number;
  ndr: number;
  rtoHigh: number;
  rtoMedium: number;
  delivered: number;
  valueAtRisk: number;
  deliveryDays: number[];
  insufficientSample: boolean;
};

export function emptyRow(key: string, label: string): SegmentRow {
  return {
    key,
    label,
    shipped: 0,
    trackable: 0,
    ndr: 0,
    rtoHigh: 0,
    rtoMedium: 0,
    delivered: 0,
    valueAtRisk: 0,
    deliveryDays: [],
    insufficientSample: true,
  };
}

export function rate(numerator: number, denominator: number): number | null {
  if (!denominator) return null;
  return Number(((numerator / denominator) * 100).toFixed(1));
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return Number((s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2).toFixed(1));
}

/** Median delivery time for a segment. Client-safe: rendered directly in the dashboard. */
export function medianDays(row: SegmentRow): number | null {
  return median(row.deliveryDays);
}

export function finalizeRows(rows: SegmentRow[]): SegmentRow[] {
  return rows.map((r) => ({ ...r, insufficientSample: r.shipped < MIN_SAMPLE }));
}

/**
 * Rank segments worst-first for the "where is the leak" view. Segments below MIN_SAMPLE are
 * pushed to the bottom regardless of their rate — a 100% failure rate on 2 shipments is
 * noise, and presenting it as the worst courier would discredit the whole audit.
 */
export function rankByLeakage(rows: SegmentRow[]): SegmentRow[] {
  return [...rows].sort((a, b) => {
    if (a.insufficientSample !== b.insufficientSample) return a.insufficientSample ? 1 : -1;
    const aRate = (a.rtoHigh + a.rtoMedium) / Math.max(a.shipped, 1);
    const bRate = (b.rtoHigh + b.rtoMedium) / Math.max(b.shipped, 1);
    if (bRate !== aRate) return bRate - aRate;
    return b.valueAtRisk - a.valueAtRisk;
  });
}

export function formatINR(value: number, currency = "INR"): string {
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return `${currency} ${Math.round(value).toLocaleString("en-IN")}`;
  }
}

/** Inclusive-start, exclusive-end window description used on every card. */
export function describeWindow(from: Date, to: Date, timezone: string): string {
  const fmt = (d: Date) =>
    new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: timezone }).format(d);
  return `${fmt(from)} – ${fmt(to)}`;
}
