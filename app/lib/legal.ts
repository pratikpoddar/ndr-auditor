/**
 * Single source of truth for the legal/support pages.
 *
 * Shopify review checks that the privacy policy matches what the app actually does, so this
 * content is written from the real data model rather than from a template. If a field is added
 * to OrderFact or BuyerResponse, it must be reflected here.
 */
export const COMPANY = {
  name: "NDR Auditor",
  operator: process.env.LEGAL_ENTITY_NAME || "Pratik Poddar",
  email: process.env.SUPPORT_EMAIL || "support@ndrauditor.app",
  address: process.env.LEGAL_ADDRESS || "India",
  updated: "20 September 2026",
};

export const DATA_COLLECTED = [
  {
    what: "Order facts",
    fields: "Order ID, order name, dates, total value, currency, payment gateway names, financial status, refund amount and dates, cancellation date and reason, order tags",
    why: "These are the denominators of the audit and the basis of 'value at risk'. Refund and cancellation timing is required by the RTO correlation rules.",
  },
  {
    what: "Destination location",
    fields: "Destination city, state/province code, country code, and postal (PIN) code",
    why: "To show which delivery areas fail most often. PIN codes are grouped to the first three digits for display, and low-volume areas are suppressed so an individual buyer cannot be identified from a chart.",
  },
  {
    what: "Line items",
    fields: "Line item ID, SKU, product title, product and variant IDs, quantity, unit price",
    why: "To break leakage down by product and SKU.",
  },
  {
    what: "Shipment and tracking data",
    fields: "Fulfillment ID, carrier name, tracking number (AWB), tracking URL, status, and the carrier event timeline including event messages, timestamps and cities",
    why: "This is the evidence the audit is built on. Event messages are what the NDR reason classifier reads.",
  },
  {
    what: "Buyer-submitted corrections",
    fields: "Address line, landmark and PIN code, only when a buyer voluntarily submits them through a recovery link",
    why: "To pass a corrected address back to the merchant. Encrypted at rest with AES-256-GCM.",
  },
  {
    what: "Recovery link usage",
    fields: "A one-way salted hash of IP address and user agent, plus the option the buyer selected",
    why: "Weak provenance evidence so a merchant can see a response was genuine. The raw IP address and user agent are never stored.",
  },
];

export const NOT_COLLECTED = [
  "Buyer names, email addresses or phone numbers — the app does not request the read_customers scope",
  "Full street addresses from Shopify (only city, state, country and PIN code)",
  "Payment card or bank details of any kind",
  "Anything from your storefront, theme, products, or customers outside the orders in scope",
];

export const RETENTION = [
  ["Raw webhook payloads", "7 days, then automatically purged. Kept only for debugging."],
  ["Order, shipment and event data", "For as long as the app is installed, then deleted on the schedule below."],
  ["Buyer address corrections", "Deleted with the incident, or immediately on a customers/redact request."],
  ["Recovery links", "Expire 48 hours after they are created. Only a SHA-256 hash is ever stored."],
  ["After uninstall", "All shop data is deleted within 30 days. Shopify's shop/redact webhook triggers an immediate full purge."],
];

export const SUBPROCESSORS = [
  ["Fly.io", "Application hosting and managed PostgreSQL (Singapore region)"],
  ["Shopify", "Source of all order and fulfillment data; handles all billing"],
  ["WhatsApp provider", "Only if the merchant enables buyer or merchant alerts. Disabled by default."],
];
