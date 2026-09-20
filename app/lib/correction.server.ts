import type { PrismaClient, Shop } from "@prisma/client";
import { TRACKING_INFO_UPDATE } from "./shopify/queries";
import { resolveCarrier } from "./carriers";

/**
 * The app's only write to Shopify.
 *
 * Safety properties, all deliberate:
 *   - Never runs without an explicit merchant action (no background auto-fix).
 *   - Re-sends the EXISTING number and url, so a correction cannot drop the AWB.
 *   - Logs before/after for every attempt, so any change is reversible by hand.
 *   - notifyCustomer is always false: renaming a carrier is a data fix, and it must never
 *     fire a shipping-update email to the buyer.
 */
export async function applyTrackingCorrection(
  prisma: PrismaClient,
  shop: Shop,
  admin: { graphql: (q: string, o?: any) => Promise<Response> },
  shipmentIds: string[],
  toCompany: string,
  opts: { dryRun: boolean; actor: string },
): Promise<{ ok: boolean; dryRun: boolean; summary: string; errors: string[]; changed: number }> {
  const errors: string[] = [];
  let changed = 0;

  const shipments = await prisma.shipment.findMany({
    where: { id: { in: shipmentIds }, shopId: shop.id },
  });

  if (shipments.length === 0) {
    return { ok: false, dryRun: opts.dryRun, summary: "No matching shipments for this shop.", errors, changed: 0 };
  }

  if (!resolveCarrier(toCompany)) {
    return {
      ok: false, dryRun: opts.dryRun, changed: 0, errors,
      summary: `Refusing to write "${toCompany}": it is not in the verified carrier alias table.`,
    };
  }

  if (opts.dryRun) {
    const withAwb = shipments.filter((s) => s.awb).length;
    return {
      ok: true, dryRun: true, changed: 0, errors,
      summary: `Would rename the carrier on ${shipments.length} shipment(s) to "${toCompany}". ` +
        `${withAwb} carry an AWB that will be preserved; ${shipments.length - withAwb} have no AWB and will be skipped.`,
    };
  }

  for (const s of shipments) {
    // A fulfillment with no AWB cannot be corrected: sending a company with no number would
    // replace one broken state with another.
    if (!s.awb) {
      errors.push(`${s.fulfillmentId}: skipped, no AWB to preserve.`);
      continue;
    }

    const before = { company: s.carrierRaw, number: s.awb, url: s.trackingUrl };
    const after = { company: toCompany, number: s.awb, url: s.trackingUrl };

    try {
      const res = await admin.graphql(TRACKING_INFO_UPDATE, {
        variables: {
          fulfillmentId: `gid://shopify/Fulfillment/${s.fulfillmentId}`,
          trackingInfoInput: { company: toCompany, number: s.awb, url: s.trackingUrl ?? undefined },
          notifyCustomer: false,
        },
      });
      const body: any = await res.json();
      const userErrors = body?.data?.fulfillmentTrackingInfoUpdate?.userErrors ?? [];

      if (body.errors || userErrors.length > 0) {
        const message = JSON.stringify(userErrors.length ? userErrors : body.errors).slice(0, 300);
        errors.push(`${s.fulfillmentId}: ${message}`);
        await prisma.shopifyWriteLog.create({
          data: {
            shopId: shop.id, mutation: "fulfillmentTrackingInfoUpdate", targetId: s.fulfillmentId,
            beforeValue: before as any, afterValue: after as any, actor: opts.actor,
            succeeded: false, error: message,
          },
        });
        continue;
      }

      await prisma.shipment.update({
        where: { id: s.id },
        data: { carrierRaw: toCompany, carrierNormalized: resolveCarrier(toCompany)?.slug ?? null },
      });
      await prisma.shopifyWriteLog.create({
        data: {
          shopId: shop.id, mutation: "fulfillmentTrackingInfoUpdate", targetId: s.fulfillmentId,
          beforeValue: before as any, afterValue: after as any, actor: opts.actor, succeeded: true,
        },
      });
      changed += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${s.fulfillmentId}: ${message}`);
    }
  }

  return {
    ok: errors.length === 0,
    dryRun: false,
    changed,
    errors,
    summary: `Renamed the carrier on ${changed} of ${shipments.length} shipment(s). AWB and tracking URL preserved on every change.`,
  };
}
