/**
 * Decision business logic.
 * Validates input, applies defaults, delegates to DecisionStore,
 * and cross-posts to blackboard.
 * Phase 3: Adds trace, reconsider, override, and conflict detection.
 * Generates embeddings on decide (Phase 2) with graceful fallback.
 * Phase 5: Syncs decision summaries to .planning/STATE.md for GSD bridge.
 */
import fs from "node:fs";
import path from "node:path";
import { DecisionStore } from "../storage/decision-store.js";
import { BlackboardEngine } from "./blackboard.js";
import { TwiningError } from "../utils/errors.js";
import type {
  Decision,
  DecisionConfidence,
  DecisionStatus,
} from "../utils/types.js";
import type { Embedder } from "../embeddings/embedder.js";
import type { IndexManager } from "../embeddings/index-manager.js";
import type { SearchEngine } from "../embeddings/search.js";
import type { GraphEngine } from "./graph.js";

/** Entry in a dependency trace chain. */
export interface TraceEntry {
  id: string;
  summary: string;
  depends_on: string[];
  dependents: string[];
  status: string;
}

export class DecisionEngine {
  private readonly decisionStore: DecisionStore;
  private readonly blackboardEngine: BlackboardEngine;
  private readonly embedder: Embedder | null;
  private readonly indexManager: IndexManager | null;
  private readonly projectRoot: string | null;
  private readonly searchEngine: SearchEngine | null;
  private readonly graphEngine: GraphEngine | null;
  private assemblyChecker?: (agentId: string) => boolean;

  constructor(
    decisionStore: DecisionStore,
    blackboardEngine: BlackboardEngine,
    embedder?: Embedder | null,
    indexManager?: IndexManager | null,
    projectRoot?: string | null,
    searchEngine?: SearchEngine | null,
    graphEngine?: GraphEngine | null,
  ) {
    this.decisionStore = decisionStore;
    this.blackboardEngine = blackboardEngine;
    this.embedder = embedder ?? null;
    this.indexManager = indexManager ?? null;
    this.projectRoot = projectRoot ?? null;
    this.searchEngine = searchEngine ?? null;
    this.graphEngine = graphEngine ?? null;
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
    alternatives?: Array<{
      option: string;
      pros?: string[];
      cons?: string[];
      reason_rejected: string;
    }>;
    depends_on?: string[];
    supersedes?: string;
    confidence?: "high" | "medium" | "low";
    reversible?: boolean;
    affected_files?: string[];
    affected_symbols?: string[];
    agent_id?: string;
    commit_hash?: string;
  }): Promise<{
    id: string;
    timestamp: string;
    conflicts?: { id: string; summary: string }[];
  }> {
    // Validate required fields
    if (!input.domain) {
      throw new TwiningError("domain is required", "INVALID_INPUT");
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

    // If supersedes, mark old decision
    if (input.supersedes) {
      await this.decisionStore.updateStatus(input.supersedes, "superseded");
    }

    // Conflict detection: scan for active decisions in same domain with overlapping scope
    const index = await this.decisionStore.getIndex();
    const conflicts = index.filter(
      (entry) =>
        entry.domain === input.domain &&
        (entry.scope.startsWith(input.scope) ||
          input.scope.startsWith(entry.scope)) &&
        entry.status === "active" &&
        entry.summary !== input.summary,
    );

    // Normalize alternatives: ensure pros/cons arrays exist
    const alternatives = (input.alternatives ?? []).map((alt) => ({
      option: alt.option,
      pros: alt.pros ?? [],
      cons: alt.cons ?? [],
      reason_rejected: alt.reason_rejected,
    }));

    // Create decision with defaults — provisional if conflicts found
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
      constraints: input.constraints ?? [],
      alternatives,
      depends_on: input.depends_on ?? [],
      supersedes: input.supersedes,
      confidence: (input.confidence ?? "medium") as DecisionConfidence,
      reversible: input.reversible ?? true,
      affected_files: input.affected_files ?? [],
      affected_symbols: input.affected_symbols ?? [],
      commit_hashes: input.commit_hash ? [input.commit_hash] : [],
      ...(assembledBefore !== undefined ? { assembled_before: assembledBefore } : {}),
    });

    // If conflicts exist, mark new decision as provisional and post warning
    if (conflicts.length > 0) {
      await this.decisionStore.updateStatus(decision.id, "provisional");
      const conflictDetails = conflicts
        .map((c) => `- ${c.id}: "${c.summary}"`)
        .join("\n");
      await this.blackboardEngine.post({
        entry_type: "warning",
        summary: `Potential conflict: new decision may conflict with ${conflicts.length} existing decision(s)`,
        detail: `New decision "${decision.summary}" conflicts with:\n${conflictDetails}`,
        tags: [input.domain],
        scope: input.scope,
        agent_id: decision.agent_id,
      });
    }

    // Cross-post to blackboard (internal — bypasses decision rejection)
    await this.blackboardEngine.post({
      entry_type: "decision",
      summary: decision.summary,
      detail: decision.rationale,
      tags: [decision.domain],
      scope: decision.scope,
      agent_id: decision.agent_id,
      _internal: true,
    });

    // Generate embedding (Phase 2) — never let embedding failure prevent the decide
    if (this.embedder && this.indexManager) {
      try {
        const text =
          decision.summary + " " + decision.rationale + " " + decision.context;
        const vector = await this.embedder.embed(text);
        if (vector) {
          await this.indexManager.addEntry("decisions", decision.id, vector);
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

    // Auto-populate knowledge graph with affected files/symbols (spec §4.2)
    if (this.graphEngine) {
      try {
        // Create a concept entity for the decision itself so relations can reference it
        const decisionEntity = await this.graphEngine.addEntity({
          name: decision.id,
          type: "concept",
          properties: { summary: decision.summary, scope: decision.scope },
        });
        for (const filePath of decision.affected_files) {
          const entity = await this.graphEngine.addEntity({
            name: filePath,
            type: "file",
            properties: { scope: decision.scope },
          });
          await this.graphEngine.addRelation({
            source: entity.name,
            target: decisionEntity.name,
            type: "decided_by",
            properties: { decision_summary: decision.summary },
          });
        }
        for (const symbol of decision.affected_symbols) {
          const entity = await this.graphEngine.addEntity({
            name: symbol,
            type: "function",
            properties: { scope: decision.scope },
          });
          await this.graphEngine.addRelation({
            source: entity.name,
            target: decisionEntity.name,
            type: "decided_by",
            properties: { decision_summary: decision.summary },
          });
        }
      } catch (error) {
        // Non-fatal — graph enrichment is best-effort
        console.error("[twining] Graph auto-population failed (non-fatal):", error);
      }
    }

    const result: {
      id: string;
      timestamp: string;
      conflicts?: { id: string; summary: string }[];
    } = { id: decision.id, timestamp: decision.timestamp };

    if (conflicts.length > 0) {
      result.conflicts = conflicts.map((c) => ({
        id: c.id,
        summary: c.summary,
      }));
    }

    return result;
  }

  /** Retrieve decision chain for a scope or file. */
  async why(scope: string): Promise<{
    decisions: Array<{
      id: string;
      summary: string;
      rationale: string;
      confidence: string;
      status: string;
      timestamp: string;
      alternatives_count: number;
      commit_hashes: string[];
    }>;
    active_count: number;
    provisional_count: number;
  }> {
    const decisions = await this.decisionStore.getByScope(scope);

    const mapped = decisions.map((d) => ({
      id: d.id,
      summary: d.summary,
      rationale: d.rationale,
      confidence: d.confidence,
      status: d.status,
      timestamp: d.timestamp,
      alternatives_count: d.alternatives.length,
      commit_hashes: d.commit_hashes ?? [],
    }));

    const active_count = decisions.filter((d) => d.status === "active").length;
    const provisional_count = decisions.filter(
      (d) => d.status === "provisional",
    ).length;

    return { decisions: mapped, active_count, provisional_count };
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

    // Post override entry to blackboard (internal — bypasses decision rejection)
    const overrider = overriddenBy ?? "human";
    await this.blackboardEngine.post({
      entry_type: "decision",
      summary:
        `Override: ${decision.summary} -- overridden by ${overrider}`.slice(
          0,
          200,
        ),
      detail: reason,
      tags: [decision.domain],
      scope: decision.scope,
      agent_id: overrider,
      _internal: true,
    });

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
    total_matched: number;
    fallback_mode: boolean;
  }> {
    const maxResults = limit ?? 20;

    try {
      if (!query || query.trim().length === 0) {
        return { results: [], total_matched: 0, fallback_mode: true };
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
        return { results: [], total_matched: 0, fallback_mode: true };
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
          total_matched: searchResults.results.length,
          fallback_mode: searchResults.fallback_mode,
        };
      }

      // Keyword fallback: manual keyword matching
      const queryTerms = query
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length > 0);

      if (queryTerms.length === 0) {
        return { results: [], total_matched: 0, fallback_mode: true };
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
          scored.push({ decision, relevance: normalizedScore });
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
        total_matched: topResults.length,
        fallback_mode: true,
      };
    } catch (error) {
      console.error(
        "[twining] searchDecisions failed (non-fatal):",
        error,
      );
      return { results: [], total_matched: 0, fallback_mode: true };
    }
  }
}
