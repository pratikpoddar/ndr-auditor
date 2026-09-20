import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import {
  Page, Card, Text, BlockStack, InlineStack, Badge, DataTable, Banner, Box, Button, Divider,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { computeHygiene, HYGIENE_FORMULA } from "../lib/hygiene";
import { formatDateTime } from "../lib/metrics";
import { proposeCorrection, carrierLabel } from "../lib/carriers";
import { applyTrackingCorrection } from "../lib/correction.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUniqueOrThrow({ where: { domain: session.shop } });

  const shipments = await prisma.shipment.findMany({
    where: { shopId: shop.id },
    include: { order: { select: { orderName: true } } },
    orderBy: { createdAt: "desc" },
  });

  const report = computeHygiene(
    shipments.map((s) => ({
      fulfillmentId: s.fulfillmentId, awb: s.awb, carrierRaw: s.carrierRaw,
      trackingUrl: s.trackingUrl, lastEventAt: s.lastEventAt, createdAt: s.createdAt,
      currentStatus: s.currentStatus,
    })),
    new Date(),
  );

  // Group correctable shipments by the raw string, so the merchant confirms one naming fix
  // rather than approving hundreds of identical rows.
  const groups = new Map<string, { from: string; to: string; carrier: string; ids: string[]; sample: string }>();
  for (const s of shipments) {
    const proposal = proposeCorrection(s.carrierRaw);
    if (!proposal) continue;
    const key = proposal.from;
    if (!groups.has(key)) {
      groups.set(key, { from: proposal.from, to: proposal.to, carrier: carrierLabel(proposal.carrier.slug), ids: [], sample: s.order.orderName });
    }
    groups.get(key)!.ids.push(s.id);
  }

  const unrecognized = shipments
    .filter((s) => s.carrierRaw && !proposeCorrection(s.carrierRaw) && !s.carrierNormalized)
    .reduce((acc, s) => {
      const k = s.carrierRaw!;
      acc.set(k, (acc.get(k) ?? 0) + 1);
      return acc;
    }, new Map<string, number>());

  const writeLogs = await prisma.shopifyWriteLog.findMany({
    where: { shopId: shop.id }, orderBy: { createdAt: "desc" }, take: 20,
  });

  return {
    report,
    proposals: [...groups.values()],
    unrecognized: [...unrecognized.entries()].map(([name, count]) => ({ name, count })),
    writeLogs,
    timezone: shop.timezone,
    currency: shop.currency,
    // fulfillmentTrackingInfoUpdate needs a fulfillment-ORDER write scope; write_fulfillments
    // is not sufficient and Shopify rejects the mutation outright. Gate on what actually works.
    canWrite: Boolean(
      shop.scopes?.includes("write_merchant_managed_fulfillment_orders") ||
      shop.scopes?.includes("write_third_party_fulfillment_orders") ||
      shop.scopes?.includes("write_assigned_fulfillment_orders"),
    ),
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const shop = await prisma.shop.findUniqueOrThrow({ where: { domain: session.shop } });
  const form = await request.formData();

  const shipmentIds = String(form.get("shipmentIds") ?? "").split(",").filter(Boolean);
  const to = String(form.get("to") ?? "");
  const dryRun = form.get("dryRun") === "true";

  const result = await applyTrackingCorrection(prisma, shop, admin, shipmentIds, to, {
    dryRun,
    actor: session.onlineAccessInfo?.associated_user?.email ?? session.shop,
  });
  return result;
}

export default function Hygiene() {
  const { report, proposals, unrecognized, writeLogs, canWrite, timezone, currency } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  const scoreTone = report.score >= 85 ? "success" : report.score >= 60 ? "attention" : "critical";

  return (
    <Page title="Tracking hygiene" subtitle="Whether Shopify can actually watch your shipments">
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="300">
            <InlineStack gap="300" blockAlign="center">
              <Text as="h2" variant="heading2xl">{report.score}</Text>
              <Badge tone={scoreTone}>{`${report.totalFulfillments} shipments scored`}</Badge>
            </InlineStack>
            <Text as="p" tone="subdued" variant="bodySm">Formula: {HYGIENE_FORMULA}</Text>
            <Divider />
            <DataTable
              columnContentTypes={["text", "numeric", "text"]}
              headings={["Finding", "Shipments", "Why it matters"]}
              rows={[
                ["Missing AWB", report.missingAwb, "Shopify has a fulfillment but no tracking number — the parcel is invisible."],
                ["Missing carrier name", report.missingCarrier, "No company set, so Shopify cannot attach a tracking source."],
                ["Unrecognized carrier name", report.unrecognizedCarrier, "Shopify does not recognize the spelling and will not poll for status."],
                ["Duplicate AWB", report.duplicateAwb, "The same tracking number on multiple fulfillments; counts and status will be wrong."],
                ["Invalid tracking URL", report.invalidUrl, "The stored URL is not usable."],
                ["Stale tracking", report.staleTracking, "Non-terminal shipments with no event for over 5 days."],
              ]}
            />
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">Proposed carrier-name corrections</Text>
            <Text as="p" tone="subdued">
              Nothing is written to Shopify by default. Each correction re-sends the existing AWB and
              tracking URL unchanged, and the original value is logged so it can be restored.
            </Text>

            {!canWrite && (
              <Banner tone="warning" title="Write access not granted">
                <Text as="p">
                  The app does not have a fulfillment-order write scope, so Shopify will reject the tracking update. Corrections below are preview-only.
                </Text>
              </Banner>
            )}

            {proposals.length === 0 && <Text as="p">No correctable carrier names found.</Text>}

            {proposals.map((p) => (
              <Box key={p.from} padding="300" borderWidth="025" borderRadius="200" borderColor="border">
                <InlineStack align="space-between" blockAlign="center" wrap gap="300">
                  <BlockStack gap="100">
                    <Text as="p">
                      <code>{p.from}</code> → <code>{p.to}</code> ({p.carrier})
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      {p.ids.length} shipment(s), e.g. {p.sample}
                    </Text>
                  </BlockStack>
                  <InlineStack gap="200">
                    <Button
                      onClick={() => fetcher.submit(
                        { shipmentIds: p.ids.join(","), to: p.to, dryRun: "true" },
                        { method: "post" },
                      )}
                    >
                      Dry run
                    </Button>
                    <Button
                      variant="primary"
                      disabled={!canWrite}
                      onClick={() => fetcher.submit(
                        { shipmentIds: p.ids.join(","), to: p.to, dryRun: "false" },
                        { method: "post" },
                      )}
                    >
                      {`Apply to ${p.ids.length}`}
                    </Button>
                  </InlineStack>
                </InlineStack>
              </Box>
            ))}

            {fetcher.data && (
              <Banner tone={fetcher.data.ok ? "success" : "critical"} title={fetcher.data.dryRun ? "Dry run result" : "Correction result"}>
                <BlockStack gap="100">
                  <Text as="p">{fetcher.data.summary}</Text>
                  {fetcher.data.errors.map((e: string, i: number) => <Text key={i} as="p" variant="bodySm">{e}</Text>)}
                </BlockStack>
              </Banner>
            )}
          </BlockStack>
        </Card>

        {unrecognized.length > 0 && (
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Unrecognized carrier names with no safe mapping</Text>
              <Text as="p" tone="subdued">
                These do not match any carrier in our India alias table. We will not guess a mapping —
                a wrong carrier name is worse than a missing one.
              </Text>
              <DataTable
                columnContentTypes={["text", "numeric"]}
                headings={["Raw value in Shopify", "Shipments"]}
                rows={unrecognized.map((u) => [u.name, u.count])}
              />
            </BlockStack>
          </Card>
        )}

        {writeLogs.length > 0 && (
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Write audit log</Text>
              <DataTable
                columnContentTypes={["text", "text", "text", "text", "text"]}
                headings={["When", "Target", "Before", "After", "Result"]}
                rows={writeLogs.map((l) => [
                  formatDateTime(l.createdAt as unknown as string, timezone, currency),
                  l.targetId,
                  JSON.stringify(l.beforeValue),
                  JSON.stringify(l.afterValue),
                  l.succeeded ? "ok" : `failed: ${l.error ?? ""}`,
                ])}
              />
            </BlockStack>
          </Card>
        )}
      </BlockStack>
    </Page>
  );
}
