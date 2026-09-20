import "@shopify/shopify-app-remix/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-remix/server";
import { billingConfig } from "./lib/billing";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";

/**
 * Pinned API version.
 *
 * Kept in lockstep with `api_version` under [webhooks] in shopify.app.toml — if the two drift,
 * webhook payloads arrive in a different shape from the one the Admin client speaks.
 *
 * DAY-1 GATE: before writing any query against it, confirm against the live schema that
 * FulfillmentTrackingInfo, Fulfillment.events and fulfillmentTrackingInfoUpdate carry the
 * fields app/lib/shopify/queries.ts assumes. Bump deliberately, never implicitly — the
 * queries and the webhook payload shapes are versioned together.
 */
export const API_VERSION = ApiVersion.October26;

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY!,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: API_VERSION,
  scopes: process.env.SCOPES?.split(","),
  // `shopify app dev` injects APP_URL (its proxy/tunnel origin); a deployed host sets
  // SHOPIFY_APP_URL. Accept either so local dev and production use the same code path.
  appUrl: process.env.SHOPIFY_APP_URL || process.env.APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  // Unlisted distribution still requires charges to go through Shopify Billing.
  billing: billingConfig,
  // REST is gone entirely in shopify-app-remix v6; this app was GraphQL-only regardless.
  future: { unstable_newEmbeddedAuthStrategy: true },
  ...(process.env.SHOP_CUSTOM_DOMAIN ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] } : {}),
});

export default shopify;
export const apiVersion = API_VERSION;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
