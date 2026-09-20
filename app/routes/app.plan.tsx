import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import {
  Page, Card, Text, BlockStack, InlineStack, Badge, Button, Banner, List, Divider, Box,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { FOUNDING_PLAN, GROWTH_PLAN, PLAN_LIMITS, overageFor } from "../lib/billing";
import { formatMoney } from "../lib/metrics";

export async function loader({ request }: LoaderFunctionArgs) {
  const { billing, session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUniqueOrThrow({ where: { domain: session.shop } });

  // `check` never throws; it reports what is active so the page can show state rather than
  // forcing a redirect the merchant did not ask for.
  const { hasActivePayment, appSubscriptions } = await billing.check({
    plans: [FOUNDING_PLAN, GROWTH_PLAN],
    isTest: process.env.NODE_ENV !== "production",
  });

  const windowStart = new Date(Date.now() - shop.auditWindowDays * 86400_000);
  const shipmentsInWindow = await prisma.shipment.count({
    where: { shopId: shop.id, order: { createdAt: { gte: windowStart } } },
  });

  const activePlan = appSubscriptions[0]?.name ?? null;

  return {
    hasActivePayment,
    activePlan,
    subscriptions: appSubscriptions.map((s) => ({ name: s.name, status: (s as any).status ?? "ACTIVE" })),
    shipmentsInWindow,
    overage: overageFor(activePlan, shipmentsInWindow),
    windowDays: shop.auditWindowDays,
    currency: shop.currency,
    isTest: process.env.NODE_ENV !== "production",
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const { billing } = await authenticate.admin(request);
  const form = await request.formData();
  const plan = String(form.get("plan"));

  if (plan !== FOUNDING_PLAN && plan !== GROWTH_PLAN) {
    return { error: "Unknown plan." };
  }

  // Throws a redirect to Shopify's confirmation screen. The merchant approves the charge there,
  // on Shopify's own UI — this app never sees or handles payment details.
  return billing.request({
    plan,
    isTest: process.env.NODE_ENV !== "production",
    returnUrl: `${process.env.SHOPIFY_APP_URL || process.env.APP_URL}/app/plan`,
  });
}

export default function Plan() {
  const {
    hasActivePayment, activePlan, shipmentsInWindow, overage, windowDays, currency, isTest,
  } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  return (
    <Page title="Plan and billing">
      <BlockStack gap="400">
        {isTest && (
          <Banner tone="warning" title="Test charges">
            <Text as="p">
              Billing is running in test mode, so no money moves. Charges become real when the app
              runs with <code>NODE_ENV=production</code>.
            </Text>
          </Banner>
        )}

        <Card>
          <BlockStack gap="300">
            <InlineStack gap="200" blockAlign="center">
              <Text as="h2" variant="headingMd">Current plan</Text>
              {hasActivePayment
                ? <Badge tone="success">{activePlan ?? "Active"}</Badge>
                : <Badge tone="attention">No active subscription</Badge>}
            </InlineStack>
            <Text as="p" tone="subdued">
              {shipmentsInWindow.toLocaleString()} shipments in the last {windowDays} days
              {overage.limit !== null && ` · plan allowance ${overage.limit.toLocaleString()}`}
            </Text>
            {overage.over && (
              <Banner tone="warning" title="Above your plan allowance">
                <Text as="p">
                  {overage.excess.toLocaleString()} shipments over. Your audit keeps running and
                  nothing is hidden — cutting you off would conceal leakage you are already paying
                  to see. Upgrade when it suits you.
                </Text>
              </Banner>
            )}
          </BlockStack>
        </Card>

        <InlineStack gap="400" wrap>
          {[FOUNDING_PLAN, GROWTH_PLAN].map((plan) => {
            const meta = PLAN_LIMITS[plan];
            const current = activePlan === plan;
            return (
              <Box key={plan} minWidth="300px">
                <Card>
                  <BlockStack gap="300">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="h3" variant="headingMd">{meta.label}</Text>
                      {current && <Badge tone="success">Current</Badge>}
                    </InlineStack>
                    <Text as="p" variant="heading2xl">
                      {formatMoney(meta.price, "INR")}
                      <Text as="span" variant="bodySm" tone="subdued"> /month</Text>
                    </Text>
                    <List type="bullet">
                      <List.Item>Up to {meta.shipments.toLocaleString()} shipments</List.Item>
                      <List.Item>Audit across the window your API access allows</List.Item>
                      <List.Item>Live NDR alerts and recovery links</List.Item>
                      <List.Item>Tracking hygiene and carrier correction</List.Item>
                      {plan === GROWTH_PLAN && <List.Item>Multi-user ops, exports, higher alert volume</List.Item>}
                      {plan === FOUNDING_PLAN && <List.Item>Direct founder support</List.Item>}
                    </List>
                    <Text as="p" variant="bodySm" tone="subdued">14-day free trial</Text>
                    <fetcher.Form method="post">
                      <input type="hidden" name="plan" value={plan} />
                      <Button submit variant={current ? "secondary" : "primary"} disabled={current} fullWidth>
                        {current ? "Current plan" : `Choose ${meta.label}`}
                      </Button>
                    </fetcher.Form>
                  </BlockStack>
                </Card>
              </Box>
            );
          })}
        </InlineStack>

        {fetcher.data && "error" in fetcher.data && (
          <Banner tone="critical"><Text as="p">{fetcher.data.error}</Text></Banner>
        )}

        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">What you are charged for</Text>
            <Text as="p" tone="subdued">
              Prices are set in INR. Shopify converts to your store's billing currency at charge
              time, so you are billed a correct local amount. Payment is handled entirely by
              Shopify — this app never sees your card details.
            </Text>
            <Divider />
            <Text as="p" variant="bodySm" tone="subdued">
              Overage pricing is deliberately undefined until real usage costs are observed.
              You will never be charged for it without being told first.
            </Text>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
