/**
 * Storage backend interfaces — the contract between engines and persistence.
 *
 * Engines and tools type against these interfaces, never against the concrete
 * file-backed classes, so an alternative backend (the planned SQLite store,
 * docs/FOUNDATION-PLAN.md W2.2) can be swapped in without touching engine
 * code. TypeScript's structural typing alone is not enough here: the concrete
 * classes have private fields, which makes their class types nominal.
 *
 * Every method mirrors the corresponding file-store class verbatim — this
 * extraction is behavior-neutral by construction.
 */
import type {
  AgentRecord,
  BlackboardEntry,
  Decision,
  DecisionIndexEntry,
  DecisionAmendment,
  DecisionStatus,
  Entity,
  HandoffIndexEntry,
  HandoffRecord,
  Relation,
  ToolUsageSummary,
  UsageBucket,
} from "../utils/types.js";
import type {
  EmbeddingIndex,
  IndexName,
} from "../embeddings/index-manager.js";

/** Append-only blackboard persistence (blackboard.jsonl today). */
export interface IBlackboardStore {
  append(
    entry: Omit<BlackboardEntry, "id" | "timestamp">,
  ): Promise<BlackboardEntry>;
  read(filters?: {
    entry_types?: string[];
    tags?: string[];
    scope?: string;
    since?: string;
    limit?: number;
  }): Promise<{ entries: BlackboardEntry[]; total_count: number }>;
  recent(n?: number, entry_types?: string[]): Promise<BlackboardEntry[]>;
  dismiss(
    ids: string[],
  ): Promise<{ dismissed: string[]; not_found: string[] }>;
  /**
   * Mark entries resolved in place (D2). Idempotent: an already-resolved
   * entry counts as resolved but keeps its original audit stamp. Unknown
   * ids land in not_found.
   */
  resolve(
    ids: string[],
    opts: { by?: string; note?: string },
  ): Promise<{ resolved: string[]; not_found: string[] }>;
}

/** Decision persistence (decisions/<id>.json + index.json today). */
export interface IDecisionStore {
  create(
    input: Omit<Decision, "id" | "timestamp" | "status"> & {
      // Creation-time status: only the two "live" states are creatable —
      // superseded/overridden/archived are lifecycle outcomes with back-links.
      status?: "active" | "provisional";
    },
  ): Promise<Decision>;
  get(id: string): Promise<Decision | null>;
  getByScope(scope: string): Promise<Decision[]>;
  updateStatus(
    id: string,
    status: DecisionStatus,
    extra?: Partial<Decision>,
  ): Promise<void>;
  getIndex(): Promise<DecisionIndexEntry[]>;
  linkCommit(id: string, commitHash: string): Promise<void>;
  getByCommitHash(commitHash: string): Promise<Decision[]>;
  /**
   * Persist an append-only metadata amendment (field D11). Receives DELTAS
   * and merges them against the freshly-read record INSIDE the backend's
   * critical section — an engine-computed union would be a lost-update under
   * concurrent amends (the withWriteTxn doc's exact hazard class). Must keep
   * every index the backend maintains consistent: the file backend's index
   * carries affected_files/affected_symbols that getByScope reads, so a
   * record-only write would be a half-repair retrieval cannot see.
   */
  amendMetadata(
    id: string,
    delta: {
      add_affected_files: string[];
      add_affected_symbols: string[];
      amendment: DecisionAmendment;
    },
  ): Promise<void>;
}

/** Knowledge-graph persistence (graph/entities.json + relations.json today). */
export interface IGraphStore {
  addEntity(input: {
    name: string;
    type: Entity["type"];
    properties?: Record<string, string>;
  }): Promise<Entity>;
  addRelation(input: {
    source: string;
    target: string;
    type: Relation["type"];
    properties?: Record<string, string>;
  }): Promise<Relation>;
  getEntities(): Promise<Entity[]>;
  getRelations(): Promise<Relation[]>;
  getEntityById(id: string): Promise<Entity | undefined>;
  getEntityByName(name: string, type?: string): Promise<Entity[]>;
  removeEntities(
    entityIds: Set<string>,
  ): Promise<{ removedEntities: number; removedRelations: number }>;
  /** Remove relations by id (wave-2 dedup pass). Unknown ids are ignored. */
  removeRelations(relationIds: Set<string>): Promise<{ removed: number }>;
}

/** Agent registry persistence (agents/registry.json today). */
export interface IAgentStore {
  upsert(input: {
    agent_id: string;
    capabilities?: string[];
    role?: string;
    description?: string;
  }): Promise<AgentRecord>;
  touch(agentId: string): Promise<AgentRecord>;
  get(agentId: string): Promise<AgentRecord | null>;
  getAll(): Promise<AgentRecord[]>;
  findByCapabilities(tags: string[]): Promise<AgentRecord[]>;
}

/** Handoff persistence (handoffs/<id>.json + index.jsonl today). */
export interface IHandoffStore {
  create(
    input: Omit<HandoffRecord, "id" | "created_at">,
  ): Promise<HandoffRecord>;
  get(id: string): Promise<HandoffRecord | null>;
  list(filters?: {
    source_agent?: string;
    target_agent?: string;
    scope?: string;
    since?: string;
    limit?: number;
  }): Promise<HandoffIndexEntry[]>;
  acknowledge(id: string, acknowledgedBy: string): Promise<HandoffRecord>;
}

/** Embedding-index persistence (embeddings/*.index today). */
export interface IIndexManager {
  load(indexName: IndexName): Promise<EmbeddingIndex>;
  save(indexName: IndexName, index: EmbeddingIndex): Promise<void>;
  /**
   * contentHash (sha256 of the embed text, see embed-text.ts) lets the
   * sqlite backend's reconciler skip re-embedding unchanged records after
   * ingest. The file backend has no ingest and ignores it.
   */
  addEntry(
    indexName: IndexName,
    id: string,
    vector: number[],
    contentHash?: string,
  ): Promise<void>;
  removeEntries(indexName: IndexName, ids: string[]): Promise<void>;
  getVector(indexName: IndexName, id: string): Promise<number[] | null>;
}

/** Tool-metrics read model (metrics.jsonl today). */
export interface IMetricsStore {
  getToolUsageSummary(since?: string): Promise<ToolUsageSummary[]>;
  getUsageOverTime(bucketMinutes?: number): Promise<UsageBucket[]>;
  getErrorBreakdown(): Promise<
    Array<{ tool_name: string; error_code: string; count: number }>
  >;
}
