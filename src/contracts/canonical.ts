/**
 * Canonical bytes and digests (ADR §1.2, DP1).
 *
 * Canonical form: JSON with recursively sorted object keys, no insignificant
 * whitespace, UTF-8. Arrays keep their order (order is meaning). `undefined`
 * members are dropped (JSON has no undefined). No Unicode normalization —
 * bytes are bytes. The digest of an event covers the envelope minus `digest`
 * and `sig`. This is deliberately NOT the hash of the file on disk (which may
 * be pretty-printed) and NOT the hash of any source bytes (attachments carry
 * their own sha256) — three different values, three fields.
 */
import { createHash } from "node:crypto";

export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) {
      const v = src[key];
      if (v === undefined) continue;
      out[key] = sortKeysDeep(v);
    }
    return out;
  }
  return value;
}

/** Canonical JSON text (compact, sorted keys). */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

/** Canonical UTF-8 bytes. */
export function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(canonicalize(value), "utf8");
}

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export const DIGEST_PREFIX = "sha256:";

/** `sha256:<hex>` over the canonical bytes of `value`. */
export function digestOf(value: unknown): string {
  return DIGEST_PREFIX + sha256Hex(canonicalBytes(value));
}

/** Strip the fields the digest must not cover. */
export function envelopeForDigest(event: Record<string, unknown>): Record<string, unknown> {
  const { digest: _d, sig: _s, ...rest } = event;
  return rest;
}

/** Digest an event envelope (ignores any present `digest`/`sig`). */
export function computeEventDigest(event: Record<string, unknown>): string {
  return digestOf(envelopeForDigest(event));
}

export function isDigest(s: unknown): s is string {
  return typeof s === "string" && /^sha256:[0-9a-f]{64}$/.test(s);
}
