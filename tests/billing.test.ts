import { describe, it, expect } from "vitest";
import { overageFor, PLAN_LIMITS, FOUNDING_PLAN, GROWTH_PLAN, billingConfig } from "../app/lib/billing";

describe("plan allowances", () => {
  it("matches the published founding-cohort offer", () => {
    expect(PLAN_LIMITS[FOUNDING_PLAN]).toMatchObject({ shipments: 2000, price: 4999 });
    expect(PLAN_LIMITS[GROWTH_PLAN]).toMatchObject({ shipments: 10000, price: 9999 });
  });

  it("prices in INR with a trial on every plan", () => {
    for (const plan of [FOUNDING_PLAN, GROWTH_PLAN]) {
      const cfg = (billingConfig as any)[plan];
      expect(cfg.lineItems[0].currencyCode).toBe("INR");
      expect(cfg.trialDays).toBeGreaterThan(0);
    }
  });
});

describe("overage", () => {
  it("reports excess without implying the audit stops", () => {
    const o = overageFor(FOUNDING_PLAN, 2500);
    expect(o).toMatchObject({ over: true, limit: 2000, excess: 500 });
  });

  it("is not over at exactly the limit", () => {
    expect(overageFor(FOUNDING_PLAN, 2000).over).toBe(false);
  });

  it("never reports overage for a shop with no plan", () => {
    // An unsubscribed shop in trial must not be told it is over a limit it has not agreed to.
    const o = overageFor(null, 99999);
    expect(o).toMatchObject({ over: false, limit: null, excess: 0 });
  });

  it("ignores an unrecognised plan name rather than guessing a limit", () => {
    expect(overageFor("Enterprise", 99999)).toMatchObject({ over: false, limit: null });
  });
});
