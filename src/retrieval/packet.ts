/**
 * The required-facts-first context packet (oracles C26, C05 A13/A14, C25 A7;
 * baseline gap 7).
 *
 * ## Order
 *
 * 1. **Governing facts and consumer prerequisites.** Exact records, revision
 *    bound, `role: "required"`. These are what an action is qualified against.
 * 2. **Lessons, counterexamples and no-patch dispositions** (C05): what was
 *    tried, what it cost, and under exactly which conditions the disposition
 *    applies. `role: "optional"`.
 * 3. **Unresolved questions.** `role: "optional"`.
 *
 * Tier 1 is filled first and never yields budget to tier 2 or 3. If a required
 * record does not fit, the packet says so out loud.
 *
 * ## Budget
 *
 * The budget is enforced over the **final emitted bytes**, not over the raw
 * text of the selected items. That is the gap-7 defect precisely: 2.x charges
 * the caller for records the formatter then declines to render, and never
 * charges for the headings, the JSON envelope or the escaping. Here the
 * renderer runs first, the bytes are measured with the declared tokenizer
 * (`tokenizer.ts`), and a record is admitted only if the packet still fits
 * WITH it — headings, separators, manifest and footer included.
 *
 * JSON escaping is NOT included here, because this function does not know the
 * transport. The docstring used to claim it was, which was false: the admission
 * loop measures the plain concatenation. `measureEnvelope` is the wire-level
 * gate, and an emitting path that serializes this packet must call it (the
 * assemble command does, via `annotateEmitted(ctx, briefing, envelope)`).
 *
 * ## Incompleteness is loud
 *
 * When a required record does not fit, `incomplete: true`, the omitted ids and
 * reasons are in the packet the receiving turn reads (not only in a log), and
 * `qualifies_action: false`. There is no "qualified with caveats" (C26 A07).
 */
import { createHash } from "node:crypto";

import { estimate, ACTIVE_TABLE, TOKENIZER_ID, type CalibrationTable } from "./tokenizer.js";
import { renderRecord, renderRecipeForInspection, type RenderableRecord } from "./render.js";

export type PacketRole = "required" | "optional";
export type PacketTier = "governing" | "lesson" | "question";

export interface PacketItem {
  record: RenderableRecord;
  tier: PacketTier;
  role: PacketRole;
  /** Retrieved for inspection only — rendered through the recipe renderer. */
  recipe?: boolean;
  /** Ranking inputs, carried through to the explain packet. Never a filter. */
  score?: number;
  reasons?: string[];
  paths?: string[];
}

export type OmissionReason =
  | "does_not_fit"
  | "formatter_drop"
  | "partial"
  | "unavailable"
  | "scope_denied";

export interface Omission {
  id: string;
  version: string;
  role: PacketRole;
  tier: PacketTier;
  reason: OmissionReason;
}

export interface PacketOptions {
  /** Hard bound on the emitted payload, in tokens of the declared tokenizer. */
  budget_tokens: number;
  table?: CalibrationTable;
  header?: string;
  footer?: string;
  /**
   * Any prerequisite the consumer declared but retrieval could not produce at
   * all (not merely could not fit). These make the packet incomplete too.
   */
  unavailable_required?: Array<{ id: string; version?: string; reason?: string }>;
  /** Freshness verdict for the packet as a whole; `stale`/`unknown` blocks. */
  freshness?: "live" | "stale" | "unknown";
  /** Instrument control: report the packet complete regardless (C05/C26). */
  disable?: { delivery_receipt_accounting_off?: boolean; budget_over_selection?: boolean };
}

export interface Packet {
  /** The exact bytes an emitter sends. The receipt hashes THIS string. */
  text: string;
  /** Everything the selector handed the builder. */
  selected: string[];
  /** What actually made it into `text`. */
  emitted: string[];
  omissions: Omission[];
  incomplete: boolean;
  /**
   * True only when the budget is too small for even the refusal text. The
   * packet then exceeds its budget; saying so out loud is the honest failure.
   */
  budget_infeasible: boolean;
  /**
   * False whenever the packet is incomplete, stale, over its own bound, empty,
   * or carries a required record that cannot itself qualify an action (wrong
   * class, conflicted, retired). Never "yes, but".
   */
  qualifies_action: boolean;
  /** Every reason the verdict is false, including the blocking record ids. */
  qualification_refused_because?: string[];
  /** Required ids that are not in `emitted` — named in the packet body too. */
  missing_required: string[];
  token_usage: {
    budget: number;
    /** Conservative bound over `text`. Always <= budget. */
    emitted_tokens: number;
    tokenizer_id: string;
    table_id: string;
    conservative_fallback: boolean;
    /** Which bound `table_id` is: a proof, or a measurement over a named corpus. */
    table_provenance: CalibrationTable["provenance"];
    /** Per-record cost of what was emitted, for C26 A03's framing arithmetic. */
    per_record: Array<{ id: string; tokens: number }>;
    /** emitted_tokens minus the sum of per_record — headings, manifest, footer. */
    framing_tokens: number;
  };
  emitted_bytes_sha256: string;
}

const TIER_ORDER: Record<PacketTier, number> = { governing: 0, lesson: 1, question: 2 };

function renderItem(item: PacketItem): string {
  return item.recipe ? renderRecipeForInspection(item.record) : renderRecord(item.record);
}

function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex")}`;
}

/**
 * Build the packet.
 *
 * The loop measures the WHOLE candidate payload on every step rather than
 * summing per-item costs. Summing is what lets framing escape the budget: the
 * headings, the separators and the manifest are not attributable to any single
 * record, so a per-item accounting never charges for them. Re-measuring is
 * O(n^2) in the payload size, which is irrelevant at packet scale (tens of
 * records) and is the difference between a bound and an estimate.
 */
export function buildPacket(items: readonly PacketItem[], opts: PacketOptions): Packet {
  const table = opts.table ?? ACTIVE_TABLE;
  const ordered = [...items].sort((a, b) => {
    const t = TIER_ORDER[a.tier] - TIER_ORDER[b.tier];
    if (t !== 0) return t;
    // Required before optional inside a tier, then by descending score.
    if (a.role !== b.role) return a.role === "required" ? -1 : 1;
    return (b.score ?? 0) - (a.score ?? 0);
  });

  const selected = ordered.map((i) => i.record.id);
  const requiredIds = ordered.filter((i) => i.role === "required").map((i) => i.record.id);

  const header = opts.header ?? "";
  const footer = opts.footer ?? "";

  const emittedItems: PacketItem[] = [];
  const omissions: Omission[] = [];

  /** Assemble the payload for a given item set, including the manifest. */
  const assemble = (set: PacketItem[], omitted: Omission[], missing: string[]): string => {
    const parts: string[] = [];
    if (header) parts.push(header);
    if (missing.length > 0) {
      parts.push(
        [
          "## INCOMPLETE PACKET",
          `Required records missing from this packet: ${missing.join(", ")}.`,
          "No action may be qualified from this packet until they are present.",
        ].join("\n"),
      );
    }
    const byTier = (t: PacketTier): PacketItem[] => set.filter((i) => i.tier === t);
    const gov = byTier("governing");
    const les = byTier("lesson");
    const qs = byTier("question");
    if (gov.length > 0) parts.push(["## GOVERNING FACTS AND PREREQUISITES", ...gov.map(renderItem)].join("\n\n"));
    if (les.length > 0) parts.push(["## LESSONS, COUNTEREXAMPLES AND DISPOSITIONS", ...les.map(renderItem)].join("\n\n"));
    if (qs.length > 0) parts.push(["## UNRESOLVED QUESTIONS", ...qs.map(renderItem)].join("\n\n"));
    if (omitted.length > 0) {
      parts.push(
        [
          "## OMITTED FROM THIS PACKET",
          ...omitted.map((o) => `- ${o.id}@${o.version} (${o.role}, ${o.tier}) — ${o.reason}`),
        ].join("\n"),
      );
    }
    if (footer) parts.push(footer);
    return parts.join("\n\n");
  };

  // Required prerequisites retrieval could not produce at all. They are
  // omissions before the budget is even consulted.
  const unavailable = opts.unavailable_required ?? [];
  for (const u of unavailable) {
    omissions.push({
      id: u.id,
      version: u.version ?? "unknown",
      role: "required",
      tier: "governing",
      reason: "unavailable",
    });
  }

  const missingSoFar = (): string[] => [
    ...unavailable.map((u) => u.id),
    ...requiredIds.filter((id) => !emittedItems.some((e) => e.record.id === id)),
  ];

  for (const item of ordered) {
    const candidate = [...emittedItems, item];
    // The omission list and the missing-required banner are themselves part of
    // the payload, so they must be inside the measurement. Assume the worst
    // case for the tail (everything not yet placed is omitted) — that can only
    // overstate, and overstating is the safe direction for a bound.
    const worstCaseOmissions: Omission[] = [
      ...omissions,
      ...ordered
        .filter((o) => !candidate.includes(o))
        .map((o) => ({
          id: o.record.id,
          version: o.record.version,
          role: o.role,
          tier: o.tier,
          reason: "does_not_fit" as OmissionReason,
        })),
    ];
    const worstCaseMissing = [
      ...unavailable.map((u) => u.id),
      ...requiredIds.filter((id) => !candidate.some((c) => c.record.id === id)),
    ];
    const trial = assemble(candidate, worstCaseOmissions, worstCaseMissing);
    if (estimate(trial, table).tokens <= opts.budget_tokens) {
      emittedItems.push(item);
    } else {
      omissions.push({
        id: item.record.id,
        version: item.record.version,
        role: item.role,
        tier: item.tier,
        reason: "does_not_fit",
      });
    }
  }

  let missing = missingSoFar();
  let text = assemble(emittedItems, omissions, missing);
  let est = estimate(text, table);
  let budgetInfeasible = false;

  // The framing is not free. When nothing fits, the banner and the omission
  // manifest can themselves exceed the budget — and emitting them anyway would
  // break the bound the budget exists to be. C26 §6 accepts a second terminal
  // shape for exactly this: `refused_incomplete`, nothing emitted plus an
  // explicit incompleteness report. Fall back to the shortest honest refusal.
  if (est.tokens > opts.budget_tokens) {
    emittedItems.length = 0;
    for (const i of ordered) {
      if (!omissions.some((o) => o.id === i.record.id)) {
        omissions.push({ id: i.record.id, version: i.record.version, role: i.role, tier: i.tier, reason: "does_not_fit" });
      }
    }
    text = `REFUSED: no record fits a ${opts.budget_tokens}-token budget (${TOKENIZER_ID}). ${omissions.length} record(s) omitted; see omissions.`;
    est = estimate(text, table);
    // Even the refusal can overflow an absurdly small budget. Say so rather
    // than silently exceeding it — an honest overflow beats an invisible one.
    if (est.tokens > opts.budget_tokens) budgetInfeasible = true;
    missing = missingSoFar();
  }

  // Per-record costs, for C26 A03's framing arithmetic. Measured over the
  // rendered record in isolation, so the difference from the total is exactly
  // the framing — which is the point of reporting it.
  const perRecord = emittedItems.map((i) => ({
    id: i.record.id,
    tokens: estimate(renderItem(i), table).tokens - table.envelope_overhead_tokens,
  }));
  const bodySum = perRecord.reduce((a, b) => a + b.tokens, 0);

  const incomplete = opts.disable?.delivery_receipt_accounting_off
    ? false
    : missing.length > 0 || omissions.some((o) => o.role === "required");
  const stale = opts.freshness === "stale" || opts.freshness === "unknown";

  // The verdict must read the RECORDS, not just the packet's shape.
  //
  // `!incomplete && !stale` consulted completeness and packet-level freshness
  // only, so a packet whose sole required governing record was conflicted,
  // superseded or `legacy_unverified` reported that it qualified an action —
  // while `renderRecord` printed "qualifies an action: no" for that same record
  // two lines above. The structured flag and the rendered text disagreed, and a
  // consumer reads the flag.
  const blocking = emittedItems
    .filter((i) => i.role === "required")
    .filter((i) => !i.record.lifecycle.authorizes_action || i.record.lifecycle.conflicts.length > 0)
    .map((i) => i.record.id);

  // A packet that carried no evidence cannot qualify anything, and one that
  // broke its own bound says so in the verdict rather than only in a sibling.
  const carriedEvidence = emittedItems.length > 0;
  const qualifies = !incomplete && !stale && !budgetInfeasible && carriedEvidence && blocking.length === 0;

  const refusedBecause: string[] = [];
  if (incomplete) refusedBecause.push("incomplete: a required record is missing");
  if (stale) refusedBecause.push(`freshness_${opts.freshness}`);
  if (budgetInfeasible) refusedBecause.push("budget_infeasible: the packet exceeded its own budget");
  if (!carriedEvidence) refusedBecause.push("no_records_emitted");
  for (const id of blocking) refusedBecause.push(`record_cannot_qualify:${id}`);

  return {
    text,
    selected,
    emitted: emittedItems.map((i) => i.record.id),
    omissions,
    incomplete,
    budget_infeasible: budgetInfeasible,
    qualifies_action: qualifies,
    ...(refusedBecause.length > 0 ? { qualification_refused_because: refusedBecause } : {}),
    missing_required: missing,
    token_usage: {
      budget: opts.budget_tokens,
      emitted_tokens: est.tokens,
      tokenizer_id: TOKENIZER_ID,
      table_id: table.id,
      table_provenance: table.provenance,
      conservative_fallback: est.conservative_fallback,
      per_record: perRecord,
      framing_tokens: est.tokens - bodySum,
    },
    emitted_bytes_sha256: sha256(text),
  };
}

/**
 * Budget accounting over the JSON envelope a tool actually returns.
 *
 * `buildPacket` bounds the packet text. A tool that wraps it in JSON pays for
 * the escaping and the sibling fields too, and gap 7 shows 2.x never did. Call
 * this with the serialized response to get the number that belongs in the
 * receipt.
 */
export function measureEnvelope(json: string, table: CalibrationTable = ACTIVE_TABLE): {
  tokens: number;
  tokenizer_id: string;
  table_id: string;
  table_provenance: CalibrationTable["provenance"];
  bytes: number;
} {
  const est = estimate(json, table);
  return {
    tokens: est.tokens,
    tokenizer_id: TOKENIZER_ID,
    table_id: table.id,
    table_provenance: table.provenance,
    bytes: est.bytes,
  };
}
