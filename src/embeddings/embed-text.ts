/**
 * Canonical embed-text derivation, shared by the live write path (engines),
 * keyword-fallback search, and the sync layer's embedding reconciliation.
 * There must be exactly one definition of "the text a record is embedded
 * as": the reconciler decides whether to re-embed by hashing this text, so
 * any drift between call sites would either thrash the model or leave
 * stale vectors blessed.
 */
import { createHash } from "node:crypto";
import type { BlackboardEntry, Decision } from "../utils/types.js";

export function blackboardEmbedText(
  entry: Pick<BlackboardEntry, "summary" | "detail">,
): string {
  return entry.summary + " " + entry.detail;
}

export function decisionEmbedText(
  decision: Pick<Decision, "summary" | "rationale" | "context">,
): string {
  return decision.summary + " " + decision.rationale + " " + decision.context;
}

/** Stable identity for an embed text — sha256 hex. */
export function embedContentHash(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}
