import crypto from "node:crypto";

/**
 * AES-256-GCM for buyer contact data and corrected addresses at rest.
 * APP_ENCRYPTION_KEY must be 32 bytes, base64-encoded. Generate with:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 */
function key(): Buffer {
  const raw = process.env.APP_ENCRYPTION_KEY;
  if (!raw) throw new Error("APP_ENCRYPTION_KEY is not set");
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new Error("APP_ENCRYPTION_KEY must decode to exactly 32 bytes");
  return buf;
}

export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(".");
}

export function decrypt(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split(".");
  if (!ivB64 || !tagB64 || !dataB64) throw new Error("malformed ciphertext");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}

/** One-way hash for values we must compare but must never be able to read back. */
export function hash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/**
 * Hash of IP + user-agent, stored on a buyer response as weak provenance evidence.
 * Salted with the app secret so the stored value is not a rainbow-table lookup of an IP.
 */
export function clientFingerprint(ip: string | null, userAgent: string | null): string {
  const salt = process.env.SHOPIFY_API_SECRET ?? "dev-salt";
  return crypto
    .createHash("sha256")
    .update(`${salt}|${ip ?? ""}|${userAgent ?? ""}`)
    .digest("hex")
    .slice(0, 32);
}

/** Constant-time compare, for HMACs and tokens. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** Verify a Shopify webhook HMAC against the RAW request body. */
export function verifyShopifyHmac(rawBody: string, headerHmac: string | null, secret: string): boolean {
  if (!headerHmac) return false;
  const digest = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
  return safeEqual(digest, headerHmac);
}
