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
  overridden_by?: string;
  override_reason?: string;
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
}
