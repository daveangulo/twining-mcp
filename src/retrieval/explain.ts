/**
 * The explain packet (R16; oracles C25 A6/A18, C19 A05, C12 A13).
 *
 * Diagnostics are subject to the SAME authorization as retrieval. An explain
 * surface that lists what it suppressed — with ids, titles, snippets or scores
 * — hands the caller exactly the cross-scope data the filter just withheld.
 * That is the classic leak, and C25 A6 is written to catch it.
 *
 * So there are two renderings of one structure:
 *
 *  - `explainFor(viewer)` — counts by reason, applied filters, and full detail
 *    for candidates the viewer WAS authorized to read. No identifiers for
 *    anything denied on scope.
 *  - `explainOperator(...)` — the same, plus denied identifiers, and it is
 *    reachable only by a principal with `rule` capability. The `viewer` is
 *    still checked; being an operator surface is not an exemption.
 */
import type { SelectionOutcome, RetrievalMode, SelectionRequest } from "./select.js";
import { OPAQUE_REASONS, authorizedDigest, type DenialReason } from "./select.js";

export interface CandidateExplain {
  id: string;
  version: string;
  version_digest: string;
  evidence_class: string;
  lifecycle_state: string;
  /** live | stale | unknown, with the age when one is known. */
  freshness: { state: string; age_seconds?: number; reason?: string };
  score?: number;
  /** Which retrieval paths produced this candidate. */
  paths?: string[];
  /** Why it scored as it did; never the defense, always the account. */
  reasons?: string[];
  source_pointer?: { uri?: string; anchor?: string; sha256?: string };
}

export interface ExplainPacket {
  query_id: string;
  /** The scope the query ran under, and the authorization envelope digest. */
  query: {
    scope: Record<string, unknown>;
    mode: RetrievalMode;
    authorized_digest: string;
    principal: string;
  };
  /** Versions of everything that could change a result between two runs. */
  versions: {
    ranking: string;
    index: string;
    embedding_model: string;
    tokenizer: string;
    contract: string;
  };
  /** Candidates the viewer is authorized to see. */
  candidates: CandidateExplain[];
  /** Records that made it into the emitted packet. */
  results: CandidateExplain[];
  /** Counts by reason. Members are NOT named for an opaque reason. */
  suppressed: Record<string, number>;
  /** Suppressions the viewer may see in full (relevance, not authorization). */
  suppressed_visible: Array<{ id: string; reason: DenialReason }>;
  /** Why records were left out of the emitted packet (budget, unavailability). */
  omissions: Array<{ id: string; reason: string; role: string }>;
  outcome: SelectionOutcome<unknown>["outcome"];
  missing_entitlement?: string;
  token_usage: Record<string, unknown>;
  /** sha256 of the exact emitted payload; links to the receipt. */
  emitted_bytes_sha256?: string;
  receipt_id?: string;
  delivery_state?: string;
  /** True when this rendering withheld identifiers from the viewer. */
  redacted: boolean;
}

export interface ExplainInput {
  query_id: string;
  request: SelectionRequest;
  selection: SelectionOutcome<unknown>;
  candidates: CandidateExplain[];
  results: CandidateExplain[];
  omissions: Array<{ id: string; reason: string; role: string }>;
  token_usage: Record<string, unknown>;
  versions: ExplainPacket["versions"];
  emitted_bytes_sha256?: string;
  receipt_id?: string;
  delivery_state?: string;
}

/**
 * The viewer-facing rendering.
 *
 * `candidates` and `results` must already have been filtered by the selection
 * gate — this function does not re-filter records, it only refuses to leak the
 * suppression list. Callers pass the ADMITTED candidate detail; anything
 * denied on scope should never have reached this function at all.
 */
export function explainFor(input: ExplainInput): ExplainPacket {
  const redactionOff = input.request.disable?.diagnostics_redaction_off === true;
  // With redaction ON (production) the viewer sees only reportable
  // suppressions. With it OFF (the C25 control) the full detail leaks —
  // which is exactly the failure mode A6 exists to catch.
  const visible = redactionOff
    ? input.selection.suppressed_detail
    : input.selection.suppressed_visible.filter((s) => !OPAQUE_REASONS.has(s.reason));

  return {
    query_id: input.query_id,
    query: {
      scope: input.request.query as Record<string, unknown>,
      mode: input.request.mode ?? "strict",
      authorized_digest: authorizedDigest(input.request.authorized),
      principal: input.request.principal,
    },
    versions: input.versions,
    candidates: input.candidates,
    results: input.results,
    suppressed: input.selection.suppressed,
    suppressed_visible: visible,
    omissions: input.omissions,
    outcome: input.selection.outcome,
    ...(input.selection.missing_entitlement ? { missing_entitlement: input.selection.missing_entitlement } : {}),
    token_usage: input.token_usage,
    ...(input.emitted_bytes_sha256 ? { emitted_bytes_sha256: input.emitted_bytes_sha256 } : {}),
    ...(input.receipt_id ? { receipt_id: input.receipt_id } : {}),
    ...(input.delivery_state ? { delivery_state: input.delivery_state } : {}),
    redacted: !redactionOff,
  };
}

/**
 * The operator rendering. Requires `rule` capability in the queried scope;
 * without it the caller gets the viewer rendering, not an error that would
 * itself confirm what exists.
 */
export function explainOperator(input: ExplainInput, opts: { has_rule_capability: boolean }): ExplainPacket {
  if (!opts.has_rule_capability) return explainFor(input);
  return { ...explainFor(input), suppressed_visible: input.selection.suppressed_detail, redacted: false };
}

/**
 * Does this packet name anything the viewer was not authorized to read?
 *
 * The test-side assertion for C25 A6 / C19 A05: serialize the packet and look
 * for any forbidden token. Lives here so the production surface and the test
 * share one definition of "leak".
 */
export function leaksAny(packet: ExplainPacket, forbidden: readonly string[]): string[] {
  const text = JSON.stringify(packet);
  return forbidden.filter((needle) => needle.length > 0 && text.includes(needle));
}
