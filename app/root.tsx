import {
  Links, Meta, Outlet, Scripts, ScrollRestoration, isRouteErrorResponse, useRouteError,
} from "@remix-run/react";

export default function App() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link rel="stylesheet" href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css" />
        <Meta />
        <Links />
      </head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

/**
 * Root error boundary.
 *
 * Remix sanitises errors in production, but this app handles Shopify access tokens and buyer
 * data, and during development the default screen rendered a failed `session.upsert` payload
 * verbatim — access token included. So the boundary never renders the error object at all:
 * it logs server-side and shows the viewer nothing but a status. Shopify app review also
 * rejects apps that surface raw error screens.
 */
export function ErrorBoundary() {
  const error = useRouteError();
  const status = isRouteErrorResponse(error) ? error.status : 500;

  if (typeof console !== "undefined") {
    console.error(JSON.stringify({
      level: "error",
      msg: "unhandled route error",
      status,
      // Message only — never the error payload, which can carry tokens or buyer data.
      error: error instanceof Error ? error.message : String(error),
    }));
  }

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>Something went wrong</title>
        <Meta />
        <Links />
      </head>
      <body style={{ fontFamily: "system-ui, sans-serif", padding: 32, maxWidth: 560, margin: "0 auto" }}>
        <h1 style={{ fontSize: 20 }}>
          {status === 404 ? "Page not found" : "Something went wrong"}
        </h1>
        <p style={{ color: "#555", lineHeight: 1.6 }}>
          {status === 404
            ? "That page does not exist."
            : "We hit an unexpected error and it has been logged. Your shipment data is unaffected — nothing is written to Shopify without your confirmation."}
        </p>
        <Scripts />
      </body>
    </html>
  );
}
