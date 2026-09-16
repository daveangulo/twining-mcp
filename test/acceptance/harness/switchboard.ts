/**
 * Instrument-can-fail switchboard (lane 05).
 *
 * Every oracle ends with an "Instrument-can-fail controls" section: a list of
 * defects that MUST make a named negative assertion fail. A negative assertion
 * that still passes with its control disabled is not coverage — it is passing
 * for the wrong reason. This module turns that list into flippable switches
 * and `switchboard.test.ts` proves each switch actually breaks something.
 *
 * ## Injection modes — read this before quoting a result
 *
 * Lane 05 does not own `src/**` and must not edit it, so a control cannot be
 * turned off inside the shipped reducer. Each control therefore declares where
 * it injects and what that buys:
 *
 *  - `input`  — the defect is expressible as a difference in what enters the
 *               store, and the real, unmodified pipeline then runs end to end.
 *               A failure here is evidence about the SYSTEM.
 *  - `observe` — the defect lives inside code lane 05 may not edit. The switch
 *               interposes on the assertion's read path and reproduces exactly
 *               what the defective build would have returned, recomputed from
 *               the store's own durable events. A failure here is evidence
 *               about the ASSERTION: it proves the assertion is sensitive to
 *               the defect rather than vacuously true. It is NOT evidence that
 *               the shipped code implements the control — the oracle-derived
 *               slice tests carry that burden.
 *
 * Reporting rule: never quote an `observe` control as proof the system
 * enforces anything. Quote it as proof the test would have caught the defect.
 */
import { EVIDENCE_RANK, type EvidenceClass } from "../../../src/contracts/evidence.js";
import type { EventEnvelope } from "../../../src/contracts/index.js";
import { computeEventDigest, signEvent } from "../../../src/contracts/index.js";
import { scopeMatches, type Scope } from "../../../src/contracts/scope.js";
import type { EventStore } from "../../../src/events/event-store.js";
import { causalOrder, type SliceProjectedRecord } from "../../../src/events/projection.js";
import { mintEventId } from "../../../src/contracts/index.js";
import type { Actor } from "./identity.js";

export const CONTROLS = [
  "scope_filter_off",
  "trust_check_off",
  "dedup_off",
  "byte_preservation_off",
  "class_rank_off",
  "conflict_detection_off",
] as const;
export type Control = (typeof CONTROLS)[number];

export type InjectionMode = "input" | "observe";

export interface ControlSpec {
  control: Control;
  mode: InjectionMode;
  /** The build defect this switch stands for, in the oracles' own words. */
  defect: string;
  /** Where the fidelity of the simulation stops. Stated so a report cannot overclaim. */
  fidelity: string;
}

export const CONTROL_SPECS: Record<Control, ControlSpec> = {
  scope_filter_off: {
    control: "scope_filter_off",
    mode: "observe",
    defect: "Authorization is applied after ranking, or skipped entirely while draining a recovery backlog, so an out-of-scope record reaches the caller's view.",
    fidelity:
      "The store really holds the out-of-scope event (it was delivered over the carrier); the switch only removes the scope predicate from the read, which is precisely the defective build's behaviour. It does not prove the shipped read applies the filter — the C25/C18 scope tests do.",
  },
  trust_check_off: {
    control: "trust_check_off",
    mode: "input",
    defect: "Evidence class is taken from a caller-supplied field instead of being decided by the ingress, so model-authored text can author a human ruling.",
    fidelity:
      "Injected by relabelling the model event `human_ruling` and signing it with a trusted human key. A real defect would skip the signature check as well; this variant is strictly HARDER to detect, so a control failure here is conservative.",
  },
  dedup_off: {
    control: "dedup_off",
    mode: "input",
    defect: "A retry is admitted as a new effect rather than being reconciled by a stable event identity + digest.",
    fidelity:
      "Injected producer-side (the retry re-mints its event id), which is how a system with no stable idempotency key behaves. The consumer-side variant ('admit by arrival even for an identical id+digest') is not reachable without editing the store and is covered in `observe` mode by attemptsFor().",
  },
  byte_preservation_off: {
    control: "byte_preservation_off",
    mode: "input",
    defect: "Export or admission normalizes the payload — BOM stripped, CRLF folded to LF, trailing newline trimmed.",
    fidelity: "Fully end-to-end: the normalized bytes are appended through the real pipeline and the stored bytes, length and digest are read back off disk.",
  },
  class_rank_off: {
    control: "class_rank_off",
    mode: "observe",
    defect: "Lifecycle events apply in arrival order regardless of evidence class, so a lower-class successor supersedes a higher-class record.",
    fidelity:
      "The replacement reducer runs over the store's own admitted events in the store's own causal order; only the class-rank guard is removed. It reproduces the defective projection exactly but is not the shipped reducer.",
  },
  conflict_detection_off: {
    control: "conflict_detection_off",
    mode: "observe",
    defect: "Concurrent equal-class successors are applied last-writer-wins; no conflict is recorded.",
    fidelity: "Same as class_rank_off: a replacement reducer over real admitted events with the concurrency check removed.",
  },
};

export type Switches = Partial<Record<Control, boolean>>;

// ------------------------------------------------------------ input injection

/** Normalize text the way a byte-mangling exporter would. Used by `byte_preservation_off`. */
export function normalizeText(s: string): string {
  return s.replace(/^﻿/, "").replace(/\r\n/g, "\n").replace(/\s+$/, "");
}

function reDigest(ev: Record<string, unknown>, signBy?: Actor): Record<string, unknown> {
  const out = { ...ev };
  delete out.sig;
  delete out.digest;
  out.digest = computeEventDigest(out);
  if (signBy) out.sig = { alg: "ed25519", key: signBy.keyId, value: signEvent(out, signBy.kp.privateKeyPkcs8Pem) };
  return out;
}

export interface InputInjectionContext {
  /** A trusted human actor, needed by `trust_check_off`. */
  human?: Actor;
  /** Payload string fields to normalize under `byte_preservation_off`. */
  textFields?: string[];
}

/**
 * Rewrite an envelope on its way into the store under the flipped switches.
 * Returns the envelope unchanged when no input-mode switch applies.
 */
export function injectInput(
  ev: Record<string, unknown>,
  switches: Switches,
  ctx: InputInjectionContext = {},
): Record<string, unknown> {
  let out = ev;

  if (switches.byte_preservation_off) {
    const payload = { ...(out.payload as Record<string, unknown>) };
    let touched = false;
    for (const f of ctx.textFields ?? Object.keys(payload)) {
      if (typeof payload[f] === "string") {
        const before = payload[f] as string;
        const after = normalizeText(before);
        if (after !== before) {
          payload[f] = after;
          touched = true;
        }
      }
    }
    if (touched) out = reDigest({ ...out, payload });
  }

  if (switches.trust_check_off && out.evidence_class === "model_inference" && ctx.human) {
    out = reDigest({ ...out, evidence_class: "human_ruling" }, ctx.human);
  }

  if (switches.dedup_off) {
    // A producer with no stable idempotency key re-mints on retry. `created`
    // binds the record id to the event id, so both move together.
    const fresh = mintEventId();
    const rec = out.record as { type: string; id: string } | undefined;
    out = reDigest({
      ...out,
      id: fresh,
      ...(rec && out.kind === "created" ? { record: { type: rec.type, id: fresh } } : {}),
    });
  }

  return out;
}

// --------------------------------------------------------- observe injection

/**
 * The record view an assertion reads. With every switch off this delegates to
 * the store; with an observe-mode switch on it returns what the defective
 * build would have returned.
 */
export class Instrument {
  constructor(
    readonly store: EventStore,
    readonly switches: Switches = {},
  ) {}

  /** The applicable view for a scope — the read a caller's retrieval path performs. */
  async view(scope: Scope): Promise<SliceProjectedRecord[]> {
    if (this.switches.scope_filter_off) {
      // Authorization after ranking / skipped: everything the store holds is
      // a candidate, and the scope predicate never runs.
      return this.store.query({});
    }
    return this.store.query({ scope });
  }

  /** The projected record, with the reducer defects applied when switched on. */
  async record(recordId: string): Promise<SliceProjectedRecord | null> {
    const base = await this.store.get(recordId);
    if (!base) return null;
    if (!this.switches.class_rank_off && !this.switches.conflict_detection_off) return base;
    const rebuilt = await this.defectiveReduce();
    return rebuilt.get(recordId) ?? base;
  }

  /**
   * Delivery attempts recorded for an event id. Under `dedup_off` in observe
   * mode this is what a consumer that counts arrivals would report as its
   * admitted-copy count.
   */
  attemptsFor(eventId: string): number {
    return this.store.admissionLog(eventId).filter((r) => r.outcome !== "rejected").length;
  }

  /** Deliveries the store suppressed as duplicates — dedup must be RECORDED, not invisible (R20). */
  suppressedDuplicates(eventId: string): number {
    return this.store.admissionLog(eventId).filter((r) => r.outcome === "duplicate_suppressed").length;
  }

  /**
   * A replacement reducer over the store's own admitted events with the
   * class-rank guard and/or the concurrency check removed. Only the fields the
   * negative assertions read are recomputed.
   */
  private async defectiveReduce(): Promise<Map<string, SliceProjectedRecord>> {
    const admitted = (await this.store.events({})) as EventEnvelope[];
    const ordered = causalOrder(admitted);
    const out = new Map<string, SliceProjectedRecord>();
    for (const rec of await this.store.query({ include_retired: true, include_archived: true })) {
      out.set(rec.record_id, { ...rec, conflicts: [...rec.conflicts], contested: [...rec.contested], superseded_by: [...rec.superseded_by] });
    }
    for (const ev of ordered) {
      const targetId = (ev.payload as { target?: string })?.target;
      if (!targetId) continue;
      const rec = out.get(targetId);
      if (!rec) continue;
      const by = (ev.payload as { by?: string }).by;
      const lower = EVIDENCE_RANK[ev.evidence_class as EvidenceClass] < EVIDENCE_RANK[rec.evidence_class as EvidenceClass];

      if (ev.kind === "superseded") {
        if (lower && !this.switches.class_rank_off) continue; // rank still enforced
        if (this.switches.conflict_detection_off) {
          // last writer wins, silently
          rec.status = "superseded";
          rec.conflicts = [];
          rec.superseded_by = by ? [by] : rec.superseded_by;
          rec.contested = [];
        } else {
          rec.status = "superseded";
          if (by) rec.superseded_by = [...new Set([...rec.superseded_by, by])].sort();
          rec.contested = rec.contested.filter((c) => c.event !== ev.id);
        }
        if (this.switches.class_rank_off) rec.contested = rec.contested.filter((c) => c.event !== ev.id);
      }
    }
    return out;
  }
}

/** All switches off — the honest instrument. */
export const NO_SWITCHES: Switches = {};

/** One switch on, everything else off. */
export function only(control: Control): Switches {
  return { [control]: true };
}
