import { describe, it, expect } from "vitest";
import { inferShipment, countsTowardHeadlineRto, countsTowardNdr } from "../app/lib/inference/engine";
import { REASON } from "../app/lib/inference/reasons";
import { cfg, ev, order, shipment, NOW } from "./fixtures";

// Fixtures mirror the spec's test plan (section 10). Each asserts label, confidence band,
// and that evidence is actually retained — an inference with no evidence is a bug.

describe("clean delivery", () => {
  it("opens no incident when the parcel was never in exception", () => {
    const s = shipment([ev("IN_TRANSIT", 6), ev("OUT_FOR_DELIVERY", 4), ev("DELIVERED", 4)]);
    expect(inferShipment(s, order(), cfg()).incident).toBeNull();
  });
});

describe("N1 attempted delivery", () => {
  it("opens a high-confidence incident on structured attempted_delivery", () => {
    const s = shipment([
      ev("IN_TRANSIT", 5),
      ev("OUT_FOR_DELIVERY", 3),
      ev("ATTEMPTED_DELIVERY", 3, "Customer not available at premises"),
    ]);
    const r = inferShipment(s, order(), cfg()).incident!;
    expect(r.openRule).toBe("N1");
    expect(r.confidenceBand).toBe("HIGH");
    expect(r.reasonClass).toBe(REASON.CUSTOMER_UNAVAILABLE);
    expect(r.reasonEvidence).toBeTruthy();
    expect(r.evidence.eventIds.length).toBeGreaterThan(0);
  });

  it("marks recovered when a delivery follows the attempt", () => {
    const s = shipment([
      ev("OUT_FOR_DELIVERY", 5),
      ev("ATTEMPTED_DELIVERY", 5, "Customer not available"),
      ev("DELIVERED", 3),
    ]);
    const r = inferShipment(s, order(), cfg()).incident!;
    expect(r.rtoLevel).toBe("NOT_RTO");
    expect(r.state).toBe("DELIVERED_RECOVERED");
  });
});

describe("N2 failure", () => {
  it("opens on failure after movement", () => {
    const s = shipment([ev("IN_TRANSIT", 6), ev("FAILURE", 4, "Delivery exception")]);
    const r = inferShipment(s, order(), cfg()).incident!;
    expect(r.openRule).toBe("N2");
    expect(r.confidenceBand).toBe("HIGH");
  });

  it("does not open on a failure that precedes any movement (booking error, not NDR)", () => {
    const s = shipment([ev("LABEL_PRINTED", 8), ev("FAILURE", 7, "Manifest error")]);
    expect(inferShipment(s, order(), cfg()).incident).toBeNull();
  });
});

describe("N3 free-text", () => {
  it("opens at medium confidence on a failed-attempt phrase", () => {
    const s = shipment([ev("IN_TRANSIT", 5), ev("IN_TRANSIT", 3, "Could not be delivered - door locked")]);
    const r = inferShipment(s, order(), cfg()).incident!;
    expect(r.openRule).toBe("N3");
    expect(r.confidenceBand).toBe("MEDIUM");
    expect(r.reasonClass).toBe(REASON.ADDRESS_ISSUE);
    expect(r.evidence.matched).toBeTruthy();
  });
});

describe("N4 staleness is not an NDR", () => {
  it("flags stuck-only and keeps it out of NDR counts", () => {
    const s = shipment([ev("IN_TRANSIT", 8), ev("OUT_FOR_DELIVERY", 4)]);
    const r = inferShipment(s, order(), cfg()).incident!;
    expect(r.openRule).toBe("N4");
    expect(r.isStuckOnly).toBe(true);
    expect(r.state).toBe("OBSERVED");
    expect(countsTowardNdr(r.openRule, r.isStuckOnly)).toBe(false);
  });
});

describe("RTO inference", () => {
  it("confirms only on an explicit return phrase plus movement", () => {
    const s = shipment([
      ev("OUT_FOR_DELIVERY", 12),
      ev("ATTEMPTED_DELIVERY", 12, "Customer refused the shipment"),
      ev("IN_TRANSIT", 9, "Return to origin initiated"),
      ev("IN_TRANSIT", 7, "In transit to origin hub"),
    ]);
    const r = inferShipment(s, order(), cfg()).incident!;
    expect(r.rtoLevel).toBe("CONFIRMED");
    expect(r.state).toBe("CONFIRMED_RTO");
    expect(r.reasonClass).toBe(REASON.CUSTOMER_REFUSED);
  });

  // Regression: an "RTO delivered" scan carries status=delivered but means the parcel came
  // BACK. Reading it as a success silently under-reports RTO, which is the most damaging
  // direction this product can be wrong in.
  it("treats a return-leg delivery scan as confirmed RTO, not as a delivery", () => {
    const s = shipment([
      ev("OUT_FOR_DELIVERY", 14),
      ev("ATTEMPTED_DELIVERY", 14, "Customer refused to accept the shipment"),
      ev("IN_TRANSIT", 11, "Return to origin initiated"),
      ev("RTO_DELIVERED", 8, "RTO delivered at origin"),
    ]);
    const r = inferShipment(s, order(), cfg()).incident!;
    expect(r.rtoLevel).toBe("CONFIRMED");
    expect(r.state).toBe("CONFIRMED_RTO");
  });

  it("calls a lone return phrase high, not confirmed", () => {
    const s = shipment([
      ev("OUT_FOR_DELIVERY", 10),
      ev("ATTEMPTED_DELIVERY", 10, "Customer unavailable"),
      ev("IN_TRANSIT", 8, "Returned to shipper"),
    ]);
    const r = inferShipment(s, order(), cfg()).incident!;
    expect(r.rtoLevel).toBe("HIGH");
    expect(r.state).toBe("LIKELY_RTO");
  });

  it("correlates a substantial refund after an attempt as medium", () => {
    const s = shipment([
      ev("OUT_FOR_DELIVERY", 20),
      ev("ATTEMPTED_DELIVERY", 20, "Customer not reachable"),
    ]);
    const o = order({ refundAmount: 2400, lastRefundAt: new Date(NOW.getTime() - 12 * 86400_000) });
    const r = inferShipment(s, o, cfg()).incident!;
    expect(r.rtoLevel).toBe("MEDIUM");
    expect(r.confidenceBand).toBe("MEDIUM");
  });

  it("does NOT treat a partial refund as an RTO", () => {
    const s = shipment([
      ev("OUT_FOR_DELIVERY", 20),
      ev("ATTEMPTED_DELIVERY", 20, "Customer not reachable"),
    ]);
    // 30% refund — a goodwill or single-item refund, not a returned parcel.
    const o = order({ refundAmount: 720, lastRefundAt: new Date(NOW.getTime() - 12 * 86400_000) });
    const r = inferShipment(s, o, cfg()).incident!;
    expect(r.rtoLevel).not.toBe("MEDIUM");
  });

  it("never infers RTO from a refund with no shipment exception at all", () => {
    const s = shipment([ev("IN_TRANSIT", 20), ev("DELIVERED", 18)]);
    const o = order({ refundAmount: 2400, lastRefundAt: new Date(NOW.getTime() - 5 * 86400_000) });
    expect(inferShipment(s, o, cfg()).incident).toBeNull();
  });

  it("ignores a refund that predates the failed attempt", () => {
    const s = shipment([
      ev("OUT_FOR_DELIVERY", 9),
      ev("ATTEMPTED_DELIVERY", 9, "Customer not reachable"),
    ]);
    // Refund happened BEFORE the attempt, so it cannot be caused by it.
    const o = order({ refundAmount: 2400, lastRefundAt: new Date(NOW.getTime() - 15 * 86400_000) });
    const r = inferShipment(s, o, cfg()).incident!;
    expect(r.rtoLevel).not.toBe("MEDIUM");
  });

  it("falls back to low confidence on silence, and keeps it out of the headline", () => {
    const s = shipment([
      ev("OUT_FOR_DELIVERY", 30),
      ev("ATTEMPTED_DELIVERY", 30, "Customer not reachable"),
    ]);
    const r = inferShipment(s, order(), cfg()).incident!;
    expect(r.rtoLevel).toBe("LOW");
    expect(r.confidenceBand).toBe("LOW");
    expect(countsTowardHeadlineRto(r.rtoLevel)).toBe(false);
  });

  it("lets a late delivered event reverse an inferred RTO", () => {
    const s = shipment([
      ev("OUT_FOR_DELIVERY", 14),
      ev("ATTEMPTED_DELIVERY", 14, "Customer unavailable"),
      ev("IN_TRANSIT", 12, "Returned to shipper"),
      ev("DELIVERED", 2, "Delivered"),
    ]);
    const r = inferShipment(s, order(), cfg()).incident!;
    expect(r.rtoLevel).toBe("NOT_RTO");
    expect(r.state).toBe("DELIVERED_RECOVERED");
  });
});

describe("evidence integrity", () => {
  it("always records rule version and notes", () => {
    const s = shipment([ev("OUT_FOR_DELIVERY", 5), ev("ATTEMPTED_DELIVERY", 5, "COD amount not ready")]);
    const r = inferShipment(s, order(), cfg()).incident!;
    expect(r.ruleVersion).toMatch(/^\d{4}\.\d{2}\.\d+$/);
    expect(r.evidence.notes.length).toBeGreaterThan(0);
    expect(r.reasonClass).toBe(REASON.PAYMENT_ISSUE);
  });

  it("records UNKNOWN rather than guessing when no phrase matches", () => {
    const s = shipment([ev("OUT_FOR_DELIVERY", 5), ev("ATTEMPTED_DELIVERY", 5, "xyzzy 4491")]);
    const r = inferShipment(s, order(), cfg()).incident!;
    expect(r.reasonClass).toBe(REASON.UNKNOWN);
    expect(r.reasonEvidence).toBeNull();
  });
});

describe("out-of-order events", () => {
  it("produces the same verdict regardless of input ordering", () => {
    const events = [
      ev("OUT_FOR_DELIVERY", 12),
      ev("ATTEMPTED_DELIVERY", 12, "Customer refused"),
      ev("IN_TRANSIT", 9, "Return to origin initiated"),
      ev("IN_TRANSIT", 7, "In transit to origin"),
    ];
    const a = inferShipment(shipment(events), order(), cfg()).incident!;
    const b = inferShipment(shipment([...events].reverse()), order(), cfg()).incident!;
    expect(b.rtoLevel).toBe(a.rtoLevel);
    expect(b.openRule).toBe(a.openRule);
    expect(b.confidence).toBe(a.confidence);
  });
});
