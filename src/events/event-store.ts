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
  sha256Hex,
  verifyEventSignature,
  ENVELOPE_V,
  EVENT_KINDS,
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
import { exchangeStatus, type ExchangeStatus, type ExchangeStatusOptions } from "../exchange/status.js";
import { causalOrder, currentUseClaim, projectEvents, type SliceProjectedRecord } from "./projection.js";

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
  /**
   * Named crash points for the C18 fault suite. A hook is allowed never to
   * return (the child worker calls process.exit inside it), which is how a
   * kill BETWEEN two durable steps is produced rather than simulated.
   */
  faultHook?: (step: string) => void;
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
  first_seen: string;
  /** 1 when this event's payload was destroyed locally by purge (C20). */
  purged: number;
  /** Exact stored bytes, cached so the projection never depends on the checkout. */
  envelope: string | null;
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
const RETRYABLE_QUARANTINE = new Set(["signature_required", "unauthorized_principal", "attachment_missing", "signer_unknown", "no_policy_yet"]);

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
  readonly faultHook?: (step: string) => void;
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
    if (opts.faultHook) this.faultHook = opts.faultHook;
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

    // D1 is ONE durable step with two writes. The event file is fsynced first,
    // then the journal row; the API returns only after both. A kill between
    // them leaves a file with no row, which recovery re-journals from the file
    // — so the caller never held an acknowledgement for a lost event, and
    // "journaled but not enqueued" is unrepresentable because the outbox is
    // DERIVED from the journal rather than written separately (C18 §1, B = D1+D2
    // atomic; the K1-unreachability demonstration).
    const text = JSON.stringify(envelope, null, 2);
    const file = this.writeEvent(ev, envelope);
    this.faultHook?.("event_file_written");
    this.insertJournal(ev, file, "local_persisted", ingress, true, undefined, 1, text);
    this.faultHook?.("journal_row_written");
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
    if (!id) return { id: "", state: "rejected", duplicate: false, reason: "schema" };

    /**
     * The declared digest is VERIFIED before it is used as the dedup key.
     *
     * Keying dedup on a self-declared field would let anyone suppress the
     * delivery of a legitimate event by pre-sending garbage that claims its
     * id and digest: the real event then arrives, matches an existing row by
     * (id, digest), and is discarded as a redelivery — a silent loss produced
     * by an attacker-controlled string. The digest is the one field that can be
     * checked against the bytes themselves, so it is checked first.
     */
    const declared = typeof envelope.digest === "string" ? envelope.digest : undefined;
    const computed = computeEventDigest(envelope);
    if (declared !== undefined && declared !== computed) {
      // Keyed on the COMPUTED digest: the declared one is a claim, and it is
      // very likely the digest of some OTHER event whose row must not be touched.
      return this.retainUnapplied(id, computed, envelope, "rejected", "digest_mismatch", `declared ${declared} but the canonical bytes hash to ${computed}`, carrier);
    }
    const digest = computed;

    if (carrier && carrierId) this.addRepresentation(id, carrier, carrierId);
    const existing = this.rowsForId(id);
    const same = existing.find((r) => r.digest === digest);
    if (same) {
      /**
       * The digest deliberately excludes `sig`, so two copies that differ ONLY
       * in their signature hash identically. Treating the second as a plain
       * redelivery let an attacker suppress a legitimate event for ever by
       * pre-sending the same bytes with a forged signature: whichever copy
       * landed first owned the id, and the real one was discarded unrecorded.
       *
       * A differing signature is therefore a COMPETING SIGNATURE: the bytes are
       * retained, the suppression is logged, and — when the incumbent is
       * sitting in a signature-related quarantine — the newcomer replaces it so
       * a verifiable copy can still win. A squatter can delay, never silence.
       */
      const incomingSig = JSON.stringify((envelope as { sig?: unknown }).sig ?? null);
      const heldSig = JSON.stringify((this.parseEnvelopeText(this.readEventFileText(same.file) ?? same.envelope) as { sig?: unknown } | null)?.sig ?? null);
      if (incomingSig !== heldSig) {
        this.recordIngestAttempt({
          carrier: carrier ?? "direct",
          disposition: "QUARANTINE",
          reason: "competing_signature",
          bytes: JSON.stringify(envelope, null, 2),
          detail: `same id and digest as ${id} but a different signature`,
        });
        this.logAdmission(id, digest, "competing_signature", `a second copy of ${id} arrived with a different signature; both byte streams are retained`);
        // Which copy is replaceable is decided by whether the signature
        // VERIFIES, not by whether admission happens to have run yet: the two
        // copies can arrive back to back, and a rule that depended on the
        // interleaving would be the same arrival-order bug in a new place.
        const heldEnvelope = this.parseEnvelopeText(this.readEventFileText(same.file) ?? same.envelope);
        const replaceable =
          !ADMITTED_STATES.has(same.state) &&
          !this.signatureVerifies(heldEnvelope as unknown as Record<string, unknown> | null) &&
          this.signatureVerifies(envelope);
        if (replaceable) {
          // The incumbent could not be verified. Let the newcomer try.
          durableWrite(path.join(this.eventsDir, same.file), JSON.stringify(envelope, null, 2));
          this.db.prepare("UPDATE journal SET envelope = ?, state = 'received', reason = NULL WHERE id = ? AND digest = ?").run(JSON.stringify(envelope, null, 2), id, digest);
          this.viewCache = undefined; // the bytes changed under an unchanged key
          this.appendReceiptLog({ k: "sig_replace", id, digest });
          return { id, state: "received", duplicate: false, reason: "competing_signature" };
        }
        this.countAttempt(id, digest, "duplicate");
        return { id, state: same.state, duplicate: true, reason: "competing_signature" };
      }
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

    // An envelope from a NEWER client, or one naming a kind this build does not
    // know, is QUARANTINED — not rejected and above all not coerced by dropping
    // the fields we do not recognise (C17 A8/A9). The prior projection is
    // untouched: quarantine withholds application, it never rewrites state.
    if (envelope.v !== ENVELOPE_V) {
      return this.retainUnapplied(id, digest, envelope, "quarantined", "envelope_version_unsupported", `envelope v=${String(envelope.v)} is not ${ENVELOPE_V}`, carrier);
    }
    if (typeof envelope.kind !== "string" || !(EVENT_KINDS as readonly string[]).includes(envelope.kind)) {
      return this.retainUnapplied(id, digest, envelope, "quarantined", "unknown_kind", `unknown event kind ${JSON.stringify(envelope.kind)}`, carrier);
    }

    const parsed = eventEnvelopeSchema.safeParse(envelope);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return this.retainUnapplied(id, digest, envelope, "rejected", "schema", issue ? `${issue.path.join(".") || "(root)"}: ${issue.message}` : "invalid envelope", carrier);
    }
    const ev = parsed.data;
    const text = JSON.stringify(envelope, null, 2);
    const file = this.writeEvent(ev, envelope);
    this.insertJournal(ev, file, "received", "import", true, carrier, 1, text);
    this.logAdmission(id, digest, "received", carrier ? `received via ${carrier}` : "received");
    this.faultHook?.("received");
    return { id, state: "received", duplicate: false };
  }

  /**
   * Retain bytes that will never be applied, with a reason.
   *
   * Quarantine and rejection differ in whether a later event can clear them,
   * not in whether the bytes survive: nothing is ever dropped (ADR §5), and the
   * file keeps its ORIGINAL bytes at its original hash — no normalization of
   * BOMs, line endings or encodings (C17 A16, C24 A-7).
   */
  private retainUnapplied(
    id: string,
    digest: string,
    envelope: Record<string, unknown>,
    state: Extract<DeliveryState, "quarantined" | "rejected">,
    reason: string,
    message: string,
    carrier?: string,
  ): { id: string; state: DeliveryState; duplicate: boolean; reason?: string } {
    const dir = state === "quarantined" ? "quarantine" : "rejected";
    const file = path.join(dir, `${id}.${digest.slice(7, 19)}.json`);
    const text = JSON.stringify(envelope, null, 2);
    durableWrite(path.join(this.eventsDir, file), text);
    // Bytes that are never applied never take ownership of the id: if a
    // canonical row already holds it, this row is evidence beside it.
    const canonical = this.rowsForId(id).some((r) => r.canonical === 1) ? 0 : 1;
    this.db
      .prepare(
        `INSERT INTO journal (id,digest,canonical,kind,record_id,record_type,scope,principal,evidence_class,occurred_at,parents,file,envelope,state,reason,first_seen)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id, digest) DO UPDATE SET state = excluded.state, reason = excluded.reason`,
      )
      .run(
        id,
        digest,
        canonical,
        String(envelope.kind ?? "?"),
        null,
        null,
        "{}",
        String((envelope.producer as { principal?: string } | undefined)?.principal ?? "?"),
        String(envelope.evidence_class ?? "?"),
        String(envelope.occurred_at ?? ""),
        "[]",
        file,
        text,
        state,
        reason,
        this.now(),
      );
    this.logAdmission(id, digest, state, `${reason}: ${message}`);
    this.recordIngestAttempt({
      carrier: carrier ?? "direct",
      disposition: state === "quarantined" ? "QUARANTINE" : "REFUSE",
      reason,
      bytes: text,
      detail: message,
    });
    return { id, state, duplicate: false, reason };
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
      /**
       * The REVOCATION CUT is causal, not arrival-ordered.
       *
       * `view.revokedKeys` holds only keys whose revocation this replica has
       * ALREADY ADMITTED, so an event is denied when either
       *   (a) the revocation is a causal ancestor of it — the parents rule
       *       holds the event at `pending_parents` until the revocation is
       *       admitted, and the next pass then denies it; or
       *   (b) the revocation was admitted here before the event was offered.
       * An event that is genuinely CONCURRENT with the revocation is admitted
       * and flagged `key_revoked_after` (ADR §7: revocation is prospective and
       * history is not rewritten). Denying concurrent events instead would make
       * the outcome depend on which batch they arrived in — the arrival-order
       * authority decision ADR §4.3.1 forbids.
       */
      let progressed = false;
      /**
       * Events admitted EARLIER IN THIS PASS.
       *
       * Cycle detection has to see them: three prerequisite edges delivered in
       * one batch close a ring, and judging each against a view frozen at the
       * start of the pass admitted all three. Only the cycle check needs this —
       * the other checks resolve naturally on the next pass, which is what the
       * loop is for.
       */
      const admittedThisPass: EventEnvelope[] = [];
      for (const row of candidates) {
        const outcome = this.admitOne(row, view, admittedThisPass);
        outcomes.set(row.id, outcome);
        if (outcome.state === "admitted") {
          progressed = true;
          const ev = this.envelopeForRow(row);
          if (ev) admittedThisPass.push(ev);
        }
      }
      if (!progressed) break;
    }
    this.faultHook?.("admitted");
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

  private admitOne(row: JournalRow, view: AdmittedView, admittedThisPass: EventEnvelope[] = []): AdmissionOutcome {
    // 1. Re-validate from the bytes on disk, not from whatever the caller held.
    let raw: unknown;
    const text = this.readEventFileText(row.file) ?? row.envelope;
    if (text === null) {
      return this.settle(row, "quarantined", "attachment_missing", "event file unreadable and no journal copy held");
    }
    try {
      raw = JSON.parse(text);
    } catch (err) {
      return this.settle(row, "quarantined", "attachment_missing", `event file unreadable: ${(err as Error).message}`);
    }
    /**
     * A PURGED event is admitted on the strength of what it already was.
     *
     * Its payload was destroyed locally, so the stored bytes no longer hash to
     * the recorded digest — re-verifying them would refuse an event this
     * replica had already admitted, which is `rebuild()` reporting
     * `acknowledged_events_lost` for a supported operation and regressing every
     * descendant to `pending_parents`. The digest in the journal is the proof
     * of what the bytes WERE; the erasure is why they are no longer checkable.
     */
    if (this.isPurgedRow(row)) {
      return this.settle(row, "admitted", undefined, "admitted:purged_stub (payload destroyed locally; digest retained as evidence)", undefined);
    }

    const credential = this.checkCredential(raw, view);
    if (credential.length > 0) {
      // C24 C-5: when more than one check fails, EACH is recorded as its own
      // reason. Collapsing them into one generic denial loses the fact that the
      // author assertion was refused independently of the scope refusal.
      for (const c of credential) this.logAdmission(row.id, row.digest, c.state, `${c.reason}: ${c.message}`);
      const terminal = credential.find((c) => c.state === "rejected") ?? (credential[0] as { state: "rejected" | "quarantined"; reason: string });
      return this.settle(row, terminal.state, terminal.reason, credential.map((c) => c.reason).join("+"));
    }

    const validation = validateEvent(raw, this.validateOptions("import", view));
    if (!validation.ok) return this.settle(row, ...mapValidationFailure(validation.code), validation.message, validation);
    const ev = validation.event;

    // 2. Parents must all be admitted; until then the event waits, visible.
    const missingParents = (ev.parents ?? []).filter((p) => !view.admittedIds.has(p));
    if (missingParents.length > 0) {
      // "Has not arrived yet" and "arrived here and was terminally refused" are
      // different facts. Treating both as `pending_parents` left an event whose
      // parent was REJECTED permanently non-terminal: never admitted, never
      // refused, never surfaced as undeliverable, and re-offered on every pass
      // for ever. A dead parent is a dead prerequisite (C28 A13, C18 A9).
      const dead = missingParents.filter((id) => this.isTerminallyRefused(id));
      if (dead.length > 0) {
        return this.settle(row, "rejected", "unsatisfiable_parent", `parent(s) terminally refused on this replica: ${dead.join(", ")}`, validation);
      }
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
      const allowed = this.hasCapability(ev, capability, view, this.ancestorMembership(ev, view, admittedThisPass));
      if (!allowed.ok) {
        if (allowed.terminal) return this.settle(row, "rejected", "unauthorized", allowed.reason, validation);
        // `no_policy_yet` and `unauthorized_principal` are different answers:
        // the first says the policy is not reachable yet, the second says a
        // reachable policy does not name this principal. Both retry.
        const reason = allowed.reason.includes("no_policy_yet") ? "no_policy_yet" : "unauthorized_principal";
        return this.settle(row, "quarantined", reason, allowed.reason, validation);
      }
    }

    // 5. The author's scope must govern the endpoints of an authority-changing
    //    relation; a narrow scope never widens (C09, R06).
    const scopeCheck = checkRelationScope(ev, view);
    if (!scopeCheck.ok) return this.settle(row, "quarantined", "unauthorized_cross_scope", scopeCheck.reason, validation);

    // 6. Cycles in the supersession graph are rejected outright (C22).
    if (createsCycle(ev, view, admittedThisPass)) return this.settle(row, "rejected", "cycle", "prerequisite or supersession cycle", validation);

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

  /**
   * Credential checks that must not be collapsed into "the signature failed".
   *
   * 1. A REVOKED key denies every later event (C24 C-4). Revocation is
   *    prospective only: events already admitted stay admitted and are flagged
   *    `key_revoked_after`, because revoking a key does not unsay what was said
   *    while it was valid (ADR §7).
   * 2. An ASSERTED AUTHOR that does not match the key's own principal record is
   *    refused on its own reason (C24 C-5): possession of a valid signature is
   *    not permission to speak as someone else. A key with no principal record
   *    is unverifiable rather than false, so the check abstains.
   * 3. A human-ruling signature by a key that is resolvable but NOT in the
   *    chain-of-trust closure is QUARANTINED, not rejected: the properly signed
   *    principal event that would trust it may still be in flight, and refusing
   *    terminally would make trust depend on delivery order (ADR §7, C12).
   */
  private checkCredential(raw: unknown, view: AdmittedView): Array<{ state: "rejected" | "quarantined"; reason: string; message: string }> {
    const out: Array<{ state: "rejected" | "quarantined"; reason: string; message: string }> = [];
    const r = raw as { sig?: { key?: string }; producer?: { principal?: string }; evidence_class?: string };
    const keyId = r.sig?.key;
    if (typeof keyId !== "string") return out;

    if (view.revokedKeys.has(keyId)) {
      out.push({ state: "rejected", reason: "credential_revoked", message: `key ${keyId} was revoked; events signed after the revocation cut are denied` });
    }
    const bound = view.keyPrincipals.get(keyId);
    const asserted = r.producer?.principal;
    if (bound !== undefined && typeof asserted === "string" && bound !== asserted) {
      out.push({
        state: "rejected",
        reason: "author_assertion_not_authenticated",
        message: `the envelope asserts producer ${asserted} but key ${keyId} belongs to ${bound}; the authenticated principal is ${bound}`,
      });
    }
    if (r.evidence_class === "human_ruling" && !view.humanKeys.has(keyId) && (view.keys.has(keyId) || this.knownKeys[keyId] !== undefined)) {
      out.push({
        state: "quarantined",
        reason: "signer_unknown",
        message: `key ${keyId} is resolvable but is not a trusted human signer — it was neither bootstrapped nor introduced by an already-trusted human key`,
      });
    }
    return out;
  }

  /**
   * Is this id present on THIS replica in a state nothing can clear?
   *
   * Rejected outright, or quarantined for a reason no later event repairs. An
   * id with no row at all is simply still in flight and is NOT terminal.
   */
  private isTerminallyRefused(id: string): boolean {
    const row = this.rowsForId(id).find((r) => r.canonical === 1);
    if (!row) return false;
    if (row.state === "rejected") return true;
    return row.state === "quarantined" && !RETRYABLE_QUARANTINE.has(row.reason ?? "");
  }

  /** Record ids whose local payload bytes were destroyed (survives rebuild). */
  private purgedRecordIds(): Set<string> {
    return new Set(this.localErasures().filter((e) => e.op === "purge").map((e) => e.record_id));
  }

  private isPurgedRow(row: JournalRow): boolean {
    if (row.purged === 1) return true;
    const purged = this.purgedRecordIds();
    if (purged.size === 0) return false;
    return (row.record_id !== null && purged.has(row.record_id)) || purged.has(row.id);
  }

  /**
   * Does this replica hold a membership record at all — admitted, or still
   * making its way through admission? Rejected rows do not count.
   */
  /**
   * Did THIS replica already admit this exact (id, digest)? Read from the
   * admission log, which is local first-party evidence restored from the
   * durable receipt log on rebuild. See the call site in checkCapability.
   */
  private admittedHereBefore(eventId: string, digest: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS present FROM admission_log WHERE event_id = ? AND digest = ? AND outcome = 'admitted' LIMIT 1")
      .get(eventId, digest) as { present?: number } | undefined;
    return row?.present === 1;
  }

  /**
   * The event id to cite so that this replica's membership policy is a causal
   * ancestor of a new event.
   *
   * ADR §4.3.1: "a membership must therefore be a causal ancestor of anything
   * it authorizes". A producer that mints an event without citing the policy
   * it will be judged under is quarantined `no_policy_yet` — correctly, but
   * uselessly, since the producer is the one replica that always knows which
   * policy applies. Every adapter/runtime write path calls this so the honest
   * citation is automatic rather than something each call site must remember.
   *
   * The LATEST admitted membership event is returned: an event is judged under
   * the policy it cites, so citing the newest one is what an honest producer
   * does.
   */
  currentPolicyEvent(): string | null {
    const row = this.db
      .prepare("SELECT id FROM journal WHERE canonical = 1 AND record_type = 'membership' AND state IN ('admitted','projected') ORDER BY id DESC LIMIT 1")
      .get() as { id?: string } | undefined;
    return row?.id ?? null;
  }

  private replicaKnowsAPolicy(): boolean {
    const row = this.db
      .prepare("SELECT 1 AS present FROM journal WHERE canonical = 1 AND record_type = 'membership' AND state != 'rejected' LIMIT 1")
      .get() as { present?: number } | undefined;
    return row?.present === 1;
  }

  /**
   * Does this envelope's signature verify against a key this replica can
   * resolve? An unsigned or unresolvable-key envelope does NOT verify — it is
   * asserted, not authenticated (ADR §2.1).
   */
  private signatureVerifies(envelope: Record<string, unknown> | null): boolean {
    const sig = (envelope as { sig?: { key?: string; value?: string } } | null)?.sig;
    if (!envelope || !sig?.key || !sig.value) return false;
    const pub = this.validateOptions("import").resolveKey(sig.key);
    if (!pub) return false;
    return verifyEventSignature(envelope, sig.value, pub);
  }

  private settle(
    row: JournalRow,
    state: DeliveryState,
    reason?: string,
    message?: string,
    validation?: ValidationResult,
    pendingOn?: string[],
  ): AdmissionOutcome {
    // A deferral whose WAITING SET shrinks is a state change worth recording:
    // without it the admission log keeps the first, stalest list of missing
    // prerequisites and an operator reading the trail is told the wrong thing.
    const pendingJson = pendingOn ? JSON.stringify(pendingOn) : null;
    const changed = row.state !== state || (row.reason ?? undefined) !== reason || (row.pending_on ?? null) !== pendingJson;
    const admissionsDelta = state === "admitted" && row.state !== "admitted" && row.state !== "projected" ? 1 : 0;
    this.db
      .prepare("UPDATE journal SET state = ?, reason = ?, pending_on = ?, admissions = admissions + ? WHERE id = ? AND canonical = 1")
      .run(state, reason ?? null, pendingJson, admissionsDelta, row.id);
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
    this.faultHook?.("projected");
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
    this.faultHook?.("acked");
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
    this.viewCache = undefined;
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
      .map((r) => this.envelopeForRow(r))
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
      // NOT a union with every admitted human principal: v.humanKeys is already
      // the chain-of-trust closure over the bootstrapped set (ADR §7).
      humanKeyIds: v.humanKeys,
    };
  }

  private writeEvent(ev: EventEnvelope, envelope: Record<string, unknown>): string {
    const rel = path.join(monthShard(ev.occurred_at), `${ev.id}.json`);
    const abs = path.join(this.eventsDir, rel);
    if (!fs.existsSync(abs)) durableWrite(abs, JSON.stringify(envelope, null, 2));
    return rel;
  }

  private insertJournal(
    ev: EventEnvelope,
    file: string,
    state: DeliveryState,
    ingress: Ingress,
    canonical: boolean,
    carrier?: string,
    attempts = 1,
    envelopeText?: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO journal (id,digest,canonical,kind,record_id,record_type,scope,principal,evidence_class,occurred_at,parents,file,envelope,state,reason,first_seen,attempts)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
        envelopeText ?? this.readEventFileText(file),
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

  // --------------------------------------------------- ingest attempts (C17)

  /**
   * Record one import ATTEMPT of an artifact that is not a well-formed event.
   *
   * Keyed on the sha256 of the OBSERVED BYTES, so a byte-identical re-ingest is
   * the same attempt with a higher retry count rather than a second entry
   * (C17 A15), and the retained bytes always hash to their ingest hash with no
   * normalization (A16). A carrier that decoded nothing and moved on would make
   * both assertions unfalsifiable, which is why transports surface malformed
   * artifacts instead of returning null.
   */
  recordIngestAttempt(a: {
    carrier: string;
    carrier_id?: string;
    disposition: "ADMIT" | "QUARANTINE" | "REFUSE" | "DEFER" | "REPORT_NOT_OBSERVED";
    reason: string;
    bytes: string;
    declared_bytes?: number;
    completeness?: "COMPLETE" | "INCOMPLETE" | "UNKNOWN";
    detail?: string;
  }): string {
    const artifactId = sha256Hex(Buffer.from(a.bytes, "utf8"));
    const observed = Buffer.byteLength(a.bytes, "utf8");
    const existing = this.db.prepare("SELECT artifact_id FROM ingest_attempts WHERE artifact_id = ?").get(artifactId);
    if (existing) {
      this.db.prepare("UPDATE ingest_attempts SET retry_count = retry_count + 1, last_seen = ? WHERE artifact_id = ?").run(this.now(), artifactId);
      this.appendReceiptLog({ k: "ingest_retry", artifact_id: artifactId });
      return artifactId;
    }
    const rel = path.join("quarantine", "artifacts", `${artifactId}.bin`);
    durableWrite(path.join(this.eventsDir, rel), a.bytes);
    this.db
      .prepare(
        `INSERT INTO ingest_attempts (artifact_id,carrier,carrier_id,disposition,reason,observed_bytes,declared_bytes,completeness,bytes_file,retry_count,first_seen,last_seen,detail)
         VALUES (?,?,?,?,?,?,?,?,?,1,?,?,?)`,
      )
      .run(
        artifactId,
        a.carrier,
        a.carrier_id ?? null,
        a.disposition,
        a.reason,
        observed,
        a.declared_bytes ?? null,
        a.completeness ?? (a.declared_bytes !== undefined && a.declared_bytes !== observed ? "INCOMPLETE" : "UNKNOWN"),
        rel,
        this.now(),
        this.now(),
        a.detail ?? null,
      );
    this.appendReceiptLog({ k: "ingest", artifact_id: artifactId, carrier: a.carrier, disposition: a.disposition, reason: a.reason, bytes_file: rel, observed, declared: a.declared_bytes ?? null, detail: a.detail ?? null, carrier_id: a.carrier_id ?? null, completeness: a.completeness ?? null });
    return artifactId;
  }

  ingestAttempts(): Array<{
    artifact_id: string;
    carrier: string;
    carrier_id?: string;
    disposition: string;
    reason: string;
    observed_bytes: number;
    declared_bytes?: number;
    completeness: string;
    retry_count: number;
    detail?: string;
  }> {
    return (this.db.prepare("SELECT * FROM ingest_attempts ORDER BY first_seen, artifact_id").all() as Record<string, unknown>[]).map((r) => ({
      artifact_id: String(r.artifact_id),
      carrier: String(r.carrier),
      ...(r.carrier_id ? { carrier_id: String(r.carrier_id) } : {}),
      disposition: String(r.disposition),
      reason: String(r.reason),
      observed_bytes: Number(r.observed_bytes),
      ...(r.declared_bytes === null || r.declared_bytes === undefined ? {} : { declared_bytes: Number(r.declared_bytes) }),
      completeness: String(r.completeness ?? "UNKNOWN"),
      retry_count: Number(r.retry_count),
      ...(r.detail ? { detail: String(r.detail) } : {}),
    }));
  }

  /** The exact bytes of a retained artifact, at its ingest hash. */
  artifactBytes(artifactId: string): string | null {
    const row = this.db.prepare("SELECT bytes_file FROM ingest_attempts WHERE artifact_id = ?").get(artifactId) as { bytes_file: string } | undefined;
    if (!row) return null;
    try {
      return fs.readFileSync(path.join(this.eventsDir, row.bytes_file), "utf8");
    } catch {
      return null;
    }
  }

  // -------------------------------------------------- pending imports (C17)

  /**
   * Open an unresolved-transfer obligation. While one is open, anything served
   * from a locally-held version in its scopes carries a fallback marker naming
   * it and no consequential action qualifies from that version (C17 A12/A13):
   * the store KNOWS a newer version is in flight, so serving the old one
   * silently would be the "unreported fallback to an old valid-looking
   * projection" the case exists to forbid.
   */
  openPendingImport(p: { batch_id: string; carrier: string; reason: string; missing: string[]; scopes: Scope[] }): void {
    this.db
      .prepare(
        `INSERT INTO pending_imports (batch_id,carrier,reason,missing,scopes,opened_at) VALUES (?,?,?,?,?,?)
         ON CONFLICT(batch_id) DO UPDATE SET reason = excluded.reason, missing = excluded.missing, scopes = excluded.scopes, resolved_at = NULL`,
      )
      .run(p.batch_id, p.carrier, p.reason, JSON.stringify(p.missing), JSON.stringify(p.scopes), this.now());
    this.appendReceiptLog({ k: "pending_open", batch_id: p.batch_id, carrier: p.carrier, reason: p.reason, missing: p.missing, scopes: p.scopes });
  }

  resolvePendingImport(batchId: string): void {
    this.db.prepare("UPDATE pending_imports SET resolved_at = ? WHERE batch_id = ?").run(this.now(), batchId);
    this.appendReceiptLog({ k: "pending_resolved", batch_id: batchId });
  }

  pendingImports(): Array<{ batch_id: string; carrier: string; reason: string; missing: string[]; scopes: Scope[]; opened_at: string }> {
    return (this.db.prepare("SELECT * FROM pending_imports WHERE resolved_at IS NULL ORDER BY opened_at, batch_id").all() as Record<string, unknown>[]).map((r) => ({
      batch_id: String(r.batch_id),
      carrier: String(r.carrier),
      reason: String(r.reason),
      missing: JSON.parse(String(r.missing)) as string[],
      scopes: JSON.parse(String(r.scopes)) as Scope[],
      opened_at: String(r.opened_at),
    }));
  }

  /**
   * Serve a record WITH the honesty a pending transfer demands (C17 A12/A13).
   * `fallback_used` is not decoration: the qualification verdict is computed
   * from it, so a caller cannot read the record without reading the caveat.
   */
  async serve(recordId: string, at?: Scope): Promise<{
    record: SliceProjectedRecord | null;
    fallback_used: boolean;
    fallback_source?: string;
    pending: Array<{ batch_id: string; missing: string[] }>;
    qualification: { ok: boolean; reason?: string };
  }> {
    const record = await this.get(recordId);
    const pending = this.pendingImports().filter((p) => record === null || p.scopes.some((s) => scopeMatches(s, record.scope)));
    const base = record && at ? currentUseClaim(record, at) : { ok: false, reason: "no_scope_asked" };
    if (pending.length === 0) {
      return { record, fallback_used: false, pending: [], qualification: record && at ? base : { ok: false, reason: record ? "no_scope_asked" : "not_found" } };
    }
    return {
      record,
      fallback_used: true,
      fallback_source: `local projection as of ${record?.version ?? "unknown"}`,
      pending: pending.map((p) => ({ batch_id: p.batch_id, missing: p.missing })),
      qualification: {
        ok: false,
        reason: `pending_unresolved_import:${pending.map((p) => p.batch_id).join(",")}${pending.some((p) => p.missing.length > 0) ? ` missing_events:${pending.flatMap((p) => p.missing).join(",")}` : ""}`,
      },
    };
  }

  // --------------------------------------------------------- deletion (C20)

  /**
   * Destroy the LOCAL bytes of a tombstoned record and keep the tombstone.
   *
   * Only a tombstoned record may be purged: the semantic delete is an admitted
   * EVENT that propagates, while purge is a local act on local bytes. Nothing
   * here claims anything about other clones — `erasureReport` says so per
   * location, in words, because ADR §10.10 forbids the unqualified claim.
   */
  async purge(recordId: string): Promise<{ purged: boolean; reason?: string; files_removed: number; retained: Array<{ event: string; kind: string; field: string }> }> {
    // Tombstone status comes from the ADMITTED EVENTS, not from the projection
    // row: `forget()` deletes that row, and letting a local view operation make
    // the compliance action unreachable — and the erasure report claim the
    // record was never tombstoned — is the forget/tombstone confusion in its
    // most damaging direction.
    if (!this.isTombstoned(recordId)) return { purged: false, reason: "purge requires an admitted tombstoned event", files_removed: 0, retained: [] };
    let removed = 0;
    const retained: Array<{ event: string; kind: string; field: string }> = [];
    for (const row of this.allRows().filter((r) => this.rowTouchesRecord(r, recordId))) {
      const abs = path.join(this.eventsDir, row.file);
      if (!fs.existsSync(abs)) continue;
      const held = this.parseEnvelopeText(this.readEventFileText(row.file));
      if (!held) continue;
      if (row.kind === "tombstoned") {
        // The tombstone's own `reason` is the AUTHORIZATION for the erasure and
        // is kept deliberately. Saying so per event is the difference between
        // an honest report and the unqualified claim ADR §10.10 forbids.
        retained.push({ event: row.id, kind: row.kind, field: "payload.reason" });
        continue;
      }
      // A schema-VALID stub: everything but the payload survives, so the causal
      // graph and the admitted set survive a rebuild while the content does not.
      // Dropping the whole envelope made rebuild() report acknowledged_events_lost
      // for a supported operation and regressed every descendant to pending_parents.
      const stub = { ...held, payload: { purged: true, purged_at: this.now() } } as unknown as Record<string, unknown>;
      durableWrite(abs, JSON.stringify(stub, null, 2));
      this.db.prepare("UPDATE journal SET envelope = ?, purged = 1 WHERE id = ? AND digest = ?").run(JSON.stringify(stub, null, 2), row.id, row.digest);
      removed += 1;
    }
    this.db.prepare("INSERT INTO local_erasures (record_id, op, at, detail) VALUES (?,?,?,?) ON CONFLICT DO NOTHING").run(recordId, "purge", this.now(), `${removed} payload(s) destroyed locally`);
    // The derived index must not keep the bytes either.
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      this.db.exec("VACUUM;");
    } catch {
      /* a checkpoint failure does not undo the file-level destruction */
    }
    this.viewCache = undefined; // the bytes changed under an unchanged key
    this.appendReceiptLog({ k: "purge", id: recordId, files: removed });
    return { purged: true, files_removed: removed, retained };
  }

  /** Does this journal row carry content ABOUT the record? */
  private rowTouchesRecord(row: JournalRow, recordId: string): boolean {
    if (row.record_id === recordId || row.id === recordId) return true;
    const held = this.parseEnvelopeText(row.envelope);
    return (held?.payload as { target?: string } | undefined)?.target === recordId;
  }

  /** Tombstone status from the admitted EVENT set — survives `forget()`. */
  private isTombstoned(recordId: string): boolean {
    return this.allRows().some(
      (r) => r.canonical === 1 && ADMITTED_STATES.has(r.state) && r.kind === "tombstoned" && this.rowTouchesRecord(r, recordId),
    );
  }

  /**
   * Drop the local projection row only (`twining forget`). The events stay; a
   * rebuild brings the record back, which is exactly the difference between
   * forgetting and deleting and is why the two are separate verbs.
   */
  forget(recordId: string): { forgotten: boolean } {
    const r = this.db.prepare("DELETE FROM projections WHERE record_id = ?").run(recordId);
    this.db.prepare("INSERT INTO local_erasures (record_id, op, at, detail) VALUES (?,?,?,?) ON CONFLICT DO NOTHING").run(recordId, "forget", this.now(), "projection row removed; events retained");
    this.appendReceiptLog({ k: "forget", id: recordId });
    return { forgotten: Number(r.changes) > 0 };
  }

  localErasures(recordId?: string): Array<{ record_id: string; op: string; at: string; detail?: string }> {
    const rows = recordId
      ? (this.db.prepare("SELECT * FROM local_erasures WHERE record_id = ? ORDER BY at").all(recordId) as Record<string, unknown>[])
      : (this.db.prepare("SELECT * FROM local_erasures ORDER BY at").all() as Record<string, unknown>[]);
    return rows.map((r) => ({ record_id: String(r.record_id), op: String(r.op), at: String(r.at), ...(r.detail ? { detail: String(r.detail) } : {}) }));
  }

  /**
   * What this replica can and cannot say about a deletion, per location.
   *
   * Every location this store knows of is enumerated with an honest status.
   * `uncontrolled` and `not_erased` are first-class answers; there is no code
   * path that can produce "erased everywhere", which is the point (C20 E1/E2).
   */
  async erasureReport(recordId: string, locations: Array<{ id: string; kind: "local_store" | "replica" | "carrier_history" | "backup" | "uncontrolled_clone"; reachable?: boolean }> = []): Promise<{
    record_id: string;
    tombstoned: boolean;
    purged_locally: boolean;
    forgotten_locally: boolean;
    locations: Array<{ id: string; kind: string; status: string; note: string }>;
    global_erasure_claimed: false;
    statement: string;
  }> {
    const rec = await this.get(recordId);
    const purgedLocally = this.localErasures(recordId).some((e) => e.op === "purge");
    const forgottenLocally = this.localErasures(recordId).some((e) => e.op === "forget");
    // From the events, never from the projection row `forget()` can delete.
    const tombstoned = this.isTombstoned(recordId);
    const rows: Array<{ id: string; kind: string; status: string; note: string }> = [
      {
        id: "this replica",
        kind: "local_store",
        status: purgedLocally ? "purged" : tombstoned ? "tombstoned" : "present",
        note: purgedLocally
          ? "local payload bytes destroyed for every event carrying this record's content; the tombstone's own reason is retained as the authorization, and each event stub keeps its identity and digest"
          : tombstoned
            ? "tombstoned and awaiting a local purge"
            : "no local purge has run",
      },
    ];
    for (const loc of locations) {
      if (loc.kind === "uncontrolled_clone") rows.push({ id: loc.id, kind: loc.kind, status: "unknown", note: "outside operator control — never reported as erased or compliant" });
      else if (loc.kind === "backup") rows.push({ id: loc.id, kind: loc.kind, status: "not_erased", note: "a retained backup still holds the bytes unless it was destroyed and the destruction observed" });
      else if (loc.kind === "carrier_history") rows.push({ id: loc.id, kind: loc.kind, status: "retention_obligation", note: "git history and every clone of it still carry the bytes; removal is a history-rewrite obligation, not an automatic effect" });
      else if (loc.reachable === false) rows.push({ id: loc.id, kind: loc.kind, status: "pending", note: "unreachable replica: the obligation stays open with its age, never silently closed" });
      else rows.push({ id: loc.id, kind: loc.kind, status: tombstoned ? "tombstone_delivered" : "unknown", note: "verified only to the extent this replica holds a receipt" });
    }
    return {
      record_id: recordId,
      tombstoned,
      purged_locally: purgedLocally,
      // `forget` hides the projection row; saying so keeps it distinguishable
      // from "never tombstoned", which is what it used to look like.
      forgotten_locally: forgottenLocally,
      locations: rows,
      global_erasure_claimed: false,
      statement:
        "Bytes are destroyed only in the locations listed as purged. Remote clones, retained backups and carrier history are NOT erased by any Twining operation and are reported as unknown or not erased.",
    };
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
    first_seen: string;
    attempts: number;
    /** Prerequisites this event is still waiting on (machine-readable). */
    pending_on?: string[];
    /** The signing key was revoked AFTER this event was admitted (ADR §7). */
    key_revoked_after?: boolean;
  }> {
    const view = this.admittedView();
    return this.allRows().map((r) => {
      const ev = this.envelopeForRow(r);
      const revokedAfter = ev?.sig?.key !== undefined && view.revokedKeys.has(ev.sig.key) && ADMITTED_STATES.has(r.state);
      return {
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
        first_seen: r.first_seen,
        attempts: r.attempts,
        ...(r.pending_on ? { pending_on: JSON.parse(r.pending_on) as string[] } : {}),
        ...(revokedAfter ? { key_revoked_after: true } : {}),
      };
    });
  }

  /** Per-transport transfer rows — the OTHER ladder (R08), never folded into state. */
  outboxRows(): Array<{ transport: string; event_id: string; state: string; carrier_id?: string; attempts: number; acked: boolean; uncertain: boolean; opened: string[] }> {
    return (this.db.prepare("SELECT * FROM outbox ORDER BY transport, event_id").all() as Record<string, unknown>[]).map((r) => ({
      transport: String(r.transport),
      event_id: String(r.event_id),
      state: String(r.state),
      ...(r.carrier_id ? { carrier_id: String(r.carrier_id) } : {}),
      attempts: Number(r.attempts),
      acked: Number(r.acked) === 1,
      uncertain: Number(r.uncertain) === 1,
      opened: (JSON.parse(String(r.uncertain_windows)) as Array<{ opened: string; closed?: string }>).filter((w) => !w.closed).map((w) => w.opened),
    }));
  }

  /** Every consumer cursor this replica holds. */
  allCursors(): Array<{ principal: string; cursor: Cursor }> {
    return (this.db.prepare("SELECT principal, data FROM cursors ORDER BY principal").all() as Record<string, unknown>[]).map((r) => ({
      principal: String(r.principal),
      cursor: JSON.parse(String(r.data)) as Cursor,
    }));
  }

  /** The store's audit clock — status surfaces age against it, never against ordering. */
  nowStamp(): string {
    return this.now();
  }

  /**
   * The R20 observability surface. Implemented in `../exchange/status.js` so
   * the store keeps the state and the report keeps the presentation; the method
   * exists here because `store.exchangeStatus()` is what lanes 03 and 04 call.
   */
  async exchangeStatus(opts: ExchangeStatusOptions = {}): Promise<ExchangeStatus> {
    return exchangeStatus(this, opts);
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
        case "ingest": {
          const artifactId = String(line.artifact_id ?? "");
          this.db
            .prepare(
              `INSERT INTO ingest_attempts (artifact_id,carrier,carrier_id,disposition,reason,observed_bytes,declared_bytes,completeness,bytes_file,retry_count,first_seen,last_seen,detail)
               VALUES (?,?,?,?,?,?,?,?,?,1,?,?,?) ON CONFLICT DO NOTHING`,
            )
            .run(
              artifactId,
              String(line.carrier ?? ""),
              line.carrier_id === null || line.carrier_id === undefined ? null : String(line.carrier_id),
              String(line.disposition ?? ""),
              String(line.reason ?? ""),
              Number(line.observed ?? 0),
              line.declared === null || line.declared === undefined ? null : Number(line.declared),
              line.completeness === null || line.completeness === undefined ? "UNKNOWN" : String(line.completeness),
              String(line.bytes_file ?? ""),
              String(line.at ?? ""),
              String(line.at ?? ""),
              line.detail === null || line.detail === undefined ? null : String(line.detail),
            );
          break;
        }
        case "sig_replace":
          // The bytes themselves are on disk, so the replay only has to make
          // sure the row is re-offered rather than left in its old quarantine.
          this.db.prepare("UPDATE journal SET state = 'received', reason = NULL WHERE id = ? AND digest = ? AND state = 'quarantined'").run(id, String(line.digest ?? ""));
          break;
        case "ingest_retry":
          this.db.prepare("UPDATE ingest_attempts SET retry_count = retry_count + 1, last_seen = ? WHERE artifact_id = ?").run(String(line.at ?? ""), String(line.artifact_id ?? ""));
          break;
        case "pending_open":
          this.db
            .prepare(
              `INSERT INTO pending_imports (batch_id,carrier,reason,missing,scopes,opened_at) VALUES (?,?,?,?,?,?)
               ON CONFLICT(batch_id) DO UPDATE SET reason = excluded.reason, missing = excluded.missing, scopes = excluded.scopes, resolved_at = NULL`,
            )
            .run(String(line.batch_id ?? ""), String(line.carrier ?? ""), String(line.reason ?? ""), JSON.stringify(line.missing ?? []), JSON.stringify(line.scopes ?? []), String(line.at ?? ""));
          break;
        case "pending_resolved":
          this.db.prepare("UPDATE pending_imports SET resolved_at = ? WHERE batch_id = ?").run(String(line.at ?? ""), String(line.batch_id ?? ""));
          break;
        case "purge":
          this.db.prepare("INSERT INTO local_erasures (record_id, op, at, detail) VALUES (?,?,?,?) ON CONFLICT DO NOTHING").run(id, "purge", String(line.at ?? ""), `${String(line.files ?? 0)} payload file(s) destroyed locally`);
          break;
        case "forget":
          this.db.prepare("INSERT INTO local_erasures (record_id, op, at, detail) VALUES (?,?,?,?) ON CONFLICT DO NOTHING").run(id, "forget", String(line.at ?? ""), "projection row removed; events retained");
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

  private readEventFileText(file: string): string | null {
    try {
      return fs.readFileSync(path.join(this.eventsDir, file), "utf8");
    } catch {
      return null;
    }
  }

  private parseEnvelopeText(text: string | null): EventEnvelope | null {
    if (text === null) return null;
    try {
      const parsed = eventEnvelopeSchema.safeParse(JSON.parse(text));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private readEnvelope(file: string): EventEnvelope | null {
    return this.parseEnvelopeText(this.readEventFileText(file));
  }

  /**
   * The bytes of an admitted event, from the FILE when the checkout still has
   * it and from the journal's cache when it does not.
   *
   * Reading only the file would mean a shallow/sparse checkout, a `reset
   * --hard` or a force-push silently deleted admitted records at the next
   * project() — absence read as deletion, the C17 failure. The journal is what
   * ADR §8.2 says retains the admitted set, so it is what answers here;
   * `checkoutStatus()` separately reports that the checkout is behind.
   */
  private envelopeForRow(row: JournalRow): EventEnvelope | null {
    return this.readEnvelope(row.file) ?? this.parseEnvelopeText(row.envelope);
  }

  private admittedEnvelopes(): EventEnvelope[] {
    return this.allRows()
      .filter((r) => r.canonical === 1 && ADMITTED_STATES.has(r.state))
      .map((r) => this.envelopeForRow(r))
      .filter((e): e is EventEnvelope => e !== null);
  }

  /**
   * The admitted set, projected — what admission decisions are made against.
   *
   * MEMOIZED, because building it is O(admitted): it reads every admitted
   * event file and runs the whole reducer. `append()` calls it (through
   * `validateOptions`) on EVERY write, so a store with n admitted events paid
   * O(n) per append and O(n^2) to build a corpus — the super-linear append cost
   * lane 05 measured (p95 crossing 100 ms near 35k events).
   *
   * The cache key is the admitted set itself: its size and its highest event
   * id. Both change whenever an event is admitted, and neither changes when an
   * event is merely journaled (`local_persisted`) or moves admitted→projected,
   * which is exactly the invalidation rule the view's content needs. The key is
   * one indexed aggregate query rather than a scan of the rows.
   */
  private viewCache?: { key: string; view: AdmittedView };

  private admittedViewKey(): string {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n, MAX(id) AS top FROM journal WHERE canonical = 1 AND state IN ('admitted','projected')")
      .get() as { n: number | bigint; top: string | null } | undefined;
    return `${String(row?.n ?? 0)}:${row?.top ?? ""}`;
  }

  private admittedView(): AdmittedView {
    const key = this.admittedViewKey();
    const cached = this.viewCache;
    if (cached && cached.key === key) return cached.view;
    const view = this.buildAdmittedView();
    this.viewCache = { key, view };
    return view;
  }

  private buildAdmittedView(): AdmittedView {
    const envelopes = this.admittedEnvelopes();
    const byId = new Map(envelopes.map((e) => [e.id, e]));
    const { records } = projectEvents(envelopes);
    const keys = new Map<string, string>();
    const keyPrincipals = new Map<string, string>();
    const revokedKeys = new Set<string>();

    /**
     * CHAIN OF TRUST FOR HUMAN KEYS (ADR §7, C12).
     *
     * Every principal record makes its key RESOLVABLE — that is what lets an
     * imported event's signature be checked at all, and an unsigned or
     * agent-signed human principal is admitted as ordinary data.
     *
     * Becoming a TRUSTED SIGNER is a different and much stronger thing. A human
     * key is trusted only when it was bootstrapped out of band at store
     * creation, or when the `principal` event introducing it is itself signed by
     * a key already in the trusted set. Before this, any admitted principal
     * record of kind human minted a ruling signer — so a single imported record
     * could manufacture authority, which is exactly the hole C12 names.
     *
     * The rule is transitive, so it is evaluated to a fixpoint rather than in
     * one pass: delivery order must not decide who is trusted.
     */
    const humanPrincipals: Array<{ keyId: string; event?: EventEnvelope }> = [];
    for (const rec of records.values()) {
      if (rec.record_type !== "principal") continue;
      const body = rec.body as { key_id?: string; public_key?: string; kind?: string; principal_id?: string };
      if (!body.key_id || !body.public_key) continue;
      keys.set(body.key_id, body.public_key);
      if (body.principal_id) keyPrincipals.set(body.key_id, body.principal_id);
      if (rec.revoked || rec.status === "revoked") revokedKeys.add(body.key_id);
      if (body.kind === "human") {
        const created = byId.get(rec.record_id);
        // The body and the provenance must be read from the SAME point in the
        // record's history. Today nothing can move `key_id`, but the invariant
        // was incidental: any future lifecycle kind that merged into a
        // principal body would let a `write`-capability event mint a trusted
        // human signing key — exactly the C12 hole this closure exists to shut.
        // So the key in the projected body must be the key the create event
        // declared; a record whose body has drifted is dropped from the
        // closure with a logged reason rather than silently trusted.
        const declared = (created?.payload as { key_id?: string } | undefined)?.key_id;
        if (declared !== undefined && declared !== body.key_id) {
          this.logAdmission(rec.record_id, rec.version, "trust_withheld", `principal ${rec.record_id} projects key_id ${body.key_id} but its create event declared ${declared}; not a trusted signer`);
          continue;
        }
        humanPrincipals.push({ keyId: body.key_id, ...(created ? { event: created } : {}) });
      }
    }
    const humanKeys = new Set<string>(
      Object.entries(this.knownKeys)
        .filter(([, k]) => k.human)
        .map(([id]) => id),
    );
    for (let pass = 0; pass < humanPrincipals.length + 1; pass += 1) {
      let grew = false;
      for (const p of humanPrincipals) {
        if (humanKeys.has(p.keyId)) continue;
        const signer = p.event?.sig?.key;
        if (signer !== undefined && humanKeys.has(signer)) {
          humanKeys.add(p.keyId);
          grew = true;
        }
      }
      if (!grew) break;
    }
    const memberships = [...records.values()].filter((r) => r.record_type === "membership" && r.applicable).sort((a, b) => (a.version < b.version ? -1 : 1));
    return {
      envelopes,
      records,
      admittedIds: new Set(envelopes.map((e) => e.id)),
      keys,
      keyPrincipals,
      humanKeys,
      revokedKeys,
      ...(memberships.at(-1) ? { membership: memberships.at(-1) as SliceProjectedRecord } : {}),
    };
  }

  /**
   * The membership policy an event is judged against: the latest one reachable
   * through its OWN causal ancestry, never the replica's latest.
   *
   * Lead ruling (from a defect lane 02c measured): judging against the latest
   * admitted policy made admission order-dependent and, worse, made it
   * RETROACTIVE — a membership added after an event was admitted dropped that
   * event on the next rebuild (`acknowledged_events_lost: 1`,
   * `rejected: unauthorized`), because rebuild re-admits from scratch against
   * the policy as it stands today. Causal ancestry is the only ordering the
   * store has that does not depend on arrival or on a clock, so a membership
   * must be a causal ancestor of anything it authorizes (ADR §4.3.1) and an
   * event is judged against exactly that policy for ever after.
   */
  private ancestorMembership(ev: EventEnvelope, view: AdmittedView, extra: EventEnvelope[] = []): SliceProjectedRecord | undefined {
    const byId = new Map<string, EventEnvelope>();
    for (const e of [...view.envelopes, ...extra]) byId.set(e.id, e);
    const seen = new Set<string>();
    const stack = [...(ev.parents ?? [])];
    const found: SliceProjectedRecord[] = [];
    while (stack.length > 0) {
      const id = stack.pop() as string;
      if (seen.has(id)) continue;
      seen.add(id);
      const rec = view.records.get(id);
      if (rec?.record_type === "membership" && rec.applicable) found.push(rec);
      const parent = byId.get(id);
      if (parent) stack.push(...(parent.parents ?? []));
    }
    // Deterministic pick among several ancestor policies: the one whose record
    // version is highest. Version is an event id, so this is replay-stable.
    return found.sort((a, b) => (a.version < b.version ? -1 : 1)).at(-1);
  }

  private hasCapability(
    ev: EventEnvelope,
    capability: Capability,
    view: AdmittedView,
    membership: SliceProjectedRecord | undefined,
  ): { ok: true } | { ok: false; reason: string; terminal: boolean } {
    if (capability === "own") {
      const target = ev.record ? view.records.get(ev.record.id) : undefined;
      if (!target) return { ok: false, reason: "retraction target unknown", terminal: false };
      if (target.producer !== ev.producer.principal) return { ok: false, reason: `only ${target.producer} may retract its own statement`, terminal: true };
      return { ok: true };
    }
    if (!membership) {
      /**
       * No policy in this event's ANCESTRY.
       *
       * `parents` is a field the AUTHOR controls, so "no policy in my ancestry"
       * cannot be treated as "this store has no policy": a principal with no
       * grant anywhere could simply set `parents: []` and have its writes
       * admitted, while the identical event that honestly cited the policy was
       * rejected. The replica's own admitted set is what decides which of the
       * two situations this is:
       *   - the replica holds NO membership at all → genuine bootstrap, allow
       *     the first membership and ordinary writes, because otherwise a store
       *     could never acquire a policy;
       *   - the replica HOLDS a policy but this event does not descend from one
       *     → quarantined `no_policy_yet`, retryable, so a later delivery of
       *     the real ancestry can clear it (ADR §4.3.1).
       */
      /**
       * The BOOTSTRAP set is exempt by TYPE, not by ancestry.
       *
       * A `principal` record is an identity declaration and grants nothing —
       * the chain-of-trust closure decides who may sign, the membership decides
       * who may act — and the first `membership` must be creatable or the store
       * could never acquire a policy at all. Both legitimately precede the
       * policy in causal order (the membership names the principals as parents),
       * so neither can be required to descend from one.
       */
      if (ev.kind === "created" && (ev.record?.type === "membership" || ev.record?.type === "principal")) return { ok: true };
      // "This replica knows of a policy" includes one still working through
      // admission: otherwise an event evaluated earlier in the same batch than
      // the membership would slip through on the bootstrap exemption, which is
      // the arrival-order bypass in a different coat.
      if (!this.replicaKnowsAPolicy()) {
        if (capability === "write") return { ok: true };
        return { ok: false, reason: `no membership policy has been admitted on this replica: ${capability} is default-deny until one is`, terminal: false };
      }
      /**
       * ADMISSION IS MONOTONIC FOR WHAT THIS REPLICA ALREADY ADMITTED.
       *
       * The bootstrap branch above is a function of REPLICA state ("do I hold
       * a policy?"), not of the event's ancestry, so a policy that arrives
       * AFTER an event was admitted would otherwise re-answer that event's
       * question the other way on the next rebuild — the whole legacy corpus
       * of a migrated store flips to `no_policy_yet` the moment the store
       * acquires its first membership, and rebuild stops reproducing the
       * projection (ADR §12 step 6; found merging lane 02b with lane 02c,
       * C21 A-REC-10).
       *
       * This replica's own admission log is first-party evidence — it is
       * written by logAdmission on this machine and replayed from the durable
       * receipt log before admit() runs — so honouring it cannot be forged by
       * a peer the way `parents: []` can. It only ever preserves a verdict
       * this replica already reached under the bootstrap regime; it never
       * grants admission to an event seen for the first time, and it does not
       * touch the terminal "lacks capability" answer below. C14 N1/N2/N3
       * (never silently revoke what was already admitted) is the same rule.
       */
      if (this.admittedHereBefore(ev.id, ev.digest)) return { ok: true };
      return {
        ok: false,
        reason: `this replica holds a membership policy but no policy is a causal ancestor of this event — ${capability} cannot be judged (no_policy_yet)`,
        terminal: false,
      };
    }
    const body = membership.body as { members?: Array<{ principal: string; roles: string[]; scopes: Scope[] }> };
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
  /** Every key a principal record makes resolvable (so signatures can be checked). */
  keys: Map<string, string>;
  /** key id → the principal that key belongs to, per its `principal` record. */
  keyPrincipals: Map<string, string>;
  /** Keys TRUSTED to sign rulings — bootstrapped, or introduced by an already-trusted human key. */
  humanKeys: Set<string>;
  /** Keys whose principal record has been revoked; prospective denial only. */
  revokedKeys: Set<string>;
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
    first_seen: String(r.first_seen ?? ""),
    purged: Number(r.purged ?? 0),
    envelope: r.envelope === null || r.envelope === undefined ? null : String(r.envelope),
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
  if (ev.kind === "receipt") return out;
  if (ev.kind === "created") {
    // A prerequisite relation whose endpoints are RECORDS must wait for them:
    // a dangling prerequisite is deferred (visible, retried), never applied and
    // never invented (C22 A03/N02). Entity-name relations are untouched.
    if (ev.record?.type === "relation" && PREREQUISITE_RELATION_TYPES.has(String(p.type ?? ""))) {
      for (const end of [p.source, p.target]) if (isRecordId(end)) out.push(end);
    }
    return [...new Set(out)];
  }
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
export function createsCycle(ev: EventEnvelope, view: AdmittedView, alsoAdmitted: EventEnvelope[] = []): boolean {
  const edges = new Map<string, Set<string>>();
  const add = (from: string, to: string): void => {
    if (!edges.has(from)) edges.set(from, new Set());
    edges.get(from)?.add(to);
  };
  for (const e of [...view.envelopes, ...alsoAdmitted]) addSupersessionEdge(e, add);
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

/**
 * Relation types that carry a PREREQUISITE, and therefore a direction a cycle
 * can close. `relates_to` is deliberately absent: an advisory cross-reference
 * cycle is legitimate, and rejecting one would refuse valid data (C22 open
 * question 4). Only prerequisite-bearing edges are cycle-checked.
 */
const PREREQUISITE_RELATION_TYPES = new Set(["requires", "depends_on", "prerequisite", "blocked_by"]);

function isRecordId(v: unknown): v is string {
  return typeof v === "string" && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(v);
}

/**
 * Every edge whose closure would make a record depend on itself.
 *
 * Supersession/override/ruling-supersedes are authority edges; `requires`,
 * `depends_on` and friends are prerequisite edges. C22's cycle is built from
 * the SECOND kind, so restricting cycle detection to supersession would have
 * admitted an unsatisfiable prerequisite ring and left every action in the
 * scope refusable only by accident.
 */
function addSupersessionEdge(ev: EventEnvelope, add: (from: string, to: string) => void): void {
  const p = (ev.payload ?? {}) as Record<string, unknown>;
  if (ev.kind === "superseded" && typeof p.target === "string" && typeof p.by === "string") add(p.target, p.by);
  if (ev.kind === "overridden" && typeof p.target === "string" && typeof p.replacement === "string") add(p.target, p.replacement);
  if (ev.kind === "created" && ev.record?.type === "ruling" && ev.record.id) {
    for (const s of ((p.supersedes as string[]) ?? [])) add(s, ev.record.id);
  }
  if (ev.kind === "created" && ev.record?.type === "relation") {
    // Record ids only: relation bodies also carry entity NAMES, which are not
    // records and cannot participate in a prerequisite ring.
    if (PREREQUISITE_RELATION_TYPES.has(String(p.type ?? "")) && isRecordId(p.source) && isRecordId(p.target)) add(p.source, p.target);
  }
  if (ev.kind === "created" && ev.record?.type === "decision" && ev.record.id) {
    for (const dep of ((p.depends_on as string[]) ?? [])) if (isRecordId(dep)) add(ev.record.id, dep);
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
