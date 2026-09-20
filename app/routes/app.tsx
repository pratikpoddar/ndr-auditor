import type { HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { Link, Outlet, useLoaderData, useRouteError } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { NavMenu } from "@shopify/app-bridge-react";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop } from "../lib/shop.server";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

export async function loader({ request }: LoaderFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  // First authenticated request after install creates the tenant row and kicks off backfill.
  await ensureShop(prisma, session.shop, session.scope ?? null, admin);
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
}

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();
  return (
    <AppProvider isEmbeddedApp apiKey={apiKey}>
      <NavMenu>
        <Link to="/app" rel="home">Audit</Link>
        <Link to="/app/incidents">Recovery queue</Link>
        <Link to="/app/hygiene">Tracking hygiene</Link>
        <Link to="/app/shipments">Shipments</Link>
        <Link to="/app/plan">Plan</Link>
        <Link to="/app/settings">Settings</Link>
      </NavMenu>
      <Outlet />
    </AppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (args) => boundary.headers(args);
