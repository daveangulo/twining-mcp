/**
 * The event-store API lanes implement against (ADR §11). Lane 02 implements
 * it; lanes 03 and 04 consume it. Interfaces only — no implementation here.
 *
 * Every method that changes durable state returns only after the journal
 * row and the event file are fsynced (the local acknowledgement boundary,
 * ADR §4.2). Nothing here runs git.
 */
import type { EventEnvelope } from "./event.js";
import type { DeliveryState } from "./delivery.js";
import type { EvidenceClass, Ingress } from "./evidence.js";
import type { Scope } from "./scope.js";
import type { ValidationResult } from "./validate.js";

export interface AppendResult {
  /** The event as stored (digest and, when the host key is present, sig). */
  event: EventEnvelope;
  /** true when the same id+digest already existed — no new semantic effect. */
  duplicate: boolean;
  state: Extract<DeliveryState, "local_persisted">;
}

export interface AdmissionOutcome {
  id: string;
  state: Extract<DeliveryState, "admitted" | "pending_parents" | "quarantined" | "rejected">;
  reason?: string;
  validation?: ValidationResult;
}

export interface ProjectedRecord<Body = Record<string, unknown>> {
  record_id: string;
  record_type: string;
  body: Body;
  /** Current applicable lifecycle status as derived by the reducer. */
  status: string;
  /** Evidence class of the governing event for this record. */
  evidence_class: EvidenceClass;
  scope: Scope;
  /** Event id of the latest admitted event affecting this record on this replica. */
  version: string;
  /** sha256 over the projected record (canonical), for receipts and explain packets. */
  version_digest: string;
  /** Records currently in explicit conflict with this one (equal-class successors, contested). */
  conflicts: string[];
  /** Lifecycle event ids applied to this record, in application order. */
  history: string[];
  /** Legacy provenance flags carried from migration. */
  legacy?: { derived_from_legacy_snapshot: boolean; legacy_ambiguity?: string[] };
}

export interface EventQuery {
  scope?: Scope;
  /** Strict: only events whose scope matches. Lessons: explicitly authorized cross-scope read. */
  mode?: "strict" | "lessons";
  record_type?: string;
  kinds?: string[];
  since_id?: string;
  limit?: number;
}

export interface Cursor {
  transport: string;
  position: string;
  /** Highest admitted event id covered by this cursor. */
  last_admitted?: string;
}

/**
 * Exchange observability (R20) — the shape `exchangeStatus()` returns.
 *
 * Defined here rather than in src/exchange because it is part of the store API
 * lanes 03 and 04 consume, and a contract must not depend on an implementation
 * module. src/exchange/status.ts imports these and is the only implementation.
 */
export interface ExchangeGap {
  kind: "checkout_behind_journal" | "cursor_fork" | "pending_import" | "pending_parents" | "uncertain_transfer" | "open_erasure_obligation";
  detail: string;
  ids: string[];
}

export interface ExchangeStatus {
  generated_at: string;
  store: {
    twining_dir: string;
    events_held: number;
    admitted: number;
    projected: number;
    checkout: "ok" | "checkout_behind_journal";
  };
  /** Producer side: what has not left this host yet, per transport. */
  outbox: {
    depth: number;
    oldest_pending_age_ms: number | null;
    oldest_pending_id: string | null;
    retries: number;
    uncertain: string[];
    by_transport: Array<{ transport: string; queued: number; transferred: number; uncertain: number; attempts: number }>;
  };
  /** Consumer side: what arrived but has not been applied. */
  inbound: {
    received: number;
    pending_parents: Array<{ id: string; waiting_on: string[] }>;
  };
  rejected: { count: number; by_reason: Record<string, number> };
  quarantined: { count: number; retryable: number; by_reason: Record<string, number> };
  ingest_attempts: { count: number; retries: number; by_disposition: Record<string, number>; by_reason: Record<string, number> };
  cursors: Array<{ principal: string; transport: string; position: string; last_admitted?: string }>;
  cursor_forks: Array<{ principal: string; positions: string[] }>;
  transports: Array<{ id: string } & TransportHealth>;
  gaps: ExchangeGap[];
  /** Keys revoked after events they signed were admitted — history kept, flagged. */
  revoked_credentials: Array<{ event_id: string; principal: string }>;
  migration: { state: "unknown"; note: string };
}

export interface ExchangeStatusOptions {
  /** Live carriers to probe. Probing is optional: a status call must work offline. */
  transports?: Array<{ id(): string; health(): Promise<TransportHealth> }>;
  /** Injected clock for age arithmetic (audit only — never an ordering input). */
  now?: () => number;
}

export interface EventStore {
  /** Validate for the given ingress, sign with the host key when available, journal, write the event file. */
  append(raw: unknown, ingress: Ingress): Promise<AppendResult | { ok: false; validation: ValidationResult }>;

  /** Run admission on received-but-unadmitted events (schema, digest, signature/policy, scope, parents). */
  admit(ids?: string[]): Promise<AdmissionOutcome[]>;

  /** Recompute projections from the admitted set; must be idempotent and deterministic. */
  project(): Promise<{ records: number; conflicts: number }>;

  get(recordId: string): Promise<ProjectedRecord | null>;
  query(q: EventQuery): Promise<ProjectedRecord[]>;
  events(q: EventQuery): Promise<EventEnvelope[]>;
  history(recordId: string): Promise<EventEnvelope[]>;

  deliveryState(eventId: string): Promise<{ state: DeliveryState; reason?: string; carrier?: string } | null>;
  cursor(principal: string): Promise<Cursor | null>;
  setCursor(principal: string, cursor: Cursor): Promise<void>;

  /** Drop the derived database and rebuild it from events; returns the projection digest for equality checks. */
  rebuild(): Promise<{ projection_digest: string }>;

  /**
   * "What is this replica uncertain about?" (R20). Read-only, offline-safe,
   * never runs git; probing live carriers is opt-in through `opts.transports`.
   */
  exchangeStatus(opts?: ExchangeStatusOptions): Promise<ExchangeStatus>;
}

export interface PublishReceipt {
  transport: string;
  /** Carrier identity per event digest (commit sha, relay op id, file path). */
  carrier_ids: Record<string, string>;
}

export interface TransportHealth {
  reachable: boolean;
  lag_events?: number;
  last_error?: string;
  credential_state?: "ok" | "expired" | "revoked" | "unknown";
}

/** An artifact a carrier delivered that could not be decoded (C17). */
export interface MalformedArtifact {
  carrier_id: string;
  path: string;
  /** The undecodable bytes, retained as evidence. */
  bytes: string;
  observed_bytes: number;
  reason: "unparseable" | "conflict_markers" | "truncated";
}

/** A discontinuity in a carrier's own sequence, as the carrier saw it. */
export interface CarrierGap {
  gap: boolean;
  reason?: string;
  /** The cursor position the carrier could no longer resolve. */
  unreachable_from?: string;
}

export interface Transport {
  id(): string;
  /**
   * What the LAST poll could not account for. Optional: a carrier that cannot
   * detect either says nothing rather than reporting a reassuring zero (R20,
   * C17, C18). Both are read by `exchangeStatus()` to populate `gaps`.
   *
   * `lastMalformed` — artifacts the poll could not decode; retained as bytes,
   * never dropped, so an operator can see what arrived unreadable.
   * `lastGap` — whether the poll found its own cursor unreachable (a rewind or
   * a force-push on the carrier), with the position it could not resolve from.
   */
  lastMalformed?: ReadonlyArray<MalformedArtifact>;
  lastGap?: CarrierGap;
  /** Idempotent by event id + digest; a retry after a lost ack reconciles the same operation. */
  publish(events: EventEnvelope[]): Promise<PublishReceipt>;
  poll(cursor: Cursor | null): Promise<{ events: EventEnvelope[]; cursor: Cursor }>;
  ack(consumer: string, cursor: Cursor): Promise<void>;
  health(): Promise<TransportHealth>;
}
