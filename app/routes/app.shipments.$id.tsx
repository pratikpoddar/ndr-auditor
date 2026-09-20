import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
  Page, Card, Text, BlockStack, InlineStack, Badge, Divider, Box, Banner, List, Button,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { RTO_LABEL } from "../lib/inference/engine";
import { REASON_LABEL, type ReasonClass } from "../lib/inference/reasons";
import { formatINR } from "../lib/metrics";
import { carrierLabel } from "../lib/carriers";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUniqueOrThrow({ where: { domain: session.shop } });

  // Tenant scoping is on the query itself, not checked afterwards — one shop can never read
  // another's shipment even with a guessed ID.
  const shipment = await prisma.shipment.findFirstOrThrow({
    where: { id: params.id, shopId: shop.id },
    include: {
      order: { include: { items: true } },
      events: { orderBy: { happenedAt: "asc" } },
      incidents: { include: { outcomes: true, responses: true, alerts: true } },
    },
  });

  return { shipment, timezone: shop.timezone, currency: shop.currency };
}

export default function ShipmentTimeline() {
  const { shipment, timezone, currency } = useLoaderData<typeof loader>();
  const incident = shipment.incidents[0];
  const evidence = incident?.evidence as any;

  const fmt = (iso: string) =>
    new Intl.DateTimeFormat("en-IN", {
      dateStyle: "medium", timeStyle: "short", timeZone: timezone,
    }).format(new Date(iso));

  return (
    <Page
      title={`${shipment.order.orderName} — evidence timeline`}
      subtitle={`${shipment.carrierNormalized ? carrierLabel(shipment.carrierNormalized) : shipment.carrierRaw ?? "Unknown carrier"} · AWB ${shipment.awb ?? "missing"}`}
      secondaryActions={[
        { content: "Export CSV", url: `/app/export/${shipment.id}.csv`, external: true },
      ]}
    >
      <BlockStack gap="400">
        {incident && (
          <Card>
            <BlockStack gap="300">
              <InlineStack gap="200" blockAlign="center">
                <Text as="h2" variant="headingMd">Our inference</Text>
                <Badge tone={incident.rtoLevel === "CONFIRMED" ? "critical" : incident.rtoLevel === "NOT_RTO" ? "success" : "attention"}>
                  {RTO_LABEL[incident.rtoLevel as keyof typeof RTO_LABEL]}
                </Badge>
                <Badge>{`${Math.round(incident.confidence * 100)}% confidence (${incident.confidenceBand})`}</Badge>
                <Badge tone="info">{`rules ${incident.ruleVersion}`}</Badge>
              </InlineStack>

              <Text as="p">
                Reason: <b>{REASON_LABEL[incident.reasonClass as ReasonClass]}</b>
                {incident.reasonEvidence && <> — matched phrase “{incident.reasonEvidence}”</>}
              </Text>
              <Text as="p" tone="subdued">Risk value: {formatINR(Number(incident.riskValue), currency)} · opened {fmt(incident.openedAt as unknown as string)}</Text>

              <Divider />
              <Text as="h3" variant="headingSm">How this label was derived</Text>
              <List type="bullet">
                <List.Item>Rule path: <code>{evidence?.rule}</code></List.Item>
                {(evidence?.notes ?? []).map((n: string, i: number) => <List.Item key={i}>{n}</List.Item>)}
              </List>

              <Banner tone="info">
                <Text as="p">
                  Source events below are what Shopify reported. The label above is this app's
                  inference from those events — Shopify has no native RTO field.
                </Text>
              </Banner>
            </BlockStack>
          </Card>
        )}

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">Carrier events (source)</Text>
            {shipment.events.length === 0 && (
              <Banner tone="warning" title="No tracking events">
                <Text as="p">
                  Shopify has this fulfillment but received no status events for it. This is a
                  tracking-hygiene problem, not necessarily a delivery problem.
                </Text>
              </Banner>
            )}
            <BlockStack gap="200">
              {shipment.events.map((e) => {
                const isTrigger = evidence?.eventIds?.includes(e.id);
                return (
                  <Box key={e.id} padding="300" borderWidth="025" borderRadius="200"
                    borderColor={isTrigger ? "border-emphasis" : "border"}
                    background={isTrigger ? "bg-surface-caution" : undefined}>
                    <InlineStack gap="300" align="space-between" wrap>
                      <BlockStack gap="050">
                        <InlineStack gap="200">
                          <Text as="span" fontWeight="semibold">{e.status.replace(/_/g, " ").toLowerCase()}</Text>
                          {e.rawStatus && e.rawStatus.toLowerCase() !== e.status.toLowerCase() && (
                            <Text as="span" tone="subdued" variant="bodySm">(raw: {e.rawStatus})</Text>
                          )}
                          {isTrigger && <Badge tone="attention">evidence</Badge>}
                        </InlineStack>
                        {e.message && <Text as="span" variant="bodySm">{e.message}</Text>}
                        {e.city && <Text as="span" variant="bodySm" tone="subdued">{e.city}</Text>}
                      </BlockStack>
                      <Text as="span" variant="bodySm" tone="subdued">{fmt(e.happenedAt as unknown as string)}</Text>
                    </InlineStack>
                  </Box>
                );
              })}
            </BlockStack>
          </BlockStack>
        </Card>

        {incident && (incident.responses.length > 0 || incident.outcomes.length > 0 || incident.alerts.length > 0) && (
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">App actions and labels</Text>
              <Text as="p" tone="subdued" variant="bodySm">
                Kept separate from carrier events above. Buyer and merchant labels are evidence; they never overwrite what the courier reported.
              </Text>
              {incident.alerts.map((a) => (
                <Text key={a.id} as="p" variant="bodySm">
                  Alert via {a.channel}: <b>{a.status}</b>{a.error ? ` — ${a.error}` : ""}
                </Text>
              ))}
              {incident.responses.map((r) => (
                <Text key={r.id} as="p" variant="bodySm">
                  Buyer selected <b>{r.action}</b> at {fmt(r.respondedAt as unknown as string)}
                </Text>
              ))}
              {incident.outcomes.map((o) => (
                <Text key={o.id} as="p" variant="bodySm">
                  Outcome <b>{o.outcome}</b> ({o.evidenceType}, by {o.actor}) — {o.note}
                </Text>
              ))}
            </BlockStack>
          </Card>
        )}

        <Card>
          <Text as="p" variant="bodySm" tone="subdued">
            Compiled from Shopify data; not a courier-certified proof.
          </Text>
        </Card>
      </BlockStack>
    </Page>
  );
}
