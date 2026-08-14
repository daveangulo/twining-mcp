/**
 * Record export tree (FOUNDATION-PLAN W2.3, design D1/D2).
 *
 * The sqlite backend's twining.db is a derived, gitignored local cache — on
 * its own it cannot ride git between users, branches, or worktrees. This
 * module maintains the committable truth alongside it: one JSON file per
 * record under .twining/records/, written synchronously after every
 * successful store write with deterministic serialization (recursively
 * sorted keys), so identical records produce identical bytes on every
 * machine and git merges of two branches' exports are set-union by
 * filename (ULID) with no content churn.
 *
 * Layout:
 *   records/posts/<yyyy-mm>/<ulid>.json   — blackboard entries, month-sharded
 *   records/decisions/<ulid>.json
 *   records/graph/entities/<ulid>.json
 *   records/graph/relations/<ulid>.json
 *   records/handoffs/<ulid>.json
 *
 * Mutations rewrite the same file (decision status, entity merge, handoff
 * acknowledge); removals (dismiss, removeEntities) unlink it. Agents and
 * embeddings are deliberately NOT exported: agent liveness timestamps churn
 * on every call (pure git noise), and embeddings are a rebuildable local
 * index.
 */
import fs from "node:fs";
import path from "node:path";
import { atomicWriteFileSync, ensureDir } from "../file-store.js";
import type { StoreSet } from "../backend-factory.js";
import type {
  IBlackboardStore,
  IDecisionStore,
  IGraphStore,
  IHandoffStore,
} from "../interfaces.js";
import type {
  BlackboardEntry,
  Decision,
  Entity,
  HandoffRecord,
  Relation,
} from "../../utils/types.js";

/** JSON.stringify with recursively sorted object keys — deterministic bytes. */
export function stableStringify(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(v as Record<string, unknown>).sort()) {
        out[key] = sort((v as Record<string, unknown>)[key]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(value), null, 2) + "\n";
}

export class RecordExporter {
  private readonly recordsDir: string;

  constructor(twiningDir: string) {
    this.recordsDir = path.join(twiningDir, "records");
  }

  postPath(entry: Pick<BlackboardEntry, "id" | "timestamp">): string {
    return path.join(
      this.recordsDir,
      "posts",
      entry.timestamp.slice(0, 7), // yyyy-mm
      `${entry.id}.json`,
    );
  }

  private write(filePath: string, record: unknown): void {
    ensureDir(path.dirname(filePath));
    atomicWriteFileSync(filePath, stableStringify(record));
  }

  private unlink(filePath: string): void {
    fs.rmSync(filePath, { force: true });
  }

  post(entry: BlackboardEntry): void {
    this.write(this.postPath(entry), entry);
  }

  removePost(entry: Pick<BlackboardEntry, "id" | "timestamp">): void {
    this.unlink(this.postPath(entry));
  }

  decision(decision: Decision): void {
    this.write(
      path.join(this.recordsDir, "decisions", `${decision.id}.json`),
      decision,
    );
  }

  entity(entity: Entity): void {
    this.write(
      path.join(this.recordsDir, "graph", "entities", `${entity.id}.json`),
      entity,
    );
  }

  removeEntity(id: string): void {
    this.unlink(path.join(this.recordsDir, "graph", "entities", `${id}.json`));
  }

  relation(relation: Relation): void {
    this.write(
      path.join(this.recordsDir, "graph", "relations", `${relation.id}.json`),
      relation,
    );
  }

  removeRelation(id: string): void {
    this.unlink(path.join(this.recordsDir, "graph", "relations", `${id}.json`));
  }

  handoff(record: HandoffRecord): void {
    this.write(
      path.join(this.recordsDir, "handoffs", `${record.id}.json`),
      record,
    );
  }
}

/**
 * Wrap a store set so every successful write is mirrored into the export
 * tree. Reads delegate untouched. Export failures are deliberately loud
 * (they throw): a silently stale export tree would commit wrong state.
 */
export function withRecordExport(
  stores: StoreSet,
  twiningDir: string,
): StoreSet {
  const exporter = new RecordExporter(twiningDir);
  return {
    ...stores,
    blackboardStore: new ExportingBlackboardStore(
      stores.blackboardStore,
      exporter,
    ),
    decisionStore: new ExportingDecisionStore(stores.decisionStore, exporter),
    graphStore: new ExportingGraphStore(stores.graphStore, exporter),
    handoffStore: new ExportingHandoffStore(stores.handoffStore, exporter),
  };
}

class ExportingBlackboardStore implements IBlackboardStore {
  constructor(
    private readonly inner: IBlackboardStore,
    private readonly exporter: RecordExporter,
  ) {}

  async append(
    entry: Omit<BlackboardEntry, "id" | "timestamp">,
  ): Promise<BlackboardEntry> {
    const full = await this.inner.append(entry);
    this.exporter.post(full);
    return full;
  }

  read: IBlackboardStore["read"] = (filters) => this.inner.read(filters);
  recent: IBlackboardStore["recent"] = (n, t) => this.inner.recent(n, t);

  async resolve(
    ids: string[],
    opts: { by?: string; note?: string },
  ): Promise<{ resolved: string[]; not_found: string[] }> {
    const result = await this.inner.resolve(ids, opts);
    if (result.resolved.length > 0) {
      // Re-export the mutated records — same-file rewrite, mirroring how
      // decision updateStatus re-exports.
      const resolvedSet = new Set(result.resolved);
      const { entries } = await this.inner.read();
      for (const entry of entries) {
        if (resolvedSet.has(entry.id)) this.exporter.post(entry);
      }
    }
    return result;
  }

  async dismiss(
    ids: string[],
  ): Promise<{ dismissed: string[]; not_found: string[] }> {
    // Resolve timestamps (for month shards) before the rows disappear.
    const { entries } = await this.inner.read();
    const byId = new Map(entries.map((e) => [e.id, e]));
    const result = await this.inner.dismiss(ids);
    for (const id of result.dismissed) {
      const entry = byId.get(id);
      if (entry) this.exporter.removePost(entry);
    }
    return result;
  }
}

class ExportingDecisionStore implements IDecisionStore {
  constructor(
    private readonly inner: IDecisionStore,
    private readonly exporter: RecordExporter,
  ) {}

  async create(
    input: Omit<Decision, "id" | "timestamp" | "status">,
  ): Promise<Decision> {
    const decision = await this.inner.create(input);
    this.exporter.decision(decision);
    return decision;
  }

  get: IDecisionStore["get"] = (id) => this.inner.get(id);
  getByScope: IDecisionStore["getByScope"] = (s) => this.inner.getByScope(s);
  getIndex: IDecisionStore["getIndex"] = () => this.inner.getIndex();
  getByCommitHash: IDecisionStore["getByCommitHash"] = (h) =>
    this.inner.getByCommitHash(h);

  async updateStatus(
    id: string,
    status: Parameters<IDecisionStore["updateStatus"]>[1],
    extra?: Parameters<IDecisionStore["updateStatus"]>[2],
  ): Promise<void> {
    await this.inner.updateStatus(id, status, extra);
    const updated = await this.inner.get(id);
    if (updated) this.exporter.decision(updated);
  }

  async linkCommit(id: string, commitHash: string): Promise<void> {
    await this.inner.linkCommit(id, commitHash);
    const updated = await this.inner.get(id);
    if (updated) this.exporter.decision(updated);
  }

  // Mirror invariant (field D11): without this delegation the amendment
  // would live only in the db and the next file-wins ingest would REVERT it.
  async amendMetadata(
    id: string,
    fields: Parameters<IDecisionStore["amendMetadata"]>[1],
  ): Promise<void> {
    await this.inner.amendMetadata(id, fields);
    const updated = await this.inner.get(id);
    if (updated) this.exporter.decision(updated);
  }
}

class ExportingGraphStore implements IGraphStore {
  constructor(
    private readonly inner: IGraphStore,
    private readonly exporter: RecordExporter,
  ) {}

  async addEntity(
    input: Parameters<IGraphStore["addEntity"]>[0],
  ): Promise<Entity> {
    const entity = await this.inner.addEntity(input);
    this.exporter.entity(entity);
    return entity;
  }

  async addRelation(
    input: Parameters<IGraphStore["addRelation"]>[0],
  ): Promise<Relation> {
    const relation = await this.inner.addRelation(input);
    this.exporter.relation(relation);
    return relation;
  }

  getEntities: IGraphStore["getEntities"] = () => this.inner.getEntities();
  getRelations: IGraphStore["getRelations"] = () => this.inner.getRelations();
  getEntityById: IGraphStore["getEntityById"] = (id) =>
    this.inner.getEntityById(id);
  getEntityByName: IGraphStore["getEntityByName"] = (n, t) =>
    this.inner.getEntityByName(n, t);

  async removeEntities(
    entityIds: Set<string>,
  ): Promise<{ removedEntities: number; removedRelations: number }> {
    // Capture cascading relation ids before the delete removes them.
    const doomedRelations = (await this.inner.getRelations()).filter(
      (r) => entityIds.has(r.source) || entityIds.has(r.target),
    );
    const result = await this.inner.removeEntities(entityIds);
    for (const id of entityIds) this.exporter.removeEntity(id);
    for (const r of doomedRelations) this.exporter.removeRelation(r.id);
    return result;
  }

  // Mirror invariant: a dedup that removed relations only in the db would be
  // resurrected by the next file-wins ingest.
  async removeRelations(relationIds: Set<string>): Promise<{ removed: number }> {
    const result = await this.inner.removeRelations(relationIds);
    for (const id of relationIds) this.exporter.removeRelation(id);
    return result;
  }
}

class ExportingHandoffStore implements IHandoffStore {
  constructor(
    private readonly inner: IHandoffStore,
    private readonly exporter: RecordExporter,
  ) {}

  async create(
    input: Omit<HandoffRecord, "id" | "created_at">,
  ): Promise<HandoffRecord> {
    const record = await this.inner.create(input);
    this.exporter.handoff(record);
    return record;
  }

  get: IHandoffStore["get"] = (id) => this.inner.get(id);
  list: IHandoffStore["list"] = (f) => this.inner.list(f);

  async acknowledge(id: string, acknowledgedBy: string): Promise<HandoffRecord> {
    const record = await this.inner.acknowledge(id, acknowledgedBy);
    this.exporter.handoff(record);
    return record;
  }
}
