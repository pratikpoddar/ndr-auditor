import type { MetaFunction } from "@remix-run/node";
import { COMPANY, DATA_COLLECTED, NOT_COLLECTED, RETENTION, SUBPROCESSORS } from "../lib/legal";

export const meta: MetaFunction = () => [
  { title: "Privacy Policy — NDR Auditor" },
  { name: "description", content: "How NDR Auditor handles Shopify and buyer data." },
];

/**
 * Public, unauthenticated: Shopify app review must be able to load this without installing,
 * and merchants link to it from their own policies.
 */
export default function Privacy() {
  return (
    <main style={S.page}>
      <article style={S.article}>
        <h1 style={S.h1}>Privacy Policy</h1>
        <p style={S.meta}>{COMPANY.name}, operated by {COMPANY.operator} · Last updated {COMPANY.updated}</p>

        <p style={S.lede}>
          NDR Auditor reads shipment data from your Shopify store to show where failed deliveries
          and returns are costing you money. It reads only Shopify. It does not connect to any
          courier account, and it asks for the smallest set of data that makes the audit possible.
        </p>

        <h2 style={S.h2}>What we collect, and why</h2>
        <table style={S.table}>
          <thead><tr><th style={S.th}>Data</th><th style={S.th}>Fields</th><th style={S.th}>Why</th></tr></thead>
          <tbody>
            {DATA_COLLECTED.map((d) => (
              <tr key={d.what}>
                <td style={S.td}><b>{d.what}</b></td>
                <td style={S.td}>{d.fields}</td>
                <td style={S.td}>{d.why}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <h2 style={S.h2}>What we deliberately do not collect</h2>
        <ul style={S.ul}>{NOT_COLLECTED.map((n) => <li key={n} style={S.li}>{n}</li>)}</ul>

        <h2 style={S.h2}>How long we keep it</h2>
        <table style={S.table}>
          <tbody>{RETENTION.map(([k, v]) => (
            <tr key={k}><td style={S.td}><b>{k}</b></td><td style={S.td}>{v}</td></tr>
          ))}</tbody>
        </table>

        <h2 style={S.h2}>Security</h2>
        <ul style={S.ul}>
          <li style={S.li}>Shopify access tokens and buyer-submitted addresses are encrypted at rest (AES-256-GCM).</li>
          <li style={S.li}>All traffic is served over HTTPS.</li>
          <li style={S.li}>Every Shopify webhook is verified by HMAC against the raw request body before it is processed.</li>
          <li style={S.li}>Recovery links are random 32-byte tokens, stored only as a SHA-256 hash, and expire after 48 hours. They cannot be guessed or enumerated.</li>
          <li style={S.li}>Access tokens, full addresses, phone numbers and raw webhook bodies are never written to application logs.</li>
          <li style={S.li}>Every shop's data is isolated by a tenant key enforced on every database query.</li>
        </ul>

        <h2 style={S.h2}>Who else processes your data</h2>
        <table style={S.table}>
          <tbody>{SUBPROCESSORS.map(([k, v]) => (
            <tr key={k}><td style={S.td}><b>{k}</b></td><td style={S.td}>{v}</td></tr>
          ))}</tbody>
        </table>
        <p style={S.p}>We do not sell your data, and we do not share it with advertisers or data brokers.</p>

        <h2 style={S.h2}>Buyer data and recovery links</h2>
        <p style={S.p}>
          When a delivery fails, a merchant may send a buyer a recovery link. That page shows only
          the merchant's name, the order number and the destination city — never a full address,
          phone number or tracking number. If a buyer submits a corrected address, it is encrypted
          and shown only to that merchant.
        </p>

        <h2 style={S.h2}>Your rights</h2>
        <p style={S.p}>
          We support Shopify's mandatory privacy webhooks. A <code>customers/redact</code> request
          removes the location data and any buyer-submitted content for the named orders. A{" "}
          <code>shop/redact</code> request deletes all of that shop's data. You can also email us
          directly to request access, correction or deletion.
        </p>

        <h2 style={S.h2}>Contact</h2>
        <p style={S.p}>
          {COMPANY.operator} · <a href={`mailto:${COMPANY.email}`} style={S.a}>{COMPANY.email}</a><br />
          {COMPANY.address}
        </p>

        <p style={S.footer}>
          <a href="/support" style={S.a}>Support</a>
        </p>
      </article>
    </main>
  );
}

const S: Record<string, React.CSSProperties> = {
  page: { fontFamily: "system-ui, -apple-system, sans-serif", background: "#fff", padding: "32px 20px", color: "#1a1a1a" },
  article: { maxWidth: 760, margin: "0 auto", lineHeight: 1.65 },
  h1: { fontSize: 30, marginBottom: 4 },
  h2: { fontSize: 19, marginTop: 34, marginBottom: 10 },
  meta: { color: "#6d7175", fontSize: 14, marginTop: 0 },
  lede: { fontSize: 16.5, marginTop: 22 },
  p: { fontSize: 15.5 },
  ul: { paddingLeft: 20 },
  li: { fontSize: 15.5, marginBottom: 7 },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 14.5, marginTop: 10 },
  th: { textAlign: "left", borderBottom: "2px solid #e3e3e3", padding: "8px 10px 8px 0", verticalAlign: "top" },
  td: { borderBottom: "1px solid #ededed", padding: "9px 10px 9px 0", verticalAlign: "top" },
  a: { color: "#005bd3" },
  footer: { marginTop: 40, paddingTop: 16, borderTop: "1px solid #e3e3e3", fontSize: 14 },
};
