/**
 * The event envelope (ADR §1.2). STRICT: an unknown top-level key is a schema
 * error, so a newer client's envelope is refused (and quarantined by ingest)
 * rather than partially understood.
 */
import { z } from "zod";
import { ENVELOPE_V } from "./version.js";
import { ulidSchema, principalIdSchema, hostIdSchema, keyIdSchema, repoIdSchema, worktreeTokenSchema, gitShaSchema } from "./ids.js";
import { scopeSchema } from "./scope.js";
import { evidenceClassSchema } from "./evidence.js";
import { EVENT_KINDS } from "./lifecycle.js";
import { recordTypeSchema } from "./records.js";

export const producerSchema = z
  .object({
    principal: principalIdSchema,
    kind: z.enum(["human", "agent", "host"]),
    host: hostIdSchema,
    session: z.string().optional(),
    turn: z.string().optional(),
    /** Caller-supplied label (today's agent_id). Recorded, displayed, never authoritative. */
    asserted_actor: z.string().optional(),
  })
  .strict();

/** The PRODUCING checkout — distinct from where the store lives (gap 4). */
export const sourceSchema = z
  .object({
    repo: repoIdSchema.optional(),
    worktree: worktreeTokenSchema.optional(),
    branch: z.string().optional(),
    commit: gitShaSchema.optional(),
    dirty: z.boolean().optional(),
  })
  .strict();

export const attachmentSchema = z
  .object({
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    bytes: z.number().int().nonnegative(),
    media_type: z.string().min(1),
    source_kind: z.enum(["file", "cli_render", "pr_body", "commit", "issue", "transcript_excerpt", "legacy_record", "other"]),
    source_uri: z.string().optional(),
    anchor: z.string().optional(),
    encoding: z.string().optional(),
    git_oid: gitShaSchema.optional(),
    base: gitShaSchema.optional(),
    head: gitShaSchema.optional(),
  })
  .strict();

export const signatureSchema = z
  .object({ alg: z.literal("ed25519"), key: keyIdSchema, value: z.string().min(1) })
  .strict();

export const legacySchema = z
  .object({
    derived_from_legacy_snapshot: z.boolean(),
    legacy_ambiguity: z.array(z.string()).optional(),
    legacy_status: z.string().optional(),
  })
  .strict();

export const eventEnvelopeSchema = z
  .object({
    v: z.literal(ENVELOPE_V),
    id: ulidSchema,
    kind: z.enum(EVENT_KINDS),
    record: z.object({ type: recordTypeSchema, id: ulidSchema }).strict().optional(),
    scope: scopeSchema,
    producer: producerSchema,
    source: sourceSchema.optional(),
    parents: z.array(ulidSchema).default([]),
    evidence_class: evidenceClassSchema,
    occurred_at: z.string().datetime(),
    payload: z.record(z.unknown()),
    attachments: z.array(attachmentSchema).optional(),
    legacy: legacySchema.optional(),
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    sig: signatureSchema.optional(),
  })
  .strict();

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;
export type EventInput = z.input<typeof eventEnvelopeSchema>;
