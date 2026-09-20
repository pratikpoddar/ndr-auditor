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

/**
 * Locale is derived from the shop's currency rather than hardcoded.
 *
 * Digit grouping is not cosmetic: en-IN groups as 1,53,698 (lakh) and en-US as 153,698. A USD
 * store rendered with en-IN shows "$1,53,698", which reads as a typo to an American merchant
 * and silently undermines every number on the page.
 */
const CURRENCY_LOCALE: Record<string, string> = {
  INR: "en-IN",
  USD: "en-US",
  GBP: "en-GB",
  EUR: "de-DE",
  AED: "en-AE",
  SAR: "en-SA",
  AUD: "en-AU",
  CAD: "en-CA",
  SGD: "en-SG",
  MYR: "en-MY",
  LKR: "en-LK",
  BDT: "bn-BD",
  NPR: "ne-NP",
  PKR: "en-PK",
};

export function localeForCurrency(currency: string | null | undefined): string {
  if (!currency) return "en-US";
  return CURRENCY_LOCALE[currency.toUpperCase()] ?? "en-US";
}

/** Money in the shop's own currency and grouping convention. */
export function formatMoney(value: number, currency = "INR"): string {
  const locale = localeForCurrency(currency);
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    // Unknown ISO code: still render something truthful rather than throwing.
    return `${currency} ${Math.round(value).toLocaleString(locale)}`;
  }
}

/** Plain counts, grouped the same way as money so a page does not mix conventions. */
export function formatCount(value: number, currency = "INR"): string {
  return value.toLocaleString(localeForCurrency(currency));
}

/** Inclusive-start, exclusive-end window description used on every card. */
export function describeWindow(from: Date, to: Date, timezone: string, currency = "INR"): string {
  const locale = localeForCurrency(currency);
  const fmt = (d: Date) =>
    new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric", timeZone: timezone }).format(d);
  return `${fmt(from)} – ${fmt(to)}`;
}

/** Date+time in the shop's timezone and locale. Used on timelines and exports. */
export function formatDateTime(d: Date | string, timezone: string, currency = "INR"): string {
  return new Intl.DateTimeFormat(localeForCurrency(currency), {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: timezone,
  }).format(typeof d === "string" ? new Date(d) : d);
}
