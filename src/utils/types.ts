/**
 * Core TypeScript interfaces for Twining MCP Server.
 * Matches TWINING-DESIGN-SPEC.md section 3 exactly.
 */

// Blackboard entry types — all 10 from spec section 3.1
export const ENTRY_TYPES = [
  "need",
  "offer",
  "finding",
  "decision",
  "constraint",
  "question",
  "answer",
  "status",
  "artifact",
  "warning",
] as const;

export type EntryType = (typeof ENTRY_TYPES)[number];

/** Blackboard Entry — spec section 3.1 */
export interface BlackboardEntry {
  id: string;
  timestamp: string;
  agent_id: string;
  entry_type: EntryType;
  tags: string[];
  relates_to?: string[];
  scope: string;
  summary: string;
  detail: string;
  embedding_id?: string;
}

/** Decision alternative — nested in Decision */
export interface DecisionAlternative {
  option: string;
  pros: string[];
  cons: string[];
  reason_rejected: string;
}

export type DecisionConfidence = "high" | "medium" | "low";
export type DecisionStatus =
  | "active"
  | "provisional"
  | "superseded"
  | "overridden";

/** Decision — spec section 3.2 */
export interface Decision {
  id: string;
  timestamp: string;
  agent_id: string;
  domain: string;
  scope: string;
  summary: string;
  context: string;
  rationale: string;
  constraints: string[];
  alternatives: DecisionAlternative[];
  depends_on: string[];
  supersedes?: string;
  confidence: DecisionConfidence;
  status: DecisionStatus;
  reversible: boolean;
  affected_files: string[];
  affected_symbols: string[];
  commit_hashes: string[];
  overridden_by?: string;
  override_reason?: string;
  assembled_before?: boolean;
}

/** Knowledge Graph Entity — spec section 3.3 */
export interface Entity {
  id: string;
  name: string;
  type:
    | "module"
    | "function"
    | "class"
    | "file"
    | "concept"
    | "pattern"
    | "dependency"
    | "api_endpoint";
  properties: Record<string, string>;
  created_at: string;
  updated_at: string;
}

/** Knowledge Graph Relation — spec section 3.4 */
export interface Relation {
  id: string;
  source: string;
  target: string;
  type:
    | "depends_on"
    | "implements"
    | "decided_by"
    | "affects"
    | "tested_by"
    | "calls"
    | "imports"
    | "related_to";
  properties: Record<string, string>;
  created_at: string;
}

/** Assembled Context — spec section 3.5 (ephemeral output) */
export interface AssembledContext {
  assembled_at: string;
  task: string;
  scope: string;
  token_estimate: number;
  active_decisions: {
    id: string;
    summary: string;
    rationale: string;
    confidence: string;
    affected_files: string[];
  }[];
  open_needs: Pick<BlackboardEntry, "id" | "summary" | "scope" | "timestamp">[];
  recent_findings: Pick<
    BlackboardEntry,
    "id" | "summary" | "detail" | "scope" | "timestamp"
  >[];
  active_warnings: Pick<
    BlackboardEntry,
    "id" | "summary" | "detail" | "scope" | "timestamp"
  >[];
  recent_questions: Pick<
    BlackboardEntry,
    "id" | "summary" | "scope" | "timestamp"
  >[];
  related_entities: {
    name: string;
    type: string;
    relations: string[];
  }[];
  planning_state?: PlanningState;
  recent_handoffs?: {
    id: string;
    source_agent: string;
    target_agent: string;
    scope: string;
    summary: string;
    result_status: string;
    acknowledged: boolean;
    created_at: string;
  }[];
  suggested_agents?: {
    agent_id: string;
    capabilities: string[];
    liveness: string;
  }[];
}

/** Config — matches spec section 2.3 config.yml structure */
export interface TwiningConfig {
  version: number;
  project_name: string;
  embedding_model: string;
  archive: {
    auto_archive_on_commit: boolean;
    auto_archive_on_context_switch: boolean;
    max_blackboard_entries_before_archive: number;
  };
  context_assembly: {
    default_max_tokens: number;
    priority_weights: {
      recency: number;
      relevance: number;
      decision_confidence: number;
      warning_boost: number;
    };
  };
  conflict_resolution: string;
  agents?: {
    liveness: {
      idle_after_ms: number;
      gone_after_ms: number;
    };
  };
  delegations?: {
    timeouts: {
      high_ms: number;
      normal_ms: number;
      low_ms: number;
    };
  };
}

/** Summarize result — spec section 4.3 twining_summarize return */
export interface SummarizeResult {
  scope: string;
  active_decisions: number;
  provisional_decisions: number;
  open_needs: number;
  active_warnings: number;
  unanswered_questions: number;
  recent_activity_summary: string;
  planning_state?: PlanningState;
}

/** What changed result — spec section 4.3 twining_what_changed return */
export interface WhatChangedResult {
  new_decisions: { id: string; summary: string }[];
  new_entries: { id: string; entry_type: string; summary: string }[];
  overridden_decisions: { id: string; summary: string; reason: string }[];
  reconsidered_decisions: { id: string; summary: string }[];
}

/** Planning state from .planning/ directory */
export interface PlanningState {
  current_phase: string;
  progress: string;
  blockers: string[];
  pending_todos: string[];
  open_requirements: string[];
}

/** Decision index entry — subset for fast lookup */
export interface DecisionIndexEntry {
  id: string;
  timestamp: string;
  domain: string;
  scope: string;
  summary: string;
  confidence: DecisionConfidence;
  status: DecisionStatus;
  affected_files: string[];
  affected_symbols: string[];
  commit_hashes: string[];
}

// Agent coordination types — v1.3

/** Agent liveness state derived from last_active timestamp */
export type AgentLiveness = "active" | "idle" | "gone";

/** Configurable thresholds for liveness computation */
export interface LivenessThresholds {
  idle_after_ms: number;
  gone_after_ms: number;
}

/** Agent registry record — spec section for agent coordination */
export interface AgentRecord {
  agent_id: string;
  capabilities: string[];
  role?: string;
  description?: string;
  registered_at: string;
  last_active: string;
}

/** Structured result within a handoff */
export interface HandoffResult {
  description: string;
  status: "completed" | "partial" | "blocked" | "failed";
  artifacts?: string[];
  notes?: string;
}

/** Full handoff record between agents */
export interface HandoffRecord {
  id: string;
  created_at: string;
  source_agent: string;
  target_agent?: string;
  scope?: string;
  summary: string;
  results: HandoffResult[];
  context_snapshot: {
    decision_ids: string[];
    warning_ids: string[];
    finding_ids: string[];
    summaries: string[];
  };
  acknowledged_by?: string;
  acknowledged_at?: string;
}

/** Lightweight handoff index entry for JSONL index */
export interface HandoffIndexEntry {
  id: string;
  created_at: string;
  source_agent: string;
  target_agent?: string;
  scope?: string;
  summary: string;
  result_status:
    | "completed"
    | "partial"
    | "blocked"
    | "failed"
    | "mixed";
  acknowledged: boolean;
}

// Agent discovery result types

/** Input for agent discovery/ranking */
export interface DiscoverInput {
  required_capabilities: string[];
  include_gone?: boolean; // Include gone agents (default: true)
  min_score?: number; // Minimum total_score threshold (default: 0)
}

/** Scored agent result from discovery */
export interface AgentScore {
  agent_id: string;
  capabilities: string[];
  role?: string;
  description?: string;
  liveness: AgentLiveness;
  capability_overlap: number; // 0-1: matched/required
  liveness_score: number; // active=1.0, idle=0.5, gone=0.1
  total_score: number; // weighted combination
  matched_capabilities: string[];
}

/** Result of agent discovery */
export interface DiscoverResult {
  agents: AgentScore[];
  total_registered: number;
}

// Delegation types

/** Urgency levels for delegated tasks */
export type DelegationUrgency = "high" | "normal" | "low";

/** Metadata attached to delegation blackboard entries */
export interface DelegationMetadata {
  type: "delegation";
  required_capabilities: string[];
  urgency: DelegationUrgency;
  expires_at: string;
  timeout_ms?: number;
}

/** Input for posting a delegation to the blackboard */
export interface DelegationInput {
  summary: string;
  required_capabilities: string[];
  urgency?: DelegationUrgency; // Default: "normal"
  timeout_ms?: number; // Override default expiry
  scope?: string;
  tags?: string[];
  agent_id?: string;
}

/** Result of posting a delegation */
export interface DelegationResult {
  entry_id: string;
  timestamp: string;
  expires_at: string;
  suggested_agents: AgentScore[];
}

/** Input for creating a handoff between agents */
export interface CreateHandoffInput {
  source_agent: string;
  target_agent?: string;
  scope?: string;
  summary: string;
  results: HandoffResult[];
  auto_snapshot?: boolean; // Auto-assemble context snapshot (default: true)
  context_snapshot?: HandoffRecord["context_snapshot"]; // Manual override
}

// Verification types — twining_verify tool

/** Test coverage check result */
export interface TestCoverageCheck {
  status: "pass" | "warn" | "fail";
  decisions_in_scope: number;
  decisions_with_tested_by: number;
  uncovered: Array<{ decision_id: string; summary: string; affected_files: string[] }>;
}

/** Warnings check result */
export interface WarningsCheck {
  status: "pass" | "warn" | "fail";
  warnings_in_scope: number;
  acknowledged: number;
  resolved: number;
  silently_ignored: number;
  ignored_details: Array<{ id: string; summary: string }>;
}

/** Assembly tracking check result */
export interface AssemblyCheck {
  status: "pass" | "warn" | "fail";
  decisions_by_agent: number;
  assembled_before: number;
  blind_decisions: Array<{ decision_id: string; summary: string; agent_id: string }>;
}

/** Drift detection check (stub for P2) */
export interface DriftCheck {
  status: "pass" | "warn" | "skip";
  decisions_checked: number;
  stale: Array<{
    decision_id: string;
    summary: string;
    affected_file: string;
    decision_timestamp: string;
    last_file_modification: string;
    modifying_commit: string;
  }>;
}

/** Constraints check (stub for P2) */
export interface ConstraintsCheck {
  status: "pass" | "warn" | "fail" | "skip";
  checkable: number;
  passed: number;
  failed: Array<{
    constraint_id: string;
    summary: string;
    check_command: string;
    actual: string;
    expected: string;
  }>;
}

/** Full verification result from twining_verify */
export interface VerifyResult {
  scope: string;
  verified_at: string;
  checks: {
    test_coverage?: TestCoverageCheck;
    warnings?: WarningsCheck;
    assembly?: AssemblyCheck;
    drift?: DriftCheck;
    constraints?: ConstraintsCheck;
  };
  summary: string;
}

/** Test coverage result from GraphEngine */
export interface TestCoverageResult {
  decisions_in_scope: number;
  decisions_with_tested_by: number;
  uncovered: Array<{ decision_id: string; summary: string; affected_files: string[] }>;
}
