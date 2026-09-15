/**
 * The deterministic reducer (ADR §1.1 "Projection", §4.3 precedence, §12).
 *
 * Pure: a set of admitted event envelopes in, a map of projected records out.
 * Nothing here reads the clock, the filesystem or the database, so two
 * replicas holding the same admitted set produce byte-identical projections
 * and `rebuild()` reproduces them exactly (C09 A22, C10 A18, C11 A08/A18,
 * C14 A-CUR9, C16 A3.6/A3.7).
 *
 * Order is CAUSAL: parents before children, ties broken by event id. ULID
 * order is used for the tie-break only — never for precedence (R05).
 */
import type { EventEnvelope } from "../contracts/event.js";
import type { ProjectedRecord } from "../contracts/store-api.js";
import type { Scope } from "../contracts/scope.js";
import { scopeGoverns } from "../contracts/scope.js";
import { EVIDENCE_RANK, successorMayApply, type EvidenceClass } from "../contracts/evidence.js";
import { CLASS_RANKED_KINDS } from "../contracts/lifecycle.js";
import { digestOf } from "../contracts/canonical.js";

/**
 * Statuses that are NOT part of the current applicable view.
 *
 * `contested` is here because of the lead's conflict-1 ruling: a lower-class
 * successor's claim is an annotation carried in history and explain packets,
 * never a member of `current()` and never a change to the governing record's
 * conflict state (C11 A05, C09 A12/N8). The oracles' own name for this status
 * is `claim_rejected` (C11 A04); appendix B C11-D2 maps it onto `contested`.
 */
export const RETIRED_STATUSES = new Set([
  "superseded",
  "overridden",
  "revoked",
  "retracted",
  "tombstoned",
  "contested",
]);

/**
 * Classes that can qualify an action. A reported_result or a human_statement
 * proves someone said something, not that it is so (ADR §2.2), so the bar for
 * `authorizes_action` is rank >= 4: human_ruling and verified_observation.
 */
export const ACTIONABLE_RANK = 4;

export interface ProjectedPart {
  part_id: string;
  text: string;
  status: string;
  superseded_by?: string;
  authorizing_event?: string;
}

export interface Correction {
  /** The `corrected` event that carried this correction. */
  event: string;
  applies_to: Scope;
  correction: Record<string, unknown>;
  by: string;
  reason?: string;
}

/**
 * A refused claim, carried beside the governing record as an ANNOTATION
 * (ADR §4.3 rule 1 as reworded by the lead): visible in history and explain
 * output, never a member of the applicable view, never a change to the
 * governing record's `conflicts`.
 */
export interface ContestedAnnotation {
  /** The lifecycle event whose claim was refused. */
  event: string;
  kind: string;
  /** The record that made the claim, when the kind names one. */
  claimant?: string;
  reason: string;
  claimed_class: EvidenceClass;
  target_class: EvidenceClass;
}

/**
 * A projected record. Extends the contract's ProjectedRecord (a subtype, so
 * `EventStore` stays satisfied) with the fields the oracles read: parts,
 * scoped corrections, refused claims, and the archive flag that keeps
 * "archived" from collapsing into the lifecycle status (C16 A2.1/A2.2).
 */
export interface SliceProjectedRecord extends ProjectedRecord {
  /** Principal that produced the `created` event. */
  producer: string;
  /** `occurred_at` of the created event — informational, never an ordering input. */
  created_at: string;
  archived: boolean;
  /** The status remembered at the moment of archival (derived, never guessed). */
  archived_from?: string;
  revoked: boolean;
  applicable: boolean;
  authorizes_action: boolean;
  superseded_by: string[];
  overridden_by?: string;
  parts?: ProjectedPart[];
  corrections: Correction[];
  /** Refused claims against this record — annotations, not conflict membership. */
  contested: ContestedAnnotation[];
  commits: string[];
  note?: string;
}

interface Mutable extends Omit<SliceProjectedRecord, "version_digest" | "applicable" | "authorizes_action"> {
  /** Lifecycle events that actually APPLIED a supersession, for concurrency tests. */
  supersession_events: string[];
}

export interface ProjectionResult {
  records: Map<string, SliceProjectedRecord>;
  conflicts: number;
  /** sha256 over every projected record, sorted by record id (ADR §12 step 6). */
  digest: string;
}

/** Parents before children; ties by event id. Events with absent parents sort by id. */
export function causalOrder(events: EventEnvelope[]): EventEnvelope[] {
  const byId = new Map(events.map((e) => [e.id, e]));
  const indeg = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const e of events) {
    let n = 0;
    for (const p of e.parents ?? []) {
      if (!byId.has(p)) continue; // a parent outside this set cannot order anything
      n += 1;
      const list = children.get(p);
      if (list) list.push(e.id);
      else children.set(p, [e.id]);
    }
    indeg.set(e.id, n);
  }
  const ready = [...indeg.entries()].filter(([, n]) => n === 0).map(([id]) => id).sort();
  const out: EventEnvelope[] = [];
  while (ready.length > 0) {
    const id = ready.shift() as string;
    out.push(byId.get(id) as EventEnvelope);
    for (const child of (children.get(id) ?? []).slice().sort()) {
      const n = (indeg.get(child) ?? 0) - 1;
      indeg.set(child, n);
      if (n === 0) {
        // keep `ready` sorted so the tie-break is by id, not by discovery
        const at = ready.findIndex((x) => x > child);
        if (at === -1) ready.push(child);
        else ready.splice(at, 0, child);
      }
    }
  }
  if (out.length !== events.length) {
    // A parent cycle would strand events; emit the stragglers in id order so a
    // projection is still produced (admission rejects cycles before this).
    const seen = new Set(out.map((e) => e.id));
    for (const e of [...events].sort((a, b) => (a.id < b.id ? -1 : 1))) if (!seen.has(e.id)) out.push(e);
  }
  return out;
}

/** Is `a` a causal descendant of `b` (a path a → … → b through parents)? */
export function descendsFrom(a: string, b: string, byId: Map<string, EventEnvelope>): boolean {
  const seen = new Set<string>();
  const stack = [...(byId.get(a)?.parents ?? [])];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (cur === b) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    stack.push(...(byId.get(cur)?.parents ?? []));
  }
  return false;
}

function defaultStatus(recordType: string, body: Record<string, unknown>): string {
  if (recordType === "decision") return (body.status as string) === "provisional" ? "provisional" : "active";
  if (recordType === "post") return "open";
  if (recordType === "handoff") return "pending";
  return "active";
}

/**
 * May this record qualify an action at `at`? (ADR §6, R12.)
 *
 * Refusal is the default when the answer is not knowable: a revision-bound
 * record asked about a different head is `stale_revision`, never silently
 * requalified by identical bytes at another revision (C14 N5).
 */
export function currentUseClaim(rec: SliceProjectedRecord, at: Scope): { ok: boolean; reason?: string } {
  if (!rec.applicable) return { ok: false, reason: `status_${rec.status}` };
  if (rec.archived) return { ok: false, reason: "archived" };
  if (rec.conflicts.length > 0) return { ok: false, reason: "conflicted" };
  if (!rec.authorizes_action) return { ok: false, reason: "insufficient_evidence_class" };
  if (!scopeGoverns(rec.scope, at)) {
    const ruleHead = rec.scope.revision?.head;
    if (ruleHead !== undefined && at.revision?.head !== ruleHead) return { ok: false, reason: "stale_revision" };
    return { ok: false, reason: "out_of_scope" };
  }
  return { ok: true };
}

/** The correction that governs `scope`, if any (C09 A5/A10/A15: per-scope status). */
export function correctionFor(record: SliceProjectedRecord, scope: Scope): Correction | undefined {
  return record.corrections.find((c) => scopeGoverns(c.applies_to, scope));
}

export function projectEvents(admitted: EventEnvelope[]): ProjectionResult {
  const ordered = causalOrder(admitted);
  const byId = new Map(ordered.map((e) => [e.id, e]));
  const recs = new Map<string, Mutable>();

  const touch = (rec: Mutable, ev: EventEnvelope): void => {
    rec.history.push(ev.id);
    rec.version = ev.id;
  };

  for (const ev of ordered) {
    if (ev.kind === "receipt") continue; // receipts are delivery evidence, not records
    const recordId = ev.record?.id;
    if (!recordId) continue;

    if (ev.kind === "created") {
      const body = { ...(ev.payload as Record<string, unknown>) };
      const partsBody = Array.isArray(body.parts) ? (body.parts as Array<{ part_id: string; text: string }>) : undefined;
      recs.set(recordId, {
        record_id: recordId,
        record_type: ev.record?.type ?? "decision",
        body,
        status: defaultStatus(ev.record?.type ?? "decision", body),
        evidence_class: ev.evidence_class,
        scope: ev.scope,
        producer: ev.producer.principal,
        created_at: ev.occurred_at,
        version: ev.id,
        conflicts: [],
        history: [ev.id],
        archived: false,
        revoked: false,
        superseded_by: [],
        parts: partsBody?.map((p) => ({ part_id: p.part_id, text: p.text, status: "applicable" })),
        corrections: [],
        contested: [],
        commits: [],
        supersession_events: [],
        ...(ev.legacy ? { legacy: { derived_from_legacy_snapshot: ev.legacy.derived_from_legacy_snapshot, ...(ev.legacy.legacy_ambiguity ? { legacy_ambiguity: ev.legacy.legacy_ambiguity } : {}) } } : {}),
      });
      continue;
    }

    const rec = recs.get(recordId);
    if (!rec) continue; // admission guarantees the target exists; be defensive anyway
    const p = ev.payload as Record<string, unknown>;

    // Rule 1 of ADR §4.3: a lower-class successor never applies. It is admitted
    // and retained, but as a contested ANNOTATION beside the governing record.
    //
    // `reinstated` is ranked against the SUPERSEDING event's class, not the
    // record's own (lead ruling C14-D11): undoing a supersession needs at least
    // the authority that made it. The highest-ranked supersession wins that
    // comparison, so a low-class reinstatement cannot unpick a high-class one.
    if (CLASS_RANKED_KINDS.has(ev.kind)) {
      const against: EvidenceClass =
        ev.kind === "reinstated"
          ? (rec.supersession_events
              .map((e) => byId.get(e)?.evidence_class as EvidenceClass)
              .filter(Boolean)
              .sort((a, b) => EVIDENCE_RANK[b] - EVIDENCE_RANK[a])[0] ?? rec.evidence_class)
          : rec.evidence_class;
      if (!successorMayApply(against, ev.evidence_class)) {
        touch(rec, ev);
        const claimant = (p.by as string | undefined) ?? (p.replacement as string | undefined);
        const verb = ev.kind === "corrected" ? "correct" : ev.kind === "reinstated" ? "reinstate_over" : "supersede";
        rec.contested.push({
          event: ev.id,
          kind: ev.kind,
          ...(claimant ? { claimant } : {}),
          reason: `lower_evidence_class_cannot_${verb}_${against}`,
          claimed_class: ev.evidence_class,
          target_class: against,
        });
        // The record that MADE the refused claim leaves the applicable view
        // (C11 A05): a refused claim is not a live statement about the scope.
        if (claimant) {
          const cl = recs.get(claimant);
          if (cl && !RETIRED_STATUSES.has(cl.status)) {
            cl.status = "contested";
            cl.history.push(ev.id);
          }
        }
        continue;
      }
    }

    switch (ev.kind) {
      case "promoted": {
        touch(rec, ev);
        if (rec.status === "provisional") rec.status = "active";
        break;
      }
      case "reconsidered": {
        touch(rec, ev);
        if (rec.status === "active") rec.status = "provisional";
        break;
      }
      case "superseded": {
        touch(rec, ev);
        const by = p.by as string;
        const parts = p.parts as string[] | undefined;
        if (parts && rec.parts) {
          for (const partId of parts) {
            const part = rec.parts.find((x) => x.part_id === partId);
            if (!part) continue;
            part.status = "superseded";
            part.superseded_by = by;
            part.authorizing_event = ev.id;
          }
          if (rec.parts.every((x) => x.status !== "applicable")) {
            rec.status = "superseded";
            rec.superseded_by.push(by);
          }
          break;
        }
        // Whole-record supersession. Two successors with no causal path
        // between them are concurrent; equal class → both stay applicable and
        // the record is explicitly conflicted (ADR §4.3 rule 3, C11 rule_C).
        const concurrent = rec.supersession_events.filter(
          (prior) => !descendsFrom(ev.id, prior, byId) && !descendsFrom(prior, ev.id, byId),
        );
        const equalClass = concurrent.filter((prior) => EVIDENCE_RANK[byId.get(prior)?.evidence_class as EvidenceClass] === EVIDENCE_RANK[ev.evidence_class]);
        rec.supersession_events.push(ev.id);
        if (equalClass.length > 0) {
          rec.status = "conflicted";
          const rivals = equalClass.map((e) => (byId.get(e)?.payload as Record<string, unknown>)?.by as string).filter(Boolean);
          rec.conflicts = [...new Set([...rec.conflicts, ...rivals, by])].sort();
          rec.superseded_by = [...new Set([...rec.superseded_by, ...rivals, by])].sort();
        } else {
          rec.status = "superseded";
          rec.superseded_by = [...new Set([...rec.superseded_by, by])];
        }
        break;
      }
      case "overridden": {
        touch(rec, ev);
        rec.status = "overridden";
        if (typeof p.replacement === "string") rec.overridden_by = p.replacement;
        break;
      }
      case "corrected": {
        touch(rec, ev);
        rec.corrections.push({
          event: ev.id,
          applies_to: p.applies_to as Scope,
          correction: p.correction as Record<string, unknown>,
          by: ev.producer.principal,
          ...(typeof p.reason === "string" ? { reason: p.reason } : {}),
        });
        break;
      }
      case "contested": {
        // An explicit annotation only. It does NOT set the target's conflict
        // state — §4.3.3 reserves `conflicted` for equal-class concurrents
        // (lead ruling, conflict 1; C09 A12/N8).
        touch(rec, ev);
        rec.contested.push({
          event: ev.id,
          kind: "contested",
          claimant: p.by as string,
          reason: (p.reason as string) ?? "contested",
          claimed_class: ev.evidence_class,
          target_class: rec.evidence_class,
        });
        break;
      }
      case "reinstated": {
        // The only path back from supersession/override (ADR §4.1, C14 P1).
        touch(rec, ev);
        // …and never a path back from revocation or a tombstone: ADR §4.4 and
        // C14 N2 / C16 N6 make withdrawn authority unrecoverable by any
        // restoration verb. The refusal is recorded, never silent.
        if (rec.revoked || rec.status === "tombstoned" || rec.status === "retracted") {
          rec.contested.push({
            event: ev.id,
            kind: "reinstated",
            reason: `withdrawn_authority_cannot_be_reinstated (${rec.status})`,
            claimed_class: ev.evidence_class,
            target_class: rec.evidence_class,
          });
          break;
        }
        rec.status = "restored_applicable";
        // Its successors are still applicable, so the pair is a live
        // contradiction between two authorized statements: §4.3.3 conflict.
        const rivals = rec.superseded_by.filter((id) => {
          const s = recs.get(id);
          return s !== undefined && !RETIRED_STATUSES.has(s.status);
        });
        rec.conflicts = [...new Set([...rec.conflicts, ...rivals])].sort();
        for (const rival of rivals) {
          const s = recs.get(rival);
          if (!s) continue;
          s.conflicts = [...new Set([...s.conflicts, rec.record_id])].sort();
          s.history.push(ev.id);
        }
        break;
      }
      case "conflict_resolved": {
        touch(rec, ev);
        const winner = p.winner as string;
        const losers = (p.losers as string[]) ?? [];
        rec.conflicts = [];
        rec.status = "superseded";
        rec.superseded_by = [winner];
        for (const loser of losers) {
          const lr = recs.get(loser);
          if (!lr || lr.record_id === winner) continue;
          lr.status = "overridden";
          lr.overridden_by = winner;
          lr.history.push(ev.id);
        }
        break;
      }
      case "archived": {
        touch(rec, ev);
        if (!rec.archived) {
          rec.archived = true;
          rec.archived_from = rec.status; // remembered, never guessed (ADR §4.4)
        }
        break;
      }
      case "restored": {
        touch(rec, ev);
        // Un-archive only. The lifecycle status was never overwritten by the
        // archive, so a revoked record stays revoked and a superseded record
        // stays superseded (ADR §4.4, C16 A3.1/N6).
        rec.archived = false;
        break;
      }
      case "resolved": {
        touch(rec, ev);
        rec.status = "resolved";
        if (typeof p.note === "string") rec.note = p.note;
        break;
      }
      case "acknowledged": {
        touch(rec, ev);
        rec.status = "acknowledged";
        break;
      }
      case "amended": {
        touch(rec, ev);
        const addF = (p.add_affected_files as string[]) ?? [];
        const addS = (p.add_affected_symbols as string[]) ?? [];
        const files = new Set([...(((rec.body.affected_files as string[]) ?? [])), ...addF]);
        const syms = new Set([...(((rec.body.affected_symbols as string[]) ?? [])), ...addS]);
        rec.body = { ...rec.body, affected_files: [...files].sort(), affected_symbols: [...syms].sort() };
        break;
      }
      case "commit_linked": {
        touch(rec, ev);
        rec.commits = [...new Set([...rec.commits, p.commit as string])].sort();
        break;
      }
      case "retracted": {
        touch(rec, ev);
        rec.status = "retracted";
        break;
      }
      case "revoked": {
        touch(rec, ev);
        rec.status = "revoked";
        rec.revoked = true; // permanent: no later event returns authority
        break;
      }
      case "tombstoned": {
        touch(rec, ev);
        rec.status = "tombstoned";
        rec.body = {};
        break;
      }
      default:
        break;
    }
  }

  const records = new Map<string, SliceProjectedRecord>();
  let conflicts = 0;
  for (const [id, m] of [...recs.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const { supersession_events: _drop, ...rest } = m;
    const applicable = !RETIRED_STATUSES.has(m.status);
    const authorizes_action =
      applicable && !m.archived && !m.revoked && EVIDENCE_RANK[m.evidence_class] >= ACTIONABLE_RANK && m.status !== "provisional";
    const withoutDigest: Omit<SliceProjectedRecord, "version_digest"> = { ...rest, applicable, authorizes_action };
    const record: SliceProjectedRecord = { ...withoutDigest, version_digest: digestOf(withoutDigest) };
    if (record.conflicts.length > 0) conflicts += 1;
    records.set(id, record);
  }
  return { records, conflicts, digest: digestOf([...records.values()]) };
}
