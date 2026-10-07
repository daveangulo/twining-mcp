/**
 * Lifecycle states, as READ by retrieval (ADR §4, §6; oracles C05 A3/A15,
 * C19 A04/A11, C25 A15, C26 A16).
 *
 * This module deliberately contains **no** lifecycle logic. Every state comes
 * out of `src/events/projection.ts`, the deterministic reducer lane 02 owns.
 * Retrieval's job is to name what the resolver already decided and to refuse
 * to paper over it:
 *
 *  - no last-write-wins anywhere (the reducer orders causally, never by clock);
 *  - a conflicted record is RETURNED as conflicted, never silently resolved to
 *    one side and never hidden (ADR §4.3 rule 3);
 *  - a conflicted or contested record cannot qualify an action.
 *
 * The 2.x adapter below maps the legacy `status` string onto the same
 * vocabulary, and stamps `resolver: "legacy-status-field"` so a reader can
 * tell a resolver-derived state from a status column that a writer set.
 */
import {
  currentUseClaim,
  correctionFor,
  RETIRED_STATUSES,
  ACTIONABLE_RANK,
  type SliceProjectedRecord,
} from "../events/projection.js";
import { EVIDENCE_RANK, type EvidenceClass } from "../contracts/evidence.js";
import type { Scope } from "../contracts/scope.js";

export { currentUseClaim, correctionFor, RETIRED_STATUSES, ACTIONABLE_RANK };

/**
 * The retrieval-facing lifecycle vocabulary. These are not new states: each is
 * a name for a combination the reducer already produced.
 */
export type LifecycleState =
  | "current"
  | "provisional"
  | "conflicted"
  | "contested"
  | "superseded"
  | "overridden"
  | "revoked"
  | "retracted"
  | "tombstoned"
  | "archived"
  | "resolved"
  | "acknowledged"
  | "restored_applicable"
  | "historical"
  | "unknown";

export interface LifecycleView {
  state: LifecycleState;
  /** Where the state came from. Honest about the 2.x approximation. */
  resolver: "event-projection" | "legacy-status-field";
  /** Part of the current applicable view? */
  applicable: boolean;
  /** Live contradictions this record is a member of (ADR §4.3 rule 3). */
  conflicts: readonly string[];
  /** Refused claims carried beside the record as annotations, never as state. */
  contested: readonly string[];
  /** Evidence class, exactly as the ingress stamped it. Never re-derived. */
  evidence_class: EvidenceClass | "legacy_unverified";
  /** Rank >= ACTIONABLE_RANK AND applicable AND unconflicted. */
  authorizes_action: boolean;
  archived: boolean;
  archived_from?: string;
}

/**
 * Name the state a projected record is in. Reads projection output only.
 *
 * `archived` is reported as a FLAG beside the lifecycle status, never as a
 * replacement for it (ADR §4.4) — so a superseded-then-archived record reads
 * `superseded` + `archived: true` and restoring it cannot invent an `active`.
 */
export function classify(rec: SliceProjectedRecord): LifecycleView {
  const base: LifecycleState = (() => {
    switch (rec.status) {
      case "active":
        return "current";
      case "provisional":
        return "provisional";
      case "conflicted":
        return "conflicted";
      case "contested":
        return "contested";
      case "superseded":
        return "superseded";
      case "overridden":
        return "overridden";
      case "revoked":
        return "revoked";
      case "retracted":
        return "retracted";
      case "tombstoned":
        return "tombstoned";
      case "resolved":
        return "resolved";
      case "acknowledged":
        return "acknowledged";
      case "restored_applicable":
        return "restored_applicable";
      case "open":
      case "pending":
        return "current";
      default:
        return "unknown";
    }
  })();

  return {
    state: base,
    resolver: "event-projection",
    applicable: rec.applicable,
    conflicts: rec.conflicts,
    contested: rec.contested.map((c) => c.event),
    evidence_class: rec.evidence_class,
    // A conflicted record cannot qualify an action even when the reducer's own
    // `authorizes_action` says the class is high enough: two authorized
    // statements disagree and retrieval refuses rather than picking (R05, C11).
    authorizes_action: rec.authorizes_action && rec.conflicts.length === 0,
    archived: rec.archived,
    ...(rec.archived_from ? { archived_from: rec.archived_from } : {}),
  };
}

/**
 * May this record qualify `action` at coordinate `at`?
 *
 * Delegates to the reducer's `currentUseClaim` and then applies retrieval's
 * own two extra refusals, both of which are about the PACKET rather than the
 * record: an inference-class lead never qualifies (C05 A8, C25 A12), and a
 * record delivered inside an incomplete packet never qualifies (C26 A07) —
 * the latter is enforced in `packet.ts`, which owns the packet.
 */
export function qualifies(
  rec: SliceProjectedRecord,
  at: Scope,
): { ok: boolean; reason?: string; missing_required?: string[] } {
  const claim = currentUseClaim(rec, at);
  if (!claim.ok) {
    if (claim.reason === "insufficient_evidence_class") {
      return {
        ok: false,
        reason: "evidence_class_insufficient",
        missing_required: [
          `a record with evidence_class of rank >= ${ACTIONABLE_RANK} (human_ruling or verified_observation); this record is ${rec.evidence_class} (rank ${EVIDENCE_RANK[rec.evidence_class]})`,
        ],
      };
    }
    return { ok: false, reason: claim.reason };
  }
  if (rec.conflicts.length > 0) return { ok: false, reason: "conflicted" };
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Freshness (ADR §6)                                                   */
/* ------------------------------------------------------------------ */

export type Freshness = "live" | "stale" | "unknown";

export interface FreshnessView {
  state: Freshness;
  /** Seconds since the observation, when one exists. */
  age_seconds?: number;
  /** Why the state is `unknown`. Never a guess, never a cached value as live. */
  reason?: string;
}

/**
 * Freshness of a volatile fact (ADR §6 rows 3–5).
 *
 * A local branch read, a file existence test or an index refresh is NOT a live
 * check (R12): callers pass `observed` only for a real `verified_observation`.
 * With no observation the answer is `unknown` — never the last-known value
 * dressed as current (C01 A05/A06, C19 A18).
 */
export function freshness(opts: {
  observed_at?: string;
  now: number;
  max_age_seconds?: number;
  source_available?: boolean;
  unavailable_reason?: string;
}): FreshnessView {
  if (opts.source_available === false) {
    return { state: "unknown", reason: opts.unavailable_reason ?? "source_unavailable" };
  }
  if (!opts.observed_at) return { state: "unknown", reason: "never_observed" };
  const t = Date.parse(opts.observed_at);
  if (Number.isNaN(t)) return { state: "unknown", reason: "unparseable_observation_time" };
  const age = Math.max(0, Math.floor((opts.now - t) / 1000));
  if (opts.max_age_seconds === undefined) return { state: "stale", age_seconds: age, reason: "no_max_age_policy" };
  return age <= opts.max_age_seconds
    ? { state: "live", age_seconds: age }
    : { state: "stale", age_seconds: age, reason: "older_than_max_age" };
}

/* ------------------------------------------------------------------ */
/* 2.x adapter                                                          */
/* ------------------------------------------------------------------ */

/** 2.x decision statuses, as written by `src/engine/decisions.ts`. */
export type LegacyStatus =
  | "active"
  | "provisional"
  | "superseded"
  | "overridden"
  | "archived"
  | string;

/**
 * Map a 2.x status column onto the same vocabulary.
 *
 * The 2.x store has no evidence classes: everything a 2.x client wrote is an
 * unauthenticated agent assertion, which is exactly `legacy_unverified`
 * (ADR §7, migration ingress). So NO 2.x record authorizes an action — the
 * honest answer, and the one that stops a 2.x briefing from reading as a set
 * of rulings (gap 6, render side).
 */
export function classifyLegacy(status: LegacyStatus): LifecycleView {
  const map: Record<string, LifecycleState> = {
    active: "current",
    provisional: "provisional",
    superseded: "superseded",
    overridden: "overridden",
    archived: "current",
    resolved: "resolved",
  };
  const state = map[status] ?? "unknown";
  const archived = status === "archived";
  const applicable = !RETIRED_STATUSES.has(status) && state !== "unknown";
  return {
    state,
    resolver: "legacy-status-field",
    applicable,
    conflicts: [],
    contested: [],
    evidence_class: "legacy_unverified",
    // rank(legacy_unverified) = 2 < ACTIONABLE_RANK (4). Always false.
    authorizes_action: false,
    archived,
  };
}
