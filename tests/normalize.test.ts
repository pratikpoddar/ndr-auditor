import { describe, it, expect } from "vitest";
import { classifyEventStatus, normalizeStatus, STATUS, derivePaymentMode, isTrackable, pincodePrefix } from "../app/lib/normalize";
import { deterministicEventId } from "../app/lib/ids.server";

describe("classifyEventStatus", () => {
  it("splits a return-leg delivery scan away from a real delivery", () => {
    expect(classifyEventStatus("delivered", "Delivered to consignee")).toBe(STATUS.DELIVERED);
    expect(classifyEventStatus("delivered", "RTO delivered at origin")).toBe(STATUS.RTO_DELIVERED);
    expect(classifyEventStatus("delivered", "Returned to shipper")).toBe(STATUS.RTO_DELIVERED);
  });

  it("never promotes a non-delivered status to delivered on the strength of a message", () => {
    // A message must not be able to manufacture a delivery the carrier did not report.
    expect(classifyEventStatus("in_transit", "Delivered to consignee")).toBe(STATUS.IN_TRANSIT);
    expect(classifyEventStatus("attempted_delivery", "delivered")).toBe(STATUS.ATTEMPTED_DELIVERY);
  });

  it("maps unknown statuses to UNKNOWN rather than guessing", () => {
    expect(normalizeStatus("some_new_status")).toBe(STATUS.UNKNOWN);
    expect(normalizeStatus(null)).toBe(STATUS.UNKNOWN);
  });
});

describe("derivePaymentMode", () => {
  const rules = ["cash on delivery (cod)", "cod", "manual"];
  it("detects COD from configured gateway rules", () => {
    expect(derivePaymentMode(["Cash on Delivery (COD)"], rules)).toBe("COD");
    expect(derivePaymentMode(["COD"], rules)).toBe("COD");
  });
  it("detects prepaid only from a known gateway", () => {
    expect(derivePaymentMode(["razorpay"], rules)).toBe("PREPAID");
  });
  it("returns UNKNOWN rather than guessing prepaid", () => {
    expect(derivePaymentMode(["some_custom_gateway"], rules)).toBe("UNKNOWN");
    expect(derivePaymentMode([], rules)).toBe("UNKNOWN");
  });
});

describe("isTrackable", () => {
  const base = { awb: "12345678901", carrierRaw: "Delhivery", trackingUrl: "https://x.test/1", eventCount: 3 };
  it("requires AWB, a resolvable carrier or URL, and at least one event", () => {
    expect(isTrackable(base)).toBe(true);
    expect(isTrackable({ ...base, awb: null })).toBe(false);
    expect(isTrackable({ ...base, eventCount: 0 })).toBe(false);
    expect(isTrackable({ ...base, carrierRaw: "SR-COURIER-7", trackingUrl: null })).toBe(false);
  });
  it("accepts an unrecognized carrier when a valid tracking URL exists", () => {
    expect(isTrackable({ ...base, carrierRaw: "SR-COURIER-7" })).toBe(true);
  });
});

describe("deterministicEventId", () => {
  it("is stable for identical content and distinct for different content", () => {
    const a = { fulfillmentId: "f1", status: "delivered", happenedAt: new Date("2026-01-01T00:00:00Z"), message: "x" };
    expect(deterministicEventId(a)).toBe(deterministicEventId({ ...a }));
    expect(deterministicEventId(a)).not.toBe(deterministicEventId({ ...a, message: "y" }));
  });
});

describe("pincodePrefix", () => {
  it("groups to three digits and rejects unusable input", () => {
    expect(pincodePrefix("560103")).toBe("560");
    expect(pincodePrefix("56")).toBeNull();
    expect(pincodePrefix(null)).toBeNull();
  });
});
