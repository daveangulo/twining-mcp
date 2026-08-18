/**
 * Decision CRUD operations.
 * Individual JSON files per decision with a fast-lookup index.
 */
import fs from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";
import { LOCK_OPTIONS, atomicWriteFileSync, ensureFileExists, readJSON } from "./file-store.js";
import { generateId } from "../utils/ids.js";
import { scopeMatches } from "../utils/scope.js";
import { commitHashMatches } from "../utils/commit-hash.js";
import type {
  Decision,
  DecisionAmendment,
  DecisionIndexEntry,
  DecisionStatus,
} from "../utils/types.js";
import type { IDecisionStore } from "./interfaces.js";

/** Salvage shape gate: a plain object whose id matches the filename stem
 * and whose load-bearing string fields exist. Everything else is a stray
 * file, not a decision (2.16.0 review SC-1/TC-4). */
function isSalvageableDecision(raw: unknown, expectedId: string): boolean {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return false;
  }
  const d = raw as Record<string, unknown>;
  return (
    d.id === expectedId &&
    typeof d.scope === "string" &&
    typeof d.summary === "string" &&
    typeof d.timestamp === "string" &&
    typeof d.status === "string"
  );
}

export class DecisionStore implements IDecisionStore {
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
    input: Omit<Decision, "id" | "timestamp" | "status"> & {
      status?: "active" | "provisional";
    },
  ): Promise<Decision> {
    const decision: Decision = {
      ...input,
      commit_hashes: input.commit_hashes ?? [],
      id: generateId(),
      timestamp: new Date().toISOString(),
      status: input.status ?? "active",
    };

    const filePath = path.join(this.decisionsDir, `${decision.id}.json`);

    // Lock index for atomic read-modify-write
    const release = await lockfile.lock(this.indexPath, LOCK_OPTIONS);
    try {
      // Write individual decision file
      atomicWriteFileSync(filePath, JSON.stringify(decision, null, 2));

      // Update index
      const index = JSON.parse(
        fs.readFileSync(this.indexPath, "utf-8"),
      ) as DecisionIndexEntry[];
      index.push(this.toIndexEntry(decision));
      atomicWriteFileSync(this.indexPath, JSON.stringify(index, null, 2));
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
        scopeMatches(entry.scope, scope) ||
        entry.affected_files.some((f) => scopeMatches(f, scope)) ||
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
  ): Promise<{ persisted: boolean }> {
    const filePath = path.join(this.decisionsDir, `${id}.json`);
    if (!fs.existsSync(filePath)) return { persisted: false };

    // Lock index for the full atomic update of both file and index
    const release = await lockfile.lock(this.indexPath, LOCK_OPTIONS);
    try {
      // Update individual decision file
      const decision = JSON.parse(
        fs.readFileSync(filePath, "utf-8"),
      ) as Decision;
      decision.status = status;
      if (extra) {
        Object.assign(decision, extra);
      }
      atomicWriteFileSync(filePath, JSON.stringify(decision, null, 2));

      // Update index
      const index = JSON.parse(
        fs.readFileSync(this.indexPath, "utf-8"),
      ) as DecisionIndexEntry[];
      const indexEntry = index.find((e) => e.id === id);
      if (indexEntry) {
        indexEntry.status = status;
      }
      atomicWriteFileSync(this.indexPath, JSON.stringify(index, null, 2));
    } finally {
      await release();
    }
    this.cachedIndex = null; // Invalidate index cache
    return { persisted: true };
  }

  /**
   * Persist an append-only metadata amendment (field D11). Unlike
   * updateStatus, this rewrites the index entry's affected_files/
   * affected_symbols too — getByScope reads them from the index, so a
   * record-only write would leave the repair invisible to retrieval.
   * Deltas merge against the in-lock read: concurrent amends both survive.
   */
  async amendMetadata(
    id: string,
    delta: {
      add_affected_files: string[];
      add_affected_symbols: string[];
      amendment: DecisionAmendment;
    },
  ): Promise<void> {
    const filePath = path.join(this.decisionsDir, `${id}.json`);
    if (!fs.existsSync(filePath)) return;

    const release = await lockfile.lock(this.indexPath, LOCK_OPTIONS);
    try {
      const decision = JSON.parse(
        fs.readFileSync(filePath, "utf-8"),
      ) as Decision;
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
      atomicWriteFileSync(filePath, JSON.stringify(decision, null, 2));

      const index = JSON.parse(
        fs.readFileSync(this.indexPath, "utf-8"),
      ) as DecisionIndexEntry[];
      const indexEntry = index.find((e) => e.id === id);
      if (indexEntry) {
        indexEntry.affected_files = decision.affected_files;
        indexEntry.affected_symbols = decision.affected_symbols;
      }
      atomicWriteFileSync(this.indexPath, JSON.stringify(index, null, 2));
    } finally {
      await release();
    }
    this.cachedIndex = null; // Invalidate index cache
  }

  /**
   * Index-desync detection + repair (S0-index-desync, 2026-08-15 field
   * audit): every read path is index-driven, so a decision file missing
   * from index.json is silently invisible — the runtime twin of the
   * migrate CLI's orphan salvage. Preview reports orphan ids; execute
   * appends salvaged entries under the index lock. Unparseable files are
   * counted as orphans but never repaired, modified, or deleted — legacy
   * files are their own backup.
   */
  async repairIndexDesync(
    execute: boolean,
  ): Promise<{ orphan_ids: string[]; repaired: number; skipped_invalid: number }> {
    if (!fs.existsSync(this.decisionsDir)) {
      return { orphan_ids: [], repaired: 0, skipped_invalid: 0 };
    }
    // A missing/unreadable index with decision files on disk is the extreme
    // form of the desync — treat it as empty rather than failing detection.
    const indexed = await this.getIndex().catch(() => [] as DecisionIndexEntry[]);
    const known = new Set(indexed.map((e) => e.id));
    const orphan_ids: string[] = [];
    for (const file of fs.readdirSync(this.decisionsDir)) {
      if (file === "index.json" || !file.endsWith(".json")) continue;
      const id = file.slice(0, -".json".length);
      if (!known.has(id)) orphan_ids.push(id);
    }
    if (!execute || orphan_ids.length === 0) {
      return { orphan_ids, repaired: 0, skipped_invalid: 0 };
    }

    let repaired = 0;
    let skipped_invalid = 0;
    // proper-lockfile locks by file existence — a store whose index.json was
    // deleted entirely (the extreme desync) must get one before locking, or
    // the repair fails with ENOENT in exactly the state it exists to fix
    // (2.16.0 review SC-2).
    ensureFileExists(this.indexPath, "[]");
    const release = await lockfile.lock(this.indexPath, LOCK_OPTIONS);
    try {
      let index: DecisionIndexEntry[];
      try {
        const parsed = JSON.parse(
          fs.readFileSync(this.indexPath, "utf-8"),
        ) as unknown;
        index = Array.isArray(parsed) ? (parsed as DecisionIndexEntry[]) : [];
      } catch {
        index = [];
      }
      const liveIds = new Set(index.map((e) => e.id));
      for (const id of orphan_ids) {
        if (liveIds.has(id)) continue; // raced in by a concurrent writer
        try {
          const raw = JSON.parse(
            fs.readFileSync(path.join(this.decisionsDir, `${id}.json`), "utf-8"),
          ) as unknown;
          // Shape gate (2.16.0 review SC-1): only salvage something that is
          // recognizably a decision whose id matches its filename — a stray
          // parseable JSON (merge artifact, index backup, hand-edit) pushed
          // into the index would crash every scope read and re-append on
          // every repair run. Invalid files are reported, never modified.
          if (!isSalvageableDecision(raw, id)) {
            skipped_invalid++;
            continue;
          }
          const decision = raw as Decision;
          decision.affected_files = Array.isArray(decision.affected_files)
            ? decision.affected_files
            : [];
          decision.affected_symbols = Array.isArray(decision.affected_symbols)
            ? decision.affected_symbols
            : [];
          index.push(this.toIndexEntry(decision));
          repaired++;
        } catch {
          // Unparseable: skip, never delete — matches migrate's salvage rule.
          skipped_invalid++;
        }
      }
      if (repaired > 0) {
        // ULIDs sort lexicographically by creation time — keep the index in
        // its natural chronological order after out-of-order salvage
        // (2.16.0 review ENG-5).
        index.sort((a, b) => a.id.localeCompare(b.id));
        atomicWriteFileSync(this.indexPath, JSON.stringify(index, null, 2));
      }
    } finally {
      await release();
    }
    this.cachedIndex = null;
    return { orphan_ids, repaired, skipped_invalid };
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

    // Lock index for the full atomic update of both file and index
    const release = await lockfile.lock(this.indexPath, LOCK_OPTIONS);
    try {
      // Update individual decision file
      const decision = JSON.parse(
        fs.readFileSync(filePath, "utf-8"),
      ) as Decision;
      if (!decision.commit_hashes) {
        decision.commit_hashes = [];
      }
      if (!decision.commit_hashes.includes(commitHash)) {
        decision.commit_hashes.push(commitHash);
      }
      atomicWriteFileSync(filePath, JSON.stringify(decision, null, 2));

      // Update index
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
      atomicWriteFileSync(this.indexPath, JSON.stringify(index, null, 2));
    } finally {
      await release();
    }
    this.cachedIndex = null; // Invalidate index cache
  }

  /** Get decisions linked to a specific commit hash. */
  async getByCommitHash(commitHash: string): Promise<Decision[]> {
    const index = await this.getIndex();
    // Prefix-aware match (2.16.0 review TC-2/CS-1): links are stored however
    // the caller wrote them (this repo's own store holds 7-char links; hooks
    // write full 40-char SHAs), so an exact test made short-vs-full misses
    // the common case. Bidirectional prefix with a 4-char floor — git's own
    // abbreviation minimum — so a stray non-hex or tiny link can't sweep.
    const matching = index.filter(
      (entry) =>
        entry.commit_hashes &&
        entry.commit_hashes.some((h) => commitHashMatches(h, commitHash)),
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
