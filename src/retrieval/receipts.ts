/**
 * Delivery receipts (R16; oracles C25 A5/A7/A8, C26 A05/A11/A12/A13,
 * C05 A13/A14, C12 A18, C19 A13/A14).
 *
 * Four states, kept distinct because collapsing any pair is what makes a loss
 * invisible:
 *
 *  - `selected`  — the retriever chose it.
 *  - `emitted`   — it is in the bytes that were rendered.
 *  - `delivered` — a consumer acknowledged receiving those bytes.
 *  - `unknown`   — emitted, but no acknowledgement. NOT `delivered` (C26 A12).
 *
 * `unknown` is the state an optimistic implementation skips, and it is the one
 * that matters: a packet whose delivery is unknown cannot qualify an action.
 *
 * The persisted hash is over the EXACT rendered payload (`Packet.text`), not
 * over a re-serialization of the selection. A hash of the selection would still
 * match after the formatter silently dropped a record, which is the failure
 * C26 A05 is written to catch.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export type DeliveryState = "selected" | "emitted" | "delivered" | "unknown";

/** Adapter-supplied coordinates. Retrieval never invents these. */
export interface TurnBinding {
  principal: string;
  host: string;
  session: string;
  turn: string;
}

export interface Receipt {
  receipt_id: string;
  /** sha256 over the exact emitted bytes. */
  emitted_bytes_sha256: string;
  emitted_byte_length: number;
  /**
   * A DIFFERENT value from `emitted_bytes_sha256`, recorded for diagnosis and
   * never used as delivery proof (C25 A11, C08 A8, C05 A4). Normalizing before
   * hashing would collapse two distinct snippets onto one identity.
   */
  normalized_text_sha256?: string;
  binding: TurnBinding | null;
  selected: string[];
  emitted: string[];
  delivered: string[];
  unknown: string[];
  omissions: Array<{ id: string; reason: string; role: string }>;
  token_usage: Record<string, unknown>;
  /** How many emission attempts this packet has had (C26 A13 idempotence). */
  emission_attempts: number;
  state: DeliveryState;
  created_at: string;
}

export function hashBytes(text: string): string {
  return `sha256:${createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex")}`;
}

/**
 * The normalized-text hash: BOM stripped, CRLF folded, whitespace collapsed.
 *
 * Exists only so the two values can be shown to DIFFER. Nothing in delivery
 * accounting consumes it.
 */
export function hashNormalized(text: string): string {
  const normalized = text.replace(/^﻿/, "").replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ");
  return `sha256:${createHash("sha256").update(Buffer.from(normalized, "utf8")).digest("hex")}`;
}

export interface MintOptions {
  receipt_id: string;
  emitted_text: string;
  selected: string[];
  emitted: string[];
  omissions: Array<{ id: string; reason: string; role: string }>;
  token_usage: Record<string, unknown>;
  binding?: TurnBinding | null;
  now?: () => string;
}

/**
 * Mint a receipt for an emitted packet.
 *
 * Emission is not delivery: everything emitted starts in `unknown` and moves to
 * `delivered` only when `acknowledge` is called with the same byte hash.
 */
export function mintReceipt(opts: MintOptions): Receipt {
  const now = opts.now ?? (() => new Date().toISOString());
  return {
    receipt_id: opts.receipt_id,
    emitted_bytes_sha256: hashBytes(opts.emitted_text),
    emitted_byte_length: Buffer.byteLength(opts.emitted_text, "utf8"),
    normalized_text_sha256: hashNormalized(opts.emitted_text),
    binding: opts.binding ?? null,
    selected: opts.selected,
    emitted: opts.emitted,
    delivered: [],
    unknown: [...opts.emitted],
    omissions: opts.omissions,
    token_usage: opts.token_usage,
    emission_attempts: 1,
    state: "emitted",
    created_at: now(),
  };
}

/**
 * Acknowledge delivery of the exact bytes named by `received_sha256`.
 *
 * A mismatch is refused: the receipt stays `unknown` rather than being
 * upgraded on the consumer's say-so. A repeat acknowledgement of the same
 * bytes is idempotent — the emitted set, the delivered set and the token count
 * are unchanged, and only `emission_attempts` moves (C26 A13).
 */
export function acknowledge(
  receipt: Receipt,
  received_sha256: string,
  binding: TurnBinding,
): { receipt: Receipt; accepted: boolean; reason?: string } {
  if (received_sha256 !== receipt.emitted_bytes_sha256) {
    return {
      receipt: { ...receipt, emission_attempts: receipt.emission_attempts + 1 },
      accepted: false,
      reason: "emitted_bytes_hash_mismatch",
    };
  }
  if (receipt.state === "delivered") {
    // Idempotent retry: one delivery record, attempts incremented, sets frozen.
    return {
      receipt: { ...receipt, emission_attempts: receipt.emission_attempts + 1 },
      accepted: true,
      reason: "duplicate_acknowledgement",
    };
  }
  return {
    receipt: {
      ...receipt,
      binding,
      delivered: [...receipt.emitted],
      unknown: [],
      state: "delivered",
      emission_attempts: receipt.emission_attempts + 1,
    },
    accepted: true,
  };
}

/** A packet whose delivery is not acknowledged cannot qualify an action. */
export function deliveryQualifies(receipt: Receipt): boolean {
  return receipt.state === "delivered" && receipt.unknown.length === 0;
}

/* ------------------------------------------------------------------ */
/* Persistence                                                          */
/* ------------------------------------------------------------------ */

/**
 * Receipts live under `.twining/retrieval/receipts/<yyyy-mm>/<id>.json`.
 *
 * Append-only by construction (the id is unique per emission) so a later
 * emission never overwrites the evidence of an earlier one — C26 A15 requires
 * A1's and A2's receipts to be byte-identical after A3 succeeds.
 */
export function receiptsDir(twiningDir: string): string {
  return path.join(twiningDir, "retrieval", "receipts");
}

export function persistReceipt(twiningDir: string, receipt: Receipt): string {
  const shard = receipt.created_at.slice(0, 7);
  const dir = path.join(receiptsDir(twiningDir), shard);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${receipt.receipt_id}.json`);
  fs.writeFileSync(file, JSON.stringify(receipt, null, 2), "utf8");
  return file;
}

export function readReceipt(twiningDir: string, receiptId: string, createdAt: string): Receipt | null {
  const file = path.join(receiptsDir(twiningDir), createdAt.slice(0, 7), `${receiptId}.json`);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Receipt;
  } catch {
    return null;
  }
}
