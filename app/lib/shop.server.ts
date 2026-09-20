import type { PrismaClient, Shop } from "@prisma/client";
import { SHOP_QUERY } from "./shopify/queries";
import { enqueue } from "./jobs/queue.server";
import { API_VERSION } from "../shopify.server";

/**
 * Create or refresh the tenant row on the first authenticated request after install, and
 * start the backfill exactly once. Reinstall is safe: the shop row is matched on domain and
 * the backfill is only enqueued when it has not already run.
 */
export async function ensureShop(
  prisma: PrismaClient,
  domain: string,
  scopes: string | null,
  admin: { graphql: (q: string, o?: any) => Promise<Response> },
): Promise<Shop> {
  const existing = await prisma.shop.findUnique({ where: { domain } });

  let name: string | null = existing?.name ?? null;
  let currency = existing?.currency ?? "INR";
  let timezone = existing?.timezone ?? "Asia/Kolkata";

  try {
    const res = await admin.graphql(SHOP_QUERY);
    const body: any = await res.json();
    const s = body?.data?.shop;
    if (s) {
      name = s.name ?? name;
      currency = s.currencyCode ?? currency;
      timezone = s.ianaTimezone ?? timezone;
    }
  } catch (err) {
    // A shop-metadata failure must not block the app from loading; defaults are sane for India.
    console.error(JSON.stringify({ level: "warn", msg: "shop query failed", domain, error: String(err) }));
  }

  const hasReadAllOrders = Boolean(scopes?.includes("read_all_orders"));

  const shop = await prisma.shop.upsert({
    where: { domain },
    create: {
      domain, name, currency, timezone,
      scopes: scopes ?? null,
      apiVersion: API_VERSION,
      hasReadAllOrders,
      // Without read_all_orders Shopify only exposes 60 days, so we set the window to what we
      // can actually deliver rather than promising 90 and quietly returning less.
      auditWindowDays: hasReadAllOrders ? 90 : 60,
    },
    update: {
      name, currency, timezone,
      scopes: scopes ?? null,
      apiVersion: API_VERSION,
      hasReadAllOrders,
      uninstalledAt: null,
    },
  });

  if (shop.backfillState === "PENDING") {
    await prisma.shop.update({ where: { id: shop.id }, data: { backfillState: "RUNNING" } });
    await enqueue(prisma, "BACKFILL_PAGE", { shopId: shop.id, cursor: null }, {
      shopId: shop.id,
      dedupeKey: `backfill:start:${shop.id}`,
    });
  }

  return shop;
}

/** Honest description of what the audit actually covers, for display on every card. */
export function coverageNote(shop: Shop): string {
  return shop.hasReadAllOrders
    ? `${shop.auditWindowDays}-day audit.`
    : `${shop.auditWindowDays}-day audit until extended order access (read_all_orders) is approved by Shopify.`;
}
