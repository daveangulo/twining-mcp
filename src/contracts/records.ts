/**
 * Record types and their `created` payload schemas (ADR §1.3). Record bodies
 * PASS THROUGH unknown fields (bodies evolve; the envelope does not) but the
 * fields that carry meaning for lifecycle, retrieval and authority are typed.
 */
import { z } from "zod";
import { ulidSchema, principalIdSchema, hostIdSchema, storeIdSchema, gitShaSchema } from "./ids.js";
import { scopeSchema } from "./scope.js";

export const RECORD_TYPES = [
  "decision",
  "post",
  "entity",
  "relation",
  "handoff",
  "work",
  "principal",
  "membership",
  "observation",
  "ruling",
] as const;
export type RecordType = (typeof RECORD_TYPES)[number];
export const recordTypeSchema = z.enum(RECORD_TYPES);

/** Unit of partial supersession/revocation (C16). A part may narrow the record's scope; its evidence class and version are projection state derived from the event that last established it. */
const decisionPart = z.object({ part_id: z.string().min(1), text: z.string().min(1), scope: scopeSchema.optional() }).strict();

export const decisionBodySchema = z
  .object({
    summary: z.string().min(1),
    context: z.string().optional(),
    rationale: z.string().min(1),
    rationale_source: z.enum(["authored", "derived"]).optional(),
    constraints: z.array(z.string()).optional(),
    alternatives: z
      .array(
        z.object({
          option: z.string().min(1),
          pros: z.array(z.string()).optional(),
          cons: z.array(z.string()).optional(),
          reason_rejected: z.string().optional(),
        }),
      )
      .optional(),
    depends_on: z.array(ulidSchema).optional(),
    assumptions: z.array(z.string()).optional(),
    affected_files: z.array(z.string()).optional(),
    affected_symbols: z.array(z.string()).optional(),
    confidence: z.enum(["high", "medium", "low"]).optional(),
    reversible: z.boolean().optional(),
    domain: z.string().optional(),
    /** Creation-time status: only the two live states are creatable. */
    status: z.enum(["active", "provisional"]).optional(),
    /** Unit of partial supersession (C16). */
    parts: z.array(decisionPart).min(1).optional(),
  })
  .passthrough();

/**
 * `"decision"` is a LEGACY entry_type (draft.3).
 *
 * 2.x blackboard entries could carry entry_type "decision"; v3 models a
 * decision as its own record type, so the value must be representable for
 * migration to import old bytes faithfully — but it must NOT be producible by
 * a live client, which would fork the decision surface in two. The schema
 * admits it; validate.ts rejects it on every ingress except `migration`.
 */
export const postBodySchema = z
  .object({
    entry_type: z.enum(["need", "offer", "finding", "constraint", "question", "answer", "status", "artifact", "warning", "decision"]),
    summary: z.string().min(1).max(200),
    detail: z.string().optional(),
    tags: z.array(z.string()).optional(),
    relates_to: z.array(ulidSchema).optional(),
  })
  .passthrough();

export const entityBodySchema = z
  .object({ name: z.string().min(1), type: z.string().min(1), properties: z.record(z.string()).optional() })
  .passthrough();

export const relationBodySchema = z
  .object({ source: z.string().min(1), target: z.string().min(1), type: z.string().min(1), properties: z.record(z.string()).optional() })
  .passthrough();

export const handoffBodySchema = z
  .object({ summary: z.string().min(1), source_agent: z.string().min(1), target_agent: z.string().optional() })
  .passthrough();

/** External work references: recorded, never granted (R04). */
export const workBodySchema = z
  .object({
    kind: z.enum(["definition", "assignment", "attempt", "job"]),
    system: z.string().min(1),
    external_id: z.string().min(1),
    owner: z.string().optional(),
    parent: ulidSchema.optional(),
    stage: z.string().optional(),
  })
  .passthrough();

export const principalBodySchema = z
  .object({
    principal_id: principalIdSchema,
    kind: z.enum(["human", "agent", "host"]),
    label: z.string().optional(),
    host: hostIdSchema.optional(),
    /** base64 SPKI DER of an Ed25519 public key. */
    public_key: z.string().optional(),
    key_id: z.string().optional(),
    forked_from: z.string().optional(),
  })
  .strict();

export const membershipBodySchema = z
  .object({
    store_id: storeIdSchema,
    members: z.array(
      z.object({
        principal: principalIdSchema,
        /** propose = may create proposals/inferences/questions only; write = propose + lifecycle transitions; rule = write + authority. */
        roles: z.array(z.enum(["read", "propose", "write", "rule"])).min(1),
        scopes: z.array(scopeSchema).min(1),
      }).strict(),
    ),
    rules: z
      .object({ equal_class_successors: z.enum(["conflict", "author_wins_for_own_records"]).optional() })
      .strict()
      .optional(),
  })
  .strict();

export const observationBodySchema = z
  .object({
    source_kind: z.enum(["file", "cli_render", "pr_body", "commit", "issue", "branch", "permission", "transcript_excerpt", "other"]),
    source_uri: z.string().optional(),
    anchor: z.string().optional(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    normalized_sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    encoding: z.string().optional(),
    git_oid: gitShaSchema.optional(),
    base: gitShaSchema.optional(),
    head: gitShaSchema.optional(),
    observed_at: z.string().datetime(),
    volatile: z.boolean(),
    check_method: z.string().optional(),
    result: z.record(z.unknown()),
  })
  .strict();

export const rulingBodySchema = z
  .object({
    statement: z.string().min(1),
    cites: z.array(ulidSchema).optional(),
    grants: z
      .array(z.object({ principal: principalIdSchema, roles: z.array(z.enum(["read", "propose", "write", "rule"])).min(1), scope: scopeSchema }).strict())
      .optional(),
    supersedes: z.array(ulidSchema).optional(),
    /** Multi-part rulings (C16): the unit of partial supersession/revocation. */
    parts: z.array(decisionPart).min(1).optional(),
    /** Machine-checkable requirements a ruling establishes (C09 prerequisites), instead of tokens parsed out of prose. */
    requirements: z
      .array(z.object({ key: z.string().min(1), value: z.unknown(), applies_to: scopeSchema.optional() }).strict())
      .optional(),
  })
  .strict();

export const recordBodySchemas: Record<RecordType, z.ZodTypeAny> = {
  decision: decisionBodySchema,
  post: postBodySchema,
  entity: entityBodySchema,
  relation: relationBodySchema,
  handoff: handoffBodySchema,
  work: workBodySchema,
  principal: principalBodySchema,
  membership: membershipBodySchema,
  observation: observationBodySchema,
  ruling: rulingBodySchema,
};
