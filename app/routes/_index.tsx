import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { login } from "../shopify.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }
  return null;
}

export default function Index() {
  return (
    <main style={{ fontFamily: "Inter, system-ui, sans-serif", maxWidth: 640, margin: "80px auto", padding: 24 }}>
      <h1 style={{ fontSize: 28, marginBottom: 8 }}>NDR Auditor</h1>
      <p style={{ color: "#555", lineHeight: 1.6 }}>
        A carrier-neutral RTO audit and recovery layer that reads only Shopify. Install from your
        Shopify admin to see a 90-day shipment audit — no CSV, no courier login.
      </p>
      <form method="post" action="/auth/login" style={{ marginTop: 24 }}>
        <label htmlFor="shop" style={{ display: "block", marginBottom: 6, fontWeight: 600 }}>Shop domain</label>
        <input id="shop" name="shop" placeholder="my-store.myshopify.com"
          style={{ padding: "8px 12px", width: "100%", border: "1px solid #ccc", borderRadius: 6 }} />
        <button type="submit" style={{ marginTop: 12, padding: "8px 16px", borderRadius: 6, border: 0, background: "#111", color: "#fff", cursor: "pointer" }}>
          Install
        </button>
      </form>
    </main>
  );
}
