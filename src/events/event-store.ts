/**
 * EventStore — the local replica (lane 02, ADR §§1, 4, 5, 8, 11, 12).
 *
 * Durable truth is the event files under `.twining/events/<yyyy-mm>/<ulid>.json`.
 * `<twiningDir>/store/events.db` is a derived journal + admission log +
 * projection + outbox that can be deleted at any time and rebuilt from the
 * files (`rebuild()`), which is the whole point of ADR §12 step 6.
 *
 * Three boundaries are kept strictly apart, because R08/C10/C14 forbid
 * collapsing them:
 *   - the LOCAL ladder (local_persisted | received | pending_parents |
 *     admitted | quarantined | rejected | projected) lives on the journal row;
 *   - the TRANSFER ladder (exported | transferred, per transport, with attempts
 *     and ack uncertainty) lives on outbox rows;
 *   - task acceptance is not modelled here at all — nothing in this file can
 *     produce it, which is how "an ack is never acceptance" is enforced rather
 *     than asserted.
 */
import fs from "node:fs";
import path from "node:path";

import { atomicWriteFileSync, ensureDir } from "../storage/file-store.js";
import {
  computeEventDigest,
  digestOf,
  eventEnvelopeSchema,
  pathCovers,
  scopeGoverns,
  scopeMatches,
  signEvent,
  successorMayApply,
  validateEvent,
  CLASS_RANKED_KINDS,
  REQUIRED_CAPABILITY,
  type Capability,
  type EventEnvelope,
  type EvidenceClass,
  type Ingress,
  type Scope,
  type ValidationCode,
  type ValidationResult,
} from "../contracts/index.js";
import type { AdmissionOutcome, AppendResult, Cursor, EventQuery } from "../contracts/store-api.js";
import type { DeliveryState } from "../contracts/delivery.js";
import { openEventsDatabase, dropEventsDatabase, withWriteTxn, type SqliteDatabase } from "./db.js";
import { causalOrder, projectEvents, type SliceProjectedRecord } from "./projection.js";

/**
 * `conflicting_duplicate` is a REJECT_REASONS value in the delivery contract
 * but has no ValidationCode, so append() has nothing honest to return for a
 * same-id/different-digest write. Proposed to the lead as a new ValidationCode;
 * the cast is the only place the gap shows.
 */
export const CONFLICTING_DUPLICATE = "CONFLICTING_DUPLICATE" as unknown as ValidationCode;

export interface HostKey {
  keyId: string;
  privateKeyPkcs8Pem: string;
  publicKeySpkiBase64: string;
}

export interface KnownKey {
  publicKeySpkiBase64: string;
  /** Only a human principal's key may sign a ruling (ADR §2.3). */
  human?: boolean;
}

export interface EventStoreOptions {
  twiningDir: string;
  /** Signs locally-appended events that arrive unsigned. */
  hostKey?: HostKey;
  /** Keys trusted out of band (host keys, the human's ceremony key). */
  knownKeys?: Record<string, KnownKey>;
  /** Injected clock — only ever used for audit stamps, never for ordering. */
  now?: () => string;
}

export interface TransferView {
  transport: string;
  state: "exported" | "transferred";
  carrier_id?: string;
  attempts: number;
  acked: boolean;
  uncertain: boolean;
  uncertain_windows: Array<{ opened: string; closed?: string }>;
}

export interface DeliveryStateView {
  state: DeliveryState;
  reason?: string;
  carrier?: string;
  pending_on?: string[];
  /** C10 receipt arithmetic: attempts == admissions + duplicate_suppressed + conflict_rejected. */
  attempts: number;
  admissions: number;
  duplicate_suppressed: number;
  conflict_rejected: number;
  /** Per-transport transfer ladder — never folded into `state` (R08). */
  transfers: TransferView[];
}

export interface AdmissionLogRow {
  seq: number;
  event_id: string;
  digest: string;
  outcome: string;
  reason?: string;
  at: string;
}

export interface SliceEventQuery extends EventQuery {
  include_archived?: boolean;
  include_retired?: boolean;
  record_id?: string;
}

export type AppendOutcome = AppendResult | { ok: false; validation: ValidationResult };

interface JournalRow {
  id: string;
  digest: string;
  canonical: number;
  kind: string;
  record_id: string | null;
  record_type: string | null;
  scope: string;
  principal: string;
  evidence_class: string;
  occurred_at: string;
  parents: string;
  file: string;
  state: DeliveryState;
  reason: string | null;
  pending_on: string | null;
  attempts: number;
  admissions: number;
  duplicate_suppressed: number;
  conflict_rejected: number;
}

const ADMITTED_STATES = new Set<DeliveryState>(["admitted", "projected"]);
/** Quarantine reasons that a later event (a principal record, a membership) can clear. */
const RETRYABLE_QUARANTINE = new Set(["signature_required", "unauthorized_principal", "attachment_missing"]);

function monthShard(occurredAt: string): string {
  return occurredAt.slice(0, 7); // yyyy-mm
}

/** Atomic rename plus fsync of the file and its directory — the ADR §4.2 ack boundary. */
function durableWrite(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath));
  atomicWriteFileSync(filePath, content);
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, "r");
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  let dir: number | undefined;
  try {
    dir = fs.openSync(path.dirname(filePath), "r");
    fs.fsyncSync(dir);
  } catch {
    /* directory fsync is unavailable on some platforms; the rename is still atomic */
  } finally {
    if (dir !== undefined) fs.closeSync(dir);
  }
}

export class EventStore {
  readonly twiningDir: string;
  readonly eventsDir: string;
  readonly cursorsDir: string;
  private readonly hostKey?: HostKey;
  private readonly knownKeys: Record<string, KnownKey>;
  private readonly now: () => string;
  private db: SqliteDatabase;
  /** True while rebuild() is replaying the receipt log — suppresses re-logging. */
  private replaying = false;

  constructor(opts: EventStoreOptions) {
    this.twiningDir = opts.twiningDir;
    this.eventsDir = path.join(opts.twiningDir, "events");
    this.cursorsDir = path.join(opts.twiningDir, "cursors");
    this.hostKey = opts.hostKey;
    this.knownKeys = { ...(opts.knownKeys ?? {}) };
    if (opts.hostKey) this.knownKeys[opts.hostKey.keyId] ??= { publicKeySpkiBase64: opts.hostKey.publicKeySpkiBase64 };
    this.now = opts.now ?? (() => new Date().toISOString());
    ensureDir(this.eventsDir);
    ensureDir(this.cursorsDir);
    this.db = openEventsDatabase(opts.twiningDir);
    this.loadCursorFiles();
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }

  // ---------------------------------------------------------------- ingress

  /**
   * Validate for `ingress`, sign with the host key when the event arrives
   * unsigned, journal, write the event file, fsync, return. A repeat of the
   * same id+digest is a no-op; the same id with different bytes is rejected as
   * a conflicting duplicate with the ORIGINAL file untouched (R07).
   */
  async append(raw: unknown, ingress: Ingress): Promise<AppendOutcome> {
    const first = validateEvent(raw, this.validateOptions(ingress));
    if (!first.ok) return { ok: false, validation: first };

    let envelope: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
    if (this.hostKey && envelope.sig === undefined) {
      envelope.sig = { alg: "ed25519", key: this.hostKey.keyId, value: signEvent(envelope, this.hostKey.privateKeyPkcs8Pem) };
      const signed = validateEvent(envelope, this.validateOptions(ingress));
      if (!signed.ok) return { ok: false, validation: signed };
      envelope = { ...envelope };
    }
    const ev = eventEnvelopeSchema.parse(envelope);

    const existing = this.rowsForId(ev.id);
    const sameDigest = existing.find((r) => r.digest === ev.digest);
    if (sameDigest) {
      this.countAttempt(ev.id, ev.digest, "duplicate");
      this.logAdmission(ev.id, ev.digest, "duplicate_suppressed", "same id and digest already stored");
      return { event: ev, duplicate: true, state: "local_persisted" };
    }
    const canonical = existing.find((r) => r.canonical === 1);
    if (canonical) {
      this.recordConflictingDuplicate(ev, envelope, canonical);
      return {
        ok: false,
        validation: {
          ok: false,
          code: CONFLICTING_DUPLICATE,
          message: `event id ${ev.id} is already bound to digest ${canonical.digest}; the new bytes are retained as evidence and never applied`,
          path: "digest",
        },
      };
    }

    const file = this.writeEvent(ev, envelope);
    this.insertJournal(ev, file, "local_persisted", ingress, true);
    this.logAdmission(ev.id, ev.digest, "local_persisted", `appended via ${ingress}`);
    return { event: ev, duplicate: false, state: "local_persisted" };
  }

  /**
   * Take delivery of an event produced elsewhere: retain the bytes durably and
   * journal it as `received`. Admission is a separate, later decision.
   */
  receive(raw: unknown, carrier?: string, carrierId?: string): { id: string; state: DeliveryState; duplicate: boolean; reason?: string } {
    if (typeof raw !== "object" || raw === null) return { id: "", state: "rejected", duplicate: false, reason: "schema" };
    const envelope = raw as Record<string, unknown>;
    const id = typeof envelope.id === "string" ? envelope.id : "";
    const digest = typeof envelope.digest === "string" ? envelope.digest : computeEventDigest(envelope);
    if (!id) return { id: "", state: "rejected", duplicate: false, reason: "schema" };

    if (carrier && carrierId) this.addRepresentation(id, carrier, carrierId);
    const existing = this.rowsForId(id);
    const same = existing.find((r) => r.digest === digest);
    if (same) {
      this.countAttempt(id, digest, "duplicate");
      this.logAdmission(id, digest, "duplicate_suppressed", "redelivery of an event already held");
      return { id, state: same.state, duplicate: true };
    }
    const canonical = existing.find((r) => r.canonical === 1);
    if (canonical) {
      const parsed = eventEnvelopeSchema.safeParse(envelope);
      if (parsed.success) this.recordConflictingDuplicate(parsed.data, envelope, canonical);
      else this.recordConflictingDuplicateRaw(id, digest, envelope, canonical);
      return { id, state: "rejected", duplicate: false, reason: "conflicting_duplicate" };
    }

    const parsed = eventEnvelopeSchema.safeParse(envelope);
    if (!parsed.success) {
      // Retain the bytes anyway — nothing is ever dropped (ADR §5).
      const file = path.join("rejected", `${id}.${digest.slice(7, 19)}.json`);
      durableWrite(path.join(this.eventsDir, file), JSON.stringify(envelope, null, 2));
      this.db
        .prepare(
          `INSERT INTO journal (id,digest,canonical,kind,record_id,record_type,scope,principal,evidence_class,occurred_at,parents,file,state,reason,first_seen)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(id, digest, 1, String(envelope.kind ?? "?"), null, null, "{}", "?", "?", String(envelope.occurred_at ?? ""), "[]", file, "rejected", "schema", this.now());
      this.logAdmission(id, digest, "rejected", "schema");
      return { id, state: "rejected", duplicate: false, reason: "schema" };
    }
    const ev = parsed.data;
    const file = this.writeEvent(ev, envelope);
    this.insertJournal(ev, file, "received", "import", true, carrier);
    this.logAdmission(id, digest, "received", carrier ? `received via ${carrier}` : "received");
    return { id, state: "received", duplicate: false };
  }

  // -------------------------------------------------------------- admission

  /**
   * Run admission over every candidate until no further progress is possible:
   * re-validate from the FILE bytes, check parents, capability, relation scope,
   * cycles and the class-rank rule. Every outcome is a durable admission-log row.
   */
  async admit(ids?: string[]): Promise<AdmissionOutcome[]> {
    const outcomes = new Map<string, AdmissionOutcome>();
    for (let pass = 0; pass < 32; pass += 1) {
      const candidates = this.admissionCandidates(ids);
      if (candidates.length === 0) break;
      const view = this.admittedView();
      let progressed = false;
      for (const row of candidates) {
        const outcome = this.admitOne(row, view);
        outcomes.set(row.id, outcome);
        if (outcome.state === "admitted") progressed = true;
      }
      if (!progressed) break;
    }
    return [...outcomes.values()];
  }

  private admissionCandidates(ids?: string[]): JournalRow[] {
    const rows = this.allRows().filter((r) => r.canonical === 1);
    return rows.filter((r) => {
      if (ids && !ids.includes(r.id)) return false;
      if (r.state === "local_persisted" || r.state === "received" || r.state === "pending_parents") return true;
      if (r.state === "quarantined" && r.reason && RETRYABLE_QUARANTINE.has(r.reason)) return true;
      return false;
    });
  }

  private admitOne(row: JournalRow, view: AdmittedView): AdmissionOutcome {
    // 1. Re-validate from the bytes on disk, not from whatever the caller held.
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(this.eventsDir, row.file), "utf8"));
    } catch (err) {
      return this.settle(row, "quarantined", "attachment_missing", `event file unreadable: ${(err as Error).message}`);
    }
    const validation = validateEvent(raw, this.validateOptions("import", view));
    if (!validation.ok) return this.settle(row, ...mapValidationFailure(validation.code), validation.message, validation);
    const ev = validation.event;

    // 2. Parents must all be admitted; until then the event waits, visible.
    const missingParents = (ev.parents ?? []).filter((p) => !view.admittedIds.has(p));
    if (missingParents.length > 0) {
      return this.settle(row, "pending_parents", undefined, `waiting on ${missingParents.join(", ")}`, undefined, missingParents);
    }

    // 3. Relation endpoints must exist (ADR §3) — otherwise the event waits too.
    const endpoints = relationEndpoints(ev);
    const missingEndpoints = endpoints.filter((r) => !view.records.has(r));
    if (missingEndpoints.length > 0) {
      return this.settle(row, "pending_parents", undefined, `waiting on record ${missingEndpoints.join(", ")}`, undefined, missingEndpoints);
    }

    // 4. Capability against the projected membership. A policy that DENIES is
    //    terminal (`rejected:unauthorized`, appendix B X-4); a policy that has
    //    not arrived yet is retryable, because "the policy is absent" and "the
    //    policy refuses" are different answers and conflating them would make
    //    admission depend on delivery order (C16 A4.4 plan B, C11 O2).
    const capability = requiredCapability(ev);
    if (capability) {
      const allowed = this.hasCapability(ev, capability, view);
      if (!allowed.ok) {
        return allowed.terminal
          ? this.settle(row, "rejected", "unauthorized", allowed.reason, validation)
          : this.settle(row, "quarantined", "unauthorized_principal", allowed.reason, validation);
      }
    }

    // 5. The author's scope must govern the endpoints of an authority-changing
    //    relation; a narrow scope never widens (C09, R06).
    const scopeCheck = checkRelationScope(ev, view);
    if (!scopeCheck.ok) return this.settle(row, "quarantined", "unauthorized_cross_scope", scopeCheck.reason, validation);

    // 6. Cycles in the supersession graph are rejected outright (C22).
    if (createsCycle(ev, view)) return this.settle(row, "rejected", "cycle", "supersession cycle", validation);

    // 7. Class rank: a lower-class successor is ADMITTED, but the reducer
    //    applies it as a contested annotation, never as a supersession (§4.3).
    //    The admission log carries a reason for EVERY outcome, `admitted`
    //    included (lead ruling C10-D6), so A10's `prerequisite_satisfied`
    //    trigger is readable off the log rather than inferred.
    let note = row.state === "pending_parents" ? "admitted:prerequisite_satisfied" : "admitted:validated";
    if (CLASS_RANKED_KINDS.has(ev.kind) && ev.record) {
      const target = view.records.get(ev.record.id);
      if (target && !successorMayApply(target.evidence_class as EvidenceClass, ev.evidence_class)) {
        note = `admitted:contested_lower_class (${ev.evidence_class} cannot ${ev.kind} over ${target.evidence_class})`;
      }
    }
    return this.settle(row, "admitted", undefined, note, validation);
  }

  private settle(
    row: JournalRow,
    state: DeliveryState,
    reason?: string,
    message?: string,
    validation?: ValidationResult,
    pendingOn?: string[],
  ): AdmissionOutcome {
    const changed = row.state !== state || (row.reason ?? undefined) !== reason;
    const admissionsDelta = state === "admitted" && row.state !== "admitted" && row.state !== "projected" ? 1 : 0;
    this.db
      .prepare("UPDATE journal SET state = ?, reason = ?, pending_on = ?, admissions = admissions + ? WHERE id = ? AND canonical = 1")
      .run(state, reason ?? null, pendingOn ? JSON.stringify(pendingOn) : null, admissionsDelta, row.id);
    if (changed || state === "admitted") this.logAdmission(row.id, row.digest, state, message ?? reason);
    return {
      id: row.id,
      state: state as AdmissionOutcome["state"],
      ...(reason ? { reason } : message ? { reason: message } : {}),
      ...(validation ? { validation } : {}),
    };
  }

  // ------------------------------------------------------------- projection

  /** Recompute every projection from the admitted set. Idempotent and deterministic. */
  async project(): Promise<{ records: number; conflicts: number }> {
    const result = projectEvents(this.admittedEnvelopes());
    withWriteTxn(this.db, () => {
      this.db.prepare("DELETE FROM projections").run();
      const ins = this.db.prepare("INSERT INTO projections (record_id, data) VALUES (?, ?)");
      for (const [id, rec] of result.records) ins.run(id, JSON.stringify(rec));
      this.db.prepare("UPDATE journal SET state = 'projected' WHERE state = 'admitted' AND canonical = 1").run();
    });
    return { records: result.records.size, conflicts: result.conflicts };
  }

  /**
   * The projection as of a LOGICAL cut: replay the causal prefix up to and
   * including `cutEventId`. Bitemporal as-of queries (C16 A3.8 / Q6) are a
   * replay to a cut, never a wall-clock filter — nothing orders by time.
   */
  projectionAsOf(cutEventId: string): Map<string, SliceProjectedRecord> {
    const ordered = causalOrder(this.admittedEnvelopes());
    const at = ordered.findIndex((e) => e.id === cutEventId);
    return projectEvents(at === -1 ? [] : ordered.slice(0, at + 1)).records;
  }

  async get(recordId: string): Promise<SliceProjectedRecord | null> {
    const row = this.db.prepare("SELECT data FROM projections WHERE record_id = ?").get(recordId) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as SliceProjectedRecord) : null;
  }

  /**
   * The applicable view. Retired and archived records are excluded by default
   * (they are never deleted — ask for them explicitly).
   */
  async query(q: SliceEventQuery = {}): Promise<SliceProjectedRecord[]> {
    const rows = this.db.prepare("SELECT data FROM projections ORDER BY record_id").all() as Array<{ data: string }>;
    const all = rows.map((r) => JSON.parse(r.data) as SliceProjectedRecord);
    return all.filter((rec) => {
      if (q.record_id && rec.record_id !== q.record_id) return false;
      if (q.record_type && rec.record_type !== q.record_type) return false;
      if (!q.include_retired && !rec.applicable) return false;
      if (!q.include_archived && rec.archived) return false;
      if (q.scope) {
        if ((q.mode ?? "strict") === "strict") {
          if (!scopeMatches(q.scope, rec.scope)) return false;
        } else {
          // "lessons": an explicitly authorized cross-PATH read inside the same
          // tenant/repo (R13/R14). It still never crosses repo or tenant.
          const { path: _p, ...identity } = q.scope;
          if (!scopeMatches(identity as Scope, rec.scope)) return false;
        }
      }
      return true;
    });
  }

  /** Admitted events, in causal order, filtered. */
  async events(q: SliceEventQuery = {}): Promise<EventEnvelope[]> {
    let evs = this.admittedEnvelopes();
    if (q.kinds) evs = evs.filter((e) => q.kinds?.includes(e.kind));
    if (q.record_type) evs = evs.filter((e) => e.record?.type === q.record_type);
    if (q.record_id) evs = evs.filter((e) => e.record?.id === q.record_id);
    if (q.scope) evs = evs.filter((e) => scopeMatches(q.scope as Scope, e.scope));
    if (q.since_id) evs = evs.filter((e) => e.id > (q.since_id as string));
    evs = evs.sort((a, b) => (a.id < b.id ? -1 : 1));
    return q.limit ? evs.slice(0, q.limit) : evs;
  }

  /** Every admitted event that names this record, oldest first. */
  async history(recordId: string): Promise<EventEnvelope[]> {
    return this.admittedEnvelopes()
      .filter((e) => e.record?.id === recordId || (e.payload as { target?: string })?.target === recordId || ((e.payload as { losers?: string[] })?.losers ?? []).includes(recordId))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  /** Every durable admission decision for an event, including the refusals. */
  admissionLog(eventId?: string): AdmissionLogRow[] {
    const rows = eventId
      ? (this.db.prepare("SELECT * FROM admission_log WHERE event_id = ? ORDER BY seq").all(eventId) as Record<string, unknown>[])
      : (this.db.prepare("SELECT * FROM admission_log ORDER BY seq").all() as Record<string, unknown>[]);
    return rows.map((r) => ({
      seq: Number(r.seq),
      event_id: String(r.event_id),
      digest: String(r.digest),
      outcome: String(r.outcome),
      ...(r.reason ? { reason: String(r.reason) } : {}),
      at: String(r.at),
    }));
  }

  // ---------------------------------------------------------------- receipts

  async deliveryState(eventId: string): Promise<DeliveryStateView | null> {
    const row = this.rowsForId(eventId).find((r) => r.canonical === 1);
    if (!row) return null;
    const transfers = (this.db.prepare("SELECT * FROM outbox WHERE event_id = ? ORDER BY transport").all(eventId) as Record<string, unknown>[]).map((t) => ({
      transport: String(t.transport),
      state: String(t.state) as "exported" | "transferred",
      ...(t.carrier_id ? { carrier_id: String(t.carrier_id) } : {}),
      attempts: Number(t.attempts),
      acked: Number(t.acked) === 1,
      uncertain: Number(t.uncertain) === 1,
      uncertain_windows: JSON.parse(String(t.uncertain_windows)) as Array<{ opened: string; closed?: string }>,
    }));
    const conflictRejected = this.rowsForId(eventId).filter((r) => r.canonical === 0).length;
    return {
      state: row.state,
      ...(row.reason ? { reason: row.reason } : {}),
      ...(transfers[0]?.carrier_id ? { carrier: transfers[0].carrier_id } : {}),
      ...(row.pending_on ? { pending_on: JSON.parse(row.pending_on) as string[] } : {}),
      attempts: row.attempts,
      admissions: ADMITTED_STATES.has(row.state) ? 1 : 0,
      duplicate_suppressed: row.duplicate_suppressed,
      conflict_rejected: conflictRejected,
      transfers,
    };
  }

  async cursor(principal: string): Promise<Cursor | null> {
    const row = this.db.prepare("SELECT data FROM cursors WHERE principal = ?").get(principal) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Cursor) : null;
  }

  /**
   * Cursors are single-writer FILES (ADR §5) so they union-merge across clones;
   * the database row is only a cache and is rebuilt from the file.
   */
  async setCursor(principal: string, cursor: Cursor): Promise<void> {
    this.db.prepare("INSERT INTO cursors (principal, data) VALUES (?, ?) ON CONFLICT(principal) DO UPDATE SET data = excluded.data").run(principal, JSON.stringify(cursor));
    durableWrite(path.join(this.cursorsDir, `${principal}.json`), JSON.stringify(cursor, null, 2));
  }

  /** Two cursors for one principal with diverging positions (ADR §5 `cursor_fork`). */
  cursorForks(): Array<{ principal: string; positions: string[] }> {
    const forks: Array<{ principal: string; positions: string[] }> = [];
    for (const file of fs.existsSync(this.cursorsDir) ? fs.readdirSync(this.cursorsDir) : []) {
      if (!file.endsWith(".json")) continue;
      const principal = file.replace(/\.json$/, "");
      const onDisk = JSON.parse(fs.readFileSync(path.join(this.cursorsDir, file), "utf8")) as Cursor;
      const row = this.db.prepare("SELECT data FROM cursors WHERE principal = ?").get(principal) as { data: string } | undefined;
      if (row) {
        const cached = JSON.parse(row.data) as Cursor;
        if (cached.position !== onDisk.position) forks.push({ principal, positions: [cached.position, onDisk.position] });
      }
    }
    return forks;
  }

  // ----------------------------------------------------------------- rebuild

  /**
   * Drop the derived database and replay every event file. Returns the digest
   * over all projected records so two replicas (or the same replica before and
   * after) can be compared for byte-identity (ADR §12 step 6).
   */
  /**
   * Does the checkout still hold every event the journal admitted? (ADR §8.2.)
   *
   * A rewind of the exchange checkout changes the RECEIVED set, not the
   * ADMITTED set. The replica says so — `checkout_behind_journal` — instead of
   * silently revoking what it already admitted (C14 N1/N2/N3).
   */
  checkoutStatus(): { status: "ok" | "checkout_behind_journal"; missing: string[] } {
    const missing = this.allRows()
      .filter((r) => r.canonical === 1 && ADMITTED_STATES.has(r.state) && !fs.existsSync(path.join(this.eventsDir, r.file)))
      .map((r) => r.id)
      .sort();
    return { status: missing.length > 0 ? "checkout_behind_journal" : "ok", missing };
  }

  async rebuild(): Promise<{ projection_digest: string; acknowledged_events_lost: number; lost: string[] }> {
    const admittedBefore = this.allRows()
      .filter((r) => r.canonical === 1 && ADMITTED_STATES.has(r.state))
      .map((r) => r.id);
    this.close();
    dropEventsDatabase(this.twiningDir);
    this.db = openEventsDatabase(this.twiningDir);
    this.replaying = true;
    try {
      // 1. Re-journal from the durable event files, with no counter side
      //    effects — the counters are delivery evidence, not event bytes.
      for (const file of this.scanEventFiles()) {
        let raw: unknown;
        try {
          raw = JSON.parse(fs.readFileSync(path.join(this.eventsDir, file), "utf8"));
        } catch {
          continue; // unreadable bytes are not evidence of anything
        }
        const parsed = eventEnvelopeSchema.safeParse(raw);
        if (!parsed.success) continue;
        const ev = parsed.data;
        if (this.rowsForId(ev.id).some((r) => r.digest === ev.digest)) continue;
        const isConflict = file.startsWith("rejected/") || this.rowsForId(ev.id).some((r) => r.canonical === 1);
        this.insertJournal(ev, file, isConflict ? "rejected" : "received", "import", !isConflict, undefined, 0);
        if (isConflict) this.db.prepare("UPDATE journal SET reason = 'conflicting_duplicate' WHERE id = ? AND digest = ?").run(ev.id, ev.digest);
      }
      // 2. Replay the durable receipt log: attempts, admission rows, outbox
      //    state and carrier representations all come back (C10 A18, C09 A21).
      this.replayReceiptLog();
      this.loadCursorFiles();
      // 3. Re-admit and re-project. Both are pure functions of the admitted
      //    set, so the projection is byte-identical (ADR §12 step 6).
      await this.admit();
      await this.project();
    } finally {
      this.replaying = false;
    }
    const admittedAfter = new Set(
      this.allRows()
        .filter((r) => r.canonical === 1 && ADMITTED_STATES.has(r.state))
        .map((r) => r.id),
    );
    const lost = admittedBefore.filter((id) => !admittedAfter.has(id)).sort();
    return { projection_digest: this.projectionDigest(), acknowledged_events_lost: lost.length, lost };
  }

  projectionDigest(): string {
    const rows = this.db.prepare("SELECT data FROM projections ORDER BY record_id").all() as Array<{ data: string }>;
    return digestOf(rows.map((r) => JSON.parse(r.data) as SliceProjectedRecord));
  }

  // ------------------------------------------------------- outbox plumbing

  /** Events this replica holds that have not yet been transferred on `transport`. */
  outboxPending(transport: string): EventEnvelope[] {
    const rows = this.allRows().filter((r) => r.canonical === 1 && r.state !== "rejected" && !r.file.startsWith("rejected/"));
    const sent = new Map(
      (this.db.prepare("SELECT event_id, state, acked FROM outbox WHERE transport = ?").all(transport) as Record<string, unknown>[]).map((r) => [
        String(r.event_id),
        { state: String(r.state), acked: Number(r.acked) === 1 },
      ]),
    );
    return rows
      .filter((r) => {
        const s = sent.get(r.id);
        return !s || !s.acked;
      })
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((r) => this.readEnvelope(r.file))
      .filter((e): e is EventEnvelope => e !== null);
  }

  recordPublishAttempt(transport: string, eventId: string, digest: string): void {
    const row = this.db.prepare("SELECT attempts, uncertain_windows FROM outbox WHERE transport = ? AND event_id = ?").get(transport, eventId) as
      | { attempts: number | bigint; uncertain_windows: string }
      | undefined;
    const windows = row ? (JSON.parse(row.uncertain_windows) as Array<{ opened: string; closed?: string }>) : [];
    windows.push({ opened: this.now() });
    if (row) {
      this.db
        .prepare("UPDATE outbox SET attempts = attempts + 1, state = 'exported', uncertain = 1, uncertain_windows = ? WHERE transport = ? AND event_id = ?")
        .run(JSON.stringify(windows), transport, eventId);
    } else {
      this.db
        .prepare("INSERT INTO outbox (transport, event_id, digest, state, attempts, uncertain, uncertain_windows) VALUES (?,?,?,'exported',1,1,?)")
        .run(transport, eventId, digest, JSON.stringify(windows));
    }
    this.appendReceiptLog({ k: "pub_attempt", id: eventId, digest, transport });
  }

  recordPublishReceipt(transport: string, eventId: string, carrierId: string): void {
    const row = this.db.prepare("SELECT uncertain_windows FROM outbox WHERE transport = ? AND event_id = ?").get(transport, eventId) as { uncertain_windows: string } | undefined;
    const windows = row ? (JSON.parse(row.uncertain_windows) as Array<{ opened: string; closed?: string }>) : [];
    const closedAt = this.now();
    for (const w of windows) if (!w.closed) w.closed = closedAt; // reconciliation records the uncertainty, it does not erase it (C10 A09)
    this.db
      .prepare("UPDATE outbox SET state = 'transferred', carrier_id = ?, acked = 1, uncertain = 0, uncertain_windows = ? WHERE transport = ? AND event_id = ?")
      .run(carrierId, JSON.stringify(windows), transport, eventId);
    this.appendReceiptLog({ k: "pub_receipt", id: eventId, transport, carrier_id: carrierId });
    this.addRepresentation(eventId, transport, carrierId);
  }

  // ------------------------------------------------------------- internals

  private validateOptions(ingress: Ingress, view?: AdmittedView): { ingress: Ingress; resolveKey: (k: string) => string | undefined; humanKeyIds: ReadonlySet<string> } {
    const v = view ?? this.admittedView();
    return {
      ingress,
      resolveKey: (keyId: string) => this.knownKeys[keyId]?.publicKeySpkiBase64 ?? v.keys.get(keyId),
      humanKeyIds: new Set([...Object.entries(this.knownKeys).filter(([, k]) => k.human).map(([id]) => id), ...v.humanKeys]),
    };
  }

  private writeEvent(ev: EventEnvelope, envelope: Record<string, unknown>): string {
    const rel = path.join(monthShard(ev.occurred_at), `${ev.id}.json`);
    const abs = path.join(this.eventsDir, rel);
    if (!fs.existsSync(abs)) durableWrite(abs, JSON.stringify(envelope, null, 2));
    return rel;
  }

  private insertJournal(ev: EventEnvelope, file: string, state: DeliveryState, ingress: Ingress, canonical: boolean, carrier?: string, attempts = 1): void {
    this.db
      .prepare(
        `INSERT INTO journal (id,digest,canonical,kind,record_id,record_type,scope,principal,evidence_class,occurred_at,parents,file,state,reason,first_seen,attempts)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        ev.id,
        ev.digest,
        canonical ? 1 : 0,
        ev.kind,
        ev.record?.id ?? null,
        ev.record?.type ?? null,
        JSON.stringify(ev.scope),
        ev.producer.principal,
        ev.evidence_class,
        ev.occurred_at,
        JSON.stringify(ev.parents ?? []),
        file,
        state,
        carrier ? `via ${carrier} (${ingress})` : null,
        this.now(),
        attempts,
      );
    if (attempts > 0 && canonical) this.appendReceiptLog({ k: "recv", id: ev.id, digest: ev.digest });
  }

  private recordConflictingDuplicate(ev: EventEnvelope, envelope: Record<string, unknown>, canonical: JournalRow): void {
    const rel = path.join("rejected", `${ev.id}.${ev.digest.slice(7, 19)}.json`);
    durableWrite(path.join(this.eventsDir, rel), JSON.stringify(envelope, null, 2));
    this.insertJournal(ev, rel, "rejected", "import", false);
    this.db.prepare("UPDATE journal SET state = 'rejected', reason = 'conflicting_duplicate' WHERE id = ? AND digest = ?").run(ev.id, ev.digest);
    this.db.prepare("UPDATE journal SET attempts = attempts + 1, conflict_rejected = conflict_rejected + 1 WHERE id = ? AND canonical = 1").run(ev.id);
    this.appendReceiptLog({ k: "conflict", id: ev.id, digest: ev.digest });
    this.logAdmission(ev.id, ev.digest, "rejected", `conflicting_duplicate: id already bound to ${canonical.digest}`);
  }

  private recordConflictingDuplicateRaw(id: string, digest: string, envelope: Record<string, unknown>, canonical: JournalRow): void {
    const rel = path.join("rejected", `${id}.${digest.slice(7, 19)}.json`);
    durableWrite(path.join(this.eventsDir, rel), JSON.stringify(envelope, null, 2));
    this.db
      .prepare(
        `INSERT INTO journal (id,digest,canonical,kind,record_id,record_type,scope,principal,evidence_class,occurred_at,parents,file,state,reason,first_seen)
         VALUES (?,?,0,?,?,?,?,?,?,?,?,?, 'rejected','conflicting_duplicate',?)`,
      )
      .run(id, digest, String(envelope.kind ?? "?"), null, null, "{}", "?", "?", String(envelope.occurred_at ?? ""), "[]", rel, this.now());
    this.db.prepare("UPDATE journal SET attempts = attempts + 1, conflict_rejected = conflict_rejected + 1 WHERE id = ? AND canonical = 1").run(id);
    this.appendReceiptLog({ k: "conflict", id, digest });
    this.logAdmission(id, digest, "rejected", `conflicting_duplicate: id already bound to ${canonical.digest}`);
  }

  private countAttempt(id: string, digest: string, kind: "duplicate"): void {
    if (kind === "duplicate") {
      this.db.prepare("UPDATE journal SET attempts = attempts + 1, duplicate_suppressed = duplicate_suppressed + 1 WHERE id = ? AND canonical = 1").run(id);
      this.appendReceiptLog({ k: "dup", id, digest });
    }
  }

  /**
   * Durable receipt log. Delivery state is per-replica evidence, not event
   * bytes, so it cannot be reconstructed by replaying `events/` — but C10 A18,
   * C09 A21, C14 A-RCP3 and C16 A3.5 all require it to survive the loss of the
   * derived index. It therefore lives in an append-only file beside the
   * database (local, never exchanged) that `rebuild()` replays.
   */
  private get receiptLogFile(): string {
    return path.join(this.twiningDir, "store", "receipts.jsonl");
  }

  private appendReceiptLog(line: Record<string, unknown>): void {
    if (this.replaying) return;
    ensureDir(path.dirname(this.receiptLogFile));
    fs.appendFileSync(this.receiptLogFile, `${JSON.stringify({ at: this.now(), ...line })}\n`);
  }

  private logAdmission(eventId: string, digest: string, outcome: string, reason?: string): void {
    if (this.replaying) return;
    this.db.prepare("INSERT INTO admission_log (event_id, digest, outcome, reason, at) VALUES (?,?,?,?,?)").run(eventId, digest, outcome, reason ?? null, this.now());
    this.appendReceiptLog({ k: "adm", id: eventId, digest, outcome, reason: reason ?? null });
  }

  /** Record that `carrier_id` on `carrier` delivered this event's bytes. */
  addRepresentation(eventId: string, carrier: string, carrierId: string): void {
    this.db
      .prepare("INSERT INTO representations (event_id, carrier, carrier_id, reachable, first_seen) VALUES (?,?,?,1,?) ON CONFLICT DO NOTHING")
      .run(eventId, carrier, carrierId, this.now());
    this.appendReceiptLog({ k: "repr", id: eventId, carrier, carrier_id: carrierId });
  }

  /** A history rewrite makes an old representation unreachable — never deleted. */
  markRepresentationUnreachable(carrierId: string): void {
    this.db.prepare("UPDATE representations SET reachable = 0 WHERE carrier_id = ?").run(carrierId);
    this.appendReceiptLog({ k: "repr_unreachable", carrier_id: carrierId });
  }

  representations(eventId: string): Array<{ carrier: string; carrier_id: string; reachable: boolean }> {
    return (this.db.prepare("SELECT carrier, carrier_id, reachable FROM representations WHERE event_id = ? ORDER BY carrier_id").all(eventId) as Record<string, unknown>[]).map((r) => ({
      carrier: String(r.carrier),
      carrier_id: String(r.carrier_id),
      reachable: Number(r.reachable) === 1,
    }));
  }

  /** Every journal row, including rejected and quarantined ones (the C10 `quarantine` projection). */
  journalRows(): Array<{
    id: string;
    digest: string;
    canonical: boolean;
    state: DeliveryState;
    reason?: string;
    kind: string;
    record_id?: string;
    evidence_class: string;
    scope: Scope;
    producer: string;
  }> {
    return this.allRows().map((r) => ({
      id: r.id,
      digest: r.digest,
      canonical: r.canonical === 1,
      state: r.state,
      ...(r.reason ? { reason: r.reason } : {}),
      kind: r.kind,
      ...(r.record_id ? { record_id: r.record_id } : {}),
      evidence_class: r.evidence_class,
      scope: JSON.parse(r.scope) as Scope,
      producer: r.principal,
    }));
  }

  /** Replay the durable receipt log into a freshly rebuilt index. */
  private replayReceiptLog(): void {
    if (!fs.existsSync(this.receiptLogFile)) return;
    const lines = fs
      .readFileSync(this.receiptLogFile, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "");
    const admission = this.db.prepare("INSERT INTO admission_log (event_id, digest, outcome, reason, at) VALUES (?,?,?,?,?)");
    for (const raw of lines) {
      let line: Record<string, unknown>;
      try {
        line = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        continue;
      }
      const id = String(line.id ?? "");
      switch (line.k) {
        case "recv":
          this.db.prepare("UPDATE journal SET attempts = attempts + 1 WHERE id = ? AND canonical = 1").run(id);
          break;
        case "dup":
          this.db.prepare("UPDATE journal SET attempts = attempts + 1, duplicate_suppressed = duplicate_suppressed + 1 WHERE id = ? AND canonical = 1").run(id);
          break;
        case "conflict":
          this.db.prepare("UPDATE journal SET attempts = attempts + 1, conflict_rejected = conflict_rejected + 1 WHERE id = ? AND canonical = 1").run(id);
          break;
        case "adm":
          admission.run(id, String(line.digest ?? ""), String(line.outcome ?? ""), line.reason === null || line.reason === undefined ? null : String(line.reason), String(line.at ?? ""));
          break;
        case "repr":
          this.db
            .prepare("INSERT INTO representations (event_id, carrier, carrier_id, reachable, first_seen) VALUES (?,?,?,1,?) ON CONFLICT DO NOTHING")
            .run(id, String(line.carrier ?? ""), String(line.carrier_id ?? ""), String(line.at ?? ""));
          break;
        case "repr_unreachable":
          this.db.prepare("UPDATE representations SET reachable = 0 WHERE carrier_id = ?").run(String(line.carrier_id ?? ""));
          break;
        case "pub_attempt": {
          const transport = String(line.transport ?? "");
          const existing = this.db.prepare("SELECT uncertain_windows FROM outbox WHERE transport = ? AND event_id = ?").get(transport, id) as { uncertain_windows: string } | undefined;
          const windows = existing ? (JSON.parse(existing.uncertain_windows) as Array<{ opened: string; closed?: string }>) : [];
          windows.push({ opened: String(line.at ?? "") });
          if (existing) {
            this.db.prepare("UPDATE outbox SET attempts = attempts + 1, state = 'exported', uncertain = 1, uncertain_windows = ? WHERE transport = ? AND event_id = ?").run(JSON.stringify(windows), transport, id);
          } else {
            this.db
              .prepare("INSERT INTO outbox (transport, event_id, digest, state, attempts, uncertain, uncertain_windows) VALUES (?,?,?,'exported',1,1,?)")
              .run(transport, id, String(line.digest ?? ""), JSON.stringify(windows));
          }
          break;
        }
        case "pub_receipt": {
          const transport = String(line.transport ?? "");
          const existing = this.db.prepare("SELECT uncertain_windows FROM outbox WHERE transport = ? AND event_id = ?").get(transport, id) as { uncertain_windows: string } | undefined;
          const windows = existing ? (JSON.parse(existing.uncertain_windows) as Array<{ opened: string; closed?: string }>) : [];
          for (const w of windows) if (!w.closed) w.closed = String(line.at ?? "");
          this.db
            .prepare("UPDATE outbox SET state = 'transferred', carrier_id = ?, acked = 1, uncertain = 0, uncertain_windows = ? WHERE transport = ? AND event_id = ?")
            .run(String(line.carrier_id ?? ""), JSON.stringify(windows), transport, id);
          break;
        }
        default:
          break;
      }
    }
  }

  private rowsForId(id: string): JournalRow[] {
    return (this.db.prepare("SELECT * FROM journal WHERE id = ?").all(id) as Record<string, unknown>[]).map(toRow);
  }

  private allRows(): JournalRow[] {
    return (this.db.prepare("SELECT * FROM journal ORDER BY id").all() as Record<string, unknown>[]).map(toRow);
  }

  private readEnvelope(file: string): EventEnvelope | null {
    try {
      const parsed = eventEnvelopeSchema.safeParse(JSON.parse(fs.readFileSync(path.join(this.eventsDir, file), "utf8")));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private admittedEnvelopes(): EventEnvelope[] {
    return this.allRows()
      .filter((r) => r.canonical === 1 && ADMITTED_STATES.has(r.state))
      .map((r) => this.readEnvelope(r.file))
      .filter((e): e is EventEnvelope => e !== null);
  }

  /** The admitted set, projected — what admission decisions are made against. */
  private admittedView(): AdmittedView {
    const envelopes = this.admittedEnvelopes();
    const { records } = projectEvents(envelopes);
    const keys = new Map<string, string>();
    const humanKeys = new Set<string>();
    for (const rec of records.values()) {
      if (rec.record_type !== "principal") continue;
      const body = rec.body as { key_id?: string; public_key?: string; kind?: string };
      if (body.key_id && body.public_key) {
        keys.set(body.key_id, body.public_key);
        if (body.kind === "human") humanKeys.add(body.key_id);
      }
    }
    const memberships = [...records.values()].filter((r) => r.record_type === "membership" && r.applicable).sort((a, b) => (a.version < b.version ? -1 : 1));
    return {
      envelopes,
      records,
      admittedIds: new Set(envelopes.map((e) => e.id)),
      keys,
      humanKeys,
      membership: memberships.at(-1),
    };
  }

  private hasCapability(ev: EventEnvelope, capability: Capability, view: AdmittedView): { ok: true } | { ok: false; reason: string; terminal: boolean } {
    if (capability === "own") {
      const target = ev.record ? view.records.get(ev.record.id) : undefined;
      if (!target) return { ok: false, reason: "retraction target unknown", terminal: false };
      if (target.producer !== ev.producer.principal) return { ok: false, reason: `only ${target.producer} may retract its own statement`, terminal: true };
      return { ok: true };
    }
    if (!view.membership) {
      // No policy yet: proposals are allowed, authority-changing kinds are not.
      // The one exception is the first membership record itself, which has to
      // be creatable or the store could never acquire a policy at all.
      if (capability === "write") return { ok: true };
      if (ev.kind === "created" && ev.record?.type === "membership") return { ok: true };
      return { ok: false, reason: `no membership policy has been admitted: ${capability} is default-deny until one arrives`, terminal: false };
    }
    const body = view.membership.body as { members?: Array<{ principal: string; roles: string[]; scopes: Scope[] }> };
    for (const member of body.members ?? []) {
      if (member.principal !== ev.producer.principal) continue;
      const granted = member.roles.some((role) => roleImplies(role, capability));
      if (!granted) continue;
      if (member.scopes.some((s) => scopeGoverns(s, ev.scope))) return { ok: true };
    }
    return { ok: false, reason: `${ev.producer.principal} lacks ${capability} in ${JSON.stringify(ev.scope)}`, terminal: true };
  }

  private scanEventFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string, prefix: string): void => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
        else if (entry.name.endsWith(".json")) out.push(rel);
      }
    };
    walk(this.eventsDir, "");
    // rejected/ last so the canonical row always exists before its conflict
    return [...out.filter((f) => !f.startsWith("rejected/")), ...out.filter((f) => f.startsWith("rejected/"))];
  }

  private loadCursorFiles(): void {
    if (!fs.existsSync(this.cursorsDir)) return;
    for (const file of fs.readdirSync(this.cursorsDir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const cursor = JSON.parse(fs.readFileSync(path.join(this.cursorsDir, file), "utf8")) as Cursor;
        this.db
          .prepare("INSERT INTO cursors (principal, data) VALUES (?, ?) ON CONFLICT(principal) DO UPDATE SET data = excluded.data")
          .run(file.replace(/\.json$/, ""), JSON.stringify(cursor));
      } catch {
        /* a malformed cursor file is not a reason to fail startup */
      }
    }
  }
}

// ------------------------------------------------------------- free helpers

export interface AdmittedView {
  envelopes: EventEnvelope[];
  records: Map<string, SliceProjectedRecord>;
  admittedIds: Set<string>;
  keys: Map<string, string>;
  humanKeys: Set<string>;
  membership?: SliceProjectedRecord;
}

function toRow(r: Record<string, unknown>): JournalRow {
  return {
    id: String(r.id),
    digest: String(r.digest),
    canonical: Number(r.canonical),
    kind: String(r.kind),
    record_id: r.record_id === null ? null : String(r.record_id),
    record_type: r.record_type === null ? null : String(r.record_type),
    scope: String(r.scope),
    principal: String(r.principal),
    evidence_class: String(r.evidence_class),
    occurred_at: String(r.occurred_at),
    parents: String(r.parents),
    file: String(r.file),
    state: String(r.state) as DeliveryState,
    reason: r.reason === null || r.reason === undefined ? null : String(r.reason),
    pending_on: r.pending_on === null || r.pending_on === undefined ? null : String(r.pending_on),
    attempts: Number(r.attempts ?? 1),
    admissions: Number(r.admissions ?? 0),
    duplicate_suppressed: Number(r.duplicate_suppressed ?? 0),
    conflict_rejected: Number(r.conflict_rejected ?? 0),
  };
}

function roleImplies(role: string, capability: Capability): boolean {
  if (role === "rule") return capability === "rule" || capability === "write";
  if (role === "write") return capability === "write";
  return false;
}

/** ADR §4.2 transition table, plus the two kinds the table does not list. */
export function requiredCapability(ev: EventEnvelope): Capability | null {
  if (ev.kind === "receipt") return null;
  if (ev.kind === "created") {
    if (ev.scope.global === true) return "rule"; // explicit global rules (ADR §3)
    if (ev.record?.type === "ruling" || ev.record?.type === "membership") return "rule";
    return "write";
  }
  return REQUIRED_CAPABILITY[ev.kind as keyof typeof REQUIRED_CAPABILITY] ?? "write";
}

/** Record ids a lifecycle event points at, all of which must already exist. */
export function relationEndpoints(ev: EventEnvelope): string[] {
  const p = (ev.payload ?? {}) as Record<string, unknown>;
  const out: string[] = [];
  if (ev.kind === "created" || ev.kind === "receipt") return out;
  if (typeof p.target === "string") out.push(p.target);
  if (typeof p.by === "string") out.push(p.by);
  if (typeof p.replacement === "string") out.push(p.replacement);
  if (typeof p.winner === "string") out.push(p.winner);
  for (const l of (p.losers as string[]) ?? []) out.push(l);
  return [...new Set(out)];
}

/**
 * Authority-changing relations: the author's declared scope must govern both
 * endpoints. Two deliberate readings, both noted for the lead:
 *  - `corrected` bounds its effect with `applies_to`, so the author's scope must
 *    govern `applies_to` and `applies_to` must sit inside the target's scope.
 *    Requiring the author to govern the whole target would make C09's narrow
 *    correction of a broad inference impossible, which the ADR explicitly wants.
 *  - a PARTIAL supersession (payload.parts) changes only the named parts, so it
 *    requires the author's scope to sit INSIDE the target's scope rather than to
 *    govern it — parts carry no scope of their own in the contract today.
 */
export function checkRelationScope(ev: EventEnvelope, view: AdmittedView): { ok: true } | { ok: false; reason: string } {
  const AUTHORITY_KINDS = new Set(["superseded", "overridden", "corrected", "contested", "conflict_resolved", "revoked", "tombstoned"]);
  if (!AUTHORITY_KINDS.has(ev.kind)) return { ok: true };
  const p = (ev.payload ?? {}) as Record<string, unknown>;
  const targetId = (p.target as string) ?? ev.record?.id;
  const target = targetId ? view.records.get(targetId) : undefined;
  if (!target) return { ok: true }; // absence is handled as pending_parents earlier

  if (ev.kind === "corrected") {
    const appliesTo = p.applies_to as Scope;
    if (!scopeGoverns(ev.scope, appliesTo)) return { ok: false, reason: `author scope does not govern applies_to` };
    if (!scopeGoverns(target.scope, appliesTo)) return { ok: false, reason: `applies_to is outside the corrected record's scope` };
    return { ok: true };
  }

  const parts = p.parts as string[] | undefined;
  if (parts && parts.length > 0) {
    // Containment is about the PATH envelope, not about revision currency: a
    // record anchored at an old head is still the record whose part is being
    // narrowed, and the correcting author is normally working at a NEWER head
    // (C16 T4 — juno amends P2 at c2 while D1 is anchored at c1). Using
    // scopeGoverns here would make every revision-anchored record un-amendable.
    if (!scopeEnvelopeCovers(target.scope, ev.scope)) return { ok: false, reason: `a partial supersession must be authored inside the record's scope` };
  } else if (!scopeGoverns(ev.scope, target.scope)) {
    return { ok: false, reason: `author scope ${JSON.stringify(ev.scope)} does not govern target scope ${JSON.stringify(target.scope)}` };
  }

  for (const other of [p.by, p.replacement, p.winner].filter((x): x is string => typeof x === "string")) {
    const rec = view.records.get(other);
    if (rec && !scopeGoverns(ev.scope, rec.scope) && !scopeGoverns(rec.scope, ev.scope)) {
      return { ok: false, reason: `author scope does not cover the successor's scope` };
    }
  }
  return { ok: true };
}

/**
 * Does `outer`'s path envelope contain `inner`? Identity components must match
 * exactly and the path must cover on a segment boundary — but the revision is
 * deliberately NOT consulted. This is containment, not authority: `scopeGoverns`
 * remains the only authority test, and it is the one that binds a revision.
 */
export function scopeEnvelopeCovers(outer: Scope, inner: Scope): boolean {
  for (const k of ["tenant", "repo", "task", "attempt", "consumer"] as const) {
    const o = outer[k];
    if (o === undefined) continue;
    if (inner[k] !== o) return false;
  }
  return pathCovers(outer.path, inner.path);
}

/** A supersession edge that closes a loop is rejected outright (C22). */
export function createsCycle(ev: EventEnvelope, view: AdmittedView): boolean {
  const edges = new Map<string, Set<string>>();
  const add = (from: string, to: string): void => {
    if (!edges.has(from)) edges.set(from, new Set());
    edges.get(from)?.add(to);
  };
  for (const e of view.envelopes) addSupersessionEdge(e, add);
  const candidate: Array<[string, string]> = [];
  addSupersessionEdge(ev, (from, to) => candidate.push([from, to]));
  for (const [from, to] of candidate) {
    if (from === to) return true;
    // reachable(to → from) means adding from → to closes a cycle
    const seen = new Set<string>();
    const stack = [to];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      if (cur === from) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const next of edges.get(cur) ?? []) stack.push(next);
    }
    add(from, to);
  }
  return false;
}

function addSupersessionEdge(ev: EventEnvelope, add: (from: string, to: string) => void): void {
  const p = (ev.payload ?? {}) as Record<string, unknown>;
  if (ev.kind === "superseded" && typeof p.target === "string" && typeof p.by === "string") add(p.target, p.by);
  if (ev.kind === "overridden" && typeof p.target === "string" && typeof p.replacement === "string") add(p.target, p.replacement);
  if (ev.kind === "created" && ev.record?.type === "ruling" && ev.record.id) {
    for (const s of ((p.supersedes as string[]) ?? [])) add(s, ev.record.id);
  }
}

/** Map a validation code onto a delivery state plus its quarantine/reject reason. */
export function mapValidationFailure(code: ValidationCode): [DeliveryState, string] {
  switch (code) {
    case "UNKNOWN_KIND":
      return ["quarantined", "unknown_kind"];
    case "ENVELOPE_VERSION_UNSUPPORTED":
      return ["quarantined", "envelope_version_unsupported"];
    case "SIGNATURE_REQUIRED":
    case "SIGNER_UNKNOWN":
      // Retryable: the principal record carrying the key may still arrive.
      return ["quarantined", "signature_required"];
    case "SIGNATURE_INVALID":
      return ["quarantined", "signature_invalid"];
    case "DIGEST_MISMATCH":
      return ["rejected", "digest_mismatch"];
    case "CLASS_NOT_ALLOWED_ON_INGRESS":
    case "RECORD_TYPE_CLASS_MISMATCH":
    case "LEGACY_FLAG_NOT_ALLOWED":
      return ["rejected", "class_not_allowed"];
    default:
      return ["rejected", "schema"];
  }
}
