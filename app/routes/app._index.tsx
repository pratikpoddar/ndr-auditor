import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useSearchParams, Link } from "@remix-run/react";
import {
  Page, Layout, Card, Text, BlockStack, InlineStack, Badge, DataTable,
  Banner, ProgressBar, Box, Divider, Select, Button,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { loadAudit } from "../lib/dashboard.server";
import type { Filters } from "../lib/dashboard.server";
import { coverageNote } from "../lib/shop.server";
import { formatINR, describeWindow, medianDays, type SegmentRow } from "../lib/metrics";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUniqueOrThrow({ where: { domain: session.shop } });

  const url = new URL(request.url);
  const filters: Filters = {
    carrier: url.searchParams.get("carrier"),
    paymentMode: url.searchParams.get("payment"),
    pincodePrefix: url.searchParams.get("pincode"),
    sku: url.searchParams.get("sku"),
  };

  const audit = await loadAudit(prisma, shop, filters);
  const pendingJobs = await prisma.job.count({ where: { shopId: shop.id, state: { in: ["QUEUED", "RUNNING"] } } });
  const failedJobs = await prisma.job.count({ where: { shopId: shop.id, state: "FAILED" } });

  return {
    audit,
    filters,
    coverage: coverageNote(shop),
    backfill: {
      state: shop.backfillState,
      ordersSeen: shop.backfillOrdersSeen,
      pendingJobs,
      failedJobs,
    },
    timezone: shop.timezone,
  };
}

/** A rate with no denominator is rendered as an em dash, never as 0%. */
function pct(v: number | null): string {
  return v === null ? "—" : `${v}%`;
}

export default function Dashboard() {
  const { audit, filters, coverage, backfill, timezone } = useLoaderData<typeof loader>();
  const [params, setParams] = useSearchParams();
  const h = audit.headline;
  const windowLabel = describeWindow(new Date(h.windowFrom), new Date(h.windowTo), timezone);

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (!value) next.delete(key); else next.set(key, value);
    setParams(next);
  };

  const anyFilter = Object.values(filters).some(Boolean);

  return (
    <Page
      title="Shipment audit"
      subtitle={`${windowLabel} · ${coverage}`}
      secondaryActions={anyFilter ? [{ content: "Clear filters", onAction: () => setParams(new URLSearchParams()) }] : []}
    >
      <Layout>
        {backfill.state !== "DONE" && (
          <Layout.Section>
            <Banner tone="info" title="Audit is still importing">
              <BlockStack gap="200">
                <Text as="p">
                  {backfill.ordersSeen.toLocaleString("en-IN")} orders scanned so far · {backfill.pendingJobs} jobs queued.
                  Newest orders are imported first, so live exceptions are already visible below.
                </Text>
                <ProgressBar progress={Math.min(95, backfill.ordersSeen ? 40 + backfill.ordersSeen / 20 : 5)} size="small" />
              </BlockStack>
            </Banner>
          </Layout.Section>
        )}

        {backfill.failedJobs > 0 && (
          <Layout.Section>
            <Banner tone="warning" title={`${backfill.failedJobs} import job(s) failed`}>
              <Text as="p">Some data could not be fetched. Figures below are computed on what was imported successfully.</Text>
            </Banner>
          </Layout.Section>
        )}

        {h.fulfillments === 0 && backfill.state === "DONE" && (
          <Layout.Section>
            <Banner tone="warning" title="Shopify has orders, but no shipping data is being written back">
              <Text as="p">
                No fulfillments with tracking were found in this window. That usually means your courier
                or aggregator is not writing AWBs back to Shopify. Until it does, no tool reading Shopify —
                including this one — can audit your deliveries.
              </Text>
            </Banner>
          </Layout.Section>
        )}

        <Layout.Section>
          <InlineStack gap="400" wrap>
            <MetricCard
              title="Shipments" value={h.fulfillments.toLocaleString("en-IN")}
              note={`${h.shippedOrders.toLocaleString("en-IN")} orders · ${windowLabel}`} />
            <MetricCard
              title="Tracking coverage" value={pct(h.trackingCoveragePct)}
              note={`${h.trackable} of ${h.fulfillments} shipments trackable`}
              tone={h.trackingCoveragePct !== null && h.trackingCoveragePct < 70 ? "critical" : undefined} />
            <MetricCard
              title="Delivery exceptions" value={h.ndrCount.toLocaleString("en-IN")}
              note={`${pct(h.ndrRatePct)} of ${h.fulfillments} shipments · ${h.stuckCount} stuck, investigating`} />
            <MetricCard
              title="Likely RTO" value={pct(h.rtoRatePct)}
              note={`${h.rtoHeadlineCount} of ${h.fulfillments} · high + medium confidence only`}
              badge="inferred" />
            <MetricCard
              title="Value at risk" value={formatINR(h.valueAtRisk, h.currency)}
              note={`Order value on ${h.rtoHeadlineCount} high/medium-confidence shipments`} />
            <MetricCard
              title="Recovered value" value={formatINR(h.recoveredValue, h.currency)}
              note={`${h.recoveredCount} of ${h.eligibleForRecovery} eligible · ${pct(h.recoveryRatePct)}`} />
          </InlineStack>
        </Layout.Section>

        <Layout.Section>
          <Banner tone="info">
            <Text as="p">
              <b>What is measured vs inferred.</b> Shipment counts, tracking coverage and delivered
              dates are read directly from Shopify. “Likely RTO” is this app's inference — Shopify has
              no native RTO field. {h.rtoLowCount > 0 && `${h.rtoLowCount} further shipment(s) are unresolved with only low-confidence evidence and are excluded from the headline rate.`}
              {" "}Every inferred row shows its evidence.
            </Text>
          </Banner>
        </Layout.Section>

        {(h.unknownCarrier > 0 || h.unknownPaymentMode > 0) && (
          <Layout.Section>
            <Banner tone="warning" title="Unclassified data is included, not dropped">
              <Text as="p">
                {h.unknownCarrier} shipment(s) have an unrecognized carrier and {h.unknownPaymentMode} order(s)
                have an undetermined payment mode. They remain in all denominators.
                {" "}<Link to="/app/hygiene">Review tracking hygiene →</Link>
              </Text>
            </Banner>
          </Layout.Section>
        )}

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">By courier</Text>
                <Select
                  label="Payment mode" labelInline
                  options={[
                    { label: "All", value: "" },
                    { label: "COD", value: "COD" },
                    { label: "Prepaid", value: "PREPAID" },
                    { label: "Unknown", value: "UNKNOWN" },
                  ]}
                  value={filters.paymentMode ?? ""}
                  onChange={(v) => setFilter("payment", v)}
                />
              </InlineStack>
              <SegmentTable rows={audit.byCarrier} currency={h.currency} linkKey="carrier" />
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">By destination pincode</Text>
              <Text as="p" tone="subdued" variant="bodySm">
                Grouped to the first 3 digits. Segments below 20 shipments are marked insufficient sample and are never ranked as worst.
              </Text>
              <SegmentTable rows={audit.byPincode} currency={h.currency} linkKey="pincode" />
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">By SKU</Text>
              <SegmentTable rows={audit.bySku} currency={h.currency} linkKey="sku" />
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">COD vs prepaid</Text>
              <SegmentTable rows={audit.byPaymentMode} currency={h.currency} linkKey="payment" />
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

function MetricCard({ title, value, note, tone, badge }: {
  title: string; value: string; note: string; tone?: "critical"; badge?: string;
}) {
  return (
    <Box minWidth="220px">
      <Card>
        <BlockStack gap="100">
          <InlineStack gap="200" blockAlign="center">
            <Text as="h3" variant="headingSm" tone="subdued">{title}</Text>
            {badge && <Badge tone="attention">{badge}</Badge>}
          </InlineStack>
          <Text as="p" variant="heading2xl" tone={tone}>{value}</Text>
          <Text as="p" variant="bodySm" tone="subdued">{note}</Text>
        </BlockStack>
      </Card>
    </Box>
  );
}

function SegmentTable({ rows, currency, linkKey }: { rows: SegmentRow[]; currency: string; linkKey: string }) {
  if (rows.length === 0) {
    return <Text as="p" tone="subdued">No shipments in this window.</Text>;
  }
  const body = rows.map((r) => {
    const md = medianDays(r);
    return [
      r.insufficientSample ? `${r.label} (insufficient sample)` : r.label,
      r.shipped.toLocaleString("en-IN"),
      r.shipped ? `${((r.trackable / r.shipped) * 100).toFixed(0)}%` : "—",
      r.shipped ? `${((r.ndr / r.shipped) * 100).toFixed(1)}%` : "—",
      r.shipped ? `${(((r.rtoHigh + r.rtoMedium) / r.shipped) * 100).toFixed(1)}%` : "—",
      r.shipped ? `${((r.delivered / r.shipped) * 100).toFixed(0)}%` : "—",
      md === null ? "—" : `${md}d`,
      formatINR(r.valueAtRisk, currency),
    ];
  });

  return (
    <DataTable
      columnContentTypes={["text", "numeric", "numeric", "numeric", "numeric", "numeric", "numeric", "numeric"]}
      headings={["Segment", "Shipments", "Trackable", "NDR", "Likely RTO", "Delivered", "Median", "Value at risk"]}
      rows={body}
    />
  );
}
