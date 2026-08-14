/**
 * SQLite implementations of the storage backend interfaces
 * (FOUNDATION-PLAN W2.2). Behavior-parity port of the file-backed stores:
 * every method reproduces its file counterpart's semantics exactly —
 * ordering (insertion order = file order), filter logic, upsert rules,
 * error codes, and defaults — so the existing engine layer and tests hold
 * for both backends. Query-level optimizations come later; parity first.
 *
 * All writes respect the format-version read-only gate, same as the file
 * backend's write path.
 */
import { generateId } from "../../utils/ids.js";
import { mergeEntityProperties } from "../../utils/entity-properties.js";
import { normalizeTags } from "../../utils/tags.js";
import { scopeMatches } from "../../utils/scope.js";
import { mergeRelationProperties } from "../../utils/relation-properties.js";
import { TwiningError } from "../../utils/errors.js";
import { isReadOnly } from "../file-store.js";
import type {
  AgentRecord,
  BlackboardEntry,
  Decision,
  DecisionAmendment,
  DecisionIndexEntry,
  DecisionStatus,
  Entity,
  HandoffIndexEntry,
  HandoffRecord,
  Relation,
} from "../../utils/types.js";
import type {
  IAgentStore,
  IBlackboardStore,
  IDecisionStore,
  IGraphStore,
  IHandoffStore,
  IIndexManager,
} from "../interfaces.js";
import type {
  EmbeddingIndex,
  IndexName,
} from "../../embeddings/index-manager.js";
import {
  blobToVector,
  vectorToBlob,
  withWriteTxn,
  type SqliteDatabase,
} from "./db.js";

function assertWritable(): void {
  if (isReadOnly()) {
    throw new TwiningError(
      ".twining/ format is newer than this release supports — writes are refused to prevent divergence.",
      "FORMAT_VERSION_TOO_NEW",
    );
  }
}

export class SqliteBlackboardStore implements IBlackboardStore {
  constructor(private readonly db: SqliteDatabase) {}

  private rows(): BlackboardEntry[] {
    return this.db
      .prepare("SELECT data FROM blackboard ORDER BY seq")
      .all()
      .map((r) => JSON.parse(r.data as string) as BlackboardEntry);
  }

  async append(
    entry: Omit<BlackboardEntry, "id" | "timestamp">,
  ): Promise<BlackboardEntry> {
    assertWritable();
    const full: BlackboardEntry = {
      ...entry,
      id: generateId(),
      timestamp: new Date().toISOString(),
    };
    this.db
      .prepare(
        "INSERT INTO blackboard (id, entry_type, scope, timestamp, data) VALUES (?, ?, ?, ?, ?)",
      )
      .run(full.id, full.entry_type, full.scope, full.timestamp, JSON.stringify(full));
    return full;
  }

  async read(filters?: {
    entry_types?: string[];
    tags?: string[];
    scope?: string;
    since?: string;
    limit?: number;
  }): Promise<{ entries: BlackboardEntry[]; total_count: number }> {
    let entries = this.rows();

    if (filters?.entry_types && filters.entry_types.length > 0) {
      entries = entries.filter((e) =>
        filters.entry_types!.includes(e.entry_type),
      );
    }
    if (filters?.tags && filters.tags.length > 0) {
      entries = entries.filter((e) =>
        e.tags.some((t) => filters.tags!.includes(t)),
      );
    }
    if (filters?.scope) {
      const filterScope = filters.scope;
      entries = entries.filter((e) => scopeMatches(e.scope, filterScope));
    }
    if (filters?.since) {
      const sinceTime = filters.since;
      entries = entries.filter((e) => e.timestamp >= sinceTime);
    }

    const total_count = entries.length;
    if (filters?.limit !== undefined && filters.limit > 0) {
      entries = entries.slice(-filters.limit);
    }
    return { entries, total_count };
  }

  async recent(n?: number, entry_types?: string[]): Promise<BlackboardEntry[]> {
    let entries = this.rows();
    if (entry_types && entry_types.length > 0) {
      entries = entries.filter((e) => entry_types.includes(e.entry_type));
    }
    const count = n ?? 20;
    return entries.slice(-count).reverse();
  }

  async dismiss(
    ids: string[],
  ): Promise<{ dismissed: string[]; not_found: string[] }> {
    assertWritable();
    const dismissed: string[] = [];
    const stmt = this.db.prepare("DELETE FROM blackboard WHERE id = ?");
    for (const id of ids) {
      const { changes } = stmt.run(id);
      if (Number(changes) > 0) dismissed.push(id);
    }
    const not_found = ids.filter((id) => !dismissed.includes(id));
    return { dismissed, not_found };
  }

  async resolve(
    ids: string[],
    opts: { by?: string; note?: string },
  ): Promise<{ resolved: string[]; not_found: string[] }> {
    assertWritable();
    const resolved: string[] = [];
    const select = this.db.prepare("SELECT data FROM blackboard WHERE id = ?");
    const update = this.db.prepare("UPDATE blackboard SET data = ? WHERE id = ?");
    for (const id of ids) {
      const row = select.get(id);
      if (!row) continue;
      const entry = JSON.parse(row.data as string) as BlackboardEntry;
      resolved.push(id);
      if (entry.status === "resolved") continue; // first resolve wins
      entry.status = "resolved";
      entry.resolved_at = new Date().toISOString();
      if (opts.by) entry.resolved_by = opts.by;
      if (opts.note) entry.resolution_note = opts.note;
      update.run(JSON.stringify(entry), id);
    }
    const not_found = ids.filter((id) => !resolved.includes(id));
    return { resolved, not_found };
  }
}

export class SqliteDecisionStore implements IDecisionStore {
  constructor(private readonly db: SqliteDatabase) {}

  private load(id: string): Decision | null {
    const row = this.db
      .prepare("SELECT data FROM decisions WHERE id = ?")
      .get(id);
    return row ? (JSON.parse(row.data as string) as Decision) : null;
  }

  private save(decision: Decision): void {
    this.db
      .prepare(
        "UPDATE decisions SET status = ?, timestamp = ?, data = ? WHERE id = ?",
      )
      .run(decision.status, decision.timestamp, JSON.stringify(decision), decision.id);
  }

  async create(
    input: Omit<Decision, "id" | "timestamp" | "status"> & {
      status?: "active" | "provisional";
    },
  ): Promise<Decision> {
    assertWritable();
    const decision: Decision = {
      ...input,
      commit_hashes: input.commit_hashes ?? [],
      id: generateId(),
      timestamp: new Date().toISOString(),
      status: input.status ?? "active",
    };
    this.db
      .prepare(
        "INSERT INTO decisions (id, status, timestamp, data) VALUES (?, ?, ?, ?)",
      )
      .run(decision.id, decision.status, decision.timestamp, JSON.stringify(decision));
    return decision;
  }

  async get(id: string): Promise<Decision | null> {
    return this.load(id);
  }

  async getByScope(scope: string): Promise<Decision[]> {
    const index = await this.getIndex();
    const matching = index.filter(
      (entry) =>
        scopeMatches(entry.scope, scope) ||
        entry.affected_files.some((f) => scopeMatches(f, scope)) ||
        entry.affected_symbols.some((s) => s === scope),
    );
    const decisions: Decision[] = [];
    for (const entry of matching) {
      const decision = this.load(entry.id);
      if (decision) decisions.push(decision);
    }
    decisions.sort(
      (a, b) =>
        b.timestamp.localeCompare(a.timestamp) || b.id.localeCompare(a.id),
    );
    return decisions;
  }

  async updateStatus(
    id: string,
    status: DecisionStatus,
    extra?: Partial<Decision>,
  ): Promise<void> {
    assertWritable();
    withWriteTxn(this.db, () => {
      const decision = this.load(id);
      if (!decision) return; // file backend: silently no-op when file missing
      decision.status = status;
      if (extra) Object.assign(decision, extra);
      this.save(decision);
    });
  }

  /**
   * Append-only metadata amendment (field D11). The sqlite index is a
   * read-time projection over the record, so rewriting the record keeps
   * every read model consistent. Deltas merge against the in-transaction
   * read: concurrent amends both survive.
   */
  async amendMetadata(
    id: string,
    delta: {
      add_affected_files: string[];
      add_affected_symbols: string[];
      amendment: DecisionAmendment;
    },
  ): Promise<void> {
    assertWritable();
    withWriteTxn(this.db, () => {
      const decision = this.load(id);
      if (!decision) return;
      decision.affected_files = [
        ...decision.affected_files,
        ...delta.add_affected_files.filter(
          (f) => !decision.affected_files.includes(f),
        ),
      ];
      decision.affected_symbols = [
        ...decision.affected_symbols,
        ...delta.add_affected_symbols.filter(
          (s) => !decision.affected_symbols.includes(s),
        ),
      ];
      decision.amendments = [...(decision.amendments ?? []), delta.amendment];
      this.save(decision);
    });
  }

  async getIndex(): Promise<DecisionIndexEntry[]> {
    return this.db
      .prepare("SELECT data FROM decisions ORDER BY seq")
      .all()
      .map((r) => {
        const d = JSON.parse(r.data as string) as Decision;
        return {
          id: d.id,
          timestamp: d.timestamp,
          domain: d.domain,
          scope: d.scope,
          summary: d.summary,
          confidence: d.confidence,
          status: d.status,
          affected_files: d.affected_files,
          affected_symbols: d.affected_symbols,
          commit_hashes: d.commit_hashes ?? [],
        };
      });
  }

  async linkCommit(id: string, commitHash: string): Promise<void> {
    assertWritable();
    withWriteTxn(this.db, () => {
      const decision = this.load(id);
      if (!decision) {
        throw new Error(`Decision not found: ${id}`);
      }
      if (!decision.commit_hashes) decision.commit_hashes = [];
      if (!decision.commit_hashes.includes(commitHash)) {
        decision.commit_hashes.push(commitHash);
      }
      this.save(decision);
    });
  }

  async getByCommitHash(commitHash: string): Promise<Decision[]> {
    const index = await this.getIndex();
    const matching = index.filter(
      (e) => e.commit_hashes && e.commit_hashes.includes(commitHash),
    );
    const decisions: Decision[] = [];
    for (const entry of matching) {
      const decision = this.load(entry.id);
      if (decision) decisions.push(decision);
    }
    decisions.sort(
      (a, b) =>
        b.timestamp.localeCompare(a.timestamp) || b.id.localeCompare(a.id),
    );
    return decisions;
  }
}

export class SqliteGraphStore implements IGraphStore {
  constructor(private readonly db: SqliteDatabase) {}

  private allEntities(): Entity[] {
    return this.db
      .prepare("SELECT data FROM entities ORDER BY rowid")
      .all()
      .map((r) => JSON.parse(r.data as string) as Entity);
  }

  async addEntity(input: {
    name: string;
    type: Entity["type"];
    properties?: Record<string, string>;
  }): Promise<Entity> {
    assertWritable();
    const now = new Date().toISOString();
    return withWriteTxn(this.db, () => {
      const existingRow = this.db
        .prepare("SELECT data FROM entities WHERE name = ? AND type = ?")
        .get(input.name, input.type);

      if (existingRow) {
        const existing = JSON.parse(existingRow.data as string) as Entity;
        // `scope` unions rather than overwriting — see utils/entity-properties.ts.
        existing.properties = mergeEntityProperties(
          existing.properties,
          input.properties,
        );
        existing.updated_at = now;
        this.db
          .prepare("UPDATE entities SET data = ? WHERE id = ?")
          .run(JSON.stringify(existing), existing.id);
        return existing;
      }

      const entity: Entity = {
        id: generateId(),
        name: input.name,
        type: input.type,
        properties: input.properties ?? {},
        created_at: now,
        updated_at: now,
      };
      this.db
        .prepare("INSERT INTO entities (id, name, type, data) VALUES (?, ?, ?, ?)")
        .run(entity.id, entity.name, entity.type, JSON.stringify(entity));
      return entity;
    });
  }

  async addRelation(input: {
    source: string;
    target: string;
    type: Relation["type"];
    properties?: Record<string, string>;
  }): Promise<Relation> {
    assertWritable();
    const entities = this.allEntities();

    const resolveEntity = (ref: string): Entity => {
      const byId = entities.find((e) => e.id === ref);
      if (byId) return byId;
      const byName = entities.filter((e) => e.name === ref);
      if (byName.length === 0) {
        throw new TwiningError(`Entity not found: "${ref}"`, "NOT_FOUND");
      }
      if (byName.length > 1) {
        const matches = byName.map((e) => `${e.name} (${e.type})`).join(", ");
        throw new TwiningError(
          `Ambiguous entity name "${ref}" matches: ${matches}`,
          "AMBIGUOUS_ENTITY",
        );
      }
      return byName[0]!;
    };

    const sourceEntity = resolveEntity(input.source);
    const targetEntity = resolveEntity(input.target);

    // Upsert by (source, target, type), mirroring addEntity's name+type
    // upsert (wave C). The find+write pair runs inside a write transaction —
    // WAL serializes statements, not statement PAIRS, so an unwrapped
    // check-then-act lets two processes both miss and both insert,
    // recreating the duplicate-edge defect this upsert exists to fix.
    return withWriteTxn(this.db, () => {
    const existing = this.getRelationsSync().find(
      (r) =>
        r.source === sourceEntity.id &&
        r.target === targetEntity.id &&
        r.type === input.type,
    );
    if (existing) {
      const merged: Relation = {
        ...existing,
        properties: mergeRelationProperties(existing.properties, input.properties),
      };
      this.db
        .prepare("UPDATE relations SET data = ? WHERE id = ?")
        .run(JSON.stringify(merged), merged.id);
      return merged;
    }

    const relation: Relation = {
      id: generateId(),
      source: sourceEntity.id,
      target: targetEntity.id,
      type: input.type,
      properties: input.properties ?? {},
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        "INSERT INTO relations (id, source, target, data) VALUES (?, ?, ?, ?)",
      )
      .run(relation.id, relation.source, relation.target, JSON.stringify(relation));
    return relation;
    });
  }

  private getRelationsSync(): Relation[] {
    return this.db
      .prepare("SELECT data FROM relations ORDER BY seq")
      .all()
      .map((r) => JSON.parse(r.data as string) as Relation);
  }

  async getEntities(): Promise<Entity[]> {
    return this.allEntities();
  }

  async getRelations(): Promise<Relation[]> {
    return this.db
      .prepare("SELECT data FROM relations ORDER BY seq")
      .all()
      .map((r) => JSON.parse(r.data as string) as Relation);
  }

  async getEntityById(id: string): Promise<Entity | undefined> {
    const row = this.db
      .prepare("SELECT data FROM entities WHERE id = ?")
      .get(id);
    return row ? (JSON.parse(row.data as string) as Entity) : undefined;
  }

  async getEntityByName(name: string, type?: string): Promise<Entity[]> {
    return this.allEntities().filter(
      (e) => e.name === name && (type === undefined || e.type === type),
    );
  }

  async removeEntities(
    entityIds: Set<string>,
  ): Promise<{ removedEntities: number; removedRelations: number }> {
    assertWritable();
    let removedEntities = 0;
    let removedRelations = 0;
    const delEntity = this.db.prepare("DELETE FROM entities WHERE id = ?");
    const delRelations = this.db.prepare(
      "DELETE FROM relations WHERE source = ? OR target = ?",
    );
    for (const id of entityIds) {
      removedEntities += Number(delEntity.run(id).changes);
      removedRelations += Number(delRelations.run(id, id).changes);
    }
    return { removedEntities, removedRelations };
  }
}

export class SqliteAgentStore implements IAgentStore {
  constructor(private readonly db: SqliteDatabase) {}

  private load(agentId: string): AgentRecord | null {
    const row = this.db
      .prepare("SELECT data FROM agents WHERE agent_id = ?")
      .get(agentId);
    return row ? (JSON.parse(row.data as string) as AgentRecord) : null;
  }

  private save(agent: AgentRecord, isNew: boolean): void {
    if (isNew) {
      this.db
        .prepare("INSERT INTO agents (agent_id, data) VALUES (?, ?)")
        .run(agent.agent_id, JSON.stringify(agent));
    } else {
      this.db
        .prepare("UPDATE agents SET data = ? WHERE agent_id = ?")
        .run(JSON.stringify(agent), agent.agent_id);
    }
  }

  async upsert(input: {
    agent_id: string;
    capabilities?: string[];
    role?: string;
    description?: string;
  }): Promise<AgentRecord> {
    assertWritable();
    const now = new Date().toISOString();
    const normalizedCaps = normalizeTags(input.capabilities ?? []);
    return withWriteTxn(this.db, () => {
    const existing = this.load(input.agent_id);

    if (existing) {
      existing.capabilities = normalizeTags([
        ...existing.capabilities,
        ...normalizedCaps,
      ]);
      if (input.role !== undefined) existing.role = input.role;
      if (input.description !== undefined) {
        existing.description = input.description;
      }
      existing.last_active = now;
      this.save(existing, false);
      return existing;
    }

    const agent: AgentRecord = {
      agent_id: input.agent_id,
      capabilities: normalizedCaps,
      role: input.role,
      description: input.description,
      registered_at: now,
      last_active: now,
    };
    this.save(agent, true);
    return agent;
    });
  }

  async touch(agentId: string): Promise<AgentRecord> {
    assertWritable();
    const now = new Date().toISOString();
    return withWriteTxn(this.db, () => {
      const existing = this.load(agentId);
      if (existing) {
        existing.last_active = now;
        this.save(existing, false);
        return existing;
      }
      const agent: AgentRecord = {
        agent_id: agentId,
        capabilities: [],
        registered_at: now,
        last_active: now,
      };
      this.save(agent, true);
      return agent;
    });
  }

  async get(agentId: string): Promise<AgentRecord | null> {
    return this.load(agentId);
  }

  async getAll(): Promise<AgentRecord[]> {
    return this.db
      .prepare("SELECT data FROM agents ORDER BY rowid")
      .all()
      .map((r) => JSON.parse(r.data as string) as AgentRecord);
  }

  async findByCapabilities(tags: string[]): Promise<AgentRecord[]> {
    const normalizedInput = normalizeTags(tags);
    if (normalizedInput.length === 0) return [];
    return (await this.getAll()).filter((agent) =>
      agent.capabilities.some((cap) => normalizedInput.includes(cap)),
    );
  }
}

export class SqliteHandoffStore implements IHandoffStore {
  constructor(private readonly db: SqliteDatabase) {}

  async create(
    input: Omit<HandoffRecord, "id" | "created_at">,
  ): Promise<HandoffRecord> {
    assertWritable();
    const record: HandoffRecord = {
      ...input,
      id: generateId(),
      created_at: new Date().toISOString(),
    };
    const indexEntry = this.toIndexEntry(record);
    this.db
      .prepare(
        "INSERT INTO handoffs (id, created_at, data, index_data) VALUES (?, ?, ?, ?)",
      )
      .run(record.id, record.created_at, JSON.stringify(record), JSON.stringify(indexEntry));
    return record;
  }

  async get(id: string): Promise<HandoffRecord | null> {
    const row = this.db
      .prepare("SELECT data FROM handoffs WHERE id = ?")
      .get(id);
    return row ? (JSON.parse(row.data as string) as HandoffRecord) : null;
  }

  async list(filters?: {
    source_agent?: string;
    target_agent?: string;
    scope?: string;
    since?: string;
    limit?: number;
  }): Promise<HandoffIndexEntry[]> {
    let entries = this.db
      .prepare("SELECT index_data FROM handoffs ORDER BY seq")
      .all()
      .map((r) => JSON.parse(r.index_data as string) as HandoffIndexEntry);

    if (filters) {
      if (filters.source_agent) {
        entries = entries.filter((e) => e.source_agent === filters.source_agent);
      }
      if (filters.target_agent) {
        entries = entries.filter((e) => e.target_agent === filters.target_agent);
      }
      if (filters.scope) {
        const filterScope = filters.scope;
        // Legacy scopeless records read as "project", never as match-everything
        // (field D12) — mirrors handoff-store.ts; "" matches every scope via
        // bidirectional startsWith.
        entries = entries.filter((e) => scopeMatches(e.scope ?? "project", filterScope));
      }
      if (filters.since) {
        const since = filters.since;
        entries = entries.filter((e) => e.created_at >= since);
      }
    }

    entries.sort(
      (a, b) =>
        b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id),
    );
    if (filters?.limit !== undefined) {
      entries = entries.slice(0, filters.limit);
    }
    return entries;
  }

  async acknowledge(id: string, acknowledgedBy: string): Promise<HandoffRecord> {
    assertWritable();
    return withWriteTxn(this.db, () => {
      const row = this.db
        .prepare("SELECT data, index_data FROM handoffs WHERE id = ?")
        .get(id);
      if (!row) {
        throw new Error(`Handoff not found: ${id}`);
      }
      const record = JSON.parse(row.data as string) as HandoffRecord;
      record.acknowledged_by = acknowledgedBy;
      record.acknowledged_at = new Date().toISOString();
      const indexEntry = JSON.parse(row.index_data as string) as HandoffIndexEntry;
      indexEntry.acknowledged = true;
      this.db
        .prepare("UPDATE handoffs SET data = ?, index_data = ? WHERE id = ?")
        .run(JSON.stringify(record), JSON.stringify(indexEntry), id);
      return record;
    });
  }

  private toIndexEntry(record: HandoffRecord): HandoffIndexEntry {
    return {
      id: record.id,
      created_at: record.created_at,
      source_agent: record.source_agent,
      target_agent: record.target_agent,
      scope: record.scope,
      summary: record.summary,
      result_status: this.computeResultStatus(record.results),
      acknowledged: false,
    };
  }

  private computeResultStatus(
    results: HandoffRecord["results"],
  ): HandoffIndexEntry["result_status"] {
    if (results.length === 0) return "completed";
    const statuses = new Set(results.map((r) => r.status));
    if (statuses.size === 1) return results[0]!.status;
    return "mixed";
  }
}

const DEFAULT_EMBEDDING_MODEL = "all-MiniLM-L6-v2";
const DEFAULT_EMBEDDING_DIMENSION = 384;

export class SqliteIndexManager implements IIndexManager {
  constructor(private readonly db: SqliteDatabase) {}

  async load(indexName: IndexName): Promise<EmbeddingIndex> {
    const entries = this.db
      .prepare(
        "SELECT id, vector FROM embeddings WHERE index_name = ? ORDER BY rowid",
      )
      .all(indexName)
      .map((r) => ({
        id: r.id as string,
        vector: blobToVector(r.vector as Uint8Array),
      }));
    return {
      model: DEFAULT_EMBEDDING_MODEL,
      dimension: DEFAULT_EMBEDDING_DIMENSION,
      entries,
    };
  }

  async save(indexName: IndexName, index: EmbeddingIndex): Promise<void> {
    assertWritable();
    this.db
      .prepare("DELETE FROM embeddings WHERE index_name = ?")
      .run(indexName);
    const stmt = this.db.prepare(
      "INSERT INTO embeddings (index_name, id, vector) VALUES (?, ?, ?)",
    );
    for (const entry of index.entries) {
      stmt.run(indexName, entry.id, vectorToBlob(entry.vector));
    }
  }

  async addEntry(
    indexName: IndexName,
    id: string,
    vector: number[],
    contentHash?: string,
  ): Promise<void> {
    assertWritable();
    this.db
      .prepare(
        "INSERT INTO embeddings (index_name, id, vector, content_hash) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(index_name, id) DO UPDATE SET vector = excluded.vector, content_hash = excluded.content_hash",
      )
      .run(indexName, id, vectorToBlob(vector), contentHash ?? null);
  }

  async removeEntries(indexName: IndexName, ids: string[]): Promise<void> {
    assertWritable();
    const stmt = this.db.prepare(
      "DELETE FROM embeddings WHERE index_name = ? AND id = ?",
    );
    for (const id of ids) {
      stmt.run(indexName, id);
    }
  }

  async getVector(indexName: IndexName, id: string): Promise<number[] | null> {
    const row = this.db
      .prepare("SELECT vector FROM embeddings WHERE index_name = ? AND id = ?")
      .get(indexName, id);
    return row ? blobToVector(row.vector as Uint8Array) : null;
  }
}
