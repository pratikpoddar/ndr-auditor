import type { PrismaClient, Shop } from "@prisma/client";
import { resolveCarrier } from "../carriers";
import { deterministicEventId } from "../ids.server";
import {
  derivePaymentMode,
  gidToId,
  isTrackable,
  normalizePincode,
  classifyEventStatus,
  normalizeStatus,
  pincodePrefix,
  STATUS,
} from "../normalize";

/**
 * Shopify GraphQL node -> canonical facts.
 *
 * Ingestion is deliberately dumb: it normalizes and upserts, and does no inference. That
 * separation is what makes it safe to replay a backfill or a webhook any number of times,
 * and what lets inference be re-run under a new rule version without re-fetching Shopify.
 */

type Money = { shopMoney?: { amount?: string | null; currencyCode?: string | null } | null } | null;

function money(m: Money): number {
  const raw = m?.shopMoney?.amount;
  const n = raw == null ? 0 : Number(raw);
  return Number.isFinite(n) ? n : 0;
}

export type OrderNode = any;
export type FulfillmentNode = any;

export type IngestCounts = {
  orders: number;
  fulfillments: number;
  events: number;
  trackable: number;
};

export function emptyCounts(): IngestCounts {
  return { orders: 0, fulfillments: 0, events: 0, trackable: 0 };
}

/**
 * Allocate order value across line items by line price share, falling back to an equal split
 * when prices are unusable. MVP treats "value at risk" as current total order value, so this
 * allocation exists only for the SKU/product cut — it is not a margin estimate.
 */
export function allocateLineValues(
  lineItems: Array<{ quantity: number; unitPrice: number }>,
  orderValue: number,
): number[] {
  const totals = lineItems.map((li) => li.unitPrice * li.quantity);
  const sum = totals.reduce((a, b) => a + b, 0);
  if (sum <= 0 || orderValue <= 0) {
    const even = lineItems.length ? orderValue / lineItems.length : 0;
    return lineItems.map(() => Number(even.toFixed(2)));
  }
  return totals.map((t) => Number(((t / sum) * orderValue).toFixed(2)));
}

/** Upsert one order and all of its fulfillments/events. Idempotent by Shopify IDs. */
export async function ingestOrder(
  prisma: PrismaClient,
  shop: Shop,
  node: OrderNode,
  counts: IngestCounts,
  ingestionSource: "SHOPIFY" | "SEED" = "SHOPIFY",
): Promise<void> {
  const shopifyOrderId = gidToId(node.id);
  const value = money(node.currentTotalPriceSet);
  const refundAmount = money(node.totalRefundedSet);
  const gatewayNames: string[] = node.paymentGatewayNames ?? [];

  const refundDates: Date[] = (node.refunds ?? [])
    .map((r: any) => (r?.createdAt ? new Date(r.createdAt) : null))
    .filter(Boolean) as Date[];
  const lastRefundAt = refundDates.length
    ? new Date(Math.max(...refundDates.map((d) => d.getTime())))
    : null;

  const zip = node.shippingAddress?.zip ?? null;

  const orderData = {
    shopId: shop.id,
    shopifyOrderId,
    orderName: node.name ?? shopifyOrderId,
    createdAt: new Date(node.createdAt),
    updatedAt: new Date(node.updatedAt ?? node.createdAt),
    value,
    currency: node.currentTotalPriceSet?.shopMoney?.currencyCode ?? shop.currency,
    paymentMode: derivePaymentMode(gatewayNames, shop.codGatewayRules),
    gatewayNames,
    pincode: normalizePincode(zip),
    pincodePrefix: pincodePrefix(zip),
    city: node.shippingAddress?.city ?? null,
    provinceCode: node.shippingAddress?.provinceCode ?? null,
    countryCode: node.shippingAddress?.countryCodeV2 ?? null,
    cancelledAt: node.cancelledAt ? new Date(node.cancelledAt) : null,
    cancelReason: node.cancelReason ?? null,
    financialStatus: node.displayFinancialStatus ?? null,
    refundAmount,
    lastRefundAt,
    tags: node.tags ?? [],
  };

  const order = await prisma.orderFact.upsert({
    where: { shopId_shopifyOrderId: { shopId: shop.id, shopifyOrderId } },
    create: orderData,
    update: orderData,
  });
  counts.orders += 1;

  // --- line items ---
  const lineNodes = node.lineItems?.nodes ?? [];
  const parsed = lineNodes.map((li: any) => ({
    lineItemId: gidToId(li.id),
    sku: li.sku ?? null,
    title: li.name ?? null,
    productId: li.product?.id ? gidToId(li.product.id) : null,
    variantId: li.variant?.id ? gidToId(li.variant.id) : null,
    quantity: li.quantity ?? 0,
    unitPrice: Number(li.originalUnitPriceSet?.shopMoney?.amount ?? 0) || 0,
  }));
  const allocated = allocateLineValues(parsed, value);

  for (let i = 0; i < parsed.length; i++) {
    const li = parsed[i];
    const data = {
      orderId: order.id,
      lineItemId: li.lineItemId,
      sku: li.sku,
      title: li.title,
      productId: li.productId,
      variantId: li.variantId,
      quantity: li.quantity,
      attributableValue: allocated[i] ?? 0,
    };
    await prisma.orderItemFact.upsert({
      where: { orderId_lineItemId: { orderId: order.id, lineItemId: li.lineItemId } },
      create: data,
      update: data,
    });
  }

  // --- fulfillments ---
  const fulfillments = node.fulfillments ?? [];
  for (const f of fulfillments) {
    await ingestFulfillment(prisma, shop, order.id, f, counts, ingestionSource);
  }
}

/** Upsert one fulfillment plus its events. Safe to call repeatedly for the same fulfillment. */
export async function ingestFulfillment(
  prisma: PrismaClient,
  shop: Shop,
  orderId: string,
  node: FulfillmentNode,
  counts: IngestCounts,
  ingestionSource: "SHOPIFY" | "SEED" = "SHOPIFY",
): Promise<string> {
  const fulfillmentId = gidToId(node.id);
  const tracking = (node.trackingInfo ?? [])[0] ?? {};
  const carrierRaw: string | null = tracking.company ?? null;
  const carrier = resolveCarrier(carrierRaw);

  const eventNodes = node.events?.nodes ?? [];
  const events = eventNodes.map((e: any) => {
    // Message-aware: a return-leg delivery scan must not be recorded as a delivery.
    const status = classifyEventStatus(e.status, e.message);
    const happenedAt = new Date(e.happenedAt);
    return {
      sourceEventId: e.id ? gidToId(e.id) : deterministicEventId({
        fulfillmentId,
        status: e.status ?? "",
        happenedAt,
        message: e.message,
        city: e.city,
      }),
      status,
      rawStatus: e.status ?? null,
      happenedAt,
      city: e.city ?? null,
      province: e.province ?? null,
      message: e.message ?? null,
      ingestionSource,
    };
  });

  const sorted = [...events].sort((a, b) => a.happenedAt.getTime() - b.happenedAt.getTime());
  const deliveredEvent = sorted.find((e) => e.status === STATUS.DELIVERED);
  const lastEvent = sorted[sorted.length - 1];

  // Prefer the fulfillment's own display status; fall back to the newest event when Shopify
  // reports nothing useful at the fulfillment level.
  const headline = normalizeStatus(node.displayStatus ?? node.status);
  const currentStatus =
    deliveredEvent ? STATUS.DELIVERED
    : headline !== STATUS.UNKNOWN && headline !== STATUS.IN_TRANSIT ? headline
    : lastEvent?.status ?? headline;

  const shipmentData = {
    shopId: shop.id,
    orderId,
    fulfillmentId,
    carrierRaw,
    carrierNormalized: carrier?.slug ?? null,
    awb: tracking.number ?? null,
    trackingUrl: tracking.url ?? null,
    currentStatus,
    rawStatus: node.displayStatus ?? node.status ?? null,
    firstShippedAt: node.createdAt ? new Date(node.createdAt) : null,
    lastEventAt: lastEvent?.happenedAt ?? null,
    deliveredAt: deliveredEvent?.happenedAt ?? null,
    trackable: isTrackable({
      awb: tracking.number,
      carrierRaw,
      trackingUrl: tracking.url,
      eventCount: events.length,
    }),
    sourceUpdatedAt: node.updatedAt ? new Date(node.updatedAt) : null,
  };

  const shipment = await prisma.shipment.upsert({
    where: { shopId_fulfillmentId: { shopId: shop.id, fulfillmentId } },
    create: shipmentData,
    update: shipmentData,
  });

  counts.fulfillments += 1;
  if (shipmentData.trackable) counts.trackable += 1;

  for (const e of events) {
    await prisma.shipmentEvent.upsert({
      where: { shipmentId_sourceEventId: { shipmentId: shipment.id, sourceEventId: e.sourceEventId } },
      create: { ...e, shipmentId: shipment.id },
      // Events are immutable facts; re-ingesting must not rewrite history.
      update: {},
    });
  }
  counts.events += events.length;

  return shipment.id;
}
