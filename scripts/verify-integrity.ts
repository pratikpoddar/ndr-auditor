/**
 * Metric integrity check — part of the launch checklist.
 *
 * Asserts the invariants the audit's credibility rests on: totals reconcile to unique
 * fulfillment IDs (not event rows), every cut sums back to the total, and the inference
 * engine has not started calling refunds RTOs.
 *
 * Run: npm run verify
 */
import { PrismaClient } from "@prisma/client";
import { loadAudit } from "../app/lib/dashboard.server";

const prisma = new PrismaClient();
const failures: string[] = [];

function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures.push(label);
}

const shop = await prisma.shop.findFirst({ where: { uninstalledAt: null } });
if (!shop) {
  console.error("No shop found. Run `npm run seed` first.");
  process.exit(1);
}

const audit = await loadAudit(prisma, shop);
const h = audit.headline;

console.log(`\nShop: ${shop.domain}   window: ${shop.auditWindowDays}d\n`);
console.log("HEADLINE");
console.log(`  shipments          ${h.fulfillments}  (orders ${h.shippedOrders})`);
console.log(`  tracking coverage  ${h.trackingCoveragePct}%  ${h.trackable}/${h.fulfillments}`);
console.log(`  NDR                ${h.ndrCount} (${h.ndrRatePct}%)   stuck/investigate ${h.stuckCount}`);
console.log(`  headline RTO       ${h.rtoHeadlineCount} (${h.rtoRatePct}%)   low-confidence excluded ${h.rtoLowCount}`);
console.log(`  value at risk      INR ${Math.round(h.valueAtRisk).toLocaleString("en-IN")}`);
console.log(`  recovery           ${h.recoveredCount}/${h.eligibleForRecovery} = ${h.recoveryRatePct ?? "—"}%`);
console.log(`  unknown carrier ${h.unknownCarrier}   unknown payment ${h.unknownPaymentMode}`);

console.log("\nBY CARRIER (worst first)");
for (const r of audit.byCarrier.slice(0, 8)) {
  const rto = ((r.rtoHigh + r.rtoMedium) / Math.max(r.shipped, 1)) * 100;
  console.log(`  ${r.label.padEnd(32).slice(0, 32)} n=${String(r.shipped).padStart(4)}  rto=${rto.toFixed(1).padStart(5)}%${r.insufficientSample ? "  [insufficient sample]" : ""}`);
}

console.log("\nINTEGRITY");

const totalShipments = await prisma.shipment.count({ where: { shopId: shop.id } });
check("headline counts unique fulfillments, not event rows", h.fulfillments === totalShipments, `${h.fulfillments} vs ${totalShipments}`);

const carrierSum = audit.byCarrier.reduce((s, r) => s + r.shipped, 0);
check("carrier cut sums to the total", carrierSum === totalShipments, `${carrierSum}`);

const paySum = audit.byPaymentMode.reduce((s, r) => s + r.shipped, 0);
check("payment-mode cut sums to the total", paySum === totalShipments, `${paySum}`);

const partialMedium = await prisma.nDRIncident.count({
  where: { shopId: shop.id, rtoLevel: "MEDIUM", shipment: { order: { financialStatus: "PARTIALLY_REFUNDED" } } },
});
check("no partial-refund order is labelled RTO", partialMedium === 0, `${partialMedium} found`);

const rtoDeliveredAsDelivered = await prisma.shipment.count({
  where: { shopId: shop.id, deliveredAt: { not: null }, events: { some: { status: "RTO_DELIVERED" } } },
});
check("return-leg scans are not counted as deliveries", rtoDeliveredAsDelivered === 0, `${rtoDeliveredAsDelivered} found`);

const noEvidence = await prisma.nDRIncident.count({
  where: { shopId: shop.id, OR: [{ ruleVersion: "" }, { confidence: 0 }] },
});
check("every incident carries a rule version and confidence", noEvidence === 0, `${noEvidence} without`);

const lowInHeadline = audit.byCarrier.reduce((s, r) => s + r.rtoHigh + r.rtoMedium, 0);
check("headline RTO excludes low-confidence rows", lowInHeadline === h.rtoHeadlineCount, `${lowInHeadline} vs ${h.rtoHeadlineCount}`);

const rankedWorst = audit.byPincode[0];
check("worst-ranked segment is never an insufficient sample", !rankedWorst || !rankedWorst.insufficientSample, rankedWorst?.label ?? "n/a");

console.log(failures.length === 0 ? "\nAll integrity checks passed.\n" : `\n${failures.length} check(s) FAILED.\n`);
await prisma.$disconnect();
process.exit(failures.length === 0 ? 0 : 1);
