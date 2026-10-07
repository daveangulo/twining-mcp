/**
 * Context assembly engine.
 * Builds tailored context packages for agent tasks within token budgets.
 * Uses weighted multi-signal scoring: recency, relevance, confidence, warning boost.
 */
import { SEARCH_NOISE_FLOOR, type SearchEngine } from "../embeddings/search.js";
import type { GraphEngine } from "./graph.js";
import type { PlanningBridge } from "./planning-bridge.js";
import type {
  AssembledContext,
  BlackboardEntry,
  Decision,
  SummarizeResult,
  TwiningConfig,
  WhatChangedResult,
} from "../utils/types.js";
import { DEFAULT_LIVENESS_THRESHOLDS } from "../utils/liveness.js";
import { computeLiveness } from "../utils/liveness.js";
import { computeResolvedIds } from "./resolution.js";
import { normalizeTags } from "../utils/tags.js";
import { estimateTokens } from "../utils/tokens.js";
import type { RetrievalAnnex } from "../utils/types.js";
import { dedupeFullSummary } from "../utils/full-summary.js";
import type { IAgentStore, IBlackboardStore, IDecisionStore, IHandoffStore } from "../storage/interfaces.js";
import {
  selectCandidates,
  legacyScope,
  legacyEnvelope,
  type RetrievalMode,
  type SelectionRequest,
  type SelectionOutcome,
} from "../retrieval/select.js";
import { storeIdentity, deriveRepoId, type StoreIdentity } from "../retrieval/store-identity.js";
import { estimate as estimateConservative, TOKENIZER_ID, ACTIVE_TABLE } from "../retrieval/tokenizer.js";
import { classifyLegacy } from "../retrieval/lifecycle.js";
import { hashBytes } from "../retrieval/receipts.js";
import { CLASS_PRESENTATION } from "../retrieval/render.js";

export type { RetrievalAnnex };

/** The assembler's own return type: AssembledContext plus the lane-04 annex. */
export type AssembledContextV3 = AssembledContext & { retrieval: RetrievalAnnex };

/** Most ids we will ever ship in an explain annex. Counts stay complete. */
const SUPPRESSED_VISIBLE_CAP = 20;

/**
 * Cap the sample of named suppressions.
 *
 * The full list is one object per authorized-but-out-of-query-path record, so
 * it scales with the STORE. Since `context.ts` returns the annex to the caller,
 * an uncapped list was an unbounded payload outside every budget the lane
 * added. The counts in `suppressed` remain exact; this is a diagnostic sample.
 */
function capSuppressed(all: Array<{ id: string; reason: string }>): {
  suppressed_visible: Array<{ id: string; reason: string }>;
  suppressed_visible_truncated?: number;
} {
  if (all.length <= SUPPRESSED_VISIBLE_CAP) return { suppressed_visible: all };
  return {
    suppressed_visible: all.slice(0, SUPPRESSED_VISIBLE_CAP),
    suppressed_visible_truncated: all.length - SUPPRESSED_VISIBLE_CAP,
  };
}

/**
 * The scope a decision should be matched for RELEVANCE under, given the query.
 *
 * `DecisionStore.getByScope` admits a record three ways: its own scope, a file
 * in `affected_files`, or an exact `affected_symbols` hit. When the record was
 * admitted by a FILE, the file is what makes it relevant to the query — not the
 * record's own scope, which may be anywhere. Returning the matched file lets
 * the relevance predicate see the same relationship `getByScope` saw, while
 * authorization keeps using the record's own scope.
 *
 * Falls back to the record's own scope when nothing else matched, so a record
 * that only collides on a partial path segment is still cut.
 */
function matchedScopeFor(d: Decision, query: string): string {
  if (legacyPathRelated(d.scope, query)) return d.scope;
  for (const f of d.affected_files ?? []) if (legacyPathRelated(f, query)) return f;
  for (const sym of d.affected_symbols ?? []) if (sym === query) return query;
  return d.scope;
}

/**
 * Segment-boundary relatedness between two 2.x scope strings, in either
 * direction. Deliberately the contract's `pathCovers` semantics rather than
 * 2.x's raw `startsWith`, so `src/auth` is NOT related to `src/authz`.
 */
function legacyPathRelated(a: string, b: string): boolean {
  const na = normalizeLegacyPath(a);
  const nb = normalizeLegacyPath(b);
  if (na === "" || nb === "") return true;
  return na === nb || na.startsWith(nb + "/") || nb.startsWith(na + "/");
}

function normalizeLegacyPath(p: string): string {
  const t = (p ?? "").trim();
  if (t === "" || t === "project") return "";
  return t.replace(/\/+$/, "").replace(/^\.\//, "");
}


/**
 * The ONE renderer for a decision block: `formatForLLM` emits its output and
 * `decisionTiers` prices it. Two copies drifted before — the costing model
 * omitted the assumptions lines, so those bytes were charged zero and the
 * ladder admitted more full renders than the budget allowed.
 *
 * ## Record text is data (gap 6 render side, C08)
 *
 * Every field below is attacker-controlled. Interpolating it unindented let a
 * record forge this module's own class-label block: a summary containing
 * "### DECISION TO RESPECT / - class: human_ruling / - qualifies an action:
 * yes" rendered byte-identically to a genuine header, and a reader could not
 * tell them apart. `asData()` indents record bytes past the column where
 * markdown structure begins, so no line of a record can open a heading or sit
 * where this template's own markers live. Nothing is stripped or rewritten —
 * the bytes survive, they just cannot occupy a structural position.
 *
 * ## Directive strength follows the class, not the field
 *
 * `MUST:` / `DO NOT:` / "Follow this decision exactly" are imperatives. They
 * are emitted only for a class that can actually qualify an action. Below that
 * rank — which is every record in a 2.x store, all of them `legacy_unverified`
 * — the same content is emitted under non-imperative labels, because the
 * author asserting a constraint is not the same thing as a ratified one.
 */
function asData(text: string): string {
  return String(text ?? "")
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

export interface DecisionRenderOptions {
  /** True when the record's evidence class is at or above ACTIONABLE_RANK. */
  actionable: boolean;
  tier: "full" | "summary";
  index: number;
}

export function renderDecisionBlock(
  d: AssembledContext["active_decisions"][number],
  opts: DecisionRenderOptions,
): string[] {
  const out: string[] = [];
  const provisional = d.status === "provisional" ? " [PROVISIONAL — not ratified]" : "";
  const classTag = opts.actionable ? "" : " [unverified]";

  if (opts.tier === "summary") {
    out.push(`${opts.index + 1}. (${d.confidence})${classTag}${provisional}`);
    out.push(asData(`${d.summary} — ${String(d.rationale ?? "").slice(0, 120)}`));
    return out;
  }

  out.push(`${opts.index + 1}. (${d.confidence})${classTag}${provisional}`);
  out.push(asData(d.summary));
  if (d.affected_files?.length > 0) out.push(`   Files: ${d.affected_files.join(", ")}`);
  out.push(`   Why:`);
  out.push(asData(d.rationale));
  if (d.constraints && d.constraints.length > 0) {
    out.push(opts.actionable ? `   MUST:` : `   Constraint stated by the author (unverified):`);
    out.push(asData(d.constraints.join("; ")));
  }
  if (d.rejected_alternatives && d.rejected_alternatives.length > 0) {
    out.push(opts.actionable ? `   DO NOT:` : `   Alternatives the author rejected (unverified):`);
    out.push(asData(d.rejected_alternatives.join("; ")));
  }
  if (d.assumptions && d.assumptions.length > 0) {
    if (d.assumptions_status === "challenged" && d.challenged_assumptions?.length) {
      out.push(`   ASSUMPTIONS CHALLENGED:`);
      out.push(asData(d.challenged_assumptions.join("; ")));
      out.push(`   ^ RECONSIDER this decision — evidence suggests assumptions may no longer hold.`);
    } else {
      out.push(`   Assumes:`);
      out.push(asData(d.assumptions.join("; ")));
      out.push(
        opts.actionable
          ? `   ^ Assumptions hold. Follow this decision exactly.`
          : `   ^ Assumptions stated by the author; nothing has verified them.`,
      );
    }
  }
  return out;
}

/** Sum two suppression tallies without losing a reason present in only one. */
function mergeCounts(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = (out[k] ?? 0) + v;
  return out;
}

/** Half-life for recency decay in hours (one week). */
const RECENCY_HALF_LIFE = 168;

// Minimum relevance for an entry to enter the briefing on similarity alone
// (field D12). Shared with search's total_matched counting so "a match" means
// the same thing everywhere; scope-matched entries bypass the floor entirely.
const SEMANTIC_ADMISSION_FLOOR = SEARCH_NOISE_FLOOR;

/** Scored item for budget filling. */
interface ScoredItem {
  type: "decision" | "need" | "warning" | "finding" | "question";
  id: string;
  score: number;
  tokenCost: number;
  data: Decision | BlackboardEntry;
}

export class ContextAssembler {
  private readonly blackboardStore: IBlackboardStore;
  private readonly decisionStore: IDecisionStore;
  private readonly searchEngine: SearchEngine | null;
  private readonly config: TwiningConfig;
  private readonly graphEngine: GraphEngine | null;
  private readonly planningBridge: PlanningBridge | null;
  private readonly handoffStore: IHandoffStore | null;
  private readonly agentStore: IAgentStore | null;

  /** In-memory log of last assembly time per agent (not persisted across restarts). */
  private readonly assemblyLog = new Map<string, string>();

  /**
   * Exact self-authorship signal (field D12): the ids BlackboardEngine
   * posted in this process. A timestamp-vs-process-start heuristic mislabels
   * CONCURRENT sessions sharing the store (the coordination case the lane
   * exists for), and agent_id is a role label, not an identity. Unset (e.g.
   * dashboard-constructed assemblers) means nothing is ever marked.
   */
  private sessionPostIds: ReadonlySet<string> | null = null;
  /** Repo identity for the scope gate. Resolved once, in the constructor. */
  private readonly storeIdentity: StoreIdentity;
  /** Distinguishes stores when no twiningDir was supplied. */
  private static instanceSeq = 0;

  /** Wire the posting session's entry-id set (server.ts). */
  setSessionPostIds(ids: ReadonlySet<string>): void {
    this.sessionPostIds = ids;
  }

  constructor(
    blackboardStore: IBlackboardStore,
    decisionStore: IDecisionStore,
    searchEngine: SearchEngine | null,
    config: TwiningConfig,
    graphEngine?: GraphEngine | null,
    planningBridge?: PlanningBridge | null,
    handoffStore?: IHandoffStore | null,
    agentStore?: IAgentStore | null,
    /**
     * The store root, used ONLY to resolve this store's repo identity for the
     * scope gate (R01/R13). Optional so every existing caller compiles; when
     * absent a per-instance derived identity is minted, which still gives the
     * gate the property it needs (one identity per store, never shared) because
     * one ContextAssembler is constructed per store.
     */
    twiningDir?: string,
  ) {
    this.blackboardStore = blackboardStore;
    this.decisionStore = decisionStore;
    this.searchEngine = searchEngine;
    this.config = config;
    this.graphEngine = graphEngine ?? null;
    this.planningBridge = planningBridge ?? null;
    this.handoffStore = handoffStore ?? null;
    this.agentStore = agentStore ?? null;
    this.storeIdentity = twiningDir
      ? storeIdentity(twiningDir)
      : {
          repo: deriveRepoId(`instance:${ContextAssembler.instanceSeq++}`),
          format: 2,
          derived: true,
          source: "derived-from-path",
        };
  }

  /** Check if an agent has called assemble() recently (in this session). */
  hasRecentAssembly(agentId: string): boolean {
    return this.assemblyLog.has(agentId);
  }

  /**
   * Build tailored context for a specific task within a token budget.
   * Implements spec section 4.3 (twining_assemble).
   */
  async assemble(
    task: string,
    scope: string,
    maxTokens?: number,
    agentId?: string,
    options?: { mode?: RetrievalMode; lessons_entitled?: boolean; principal?: string },
  ): Promise<AssembledContextV3> {
    const budget = maxTokens ?? this.config.context_assembly.default_max_tokens;
    const weights = this.config.context_assembly.priority_weights;
    const now = Date.now();

    // ---------------------------------------------------------------
    // Lane 04 gate 1 — SCOPE BEFORE RANKING (R13/R14, gap 3).
    //
    // 2.x unioned the scope-matched set with an UNFILTERED semantic set, so a
    // decision from any scope in the store entered the briefing whenever its
    // text matched the task string. Scope was a ranking dampener, never an
    // admission gate.
    //
    // The pool is now authorized first and the survivors are what the search
    // engine ever sees. `mode` is explicit: strict (default) never widens;
    // lessons is a same-repo, any-path channel that still runs the auth check.
    // ---------------------------------------------------------------
    const identity = this.storeIdentity;
    const selectionRequest: SelectionRequest = {
      principal: options?.principal ?? agentId ?? "main",
      authorized: legacyEnvelope(identity.repo),
      query: legacyScope(scope, identity.repo),
      mode: options?.mode ?? "strict",
      ...(options?.lessons_entitled ? { lessons_entitled: true } : {}),
    };
    const gate = <T>(
      items: readonly T[],
      getScope: (t: T) => string,
      getId: (t: T) => string,
      /**
       * `{ path: "any" }` drops the QUERY path predicate while keeping the
       * authorization check — same repo, any path. Used only where a
       * cross-path read cannot disclose anything (see the resolution slice).
       */
      relax?: { path: "any" },
      /**
       * The scope a candidate should be matched for RELEVANCE under, when it
       * differs from the scope it is AUTHORIZED by (see `matchedScopeFor`).
       */
      getQueryScope?: (t: T) => string,
    ): SelectionOutcome<T> => {
      const { path: _dropped, ...identityOnly } = selectionRequest.query;
      const req: SelectionRequest = relax?.path === "any"
        ? { ...selectionRequest, query: identityOnly as typeof selectionRequest.query }
        : selectionRequest;
      return selectCandidates(
        items,
        (t) => legacyScope(getScope(t), identity.repo),
        getId,
        req,
        getQueryScope ? (t) => legacyScope(getQueryScope(t), identity.repo) : undefined,
      );
    };

    // Load all data once upfront to avoid redundant disk reads
    const { entries: allEntriesRaw } = await this.blackboardStore.read();
    const allIndexRaw = await this.decisionStore.getIndex();

    // The gate runs on the INDEX (cheap, scope-bearing) so an out-of-scope
    // decision is never even read off disk, let alone embedded or ranked.
    const indexGate = gate(allIndexRaw, (e) => (e as { scope?: string }).scope ?? "", (e) => e.id);
    const entryGate = gate(allEntriesRaw, (e) => e.scope, (e) => e.id);
    const allIndex = indexGate.admitted;
    const allEntries = entryGate.admitted;

    // 1. Retrieve scope-matched decisions — THROUGH THE GATE.
    //
    // This path was the gap-3 bypass: `getByScope` matches with 2.x's raw
    // `startsWith` (so `src/auth` admits `src/authz`) and ALSO on
    // `affected_files` / `affected_symbols`, and its result went straight into
    // `activeDecisions` without ever meeting `selectCandidates`. Only the
    // semantic union was gated, so the module's claim that "the pool is
    // authorized first" held for one of the two paths.
    //
    // The file/symbol match is kept, deliberately. A decision scoped
    // `src/payments/` that names `src/auth/jwt.ts` IS an answer to "what
    // constrains src/auth/" — that is the project's own Gate 1 question. So the
    // record is AUTHORIZED by its own scope and matched for RELEVANCE by
    // whichever file or symbol admitted it.
    const rawScopeDecisions = await this.decisionStore.getByScope(scope);
    const scopeGate = gate(
      rawScopeDecisions,
      (d) => d.scope,
      (d) => d.id,
      undefined,
      (d) => matchedScopeFor(d, scope),
    );
    const scopeDecisions = scopeGate.admitted;
    const activeDecisions = scopeDecisions.filter(
      (d) => d.status === "active" || d.status === "provisional",
    );
    // Archived decisions are invisible below; count them so a blinded gate
    // (e.g. after a bad archive_stale sweep, D3) reads "N archived excluded"
    // instead of the indistinguishable "no decisions exist".
    const archivedExcluded = scopeDecisions.filter(
      (d) => d.status === "archived",
    ).length;
    // Same blindness class for superseded/overridden (field D10): a wholesale
    // supersession of a multi-part record silently withdrew authority from
    // live prose, and Gate 1 printed "No active decisions" with zero trace.
    const supersededExcluded = scopeDecisions.filter(
      (d) => d.status === "superseded" || d.status === "overridden",
    ).length;

    // Finding 1(a): a lessons denial is TERMINAL.
    //
    // Previously only the gated slices went empty on `scope_mode_denied` while
    // the (then ungated) decision path kept merging records, so a denied
    // assemble still shipped decisions under an annex saying the channel was
    // closed. A denial that still returns records is worse than no denial,
    // because the receipt asserts the opposite of what happened.
    const deniedGate = [scopeGate, indexGate, entryGate].find(
      (g) => g.outcome === "scope_mode_denied",
    );
    if (deniedGate) {
      return this.emptyDeniedContext(task, scope, budget, identity, selectionRequest, deniedGate);
    }

    // 2. Retrieve semantically relevant decisions (merge by ID, keep highest relevance)
    const decisionRelevance = new Map<string, number>();
    if (this.searchEngine) {
      const allDecisions: Decision[] = [];
      for (const entry of allIndex) {
        if (entry.status === "active" || entry.status === "provisional") {
          const d = await this.decisionStore.get(entry.id);
          if (d) allDecisions.push(d);
        }
      }

      const { results: semanticDecisions } =
        await this.searchEngine.searchDecisions(task, allDecisions);
      for (const sr of semanticDecisions) {
        decisionRelevance.set(sr.decision.id, sr.relevance);
      }
    }

    // Merge scope-matched and semantic decisions (union by ID)
    const mergedDecisionMap = new Map<string, Decision>();
    for (const d of activeDecisions) {
      mergedDecisionMap.set(d.id, d);
      if (!decisionRelevance.has(d.id)) {
        decisionRelevance.set(d.id, 0.5); // Default relevance for scope-only matches
      }
    }
    if (this.searchEngine) {
      for (const entry of allIndex) {
        if (
          decisionRelevance.has(entry.id) &&
          !mergedDecisionMap.has(entry.id)
        ) {
          const d = await this.decisionStore.get(entry.id);
          if (d && (d.status === "active" || d.status === "provisional")) {
            mergedDecisionMap.set(d.id, d);
          }
        }
      }
    }

    // 3. Retrieve scope-matched blackboard entries (filter from cached allEntries)
    // Exclude entry_type "decision" — legacy-data defense (issue #30). New
    // decisions are no longer cross-posted to the blackboard, but existing
    // field blackboards still hold years of mirror entries; without this
    // filter they would be cast as Decision objects, causing undefined field
    // errors. Real decisions live in the decision store.
    const scopeEntries = allEntries.filter(
      (e) =>
        e.entry_type !== "decision" &&
        (e.scope.startsWith(scope) || scope.startsWith(e.scope)),
    );

    // 4. Retrieve semantically relevant findings
    const entryRelevance = new Map<string, number>();
    if (this.searchEngine) {
      const { results: semanticEntries } =
        await this.searchEngine.searchBlackboard(task, allEntries);
      for (const sr of semanticEntries) {
        entryRelevance.set(sr.entry.id, sr.relevance);
      }
    }

    // Merge entries — scope + semantic
    const mergedEntryMap = new Map<string, BlackboardEntry>();
    for (const e of scopeEntries) {
      mergedEntryMap.set(e.id, e);
      if (!entryRelevance.has(e.id)) {
        entryRelevance.set(e.id, 0.5);
      }
    }
    if (this.searchEngine) {
      for (const e of allEntries) {
        if (
          e.entry_type !== "decision" &&
          entryRelevance.has(e.id) &&
          !mergedEntryMap.has(e.id) &&
          // Relevance floor on semantic-only admission (field D12): the
          // search path has no minimum score, so 10 arbitrary-similarity
          // entries from anywhere on the board entered every assemble.
          // Scope-matched entries are never floored — this gates only what
          // similarity alone drags in.
          entryRelevance.get(e.id)! >= SEMANTIC_ADMISSION_FLOOR
        ) {
          mergedEntryMap.set(e.id, e);
        }
      }
    }

    // Drop obligations that another entry has already resolved, before they are
    // scored — otherwise resolved needs and warnings resurface forever as
    // "REMAINING WORK" and "STOP" directives, and consume budget doing it.
    // Resolved ids come from the FULL live board, not the scope slice: the
    // resolving entry is frequently posted against a different scope. This
    // mirrors triage.ts:207 so assemble, triage, and the archiver agree on
    // what "open" means.
    //
    // DISCOVERED NEED (lane 04): resolution is computed over the
    // AUTHORIZATION slice, not the query slice.
    //
    // Decision 01KYB5EM805A90TR9MR9WK2E04 established that resolved ids must
    // come from the full live board because the resolving entry is frequently
    // posted against a different scope. Gating `allEntries` by the QUERY scope
    // broke that: a cross-scope resolver vanished and resolved needs resurfaced
    // as "REMAINING WORK" forever.
    //
    // Running it over the authorization slice keeps both properties. A
    // resolution only ever REMOVES an in-scope obligation — the resolver's own
    // text, id and scope never enter the briefing — so there is nothing here
    // for a cross-path read to disclose. A cross-REPO resolver is still cut,
    // which is the boundary that matters (R13).
    const resolutionScope = gate(
      allEntriesRaw,
      (e) => e.scope,
      (e) => e.id,
      { path: "any" },
    ).admitted;
    const resolvedIds = computeResolvedIds(resolutionScope);
    for (const [id, entry] of mergedEntryMap) {
      if (
        (entry.entry_type === "need" ||
          entry.entry_type === "warning" ||
          entry.entry_type === "question") &&
        resolvedIds.has(id)
      ) {
        mergedEntryMap.delete(id);
      }
    }

    // 5. Compute graph reachability scores for decisions
    const { scores: reachabilityScores, paths: reachabilityPaths } =
      await this.computeGraphReachability(scope, mergedDecisionMap);

    // 6. Score each item
    const scoredItems: ScoredItem[] = [];
    const graphWeight = weights.graph_reachability ?? weights.graph_connectivity ?? 0;

    // Adaptive weight fallback: if graph returns 0 for all candidates,
    // redistribute graph weight proportionally to other signals
    const maxGraphScore = Math.max(0, ...Array.from(reachabilityScores.values()));
    const effectiveGraphWeight = maxGraphScore === 0 ? 0 : graphWeight;
    const weightScale = maxGraphScore === 0 && graphWeight > 0
      ? 1.0 / (1.0 - graphWeight)
      : 1.0;

    for (const [id, decision] of mergedDecisionMap) {
      const recency = this.recencyScore(decision.timestamp, now);
      const baseRelevance = decisionRelevance.get(id) ?? 0.5;
      const proximity = ContextAssembler.scopeProximity(scope, decision.scope);
      const relevance = baseRelevance * proximity;
      const confidence = this.confidenceScore(decision.confidence);
      const warningBoost = 0;
      const reachability = reachabilityScores.get(id) ?? 0;
      const score =
        recency * weights.recency * weightScale +
        relevance * weights.relevance * weightScale +
        confidence * weights.decision_confidence * weightScale +
        warningBoost * weights.warning_boost * weightScale +
        reachability * effectiveGraphWeight;
      const text = `${decision.summary} ${decision.rationale} ${decision.confidence} ${decision.affected_files.join(", ")}`;
      scoredItems.push({
        type: "decision",
        id,
        score,
        tokenCost: estimateConservative(text).tokens,
        data: decision,
      });
    }

    for (const [id, entry] of mergedEntryMap) {
      const recency = this.recencyScore(entry.timestamp, now);
      // Entries get the same scope-proximity dampening decisions have always
      // had (field D12): without it, a strongly-similar off-scope entry
      // outranked every in-scope warning, and since the caller's own posts
      // are the newest AND often the most task-similar, the lane filled with
      // self-authored material from other scopes.
      const relevance =
        (entryRelevance.get(id) ?? 0.5) *
        ContextAssembler.scopeProximity(scope, entry.scope);
      const confidence = 0.5; // Neutral for non-decisions
      const warningBoost = entry.entry_type === "warning" ? 1.0 : 0.0;
      const score =
        recency * weights.recency * weightScale +
        relevance * weights.relevance * weightScale +
        confidence * weights.decision_confidence * weightScale +
        warningBoost * weights.warning_boost * weightScale;
      // Cost what will actually render (2.16.0 review ENG-2): charging the
      // un-deduped double text made warnings near the budget boundary
      // degrade or drop even though the deduped form fits.
      const deduped = dedupeFullSummary(entry.summary, entry.detail);
      const text = `${deduped.headline} ${deduped.detail}`;
      scoredItems.push({
        type: entry.entry_type as ScoredItem["type"],
        id,
        score,
        tokenCost: estimateConservative(text).tokens,
        data: entry,
      });
    }

    // 7. Fill token budget in priority order.
    // Warnings get priority access — they fill first from the full budget.
    // Non-warnings fill the remaining budget, but are capped at 90% of the
    // total budget to ensure at least 10% is reserved for warnings.
    const warningReserve = Math.floor(budget * 0.1);
    const nonWarningCap = budget - warningReserve;

    // Separate warnings and non-warnings
    const warnings = scoredItems.filter((i) => i.type === "warning");
    const nonWarnings = scoredItems.filter((i) => i.type !== "warning");

    warnings.sort((a, b) => b.score - a.score);
    nonWarnings.sort((a, b) => b.score - a.score);

    const selected = new Set<string>();
    let tokensUsed = 0;

    // First: fill warnings from the full budget (priority access).
    // A warning that does not fit in full degrades to summary-only rather than
    // disappearing: dropping it silently produced a briefing that affirmatively
    // said "No prior context constraints — proceed" while real warnings existed.
    const summaryOnlyWarnings = new Set<string>();
    let warningsOmitted = 0;
    for (const item of warnings) {
      if (tokensUsed + item.tokenCost <= budget) {
        selected.add(item.id);
        tokensUsed += item.tokenCost;
        continue;
      }
      const summaryCost = estimateConservative((item.data as BlackboardEntry).summary).tokens;
      if (tokensUsed + summaryCost <= budget) {
        selected.add(item.id);
        summaryOnlyWarnings.add(item.id);
        tokensUsed += summaryCost;
      } else {
        warningsOmitted += 1;
      }
    }

    // Then: fill non-warnings, capped so they don't starve warnings
    let nonWarningTokens = 0;
    for (const item of nonWarnings) {
      if (
        tokensUsed + item.tokenCost <= budget &&
        nonWarningTokens + item.tokenCost <= nonWarningCap
      ) {
        selected.add(item.id);
        tokensUsed += item.tokenCost;
        nonWarningTokens += item.tokenCost;
      }
    }

    // Also include needs even if low-scored (safety)
    for (const item of scoredItems) {
      if (
        item.type === "need" &&
        !selected.has(item.id) &&
        tokensUsed + item.tokenCost <= budget
      ) {
        selected.add(item.id);
        tokensUsed += item.tokenCost;
      }
    }

    // 8. Build AssembledContext
    const activeDecisionResults: AssembledContext["active_decisions"] = [];
    const openNeeds: AssembledContext["open_needs"] = [];
    const recentFindings: AssembledContext["recent_findings"] = [];
    const activeWarnings: AssembledContext["active_warnings"] = [];
    const recentQuestions: AssembledContext["recent_questions"] = [];

    // Present in score order, not store order. Selection above already ranked
    // warnings and non-warnings separately to fill the budget; iterating the
    // unsorted scoredItems here threw that ranking away, so formatForLLM's
    // "CRITICAL" tier rendered the three OLDEST scope-matched decisions and
    // collapsed the highest-scoring ones into "+N more".
    const presentationOrder = [...scoredItems].sort((a, b) => b.score - a.score);

    for (const item of presentationOrder) {
      if (!selected.has(item.id)) continue;

      if (item.type === "decision") {
        const d = item.data as Decision;
        const decisionEntry: AssembledContext["active_decisions"][number] = {
          id: d.id,
          status: d.status,
          summary: d.summary,
          rationale: d.rationale,
          confidence: d.confidence,
          affected_files: d.affected_files,
          constraints: d.constraints?.length > 0 ? d.constraints : undefined,
          rejected_alternatives: d.alternatives?.length > 0
            ? d.alternatives.map((a) =>
                a.reason_rejected ? `${a.option}: ${a.reason_rejected}` : a.option,
              )
            : undefined,
          assumptions: d.assumptions,
        };
        const path = reachabilityPaths.get(d.id);
        if (path) {
          decisionEntry.relevance_path = path;
        }
        activeDecisionResults.push(decisionEntry);
      } else {
        const e = item.data as BlackboardEntry;
        switch (e.entry_type) {
          case "need":
            openNeeds.push({
              id: e.id,
              summary: e.summary,
              scope: e.scope,
              timestamp: e.timestamp,
            });
            break;
          case "warning":
            activeWarnings.push({
              id: e.id,
              summary: e.summary,
              detail: summaryOnlyWarnings.has(e.id) ? "" : e.detail,
              scope: e.scope,
              timestamp: e.timestamp,
              // Same-session detection by posted-id membership (field D12).
              ...(this.sessionPostIds?.has(e.id)
                ? { self_authored: true }
                : {}),
            });
            break;
          case "finding":
            recentFindings.push({
              id: e.id,
              summary: e.summary,
              detail: e.detail,
              scope: e.scope,
              timestamp: e.timestamp,
            });
            break;
          case "question":
            recentQuestions.push({
              id: e.id,
              summary: e.summary,
              scope: e.scope,
              timestamp: e.timestamp,
            });
            break;
          // Other entry types go into findings as a catch-all
          default:
            recentFindings.push({
              id: e.id,
              summary: e.summary,
              detail: e.detail,
              scope: e.scope,
              timestamp: e.timestamp,
            });
            break;
        }
      }
    }

    // 9. Validate decision assumptions against findings and warnings
    if (activeDecisionResults.length > 0) {
      // Build a corpus of recent evidence text (findings + warnings + newer decisions)
      const evidenceTexts: string[] = [];
      for (const f of recentFindings) {
        evidenceTexts.push(f.summary.toLowerCase());
        if (f.detail) evidenceTexts.push(f.detail.toLowerCase());
      }
      for (const w of activeWarnings) {
        evidenceTexts.push(w.summary.toLowerCase());
        if (w.detail) evidenceTexts.push(w.detail.toLowerCase());
      }
      const evidenceCorpus = evidenceTexts.join(" ");

      for (const d of activeDecisionResults) {
        if (!d.assumptions || d.assumptions.length === 0) continue;

        const challenged: string[] = [];
        for (const assumption of d.assumptions) {
          // Extract key terms from the assumption (3+ char words)
          const terms = assumption.toLowerCase().match(/\b\w{3,}\b/g) ?? [];
          if (terms.length === 0) continue;

          // Check if evidence contains negation patterns near assumption terms
          // Look for: "not X", "no longer X", "changed from X", "replaced X", "removed X"
          const negationPatterns = [
            /\bnot\b/, /\bno longer\b/, /\bchanged?\b/, /\breplaced?\b/,
            /\bremoved?\b/, /\binstead\b/, /\brather than\b/, /\bno\b/,
            /\bwithout\b/, /\beliminated?\b/, /\bdeprecated?\b/,
          ];

          // Also check if a newer decision in the same scope contradicts this assumption
          for (const other of activeDecisionResults) {
            if (other.id === d.id) continue;
            // If a newer decision's summary/rationale mentions assumption terms
            // alongside negation words, the assumption may be challenged
            const otherText = `${other.summary} ${other.rationale}`.toLowerCase();
            const termHits = terms.filter((t) => otherText.includes(t)).length;
            const hasNegation = negationPatterns.some((p) => p.test(otherText));
            if (termHits >= 2 && hasNegation) {
              challenged.push(assumption);
              break;
            }
          }

          // Check findings/warnings corpus
          if (!challenged.includes(assumption)) {
            const termHits = terms.filter((t) => evidenceCorpus.includes(t)).length;
            const hasNegation = negationPatterns.some((p) => p.test(evidenceCorpus));
            if (termHits >= 2 && hasNegation) {
              challenged.push(assumption);
            }
          }
        }

        if (challenged.length > 0) {
          d.assumptions_status = "challenged";
          d.challenged_assumptions = challenged;
        } else {
          d.assumptions_status = "hold";
        }
      }
    }

    // 10. Populate related_entities from knowledge graph
    const relatedEntities = await this.getRelatedEntities(scope);

    const result: AssembledContext = {
      assembled_at: new Date().toISOString(),
      task,
      scope,
      token_estimate: tokensUsed,
      ...(warningsOmitted > 0 ? { warnings_omitted: warningsOmitted } : {}),
      ...(archivedExcluded > 0
        ? { archived_excluded_count: archivedExcluded }
        : {}),
      ...(supersededExcluded > 0
        ? { superseded_excluded_count: supersededExcluded }
        : {}),
      active_decisions: activeDecisionResults,
      open_needs: openNeeds,
      recent_findings: recentFindings,
      active_warnings: activeWarnings,
      recent_questions: recentQuestions,
      related_entities: relatedEntities,
    };

    // 10. Integrate planning state from .planning/ directory
    const planningState = this.planningBridge?.readPlanningState() ?? null;
    if (planningState) {
      // Always include planning_state as metadata (not subject to token budget)
      result.planning_state = planningState;

      // Add a synthetic scored finding for planning context so it competes
      // for token budget alongside other items (GSDB-04)
      let planningText = `Planning: Phase ${planningState.current_phase}, Progress: ${planningState.progress}`;
      if (planningState.blockers.length > 0) {
        planningText += `. Blockers: ${planningState.blockers.join("; ")}`;
      }
      const planningTokenCost = estimateConservative(planningText).tokens;
      const planningScore =
        1.0 * weights.recency +    // always fresh
        0.5 * weights.relevance +  // moderate default relevance
        0.5 * weights.decision_confidence;
      if (tokensUsed + planningTokenCost <= budget) {
        recentFindings.push({
          id: "planning-state",
          summary: planningText,
          detail: planningState.open_requirements.length > 0
            ? `Open requirements: ${planningState.open_requirements.join(", ")}`
            : "",
          scope: "project",
          timestamp: new Date().toISOString(),
        });
        result.token_estimate += planningTokenCost;
      }
    }

    // 11. Include recent handoffs matching scope (HND-03)
    if (this.handoffStore) {
      const handoffEntries = await this.handoffStore.list({ scope, limit: 5 });
      if (handoffEntries.length > 0) {
        // Load full records to get individual results for detailed checklist
        const fullHandoffs = await Promise.all(
          handoffEntries.map((h) => this.handoffStore!.get(h.id)),
        );
        result.recent_handoffs = handoffEntries.map((h, i) => ({
          id: h.id,
          source_agent: h.source_agent,
          target_agent: h.target_agent ?? "",
          scope: h.scope ?? "",
          summary: h.summary,
          result_status: h.result_status,
          acknowledged: h.acknowledged,
          created_at: h.created_at,
          results: fullHandoffs[i]?.results,
        }));
      }
    }

    // 12. Include suggested agents with matching capabilities (HND-06)
    if (this.agentStore) {
      const allAgents = await this.agentStore.getAll();
      const thresholds = this.config.agents?.liveness ?? DEFAULT_LIVENESS_THRESHOLDS;
      const taskTerms = normalizeTags(task.split(/\s+/));

      const suggestedAgents: NonNullable<AssembledContext["suggested_agents"]> = [];
      for (const agent of allAgents) {
        const liveness = computeLiveness(agent.last_active, new Date(), thresholds);
        if (liveness === "gone") continue;

        const normalizedCaps = normalizeTags(agent.capabilities);
        const hasMatch = normalizedCaps.some((cap) =>
          taskTerms.some((term) => term.includes(cap) || cap.includes(term)),
        );
        if (hasMatch) {
          suggestedAgents.push({
            agent_id: agent.agent_id,
            capabilities: agent.capabilities,
            liveness,
          });
        }
      }

      if (suggestedAgents.length > 0) {
        result.suggested_agents = suggestedAgents;
      }
    }

    // Log assembly for assembly-before-decision tracking
    this.assemblyLog.set(agentId ?? "main", result.assembled_at);

    // ---------------------------------------------------------------
    // Lane 04 gate 2 — the explain annex and the honest budget.
    //
    // `token_estimate` used to charge the raw text of every SELECTED item,
    // including the ones the formatter never rendered, and never charged for
    // the headings or the JSON envelope (gap 7 R17). It is now the conservative
    // bound over the briefing that is actually emitted, measured with the
    // declared tokenizer.
    // ---------------------------------------------------------------
    const legacyLifecycle = classifyLegacy("active");
    const annexed: AssembledContextV3 = {
      ...result,
      retrieval: {
        selection: {
          mode: selectionRequest.mode ?? "strict",
          repo: identity.repo,
          repo_identity_source: identity.source,
          authorized_digest: indexGate.filters.authorized_digest,
          suppressed: mergeCounts(
            mergeCounts(indexGate.suppressed, entryGate.suppressed),
            scopeGate.suppressed,
          ),
          // CAPPED. This list grows with the STORE, not with the query, and it
          // is returned to the caller by context.ts, so an uncapped version was
          // an unbounded payload that no budget counted. Counts above are
          // complete; these ids are a sample for diagnosis.
          ...capSuppressed([
            ...scopeGate.suppressed_visible,
            ...indexGate.suppressed_visible,
            ...entryGate.suppressed_visible,
          ]),
          outcome:
            scopeGate.outcome === "no_in_scope_evidence" &&
            indexGate.outcome === "no_in_scope_evidence" &&
            entryGate.outcome === "no_in_scope_evidence"
              ? "no_in_scope_evidence"
              : "ok",
          ...(indexGate.missing_entitlement ? { missing_entitlement: indexGate.missing_entitlement } : {}),
        },
        versions: {
          ranking: "twining-assemble-weighted/2",
          index: this.searchEngine ? "embeddings/1" : "none",
          embedding_model: this.config.embedding_model,
          tokenizer: TOKENIZER_ID,
          lifecycle_resolver: legacyLifecycle.resolver,
        },
        trust: {
          evidence_class: legacyLifecycle.evidence_class,
          qualifies_action: legacyLifecycle.authorizes_action,
          qualification_refused_because:
            "2.x records carry no authorship proof; every one is legacy_unverified, which is below the actionable class rank",
        },
        token_usage: {
          budget,
          emitted_tokens: 0, // filled by formatForLLM via annotateEmitted()
          tokenizer_id: TOKENIZER_ID,
          table_id: ACTIVE_TABLE.id,
          conservative_fallback: true,
          rendered_decisions: 0,
          selected_decisions: result.active_decisions.length,
          over_budget: false,
          omitted_decisions: 0,
        },
      },
    };
    return annexed;
  }

  /**
   * Assemble context and include a status summary inline.
   * Combines assemble + summarize into one call (P5.1).
   */
  /**
   * The terminal response to a denied retrieval mode.
   *
   * Empty of records by construction — there is no path from here back into the
   * merge loop — and it still carries the annex, so the caller can tell
   * "the channel is closed to you, and here is the entitlement you lack" from
   * "the channel is open and empty". C25 A9 requires exactly that distinction.
   */
  private emptyDeniedContext(
    task: string,
    scope: string,
    budget: number,
    identity: StoreIdentity,
    selectionRequest: SelectionRequest,
    denied: SelectionOutcome<unknown>,
  ): AssembledContextV3 {
    const legacyLifecycle = classifyLegacy("active");
    return {
      assembled_at: new Date().toISOString(),
      task,
      scope,
      token_estimate: 0,
      active_decisions: [],
      open_needs: [],
      recent_findings: [],
      active_warnings: [],
      recent_questions: [],
      related_entities: [],
      retrieval: {
        selection: {
          mode: selectionRequest.mode ?? "strict",
          repo: identity.repo,
          repo_identity_source: identity.source,
          authorized_digest: denied.filters.authorized_digest,
          suppressed: denied.suppressed,
          suppressed_visible: [],
          outcome: "scope_mode_denied",
          ...(denied.missing_entitlement ? { missing_entitlement: denied.missing_entitlement } : {}),
        },
        versions: {
          ranking: "twining-assemble-weighted/2",
          index: this.searchEngine ? "embeddings/1" : "none",
          embedding_model: this.config.embedding_model,
          tokenizer: TOKENIZER_ID,
          lifecycle_resolver: legacyLifecycle.resolver,
        },
        trust: {
          evidence_class: legacyLifecycle.evidence_class,
          qualifies_action: false,
          qualification_refused_because: "retrieval mode denied: no records were selected",
        },
        token_usage: {
          budget,
          emitted_tokens: 0,
          tokenizer_id: TOKENIZER_ID,
          table_id: ACTIVE_TABLE.id,
          conservative_fallback: true,
          rendered_decisions: 0,
          selected_decisions: 0,
          over_budget: false,
          omitted_decisions: 0,
        },
      },
    };
  }

  async assembleWithStatus(
    task: string,
    scope: string,
    maxTokens?: number,
    agentId?: string,
    options?: { mode?: RetrievalMode; lessons_entitled?: boolean; principal?: string },
  ): Promise<{ context: AssembledContextV3; status_summary: string }> {
    const context = await this.assemble(task, scope, maxTokens, agentId, options);
    // Status summary is best-effort — don't let it break assembly
    let statusSummary = "";
    try {
      const summary = await this.summarize(scope);
      statusSummary = summary.recent_activity_summary;
    } catch {
      // Non-fatal: skip status summary if summarize fails
    }
    return { context, status_summary: statusSummary };
  }

  /**
   * Format assembled context as structured markdown for LLM consumption.
   * Produces imperative sentences and numbered lists instead of raw JSON.
   */
  /**
   * How many decisions render in full, and how many as summaries, for a given
   * budget (gap 7 R15/R16).
   *
   * With no budget (a hand-built AssembledContext) the historical 3 + 2 ladder
   * is returned unchanged, so no existing 2.x consumer shifts shape. With a
   * budget, full rationales are bought until the rendered cost reaches the
   * share of the budget reserved for decisions, then summaries, then the
   * remainder is reported as omitted.
   *
   * The cost is measured with the DECLARED tokenizer over the text that will
   * actually be rendered, not over the record's raw fields — charging for
   * bytes the agent never sees is the defect this replaces.
   */
  /**
   * May the decisions in this context qualify an action?
   *
   * Read from the annex's evidence class, which for a 2.x store is always
   * `legacy_unverified` — below ACTIONABLE_RANK. A hand-built context with no
   * annex is treated as non-actionable: the conservative default, and the
   * honest one, since nothing stated its provenance.
   */
  static decisionsAreActionable(ctx: AssembledContext): boolean {
    const annex = (ctx as { retrieval?: RetrievalAnnex }).retrieval;
    return annex?.trust.qualifies_action === true;
  }

  static decisionTiers(
    ctx: AssembledContext,
    budget: number | undefined,
  ): { CRITICAL_COUNT: number; CONTEXT_COUNT: number } {
    const total = ctx.active_decisions.length;
    if (budget === undefined) return { CRITICAL_COUNT: 3, CONTEXT_COUNT: 2 };

    // Decisions are one lane among warnings, needs, findings and handoffs. Half
    // the budget is theirs; the reservation is what stops a large decision set
    // from crowding out the warnings lane, which has priority by design.
    const lane = Math.floor(budget * 0.5);
    const actionable = ContextAssembler.decisionsAreActionable(ctx);
    let spent = 0;
    let full = 0;
    for (let i = 0; i < ctx.active_decisions.length; i++) {
      // The SAME renderer the emitter uses, so the cost model cannot drift from
      // the emission again (it previously omitted the assumptions lines).
      const rendered = renderDecisionBlock(ctx.active_decisions[i]!, {
        actionable,
        tier: "full",
        index: i,
      }).join("\n");
      const cost = estimateConservative(rendered).tokens;
      if (spent + cost > lane) break;
      spent += cost;
      full += 1;
    }
    // Always show at least the historical top tier, even on a tiny budget: a
    // briefing that names no decision at all reads as "nothing constrains you".
    full = Math.max(Math.min(total, 1), Math.min(full, total));

    let summaries = 0;
    for (let i = full; i < total; i++) {
      const cost = estimateConservative(
        renderDecisionBlock(ctx.active_decisions[i]!, { actionable, tier: "summary", index: i }).join("\n"),
      ).tokens;
      if (spent + cost > lane) break;
      spent += cost;
      summaries += 1;
    }
    return { CRITICAL_COUNT: full, CONTEXT_COUNT: summaries };
  }

  /**
   * Stamp the emitted-briefing measurement onto the annex (gap 7 R17).
   *
   * `formatForLLM` is static and pure, so the measurement is taken here, after
   * the bytes exist. `token_estimate` becomes the conservative bound over the
   * briefing the agent reads — not the raw text of items it never sees.
   */
  static annotateEmitted(ctx: AssembledContextV3, briefing: string, envelope?: string): AssembledContextV3 {
    const est = estimateConservative(briefing);
    const rendered = ContextAssembler.decisionTiers(ctx, ctx.retrieval.token_usage.budget);
    const renderedCount = Math.min(
      ctx.active_decisions.length,
      rendered.CRITICAL_COUNT + rendered.CONTEXT_COUNT,
    );
    const usage = ctx.retrieval.token_usage;
    usage.emitted_tokens = est.tokens;
    usage.rendered_decisions = renderedCount;
    usage.omitted_decisions = ctx.active_decisions.length - renderedCount;
    // Measure the ENVELOPE when the caller hands it over: JSON escaping and the
    // sibling fields are on the wire too, and the packet docstring's claim that
    // the bound covers them is only true if something measures them.
    const onWire = envelope ? estimateConservative(envelope).tokens : est.tokens;
    usage.over_budget = onWire > usage.budget;
    ctx.retrieval.emitted_bytes_sha256 = hashBytes(briefing);
    ctx.token_estimate = est.tokens;
    return ctx;
  }

  static formatForLLM(ctx: AssembledContext, statusSummary?: string): string {
    // Short-circuit: if there's nothing useful to say, return minimal output
    const hasContent =
      ctx.active_warnings.length > 0 ||
      ctx.active_decisions.length > 0 ||
      ctx.recent_findings.length > 0 ||
      ctx.open_needs.length > 0 ||
      ctx.recent_questions.length > 0 ||
      (ctx.recent_handoffs && ctx.recent_handoffs.length > 0) ||
      ctx.planning_state != null ||
      // Warnings dropped for budget are still context. Reporting "no prior
      // context" here would state the opposite of the truth.
      (ctx.warnings_omitted ?? 0) > 0 ||
      // Excluded decisions are context too (D3/D10): a scope whose only
      // decisions were archived or superseded must surface the exclusion
      // note, never the indistinguishable "No prior context".
      (ctx.archived_excluded_count ?? 0) > 0 ||
      (ctx.superseded_excluded_count ?? 0) > 0;
    if (!hasContent) {
      return `No prior context for scope: ${ctx.scope}`;
    }
    if (
      ctx.active_warnings.length === 0 &&
      ctx.active_decisions.length === 0 &&
      ctx.recent_findings.length === 0 &&
      ctx.open_needs.length === 0 &&
      ctx.recent_questions.length === 0 &&
      (ctx.warnings_omitted ?? 0) > 0 &&
      // With excluded decisions in scope, fall through to the full briefing so
      // the D3/D10 exclusion notes render alongside the omitted-warnings
      // directive — this early return must not swallow them.
      (ctx.archived_excluded_count ?? 0) === 0 &&
      (ctx.superseded_excluded_count ?? 0) === 0
    ) {
      return `Context for scope ${ctx.scope} exceeded the token budget: ${ctx.warnings_omitted} warning(s) could not be shown. Call twining_read with entry_types:["warning"] before proceeding.`;
    }

    const sections: string[] = [];

    // Header
    sections.push(`## Before You Start (scope: ${ctx.scope})`);

    // 1. Warnings FIRST — "what not to do" is the most actionable signal
    if (ctx.active_warnings.length > 0) {
      sections.push("\n### STOP — READ THESE WARNINGS");
      for (const w of ctx.active_warnings) {
        const selfMark = w.self_authored ? " [this session]" : "";
        // S4-1: the lossless-write format ("Full summary: <full text>" in
        // detail behind a truncated summary) rendered the same text twice —
        // preview line plus its strict superset. Dedupe at render, keeping
        // the on-disk format intact.
        const { headline, detail } = dedupeFullSummary(w.summary, w.detail);
        sections.push(`- **${headline}**${selfMark}${detail ? `\n  ${detail}` : ""}`);
      }
    }

    // 2. Continue from (handoffs) — second priority, provides continuation context
    if (ctx.recent_handoffs && ctx.recent_handoffs.length > 0) {
      sections.push("\n### CONTINUE FROM PREVIOUS WORK");
      for (const h of ctx.recent_handoffs) {
        const status = h.acknowledged ? "acknowledged" : "pending";
        // Age stamp (field D12): the lane replayed a 15-day-old item with no
        // temporal context, indistinguishable from a live handoff. Same-day
        // items stay unstamped so fresh handoffs read as before.
        const ageDays = h.created_at
          ? Math.floor(
              (Date.now() - new Date(h.created_at).getTime()) /
                (24 * 60 * 60 * 1000),
            )
          : 0;
        const ageStamp = ageDays >= 1 ? ` (${ageDays}d ago)` : "";
        sections.push(`**${h.source_agent} → ${h.target_agent || "any"}** (${status})${ageStamp}: ${h.summary}`);
        // Detailed checklist of individual results
        if (h.results && h.results.length > 0) {
          for (const r of h.results) {
            const blockedIcon = ageDays >= 1 ? `[BLOCKED ${ageDays}d]` : "[BLOCKED]";
            const icon = r.status === "completed" ? "[x]" : r.status === "blocked" ? blockedIcon : "[ ]";
            sections.push(`  - ${icon} ${r.description}${r.notes ? ` — ${r.notes}` : ""}`);
          }
        }
      }
    }

    // 3. Decisions — the ladder is now driven by the caller's BUDGET, not by a
    //    hard-coded 3+2 (gap 7, R15/R16). A generous max_tokens buys full
    //    rationales for every selected decision; a tight one still shows the
    //    top ones in full and degrades the rest to summaries before dropping
    //    any, and says how many it dropped.
    //
    //    The heading also carries the authority class of what follows (gap 6,
    //    render side): a 2.x store holds unauthenticated agent assertions, and
    //    presenting them under a bare imperative heading is what turns an
    //    unverified claim into a directive. The class is stated; the records
    //    are unchanged.
    if (ctx.active_decisions.length > 0) {
      sections.push("\n### DECISIONS TO RESPECT");
      const annex = (ctx as { retrieval?: RetrievalAnnex }).retrieval;
      if (annex) {
        sections.push(
          `_Evidence class: ${annex.trust.evidence_class} — ${CLASS_PRESENTATION[annex.trust.evidence_class as keyof typeof CLASS_PRESENTATION]?.directive ?? "treat as a lead"}` +
            ` Qualifies an action: ${annex.trust.qualifies_action ? "yes" : "no"}._`,
        );
      }
      const total = ctx.active_decisions.length;
      // Budget-driven tiers. Without an annex (a 2.x caller constructing an
      // AssembledContext by hand) the historical 3+2 ladder is preserved
      // exactly, so nothing that does not opt in changes shape.
      const budget = annex?.token_usage.budget;
      const { CRITICAL_COUNT, CONTEXT_COUNT } = ContextAssembler.decisionTiers(ctx, budget);

      // One renderer for both tiers, shared with decisionTiers' costing.
      const actionable = ContextAssembler.decisionsAreActionable(ctx);
      for (let i = 0; i < Math.min(total, CRITICAL_COUNT); i++) {
        sections.push(
          ...renderDecisionBlock(ctx.active_decisions[i]!, { actionable, tier: "full", index: i }),
        );
      }
      for (let i = CRITICAL_COUNT; i < Math.min(total, CRITICAL_COUNT + CONTEXT_COUNT); i++) {
        sections.push(
          ...renderDecisionBlock(ctx.active_decisions[i]!, { actionable, tier: "summary", index: i }),
        );
      }

      // Omitted count — an honest report of what the budget could not carry.
      const omitted = total - CRITICAL_COUNT - CONTEXT_COUNT;
      if (omitted > 0) {
        sections.push(`\n(+${omitted} more decisions in scope — call twining_why for details)`);
      }
    } else {
      sections.push("\nNo active decisions for this scope.");
    }

    // 3b. Files to check — explicit read directives from decisions + handoffs
    const filesToCheck = new Set<string>();
    for (const d of ctx.active_decisions) {
      for (const f of d.affected_files ?? []) filesToCheck.add(f);
    }
    if (ctx.recent_handoffs) {
      for (const h of ctx.recent_handoffs) {
        if (h.results) {
          for (const r of h.results) {
            if (r.artifacts) {
              for (const a of r.artifacts) filesToCheck.add(a);
            }
          }
        }
      }
    }
    if (filesToCheck.size > 0) {
      sections.push("\n### FILES TO CHECK BEFORE WRITING");
      for (const f of filesToCheck) {
        sections.push(`- [ ] Read \`${f}\``);
      }
    }

    // 4. Open needs — what still needs to be done
    if (ctx.open_needs.length > 0) {
      sections.push("\n### REMAINING WORK");
      for (const n of ctx.open_needs) {
        sections.push(`- [ ] ${n.summary}`);
      }
    }

    // 5. Recent findings (brief, only if not redundant with decisions)
    if (ctx.recent_findings.length > 0) {
      // Filter out findings whose summary is substantially duplicated by a decision
      const decisionSummaries = ctx.active_decisions.map((d) => d.summary.toLowerCase());
      const uniqueFindings = ctx.recent_findings.filter((f) => {
        const fLower = f.summary.toLowerCase();
        return !decisionSummaries.some((ds) =>
          ds.includes(fLower.slice(0, 30)) || fLower.includes(ds.slice(0, 30)),
        );
      });
      if (uniqueFindings.length > 0) {
        sections.push("\n### FINDINGS");
        for (const f of uniqueFindings) {
          sections.push(`- ${f.summary}`);
        }
      }
    }

    // 6. Quick reference section — compact metadata
    const quickRef: string[] = ["\n---"];

    // Status summary (P5.1)
    if (statusSummary) {
      quickRef.push(`Status: ${statusSummary}`);
    }

    // Archived-exclusion visibility (D3): a blinded gate must say so.
    if ((ctx.archived_excluded_count ?? 0) > 0) {
      quickRef.push(
        `Note: ${ctx.archived_excluded_count} archived decision(s) in this scope are excluded from the briefing — if that is unexpected, twining_unarchive can restore them.`,
      );
    }
    // Superseded-exclusion visibility (field D10): same failure class.
    if ((ctx.superseded_excluded_count ?? 0) > 0) {
      quickRef.push(
        `Note: ${ctx.superseded_excluded_count} superseded/overridden decision(s) in this scope are excluded — call twining_why on this scope to see them with their successors before concluding nothing constrains it.`,
      );
    }

    // Questions
    if (ctx.recent_questions.length > 0) {
      quickRef.push(`Open questions: ${ctx.recent_questions.map((q) => q.summary).join("; ")}`);
    }

    // Planning state
    if (ctx.planning_state) {
      quickRef.push(`Planning: Phase ${ctx.planning_state.current_phase}, ${ctx.planning_state.progress}`);
      if (ctx.planning_state.blockers.length > 0) {
        quickRef.push(`Blockers: ${ctx.planning_state.blockers.join("; ")}`);
      }
    }

    // Suggested agents
    if (ctx.suggested_agents && ctx.suggested_agents.length > 0) {
      quickRef.push(`Suggested agents: ${ctx.suggested_agents.map((a) => `${a.agent_id} (${a.capabilities.join(", ")})`).join("; ")}`);
    }

    if (quickRef.length > 1) {
      sections.push(quickRef.join("\n"));
    }

    // YOUR NEXT STEP — explicit first action directive to reduce orientation time
    const omitted = ctx.warnings_omitted ?? 0;
    const nextStep =
      ctx.active_warnings.length > 0
        ? "Address the warnings above before proceeding."
        : omitted > 0
          ? `${omitted} warning(s) did not fit the token budget — call twining_read with entry_types:["warning"] before proceeding.`
          : ctx.recent_handoffs && ctx.recent_handoffs.length > 0
            ? "Continue from the handoff above — start with the unchecked items."
            : ctx.open_needs.length > 0
              ? "Pick up the first remaining work item."
              : "No prior context constraints — proceed with your task.";
    sections.push(`\n### YOUR NEXT STEP\n${nextStep}`);

    return sections.join("\n");
  }

  /**
   * High-level summary of project or scope state.
   * Implements spec section 4.3 (twining_summarize).
   */
  async summarize(scope?: string): Promise<SummarizeResult> {
    const targetScope = scope ?? "project";

    // Get decisions
    const index = await this.decisionStore.getIndex();
    const scopeIndex = targetScope === "project"
      ? index
      : index.filter(
          (e) =>
            e.scope.startsWith(targetScope) ||
            targetScope.startsWith(e.scope),
        );

    const activeDecisions = scopeIndex.filter(
      (e) => e.status === "active",
    ).length;
    const provisionalDecisions = scopeIndex.filter(
      (e) => e.status === "provisional",
    ).length;

    // Get blackboard entries
    const readOpts = targetScope === "project" ? undefined : { scope: targetScope };
    const { entries } = await this.blackboardStore.read(readOpts);

    const openNeeds = entries.filter((e) => e.entry_type === "need").length;
    const activeWarnings = entries.filter(
      (e) => e.entry_type === "warning",
    ).length;
    const unansweredQuestions = entries.filter(
      (e) => e.entry_type === "question",
    ).length;

    // Recent activity (last 24 hours)
    const twentyFourHoursAgo = new Date(
      Date.now() - 24 * 60 * 60 * 1000,
    ).toISOString();
    const recentEntries = entries.filter(
      (e) => e.timestamp >= twentyFourHoursAgo,
    );
    const recentDecisionCount = scopeIndex.filter(
      (e) => e.timestamp >= twentyFourHoursAgo,
    ).length;
    const recentFindingCount = recentEntries.filter(
      (e) => e.entry_type === "finding",
    ).length;
    const recentWarningCount = recentEntries.filter(
      (e) => e.entry_type === "warning",
    ).length;

    let recentActivitySummary =
      `In the last 24 hours: ${recentDecisionCount} decision${recentDecisionCount !== 1 ? "s" : ""} made, ` +
      `${recentFindingCount} finding${recentFindingCount !== 1 ? "s" : ""} posted, ` +
      `${recentWarningCount} warning${recentWarningCount !== 1 ? "s" : ""} raised.`;

    // Integrate planning state from .planning/ directory
    const planningState = this.planningBridge?.readPlanningState() ?? null;

    if (planningState) {
      recentActivitySummary += ` Current phase: ${planningState.current_phase}. Progress: ${planningState.progress}.`;
    }

    const result: SummarizeResult = {
      scope: targetScope,
      active_decisions: activeDecisions,
      provisional_decisions: provisionalDecisions,
      open_needs: openNeeds,
      active_warnings: activeWarnings,
      unanswered_questions: unansweredQuestions,
      recent_activity_summary: recentActivitySummary,
    };

    if (planningState) {
      result.planning_state = planningState;
    }

    return result;
  }

  /**
   * Report changes since a given point in time.
   * Implements spec section 4.3 (twining_what_changed).
   */
  async whatChanged(
    since: string,
    scope?: string,
  ): Promise<WhatChangedResult> {
    // Get new entries since timestamp
    const readOpts: { since: string; scope?: string } = { since };
    if (scope) readOpts.scope = scope;
    const { entries } = await this.blackboardStore.read(readOpts);

    const newEntries = entries.map((e) => ({
      id: e.id,
      entry_type: e.entry_type,
      summary: e.summary,
    }));

    // Get decisions since timestamp
    const index = await this.decisionStore.getIndex();
    let filteredIndex = index.filter((e) => e.timestamp >= since);
    if (scope) {
      filteredIndex = filteredIndex.filter(
        (e) =>
          e.scope.startsWith(scope) || scope.startsWith(e.scope),
      );
    }

    const newDecisions = filteredIndex
      .filter((e) => e.status === "active" || e.status === "provisional")
      .map((e) => ({ id: e.id, summary: e.summary }));

    // Find overridden decisions since timestamp
    const overriddenDecisions: WhatChangedResult["overridden_decisions"] = [];
    const allOverridden = index.filter((e) => e.status === "overridden");
    for (const entry of allOverridden) {
      const decision = await this.decisionStore.get(entry.id);
      if (decision && decision.timestamp >= since) {
        if (!scope || decision.scope.startsWith(scope) || scope.startsWith(decision.scope)) {
          overriddenDecisions.push({
            id: decision.id,
            summary: decision.summary,
            reason: decision.override_reason ?? "No reason provided",
          });
        }
      }
    }

    // Find reconsidered (provisional) decisions since timestamp. A decision
    // CREATED in the window that is provisional was born that way (2.5.0
    // creation-time status), not reconsidered — it already appears in
    // new_decisions and is excluded here.
    const newDecisionIds = new Set(newDecisions.map((d) => d.id));
    const reconsideredDecisions = filteredIndex
      .filter((e) => e.status === "provisional" && !newDecisionIds.has(e.id))
      .map((e) => ({ id: e.id, summary: e.summary }));

    return {
      new_decisions: newDecisions,
      new_entries: newEntries,
      overridden_decisions: overriddenDecisions,
      reconsidered_decisions: reconsideredDecisions,
    };
  }

  /**
   * Compute graph connectivity boost for decisions (spec §5.5).
   * Decisions whose affected_files/symbols have more graph relations
   * to the scope get a higher boost (0.0 to 1.0).
   */
  private async computeGraphReachability(
    scope: string,
    decisions: Map<string, Decision>,
  ): Promise<{ scores: Map<string, number>; paths: Map<string, string> }> {
    const scores = new Map<string, number>();
    const paths = new Map<string, string>();
    if (!this.graphEngine) return { scores, paths };

    try {
      // 1. Find entities matching scope, filtered to scope prefix
      const { entities: scopeEntities } = await this.graphEngine.query(
        scope,
        undefined,
        20,
      );
      const filteredScopeEntities = scopeEntities.filter(
        (e) => e.name.startsWith(scope) || scope.startsWith(e.name),
      );
      if (filteredScopeEntities.length === 0) return { scores, paths };

      // Relation types to follow during BFS
      const followTypes = [
        "depends_on", "decided_by", "implements", "affects", "produces", "challenged",
      ];

      // Relation type scoring bonuses
      const relationBonus: Record<string, number> = {
        decided_by: 1.0,
        affects: 1.0,
        depends_on: 0.8,
        implements: 0.8,
        produces: 0.7,
        challenged: 0.7,
        supersedes: 0.6,
        tested_by: 0.6,
        related_to: 0.5,
      };

      // Path length scoring (indexed by hop count - 1)
      const depthScore: [number, number, number] = [1.0, 0.7, 0.4];

      // Build set of decision IDs for quick lookup
      const decisionIds = new Set(decisions.keys());

      // 2. For each scope entity, do typed BFS traversal (max depth 3)
      for (const scopeEntity of filteredScopeEntities) {
        try {
          const { neighbors } = await this.graphEngine.neighbors(
            scopeEntity.id,
            3,
            followTypes,
          );

          for (const neighbor of neighbors) {
            // Check if this neighbor is a decision concept node
            if (neighbor.entity.type === "concept" && decisionIds.has(neighbor.entity.name)) {
              const decisionId = neighbor.entity.name;

              // Determine hop depth from relation (approximate: use relation type)
              // Since neighbors() returns flat results, we estimate depth from the BFS order
              // The relation tells us the connection type
              const relType = neighbor.relation.type;
              const bonus = relationBonus[relType] ?? 0.5;

              // Use depth 0 (1-hop) as default since neighbors are direct or via BFS
              const pathScore = depthScore[0] * bonus;

              // Keep max score across all paths
              const existing = scores.get(decisionId) ?? 0;
              if (pathScore > existing) {
                scores.set(decisionId, pathScore);
                paths.set(
                  decisionId,
                  `${scopeEntity.name} → ${relType} → ${neighbor.entity.name}`,
                );
              }
            }

            // Also check if the neighbor's name matches affected_files of any decision
            for (const [decisionId, decision] of decisions) {
              if (
                decision.affected_files.includes(neighbor.entity.name) ||
                decision.affected_symbols.includes(neighbor.entity.name)
              ) {
                const relType = neighbor.relation.type;
                const bonus = relationBonus[relType] ?? 0.5;
                const pathScore = depthScore[1] * bonus; // 2-hop equivalent

                const existing = scores.get(decisionId) ?? 0;
                if (pathScore > existing) {
                  scores.set(decisionId, pathScore);
                  paths.set(
                    decisionId,
                    `${scopeEntity.name} → ${relType} → ${neighbor.entity.name} → decided_by → ${decisionId}`,
                  );
                }
              }
            }
          }
        } catch {
          // Skip entities that fail to traverse
        }
      }

      // 3. Normalize scores to 0.0-1.0
      const maxScore = Math.max(0, ...Array.from(scores.values()));
      if (maxScore > 0 && maxScore !== 1.0) {
        for (const [id, score] of scores) {
          scores.set(id, score / maxScore);
        }
      }
    } catch {
      // Graph errors should never break scoring
    }

    return { scores, paths };
  }

  /**
   * Populate related_entities from the knowledge graph.
   * Finds entities matching the scope and gets their immediate neighbors.
   * Never throws — graph errors are silently caught to avoid breaking context assembly.
   */
  private async getRelatedEntities(
    scope: string,
  ): Promise<AssembledContext["related_entities"]> {
    if (!this.graphEngine) return [];

    try {
      // Search for entities whose name matches the scope
      const { entities } = await this.graphEngine.query(scope, undefined, 5);
      if (entities.length === 0) return [];

      const relatedEntities: AssembledContext["related_entities"] = [];

      for (const entity of entities) {
        try {
          const { neighbors } = await this.graphEngine.neighbors(
            entity.id,
            1,
          );
          const relations = neighbors.map(
            (n) => `${n.relation.type}: ${n.entity.name}`,
          );
          relatedEntities.push({
            name: entity.name,
            type: entity.type,
            relations,
          });
        } catch {
          // Skip entities that fail to traverse
          relatedEntities.push({
            name: entity.name,
            type: entity.type,
            relations: [],
          });
        }
      }

      return relatedEntities;
    } catch {
      // Graph errors should never break context assembly
      return [];
    }
  }

  /** Compute recency score using exponential decay. */
  private recencyScore(timestamp: string, now: number): number {
    const ageMs = now - new Date(timestamp).getTime();
    const ageHours = ageMs / (1000 * 60 * 60);
    return Math.exp(-ageHours / RECENCY_HALF_LIFE);
  }

  /** Convert decision confidence to a numeric score. */
  private confidenceScore(confidence: string): number {
    switch (confidence) {
      case "high":
        return 1.0;
      case "medium":
        return 0.6;
      case "low":
        return 0.3;
      default:
        return 0.5;
    }
  }

  /**
   * Compute scope proximity: how close is a decision's scope to the task scope.
   * Exact match or child scope = 1.0, parent (1 level) = 0.7, grandparent+ = 0.4.
   */
  static scopeProximity(taskScope: string, decisionScope: string): number {
    // Exact match or decision is a child of the task scope
    if (decisionScope.startsWith(taskScope) || taskScope.startsWith(decisionScope) && taskScope === decisionScope) {
      return 1.0;
    }
    // Task scope is within decision scope (decision is broader)
    if (taskScope.startsWith(decisionScope)) {
      const remainder = taskScope.slice(decisionScope.length);
      const depth = remainder.split("/").filter(Boolean).length;
      if (depth <= 1) return 0.7;
      return 0.4;
    }
    // Decision scope is within task scope (decision is more specific)
    if (decisionScope.startsWith(taskScope)) {
      return 1.0;
    }
    // Different branches — low relevance
    return 0.4;
  }
}
