/**
 * Seeded demo store — the backup for the live demo (spec section 8).
 *
 * Generates a realistic Indian D2C shipment mix: genuine NDRs, confirmed and inferred RTOs,
 * refunds that are NOT RTOs, tracking-hygiene defects, and clean deliveries. Data is
 * deliberately imperfect: carrier names are misspelled the way aggregators actually write
 * them, some fulfillments have no AWB, and some have AWBs but no events.
 *
 * Run: npm run seed
 */
import { PrismaClient } from "@prisma/client";
import { deriveShipment, recomputeRollups } from "../app/lib/derive.server";
import { classifyEventStatus, derivePaymentMode, isTrackable, normalizePincode, pincodePrefix, STATUS } from "../app/lib/normalize";
import { deterministicEventId } from "../app/lib/ids.server";
import { resolveCarrier } from "../app/lib/carriers";

const prisma = new PrismaClient();

const DOMAIN = process.env.SEED_SHOP_DOMAIN ?? "ndr-demo-store.myshopify.com";
const ORDER_COUNT = Number(process.env.SEED_ORDERS ?? 500);

// Deterministic PRNG so the demo looks identical every rehearsal.
let seed = 42;
function rnd(): number {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
}
const pick = <T,>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)];
const between = (a: number, b: number) => a + rnd() * (b - a);

// Carrier names as aggregators actually write them — several are deliberately unrecognizable
// to Shopify, which is what the hygiene score exists to catch.
const CARRIER_RAW = [
  "Delhivery", "Delhivery Surface", "delhivery", "Bluedart", "Blue Dart Express",
  "XpressBees", "Xpress Bees", "Ecom Express", "ecomexpress", "DTDC", "Ekart Logistics",
  "Shadowfax", "India Post", "Shiprocket", "SR-COURIER-7", "",
];

const PINCODES = ["110001","110092","400001","400709","560001","560103","600001","700001","302001","226001","800001","781001","462001","141001","530001"];
const CITIES = ["New Delhi","Mumbai","Bengaluru","Chennai","Kolkata","Jaipur","Lucknow","Patna","Guwahati","Bhopal","Ludhiana","Visakhapatnam"];
const SKUS = [
  { sku: "KUR-BLU-M", title: "Cotton Kurta Blue M", price: 1299 },
  { sku: "KUR-BLK-L", title: "Cotton Kurta Black L", price: 1299 },
  { sku: "SER-VITC-30", title: "Vitamin C Serum 30ml", price: 899 },
  { sku: "CRM-NGT-50", title: "Night Cream 50g", price: 1499 },
  { sku: "SHO-RUN-9", title: "Running Shoes UK9", price: 3499 },
  { sku: "BAG-TOT-01", title: "Canvas Tote", price: 799 },
  { sku: "WAL-LTH-BR", title: "Leather Wallet Brown", price: 1899 },
];

const UNAVAILABLE = ["Customer not available at premises", "Consignee not reachable, phone switched off", "Customer out of station, requested future delivery", "Premises closed on arrival"];
const ADDRESS = ["Incomplete address, landmark needed", "Unable to locate the address", "Door locked, no response", "Pincode mismatch with delivery area"];
const REFUSED = ["Customer refused to accept the shipment", "Rejected by consignee", "Order cancelled by customer at the door"];
const PAYMENT = ["COD amount not ready with customer", "Payment not arranged, customer asked to deliver later"];
const CAPACITY = ["Operational delay at hub", "Route disruption due to heavy rain", "Vehicle breakdown, delivery rescheduled"];

type Scenario =
  | "CLEAN" | "ATTEMPT_THEN_DELIVERED" | "CONFIRMED_RTO" | "HIGH_RTO" | "REFUND_CORRELATED"
  | "REFUND_NO_EXCEPTION" | "STALE_OFD" | "NO_AWB" | "AWB_NO_EVENTS" | "DUPLICATE_AWB"
  | "PARTIAL_REFUND" | "LOW_UNRESOLVED";

// Weighted to look like a real store: mostly fine, with a believable leakage tail.
const MIX: Array<[Scenario, number]> = [
  ["CLEAN", 0.52], ["ATTEMPT_THEN_DELIVERED", 0.09], ["CONFIRMED_RTO", 0.06],
  ["HIGH_RTO", 0.05], ["REFUND_CORRELATED", 0.04], ["REFUND_NO_EXCEPTION", 0.03],
  ["STALE_OFD", 0.04], ["NO_AWB", 0.05], ["AWB_NO_EVENTS", 0.05], ["DUPLICATE_AWB", 0.02],
  ["PARTIAL_REFUND", 0.03], ["LOW_UNRESOLVED", 0.02],
];

function chooseScenario(): Scenario {
  const r = rnd();
  let acc = 0;
  for (const [s, w] of MIX) {
    acc += w;
    if (r <= acc) return s;
  }
  return "CLEAN";
}

const DAY = 86400_000;

async function main() {
  console.log(`Seeding ${ORDER_COUNT} orders into ${DOMAIN} ...`);

  await prisma.shop.deleteMany({ where: { domain: DOMAIN } });
  const shop = await prisma.shop.create({
    data: {
      domain: DOMAIN, name: "NDR Demo Store", currency: "INR", timezone: "Asia/Kolkata",
      auditWindowDays: 90, backfillState: "DONE", backfillOrdersSeen: ORDER_COUNT,
      backfillCoverageFrom: new Date(Date.now() - 90 * DAY), hasReadAllOrders: true,
      scopes: "read_orders,read_fulfillments,write_fulfillments",
    },
  });

  const now = Date.now();
  const shipmentIds: string[] = [];
  let duplicateAwbPool: string | null = null;

  for (let i = 0; i < ORDER_COUNT; i++) {
    const scenario = chooseScenario();
    const orderedDaysAgo = between(2, 88);
    const createdAt = new Date(now - orderedDaysAgo * DAY);

    const lineCount = rnd() < 0.75 ? 1 : 2;
    const items = Array.from({ length: lineCount }, () => pick(SKUS));
    const value = items.reduce((a, it) => a + it.price, 0);
    const isCod = rnd() < 0.62; // India D2C skews COD.
    const gateway = isCod ? "Cash on Delivery (COD)" : pick(["razorpay", "shopify_payments", "payu"]);

    const pincode = pick(PINCODES);
    const cityIdx = PINCODES.indexOf(pincode) % CITIES.length;

    let refundAmount = 0;
    let lastRefundAt: Date | null = null;
    let cancelledAt: Date | null = null;

    if (scenario === "REFUND_CORRELATED") {
      refundAmount = value;
      lastRefundAt = new Date(createdAt.getTime() + between(9, 14) * DAY);
    } else if (scenario === "REFUND_NO_EXCEPTION") {
      refundAmount = value;
      lastRefundAt = new Date(createdAt.getTime() + between(10, 20) * DAY);
    } else if (scenario === "PARTIAL_REFUND") {
      refundAmount = Math.round(value * 0.3);
      lastRefundAt = new Date(createdAt.getTime() + between(8, 15) * DAY);
    }

    const order = await prisma.orderFact.create({
      data: {
        shopId: shop.id,
        shopifyOrderId: String(5000000 + i),
        orderName: `#${1001 + i}`,
        createdAt,
        updatedAt: createdAt,
        value,
        currency: "INR",
        paymentMode: derivePaymentMode([gateway], shop.codGatewayRules),
        gatewayNames: [gateway],
        pincode: normalizePincode(pincode),
        pincodePrefix: pincodePrefix(pincode),
        city: CITIES[cityIdx],
        provinceCode: "MH",
        countryCode: "IN",
        cancelledAt,
        financialStatus: refundAmount >= value ? "REFUNDED" : refundAmount > 0 ? "PARTIALLY_REFUNDED" : "PAID",
        refundAmount,
        lastRefundAt,
        tags: [],
      },
    });

    for (let li = 0; li < items.length; li++) {
      await prisma.orderItemFact.create({
        data: {
          orderId: order.id, lineItemId: `${order.shopifyOrderId}-${li}`,
          sku: items[li].sku, title: items[li].title, quantity: 1,
          attributableValue: Number((value / items.length).toFixed(2)),
          productId: `p-${items[li].sku}`, variantId: `v-${items[li].sku}`,
        },
      });
    }

    const shipDaysAgo = orderedDaysAgo - between(0.5, 1.5);
    const shippedAt = new Date(now - shipDaysAgo * DAY);
    const carrierRaw = scenario === "NO_AWB" ? pick(CARRIER_RAW) : pick(CARRIER_RAW.filter(Boolean));

    let awb: string | null = `${Math.floor(between(10_000_000_000, 99_999_999_999))}`;
    if (scenario === "NO_AWB") awb = null;
    if (scenario === "DUPLICATE_AWB") {
      if (duplicateAwbPool) awb = duplicateAwbPool;
      else duplicateAwbPool = awb;
    }

    const events = buildEvents(scenario, shippedAt, now);
    const delivered = events.find((e) => e.status === STATUS.DELIVERED);
    const last = events[events.length - 1];

    const shipment = await prisma.shipment.create({
      data: {
        shopId: shop.id, orderId: order.id, fulfillmentId: String(9000000 + i),
        carrierRaw: carrierRaw || null,
        carrierNormalized: resolveCarrier(carrierRaw)?.slug ?? null,
        awb,
        trackingUrl: awb ? `https://track.example.com/${awb}` : null,
        currentStatus: delivered ? STATUS.DELIVERED : (last?.status ?? STATUS.PENDING),
        rawStatus: last?.rawStatus ?? null,
        firstShippedAt: shippedAt,
        lastEventAt: last?.happenedAt ?? null,
        deliveredAt: delivered?.happenedAt ?? null,
        trackable: isTrackable({ awb, carrierRaw, trackingUrl: awb ? `https://track.example.com/${awb}` : null, eventCount: events.length }),
        sourceUpdatedAt: last?.happenedAt ?? shippedAt,
      },
    });

    for (const e of events) {
      await prisma.shipmentEvent.create({
        data: {
          shipmentId: shipment.id,
          sourceEventId: deterministicEventId({ fulfillmentId: shipment.fulfillmentId, status: e.status, happenedAt: e.happenedAt, message: e.message, city: CITIES[cityIdx] }),
          status: e.status, rawStatus: e.rawStatus, happenedAt: e.happenedAt,
          city: CITIES[cityIdx], message: e.message, ingestionSource: "SEED",
        },
      });
    }

    shipmentIds.push(shipment.id);
    if ((i + 1) % 100 === 0) console.log(`  ${i + 1}/${ORDER_COUNT} orders`);
  }

  console.log("Running inference over seeded shipments ...");
  for (const id of shipmentIds) {
    await deriveShipment(prisma, shop, id);
  }

  console.log("Computing rollups ...");
  const end = new Date();
  const start = new Date(end.getTime() - 90 * DAY);
  await recomputeRollups(prisma, shop, start, end);

  const incidents = await prisma.nDRIncident.groupBy({ by: ["rtoLevel"], _count: true, where: { shopId: shop.id } });
  console.log("\nSeed complete.");
  console.log(`  Shop: ${DOMAIN}`);
  console.log(`  Orders: ${ORDER_COUNT}`);
  console.log("  Incidents by RTO level:", incidents.map((i) => `${i.rtoLevel}=${i._count}`).join(" "));
}

type SeedEvent = { status: string; rawStatus: string; happenedAt: Date; message: string | null };

function buildEvents(scenario: Scenario, shippedAt: Date, now: number): SeedEvent[] {
  const t = (daysAfterShip: number) => new Date(shippedAt.getTime() + daysAfterShip * DAY);
  // Routed through the same classifier the real ingest path uses, so seeded data cannot
  // drift from ingested data (this is what hid the RTO-delivered bug the first time).
  const e = (status: string, rawStatus: string, d: number, message: string | null = null): SeedEvent =>
    ({ status: classifyEventStatus(rawStatus, message), rawStatus, happenedAt: t(d), message });

  const transit = [
    e(STATUS.LABEL_PRINTED, "label_printed", 0),
    e(STATUS.IN_TRANSIT, "in_transit", 0.6, "Shipment picked up"),
    e(STATUS.IN_TRANSIT, "in_transit", 1.4, "In transit at sorting hub"),
  ];

  switch (scenario) {
    case "CLEAN":
      return [...transit, e(STATUS.OUT_FOR_DELIVERY, "out_for_delivery", 2.2), e(STATUS.DELIVERED, "delivered", 2.5, "Delivered to consignee")];

    case "ATTEMPT_THEN_DELIVERED":
      return [...transit,
        e(STATUS.OUT_FOR_DELIVERY, "out_for_delivery", 2.2),
        e(STATUS.ATTEMPTED_DELIVERY, "attempted_delivery", 2.4, pick(UNAVAILABLE)),
        e(STATUS.OUT_FOR_DELIVERY, "out_for_delivery", 3.2),
        e(STATUS.DELIVERED, "delivered", 3.4, "Delivered on second attempt")];

    case "CONFIRMED_RTO":
      return [...transit,
        e(STATUS.OUT_FOR_DELIVERY, "out_for_delivery", 2.2),
        e(STATUS.ATTEMPTED_DELIVERY, "attempted_delivery", 2.4, pick([...REFUSED, ...PAYMENT])),
        e(STATUS.ATTEMPTED_DELIVERY, "attempted_delivery", 3.5, pick(REFUSED)),
        e(STATUS.IN_TRANSIT, "in_transit", 5, "Return to origin initiated"),
        e(STATUS.IN_TRANSIT, "in_transit", 7, "RTO in transit to origin hub"),
        e(STATUS.DELIVERED, "delivered", 9, "RTO delivered at origin")];

    case "HIGH_RTO":
      return [...transit,
        e(STATUS.OUT_FOR_DELIVERY, "out_for_delivery", 2.2),
        e(STATUS.ATTEMPTED_DELIVERY, "attempted_delivery", 2.4, pick(ADDRESS)),
        e(STATUS.IN_TRANSIT, "in_transit", 5.5, "Returned to shipper")];

    case "REFUND_CORRELATED":
      return [...transit,
        e(STATUS.OUT_FOR_DELIVERY, "out_for_delivery", 2.2),
        e(STATUS.ATTEMPTED_DELIVERY, "attempted_delivery", 2.4, pick(UNAVAILABLE))];

    case "PARTIAL_REFUND":
      return [...transit,
        e(STATUS.OUT_FOR_DELIVERY, "out_for_delivery", 2.2),
        e(STATUS.ATTEMPTED_DELIVERY, "attempted_delivery", 2.4, pick(UNAVAILABLE))];

    case "LOW_UNRESOLVED":
      return [...transit,
        e(STATUS.OUT_FOR_DELIVERY, "out_for_delivery", 2.2),
        e(STATUS.FAILURE, "failure", 2.4, pick(CAPACITY))];

    case "REFUND_NO_EXCEPTION":
      // Refunded, but the parcel was delivered cleanly — a customer return, NOT an RTO.
      return [...transit, e(STATUS.OUT_FOR_DELIVERY, "out_for_delivery", 2.2), e(STATUS.DELIVERED, "delivered", 2.5, "Delivered")];

    case "STALE_OFD":
      // Out for delivery and then silence — "stuck / investigate", never counted as an NDR.
      return [...transit, e(STATUS.OUT_FOR_DELIVERY, "out_for_delivery", Math.max(0.1, (now - shippedAt.getTime()) / DAY - 3))];

    case "AWB_NO_EVENTS":
      // The single most common real-world failure: an AWB Shopify never gets updates for.
      return [];

    case "NO_AWB":
      return [];

    case "DUPLICATE_AWB":
      return [...transit, e(STATUS.OUT_FOR_DELIVERY, "out_for_delivery", 2.2), e(STATUS.DELIVERED, "delivered", 2.6, "Delivered")];

    default:
      return transit;
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
