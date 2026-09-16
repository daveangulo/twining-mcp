/**
 * Scope algebra (ADR §3, R06, R13).
 *
 * A scope is a tuple; components absent on an EVENT are wildcards only for
 * `path` (a repo-wide statement). An event with no `repo` must declare
 * `global: true`. Path matching is on segment boundaries: "src/auth" never
 * matches "src/authz".
 *
 * THREE operations, deliberately distinct (draft.3 adopts the third from
 * lane 04, which proved it in src/retrieval/select.ts):
 *  - scopeMatches(query, event): retrieval RELEVANCE — bidirectional on path (a
 *    query for src/ sees src/auth/ records and vice versa), exact on the
 *    identity components the query names.
 *  - scopeGoverns(rule, target): AUTHORITY — unidirectional; the rule's scope
 *    must cover the target's scope on every component the rule names, and a
 *    revision-bound rule governs only its exact head.
 *  - scopeAuthorizes(envelope, record): read VISIBILITY — unidirectional like
 *    scopeGoverns, identity-exact, but with NO revision clause, because a read
 *    entitlement is not bound to the head it was granted at.
 *
 * Neither of the first two is the right predicate for read visibility:
 * scopeMatches is bidirectional, so a query for src/ would admit a record the
 * principal may not read; scopeGoverns is directionally right but its revision
 * binding would make an entitlement evaporate the moment HEAD moved.
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

/**
 * Read visibility: does `envelope` cover `record`?
 *
 * Unidirectional (an envelope for `src/` covers `src/auth/`, never the
 * reverse), exact on the identity components, and — unlike `scopeGoverns` —
 * with no revision clause. An envelope that names no `repo` authorizes nothing
 * unless it declares `global: true`: the same deny-by-default shape.
 *
 * A store-global RECORD (no repo, `global: true`) is readable by anyone
 * authorized in the store, which is the one asymmetry with scopeGoverns.
 */
export function scopeAuthorizes(envelope: Scope, record: Scope): boolean {
  for (const k of IDENTITY_KEYS) {
    const e = envelope[k];
    if (e === undefined) {
      if (k === "repo" && envelope.global !== true) return false;
      continue;
    }
    if (k === "repo" && record[k] === undefined && record.global === true) continue;
    if (record[k] !== e) return false;
  }
  if (envelope.path !== undefined && !pathCovers(envelope.path, record.path)) return false;
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
