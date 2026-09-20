/**
 * Replay inference over every stored shipment under the current RULE_VERSION.
 *
 * Because ingestion and derivation are separate, improving a rule costs zero Shopify API
 * calls: bump RULE_VERSION, run this, and every incident is re-derived from stored facts.
 *
 * Run: npm run reinfer
 */
import { PrismaClient } from "@prisma/client";
import { reinferShop, recomputeRollups } from "../app/lib/derive.server";
import { RULE_VERSION } from "../app/lib/inference/version";

const prisma = new PrismaClient();
const shops = await prisma.shop.findMany({ where: { uninstalledAt: null } });

console.log(`Replaying inference at rule version ${RULE_VERSION} across ${shops.length} shop(s).`);

for (const shop of shops) {
  const before = await prisma.nDRIncident.groupBy({ by: ["rtoLevel"], _count: true, where: { shopId: shop.id } });
  const count = await reinferShop(prisma, shop);

  const end = new Date();
  const start = new Date(end.getTime() - shop.auditWindowDays * 86400_000);
  await recomputeRollups(prisma, shop, start, end);

  const after = await prisma.nDRIncident.groupBy({ by: ["rtoLevel"], _count: true, where: { shopId: shop.id } });
  const fmt = (g: typeof before) => g.map((x) => `${x.rtoLevel}=${x._count}`).sort().join(" ");

  console.log(`\n${shop.domain}: ${count} shipments re-derived`);
  console.log(`  before  ${fmt(before)}`);
  console.log(`  after   ${fmt(after)}`);
}

await prisma.$disconnect();
