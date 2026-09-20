import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, Form, useActionData } from "@remix-run/react";
import {
  Page, Card, Text, BlockStack, TextField, Select, Button, Banner, Divider, InlineStack, Badge, List,
} from "@shopify/polaris";
import { useState } from "react";
import { authenticate, API_VERSION } from "../shopify.server";
import prisma from "../db.server";
import { enqueue } from "../lib/jobs/queue.server";
import { RULE_VERSION } from "../lib/inference/version";
import { coverageNote } from "../lib/shop.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUniqueOrThrow({ where: { domain: session.shop } });
  return {
    shop: {
      domain: shop.domain, currency: shop.currency, timezone: shop.timezone,
      auditWindowDays: shop.auditWindowDays, codGatewayRules: shop.codGatewayRules,
      riskValueBasis: shop.riskValueBasis, staleOfdHours: shop.staleOfdHours,
      staleNoEventDays: shop.staleNoEventDays, scopes: shop.scopes,
      hasReadAllOrders: shop.hasReadAllOrders, backfillState: shop.backfillState,
      whatsappConfig: shop.whatsappConfig as any,
    },
    coverage: coverageNote(shop),
    apiVersion: API_VERSION,
    ruleVersion: RULE_VERSION,
    alertProvider: process.env.ALERT_PROVIDER ?? "console",
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUniqueOrThrow({ where: { domain: session.shop } });
  const form = await request.formData();

  if (form.get("intent") === "rebackfill") {
    await prisma.shop.update({
      where: { id: shop.id },
      data: { backfillState: "RUNNING", backfillCursor: null, backfillOrdersSeen: 0 },
    });
    await enqueue(prisma, "BACKFILL_PAGE", { shopId: shop.id, cursor: null }, {
      shopId: shop.id,
      dedupeKey: `backfill:restart:${shop.id}:${Date.now()}`,
    });
    return { ok: true, message: "Backfill restarted. Newest orders are imported first." };
  }

  const codRules = String(form.get("codGatewayRules") ?? "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

  await prisma.shop.update({
    where: { id: shop.id },
    data: {
      codGatewayRules: codRules,
      riskValueBasis: String(form.get("riskValueBasis") ?? "ORDER_VALUE"),
      staleOfdHours: Math.max(1, Number(form.get("staleOfdHours") ?? 36)),
      staleNoEventDays: Math.max(1, Number(form.get("staleNoEventDays") ?? 10)),
      whatsappConfig: { merchantRecipient: String(form.get("merchantRecipient") ?? "") || null },
    },
  });

  // Threshold changes alter N4 and the RTO-LOW rule, so stored inferences must be replayed.
  await enqueue(prisma, "RECOMPUTE", { shopId: shop.id }, {
    shopId: shop.id,
    dedupeKey: `recompute:settings:${shop.id}:${Date.now()}`,
  });

  return { ok: true, message: "Settings saved. Inferences will be recomputed." };
}

export default function Settings() {
  const { shop, coverage, apiVersion, ruleVersion, alertProvider } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [codRules, setCodRules] = useState(shop.codGatewayRules.join(", "));
  const [basis, setBasis] = useState(shop.riskValueBasis);
  const [ofd, setOfd] = useState(String(shop.staleOfdHours));
  const [noEvent, setNoEvent] = useState(String(shop.staleNoEventDays));
  const [recipient, setRecipient] = useState(shop.whatsappConfig?.merchantRecipient ?? "");

  return (
    <Page title="Settings">
      <BlockStack gap="400">
        {actionData?.ok && <Banner tone="success"><Text as="p">{actionData.message}</Text></Banner>}

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">Data coverage</Text>
            <Text as="p">{coverage}</Text>
            <InlineStack gap="200">
              <Badge tone={shop.hasReadAllOrders ? "success" : "attention"}>
                {shop.hasReadAllOrders ? "read_all_orders granted" : "read_all_orders not granted"}
              </Badge>
              <Badge>{`API ${apiVersion}`}</Badge>
              <Badge>{`Inference rules ${ruleVersion}`}</Badge>
              <Badge tone={shop.backfillState === "DONE" ? "success" : "attention"}>{`Backfill ${shop.backfillState}`}</Badge>
            </InlineStack>
            <Text as="p" variant="bodySm" tone="subdued">Granted scopes: {shop.scopes ?? "unknown"}</Text>
            <Form method="post">
              <input type="hidden" name="intent" value="rebackfill" />
              <Button submit>Re-run backfill</Button>
            </Form>
          </BlockStack>
        </Card>

        <Form method="post">
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">COD detection</Text>
                <Text as="p" tone="subdued">
                  Comma-separated gateway names treated as Cash on Delivery. Orders whose gateway
                  matches none of these and no known prepaid gateway are recorded as
                  <b> unknown</b> rather than guessed as prepaid.
                </Text>
                <TextField label="COD gateway rules" name="codGatewayRules" value={codRules}
                  onChange={setCodRules} autoComplete="off" multiline={2} />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Value at risk</Text>
                <Select
                  label="Basis" name="riskValueBasis" value={basis} onChange={setBasis}
                  options={[
                    { label: "Current order value (recommended for MVP)", value: "ORDER_VALUE" },
                    { label: "COD collectable value", value: "COD_COLLECTABLE" },
                  ]}
                />
                <Banner tone="info">
                  <Text as="p">
                    This app reports order value at risk, not predicted contribution margin. It has no
                    cost inputs, so any margin figure would be invented.
                  </Text>
                </Banner>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Staleness thresholds</Text>
                <Text as="p" tone="subdued">
                  These drive the “stuck / investigate” finding and the low-confidence unresolved
                  label. Neither counts toward your headline NDR or RTO rate.
                </Text>
                <TextField label="Out for delivery with no update (hours)" name="staleOfdHours"
                  type="number" value={ofd} onChange={setOfd} autoComplete="off" />
                <TextField label="No carrier event after a failed attempt (days)" name="staleNoEventDays"
                  type="number" value={noEvent} onChange={setNoEvent} autoComplete="off" />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Merchant alerts</Text>
                <InlineStack gap="200">
                  <Badge tone={alertProvider === "console" ? "attention" : "success"}>{`Provider: ${alertProvider}`}</Badge>
                </InlineStack>
                {alertProvider === "console" && (
                  <Banner tone="info" title="Console provider active">
                    <Text as="p">
                      Alerts are rendered and logged, not sent. This keeps the audit demo working
                      without WhatsApp business verification or template approval. Set
                      <code> ALERT_PROVIDER</code> to <code>twilio</code> or <code>meta</code> to send for real.
                    </Text>
                  </Banner>
                )}
                <TextField label="Merchant WhatsApp recipient" name="merchantRecipient" value={recipient}
                  onChange={setRecipient} autoComplete="off" placeholder="whatsapp:+9198XXXXXXXX"
                  helpText="Alerts never include a full AWB, full phone number, or the buyer's address." />
                <Divider />
                <Text as="h3" variant="headingSm">Buyer messaging</Text>
                <Banner tone="warning">
                  <Text as="p">
                    Direct buyer WhatsApp is disabled. It requires buyer consent, an approved utility
                    template, opt-out handling and the <code>read_customers</code> scope — none of which
                    this app requests today. Recovery links are shared by you, through your own channel.
                  </Text>
                </Banner>
              </BlockStack>
            </Card>

            <Card>
              <Button submit variant="primary">Save settings</Button>
            </Card>
          </BlockStack>
        </Form>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">Data handling</Text>
            <List type="bullet">
              <List.Item>Shopify access tokens are stored encrypted; raw webhook bodies are purged after 7 days.</List.Item>
              <List.Item>Buyer address corrections are encrypted at rest with AES-256-GCM.</List.Item>
              <List.Item>Recovery links are stored only as a SHA-256 hash and expire after 48 hours.</List.Item>
              <List.Item>Uninstalling the app marks the shop for deletion; <code>shop/redact</code> purges all of its data.</List.Item>
            </List>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
