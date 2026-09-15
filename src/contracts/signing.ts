/**
 * Ed25519 signing over canonical bytes (DP6). Public keys travel as base64
 * SPKI DER inside `principal` records; private keys never leave
 * ~/.twining/identity/. Zero native dependencies: node:crypto only.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { canonicalBytes, envelopeForDigest } from "./canonical.js";

export interface Keypair {
  publicKeySpkiBase64: string;
  privateKeyPkcs8Pem: string;
}

export function generateKeypair(): Keypair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeySpkiBase64: (publicKey.export({ type: "spki", format: "der" }) as Buffer).toString("base64"),
    privateKeyPkcs8Pem: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
  };
}

export function publicKeyFromBase64(spkiBase64: string): KeyObject {
  return createPublicKey({ key: Buffer.from(spkiBase64, "base64"), type: "spki", format: "der" });
}

/** Signature (base64) over the canonical bytes of the envelope minus digest/sig. */
export function signEvent(event: Record<string, unknown>, privateKeyPkcs8Pem: string): string {
  const key = createPrivateKey(privateKeyPkcs8Pem);
  return cryptoSign(null, canonicalBytes(envelopeForDigest(event)), key).toString("base64");
}

export function verifyEventSignature(event: Record<string, unknown>, signatureBase64: string, publicKeySpkiBase64: string): boolean {
  try {
    return cryptoVerify(null, canonicalBytes(envelopeForDigest(event)), publicKeyFromBase64(publicKeySpkiBase64), Buffer.from(signatureBase64, "base64"));
  } catch {
    return false;
  }
}
