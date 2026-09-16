/**
 * Scope-first candidate selection (ADR §3, §7; requirements R13, R14; oracles
 * C25, C12 A13, C19 A05/A12, C05 A11).
 *
 * The single rule this module exists to enforce: **authorization is evaluated
 * before any ranking**. A relevance score, a lexical hit, a graph adjacency or
 * a cache-key collision is never evidence of access rights (C25 invariant 2).
 * Every retrieval path — dense, lexical, graph, chunk, temporal, exact-id,
 * cache, diagnostics, export — calls `selectCandidates` with the same
 * `SelectionRequest`, so there is exactly one place where the predicate lives
 * and exactly one place a control can disable it (the instrument-can-fail
 * switches in `SelectionRequest.disable`).
 *
 * ## Three scope operations, not two
 *
 * `src/contracts/scope.ts` defines two: `scopeMatches` (retrieval relevance,
 * bidirectional on path) and `scopeGoverns` (authority, unidirectional, with a
 * revision binding). Neither is the right predicate for *read visibility*:
 *
 *  - `scopeMatches` is bidirectional, so a query for `src/` would admit a
 *    record the principal may not read, and a record scoped `src/` would be
 *    admitted for a principal authorized only on `src/auth/`.
 *  - `scopeGoverns` is directionally right but carries the revision-binding
 *    clause (a revision-bound rule governs only its exact head). A principal's
 *    read entitlement is not revision-bound in that way; applying it would
 *    make an entitlement evaporate the moment HEAD moved.
 *
 * So this module defines `scopeAuthorizes(envelope, record)`: coverage on the
 * identity components and `pathCovers` on the path, with no revision clause.
 * A contract diff proposing this as a third exported operation is in the lane
 * report; until it lands, the definition lives here and is tested here.
 *
 * ## Selection is the intersection of two predicates
 *
 * 1. **Authorization (hard).** The record's scope must be covered by at least
 *    one scope in the principal's authorized envelope set. Failing this is
 *    `scope_denied` and the record is CUT — never ranked, never counted, never
 *    named in any viewer-facing diagnostic (C25 A6).
 * 2. **Query match (relevance).** `scopeMatches(query, record)` — the ADR's
 *    retrieval operation. Failing this is `out_of_query_scope`: the record is
 *    not a candidate for THIS query, but the principal could have read it, so
 *    naming it in an explain packet leaks nothing.
 *
 * The distinction matters: suppression counts for (1) must be reported without
 * identifiers, while (2) may be reported in full.
 */
import {
  pathCovers,
  scopeMatches,
  normalizePath,
  type Scope,
} from "../contracts/scope.js";
import { digestOf } from "../contracts/canonical.js";

/** Marker path for a 2.x scope string the contract's path rules cannot express. */
export const UNREPRESENTABLE_PREFIX = "\u0000unrepresentable/";

/**
 * True for a scope produced by `legacyScope` from an unrepresentable string
 * (a leading "/", or a ".." segment). Such a record is DENIED, never widened.
 */
export function isUnrepresentableScope(scope: Scope): boolean {
  return (scope.path ?? "").startsWith(UNREPRESENTABLE_PREFIX);
}

/** Explicit, entitlement-gated modes. `strict` is the default and never widens. */
export type RetrievalMode = "strict" | "lessons";

/** Why a candidate did not make it into the returned set. */
export type DenialReason =
  | "scope_denied"
  | "out_of_query_scope"
  | "mode_denied"
  | "endpoint_not_authorized"
  | "chunk_scope_denied"
  | "cache_scope_mismatch";

/**
 * Reasons whose *existence* is reportable to the requesting principal but
 * whose *members* are not. A record the principal may not read must not be
 * identified in any surface they can reach, including explain and operator
 * diagnostics (C25 A6, C19 A05).
 */
export const OPAQUE_REASONS: ReadonlySet<DenialReason> = new Set<DenialReason>([
  "scope_denied",
  "endpoint_not_authorized",
  "chunk_scope_denied",
  "cache_scope_mismatch",
]);

/** The instrument-can-fail switches. Every one of these is OFF in production. */
export interface SelectionControls {
  /** C25 scope-filter-off/dense + /lexical + C05 "scope filter OFF". */
  scope_filter_off?: boolean;
  /** C25 graph-expansion-scope-off: let traversal return unauthorized endpoints. */
  graph_expansion_scope_off?: boolean;
  /** C25 chunk-scope-inheritance-on: chunks inherit the parent document's scope. */
  chunk_scope_inheritance_on?: boolean;
  /** C25 cache-key-principal-off: key the cache on query text alone. */
  cache_key_principal_off?: boolean;
  /** C25 diagnostics-redaction-off: let explain emit suppressed identifiers. */
  diagnostics_redaction_off?: boolean;
  /** C25 strict-fallback-on: on zero in-scope results, broaden to the parent scope. */
  strict_fallback_on?: boolean;
  /** C25 entitlement-check-off: stop gating `lessons` on the entitlement. */
  entitlement_check_off?: boolean;
  /** C25 history-view-leak-on: let the historical path bypass the scope filter. */
  history_view_leak_on?: boolean;
}

export interface SelectionRequest {
  /** The requesting principal. Part of every cache key (C25 A5). */
  principal: string;
  /**
   * The principal's authorized scope envelope set. A record is readable when
   * at least one envelope covers it. An EMPTY set authorizes nothing — the
   * conservative default, so a caller that forgets to pass it gets zero
   * results rather than the whole store.
   */
  authorized: readonly Scope[];
  /** What this query is about. Relevance, not authority. */
  query: Scope;
  mode?: RetrievalMode;
  /** Does this principal hold `cross_scope_lessons:read` for the query tenant? */
  lessons_entitled?: boolean;
  /** Instrument controls. Never set outside tests. */
  disable?: SelectionControls;
}

export interface SelectionOutcome<T> {
  /** Survivors, in the order the caller supplied them. Ranking happens AFTER. */
  admitted: T[];
  /** Counts by reason. Never identifiers for an opaque reason. */
  suppressed: Record<string, number>;
  /** Ids suppressed for a reportable (non-opaque) reason only. */
  suppressed_visible: Array<{ id: string; reason: DenialReason }>;
  /**
   * EVERY suppression, opaque ones included.
   *
   * Recorded rather than discarded so an operator holding `rule` capability can
   * audit what the gate cut — and, just as importantly, so the
   * `diagnostics-redaction-off` control has something to leak. A control that
   * cannot make C25 A6 fail would leave that assertion passing vacuously.
   *
   * NEVER render this to a requesting principal. `explainFor` uses
   * `suppressed_visible`; only `explainOperator` with rule capability reads this.
   */
  suppressed_detail: Array<{ id: string; reason: DenialReason }>;
  /**
   * The terminal outcome code. `no_in_scope_evidence` is a distinct, explicit
   * answer from `ok` with an empty set — C25 A10 requires the difference to be
   * observable, and requires that nothing broadens to fill the gap.
   */
  outcome: "ok" | "no_in_scope_evidence" | "scope_mode_denied";
  /** Set when `outcome === "scope_mode_denied"`: which entitlement was absent. */
  missing_entitlement?: string;
  /** The applied filters, for the explain packet. Safe to show the requester. */
  filters: {
    mode: RetrievalMode;
    authorized_digest: string;
    query_scope: Scope;
    scope_filter_applied: boolean;
  };
}

/**
 * Read visibility: does `envelope` cover `record`?
 *
 * Unidirectional (an envelope for `src/` covers `src/auth/`, never the
 * reverse), exact on the identity components, and — unlike `scopeGoverns` —
 * with **no revision clause**, because a read entitlement is not bound to the
 * head it was granted at.
 *
 * An envelope that names no `repo` authorizes nothing unless it declares
 * `global: true`; the same deny-by-default shape `scopeGoverns` uses.
 */
export function scopeAuthorizes(envelope: Scope, record: Scope): boolean {
  const IDENTITY = ["tenant", "repo", "task", "attempt", "consumer"] as const;
  for (const k of IDENTITY) {
    const e = envelope[k];
    if (e === undefined) {
      // An envelope silent on `repo` must be explicitly global.
      if (k === "repo" && envelope.global !== true) return false;
      continue;
    }
    if (k === "repo" && record[k] === undefined && record.global === true) {
      // A store-global record is readable by anyone authorized in the store.
      continue;
    }
    if (record[k] !== e) return false;
  }
  if (envelope.path !== undefined && !pathCovers(envelope.path, record.path)) {
    return false;
  }
  return true;
}

/** Is `record` readable by a principal holding this envelope set? */
export function authorizes(envelopes: readonly Scope[], record: Scope): boolean {
  for (const env of envelopes) if (scopeAuthorizes(env, record)) return true;
  return false;
}

/**
 * A stable digest of an authorized envelope set. Two principals with the same
 * entitlements share a cache partition; anyone else does not (C25 A5).
 */
export function authorizedDigest(envelopes: readonly Scope[]): string {
  const normalized = envelopes
    .map((s) => ({ ...s, path: normalizePath(s.path) }))
    .sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  return digestOf(normalized);
}

/**
 * The cache key. Principal AND authorized-scope digest AND mode are part of
 * it, so a warm entry produced for one principal is a MISS for another rather
 * than a cross-scope serve. The `cache_key_principal_off` control drops them,
 * which is exactly the leak C25 A5 measures.
 */
export function cacheKey(req: SelectionRequest, queryText: string): string {
  if (req.disable?.cache_key_principal_off) return `q:${queryText}`;
  return [
    "q",
    queryText,
    "p",
    req.principal,
    "a",
    authorizedDigest(req.authorized),
    "m",
    req.mode ?? "strict",
    "s",
    digestOf(req.query),
  ].join(" ");
}

/**
 * May a cached entry produced under `producedUnder` be served to `req`?
 *
 * Only when the requester's envelope set covers every envelope the entry was
 * produced under — i.e. the requester could have retrieved all of it itself.
 * Any other hit is a miss plus a recorded denial, never a serve.
 */
export function cacheServable(
  req: SelectionRequest,
  producedUnder: readonly Scope[],
): boolean {
  if (req.disable?.cache_key_principal_off) return true;
  return producedUnder.every((s) => authorizes(req.authorized, s));
}

/**
 * The gate. Pure, path-agnostic, and applied BEFORE any scoring.
 *
 * `getScope` is how each path names a candidate's own scope. The chunk path
 * passes the CHUNK's scope, not the parent document's — scope is a property of
 * the thing retrieved (C25 A4). The `chunk_scope_inheritance_on` control makes
 * the caller pass the parent's scope instead, which is the bug that assertion
 * measures.
 */
export function selectCandidates<T>(
  candidates: readonly T[],
  getScope: (c: T) => Scope,
  getId: (c: T) => string,
  req: SelectionRequest,
  /**
   * The scope under which a candidate should be tested for QUERY RELEVANCE,
   * when that differs from the scope it is AUTHORIZED by.
   *
   * These are two different questions and conflating them loses real answers.
   * A 2.x decision scoped `src/payments/` that names `src/auth/jwt.ts` in its
   * `affected_files` is a genuine answer to "what constrains src/auth/" — the
   * project's own Gate 1 asks exactly that question of a file path. Its
   * AUTHORIZATION is still decided by its own scope (`src/payments/`); only its
   * RELEVANCE is decided by the file that matched.
   *
   * Defaults to `getScope`, so a caller that does not distinguish the two gets
   * the strict behaviour.
   */
  getQueryScope: (c: T) => Scope = getScope,
): SelectionOutcome<T> {
  const mode = req.mode ?? "strict";
  const suppressed: Record<string, number> = {};
  const suppressedVisible: Array<{ id: string; reason: DenialReason }> = [];
  const suppressedDetail: Array<{ id: string; reason: DenialReason }> = [];
  const bump = (r: DenialReason, id: string): void => {
    suppressed[r] = (suppressed[r] ?? 0) + 1;
    suppressedDetail.push({ id, reason: r });
    if (!OPAQUE_REASONS.has(r)) suppressedVisible.push({ id, reason: r });
  };

  const filters = {
    mode,
    authorized_digest: authorizedDigest(req.authorized),
    query_scope: req.query,
    scope_filter_applied: req.disable?.scope_filter_off !== true,
  };

  // `lessons` is an explicitly named, entitlement-gated channel. Without the
  // entitlement it is DENIED — it never degrades to `strict`, and the denial
  // is distinguishable from "the channel is empty" (C25 A9).
  if (mode === "lessons" && !req.lessons_entitled && !req.disable?.entitlement_check_off) {
    return {
      admitted: [],
      suppressed: { mode_denied: candidates.length },
      suppressed_visible: [],
      suppressed_detail: candidates.map((c) => ({ id: getId(c), reason: "mode_denied" as DenialReason })),
      outcome: "scope_mode_denied",
      missing_entitlement: `cross_scope_lessons:read@${req.query.tenant ?? req.query.repo ?? "unknown"}`,
      filters,
    };
  }

  const admitted: T[] = [];
  for (const c of candidates) {
    const scope = getScope(c);
    const queryScope = getQueryScope(c);
    const id = getId(c);

    // --- 1. AUTHORIZATION. Hard, first, before anything else. ---
    //
    // A scope we cannot represent is a scope we cannot authorize. Denying is
    // the only safe answer: the alternative (an absent path) is the WILDCARD in
    // `pathCovers`, which makes such a record match every query instead of
    // none. Counted under the opaque `scope_denied` reason like any other
    // authorization failure, so the cut is visible without naming the record.
    if (!req.disable?.scope_filter_off && isUnrepresentableScope(scope)) {
      bump("scope_denied", id);
      continue;
    }
    if (!req.disable?.scope_filter_off && !authorizes(req.authorized, scope)) {
      bump("scope_denied", id);
      continue;
    }

    // --- 2. QUERY RELEVANCE. ---
    // This is a hard filter too, not a ranking signal. Gap 3 is precisely the
    // absence of it on the semantic path: a decision from an unrelated part of
    // the tree entered every briefing because its text matched the task.
    // `scope_filter_off` turns off the WHOLE pre-ranking gate — C25's control
    // names one switch ("the pre-ranking scope predicate"), and the split into
    // authorization and relevance is an implementation detail beneath it.
    if (req.disable?.scope_filter_off) {
      admitted.push(c);
      continue;
    }
    if (mode === "strict") {
      if (!scopeMatches(req.query, queryScope)) {
        bump("out_of_query_scope", id);
        continue;
      }
    } else {
      // `lessons`: same tenant/repo, ANY path. The path component is dropped
      // from the query; the identity components are not. This is a narrow
      // authorized channel, not a general widening — the authorization check
      // above still ran, so an unentitled scope is still invisible.
      const { path: _path, ...identity } = req.query;
      if (!scopeMatches(identity as Scope, queryScope)) {
        bump("out_of_query_scope", id);
        continue;
      }
    }

    admitted.push(c);
  }

  // Strict mode with nothing in scope returns an explicit outcome and NOTHING
  // ELSE. No nearest-scope, no best-effort, no similarity fallback (C25 A10).
  // The `strict_fallback_on` control is what a broadening implementation would
  // look like; it exists only so the assertion can be shown to be live.
  if (admitted.length === 0 && mode === "strict") {
    if (req.disable?.strict_fallback_on) {
      const broadened = candidates.filter((c) =>
        req.disable?.scope_filter_off ? true : authorizes(req.authorized, getScope(c)),
      );
      return { admitted: broadened, suppressed, suppressed_visible: suppressedVisible, suppressed_detail: suppressedDetail, outcome: "ok", filters };
    }
    return {
      admitted: [],
      suppressed,
      suppressed_visible: suppressedVisible,
      suppressed_detail: suppressedDetail,
      outcome: "no_in_scope_evidence",
      filters,
    };
  }

  return { admitted, suppressed, suppressed_visible: suppressedVisible, suppressed_detail: suppressedDetail, outcome: "ok", filters };
}

/**
 * Exact-id read. An id outside the authorized envelope returns
 * `not_found_in_scope` — the SAME shape as a genuinely absent record, so the
 * caller cannot use the error to probe for existence, and never the record.
 *
 * This is the path `EventStore.get(recordId)` leaves open today: it reads the
 * projections table with no scope predicate at all.
 */
export type ReadByIdResult<T> =
  | { ok: true; record: T }
  | { ok: false; reason: "not_found_in_scope" };

export function readByIdInScope<T>(
  record: T | null | undefined,
  getScope: (c: T) => Scope,
  req: SelectionRequest,
): ReadByIdResult<T> {
  if (!record) return { ok: false, reason: "not_found_in_scope" };
  if (!req.disable?.scope_filter_off && !authorizes(req.authorized, getScope(record))) {
    return { ok: false, reason: "not_found_in_scope" };
  }
  return { ok: true, record };
}

/**
 * Graph traversal. Neighbours outside the authorized set are CUT, not ranked
 * and not scored. The relation itself may be reported as
 * `endpoint_not_authorized` — that tells the caller the traversal stopped
 * without disclosing the neighbour's id, title, body or score (C25 A3).
 */
export interface NeighborEdge<N> {
  relation_id: string;
  relation_type: string;
  neighbor: N;
}

export interface NeighborOutcome<N> {
  admitted: Array<NeighborEdge<N>>;
  /** Edges whose far endpoint the principal may not read. No neighbour data. */
  cut: Array<{ relation_id: string; relation_type: string; reason: "endpoint_not_authorized" }>;
}

export function selectNeighbors<N>(
  edges: readonly NeighborEdge<N>[],
  getScope: (n: N) => Scope,
  req: SelectionRequest,
): NeighborOutcome<N> {
  const admitted: Array<NeighborEdge<N>> = [];
  const cut: NeighborOutcome<N>["cut"] = [];
  for (const e of edges) {
    const ok =
      req.disable?.graph_expansion_scope_off === true ||
      req.disable?.scope_filter_off === true ||
      authorizes(req.authorized, getScope(e.neighbor));
    if (ok) admitted.push(e);
    else cut.push({ relation_id: e.relation_id, relation_type: e.relation_type, reason: "endpoint_not_authorized" });
  }
  return { admitted, cut };
}

/* ------------------------------------------------------------------ */
/* 2.x compatibility                                                    */
/* ------------------------------------------------------------------ */

/**
 * 2.x stores carry a scope as a bare path string and have no repo identity in
 * the record. The store's `repo_id` (from `.twining/store.json` when the file
 * exists at format 3, else a synthetic per-store identity) is the repo for
 * EVERY record in that store, so the identity component is supplied by the
 * caller rather than parsed out of the string.
 *
 * `"project"` is 2.x's repo-wide scope; it becomes an absent path (the
 * wildcard), not a directory literally named `project`.
 */
export const LEGACY_PROJECT_SCOPE = "project";

export function legacyScope(scopeString: string | undefined, repo: string): Scope {
  const raw = (scopeString ?? "").trim();
  if (raw === "" || raw === LEGACY_PROJECT_SCOPE) return { repo };
  // An unrepresentable scope string FAILS CLOSED.
  //
  // A 2.x scope can be a module name or a symbol, not only a path, and some are
  // strings the contract's path refinement rejects outright (a leading "/", or
  // a ".." segment). An earlier version returned a bare `{ repo }` for those,
  // reasoning that widening is the safe direction for authorization. That is
  // true of authorization and FALSE of relevance, and `selectCandidates` uses
  // the same derived scope for both: an absent `path` is the wildcard in
  // `pathCovers`, so `docs/../secrets` matched EVERY query in the store instead
  // of none. Universally visible, not universally invisible.
  //
  // The sentinel below is a path no real record and no real query can produce
  // (a NUL byte is not legal in a path), so it matches nothing in either
  // direction while remaining stable and inspectable.
  if (raw.startsWith("/") || raw.includes("..")) {
    return { repo, path: `${UNREPRESENTABLE_PREFIX}${digestOf(raw).slice(7, 23)}` };
  }
  return { repo, path: normalizePath(raw) };
}



/**
 * The authorized envelope a 2.x caller gets: the whole store's repo.
 *
 * ## What this does NOT buy
 *
 * It does not give the 2.x path cross-repo isolation. `legacyScope` stamps the
 * READER's repo id onto every candidate, so the repo component is equal by
 * construction and can never deny. A record ingested from a foreign records
 * tree is indistinguishable here, because 2.x rows carry no origin identity to
 * compare against — that is a property of the 2.x schema, not of this gate.
 *
 * An earlier docstring claimed the R13 cross-repo filter was in force on this
 * path. It was not, and asserting a control the code does not implement is more
 * dangerous than the missing control: a reader who believes it stops looking.
 * On the 2.x path the STORE BOUNDARY is the only repo boundary.
 *
 * What the gate does buy on 2.x: segment-boundary path matching (so `src/auth`
 * no longer matches `src/authz`), fail-closed handling of unrepresentable
 * scopes, and one predicate shared with the v3 path — where repo identity is
 * real, because records carry their own `scope.repo` from the event envelope.
 *
 * Closing the 2.x gap needs an origin field on the row (store.json `repo_id`
 * recorded at ingest); that is lane 02's migration surface, not this one.
 */
export function legacyEnvelope(repo: string): Scope[] {
  return [{ repo }];
}
