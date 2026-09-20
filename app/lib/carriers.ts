/**
 * India carrier alias table.
 *
 * `shopifyName` is the string we send to fulfillmentTrackingInfoUpdate. Shopify only
 * begins its own tracking/status polling for carriers it recognises, so a raw value of
 * "Delhivery Surface" (unrecognised) is the difference between a watched shipment and a
 * blind one — that is the entire point of the hygiene report.
 *
 * DAY-1 GATE: these strings must be checked against Shopify's current supported-carrier
 * list and against real values observed in the design-partner store. Do not trust this
 * table until that is done. See docs/day-1-validation.md.
 */

export type Carrier = {
  slug: string;
  label: string;
  /** Exact string to write back to Shopify. null = Shopify has no first-class support. */
  shopifyName: string | null;
  aliases: string[];
  /** Regex for AWB shape, used only as a soft warning — never to reject data. */
  awbPattern?: RegExp;
};

export const CARRIERS: Carrier[] = [
  {
    slug: "delhivery",
    label: "Delhivery",
    shopifyName: "Delhivery",
    aliases: ["delhivery", "delhivery surface", "delhivery express", "delhivery air", "delhiveryone", "delhivery one", "dlv"],
    awbPattern: /^\d{11,14}$/,
  },
  {
    slug: "bluedart",
    label: "Blue Dart",
    shopifyName: "Bluedart",
    aliases: ["blue dart", "bluedart", "blue dart express", "bluedart express", "bdart", "dhl bluedart"],
    awbPattern: /^\d{9,12}$/,
  },
  {
    slug: "xpressbees",
    label: "XpressBees",
    shopifyName: "XpressBees",
    aliases: ["xpressbees", "xpress bees", "xbees", "xpressbees surface", "busybees"],
  },
  {
    slug: "ecom-express",
    label: "Ecom Express",
    shopifyName: "Ecom Express",
    aliases: ["ecom express", "ecomexpress", "ecom", "ecom express ltd", "ecomxpress"],
  },
  {
    slug: "dtdc",
    label: "DTDC",
    shopifyName: "DTDC",
    aliases: ["dtdc", "dtdc express", "dtdc courier", "dtdc plus"],
  },
  {
    slug: "ekart",
    label: "Ekart",
    shopifyName: "Ekart Logistics",
    aliases: ["ekart", "ekart logistics", "ekl", "flipkart logistics"],
  },
  {
    slug: "shadowfax",
    label: "Shadowfax",
    shopifyName: "Shadowfax",
    aliases: ["shadowfax", "shadow fax", "sfx"],
  },
  {
    slug: "india-post",
    label: "India Post",
    shopifyName: "India Post",
    aliases: ["india post", "indiapost", "speed post", "speedpost", "dop", "department of posts"],
  },
  {
    slug: "amazon-shipping",
    label: "Amazon Shipping",
    shopifyName: "Amazon Logistics",
    aliases: ["amazon shipping", "amazon logistics", "ats", "amazon transportation"],
  },
  {
    slug: "shiprocket",
    label: "Shiprocket (aggregator)",
    // Shiprocket is an aggregator, not a carrier. Shopify does not track it as a carrier,
    // so a fulfillment labelled "Shiprocket" is effectively untracked — we surface it as a
    // hygiene finding rather than silently mapping it to some underlying courier we cannot see.
    shopifyName: null,
    aliases: ["shiprocket", "ship rocket", "shiprocket x"],
  },
];

const ALIAS_INDEX: Map<string, Carrier> = (() => {
  const m = new Map<string, Carrier>();
  for (const c of CARRIERS) {
    m.set(c.slug, c);
    for (const a of c.aliases) m.set(normalizeAlias(a), c);
  }
  return m;
})();

export function normalizeAlias(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[._\-/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Resolve a raw Shopify tracking company to a known carrier, or null if unrecognised. */
export function resolveCarrier(raw: string | null | undefined): Carrier | null {
  if (!raw) return null;
  const key = normalizeAlias(raw);
  if (!key) return null;
  const direct = ALIAS_INDEX.get(key);
  if (direct) return direct;

  // Contains-match as a fallback: "Delhivery (Surface 10kg)" should still resolve.
  // Longest alias first so "blue dart express" beats a shorter incidental match.
  const candidates = [...ALIAS_INDEX.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [alias, carrier] of candidates) {
    if (alias.length >= 4 && key.includes(alias)) return carrier;
  }
  return null;
}

export function carrierBySlug(slug: string | null | undefined): Carrier | null {
  if (!slug) return null;
  return CARRIERS.find((c) => c.slug === slug) ?? null;
}

export function carrierLabel(slug: string | null | undefined): string {
  return carrierBySlug(slug)?.label ?? "Unknown carrier";
}

/**
 * A correction is proposable only when the raw value resolves to a carrier that Shopify
 * itself supports AND the raw string differs from Shopify's exact spelling.
 */
export function proposeCorrection(raw: string | null | undefined): { from: string; to: string; carrier: Carrier } | null {
  if (!raw) return null;
  const carrier = resolveCarrier(raw);
  if (!carrier || !carrier.shopifyName) return null;
  if (raw.trim() === carrier.shopifyName) return null;
  return { from: raw, to: carrier.shopifyName, carrier };
}

export function isValidTrackingUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}
