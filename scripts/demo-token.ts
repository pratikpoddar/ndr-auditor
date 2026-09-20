/**
 * Mint a recovery link for the highest-value open incident, for demo rehearsal.
 * Run: npm run demo:token
 */
import { PrismaClient } from "@prisma/client";
import { issueRecoveryToken, recoveryUrl } from "../app/lib/tokens.server";

const prisma = new PrismaClient();
const incident = await prisma.nDRIncident.findFirstOrThrow({
  where: { state: { notIn: ["DELIVERED_RECOVERED", "EXPIRED"] } },
  orderBy: { riskValue: "desc" },
  include: { shipment: { include: { order: true } } },
});

const t = issueRecoveryToken();
await prisma.nDRIncident.update({
  where: { id: incident.id },
  data: { recoveryTokenHash: t.tokenHash, tokenExpiresAt: t.expiresAt, contactedAt: incident.contactedAt ?? new Date() },
});

console.log(`order      ${incident.shipment.order.orderName}`);
console.log(`value      INR ${Number(incident.riskValue)}`);
console.log(`rto level  ${incident.rtoLevel} (${Math.round(incident.confidence * 100)}%)`);
console.log(`token      ${t.token}`);
console.log(`url        ${recoveryUrl(t.token, process.env.SHOPIFY_APP_URL || "http://localhost:3000")}`);
await prisma.$disconnect();
