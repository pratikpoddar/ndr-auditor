import { describe, it, expect } from "vitest";
import { rate, median, rankByLeakage, finalizeRows, emptyRow, formatINR, MIN_SAMPLE } from "../app/lib/metrics";
import { inQuietHours, renderMerchantAlert } from "../app/lib/alerts/whatsapp.server";
import { REASON } from "../app/lib/inference/reasons";

describe("rate", () => {
  it("returns null, never 0, when the denominator is zero", () => {
    // A 0% NDR rate on zero shipments is a lie a merchant would act on.
    expect(rate(0, 0)).toBeNull();
    expect(rate(5, 0)).toBeNull();
    expect(rate(1, 4)).toBe(25);
  });
});

describe("median", () => {
  it("handles odd, even and empty inputs", () => {
    expect(median([1, 5, 3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

function row(key: string, shipped: number, rtoHigh = 0, valueAtRisk = 0) {
  return { ...emptyRow(key, key), shipped, rtoHigh, valueAtRisk };
}

describe("low-volume suppression", () => {
  it("marks segments below the minimum sample", () => {
    const rows = finalizeRows([row("a", MIN_SAMPLE), row("b", MIN_SAMPLE - 1)]);
    expect(rows[0].insufficientSample).toBe(false);
    expect(rows[1].insufficientSample).toBe(true);
  });

  it("never ranks a tiny segment as the worst courier", () => {
    // 2 shipments both RTO = 100%, but ranking it worst would discredit the whole audit.
    const ranked = rankByLeakage(finalizeRows([
      row("tiny", 2, 2),
      row("real", 200, 40),
    ]));
    expect(ranked[0].key).toBe("real");
    expect(ranked[1].key).toBe("tiny");
  });

  it("breaks ties on value at risk", () => {
    const ranked = rankByLeakage(finalizeRows([
      row("low-value", 100, 10, 5_000),
      row("high-value", 100, 10, 90_000),
    ]));
    expect(ranked[0].key).toBe("high-value");
  });
});

describe("formatINR", () => {
  it("formats in the Indian numbering system", () => {
    expect(formatINR(153698)).toContain("1,53,698");
  });
});

describe("merchant alert template", () => {
  it("never leaks a full AWB, address or phone number", () => {
    const msg = renderMerchantAlert({
      orderName: "#1042", carrier: "Delhivery", awb: "12345678901234",
      statusLabel: "Likely RTO — high confidence", reason: REASON.CUSTOMER_UNAVAILABLE,
      city: "Pune", value: 2400, currency: "INR", link: "https://app.test/r/abc",
    });
    expect(msg.body).not.toContain("12345678901234");
    expect(msg.body).toContain("1234"); // last four only
    expect(msg.body).toContain("#1042");
    expect(msg.body).toContain("https://app.test/r/abc");
  });
});

describe("quiet hours", () => {
  const shop = (start: number, end: number) =>
    ({ timezone: "Asia/Kolkata", quietHoursStart: start, quietHoursEnd: end }) as any;

  it("suppresses inside a window that wraps midnight", () => {
    // 22:30 IST
    expect(inQuietHours(shop(21, 8), new Date("2026-09-15T17:00:00Z"))).toBe(true);
    // 03:30 IST
    expect(inQuietHours(shop(21, 8), new Date("2026-09-15T22:00:00Z"))).toBe(true);
    // 14:30 IST
    expect(inQuietHours(shop(21, 8), new Date("2026-09-15T09:00:00Z"))).toBe(false);
  });

  it("treats an equal start and end as disabled", () => {
    expect(inQuietHours(shop(0, 0), new Date("2026-09-15T22:00:00Z"))).toBe(false);
  });
});
