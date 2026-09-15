/**
 * Scope algebra (ADR §3, R06, R13).
 *
 * A scope is a tuple; components absent on an EVENT are wildcards only for
 * `path` (a repo-wide statement). An event with no `repo` must declare
 * `global: true`. Path matching is on segment boundaries: "src/auth" never
 * matches "src/authz".
 *
 * Two operations, deliberately distinct:
 *  - scopeMatches(query, event): retrieval — bidirectional on path (a query
 *    for src/ sees src/auth/ records and vice versa), exact on the identity
 *    components the query names.
 *  - scopeGoverns(rule, target): authority — unidirectional; the rule's scope
 *    must cover the target's scope on every component the rule names.
 */
import { z } from "zod";
import { gitShaSchema, repoIdSchema, tenantIdSchema } from "./ids.js";

export const revisionSchema = z
  .object({ base: gitShaSchema.optional(), head: gitShaSchema.optional() })
  .strict();

export const scopeSchema = z
  .object({
    tenant: tenantIdSchema.optional(),
    repo: repoIdSchema.optional(),
    path: z
      .string()
      .refine((p) => !p.startsWith("/") && !p.includes(".."), "path must be repo-relative")
      .optional(),
    task: z.string().min(1).optional(),
    attempt: z.string().min(1).optional(),
    consumer: z.string().min(1).optional(),
    revision: revisionSchema.optional(),
    global: z.boolean().optional(),
  })
  .strict()
  .refine((s) => s.repo !== undefined || s.global === true, {
    message: "a scope without repo must declare global: true",
  });
export type Scope = z.infer<typeof scopeSchema>;

export function normalizePath(p: string | undefined): string {
  if (!p) return "";
  return p.replace(/\/+$/, "").replace(/^\.\//, "");
}

/** broad covers narrow on a segment boundary; "" covers everything. */
export function pathCovers(broad: string | undefined, narrow: string | undefined): boolean {
  const b = normalizePath(broad);
  const n = normalizePath(narrow);
  if (b === "") return true;
  return n === b || n.startsWith(b + "/");
}

const IDENTITY_KEYS = ["tenant", "repo", "task", "attempt", "consumer"] as const;

/** Retrieval match (see module doc). */
export function scopeMatches(query: Scope, event: Scope): boolean {
  for (const k of IDENTITY_KEYS) {
    const q = query[k];
    if (q === undefined) continue;
    const e = event[k];
    if (k === "repo" && e === undefined && event.global === true) continue; // global events match every repo query
    if (e !== q) return false;
  }
  if (query.path !== undefined && event.path !== undefined) {
    if (!pathCovers(event.path, query.path) && !pathCovers(query.path, event.path)) return false;
  }
  return true;
}

/** Authority coverage: does `rule` govern `target`? */
export function scopeGoverns(rule: Scope, target: Scope): boolean {
  for (const k of IDENTITY_KEYS) {
    const r = rule[k];
    if (r === undefined) {
      if (k === "repo" && rule.global !== true) return false; // a rule must name a repo or be global
      continue;
    }
    if (target[k] !== r) return false;
  }
  if (rule.path !== undefined && !pathCovers(rule.path, target.path)) return false;
  if (rule.revision?.head !== undefined) {
    // A revision-bound rule governs only the exact head it was made for.
    if (target.revision?.head !== rule.revision.head) return false;
  }
  return true;
}
