/**
 * Ingress validation (ADR §2.2, §4.2, §7). Every path that can bring an event
 * into a store — MCP, CLI, host adapter, connector, file/Git/relay import, the
 * ruling ceremony, migration — calls validateEvent with its own ingress name.
 * Authority is decided HERE, before storage, from the ingress and the
 * signature — never from a field the caller controls.
 *
 * Capability checks against the store's membership policy are a separate
 * step (lane 02's admission), because they need the projection; this module
 * is pure.
 */
import { eventEnvelopeSchema, type EventEnvelope } from "./event.js";
import { computeEventDigest } from "./canonical.js";
import { ALLOWED_CLASSES_BY_INGRESS, type Ingress } from "./evidence.js";
import { EVENT_KINDS, LIFECYCLE_KINDS, lifecyclePayloadSchemas, receiptPayloadSchema } from "./lifecycle.js";
import { recordBodySchemas } from "./records.js";
import { verifyEventSignature } from "./signing.js";
import { ENVELOPE_V } from "./version.js";

export type ValidationCode =
  | "SCHEMA"
  | "UNKNOWN_KIND"
  | "ENVELOPE_VERSION_UNSUPPORTED"
  | "DIGEST_MISMATCH"
  | "CLASS_NOT_ALLOWED_ON_INGRESS"
  | "RECORD_TYPE_CLASS_MISMATCH"
  | "LEGACY_FLAG_NOT_ALLOWED"
  | "TARGET_RECORD_MISMATCH"
  | "SIGNATURE_REQUIRED"
  | "SIGNATURE_INVALID"
  | "SIGNER_UNKNOWN"
  /** Raised by stores, not by validateEvent: same id, different digest (R07). */
  | "CONFLICTING_DUPLICATE";

export type ValidationResult =
  | { ok: true; event: EventEnvelope }
  | { ok: false; code: ValidationCode; message: string; path?: string };

export interface ValidateOptions {
  ingress: Ingress;
  /** Resolve a key id to a base64 SPKI public key, or undefined when unknown. */
  resolveKey?: (keyId: string) => string | undefined;
  /** Key ids that belong to HUMAN principals (only these may sign rulings). */
  humanKeyIds?: ReadonlySet<string>;
}

function fail(code: ValidationCode, message: string, path?: string): ValidationResult {
  return { ok: false, code, message, ...(path ? { path } : {}) };
}

export function validateEvent(raw: unknown, opts: ValidateOptions): ValidationResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return fail("SCHEMA", "event must be a JSON object");
  }
  const r = raw as Record<string, unknown>;
  if (r.v !== ENVELOPE_V) {
    return fail("ENVELOPE_VERSION_UNSUPPORTED", `envelope v=${String(r.v)} is not ${ENVELOPE_V}`, "v");
  }
  if (typeof r.kind !== "string" || !(EVENT_KINDS as readonly string[]).includes(r.kind)) {
    return fail("UNKNOWN_KIND", `unknown event kind ${JSON.stringify(r.kind)}`, "kind");
  }
  const parsed = eventEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return fail("SCHEMA", issue ? `${issue.path.join(".") || "(root)"}: ${issue.message}` : "invalid envelope", issue?.path.join("."));
  }
  const ev = parsed.data;

  // Digest covers the canonical envelope minus digest/sig — recomputed from the
  // PARSED object, so pretty-printing or key order on disk cannot matter.
  const expected = computeEventDigest(raw as Record<string, unknown>);
  if (ev.digest !== expected) {
    return fail("DIGEST_MISMATCH", `digest ${ev.digest} does not match canonical bytes (${expected})`, "digest");
  }

  // Evidence class is a property of the ingress, not of the caller.
  if (!ALLOWED_CLASSES_BY_INGRESS[opts.ingress].has(ev.evidence_class)) {
    return fail("CLASS_NOT_ALLOWED_ON_INGRESS", `ingress ${opts.ingress} cannot produce evidence_class ${ev.evidence_class}`, "evidence_class");
  }
  if (ev.legacy !== undefined && opts.ingress !== "migration" && opts.ingress !== "import") {
    return fail("LEGACY_FLAG_NOT_ALLOWED", "only migration/import may carry a legacy block", "legacy");
  }
  if (ev.legacy !== undefined && ev.evidence_class !== "legacy_unverified") {
    return fail("LEGACY_FLAG_NOT_ALLOWED", "a legacy block requires evidence_class legacy_unverified", "legacy");
  }

  // Kind-specific structure.
  if (ev.kind === "created") {
    if (!ev.record) return fail("SCHEMA", "created events name a record", "record");
    if (ev.record.id !== ev.id) return fail("TARGET_RECORD_MISMATCH", "a created event's record.id is its own event id", "record.id");
    if (ev.record.type === "ruling" && ev.evidence_class !== "human_ruling") {
      return fail("RECORD_TYPE_CLASS_MISMATCH", "a ruling record requires evidence_class human_ruling", "evidence_class");
    }
    if (ev.record.type !== "ruling" && ev.evidence_class === "human_ruling") {
      return fail("RECORD_TYPE_CLASS_MISMATCH", "human_ruling is reserved for ruling records", "evidence_class");
    }
    const body = recordBodySchemas[ev.record.type].safeParse(ev.payload);
    if (!body.success) {
      const issue = body.error.issues[0];
      return fail("SCHEMA", `payload.${issue?.path.join(".") ?? ""}: ${issue?.message ?? "invalid body"}`, "payload");
    }
    /**
     * post.entry_type "decision" is representable so MIGRATION can import 2.x
     * blackboard bytes without rewriting them, and rejected everywhere else so
     * a live client cannot fork the decision surface in two (draft.3, D30). A
     * decision is its own record type in v3.
     */
    if (ev.record.type === "post" && (ev.payload as { entry_type?: string }).entry_type === "decision" && opts.ingress !== "migration") {
      return fail(
        "RECORD_TYPE_CLASS_MISMATCH",
        'post.entry_type "decision" is a legacy value accepted only from the migration ingress — record a decision as a decision record',
        "payload.entry_type",
      );
    }
  } else if (ev.kind === "receipt") {
    const p = receiptPayloadSchema.safeParse(ev.payload);
    if (!p.success) {
      const issue = p.error.issues[0];
      return fail("SCHEMA", `payload.${issue?.path.join(".") ?? ""}: ${issue?.message ?? "invalid receipt"}`, "payload");
    }
  } else {
    const kind = ev.kind as (typeof LIFECYCLE_KINDS)[number];
    if (!ev.record) return fail("SCHEMA", "lifecycle events name the record they act on", "record");
    const p = lifecyclePayloadSchemas[kind].safeParse(ev.payload);
    if (!p.success) {
      const issue = p.error.issues[0];
      return fail("SCHEMA", `payload.${issue?.path.join(".") ?? ""}: ${issue?.message ?? "invalid payload"}`, "payload");
    }
    const target = (p.data as { target?: string }).target;
    if (kind !== "conflict_resolved" && target !== ev.record.id) {
      return fail("TARGET_RECORD_MISMATCH", "payload.target must equal record.id", "payload.target");
    }
    if (kind === "revoked" && ev.evidence_class !== "human_ruling") {
      return fail("RECORD_TYPE_CLASS_MISMATCH", "revocation requires human_ruling", "evidence_class");
    }
  }

  // Signatures. A ruling from any path other than the live ceremony must be
  // signed by a KNOWN HUMAN key; otherwise it is quarantined by the caller.
  if (ev.sig) {
    const pub = opts.resolveKey?.(ev.sig.key);
    if (!pub) return fail("SIGNER_UNKNOWN", `no public key known for ${ev.sig.key}`, "sig.key");
    if (!verifyEventSignature(raw as Record<string, unknown>, ev.sig.value, pub)) {
      return fail("SIGNATURE_INVALID", "signature does not verify over the canonical bytes", "sig.value");
    }
    if (ev.evidence_class === "human_ruling" && !(opts.humanKeyIds?.has(ev.sig.key) ?? false)) {
      return fail("SIGNATURE_INVALID", "a ruling must be signed by a human principal's key", "sig.key");
    }
  } else if (ev.evidence_class === "human_ruling" && opts.ingress === "import") {
    return fail("SIGNATURE_REQUIRED", "an imported ruling must carry a valid human signature", "sig");
  }

  return { ok: true, event: ev };
}
