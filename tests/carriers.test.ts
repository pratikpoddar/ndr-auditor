import { describe, it, expect } from "vitest";
import { resolveCarrier, proposeCorrection, isValidTrackingUrl, normalizeAlias } from "../app/lib/carriers";
import { computeHygiene } from "../app/lib/hygiene";

describe("resolveCarrier", () => {
  it("resolves the spellings aggregators actually write", () => {
    expect(resolveCarrier("Delhivery")?.slug).toBe("delhivery");
    expect(resolveCarrier("delhivery surface")?.slug).toBe("delhivery");
    expect(resolveCarrier("Blue Dart Express")?.slug).toBe("bluedart");
    expect(resolveCarrier("Xpress Bees")?.slug).toBe("xpressbees");
    expect(resolveCarrier("ecomexpress")?.slug).toBe("ecom-express");
    expect(resolveCarrier("Ekart Logistics")?.slug).toBe("ekart");
  });

  it("handles punctuation and embedded qualifiers", () => {
    expect(resolveCarrier("Delhivery (Surface 10kg)")?.slug).toBe("delhivery");
    expect(resolveCarrier("blue-dart")?.slug).toBe("bluedart");
  });

  it("returns null rather than guessing on unknown values", () => {
    expect(resolveCarrier("SR-COURIER-7")).toBeNull();
    expect(resolveCarrier("")).toBeNull();
    expect(resolveCarrier(null)).toBeNull();
  });
});

describe("proposeCorrection", () => {
  it("proposes Shopify's exact spelling for a recognised misspelling", () => {
    expect(proposeCorrection("delhivery surface")).toMatchObject({ to: "Delhivery" });
    expect(proposeCorrection("Xpress Bees")).toMatchObject({ to: "XpressBees" });
  });

  it("proposes nothing when the value is already correct", () => {
    expect(proposeCorrection("Delhivery")).toBeNull();
  });

  it("proposes nothing for an aggregator Shopify cannot track", () => {
    // Shiprocket resolves, but has no Shopify carrier to map to — renaming would be a lie.
    expect(proposeCorrection("Shiprocket")).toBeNull();
  });

  it("proposes nothing for an unrecognised value", () => {
    expect(proposeCorrection("SR-COURIER-7")).toBeNull();
  });
});

describe("isValidTrackingUrl", () => {
  it("accepts http(s) and rejects anything else", () => {
    expect(isValidTrackingUrl("https://track.example.com/1")).toBe(true);
    expect(isValidTrackingUrl("not a url")).toBe(false);
    expect(isValidTrackingUrl("javascript:alert(1)")).toBe(false);
    expect(isValidTrackingUrl(null)).toBe(false);
  });
});

describe("computeHygiene", () => {
  const now = new Date("2026-09-15T00:00:00Z");
  const base = {
    fulfillmentId: "f", awb: "12345678901", carrierRaw: "Delhivery",
    trackingUrl: "https://t.test/1", lastEventAt: now, createdAt: now, currentStatus: "IN_TRANSIT",
  };

  it("scores a clean set at 100", () => {
    const r = computeHygiene([{ ...base, fulfillmentId: "a" }, { ...base, fulfillmentId: "b", awb: "2" + base.awb }], now);
    expect(r.score).toBe(100);
  });

  it("counts a missing AWB and drops the score", () => {
    const r = computeHygiene([{ ...base, awb: null }], now);
    expect(r.missingAwb).toBe(1);
    expect(r.score).toBeLessThan(70);
  });

  it("flags an unrecognised carrier but still credits a valid URL", () => {
    const r = computeHygiene([{ ...base, carrierRaw: "SR-COURIER-7" }], now);
    expect(r.unrecognizedCarrier).toBe(1);
    // A usable tracking URL means the merchant is not blind, so the carrier leg still counts.
    expect(r.score).toBe(100);
  });

  it("detects duplicate AWBs across fulfillments", () => {
    const r = computeHygiene([{ ...base, fulfillmentId: "a" }, { ...base, fulfillmentId: "b" }], now);
    expect(r.duplicateAwb).toBe(2);
  });

  it("flags stale non-terminal shipments but not delivered ones", () => {
    const old = new Date(now.getTime() - 20 * 86400_000);
    const stale = computeHygiene([{ ...base, lastEventAt: old }], now);
    expect(stale.staleTracking).toBe(1);
    const done = computeHygiene([{ ...base, lastEventAt: old, currentStatus: "DELIVERED" }], now);
    expect(done.staleTracking).toBe(0);
  });

  it("returns a zero report rather than dividing by zero", () => {
    expect(computeHygiene([], now).score).toBe(0);
  });
});
