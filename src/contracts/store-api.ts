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
import type { Ingress } from "./evidence.js";
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
  evidence_class: string;
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

export interface Transport {
  id(): string;
  /** Idempotent by event id + digest; a retry after a lost ack reconciles the same operation. */
  publish(events: EventEnvelope[]): Promise<PublishReceipt>;
  poll(cursor: Cursor | null): Promise<{ events: EventEnvelope[]; cursor: Cursor }>;
  ack(consumer: string, cursor: Cursor): Promise<void>;
  health(): Promise<TransportHealth>;
}
