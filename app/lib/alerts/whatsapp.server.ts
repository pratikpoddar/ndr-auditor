import type { PrismaClient, Shop } from "@prisma/client";
import { maskAwb } from "../normalize";
import { formatINR } from "../metrics";
import { RTO_LABEL } from "../inference/engine";
import { REASON_LABEL, type ReasonClass } from "../inference/reasons";
import { issueRecoveryToken, recoveryUrl } from "../tokens.server";

/**
 * Merchant alerting.
 *
 * Provider choice is configuration, not architecture. The default provider is `console`,
 * which logs a fully-formed alert and marks it SENT — so the install-to-audit demo works
 * with zero WhatsApp setup, and neither Meta business verification nor template approval can
 * block the core story. Swap ALERT_PROVIDER to `twilio` or `meta` once a template is live.
 */

export type AlertProviderName = "console" | "twilio" | "meta";

export type AlertMessage = {
  to: string;
  body: string;
  templateParams: string[];
};

export type ProviderResult = {
  ok: boolean;
  providerId?: string;
  raw?: unknown;
  error?: string;
};

export interface AlertProvider {
  name: AlertProviderName;
  send(message: AlertMessage): Promise<ProviderResult>;
}

const consoleProvider: AlertProvider = {
  name: "console",
  async send(message) {
    // Deliberately logs the rendered body: this is the demo fallback and the local dev path.
    console.log(JSON.stringify({ level: "info", msg: "merchant alert (console provider)", to: message.to, body: message.body }));
    return { ok: true, providerId: `console-${Date.now()}` };
  },
};

const twilioProvider: AlertProvider = {
  name: "twilio",
  async send(message) {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_WHATSAPP_FROM;
    if (!sid || !token || !from) return { ok: false, error: "twilio credentials not configured" };

    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ From: from, To: message.to, Body: message.body }),
    });
    const raw: any = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: raw?.message ?? `twilio http ${res.status}`, raw };
    return { ok: true, providerId: raw?.sid, raw };
  },
};

const metaProvider: AlertProvider = {
  name: "meta",
  async send(message) {
    const phoneId = process.env.META_PHONE_NUMBER_ID;
    const token = process.env.META_ACCESS_TOKEN;
    const template = process.env.META_ALERT_TEMPLATE;
    if (!phoneId || !token || !template) return { ok: false, error: "meta credentials/template not configured" };

    const res = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: message.to.replace("whatsapp:", ""),
        type: "template",
        template: {
          name: template,
          language: { code: "en" },
          components: [{ type: "body", parameters: message.templateParams.map((t) => ({ type: "text", text: t })) }],
        },
      }),
    });
    const raw: any = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: raw?.error?.message ?? `meta http ${res.status}`, raw };
    return { ok: true, providerId: raw?.messages?.[0]?.id, raw };
  },
};

export function getProvider(name = process.env.ALERT_PROVIDER as AlertProviderName | undefined): AlertProvider {
  switch (name) {
    case "twilio": return twilioProvider;
    case "meta": return metaProvider;
    default: return consoleProvider;
  }
}

/**
 * Merchant template (spec 4.4). Never contains a full AWB, a full phone number, or an
 * address: these land in ops group chats, and a leaked buyer address is a real harm, not a
 * hypothetical one.
 */
export function renderMerchantAlert(params: {
  orderName: string;
  carrier: string;
  awb: string | null;
  statusLabel: string;
  reason: ReasonClass;
  city: string | null;
  value: number;
  currency: string;
  link: string;
}): AlertMessage {
  const templateParams = [
    params.orderName,
    params.carrier,
    maskAwb(params.awb),
    `${params.statusLabel} (${REASON_LABEL[params.reason]})`,
    params.city ?? "location unknown",
    formatINR(params.value, params.currency).replace(/^\D+/, ""),
    params.link,
  ];
  const body =
    `Delivery issue on order ${templateParams[0]} (${templateParams[1]}, AWB ending ${templateParams[2]}). ` +
    `Status: ${templateParams[3]} at ${templateParams[4]}. ` +
    `Order value: ${formatINR(params.value, params.currency)}. ` +
    `Open recovery: ${params.link}`;
  return { to: "", body, templateParams };
}

/** Quiet hours are shop-local. A 2am WhatsApp about a failed delivery helps nobody. */
export function inQuietHours(shop: Shop, now = new Date()): boolean {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, timeZone: shop.timezone }).format(now),
  );
  const { quietHoursStart: start, quietHoursEnd: end } = shop;
  if (start === end) return false;
  // Window wraps midnight (e.g. 21:00 -> 08:00).
  return start > end ? hour >= start || hour < end : hour >= start && hour < end;
}

export async function sendMerchantAlert(prisma: PrismaClient, shop: Shop, incidentId: string): Promise<void> {
  const incident = await prisma.nDRIncident.findUnique({
    where: { id: incidentId },
    include: { shipment: { include: { order: true } } },
  });
  if (!incident) return;

  const dedupeKey = `${incidentId}:${incident.rtoLevel}:${incident.openRule}`;
  const existing = await prisma.alertLog.findUnique({ where: { dedupeKey } });
  if (existing) return; // Already alerted for this incident at this state.

  const config = (shop.whatsappConfig ?? {}) as { merchantRecipient?: string };
  const recipient = config.merchantRecipient ?? process.env.DEMO_MERCHANT_WHATSAPP ?? "console";

  if (inQuietHours(shop)) {
    // Suppressed, not dropped: it stays visible in the dashboard and rolls into the digest.
    await prisma.alertLog.create({
      data: { incidentId, channel: "WHATSAPP_MERCHANT", dedupeKey, status: "SUPPRESSED_QUIET_HOURS" },
    });
    return;
  }

  // Mint the recovery token at send time so its 48h clock starts when the merchant is told.
  const issued = issueRecoveryToken();
  await prisma.nDRIncident.update({
    where: { id: incidentId },
    data: {
      recoveryTokenHash: issued.tokenHash,
      tokenExpiresAt: issued.expiresAt,
      contactedAt: incident.contactedAt ?? new Date(),
      state: incident.state === "NDR_OPEN" ? "CONTACTED" : incident.state,
    },
  });

  const message = renderMerchantAlert({
    orderName: incident.shipment.order.orderName,
    carrier: incident.shipment.carrierRaw ?? "unknown carrier",
    awb: incident.shipment.awb,
    statusLabel: RTO_LABEL[incident.rtoLevel as keyof typeof RTO_LABEL] ?? "Delivery exception",
    reason: incident.reasonClass as ReasonClass,
    city: incident.shipment.order.city,
    value: Number(incident.riskValue),
    currency: incident.shipment.order.currency,
    link: recoveryUrl(issued.token),
  });

  const log = await prisma.alertLog.create({
    data: { incidentId, channel: "WHATSAPP_MERCHANT", dedupeKey, status: "QUEUED" },
  });

  const provider = getProvider();
  const result = await provider.send({ ...message, to: recipient });

  await prisma.alertLog.update({
    where: { id: log.id },
    data: {
      status: result.ok ? "SENT" : "FAILED",
      providerId: result.providerId ?? null,
      providerResponse: (result.raw ?? null) as any,
      error: result.error ?? null,
      sentAt: result.ok ? new Date() : null,
    },
  });

  if (!result.ok) {
    // Surfaced in the error queue on the incidents page rather than thrown: a template
    // failure must not retry forever and must not look like a data problem.
    console.error(JSON.stringify({ level: "error", msg: "alert send failed", incidentId, error: result.error }));
  }
}
