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
  async postDelegation(_input: DelegationInput): Promise<DelegationResult> {
    throw new Error("not implemented");
  }

  /** Create a handoff record between agents. */
  async createHandoff(_input: CreateHandoffInput): Promise<HandoffRecord> {
    throw new Error("not implemented");
  }

  /** Acknowledge receipt of a handoff. */
  async acknowledgeHandoff(
    _handoffId: string,
    _agentId: string,
  ): Promise<HandoffRecord> {
    throw new Error("not implemented");
  }
}
