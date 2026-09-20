import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, Link } from "@remix-run/react";
import {
  Page, Card, Text, BlockStack, InlineStack, Badge, Box, Button, Banner, Divider, ButtonGroup,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { RTO_LABEL } from "../lib/inference/engine";
import { REASON_LABEL, type ReasonClass } from "../lib/inference/reasons";
import { formatMoney, formatDateTime } from "../lib/metrics";
import { issueRecoveryToken, recoveryUrl } from "../lib/tokens.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUniqueOrThrow({ where: { domain: session.shop } });

  const incidents = await prisma.nDRIncident.findMany({
    where: { shopId: shop.id, state: { notIn: ["DELIVERED_RECOVERED", "EXPIRED"] } },
    include: {
      shipment: { include: { order: true } },
      outcomes: true, responses: true, alerts: true,
    },
    orderBy: [{ confidence: "desc" }, { openedAt: "desc" }],
    take: 100,
  });

  const failedAlerts = await prisma.alertLog.count({
    where: { incident: { shopId: shop.id }, status: "FAILED" },
  });

  return { incidents, currency: shop.currency, timezone: shop.timezone, failedAlerts };
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUniqueOrThrow({ where: { domain: session.shop } });
  const form = await request.formData();
  const incidentId = String(form.get("incidentId"));
  const intent = String(form.get("intent"));

  const incident = await prisma.nDRIncident.findFirstOrThrow({
    where: { id: incidentId, shopId: shop.id },
    include: { shipment: { include: { order: true } } },
  });

  const actor = session.onlineAccessInfo?.associated_user?.email ?? session.shop;

  if (intent === "link") {
    // Minting a link is also the moment we consider the merchant to have intervened, which is
    // what makes a later delivery attributable as a recovery.
    const issued = issueRecoveryToken();
    await prisma.nDRIncident.update({
      where: { id: incidentId },
      data: {
        recoveryTokenHash: issued.tokenHash,
        tokenExpiresAt: issued.expiresAt,
        contactedAt: incident.contactedAt ?? new Date(),
        state: incident.state === "NDR_OPEN" ? "CONTACTED" : incident.state,
      },
    });
    return { link: recoveryUrl(issued.token), expiresAt: issued.expiresAt.toISOString() };
  }

  // Merchant labels are recorded as outcomes with an actor and timestamp. They never rewrite
  // the inference or the carrier events — both remain visible on the timeline.
  const map: Record<string, { outcome: string; final?: string }> = {
    reattempted: { outcome: "UNRESOLVED", final: "COURIER_REATTEMPTED" },
    wrong: { outcome: "WRONG_ALERT" },
    rto: { outcome: "RTO", final: "MERCHANT_CONFIRMED_RTO" },
    unresolved: { outcome: "UNRESOLVED" },
  };
  const chosen = map[intent];
  if (!chosen) return { error: "unknown action" };

  await prisma.recoveryOutcome.create({
    data: {
      incidentId,
      outcome: chosen.outcome,
      evidenceType: "MERCHANT_LABEL",
      actor,
      finalStatus: chosen.final ?? null,
      realizedValue: 0, // Only a delivered event can realize value.
      note: `Merchant labelled this incident "${intent}".`,
    },
  });

  return { labelled: intent };
}

export default function Incidents() {
  const { incidents, currency, timezone, failedAlerts } = useLoaderData<typeof loader>();

  return (
    <Page title="Recovery queue" subtitle={`${incidents.length} open incident(s), highest confidence first`}>
      <BlockStack gap="400">
        {failedAlerts > 0 && (
          <Banner tone="critical" title={`${failedAlerts} alert(s) failed to send`}>
            <Text as="p">Check the WhatsApp provider configuration in Settings. Incidents are unaffected.</Text>
          </Banner>
        )}
        {incidents.length === 0 && (
          <Card>
            <BlockStack gap="200">
              <Text as="h2" variant="headingMd">No open delivery exceptions</Text>
              <Text as="p" tone="subdued">
                Nothing to recover right now. If you expected failures here, check
                {" "}<Link to="/app/hygiene">tracking hygiene</Link> — Shopify may not be receiving status events at all.
              </Text>
            </BlockStack>
          </Card>
        )}
        {incidents.map((i) => (
          <IncidentCard key={i.id} incident={i} currency={currency} timezone={timezone} />
        ))}
      </BlockStack>
    </Page>
  );
}

function IncidentCard({ incident, currency, timezone }: any) {
  const fetcher = useFetcher<any>();
  const evidence = incident.evidence as any;
  const submit = (intent: string) =>
    fetcher.submit({ incidentId: incident.id, intent }, { method: "post" });
  const fmt = (iso: string) => formatDateTime(iso, timezone, currency);

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center" wrap gap="200">
          <InlineStack gap="200" blockAlign="center">
            <Link to={`/app/shipments/${incident.shipmentId}`}>
              <Text as="span" variant="headingMd">{incident.shipment.order.orderName}</Text>
            </Link>
            <Badge tone={incident.rtoLevel === "CONFIRMED" ? "critical" : "attention"}>
              {RTO_LABEL[incident.rtoLevel as keyof typeof RTO_LABEL]}
            </Badge>
            <Badge>{`${Math.round(incident.confidence * 100)}%`}</Badge>
            <Badge tone="info">{incident.state}</Badge>
          </InlineStack>
          <Text as="span" variant="headingMd">{formatMoney(Number(incident.riskValue), currency)}</Text>
        </InlineStack>

        <Text as="p">
          {incident.shipment.carrierRaw ?? "Unknown carrier"} · AWB …{(incident.shipment.awb ?? "").slice(-4) || "n/a"} ·
          {" "}{REASON_LABEL[incident.reasonClass as ReasonClass]} · opened {fmt(incident.openedAt)}
        </Text>

        <Text as="p" variant="bodySm" tone="subdued">
          Evidence: {evidence?.rule} — {(evidence?.notes ?? [])[0]}
        </Text>

        <Divider />

        <InlineStack gap="200" wrap>
          <Button variant="primary" onClick={() => submit("link")}>Get recovery link</Button>
          <ButtonGroup>
            <Button onClick={() => submit("reattempted")}>Courier reattempted</Button>
            <Button onClick={() => submit("rto")}>RTO confirmed</Button>
            <Button onClick={() => submit("wrong")}>Wrong alert</Button>
            <Button onClick={() => submit("unresolved")}>Unresolved</Button>
          </ButtonGroup>
        </InlineStack>

        {fetcher.data?.link && (
          <Banner tone="success" title="Recovery link created">
            <BlockStack gap="100">
              <Text as="p" breakWord><code>{fetcher.data.link}</code></Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Expires {fmt(fetcher.data.expiresAt)}. Send it to the buyer through your own channel.
                Opening it does not trigger a courier reattempt.
              </Text>
            </BlockStack>
          </Banner>
        )}
        {fetcher.data?.labelled && (
          <Banner tone="info"><Text as="p">Labelled “{fetcher.data.labelled}”. Recorded as evidence with your name and timestamp.</Text></Banner>
        )}
      </BlockStack>
    </Card>
  );
}
