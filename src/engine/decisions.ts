/**
 * Decision business logic.
 * Validates input, applies defaults, delegates to IDecisionStore.
 * Decisions live only in the decision store (issue #30) — they are no
 * longer cross-posted to the blackboard.
 * Phase 3: Adds trace, reconsider, override, and conflict detection.
 * Generates embeddings on decide (Phase 2) with graceful fallback.
 * Phase 5: Syncs decision summaries to .planning/STATE.md for GSD bridge.
 */
import fs from "node:fs";
import path from "node:path";
import { BlackboardEngine } from "./blackboard.js";
import { TwiningError } from "../utils/errors.js";
import { captureProvenance } from "../utils/provenance.js";
import { estimateTokens } from "../utils/tokens.js";
import type {
  Decision,
  DecisionAlternative,
  DecisionAmendment,
  DecisionConfidence,
  DecisionStatus,
  RationaleSource,
} from "../utils/types.js";
import type { Embedder } from "../embeddings/embedder.js";
import { decisionEmbedText, embedContentHash } from "../embeddings/embed-text.js";
import { SEARCH_NOISE_FLOOR, type SearchEngine } from "../embeddings/search.js";
import { GraphAutoPopulator } from "./graph-auto-populator.js";
import type { IDecisionStore, IIndexManager } from "../storage/interfaces.js";

/** Entry in a dependency trace chain. */
export interface TraceEntry {
  id: string;
  summary: string;
  depends_on: string[];
  dependents: string[];
  status: string;
}

/** Options for why() (#41). */
export interface WhyOptions {
  /** Token budget for the full-detail tier (default 4000, matching assemble). */
  max_tokens?: number;
  /** Include superseded decisions (excluded by default). */
  include_superseded?: boolean;
  /** Return full detail for exactly these decision ids; scope and budget are ignored. */
  ids?: string[];
  /**
   * Resolve each excluded superseded/overridden record's lineage HEAD by
   * walking superseded_by (field D13 ask 3) — "what is the current answer",
   * not "what ranks highest". Off by default (extra store reads).
   */
  lineage?: boolean;
}

/** Full-detail decision record returned by why(). */
export interface WhyDecision {
  id: string;
  summary: string;
  rationale: string;
  confidence: string;
  status: string;
  timestamp: string;
  alternatives_count: number;
  commit_hashes: string[];
  superseded_by?: string;
  // Present only in ids drill-down mode.
  context?: string;
  alternatives?: Decision["alternatives"];
  scope?: string;
  domain?: string;
  constraints?: string[];
  depends_on?: string[];
}

/** Compact one-liner for decisions that exceed the why() token budget. */
export interface WhyCompactDecision {
  id: string;
  summary: string;
  status: string;
  confidence: string;
  timestamp: string;
}

export interface WhyResult {
  decisions: WhyDecision[];
  more?: WhyCompactDecision[];
  truncated: boolean;
  total_in_scope: number;
  superseded_count: number;
  /**
   * Compact identity of the superseded/overridden records the default filter
   * hid, each pointing at its successor (field D10). A bare count read as
   * "returns nothing" in the field when a multi-part record was wholly
   * retired; the ids make the exclusion recoverable (include_superseded, or
   * follow superseded_by). Absent when include_superseded is set or nothing
   * was hidden. Capped at 20.
   */
  superseded_excluded?: Array<{
    id: string;
    summary: string;
    superseded_by?: string;
    /** Terminal record of this decision's supersession chain (lineage: true). */
    lineage_head?: { id: string; summary: string; chain_length: number };
  }>;
  /**
   * Archived decisions hidden from this result (D3). Present so a blinded
   * gate reads "0 decisions (N archived in scope)" instead of "no decisions
   * exist" — a wrongly-archived store is otherwise indistinguishable from an
   * empty one. Restore with twining_unarchive.
   */
  archived_excluded_count?: number;
  active_count: number;
  provisional_count: number;
  token_estimate: number;
  omitted_count?: number;
  missing_ids?: string[];
}

/** Default full-tier budget for why() — mirrors context_assembly.default_max_tokens. */
const DEFAULT_WHY_MAX_TOKENS = 4000;

/** Compact-tier cap for why() — beyond this, only counts are reported. */
const WHY_MAX_COMPACT = 50;

const WHY_STATUS_RANK: Record<string, number> = {
  active: 2,
  provisional: 1,
  superseded: 0,
  overridden: 0,
  archived: 0,
};

/**
 * Statuses that no longer carry authority. why() hides these by default: an
 * overridden decision was explicitly rejected, and surfacing it in the
 * full-detail tier presents a reversed choice as a live constraint.
 */
const WHY_RETIRED_STATUSES: ReadonlySet<string> = new Set([
  "superseded",
  "overridden",
  "archived",
]);

/**
 * How directly a decision matches the queried scope (#41): exact scope,
 * affected-file, or symbol match (3) > decision scoped under the query (2) >
 * broad ancestor-scoped decision that merely covers the query (1).
 */
function whySpecificity(d: Decision, scope: string): number {
  if (
    d.scope === scope ||
    d.affected_files.includes(scope) ||
    d.affected_symbols.includes(scope)
  ) {
    return 3;
  }
  if (
    d.scope.startsWith(scope) ||
    d.affected_files.some((f) => f.startsWith(scope))
  ) {
    return 2;
  }
  return 1;
}

export class DecisionEngine {
  private readonly decisionStore: IDecisionStore;
  private readonly blackboardEngine: BlackboardEngine;
  private readonly embedder: Embedder | null;
  private readonly indexManager: IIndexManager | null;
  private readonly projectRoot: string | null;
  private readonly searchEngine: SearchEngine | null;
  private readonly graphPopulator: GraphAutoPopulator | null;
  private assemblyChecker?: (agentId: string) => boolean;

  constructor(
    decisionStore: IDecisionStore,
    blackboardEngine: BlackboardEngine,
    embedder?: Embedder | null,
    indexManager?: IIndexManager | null,
    projectRoot?: string | null,
    searchEngine?: SearchEngine | null,
    graphPopulator?: GraphAutoPopulator | null,
  ) {
    this.decisionStore = decisionStore;
    this.blackboardEngine = blackboardEngine;
    this.embedder = embedder ?? null;
    this.indexManager = indexManager ?? null;
    this.projectRoot = projectRoot ?? null;
    this.searchEngine = searchEngine ?? null;
    this.graphPopulator = graphPopulator ?? null;
  }

  /** Set the function that checks whether an agent assembled context before deciding. */
  setAssemblyChecker(checker: (agentId: string) => boolean): void {
    this.assemblyChecker = checker;
  }

  /**
   * Sync a decision summary to .planning/STATE.md.
   * Appends to the "### Decisions" section under "## Accumulated Context".
   * Never throws — planning sync failure must not prevent decide().
   * Uses direct fs calls because STATE.md is a GSD planning file, not Twining data.
   */
  private syncToPlanning(summary: string): void {
    if (!this.projectRoot) return;

    try {
      const statePath = path.join(this.projectRoot, ".planning", "STATE.md");
      if (!fs.existsSync(statePath)) return;

      const content = fs.readFileSync(statePath, "utf-8");
      const lines = content.split("\n");

      // Find the "### Decisions" section
      let decisionsLineIndex = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]!.trim() === "### Decisions") {
          decisionsLineIndex = i;
          break;
        }
      }

      if (decisionsLineIndex === -1) return; // No Decisions section found

      // Find the end of the Decisions section (next ### or ## header)
      let insertIndex = lines.length; // Default: end of file
      for (let i = decisionsLineIndex + 1; i < lines.length; i++) {
        if (/^#{2,3}\s/.test(lines[i]!)) {
          insertIndex = i;
          break;
        }
      }

      // Insert the decision summary before the next header
      // Walk back over any trailing blank lines to insert after content
      let insertAt = insertIndex;
      while (insertAt > decisionsLineIndex + 1 && lines[insertAt - 1]!.trim() === "") {
        insertAt--;
      }

      const newLine = `- ${summary}`;
      lines.splice(insertAt, 0, newLine);

      fs.writeFileSync(statePath, lines.join("\n"), "utf-8");
    } catch (error) {
      // Never let planning sync failure prevent the decide operation
      console.error(
        "[twining] STATE.md sync failed (non-fatal):",
        error,
      );
    }
  }

  /** Record a decision with full rationale and conflict detection. */
  async decide(input: {
    domain: string;
    scope: string;
    summary: string;
    context: string;
    rationale: string;
    constraints?: string[];
    rationale_source?: RationaleSource;
    alternatives?: Array<{
      option: string;
      pros?: string[];
      cons?: string[];
      reason_rejected?: string;
    }>;
    depends_on?: string[];
    supersedes?: string;
    confidence?: "high" | "medium" | "low";
    reversible?: boolean;
    status?: "active" | "provisional";
    affected_files?: string[];
    affected_symbols?: string[];
    assumptions?: string[];
    agent_id?: string;
    commit_hash?: string;
  }): Promise<{
    id: string;
    timestamp: string;
    conflicts?: { id: string; summary: string }[];
    dropped_depends_on?: string[];
    /** Set when the supersedes target does not exist — it was NOT retired (field D10). */
    supersedes_dangling?: string;
  }> {
    // Validate required fields
    if (!input.domain) {
      throw new TwiningError("domain is required", "INVALID_INPUT");
    }
    // Enforced here, not only in the tool schema: superseded/overridden/
    // archived are lifecycle outcomes with back-links and must stay
    // uncreatable through every caller of decide().
    if (
      input.status !== undefined &&
      input.status !== "active" &&
      input.status !== "provisional"
    ) {
      throw new TwiningError(
        'status must be "active" or "provisional" at creation',
        "INVALID_INPUT",
      );
    }
    // A provisional decision must not retire its predecessor before it is
    // ratified — supersession is create-time-committed (the target is updated
    // immediately below), so the combination would leave a scope with no live
    // decision if the provisional is later vetoed.
    if (input.status === "provisional" && input.supersedes) {
      throw new TwiningError(
        "a provisional decision cannot supersede at creation — the target would be retired before ratification; create as active, or promote first and then supersede",
        "INVALID_INPUT",
      );
    }
    if (!input.scope) {
      throw new TwiningError("scope is required", "INVALID_INPUT");
    }
    if (!input.summary) {
      throw new TwiningError("summary is required", "INVALID_INPUT");
    }
    if (!input.context) {
      throw new TwiningError("context is required", "INVALID_INPUT");
    }
    if (!input.rationale) {
      throw new TwiningError("rationale is required", "INVALID_INPUT");
    }

    // Conflict detection: scan for active decisions in same domain with same or narrower scope.
    // Only flag conflicts when the existing decision is at the same level or more specific —
    // a broad decision at src/ should not conflict with a specific one at src/auth/.
    // The supersede target is excluded: it is being retired below, not conflicted with.
    const index = await this.decisionStore.getIndex();
    const conflicts = index.filter(
      (entry) =>
        entry.domain === input.domain &&
        entry.scope.startsWith(input.scope) &&
        // Both live states conflict: a pending provisional is a live
        // constraint (assemble/verify/why treat it as such), and skipping it
        // would let contradictory decisions ratify with no finding posted.
        (entry.status === "active" || entry.status === "provisional") &&
        entry.summary !== input.summary &&
        entry.id !== input.supersedes,
    );

    // Validate depends_on against the decision store — dangling ids (e.g. from a
    // stale twining_why/assemble snapshot, or a typo) are dropped rather than
    // persisted silently. The caller is told which ids were ignored so it can
    // decide whether that's a real problem, instead of trace()/graph walks
    // later hitting nonexistent nodes.
    const knownIds = new Set(index.map((entry) => entry.id));
    const requestedDependsOn = input.depends_on ?? [];
    const validDependsOn = requestedDependsOn.filter((id) => knownIds.has(id));
    const droppedDependsOn = requestedDependsOn.filter(
      (id) => !knownIds.has(id),
    );

    // Normalize alternatives: ensure pros/cons arrays exist
    // reason_rejected is omitted entirely when absent rather than stored as ""
    // or a placeholder — JSON.stringify drops the undefined key, so a record
    // never asserts a why-not it does not have.
    const alternatives = (input.alternatives ?? []).map((alt) => {
      const normalized: DecisionAlternative = {
        option: alt.option,
        pros: alt.pros ?? [],
        cons: alt.cons ?? [],
      };
      if (alt.reason_rejected) normalized.reason_rejected = alt.reason_rejected;
      return normalized;
    });

    // Create decision — status comes only from input (default active; guard above)
    // Check if agent assembled context before making this decision
    const agentId = input.agent_id ?? "main";
    const assembledBefore = this.assemblyChecker
      ? this.assemblyChecker(agentId)
      : undefined;

    const decision = await this.decisionStore.create({
      agent_id: agentId,
      domain: input.domain,
      scope: input.scope,
      summary: input.summary,
      context: input.context,
      rationale: input.rationale,
      ...(input.rationale_source
        ? { rationale_source: input.rationale_source }
        : {}),
      constraints: input.constraints ?? [],
      alternatives,
      depends_on: validDependsOn,
      supersedes: input.supersedes,
      confidence: (input.confidence ?? "medium") as DecisionConfidence,
      reversible: input.reversible ?? true,
      status: input.status,
      affected_files: input.affected_files ?? [],
      affected_symbols: input.affected_symbols ?? [],
      assumptions: input.assumptions,
      commit_hashes: input.commit_hash ? [input.commit_hash] : [],
      ...(assembledBefore !== undefined ? { assembled_before: assembledBefore } : {}),
      provenance: captureProvenance(this.projectRoot),
    });

    // Registry auto-touch (#32) — the blackboard engine holds the agent
    // store and the skip-unknown rule; best-effort, never fails the decide.
    this.blackboardEngine.touchAgent(agentId);

    // Retire the superseded decision and write the superseded_by back-link so
    // the retired record points at its replacement (#31). Done after create so
    // the replacement id exists; if create throws, the old decision is
    // untouched. A dangling target no longer passes silently (field D10): a
    // typo'd id was indistinguishable from a completed supersession, which
    // reads as a discharged obligation in stores with a supersession-hygiene
    // rule. Still no throw — the new decision itself is valid.
    let supersededDangling: string | undefined;
    if (input.supersedes) {
      const target = await this.decisionStore.get(input.supersedes);
      if (target) {
        await this.decisionStore.updateStatus(input.supersedes, "superseded", {
          superseded_by: decision.id,
        });
      } else {
        supersededDangling = input.supersedes;
      }
    }

    // If conflicts exist, post an informational finding (not a warning — warnings get
    // priority-boosted in assemble output and dominate context, causing rework cascades).
    // The new decision's status is never demoted here — status comes only from input.
    if (conflicts.length > 0) {
      const conflictDetails = conflicts
        .map((c) => `- ${c.id}: "${c.summary}"`)
        .join("\n");
      await this.blackboardEngine.post({
        entry_type: "finding",
        summary: `Related decisions in scope: ${conflicts.length} existing decision(s) overlap`,
        detail: `New decision "${decision.summary}" relates to:\n${conflictDetails}`,
        tags: [input.domain],
        scope: input.scope,
        agent_id: decision.agent_id,
      });
    }

    // No blackboard cross-post (issue #30): decisions live only in the
    // decision store. The old entry_type "decision" mirrors were filtered out
    // by twining_assemble anyway; twining_query/twining_recent now read the
    // decision store directly.

    // Generate embedding (Phase 2) — never let embedding failure prevent the decide
    if (this.embedder && this.indexManager) {
      try {
        const text = decisionEmbedText(decision);
        const vector = await this.embedder.embed(text);
        if (vector) {
          await this.indexManager.addEntry(
            "decisions",
            decision.id,
            vector,
            embedContentHash(text),
          );
        }
      } catch (error) {
        // Silent failure — embedding is best-effort
        console.error(
          "[twining] Decision embedding generation failed (non-fatal):",
          error,
        );
      }
    }

    // Sync decision summary to .planning/STATE.md (Phase 5 GSD bridge)
    this.syncToPlanning(decision.summary);

    // Auto-populate knowledge graph (delegated to GraphAutoPopulator)
    if (this.graphPopulator) {
      await this.graphPopulator.onDecide(
        {
          affected_files: decision.affected_files,
          affected_symbols: decision.affected_symbols,
          depends_on: validDependsOn,
          supersedes: input.supersedes,
          commit_hash: input.commit_hash,
          scope: decision.scope,
          summary: decision.summary,
        },
        decision.id,
      );
    }

    const result: {
      id: string;
      timestamp: string;
      conflicts?: { id: string; summary: string }[];
      dropped_depends_on?: string[];
      supersedes_dangling?: string;
    } = { id: decision.id, timestamp: decision.timestamp };

    if (conflicts.length > 0) {
      result.conflicts = conflicts.map((c) => ({
        id: c.id,
        summary: c.summary,
      }));
    }

    if (droppedDependsOn.length > 0) {
      result.dropped_depends_on = droppedDependsOn;
    }

    if (supersededDangling) {
      result.supersedes_dangling = supersededDangling;
    }

    return result;
  }

  /**
   * Append-only metadata repair (field D11). Adds affected_files/
   * affected_symbols to an existing record — the two fields the retrieval
   * graph and divergence checks key on — with an in-record provenance trail.
   * Semantic content is never amendable (that would demand embedding
   * reindexing and break "a decision record is what was decided, then").
   * Works on retired records: the file list is a factual attribute, not a
   * lifecycle claim. Idempotent: already-present entries append no
   * provenance and touch no store.
   */
  async amend(input: {
    id: string;
    add_affected_files?: string[];
    add_affected_symbols?: string[];
    reason?: string;
    agent_id?: string;
  }): Promise<{
    id: string;
    status: DecisionStatus;
    added_files: string[];
    added_symbols: string[];
    already_present: string[];
    /** False when the amendment persisted but the audit finding could not be posted. */
    audit_posted?: boolean;
  }> {
    if (!input.id) {
      throw new TwiningError("id is required", "INVALID_INPUT");
    }
    const wantFiles = input.add_affected_files ?? [];
    const wantSymbols = input.add_affected_symbols ?? [];
    if (wantFiles.length === 0 && wantSymbols.length === 0) {
      throw new TwiningError(
        "Nothing to amend: provide add_affected_files and/or add_affected_symbols",
        "INVALID_INPUT",
      );
    }
    // An empty or whitespace path would prefix-match EVERY scope query
    // (scopeMatches is bidirectional startsWith), making the decision
    // universally retrieved — and amend has no removal path to undo it.
    if ([...wantFiles, ...wantSymbols].some((s) => s.trim().length === 0)) {
      throw new TwiningError(
        "Empty or whitespace entries are not amendable — they would match every scope query",
        "INVALID_INPUT",
      );
    }

    const decision = await this.decisionStore.get(input.id);
    if (!decision) {
      throw new TwiningError(`Decision not found: ${input.id}`, "NOT_FOUND");
    }

    const existingFiles = new Set(decision.affected_files);
    const existingSymbols = new Set(decision.affected_symbols);
    const addedFiles = [...new Set(wantFiles)].filter(
      (f) => !existingFiles.has(f),
    );
    const addedSymbols = [...new Set(wantSymbols)].filter(
      (s) => !existingSymbols.has(s),
    );
    const alreadyPresent = [
      ...new Set([
        ...wantFiles.filter((f) => existingFiles.has(f)),
        ...wantSymbols.filter((s) => existingSymbols.has(s)),
      ]),
    ];

    if (addedFiles.length === 0 && addedSymbols.length === 0) {
      return {
        id: decision.id,
        status: decision.status,
        added_files: [],
        added_symbols: [],
        already_present: alreadyPresent,
      };
    }

    const amendment: DecisionAmendment = {
      amended_at: new Date().toISOString(),
      amended_by: input.agent_id ?? "main",
      added_files: addedFiles,
      added_symbols: addedSymbols,
      ...(input.reason ? { reason: input.reason } : {}),
    };

    // Deltas only — the backend merges inside its critical section, so a
    // concurrent amend's additions are never clobbered by this one's
    // stale read (lost-update hazard, review finding).
    await this.decisionStore.amendMetadata(decision.id, {
      add_affected_files: addedFiles,
      add_affected_symbols: addedSymbols,
      amendment,
    });

    // Graph edges for the NEW paths only — relations never deduplicate.
    if (this.graphPopulator) {
      await this.graphPopulator.onAmend(
        {
          added_files: addedFiles,
          added_symbols: addedSymbols,
          scope: decision.scope,
          summary: decision.summary,
        },
        decision.id,
      );
    }

    // Audit trail on the blackboard (housekeeping-tools pattern): the
    // amendment must be discoverable without opening the record. Non-fatal
    // like graph population — the amendment is already durably persisted,
    // and erroring here would make a retry hit the idempotent no-op path,
    // losing the audit entry forever while telling the caller it failed.
    let auditPosted = true;
    try {
      await this.blackboardEngine.post({
        entry_type: "finding",
        summary: `Amended decision ${decision.id}: +${addedFiles.length} file(s), +${addedSymbols.length} symbol(s)`,
        detail: `Added affected_files: [${addedFiles.join(", ")}]; affected_symbols: [${addedSymbols.join(", ")}]${input.reason ? `. Reason: ${input.reason}` : ""}. Amended by ${amendment.amended_by}; decision status: ${decision.status}.`,
        tags: ["amend", "audit-trail"],
        scope: decision.scope,
        agent_id: amendment.amended_by,
      });
    } catch (error) {
      auditPosted = false;
      console.error("[twining] amend audit post failed (non-fatal):", error);
    }

    return {
      id: decision.id,
      status: decision.status,
      added_files: addedFiles,
      added_symbols: addedSymbols,
      already_present: alreadyPresent,
      ...(auditPosted ? {} : { audit_posted: false }),
    };
  }

  /**
   * Retrieve decision chain for a scope or file (#41: bounded).
   * Matches are ranked by scope specificity, then status, then recency, and
   * full rationale is returned only for the decisions that fit max_tokens;
   * the remainder comes back as compact one-liners in `more`. Superseded
   * decisions are excluded unless include_superseded is set. Passing ids
   * returns full detail (rationale, context, alternatives) for exactly those
   * decisions with no budget applied — the drill-down path for `more` entries.
   */
  async why(scope: string, options?: WhyOptions): Promise<WhyResult> {
    if (options?.ids && options.ids.length > 0) {
      return this.whyByIds(options.ids);
    }

    const budget = options?.max_tokens ?? DEFAULT_WHY_MAX_TOKENS;
    const all = await this.decisionStore.getByScope(scope);

    // Counts superseded + overridden. Archived are counted ONLY by
    // archived_excluded_count — the old widen-everything semantics double-
    // counted them across both fields (field D10; supersedes the original
    // widening choice). The FILTER below still hides all three retired
    // statuses — only the count partition changed.
    const superseded_count = all.filter(
      (d) => d.status === "superseded" || d.status === "overridden",
    ).length;
    const matches = options?.include_superseded
      ? all
      : all.filter((d) => !WHY_RETIRED_STATUSES.has(d.status));
    // Compact identity of the hidden superseded/overridden records with their
    // successors (field D10) — a bare count reads as silence at the gate.
    const supersededRecords = options?.include_superseded
      ? []
      : all
          .filter((d) => d.status === "superseded" || d.status === "overridden")
          .slice(0, 20);
    const superseded_excluded = await Promise.all(
      supersededRecords.map(async (d) => ({
        id: d.id,
        summary: d.summary,
        ...(d.superseded_by ? { superseded_by: d.superseded_by } : {}),
        ...(options?.lineage && d.superseded_by
          ? {
              lineage_head: await this.resolveLineageHead(d.superseded_by),
            }
          : {}),
      })),
    );

    const ranked = [...matches].sort(
      (a, b) =>
        whySpecificity(b, scope) - whySpecificity(a, scope) ||
        (WHY_STATUS_RANK[b.status] ?? 0) - (WHY_STATUS_RANK[a.status] ?? 0) ||
        b.timestamp.localeCompare(a.timestamp) ||
        b.id.localeCompare(a.id),
    );

    const decisions: WhyDecision[] = [];
    const more: WhyCompactDecision[] = [];
    let omitted_count = 0;
    let tokensUsed = 0;
    for (const d of ranked) {
      const full: WhyDecision = {
        id: d.id,
        summary: d.summary,
        rationale: d.rationale,
        confidence: d.confidence,
        status: d.status,
        timestamp: d.timestamp,
        alternatives_count: d.alternatives.length,
        commit_hashes: d.commit_hashes ?? [],
        // Retired decisions point at their replacement (#31).
        ...(d.superseded_by ? { superseded_by: d.superseded_by } : {}),
      };
      const cost = estimateTokens(JSON.stringify(full));
      if (more.length === 0 && omitted_count === 0 && tokensUsed + cost <= budget) {
        decisions.push(full);
        tokensUsed += cost;
      } else if (more.length < WHY_MAX_COMPACT) {
        more.push({
          id: d.id,
          summary: d.summary,
          status: d.status,
          confidence: d.confidence,
          timestamp: d.timestamp,
        });
      } else {
        omitted_count++;
      }
    }

    const active_count = matches.filter((d) => d.status === "active").length;
    const provisional_count = matches.filter(
      (d) => d.status === "provisional",
    ).length;
    const archived_excluded_count = options?.include_superseded
      ? 0
      : all.filter((d) => d.status === "archived").length;

    return {
      decisions,
      ...(more.length > 0 ? { more } : {}),
      ...(omitted_count > 0 ? { omitted_count } : {}),
      truncated: more.length > 0,
      total_in_scope: matches.length,
      superseded_count,
      ...(superseded_excluded.length > 0 ? { superseded_excluded } : {}),
      ...(archived_excluded_count > 0 ? { archived_excluded_count } : {}),
      active_count,
      provisional_count,
      token_estimate: tokensUsed,
    };
  }

  /**
   * Walk superseded_by to the terminal record of a supersession chain
   * (field D13 ask 3). Cycle-guarded and depth-capped; on a cycle or a
   * dangling link the last reachable record is the reported head.
   */
  private async resolveLineageHead(
    firstSuccessorId: string,
  ): Promise<{ id: string; summary: string; chain_length: number }> {
    const visited = new Set<string>();
    let current = await this.decisionStore.get(firstSuccessorId);
    let head: { id: string; summary: string } = {
      id: firstSuccessorId,
      summary: current?.summary ?? "(unresolved successor)",
    };
    let hops = 1;
    while (current && !visited.has(current.id) && hops < 50) {
      visited.add(current.id);
      head = { id: current.id, summary: current.summary };
      if (!current.superseded_by) break;
      current = await this.decisionStore.get(current.superseded_by);
      if (current) hops++;
    }
    return { ...head, chain_length: hops };
  }

  /** Full-detail drill-down for explicitly requested decision ids (#41). */
  private async whyByIds(ids: string[]): Promise<WhyResult> {
    const decisions: WhyDecision[] = [];
    const missing_ids: string[] = [];
    for (const id of ids) {
      const d = await this.decisionStore.get(id);
      if (!d) {
        missing_ids.push(id);
        continue;
      }
      decisions.push({
        id: d.id,
        summary: d.summary,
        rationale: d.rationale,
        confidence: d.confidence,
        status: d.status,
        timestamp: d.timestamp,
        alternatives_count: d.alternatives.length,
        commit_hashes: d.commit_hashes ?? [],
        ...(d.superseded_by ? { superseded_by: d.superseded_by } : {}),
        // Drill-down carries the detail the tiered response withholds.
        context: d.context,
        alternatives: d.alternatives,
        scope: d.scope,
        domain: d.domain,
        constraints: d.constraints,
        depends_on: d.depends_on,
      });
    }
    return {
      decisions,
      truncated: false,
      total_in_scope: decisions.length,
      superseded_count: decisions.filter((d) => d.status === "superseded")
        .length,
      active_count: decisions.filter((d) => d.status === "active").length,
      provisional_count: decisions.filter((d) => d.status === "provisional")
        .length,
      token_estimate: estimateTokens(JSON.stringify(decisions)),
      ...(missing_ids.length > 0 ? { missing_ids } : {}),
    };
  }

  /**
   * Link a commit hash to an existing decision.
   * Posts a status entry to the blackboard for traceability.
   */
  async linkCommit(
    decisionId: string,
    commitHash: string,
    agentId?: string,
  ): Promise<{ linked: boolean; decision_summary: string }> {
    const decision = await this.decisionStore.get(decisionId);
    if (!decision) {
      throw new TwiningError(
        `Decision not found: ${decisionId}`,
        "NOT_FOUND",
      );
    }

    await this.decisionStore.linkCommit(decisionId, commitHash);

    // Post status entry to blackboard
    const summary = `Commit ${commitHash.slice(0, 7)} linked to decision: ${decision.summary}`.slice(0, 200);
    await this.blackboardEngine.post({
      entry_type: "status",
      summary,
      detail: `Linked commit ${commitHash} to decision ${decisionId}`,
      tags: [decision.domain],
      scope: decision.scope,
      agent_id: agentId ?? "main",
    });

    // Auto-populate graph with commit → decision link
    if (this.graphPopulator) {
      await this.graphPopulator.onLinkCommit(decisionId, commitHash);
    }

    return { linked: true, decision_summary: decision.summary };
  }

  /**
   * Get decisions linked to a specific commit hash.
   */
  async getByCommitHash(commitHash: string): Promise<{
    decisions: Array<{
      id: string;
      summary: string;
      domain: string;
      scope: string;
      confidence: string;
      timestamp: string;
      commit_hashes: string[];
    }>;
  }> {
    const decisions = await this.decisionStore.getByCommitHash(commitHash);
    return {
      decisions: decisions.map((d) => ({
        id: d.id,
        summary: d.summary,
        domain: d.domain,
        scope: d.scope,
        confidence: d.confidence,
        timestamp: d.timestamp,
        commit_hashes: d.commit_hashes,
      })),
    };
  }

  /**
   * Trace a decision's dependency chain upstream and/or downstream.
   * Uses BFS with a visited set to prevent infinite loops from circular dependencies.
   */
  async trace(
    decisionId: string,
    direction: "upstream" | "downstream" | "both" = "both",
  ): Promise<{ chain: TraceEntry[] }> {
    // Verify root decision exists
    const rootDecision = await this.decisionStore.get(decisionId);
    if (!rootDecision) {
      throw new TwiningError(
        `Decision not found: ${decisionId}`,
        "NOT_FOUND",
      );
    }

    // Load all decisions to build the dependency maps
    const index = await this.decisionStore.getIndex();
    const decisions = new Map<string, Decision>();
    for (const entry of index) {
      const d = await this.decisionStore.get(entry.id);
      if (d) decisions.set(d.id, d);
    }

    // Build reverse dependency map: parentId -> [childIds that depend on parent]
    const reverseMap = new Map<string, string[]>();
    for (const [id, d] of decisions) {
      for (const dep of d.depends_on) {
        if (!reverseMap.has(dep)) reverseMap.set(dep, []);
        reverseMap.get(dep)!.push(id);
      }
    }

    const visited = new Set<string>();
    visited.add(decisionId);
    const chain: TraceEntry[] = [];

    // BFS upstream: follow depends_on
    if (direction === "upstream" || direction === "both") {
      const queue = [...(rootDecision.depends_on ?? [])];
      while (queue.length > 0) {
        const current = queue.shift()!;
        if (visited.has(current)) continue;
        visited.add(current);
        const d = decisions.get(current);
        if (d) {
          chain.push({
            id: d.id,
            summary: d.summary,
            depends_on: d.depends_on,
            dependents: reverseMap.get(d.id) ?? [],
            status: d.status,
          });
          for (const dep of d.depends_on) {
            if (!visited.has(dep)) queue.push(dep);
          }
        }
      }
    }

    // BFS downstream: follow reverse map (dependents)
    if (direction === "downstream" || direction === "both") {
      const queue = [...(reverseMap.get(decisionId) ?? [])];
      while (queue.length > 0) {
        const current = queue.shift()!;
        if (visited.has(current)) continue;
        visited.add(current);
        const d = decisions.get(current);
        if (d) {
          chain.push({
            id: d.id,
            summary: d.summary,
            depends_on: d.depends_on,
            dependents: reverseMap.get(d.id) ?? [],
            status: d.status,
          });
          const downstream = reverseMap.get(d.id) ?? [];
          for (const dep of downstream) {
            if (!visited.has(dep)) queue.push(dep);
          }
        }
      }
    }

    return { chain };
  }

  /**
   * Flag a decision for reconsideration.
   * Sets active decisions to provisional and posts a warning.
   */
  async reconsider(
    decisionId: string,
    newContext: string,
    agentId?: string,
  ): Promise<{ flagged: boolean; decision_summary: string }> {
    const decision = await this.decisionStore.get(decisionId);
    if (!decision) {
      throw new TwiningError(
        `Decision not found: ${decisionId}`,
        "NOT_FOUND",
      );
    }

    let flagged = false;
    if (decision.status === "active") {
      await this.decisionStore.updateStatus(decisionId, "provisional");
      flagged = true;
    }

    // Check for downstream dependents
    const index = await this.decisionStore.getIndex();
    const downstreamIds: string[] = [];
    for (const entry of index) {
      const d = await this.decisionStore.get(entry.id);
      if (d && d.depends_on.includes(decisionId)) {
        downstreamIds.push(d.id);
      }
    }

    let detail = newContext;
    if (downstreamIds.length > 0) {
      detail += `\nNote: ${downstreamIds.length} downstream decisions may be affected: ${downstreamIds.join(", ")}`;
    }

    // Post warning to blackboard
    await this.blackboardEngine.post({
      entry_type: "warning",
      summary: `Reconsideration flagged: ${decision.summary}`.slice(0, 200),
      detail,
      tags: [decision.domain],
      scope: decision.scope,
      agent_id: agentId ?? "main",
    });

    // Auto-populate graph with challenged relation
    if (this.graphPopulator) {
      await this.graphPopulator.onChallenge(agentId ?? "main", decisionId, "reconsider");
    }

    return { flagged, decision_summary: decision.summary };
  }

  /**
   * Override a decision with a reason, optionally creating a replacement.
   */
  async override(
    decisionId: string,
    reason: string,
    newDecision?: string,
    overriddenBy?: string,
  ): Promise<{
    overridden: boolean;
    old_summary: string;
    new_decision_id?: string;
  }> {
    const decision = await this.decisionStore.get(decisionId);
    if (!decision) {
      throw new TwiningError(
        `Decision not found: ${decisionId}`,
        "NOT_FOUND",
      );
    }

    // Set status to overridden with extra fields
    await this.decisionStore.updateStatus(decisionId, "overridden", {
      overridden_by: overriddenBy ?? "human",
      override_reason: reason,
    });

    // No blackboard cross-post (issue #30): the override outcome lives in the
    // decision store (status "overridden", overridden_by, override_reason).

    // Auto-populate graph with challenged relation
    if (this.graphPopulator) {
      await this.graphPopulator.onChallenge(overriddenBy ?? "human", decisionId, "override");
    }

    const result: {
      overridden: boolean;
      old_summary: string;
      new_decision_id?: string;
    } = {
      overridden: true,
      old_summary: decision.summary,
    };

    // If a replacement decision is provided, create it via decide()
    if (newDecision) {
      const newResult = await this.decide({
        domain: decision.domain,
        scope: decision.scope,
        summary: newDecision,
        context: reason,
        rationale: reason,
        supersedes: decisionId,
        agent_id: overriddenBy ?? "human",
      });
      result.new_decision_id = newResult.id;
    }

    return result;
  }

  /**
   * Promote provisional decisions to active status.
   * Only provisional decisions can be promoted.
   */
  async promote(
    decisionIds: string[],
    promotedBy?: string,
  ): Promise<{
    promoted: string[];
    already_active: string[];
    not_found: string[];
    wrong_status: Array<{ id: string; status: string }>;
  }> {
    const result: {
      promoted: string[];
      already_active: string[];
      not_found: string[];
      wrong_status: Array<{ id: string; status: string }>;
    } = {
      promoted: [],
      already_active: [],
      not_found: [],
      wrong_status: [],
    };

    for (const id of decisionIds) {
      const decision = await this.decisionStore.get(id);
      if (!decision) {
        result.not_found.push(id);
        continue;
      }

      if (decision.status === "active") {
        result.already_active.push(id);
        continue;
      }

      if (decision.status !== "provisional") {
        result.wrong_status.push({ id, status: decision.status });
        continue;
      }

      await this.decisionStore.updateStatus(id, "active");
      result.promoted.push(id);
    }

    // Post a single status entry if any were promoted
    if (result.promoted.length > 0) {
      await this.blackboardEngine.post({
        entry_type: "status",
        summary:
          `Promoted ${result.promoted.length} provisional decision(s) to active`.slice(
            0,
            200,
          ),
        detail: `Decision IDs: ${result.promoted.join(", ")}`,
        scope: "project",
        agent_id: promotedBy ?? "main",
      });
    }

    return result;
  }

  /**
   * Search decisions across all scopes by keyword or semantic similarity.
   * Supports filtering by domain, status, and confidence.
   * Never throws — returns empty results on error.
   */
  async searchDecisions(
    query: string,
    filters?: {
      domain?: string;
      status?: DecisionStatus;
      confidence?: DecisionConfidence;
    },
    limit?: number,
  ): Promise<{
    results: Array<{
      id: string;
      summary: string;
      domain: string;
      scope: string;
      confidence: string;
      status: string;
      timestamp: string;
      relevance: number;
      commit_hashes: string[];
    }>;
    /**
     * Pre-slice match count — never capped by limit (field D9). Semantic
     * mode counts raw cosine >= the ~0.3 noise floor; keyword mode counts
     * every literal term hit. Membership is always tested on RAW scores,
     * before the retired-status de-boost, so a superseded decision counts
     * exactly like an active one. The results page may include sub-floor
     * rows for ranking context.
     */
    total_matched: number;
    /** Page size actually delivered: results.length. */
    returned: number;
    fallback_mode: boolean;
  }> {
    const maxResults = limit ?? 20;

    try {
      if (!query || query.trim().length === 0) {
        return { results: [], total_matched: 0, returned: 0, fallback_mode: true };
      }

      // Load index and apply filters before loading full decision files
      const index = await this.decisionStore.getIndex();
      let filtered = index;

      if (filters?.domain) {
        filtered = filtered.filter(
          (entry) => entry.domain === filters.domain,
        );
      }
      if (filters?.status) {
        filtered = filtered.filter(
          (entry) => entry.status === filters.status,
        );
      }
      if (filters?.confidence) {
        filtered = filtered.filter(
          (entry) => entry.confidence === filters.confidence,
        );
      }

      if (filtered.length === 0) {
        return { results: [], total_matched: 0, returned: 0, fallback_mode: true };
      }

      // Load full Decision objects for filtered entries
      const decisions: Decision[] = [];
      for (const entry of filtered) {
        const d = await this.decisionStore.get(entry.id);
        if (d) decisions.push(d);
      }

      // Delegate to SearchEngine if available
      if (this.searchEngine) {
        const searchResults = await this.searchEngine.searchDecisions(
          query,
          decisions,
          { limit: maxResults },
        );
        return {
          results: searchResults.results.map((r) => ({
            id: r.decision.id,
            summary: r.decision.summary,
            domain: r.decision.domain,
            scope: r.decision.scope,
            confidence: r.decision.confidence,
            status: r.decision.status,
            timestamp: r.decision.timestamp,
            relevance: r.relevance,
            commit_hashes: r.decision.commit_hashes ?? [],
          })),
          total_matched: searchResults.total_matched,
          returned: searchResults.results.length,
          fallback_mode: searchResults.fallback_mode,
        };
      }

      // Keyword fallback: manual keyword matching
      const queryTerms = query
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length > 0);

      if (queryTerms.length === 0) {
        return { results: [], total_matched: 0, returned: 0, fallback_mode: true };
      }

      const scored: Array<{
        decision: Decision;
        relevance: number;
      }> = [];

      for (const decision of decisions) {
        const text = (
          decision.summary +
          " " +
          decision.rationale +
          " " +
          decision.context
        ).toLowerCase();

        let score = 0;
        for (const term of queryTerms) {
          if (text.includes(term)) {
            const parts = text.split(term);
            const matches = parts.length - 1;
            score += Math.log(1 + matches);
          }
        }

        const normalizedScore = score / queryTerms.length;
        if (normalizedScore > 0) {
          // Same retired-status de-boost as SearchEngine (field D9): a
          // superseded original must not outrank its own amendment.
          const weight = WHY_RETIRED_STATUSES.has(decision.status) ? 0.75 : 1;
          scored.push({ decision, relevance: normalizedScore * weight });
        }
      }

      scored.sort((a, b) => b.relevance - a.relevance);
      const topResults = scored.slice(0, maxResults);

      return {
        results: topResults.map((r) => ({
          id: r.decision.id,
          summary: r.decision.summary,
          domain: r.decision.domain,
          scope: r.decision.scope,
          confidence: r.decision.confidence,
          status: r.decision.status,
          timestamp: r.decision.timestamp,
          relevance: r.relevance,
          commit_hashes: r.decision.commit_hashes ?? [],
        })),
        // Keyword mode: every literal term hit is a match (TF scores are a
        // different scale than the cosine noise floor); the de-boost above is
        // ordering-only and never affects membership.
        total_matched: scored.length,
        returned: topResults.length,
        fallback_mode: true,
      };
    } catch (error) {
      console.error(
        "[twining] searchDecisions failed (non-fatal):",
        error,
      );
      return { results: [], total_matched: 0, returned: 0, fallback_mode: true };
    }
  }
}
