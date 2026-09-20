import type { MetaFunction } from "@remix-run/node";
import { COMPANY } from "../lib/legal";

export const meta: MetaFunction = () => [
  { title: "Support — NDR Auditor" },
  { name: "description", content: "Support and contact for NDR Auditor." },
];

/** Public and unauthenticated — Shopify app review requires a reachable support page. */
export default function Support() {
  return (
    <main style={S.page}>
      <article style={S.article}>
        <h1 style={S.h1}>Support</h1>
        <p style={S.lede}>
          Email <a href={`mailto:${COMPANY.email}`} style={S.a}>{COMPANY.email}</a>. During the
          founding cohort this reaches {COMPANY.operator} directly. Expect a reply within one
          business day.
        </p>

        <h2 style={S.h2}>Common questions</h2>

        <h3 style={S.h3}>My dashboard is empty</h3>
        <p style={S.p}>
          Usually this means your courier or aggregator is not writing tracking numbers back to
          Shopify. Open <b>Tracking hygiene</b> — it will tell you whether AWBs are missing
          entirely, or present but never updated. Until tracking reaches Shopify, no tool that
          reads Shopify can audit your deliveries, including this one.
        </p>

        <h3 style={S.h3}>Why does it say 60 days and not 90?</h3>
        <p style={S.p}>
          Shopify only exposes 60 days of orders unless an app is approved for extended access.
          We show the window we can actually deliver rather than claiming 90 and quietly
          returning less.
        </p>

        <h3 style={S.h3}>Why is an RTO marked "likely" rather than confirmed?</h3>
        <p style={S.p}>
          Shopify has no native RTO field. We infer it from carrier events and label the
          confidence honestly. "Confirmed RTO" appears only when a carrier explicitly reports the
          parcel returning to origin. We never infer a return from a refund or a cancellation
          alone. Every inferred row shows the evidence and the rule that produced it.
        </p>

        <h3 style={S.h3}>Does the recovery link reschedule the delivery?</h3>
        <p style={S.p}>
          No. It captures what the buyer wants and passes it to you. You still have to act in your
          shipping system. We will not imply otherwise.
        </p>

        <h3 style={S.h3}>Will the app change anything in my store?</h3>
        <p style={S.p}>
          Only if you explicitly ask it to. The single write it can make is correcting a carrier
          name on a fulfillment, which requires your confirmation, preserves the tracking number
          and URL, and is logged before and after so it can be reversed.
        </p>

        <h3 style={S.h3}>How do I cancel?</h3>
        <p style={S.p}>
          Uninstall the app from your Shopify admin. Billing stops immediately and all of your
          data is deleted within 30 days. See the <a href="/privacy" style={S.a}>privacy policy</a>.
        </p>

        <p style={S.footer}>
          <a href="/privacy" style={S.a}>Privacy policy</a>
        </p>
      </article>
    </main>
  );
}

const S: Record<string, React.CSSProperties> = {
  page: { fontFamily: "system-ui, -apple-system, sans-serif", background: "#fff", padding: "32px 20px", color: "#1a1a1a" },
  article: { maxWidth: 720, margin: "0 auto", lineHeight: 1.65 },
  h1: { fontSize: 30, marginBottom: 8 },
  h2: { fontSize: 19, marginTop: 34, marginBottom: 10 },
  h3: { fontSize: 16, marginTop: 24, marginBottom: 6 },
  lede: { fontSize: 16.5 },
  p: { fontSize: 15.5, marginTop: 0 },
  a: { color: "#005bd3" },
  footer: { marginTop: 40, paddingTop: 16, borderTop: "1px solid #e3e3e3", fontSize: 14 },
};
