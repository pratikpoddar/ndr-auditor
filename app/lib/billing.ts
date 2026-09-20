import { BillingInterval } from "@shopify/shopify-app-remix/server";
import type { BillingConfig } from "@shopify/shopify-api";

/**
 * Shopify Billing plans.
 *
 * Unlisted and public distribution both require charges to run through Shopify Billing —
 * invoicing a merchant directly is only permitted under custom distribution.
 *
 * Amounts are in INR because the founding cohort is Indian D2C and the offer is priced in
 * rupees. Shopify converts to the merchant's billing currency at charge time, so a merchant on
 * a USD store still sees a correct local amount rather than a rupee figure they cannot parse.
 *
 * TRIAL: 14 days. The product's whole promise is "see your leakage in three minutes", so a
 * merchant should reach the audit and judge it before paying. It also covers the backfill
 * window for a store at the top of the 10,000-shipment range.
 */

export const FOUNDING_PLAN = "Founding 10";
export const GROWTH_PLAN = "Growth";

export const PLAN_LIMITS: Record<string, { shipments: number; label: string; price: number }> = {
  [FOUNDING_PLAN]: { shipments: 2_000, label: "Founding 10", price: 4999 },
  [GROWTH_PLAN]: { shipments: 10_000, label: "Growth", price: 9999 },
};

export const billingConfig = {
  [FOUNDING_PLAN]: {
    lineItems: [
      {
        amount: 4999,
        currencyCode: "INR",
        interval: BillingInterval.Every30Days,
      },
    ],
    trialDays: 14,
  },
  [GROWTH_PLAN]: {
    lineItems: [
      {
        amount: 9999,
        currencyCode: "INR",
        interval: BillingInterval.Every30Days,
      },
    ],
    trialDays: 14,
  },
} satisfies BillingConfig;

export type PlanName = typeof FOUNDING_PLAN | typeof GROWTH_PLAN;

/**
 * Whether a shop is over its plan's shipment allowance for the current audit window.
 *
 * Deliberately does NOT block the audit. Cutting a merchant off mid-window would hide leakage
 * they are already paying to see; the app surfaces the overage and lets them upgrade instead.
 * Overage pricing is intentionally undefined until real provider and hosting costs are observed.
 */
export function overageFor(plan: string | null, shipmentsInWindow: number): {
  over: boolean;
  limit: number | null;
  excess: number;
} {
  const limit = plan ? PLAN_LIMITS[plan]?.shipments ?? null : null;
  if (limit === null) return { over: false, limit: null, excess: 0 };
  return {
    over: shipmentsInWindow > limit,
    limit,
    excess: Math.max(0, shipmentsInWindow - limit),
  };
}
