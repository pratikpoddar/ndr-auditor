import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { toCsv } from "../lib/export/csv";
import { RTO_LABEL } from "../lib/inference/engine";
import { REASON_LABEL, type ReasonClass } from "../lib/inference/reasons";
import { maskAwb } from "../lib/normalize";
import { formatDateTime } from "../lib/metrics";

/**
 * AWB evidence timeline export (spec 4.7).
 *
 * Source events and app inferences are kept in a `record_type` column so the two can never be
 * confused by whoever reads the file. Buyer details are masked.
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUniqueOrThrow({ where: { domain: session.shop } });

  const shipment = await prisma.shipment.findFirstOrThrow({
    where: { id: params.id, shopId: shop.id },
    include: {
      order: true,
      events: { orderBy: { happenedAt: "asc" } },
      incidents: { include: { outcomes: true, responses: true, alerts: true } },
    },
  });

  const fmt = (d: Date | null) => (d ? formatDateTime(d, shop.timezone, shop.currency) : "");

  const rows: unknown[][] = [
    ["NDR Auditor — evidence timeline"],
    ["Shop", shop.name ?? shop.domain],
    ["Order", shipment.order.orderName],
    ["Destination", `${shipment.order.city ?? ""} ${shipment.order.pincodePrefix ? shipment.order.pincodePrefix + "xxx" : ""}`.trim()],
    ["Carrier (raw)", shipment.carrierRaw ?? ""],
    ["Carrier (normalized)", shipment.carrierNormalized ?? "unrecognized"],
    ["AWB", shipment.awb ?? "missing"],
    ["Payment mode", shipment.order.paymentMode],
    ["Order value", `${shipment.order.currency} ${Number(shipment.order.value).toFixed(2)}`],
    ["Exported at", fmt(new Date())],
    [],
    ["record_type", "timestamp", "status_or_action", "detail", "location", "source"],
  ];

  for (const e of shipment.events) {
    rows.push(["CARRIER_EVENT", fmt(e.happenedAt), e.rawStatus ?? e.status, e.message ?? "", e.city ?? "", "Shopify"]);
  }

  for (const inc of shipment.incidents) {
    const ev = inc.evidence as any;
    rows.push([
      "APP_INFERENCE", fmt(inc.openedAt),
      RTO_LABEL[inc.rtoLevel as keyof typeof RTO_LABEL],
      `${REASON_LABEL[inc.reasonClass as ReasonClass]} · confidence ${Math.round(inc.confidence * 100)}% · rules ${inc.ruleVersion} · ${ev?.rule ?? ""} · ${(ev?.notes ?? []).join(" ")}`,
      "", "NDR Auditor inference",
    ]);
    for (const a of inc.alerts) {
      rows.push(["APP_ALERT", fmt(a.sentAt ?? a.createdAt), a.channel, `${a.status}${a.error ? ` — ${a.error}` : ""}`, "", "NDR Auditor"]);
    }
    for (const r of inc.responses) {
      rows.push(["BUYER_RESPONSE", fmt(r.respondedAt), r.action, "Submitted via recovery link", "", "Buyer"]);
    }
    for (const o of inc.outcomes) {
      rows.push(["OUTCOME", fmt(o.outcomeAt), o.outcome, `${o.note ?? ""} (${o.evidenceType}, by ${o.actor})`, "", "NDR Auditor"]);
    }
  }

  rows.push([]);
  rows.push(["Compiled from Shopify data; not a courier-certified proof."]);

  const date = new Date().toISOString().slice(0, 10);
  const safeOrder = shipment.order.orderName.replace(/[^\w.-]+/g, "_");
  const filename = `ndr-evidence_${safeOrder}_${date}.csv`;

  return new Response(toCsv(rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
