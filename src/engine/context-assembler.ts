/**
 * Context assembly engine.
 * Builds tailored context packages for agent tasks within token budgets.
 * Uses weighted multi-signal scoring: recency, relevance, confidence, warning boost.
 */
import type { BlackboardStore } from "../storage/blackboard-store.js";
import type { DecisionStore } from "../storage/decision-store.js";
import type { SearchEngine } from "../embeddings/search.js";
import type { GraphEngine } from "./graph.js";
import type {
  AssembledContext,
  BlackboardEntry,
  Decision,
  SummarizeResult,
  TwiningConfig,
  WhatChangedResult,
} from "../utils/types.js";
import { estimateTokens } from "../utils/tokens.js";

/** Half-life for recency decay in hours (one week). */
const RECENCY_HALF_LIFE = 168;

/** Scored item for budget filling. */
interface ScoredItem {
  type: "decision" | "need" | "warning" | "finding" | "question";
  id: string;
  score: number;
  tokenCost: number;
  data: Decision | BlackboardEntry;
}

export class ContextAssembler {
  private readonly blackboardStore: BlackboardStore;
  private readonly decisionStore: DecisionStore;
  private readonly searchEngine: SearchEngine | null;
  private readonly config: TwiningConfig;
  private readonly graphEngine: GraphEngine | null;

  constructor(
    blackboardStore: BlackboardStore,
    decisionStore: DecisionStore,
    searchEngine: SearchEngine | null,
    config: TwiningConfig,
    graphEngine?: GraphEngine | null,
  ) {
    this.blackboardStore = blackboardStore;
    this.decisionStore = decisionStore;
    this.searchEngine = searchEngine;
    this.config = config;
    this.graphEngine = graphEngine ?? null;
  }

  /**
   * Build tailored context for a specific task within a token budget.
   * Implements spec section 4.3 (twining_assemble).
   */
  async assemble(
    task: string,
    scope: string,
    maxTokens?: number,
  ): Promise<AssembledContext> {
    const budget = maxTokens ?? this.config.context_assembly.default_max_tokens;
    const weights = this.config.context_assembly.priority_weights;
    const now = Date.now();

    // 1. Retrieve scope-matched decisions
    const scopeDecisions = await this.decisionStore.getByScope(scope);
    const activeDecisions = scopeDecisions.filter(
      (d) => d.status === "active" || d.status === "provisional",
    );

    // 2. Retrieve semantically relevant decisions (merge by ID, keep highest relevance)
    const decisionRelevance = new Map<string, number>();
    if (this.searchEngine) {
      const allIndex = await this.decisionStore.getIndex();
      const allDecisionIds = allIndex.map((e) => e.id);
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
      const allIndex = await this.decisionStore.getIndex();
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

    // 3. Retrieve scope-matched blackboard entries
    const { entries: scopeEntries } = await this.blackboardStore.read({
      scope,
    });

    // 4. Retrieve semantically relevant findings
    const entryRelevance = new Map<string, number>();
    if (this.searchEngine) {
      const { entries: allEntries } = await this.blackboardStore.read();
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
      const { entries: allEntries } = await this.blackboardStore.read();
      for (const e of allEntries) {
        if (entryRelevance.has(e.id) && !mergedEntryMap.has(e.id)) {
          mergedEntryMap.set(e.id, e);
        }
      }
    }

    // 5. Score each item
    const scoredItems: ScoredItem[] = [];

    for (const [id, decision] of mergedDecisionMap) {
      const recency = this.recencyScore(decision.timestamp, now);
      const relevance = decisionRelevance.get(id) ?? 0.5;
      const confidence = this.confidenceScore(decision.confidence);
      const warningBoost = 0;
      const score =
        recency * weights.recency +
        relevance * weights.relevance +
        confidence * weights.decision_confidence +
        warningBoost * weights.warning_boost;
      const text = `${decision.summary} ${decision.rationale} ${decision.confidence} ${decision.affected_files.join(", ")}`;
      scoredItems.push({
        type: "decision",
        id,
        score,
        tokenCost: estimateTokens(text),
        data: decision,
      });
    }

    for (const [id, entry] of mergedEntryMap) {
      const recency = this.recencyScore(entry.timestamp, now);
      const relevance = entryRelevance.get(id) ?? 0.5;
      const confidence = 0.5; // Neutral for non-decisions
      const warningBoost = entry.entry_type === "warning" ? 1.0 : 0.0;
      const score =
        recency * weights.recency +
        relevance * weights.relevance +
        confidence * weights.decision_confidence +
        warningBoost * weights.warning_boost;
      const text = `${entry.summary} ${entry.detail}`;
      scoredItems.push({
        type: entry.entry_type as ScoredItem["type"],
        id,
        score,
        tokenCost: estimateTokens(text),
        data: entry,
      });
    }

    // 6. Fill token budget in priority order
    // Reserve 10% for warnings
    const warningBudget = Math.floor(budget * 0.1);
    const mainBudget = budget - warningBudget;

    // Separate warnings and non-warnings
    const warnings = scoredItems.filter((i) => i.type === "warning");
    const nonWarnings = scoredItems.filter((i) => i.type !== "warning");

    warnings.sort((a, b) => b.score - a.score);
    nonWarnings.sort((a, b) => b.score - a.score);

    const selected = new Set<string>();
    let tokensUsed = 0;

    // First: fill warnings with reserved budget
    for (const item of warnings) {
      if (tokensUsed + item.tokenCost <= budget) {
        selected.add(item.id);
        tokensUsed += item.tokenCost;
      }
    }

    // Then: fill non-warnings with remaining budget
    for (const item of nonWarnings) {
      if (tokensUsed + item.tokenCost <= budget) {
        selected.add(item.id);
        tokensUsed += item.tokenCost;
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

    // 7. Build AssembledContext
    const activeDecisionResults: AssembledContext["active_decisions"] = [];
    const openNeeds: AssembledContext["open_needs"] = [];
    const recentFindings: AssembledContext["recent_findings"] = [];
    const activeWarnings: AssembledContext["active_warnings"] = [];
    const recentQuestions: AssembledContext["recent_questions"] = [];

    for (const item of scoredItems) {
      if (!selected.has(item.id)) continue;

      if (item.type === "decision") {
        const d = item.data as Decision;
        activeDecisionResults.push({
          id: d.id,
          summary: d.summary,
          rationale: d.rationale,
          confidence: d.confidence,
          affected_files: d.affected_files,
        });
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
              detail: e.detail,
              scope: e.scope,
              timestamp: e.timestamp,
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

    // 8. Populate related_entities from knowledge graph
    const relatedEntities = await this.getRelatedEntities(scope);

    return {
      assembled_at: new Date().toISOString(),
      task,
      scope,
      token_estimate: tokensUsed,
      active_decisions: activeDecisionResults,
      open_needs: openNeeds,
      recent_findings: recentFindings,
      active_warnings: activeWarnings,
      recent_questions: recentQuestions,
      related_entities: relatedEntities,
    };
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

    const recentActivitySummary =
      `In the last 24 hours: ${recentDecisionCount} decision${recentDecisionCount !== 1 ? "s" : ""} made, ` +
      `${recentFindingCount} finding${recentFindingCount !== 1 ? "s" : ""} posted, ` +
      `${recentWarningCount} warning${recentWarningCount !== 1 ? "s" : ""} raised.`;

    return {
      scope: targetScope,
      active_decisions: activeDecisions,
      provisional_decisions: provisionalDecisions,
      open_needs: openNeeds,
      active_warnings: activeWarnings,
      unanswered_questions: unansweredQuestions,
      recent_activity_summary: recentActivitySummary,
    };
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

    // Find reconsidered (provisional) decisions since timestamp
    const reconsideredDecisions = filteredIndex
      .filter((e) => e.status === "provisional")
      .map((e) => ({ id: e.id, summary: e.summary }));

    return {
      new_decisions: newDecisions,
      new_entries: newEntries,
      overridden_decisions: overriddenDecisions,
      reconsidered_decisions: reconsideredDecisions,
    };
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
}
