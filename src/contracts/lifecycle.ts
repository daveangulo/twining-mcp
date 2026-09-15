/**
 * Lifecycle event kinds, per-kind payload schemas and the transition table
 * (ADR §4). Payloads for lifecycle kinds are STRICT (no unknown keys) so an
 * unknown semantic from a newer client is quarantined rather than half-applied.
 */
import { z } from "zod";
import { ulidSchema, gitShaSchema, principalIdSchema } from "./ids.js";
import { scopeSchema } from "./scope.js";

export const LIFECYCLE_KINDS = [
  "promoted",
  "reconsidered",
  "superseded",
  "overridden",
  "corrected",
  "contested",
  "conflict_resolved",
  "archived",
  "restored",
  "resolved",
  "acknowledged",
  "amended",
  "commit_linked",
  "retracted",
  "revoked",
  "tombstoned",
] as const;
export type LifecycleKind = (typeof LIFECYCLE_KINDS)[number];

export const EVENT_KINDS = ["created", ...LIFECYCLE_KINDS, "receipt"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

const target = { target: ulidSchema };
const reason = { reason: z.string().min(1).optional() };

export const lifecyclePayloadSchemas: Record<LifecycleKind, z.ZodTypeAny> = {
  promoted: z.object({ ...target }).strict(),
  reconsidered: z.object({ ...target, ...reason }).strict(),
  superseded: z
    .object({ ...target, by: ulidSchema, parts: z.array(z.string().min(1)).min(1).optional(), ...reason })
    .strict(),
  overridden: z.object({ ...target, replacement: ulidSchema.optional(), reason: z.string().min(1) }).strict(),
  corrected: z
    .object({
      ...target,
      correction: z.record(z.unknown()),
      applies_to: scopeSchema,
      ...reason,
    })
    .strict(),
  contested: z.object({ ...target, by: ulidSchema, reason: z.string().min(1) }).strict(),
  conflict_resolved: z
    .object({ conflict_id: z.string().min(1), winner: ulidSchema, losers: z.array(ulidSchema).min(1), reason: z.string().min(1) })
    .strict(),
  archived: z.object({ ...target, ...reason }).strict(),
  restored: z.object({ ...target, ...reason }).strict(),
  resolved: z.object({ ...target, note: z.string().optional() }).strict(),
  acknowledged: z.object({ ...target }).strict(),
  amended: z
    .object({
      ...target,
      add_affected_files: z.array(z.string().min(1)).default([]),
      add_affected_symbols: z.array(z.string().min(1)).default([]),
      reason: z.string().min(1),
    })
    .strict(),
  commit_linked: z.object({ ...target, commit: gitShaSchema }).strict(),
  retracted: z.object({ ...target, reason: z.string().min(1) }).strict(),
  revoked: z.object({ ...target, reason: z.string().min(1) }).strict(),
  tombstoned: z.object({ ...target, reason: z.string().min(1), purge: z.boolean().default(false) }).strict(),
};

/** Capability a principal needs in the event's scope to request a kind. */
export type Capability = "write" | "own" | "rule";

/** Transition table (ADR §4.2): who may request each kind. */
export const REQUIRED_CAPABILITY: Record<Exclude<EventKind, "created" | "receipt">, Capability> = {
  promoted: "write",
  reconsidered: "write",
  superseded: "write",
  overridden: "write",
  corrected: "write",
  contested: "write",
  conflict_resolved: "rule",
  archived: "write",
  restored: "write",
  resolved: "write",
  acknowledged: "write",
  amended: "write",
  commit_linked: "write",
  retracted: "own",
  revoked: "rule",
  tombstoned: "rule",
};

/** Kinds whose application is subject to the evidence-class rank rule (ADR §4.3 rule 1). */
export const CLASS_RANKED_KINDS: ReadonlySet<EventKind> = new Set(["superseded", "overridden", "corrected"]);

export const receiptPayloadSchema = z
  .object({
    stage: z.enum(["received", "admitted", "projected", "injected", "task_acked"]),
    consumer: principalIdSchema,
    events: z.array(ulidSchema).min(1).optional(),
    cursor: z.object({ transport: z.string().min(1), position: z.string().min(1) }).strict().optional(),
    host: z.string().optional(),
    session: z.string().optional(),
    turn: z.string().optional(),
    payload_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
  })
  .strict()
  .refine((r) => r.events !== undefined || r.cursor !== undefined, { message: "a receipt names events or a cursor" });
