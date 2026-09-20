import type { PrismaClient, Shop } from "@prisma/client";
import { unauthenticated } from "../../shopify.server";
import { ORDERS_PAGE_QUERY, FULFILLMENT_QUERY } from "../shopify/queries";
import { emptyCounts, ingestOrder, ingestFulfillment } from "../shopify/ingest";
import { deriveShipment, recomputeRollups } from "../derive.server";
import { enqueue } from "./queue.server";
import { sendMerchantAlert } from "../alerts/whatsapp.server";
import { gidToId } from "../normalize";

const PAGE_SIZE = 50;

async function shopOrThrow(prisma: PrismaClient, shopId: string): Promise<Shop> {
  const shop = await prisma.shop.findUnique({ where: { id: shopId } });
  if (!shop) throw new Error(`shop ${shopId} not found`);
  return shop;
}

/**
 * Backfill one page of orders, newest-first, then enqueue the next page.
 *
 * Newest-first matters for the demo and for the product: live incidents appear in the first
 * few seconds, and the long tail fills in behind them. The cursor is checkpointed on the Shop
 * row after every page, so an interrupted backfill resumes instead of restarting.
 */
export async function handleBackfillPage(prisma: PrismaClient, payload: any): Promise<void> {
  const shop = await shopOrThrow(prisma, payload.shopId);
  const { admin } = await unauthenticated.admin(shop.domain);

  const from = new Date(Date.now() - shop.auditWindowDays * 86400_000);
  const query = `created_at:>=${from.toISOString()}`;

  const response = await admin.graphql(ORDERS_PAGE_QUERY, {
    variables: { first: PAGE_SIZE, after: payload.cursor ?? null, query },
  });
  const body: any = await response.json();

  if (body.errors) {
    throw new Error(`orders page failed: ${JSON.stringify(body.errors).slice(0, 400)}`);
  }

  const page = body.data?.orders;
  const nodes = page?.nodes ?? [];
  const counts = emptyCounts();

  for (const node of nodes) {
    await ingestOrder(prisma, shop, node, counts);
  }

  // Derive incidents for everything this page touched.
  const touched = await prisma.shipment.findMany({
    where: { shopId: shop.id, order: { shopifyOrderId: { in: nodes.map((n: any) => gidToId(n.id)) } } },
    select: { id: true },
  });
  for (const s of touched) {
    await deriveShipment(prisma, shop, s.id);
  }

  const seen = shop.backfillOrdersSeen + counts.orders;
  const hasNext = Boolean(page?.pageInfo?.hasNextPage);

  await prisma.shop.update({
    where: { id: shop.id },
    data: {
      backfillOrdersSeen: seen,
      backfillCursor: page?.pageInfo?.endCursor ?? null,
      backfillState: hasNext ? "RUNNING" : "DONE",
      backfillCoverageFrom: shop.backfillCoverageFrom ?? from,
    },
  });

  if (hasNext) {
    await enqueue(prisma, "BACKFILL_PAGE", { shopId: shop.id, cursor: page.pageInfo.endCursor }, { shopId: shop.id });
  } else {
    await enqueue(prisma, "RECOMPUTE", { shopId: shop.id }, { shopId: shop.id });
  }
}

/**
 * Webhook follow-up: re-fetch the fulfillment from Shopify rather than trusting the webhook
 * payload, which is thin and can arrive out of order. The fetched object is the truth.
 */
export async function handleNormalizeFulfillment(prisma: PrismaClient, payload: any): Promise<void> {
  const shop = await shopOrThrow(prisma, payload.shopId);
  const { admin } = await unauthenticated.admin(shop.domain);

  const gid = `gid://shopify/Fulfillment/${payload.fulfillmentId}`;
  const response = await admin.graphql(FULFILLMENT_QUERY, { variables: { id: gid } });
  const body: any = await response.json();

  if (body.errors) throw new Error(`fulfillment fetch failed: ${JSON.stringify(body.errors).slice(0, 400)}`);

  const f = body.data?.fulfillment;
  if (!f) return; // Deleted or not visible — nothing to do, and not an error worth retrying.

  const counts = emptyCounts();
  // Ingest the parent order first so the shipment always has its order facts (value, refund,
  // cancellation) available to the RTO correlation rules.
  await ingestOrder(prisma, shop, { ...f.order, fulfillments: [] }, counts);

  const order = await prisma.orderFact.findUnique({
    where: { shopId_shopifyOrderId: { shopId: shop.id, shopifyOrderId: gidToId(f.order.id) } },
  });
  if (!order) throw new Error("parent order missing after ingest");

  const shipmentId = await ingestFulfillment(prisma, shop, order.id, f, counts);
  const result = await deriveShipment(prisma, shop, shipmentId);

  if (result.created && result.alertable && result.incidentId) {
    await enqueue(
      prisma,
      "SEND_ALERT",
      { shopId: shop.id, incidentId: result.incidentId },
      // One alert per incident, ever. Duplicate webhooks cannot produce a second message.
      { shopId: shop.id, dedupeKey: `alert:${result.incidentId}` },
    );
  }
}

export async function handleRecompute(prisma: PrismaClient, payload: any): Promise<void> {
  const shop = await shopOrThrow(prisma, payload.shopId);
  const end = new Date();
  const start = new Date(end.getTime() - shop.auditWindowDays * 86400_000);
  await recomputeRollups(prisma, shop, startOfDay(start), startOfDay(addDays(end, 1)));
}

export async function handleSendAlert(prisma: PrismaClient, payload: any): Promise<void> {
  const shop = await shopOrThrow(prisma, payload.shopId);
  await sendMerchantAlert(prisma, shop, payload.incidentId);
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}
function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86400_000);
}

export const HANDLERS: Record<string, (prisma: PrismaClient, payload: any) => Promise<void>> = {
  BACKFILL_PAGE: handleBackfillPage,
  NORMALIZE_FULFILLMENT: handleNormalizeFulfillment,
  RECOMPUTE: handleRecompute,
  SEND_ALERT: handleSendAlert,
};
