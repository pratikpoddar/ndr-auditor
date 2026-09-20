import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useSearchParams, Link } from "@remix-run/react";
import { Page, Card, DataTable, Badge, Text, BlockStack, Pagination, InlineStack } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { RTO_LABEL } from "../lib/inference/engine";
import { formatMoney, formatCount } from "../lib/metrics";
import { carrierLabel } from "../lib/carriers";

const PAGE = 50;

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUniqueOrThrow({ where: { domain: session.shop } });
  const url = new URL(request.url);

  const page = Math.max(0, Number(url.searchParams.get("page") ?? 0));
  const carrier = url.searchParams.get("carrier");
  const status = url.searchParams.get("status");
  const rto = url.searchParams.get("rto");

  const where: any = { shopId: shop.id };
  if (carrier) where.carrierNormalized = carrier === "unknown" ? null : carrier;
  if (status) where.currentStatus = status;
  if (rto) where.incidents = { some: { rtoLevel: rto } };

  const [shipments, total] = await Promise.all([
    prisma.shipment.findMany({
      where,
      include: { order: true, incidents: true },
      orderBy: { lastEventAt: "desc" },
      skip: page * PAGE,
      take: PAGE,
    }),
    prisma.shipment.count({ where }),
  ]);

  return {
    total, page,
    currency: shop.currency,
    shipments: shipments.map((s) => ({
      id: s.id,
      orderName: s.order.orderName,
      carrier: s.carrierNormalized ? carrierLabel(s.carrierNormalized) : `Unrecognized: ${s.carrierRaw ?? "none"}`,
      awb: s.awb,
      status: s.currentStatus,
      trackable: s.trackable,
      value: Number(s.order.value),
      paymentMode: s.order.paymentMode,
      rtoLevel: s.incidents[0]?.rtoLevel ?? null,
      confidence: s.incidents[0]?.confidence ?? null,
      lastEventAt: s.lastEventAt?.toISOString() ?? null,
    })),
  };
}

export default function Shipments() {
  const { shipments, total, page, currency } = useLoaderData<typeof loader>();
  const [params, setParams] = useSearchParams();

  const go = (p: number) => {
    const next = new URLSearchParams(params);
    next.set("page", String(p));
    setParams(next);
  };

  const rows = shipments.map((s) => [
    <Link key={s.id} to={`/app/shipments/${s.id}`}>{s.orderName}</Link>,
    s.carrier,
    s.awb ? `…${s.awb.slice(-6)}` : <Badge tone="critical" key="noawb">No AWB</Badge>,
    s.status.replace(/_/g, " ").toLowerCase(),
    s.trackable ? <Badge tone="success" key="t">Tracked</Badge> : <Badge tone="warning" key="u">Not tracked</Badge>,
    s.rtoLevel && s.rtoLevel !== "NONE"
      ? <Badge key="r" tone={s.rtoLevel === "CONFIRMED" ? "critical" : s.rtoLevel === "NOT_RTO" ? "success" : "attention"}>
          {`${RTO_LABEL[s.rtoLevel as keyof typeof RTO_LABEL]}${s.confidence ? ` (${Math.round(s.confidence * 100)}%)` : ""}`}
        </Badge>
      : "—",
    s.paymentMode,
    formatMoney(s.value, currency),
  ]);

  return (
    <Page title="Shipments" subtitle={`${formatCount(total, currency)} shipments in the audit window`}>
      <Card>
        <BlockStack gap="300">
          <DataTable
            columnContentTypes={["text", "text", "text", "text", "text", "text", "text", "numeric"]}
            headings={["Order", "Carrier", "AWB", "Status", "Tracking", "RTO inference", "Payment", "Value"]}
            rows={rows}
          />
          <InlineStack align="center">
            <Pagination
              hasPrevious={page > 0} onPrevious={() => go(page - 1)}
              hasNext={(page + 1) * 50 < total} onNext={() => go(page + 1)}
              label={`${page * 50 + 1}–${Math.min((page + 1) * 50, total)} of ${total}`}
            />
          </InlineStack>
        </BlockStack>
      </Card>
    </Page>
  );
}
