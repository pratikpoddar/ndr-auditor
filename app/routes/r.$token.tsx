import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { data } from "@remix-run/node";
import { useLoaderData, useFetcher, Form } from "@remix-run/react";
import prisma from "../db.server";
import { tokenHashOf, isExpired } from "../lib/tokens.server";
import { clientFingerprint, encrypt } from "../lib/crypto.server";

export const meta: MetaFunction = () => [
  { title: "Delivery update" },
  { name: "viewport", content: "width=device-width,initial-scale=1" },
  // A recovery link must never be indexed or leak its referrer.
  { name: "robots", content: "noindex,nofollow" },
  { name: "referrer", content: "no-referrer" },
];

/**
 * Buyer recovery page.
 *
 * No Shopify login, no session, no sequential IDs. Lookup is by SHA-256 of the presented
 * token, so the stored value cannot be replayed even if the database leaks, and there is no
 * ID space to enumerate. Everything shown is deliberately minimal: an order name, the issue,
 * and the choices — never the full address, phone number or AWB.
 */
export async function loader({ params }: LoaderFunctionArgs) {
  const token = params.token ?? "";
  const incident = await prisma.nDRIncident.findUnique({
    where: { recoveryTokenHash: tokenHashOf(token) },
    include: {
      shipment: { include: { order: true } },
      shop: { select: { name: true, domain: true } },
      responses: true,
    },
  });

  if (!incident || isExpired(incident.tokenExpiresAt)) {
    // Identical response for "no such token" and "expired token" — distinguishing them would
    // turn the page into an oracle for probing tokens.
    throw data({ reason: "This link is no longer valid." }, { status: 404 });
  }

  return {
    merchant: incident.shop.name ?? incident.shop.domain,
    orderName: incident.shipment.order.orderName,
    city: incident.shipment.order.city,
    alreadyResponded: incident.responses.length > 0,
    lastAction: incident.responses[incident.responses.length - 1]?.action ?? null,
  };
}

export async function action({ request, params }: ActionFunctionArgs) {
  const token = params.token ?? "";
  const incident = await prisma.nDRIncident.findUnique({
    where: { recoveryTokenHash: tokenHashOf(token) },
    include: { responses: true },
  });
  if (!incident || isExpired(incident.tokenExpiresAt)) {
    throw data({ reason: "This link is no longer valid." }, { status: 404 });
  }

  const form = await request.formData();
  const action = String(form.get("action") ?? "");
  const VALID = ["REATTEMPT", "ADDRESS_CORRECTION", "ALREADY_RECEIVED", "REFUSED", "NEED_HELP"];
  if (!VALID.includes(action)) return { ok: false, error: "Please choose one of the options." };

  // Idempotent: a double-tap or a refresh must not create a second response.
  const duplicate = incident.responses.find((r) => r.action === action);
  if (duplicate) return { ok: true, action };

  let payload: any = null;
  if (action === "ADDRESS_CORRECTION") {
    // Only the fields a courier actually needs, and encrypted at rest.
    const corrected = {
      line1: String(form.get("line1") ?? "").slice(0, 200),
      landmark: String(form.get("landmark") ?? "").slice(0, 200),
      pincode: String(form.get("pincode") ?? "").replace(/\D/g, "").slice(0, 6),
    };
    if (!corrected.line1 && !corrected.landmark && !corrected.pincode) {
      return { ok: false, error: "Add at least one address detail so the courier can find you." };
    }
    payload = { enc: encrypt(JSON.stringify(corrected)) };
  }

  await prisma.buyerResponse.create({
    data: {
      incidentId: incident.id,
      action,
      payload,
      clientHash: clientFingerprint(
        request.headers.get("x-forwarded-for"),
        request.headers.get("user-agent"),
      ),
    },
  });

  // The buyer's choice updates intent only. It never overwrites the courier's reported
  // reason — both are kept, and the timeline shows which is which.
  await prisma.nDRIncident.update({
    where: { id: incident.id },
    data: { buyerIntent: action },
  });

  return { ok: true, action };
}

export default function RecoveryPage() {
  const { merchant, orderName, city, alreadyResponded, lastAction } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const done = fetcher.data?.ok || alreadyResponded;
  const chosen = fetcher.data?.action ?? lastAction;

  return (
    <main style={S.page}>
      <div style={S.card}>
        <p style={S.merchant}>{merchant}</p>
        <h1 style={S.h1}>We could not complete your delivery</h1>
        <p style={S.sub}>
          Order {orderName}{city ? ` · ${city}` : ""}
        </p>

        {done ? (
          <div style={S.success}>
            <h2 style={S.h2}>Thank you — we have your response.</h2>
            <p style={S.body}>{SUCCESS_COPY[chosen ?? "NEED_HELP"]}</p>
            <p style={S.fine}>
              {merchant} will pass this to the courier. This page does not reschedule the delivery by itself.
            </p>
          </div>
        ) : (
          <>
            <p style={S.body}>Tell us what you would like us to do.</p>
            {fetcher.data?.error && <p style={S.error}>{fetcher.data.error}</p>}

            <fetcher.Form method="post" style={S.stack}>
              <button style={S.primary} name="action" value="REATTEMPT" type="submit">
                Try delivering again
              </button>
              <button style={S.secondary} name="action" value="ALREADY_RECEIVED" type="submit">
                I already received it
              </button>
              <button style={S.secondary} name="action" value="REFUSED" type="submit">
                I do not want the order
              </button>
              <button style={S.secondary} name="action" value="NEED_HELP" type="submit">
                Need help
              </button>
            </fetcher.Form>

            <details style={S.details}>
              <summary style={S.summary}>My address needs correcting</summary>
              <fetcher.Form method="post" style={S.stack}>
                <input type="hidden" name="action" value="ADDRESS_CORRECTION" />
                <label style={S.label} htmlFor="line1">Address line</label>
                <input style={S.input} id="line1" name="line1" autoComplete="address-line1" />
                <label style={S.label} htmlFor="landmark">Nearby landmark</label>
                <input style={S.input} id="landmark" name="landmark" />
                <label style={S.label} htmlFor="pincode">PIN code</label>
                <input style={S.input} id="pincode" name="pincode" inputMode="numeric" maxLength={6} autoComplete="postal-code" />
                <button style={S.primary} type="submit">Send correction</button>
              </fetcher.Form>
            </details>
          </>
        )}

        <p style={S.fine}>This link expires 48 hours after it was created.</p>
      </div>
    </main>
  );
}

const SUCCESS_COPY: Record<string, string> = {
  REATTEMPT: "We have asked the seller to arrange another delivery attempt.",
  ADDRESS_CORRECTION: "Your corrected address has been sent to the seller.",
  ALREADY_RECEIVED: "Thanks for letting us know — we have marked this order as received.",
  REFUSED: "We have told the seller you do not want the order.",
  NEED_HELP: "The seller will get in touch with you.",
};

export function ErrorBoundary() {
  return (
    <main style={S.page}>
      <div style={S.card}>
        <h1 style={S.h1}>This link is no longer valid</h1>
        <p style={S.body}>Recovery links expire after 48 hours. Please contact the seller directly.</p>
      </div>
    </main>
  );
}

// Mobile-first, no external CSS: this page must render instantly on a slow phone connection.
const S: Record<string, React.CSSProperties> = {
  page: { fontFamily: "system-ui, -apple-system, sans-serif", background: "#f6f6f7", minHeight: "100vh", padding: 16, display: "flex", justifyContent: "center", alignItems: "flex-start" },
  card: { background: "#fff", borderRadius: 12, padding: 24, maxWidth: 440, width: "100%", boxShadow: "0 1px 3px rgba(0,0,0,.1)", marginTop: 24 },
  merchant: { fontSize: 13, textTransform: "uppercase", letterSpacing: ".06em", color: "#6d7175", margin: 0 },
  h1: { fontSize: 22, lineHeight: 1.3, margin: "8px 0 4px" },
  h2: { fontSize: 18, margin: "0 0 8px" },
  sub: { color: "#6d7175", fontSize: 14, margin: "0 0 20px" },
  body: { fontSize: 15, lineHeight: 1.5, margin: "0 0 16px" },
  stack: { display: "flex", flexDirection: "column", gap: 10 },
  primary: { padding: "14px 16px", fontSize: 16, borderRadius: 8, border: 0, background: "#1a1a1a", color: "#fff", cursor: "pointer", minHeight: 48 },
  secondary: { padding: "14px 16px", fontSize: 16, borderRadius: 8, border: "1px solid #c9cccf", background: "#fff", cursor: "pointer", minHeight: 48 },
  details: { marginTop: 20, borderTop: "1px solid #e3e3e3", paddingTop: 16 },
  summary: { cursor: "pointer", fontSize: 15, marginBottom: 12 },
  label: { fontSize: 13, color: "#6d7175" },
  input: { padding: "12px", fontSize: 16, borderRadius: 8, border: "1px solid #c9cccf", width: "100%", boxSizing: "border-box" },
  success: { background: "#f1f8f5", borderRadius: 8, padding: 16, marginBottom: 12 },
  error: { background: "#fff4f4", color: "#8e1f0b", padding: 12, borderRadius: 8, fontSize: 14 },
  fine: { fontSize: 12, color: "#8c9196", marginTop: 20, marginBottom: 0 },
};
