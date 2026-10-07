/**
 * Building v3 envelopes from a runtime (ADR §1.2, §2.2).
 *
 * One rule runs through this whole module: **the evidence class comes from
 * the ingress, never from the input.** A caller can ask for an event of a
 * kind; it cannot ask for authority. `classFor()` is the only place a class
 * is chosen, and `validateEvent` re-checks it at the store boundary, so a
 * mistake here fails loudly rather than silently minting authority.
 */
import {
  computeEventDigest,
  mintEventId,
  ALLOWED_CLASSES_BY_INGRESS,
  type EventEnvelope,
  type EventKind,
  type EvidenceClass,
  type Ingress,
  type RecordType,
  type Scope,
  ENVELOPE_V,
} from "../contracts/index.js";
import type { SourceInfo } from "./source.js";

export interface ProducerInfo {
  principal: string;
  kind: "human" | "agent" | "host";
  host: string;
  session?: string;
  turn?: string;
  /** today's agent_id — recorded, displayed, never authoritative */
  asserted_actor?: string;
}

export interface BuildEventSpec {
  kind: EventKind;
  recordType?: RecordType;
  /** Omit for `created` (the event id becomes the record id). */
  recordId?: string;
  scope: Scope;
  producer: ProducerInfo;
  source?: SourceInfo;
  evidenceClass: EvidenceClass;
  payload: Record<string, unknown>;
  parents?: string[];
  attachments?: EventEnvelope["attachments"];
  occurredAt?: string;
  /** Test seam only — never set from a host. */
  id?: string;
}

/**
 * Default evidence class for an ingress + kind.
 *
 * Adapters are the only ingress that can produce `human_statement` (a literal
 * prompt the host handed us) and `reported_result` (a worker's own return,
 * relayed) — and both are *claims about who said what*, not authority. MCP and
 * CLI ingress top out at `proposal`. `human_ruling` is unreachable from every
 * value here; only the ceremony ingress may carry it.
 */
export function classFor(
  ingress: Ingress,
  intent: "statement" | "worker_result" | "observation" | "question" | "default",
): EvidenceClass {
  const allowed = ALLOWED_CLASSES_BY_INGRESS[ingress];
  const wanted: EvidenceClass =
    intent === "statement"
      ? "human_statement"
      : intent === "worker_result"
        ? "reported_result"
        : intent === "observation"
          ? "verified_observation"
          : intent === "question"
            ? "question"
            : "proposal";
  if (allowed.has(wanted)) return wanted;
  // Downgrade, never upgrade: an ingress that cannot make the claim makes the
  // weakest one it can.
  if (allowed.has("proposal")) return "proposal";
  if (allowed.has("question")) return "question";
  const first = [...allowed][0];
  if (!first) throw new Error(`ingress ${ingress} may produce no evidence class`);
  return first;
}

/** Build a digest-complete envelope. Signing happens in EventStore.append. */
export function buildEvent(spec: BuildEventSpec): EventEnvelope {
  const id = spec.id ?? mintEventId();
  const recordId = spec.kind === "created" ? id : spec.recordId;

  const envelope: Record<string, unknown> = {
    v: ENVELOPE_V,
    id,
    kind: spec.kind,
    scope: spec.scope,
    producer: pruneUndefined(spec.producer as unknown as Record<string, unknown>),
    parents: spec.parents ?? [],
    evidence_class: spec.evidenceClass,
    occurred_at: spec.occurredAt ?? new Date().toISOString(),
    payload: spec.payload,
  };
  if (spec.kind !== "receipt") {
    if (!spec.recordType || !recordId) {
      throw new Error(`event kind ${spec.kind} needs a record type and id`);
    }
    envelope.record = { type: spec.recordType, id: recordId };
  }
  if (spec.source && Object.keys(spec.source).length > 0) {
    envelope.source = pruneUndefined(spec.source as unknown as Record<string, unknown>);
  }
  if (spec.attachments && spec.attachments.length > 0) envelope.attachments = spec.attachments;

  envelope.digest = computeEventDigest(envelope);
  return envelope as unknown as EventEnvelope;
}

function pruneUndefined<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as T;
}

/**
 * A `receipt` event — the only durable proof that a specific payload reached a
 * specific turn on a specific host (ADR §5, delivery state `injected`).
 *
 * `payload_hash` is the sha256 of the bytes the HOST received, so a later
 * reader can compare what was promised with what was delivered instead of
 * trusting a log line.
 */
export function buildReceipt(args: {
  stage: "received" | "admitted" | "projected" | "injected" | "task_acked";
  consumer: string;
  events?: string[];
  cursor?: { transport: string; position: string };
  host?: string;
  session?: string;
  turn?: string;
  payloadHash?: string;
  scope: Scope;
  producer: ProducerInfo;
  source?: SourceInfo;
  ingress: Ingress;
  occurredAt?: string;
}): EventEnvelope {
  const payload: Record<string, unknown> = {
    stage: args.stage,
    consumer: args.consumer,
  };
  if (args.events && args.events.length > 0) payload.events = args.events;
  if (args.cursor) payload.cursor = args.cursor;
  if (args.host) payload.host = args.host;
  if (args.session) payload.session = args.session;
  if (args.turn) payload.turn = args.turn;
  if (args.payloadHash) payload.payload_hash = args.payloadHash;

  return buildEvent({
    kind: "receipt",
    scope: args.scope,
    producer: args.producer,
    source: args.source,
    // A receipt is an adapter's own observation of a delivery it performed.
    evidenceClass: classFor(args.ingress, "default"),
    payload,
    occurredAt: args.occurredAt,
  });
}
