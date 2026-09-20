import crypto from "node:crypto";
import { hash, safeEqual } from "./crypto.server";

/**
 * Buyer recovery tokens.
 *
 * Requirements from spec 4.5: not enumerable, 48h expiry, no Shopify login. The token is a
 * random 32-byte value; only its SHA-256 is stored, so a database leak does not hand over
 * working recovery links. The incident ID is never part of the URL — the token is looked up
 * by hash — which is what makes enumeration impossible rather than merely inconvenient.
 */

export const TOKEN_TTL_HOURS = 48;

export type IssuedToken = {
  token: string;
  tokenHash: string;
  expiresAt: Date;
};

export function issueRecoveryToken(now = new Date()): IssuedToken {
  const token = crypto.randomBytes(32).toString("base64url");
  return {
    token,
    tokenHash: hash(token),
    expiresAt: new Date(now.getTime() + TOKEN_TTL_HOURS * 3600_000),
  };
}

export function tokenHashOf(token: string): string {
  return hash(token);
}

export function isExpired(expiresAt: Date | null | undefined, now = new Date()): boolean {
  if (!expiresAt) return true;
  return expiresAt.getTime() <= now.getTime();
}

export function recoveryUrl(
  token: string,
  appUrl = process.env.SHOPIFY_APP_URL || process.env.APP_URL || "",
): string {
  return `${appUrl.replace(/\/$/, "")}/r/${token}`;
}

/** Exported for tests: verifies a presented token against a stored hash in constant time. */
export function verifyToken(presented: string, storedHash: string): boolean {
  return safeEqual(hash(presented), storedHash);
}
