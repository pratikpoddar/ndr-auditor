import { describe, it, expect, beforeAll } from "vitest";
import crypto from "node:crypto";

beforeAll(() => {
  process.env.APP_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
  process.env.SHOPIFY_API_SECRET = "test-secret";
});

const { encrypt, decrypt, verifyShopifyHmac, clientFingerprint, safeEqual } = await import("../app/lib/crypto.server");
const { issueRecoveryToken, verifyToken, isExpired, tokenHashOf } = await import("../app/lib/tokens.server");
const { csvCell, toCsv } = await import("../app/lib/export/csv");

describe("encryption", () => {
  it("round-trips buyer data", () => {
    const secret = JSON.stringify({ line1: "12 MG Road", pincode: "560001" });
    expect(decrypt(encrypt(secret))).toBe(secret);
  });

  it("produces different ciphertext each time (random IV)", () => {
    expect(encrypt("same")).not.toBe(encrypt("same"));
  });

  it("rejects tampered ciphertext rather than returning garbage", () => {
    const enc = encrypt("sensitive");
    const [iv, tag, data] = enc.split(".");
    const tampered = [iv, tag, Buffer.from("evil").toString("base64")].join(".");
    expect(() => decrypt(tampered)).toThrow();
  });
});

describe("Shopify webhook HMAC", () => {
  const secret = "test-secret";
  const body = JSON.stringify({ id: 123, status: "attempted_delivery" });
  const valid = crypto.createHmac("sha256", secret).update(body, "utf8").digest("base64");

  it("accepts a correct signature over the raw body", () => {
    expect(verifyShopifyHmac(body, valid, secret)).toBe(true);
  });

  it("rejects a wrong signature, a missing one, and a modified body", () => {
    expect(verifyShopifyHmac(body, "wrong", secret)).toBe(false);
    expect(verifyShopifyHmac(body, null, secret)).toBe(false);
    expect(verifyShopifyHmac(body + " ", valid, secret)).toBe(false);
  });
});

describe("recovery tokens", () => {
  it("stores only a hash, never the token itself", () => {
    const t = issueRecoveryToken();
    expect(t.tokenHash).not.toContain(t.token);
    expect(t.tokenHash).toHaveLength(64);
    expect(verifyToken(t.token, t.tokenHash)).toBe(true);
  });

  it("rejects a different token", () => {
    const a = issueRecoveryToken();
    const b = issueRecoveryToken();
    expect(verifyToken(b.token, a.tokenHash)).toBe(false);
  });

  it("is not enumerable: tokens are high-entropy and unique", () => {
    const seen = new Set(Array.from({ length: 500 }, () => issueRecoveryToken().token));
    expect(seen.size).toBe(500);
    expect([...seen][0].length).toBeGreaterThanOrEqual(42);
  });

  it("expires 48 hours after issue", () => {
    const now = new Date("2026-09-15T00:00:00Z");
    const t = issueRecoveryToken(now);
    expect(isExpired(t.expiresAt, new Date("2026-09-16T23:00:00Z"))).toBe(false);
    expect(isExpired(t.expiresAt, new Date("2026-09-17T01:00:00Z"))).toBe(true);
    expect(isExpired(null)).toBe(true);
  });
});

describe("client fingerprint", () => {
  it("is stable, salted, and never contains the raw IP", () => {
    const fp = clientFingerprint("203.0.113.5", "Mozilla/5.0");
    expect(fp).toBe(clientFingerprint("203.0.113.5", "Mozilla/5.0"));
    expect(fp).not.toContain("203.0.113.5");
    expect(fp).not.toBe(clientFingerprint("203.0.113.6", "Mozilla/5.0"));
  });
});

describe("CSV export escaping", () => {
  it("neutralises formula injection from courier free text", () => {
    // Courier messages are attacker-influenceable and land straight in an Excel cell.
    expect(csvCell("=cmd|'/c calc'!A1")).toBe("'=cmd|'/c calc'!A1");
    expect(csvCell("+1234")).toBe("'+1234");
    expect(csvCell("-1234")).toBe("'-1234");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
  });

  it("quotes separators, quotes and newlines", () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
  });

  it("emits a BOM and CRLF line endings for Excel", () => {
    const out = toCsv([["a", "b"], ["c", "d"]]);
    expect(out.startsWith("﻿")).toBe(true);
    expect(out).toContain("\r\n");
  });
});
