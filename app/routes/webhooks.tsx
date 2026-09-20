import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { enqueue } from "../lib/jobs/queue.server";
import { hash } from "../lib/crypto.server";

/**
 * Single webhook endpoint.
 *
 * Contract, in order (spec section 5 request flow):
 *   1. `authenticate.webhook` verifies the HMAC against the RAW body and rejects otherwise.
 *   2. Persist a receipt keyed on X-Shopify-Webhook-Id — this is the idempotency barrier.
 *   3. Enqueue work and return 200 immediately.
 *
 * No Shopify re-fetch, no inference and no outbound WhatsApp happens in this request. Shopify
 * retries anything slow or non-200, and a retried webhook that already did work is how you
 * end up messaging a merchant twice about one failed delivery.
 */

const RAW_PAYLOAD_RETENTION_DAYS = 7;

export async function action({ request }: ActionFunctionArgs) {
  const { topic, shop: shopDomain, payload, webhookId } = await authenticate.webhook(request);

  const body = JSON.stringify(payload ?? {});
  const checksum = hash(body);

  const shop = await prisma.shop.findUnique({ where: { domain: shopDomain } });

  // Idempotency: a duplicate delivery of the same webhook ID is acknowledged and dropped.
  try {
    await prisma.webhookReceipt.create({
      data: {
        webhookId: webhookId ?? `${topic}:${checksum}`,
        topic,
        shopDomain,
        checksum,
        shopId: shop?.id ?? null,
        rawPayload: body.slice(0, 20_000),
        purgeAfter: new Date(Date.now() + RAW_PAYLOAD_RETENTION_DAYS * 86400_000),
      },
    });
  } catch (err: any) {
    if (err?.code === "P2002") return new Response(null, { status: 200 });
    throw err;
  }

  try {
    await route(topic, shopDomain, shop, payload);
  } catch (err) {
    // A routing failure must not make Shopify retry: the receipt is already stored, so a
    // retry would be deduplicated into a no-op anyway. Log and acknowledge.
    console.error(JSON.stringify({
      level: "error", msg: "webhook routing failed", topic, shopDomain,
      error: err instanceof Error ? err.message : String(err),
    }));
  }

  return new Response(null, { status: 200 });
}

async function route(topic: string, shopDomain: string, shop: { id: string } | null, payload: any) {
  switch (topic) {
    case "FULFILLMENTS_CREATE":
    case "FULFILLMENTS_UPDATE": {
      if (!shop) return;
      const fulfillmentId = String(payload?.id ?? "");
      if (!fulfillmentId) return;
      await enqueue(
        prisma,
        "NORMALIZE_FULFILLMENT",
        { shopId: shop.id, fulfillmentId },
        {
          shopId: shop.id,
          // Keyed on the fulfillment's updated_at so a genuine later update still enqueues,
          // but a duplicate delivery of the same state does not.
          dedupeKey: `fulfillment:${shop.id}:${fulfillmentId}:${payload?.updated_at ?? ""}`,
        },
      );
      return;
    }

    case "ORDERS_CREATE":
    case "ORDERS_UPDATED":
    case "ORDERS_CANCELLED":
    case "REFUNDS_CREATE": {
      if (!shop) return;
      // Order-side changes matter because cancel/refund timing feeds the RTO-MEDIUM rule.
      // Re-deriving the order's shipments is cheap; re-fetching them is what costs API budget.
      const orderId = String(payload?.order_id ?? payload?.id ?? "");
      if (!orderId) return;
      await enqueue(prisma, "RECOMPUTE", { shopId: shop.id, orderId }, {
        shopId: shop.id,
        dedupeKey: `recompute:${shop.id}:${orderId}:${payload?.updated_at ?? Date.now()}`,
        runAfter: new Date(Date.now() + 5000),
      });
      return;
    }

    case "APP_UNINSTALLED": {
      await prisma.session.deleteMany({ where: { shop: shopDomain } });
      if (shop) {
        await prisma.shop.update({ where: { id: shop.id }, data: { uninstalledAt: new Date() } });
      }
      return;
    }

    // --- Mandatory compliance webhooks ---
    case "CUSTOMERS_DATA_REQUEST": {
      // The app stores no customer PII beyond a pincode and city on OrderFact, and encrypted
      // buyer-supplied address corrections. Log the request for the documented manual SLA.
      console.log(JSON.stringify({ level: "info", msg: "compliance: customers/data_request", shopDomain }));
      return;
    }
    case "CUSTOMERS_REDACT": {
      if (!shop) return;
      const orderIds: string[] = (payload?.orders_to_redact ?? []).map(String);
      if (orderIds.length === 0) return;
      // Strip location data and any buyer-submitted payload for the named orders.
      await prisma.orderFact.updateMany({
        where: { shopId: shop.id, shopifyOrderId: { in: orderIds } },
        data: { pincode: null, pincodePrefix: null, city: null },
      });
      await prisma.buyerResponse.updateMany({
        where: { incident: { shop: { id: shop.id }, shipment: { order: { shopifyOrderId: { in: orderIds } } } } },
        data: { payload: undefined, clientHash: null },
      });
      return;
    }
    case "SHOP_REDACT": {
      // Full tenant purge. Cascades handle orders, shipments, events, incidents and jobs.
      if (shop) await prisma.shop.delete({ where: { id: shop.id } });
      await prisma.session.deleteMany({ where: { shop: shopDomain } });
      return;
    }

    default:
      console.log(JSON.stringify({ level: "warn", msg: "unhandled webhook topic", topic, shopDomain }));
  }
}
