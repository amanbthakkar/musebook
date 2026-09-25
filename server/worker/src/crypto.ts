/**
 * Canonical JSON (keys sorted recursively), base64url, and Ed25519 helpers.
 */

export function canonical(v: unknown): string {
  return JSON.stringify(sortKeys(v));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort())
      out[k] = sortKeys((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

/** Correct, simple random base64url. */
export function randomSecret(bytes = 32): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  let bin = "";
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(s)
  );
  return [...new Uint8Array(d)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function b64UrlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Verify an Ed25519 signature over the canonical JSON of `envelope`. */
export async function verifyEnvelope(
  envelope: Record<string, unknown>,
  signatureB64Url: string,
  pubkeyJwk: JsonWebKey
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      pubkeyJwk,
      { name: "Ed25519" },
      false,
      ["verify"]
    );
    const data = new TextEncoder().encode(canonical(envelope));
    const sig = b64UrlToBytes(signatureB64Url);
    return await crypto.subtle.verify("Ed25519", key, sig.buffer as ArrayBuffer, data);
  } catch {
    return false;
  }
}

/** Timing-safe string compare. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
