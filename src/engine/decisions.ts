/**
 * Decision business logic.
 * Validates input, applies defaults, delegates to DecisionStore,
 * and cross-posts to blackboard.
 * Generates embeddings on decide (Phase 2) with graceful fallback.
 */
import { DecisionStore } from "../storage/decision-store.js";
import { BlackboardEngine } from "./blackboard.js";
import { TwiningError } from "../utils/errors.js";
import type { DecisionConfidence } from "../utils/types.js";
import type { Embedder } from "../embeddings/embedder.js";
import type { IndexManager } from "../embeddings/index-manager.js";

export class DecisionEngine {
  private readonly decisionStore: DecisionStore;
  private readonly blackboardEngine: BlackboardEngine;
  private readonly embedder: Embedder | null;
  private readonly indexManager: IndexManager | null;

  constructor(
    decisionStore: DecisionStore,
    blackboardEngine: BlackboardEngine,
    embedder?: Embedder | null,
    indexManager?: IndexManager | null,
  ) {
    this.decisionStore = decisionStore;
    this.blackboardEngine = blackboardEngine;
    this.embedder = embedder ?? null;
    this.indexManager = indexManager ?? null;
  }

  /** Record a decision with full rationale. */
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
  }): Promise<{ id: string; timestamp: string }> {
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

    // Normalize alternatives: ensure pros/cons arrays exist
    const alternatives = (input.alternatives ?? []).map((alt) => ({
      option: alt.option,
      pros: alt.pros ?? [],
      cons: alt.cons ?? [],
      reason_rejected: alt.reason_rejected,
    }));

    // Create decision with defaults
    const decision = await this.decisionStore.create({
      agent_id: input.agent_id ?? "main",
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
    });

    // Cross-post to blackboard
    await this.blackboardEngine.post({
      entry_type: "decision",
      summary: decision.summary,
      detail: decision.rationale,
      tags: [decision.domain],
      scope: decision.scope,
      agent_id: decision.agent_id,
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

    return { id: decision.id, timestamp: decision.timestamp };
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
    }));

    const active_count = decisions.filter((d) => d.status === "active").length;
    const provisional_count = decisions.filter(
      (d) => d.status === "provisional",
    ).length;

    return { decisions: mapped, active_count, provisional_count };
  }
}
