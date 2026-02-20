/**
 * Decision CRUD operations.
 * Individual JSON files per decision with a fast-lookup index.
 */
import fs from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";
import { readJSON, writeJSON } from "./file-store.js";
import { generateId } from "../utils/ids.js";
import type {
  Decision,
  DecisionIndexEntry,
  DecisionStatus,
} from "../utils/types.js";

const INDEX_LOCK_OPTIONS: lockfile.LockOptions = {
  retries: { retries: 10, factor: 1.5, minTimeout: 50, maxTimeout: 1000 },
  stale: 10000,
};

export class DecisionStore {
  private readonly decisionsDir: string;
  private readonly indexPath: string;
  private cachedIndex: DecisionIndexEntry[] | null = null;
  private cachedIndexMtime: number = 0;

  constructor(twiningDir: string) {
    this.decisionsDir = path.join(twiningDir, "decisions");
    this.indexPath = path.join(this.decisionsDir, "index.json");
  }

  /** Create a new decision. Writes individual file and updates index atomically. */
  async create(
    input: Omit<Decision, "id" | "timestamp" | "status">,
  ): Promise<Decision> {
    const decision: Decision = {
      ...input,
      commit_hashes: input.commit_hashes ?? [],
      id: generateId(),
      timestamp: new Date().toISOString(),
      status: "active",
    };

    const filePath = path.join(this.decisionsDir, `${decision.id}.json`);

    // Lock index for atomic read-modify-write
    const release = await lockfile.lock(this.indexPath, INDEX_LOCK_OPTIONS);
    try {
      // Write individual decision file
      fs.writeFileSync(filePath, JSON.stringify(decision, null, 2));

      // Update index
      const index = JSON.parse(
        fs.readFileSync(this.indexPath, "utf-8"),
      ) as DecisionIndexEntry[];
      index.push(this.toIndexEntry(decision));
      fs.writeFileSync(this.indexPath, JSON.stringify(index, null, 2));
    } finally {
      await release();
    }

    this.cachedIndex = null; // Invalidate index cache
    return decision;
  }

  /** Get a single decision by ID. Returns null if not found. */
  async get(id: string): Promise<Decision | null> {
    const filePath = path.join(this.decisionsDir, `${id}.json`);
    if (!fs.existsSync(filePath)) return null;
    return readJSON<Decision>(filePath);
  }

  /** Get all decisions matching a scope (prefix match or affected files/symbols match). */
  async getByScope(scope: string): Promise<Decision[]> {
    const index = await this.getIndex();

    const matching = index.filter(
      (entry) =>
        entry.scope.startsWith(scope) ||
        scope.startsWith(entry.scope) ||
        entry.affected_files.some(
          (f) => f.startsWith(scope) || scope.startsWith(f),
        ) ||
        entry.affected_symbols.some((s) => s === scope),
    );

    // Load full decision files for matches
    const decisions: Decision[] = [];
    for (const entry of matching) {
      const decision = await this.get(entry.id);
      if (decision) decisions.push(decision);
    }

    // Sort by timestamp descending, then by ID descending (ULID is monotonic)
    decisions.sort(
      (a, b) =>
        b.timestamp.localeCompare(a.timestamp) ||
        b.id.localeCompare(a.id),
    );

    return decisions;
  }

  /** Update a decision's status (and optionally other fields). */
  async updateStatus(
    id: string,
    status: DecisionStatus,
    extra?: Partial<Decision>,
  ): Promise<void> {
    const filePath = path.join(this.decisionsDir, `${id}.json`);
    if (!fs.existsSync(filePath)) return;

    // Lock and update individual file
    const fileRelease = await lockfile.lock(filePath, INDEX_LOCK_OPTIONS);
    try {
      const decision = JSON.parse(
        fs.readFileSync(filePath, "utf-8"),
      ) as Decision;
      decision.status = status;
      if (extra) {
        Object.assign(decision, extra);
      }
      fs.writeFileSync(filePath, JSON.stringify(decision, null, 2));
    } finally {
      await fileRelease();
    }

    // Update index
    const release = await lockfile.lock(this.indexPath, INDEX_LOCK_OPTIONS);
    try {
      const index = JSON.parse(
        fs.readFileSync(this.indexPath, "utf-8"),
      ) as DecisionIndexEntry[];
      const indexEntry = index.find((e) => e.id === id);
      if (indexEntry) {
        indexEntry.status = status;
      }
      fs.writeFileSync(this.indexPath, JSON.stringify(index, null, 2));
    } finally {
      await release();
    }
    this.cachedIndex = null; // Invalidate index cache
  }

  /** Get the full decision index, with mtime-based caching. */
  async getIndex(): Promise<DecisionIndexEntry[]> {
    try {
      if (fs.existsSync(this.indexPath)) {
        const stat = fs.statSync(this.indexPath);
        if (this.cachedIndex !== null && stat.mtimeMs === this.cachedIndexMtime) {
          return this.cachedIndex;
        }
        const index = await readJSON<DecisionIndexEntry[]>(this.indexPath);
        this.cachedIndex = index;
        this.cachedIndexMtime = stat.mtimeMs;
        return index;
      }
    } catch {
      // Fall through to uncached read
      this.cachedIndex = null;
      this.cachedIndexMtime = 0;
    }
    return readJSON<DecisionIndexEntry[]>(this.indexPath);
  }

  /** Link a commit hash to an existing decision. Updates both file and index. */
  async linkCommit(id: string, commitHash: string): Promise<void> {
    const filePath = path.join(this.decisionsDir, `${id}.json`);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Decision not found: ${id}`);
    }

    // Lock and update individual decision file
    const fileRelease = await lockfile.lock(filePath, INDEX_LOCK_OPTIONS);
    try {
      const decision = JSON.parse(
        fs.readFileSync(filePath, "utf-8"),
      ) as Decision;
      if (!decision.commit_hashes) {
        decision.commit_hashes = [];
      }
      if (!decision.commit_hashes.includes(commitHash)) {
        decision.commit_hashes.push(commitHash);
      }
      fs.writeFileSync(filePath, JSON.stringify(decision, null, 2));
    } finally {
      await fileRelease();
    }

    // Update index
    const release = await lockfile.lock(this.indexPath, INDEX_LOCK_OPTIONS);
    try {
      const index = JSON.parse(
        fs.readFileSync(this.indexPath, "utf-8"),
      ) as DecisionIndexEntry[];
      const indexEntry = index.find((e) => e.id === id);
      if (indexEntry) {
        if (!indexEntry.commit_hashes) {
          indexEntry.commit_hashes = [];
        }
        if (!indexEntry.commit_hashes.includes(commitHash)) {
          indexEntry.commit_hashes.push(commitHash);
        }
      }
      fs.writeFileSync(this.indexPath, JSON.stringify(index, null, 2));
    } finally {
      await release();
    }
    this.cachedIndex = null; // Invalidate index cache
  }

  /** Get decisions linked to a specific commit hash. */
  async getByCommitHash(commitHash: string): Promise<Decision[]> {
    const index = await this.getIndex();
    const matching = index.filter(
      (entry) => entry.commit_hashes && entry.commit_hashes.includes(commitHash),
    );

    const decisions: Decision[] = [];
    for (const entry of matching) {
      const decision = await this.get(entry.id);
      if (decision) decisions.push(decision);
    }

    // Sort by timestamp descending
    decisions.sort(
      (a, b) =>
        b.timestamp.localeCompare(a.timestamp) ||
        b.id.localeCompare(a.id),
    );

    return decisions;
  }

  /** Extract index entry from a full decision. */
  private toIndexEntry(decision: Decision): DecisionIndexEntry {
    return {
      id: decision.id,
      timestamp: decision.timestamp,
      domain: decision.domain,
      scope: decision.scope,
      summary: decision.summary,
      confidence: decision.confidence,
      status: decision.status,
      affected_files: decision.affected_files,
      affected_symbols: decision.affected_symbols,
      commit_hashes: decision.commit_hashes ?? [],
    };
  }
}
