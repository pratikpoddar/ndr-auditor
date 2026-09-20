# Protected customer data request

Submitted in the Partner Dashboard → your app → **API access** → *Protected customer data access*.
There is no config-file or CLI path for this; it is a form.

Everything below is grounded in what the code actually does. Review compares your answers to app
behaviour, so if you change the data model, change this too.

---

## Level of access to request

**Level 1 (protected customer data)** — yes, because the app processes order data.

**Level 2 (protected customer fields)** — yes, for **address only**.

Request **address**. Do **not** request name, email or phone: the app never asks for the
`read_customers` scope and stores none of them. Saying so explicitly is the strongest part of
this application — most apps request far more than they use.

---

## Field-by-field justification

Paste these into the "reason" box for each field.

### Address — REQUIRED

> The app audits delivery failures and return-to-origin shipments for Indian D2C merchants. It
> uses only the destination city, state/province code, country code and postal (PIN) code, in
> order to show merchants which delivery areas have the highest failure rates — the single most
> actionable cut in the product, since Indian delivery performance varies enormously by PIN code.
>
> The app does not read or store street address lines from Shopify. PIN codes are grouped to the
> first three digits for all display and reporting, and areas with fewer than 20 shipments are
> marked "insufficient sample" and excluded from rankings, so no individual buyer can be
> identified from any chart or table.
>
> A full PIN code is retained only to join a shipment to its destination for exact-match
> analysis; it is never displayed at full precision.

### Name — NOT REQUESTED

> Not required. The app identifies orders by Shopify order name (e.g. #1042) and never displays
> or stores a customer name.

### Email — NOT REQUESTED

> Not required. The app does not contact buyers by email. Recovery links are shared by the
> merchant through their own channel.

### Phone — NOT REQUESTED

> Not required. The app does not contact buyers directly. Merchant alerts deliberately exclude
> buyer phone numbers.

---

## Data protection requirements

Shopify asks you to attest to each of these. Here is what the app actually does, with file
references so you can answer accurately rather than optimistically.

| Requirement | What the app does | Where |
|---|---|---|
| **Encryption in transit** | HTTPS enforced (`force_https = true`) | `fly.toml` |
| **Encryption at rest** | Shopify tokens and buyer-submitted addresses use AES-256-GCM | `app/lib/crypto.server.ts` |
| **Data minimization** | Only the fields listed above; `read_customers` never requested; street address never read | `app/lib/shopify/queries.ts` |
| **Retention policy** | Raw webhook payloads purged after 7 days; shop data deleted on uninstall/redact | `prisma/schema.prisma` (`purgeAfter`), `app/routes/webhooks.tsx` |
| **Mandatory webhooks** | `customers/data_request`, `customers/redact`, `shop/redact` all implemented | `app/routes/webhooks.tsx` |
| **Right to erasure** | `customers/redact` nulls location data and buyer submissions for named orders; `shop/redact` deletes the tenant | `app/routes/webhooks.tsx` |
| **Access controls** | Every query is scoped by tenant key; one shop cannot read another's rows | `app/lib/dashboard.server.ts`, all routes |
| **No data sale** | Stated in the published privacy policy | `/privacy` |
| **Logging hygiene** | Tokens, full addresses, phone numbers and raw webhook bodies are never logged | `app/lib/jobs/runner.server.ts` |
| **Incident response** | Owner contactable at the published support address | `/support` |
| **Subprocessors disclosed** | Fly.io (hosting + Postgres, Singapore), Shopify, optional WhatsApp provider | `/privacy` |

---

## Known gaps to close before submitting

Be honest about these rather than attesting to something untrue.

- [ ] **Backups** — unmanaged Fly Postgres has no automatic backups today. Most data is
      reconstructible by re-running the backfill, but recovery outcomes, merchant labels and
      buyer responses exist only here.
- [ ] **Staff access control** — currently a single operator. Fine to state as such; revisit
      when anyone else gets database access.
- [ ] **Support email on a real domain** — `SUPPORT_EMAIL` is a personal address. Move it to a
      domain address before submitting.

---

## Links to provide

- Privacy policy: `https://ndr-auditor.fly.dev/privacy`
- Support: `https://ndr-auditor.fly.dev/support`
