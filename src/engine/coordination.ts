/**
 * Coordination engine for agent discovery, delegation, and handoffs.
 * Provides scoring algorithm and discovery method for ranking agents
 * by capability overlap and liveness.
 */
import type { AgentStore } from "../storage/agent-store.js";
import type { HandoffStore } from "../storage/handoff-store.js";
import type { BlackboardEngine } from "./blackboard.js";
import type { DecisionStore } from "../storage/decision-store.js";
import type { BlackboardStore } from "../storage/blackboard-store.js";
import {
  computeLiveness,
  DEFAULT_LIVENESS_THRESHOLDS,
} from "../utils/liveness.js";
import { normalizeTags } from "../utils/tags.js";
import type {
  AgentRecord,
  AgentLiveness,
  AgentScore,
  LivenessThresholds,
  DiscoverInput,
  DiscoverResult,
  DelegationInput,
  DelegationResult,
  DelegationMetadata,
  DelegationUrgency,
  BlackboardEntry,
  CreateHandoffInput,
  HandoffRecord,
  TwiningConfig,
} from "../utils/types.js";

/** Map liveness state to a numeric score. */
function livenessToScore(liveness: AgentLiveness): number {
  switch (liveness) {
    case "active":
      return 1.0;
    case "idle":
      return 0.5;
    case "gone":
      return 0.1;
  }
}

/**
 * Score an agent against required capabilities and liveness.
 * Pure function — no side effects, fully testable in isolation.
 *
 * Weighting: 70% capability overlap + 30% liveness score.
 */
export function scoreAgent(
  agent: AgentRecord,
  requiredCapabilities: string[],
  livenessThresholds: LivenessThresholds,
  now: Date = new Date(),
): AgentScore {
  // Normalize required capabilities for case-insensitive matching
  const normalizedRequired = normalizeTags(requiredCapabilities);

  // Find matched capabilities
  const matched = agent.capabilities.filter((cap) =>
    normalizedRequired.includes(cap),
  );

  // Compute capability overlap: matched / required, or 0 if no requirements
  const capability_overlap =
    normalizedRequired.length > 0 ? matched.length / normalizedRequired.length : 0;

  // Compute liveness
  const liveness = computeLiveness(agent.last_active, now, livenessThresholds);
  const liveness_score = livenessToScore(liveness);

  // Weighted total: 70% capability + 30% liveness
  const total_score = capability_overlap * 0.7 + liveness_score * 0.3;

  return {
    agent_id: agent.agent_id,
    capabilities: agent.capabilities,
    role: agent.role,
    description: agent.description,
    liveness,
    capability_overlap,
    liveness_score,
    total_score,
    matched_capabilities: matched,
  };
}

/** Default timeout durations per urgency level. */
export const DELEGATION_TIMEOUTS: Record<DelegationUrgency, number> = {
  high: 300000,       // 5 minutes
  normal: 1800000,    // 30 minutes
  low: 14400000,      // 4 hours
};

/**
 * Parse delegation metadata from a blackboard entry's detail field.
 * Returns null for non-delegation entries or malformed JSON.
 */
export function parseDelegationMetadata(
  entry: BlackboardEntry,
): DelegationMetadata | null {
  if (!entry.detail) return null;
  try {
    const parsed = JSON.parse(entry.detail);
    if (parsed && parsed.type === "delegation") {
      return parsed as DelegationMetadata;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Check if a delegation has expired.
 * Returns true when now >= expires_at (boundary inclusive).
 */
export function isDelegationExpired(
  metadata: DelegationMetadata,
  now: Date = new Date(),
): boolean {
  return now.getTime() >= new Date(metadata.expires_at).getTime();
}

export class CoordinationEngine {
  private readonly agentStore: AgentStore;
  private readonly handoffStore: HandoffStore;
  private readonly blackboardEngine: BlackboardEngine;
  private readonly decisionStore: DecisionStore;
  private readonly blackboardStore: BlackboardStore;
  private readonly config: TwiningConfig;

  constructor(
    agentStore: AgentStore,
    handoffStore: HandoffStore,
    blackboardEngine: BlackboardEngine,
    decisionStore: DecisionStore,
    blackboardStore: BlackboardStore,
    config: TwiningConfig,
  ) {
    this.agentStore = agentStore;
    this.handoffStore = handoffStore;
    this.blackboardEngine = blackboardEngine;
    this.decisionStore = decisionStore;
    this.blackboardStore = blackboardStore;
    this.config = config;
  }

  /** Discover and rank agents by capability match and liveness. */
  async discover(input: DiscoverInput): Promise<DiscoverResult> {
    const agents = await this.agentStore.getAll();
    const thresholds =
      this.config.agents?.liveness ?? DEFAULT_LIVENESS_THRESHOLDS;
    const now = new Date();

    // Score each agent
    let scores = agents.map((agent) =>
      scoreAgent(agent, input.required_capabilities, thresholds, now),
    );

    // Filter: exclude gone agents if include_gone === false
    if (input.include_gone === false) {
      scores = scores.filter((s) => s.liveness !== "gone");
    }

    // Filter: exclude agents below min_score threshold
    if (input.min_score !== undefined) {
      scores = scores.filter((s) => s.total_score >= input.min_score!);
    }

    // Sort by total_score descending
    scores.sort((a, b) => b.total_score - a.total_score);

    return {
      agents: scores,
      total_registered: agents.length,
    };
  }

  /** Post a delegation request to the blackboard. */
  async postDelegation(input: DelegationInput): Promise<DelegationResult> {
    const now = new Date();
    const urgency: DelegationUrgency = input.urgency ?? "normal";

    // Compute timeout: custom override > config > default constant
    const urgencyKey = `${urgency}_ms` as keyof NonNullable<
      TwiningConfig["delegations"]
    >["timeouts"];
    const configTimeout = this.config.delegations?.timeouts?.[urgencyKey];
    const timeoutMs =
      input.timeout_ms ?? configTimeout ?? DELEGATION_TIMEOUTS[urgency];

    // Compute expiry
    const expiresAt = new Date(now.getTime() + timeoutMs).toISOString();

    // Normalize capabilities
    const normalizedCapabilities = normalizeTags(input.required_capabilities);

    // Build delegation metadata
    const metadata: DelegationMetadata = {
      type: "delegation",
      required_capabilities: normalizedCapabilities,
      urgency,
      expires_at: expiresAt,
      timeout_ms: timeoutMs,
    };

    // Build tags: user tags + delegation + urgency
    const tags = [...(input.tags ?? []), "delegation", urgency];

    // Post to blackboard as a "need" entry
    const { id, timestamp } = await this.blackboardEngine.post({
      entry_type: "need",
      summary: input.summary,
      detail: JSON.stringify(metadata),
      tags,
      scope: input.scope ?? "project",
      agent_id: input.agent_id ?? "main",
    });

    // Get suggested agents via discover (exclude gone agents)
    const discovery = await this.discover({
      required_capabilities: input.required_capabilities,
      include_gone: false,
    });

    return {
      entry_id: id,
      timestamp,
      expires_at: expiresAt,
      suggested_agents: discovery.agents,
    };
  }

  /**
   * Assemble a context snapshot from active decisions and blackboard
   * warnings/findings. Used by createHandoff when auto_snapshot is true.
   */
  private async assembleContextSnapshot(
    scope?: string,
  ): Promise<HandoffRecord["context_snapshot"]> {
    // 1. Get decision index and filter to active decisions
    const decisionIndex = await this.decisionStore.getIndex();
    let activeDecisions = decisionIndex.filter((d) => d.status === "active");

    // If scope provided, use bidirectional prefix matching
    if (scope) {
      activeDecisions = activeDecisions.filter(
        (d) => d.scope.startsWith(scope) || scope.startsWith(d.scope),
      );
    }

    // 2. Read blackboard entries for warnings and findings
    const { entries: bbEntries } = await this.blackboardStore.read({
      entry_types: ["warning", "finding"],
      scope,
    });

    const warnings = bbEntries.filter((e) => e.entry_type === "warning");
    const findings = bbEntries.filter((e) => e.entry_type === "finding");

    // 3. Build context snapshot
    const decision_ids = activeDecisions.map((d) => d.id);
    const warning_ids = warnings.map((e) => e.id);
    const finding_ids = findings.map((e) => e.id);

    // 4. Build capped summaries
    const summaries: string[] = [];
    for (const d of activeDecisions.slice(0, 5)) {
      summaries.push(`Decision: ${d.summary}`);
    }
    for (const w of warnings.slice(0, 3)) {
      summaries.push(`Warning: ${w.summary}`);
    }
    for (const f of findings.slice(0, 3)) {
      summaries.push(`Finding: ${f.summary}`);
    }

    return { decision_ids, warning_ids, finding_ids, summaries };
  }

  /** Create a handoff record between agents. */
  async createHandoff(input: CreateHandoffInput): Promise<HandoffRecord> {
    // 1. Determine context_snapshot
    let context_snapshot: HandoffRecord["context_snapshot"];
    if (input.context_snapshot) {
      // Manual override
      context_snapshot = input.context_snapshot;
    } else if (input.auto_snapshot !== false) {
      // Auto-assemble (default)
      context_snapshot = await this.assembleContextSnapshot(input.scope);
    } else {
      // Explicitly disabled
      context_snapshot = {
        decision_ids: [],
        warning_ids: [],
        finding_ids: [],
        summaries: [],
      };
    }

    // 2. Create via HandoffStore
    const record = await this.handoffStore.create({
      source_agent: input.source_agent,
      target_agent: input.target_agent,
      scope: input.scope,
      summary: input.summary,
      results: input.results,
      context_snapshot,
    });

    // 3. Post status entry to blackboard
    const statusSummary = `Handoff created: ${input.summary}`.slice(0, 200);
    const statusDetail = `From ${input.source_agent} to ${input.target_agent ?? "any agent"}. ${input.results.length} result(s).`;
    await this.blackboardEngine.post({
      entry_type: "status",
      summary: statusSummary,
      detail: statusDetail,
      tags: ["handoff"],
      scope: input.scope ?? "project",
      agent_id: input.source_agent,
    });

    return record;
  }

  /** Acknowledge receipt of a handoff. */
  async acknowledgeHandoff(
    handoffId: string,
    agentId: string,
  ): Promise<HandoffRecord> {
    return this.handoffStore.acknowledge(handoffId, agentId);
  }
}
