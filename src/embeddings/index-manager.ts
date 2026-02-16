/**
 * Embedding index CRUD operations.
 * JSON-based storage in .twining/embeddings/ with file locking.
 * Matches spec section 5.3 index structure.
 */
import fs from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";
import { ensureDir } from "../storage/file-store.js";

/** Embedding index structure — spec section 5.3 */
export interface EmbeddingIndex {
  model: string;
  dimension: number;
  entries: {
    id: string;
    vector: number[];
  }[];
}

const LOCK_OPTIONS: lockfile.LockOptions = {
  retries: { retries: 10, factor: 1.5, minTimeout: 50, maxTimeout: 1000 },
  stale: 10000,
};

const DEFAULT_INDEX: EmbeddingIndex = {
  model: "all-MiniLM-L6-v2",
  dimension: 384,
  entries: [],
};

export type IndexName = "blackboard" | "decisions";

export class IndexManager {
  private readonly embeddingsDir: string;

  constructor(twiningDir: string) {
    this.embeddingsDir = path.join(twiningDir, "embeddings");
    ensureDir(this.embeddingsDir);
  }

  /** Get the file path for a named index. */
  private indexPath(indexName: IndexName): string {
    return path.join(this.embeddingsDir, `${indexName}.index`);
  }

  /** Load an embedding index. Returns empty index if file doesn't exist. */
  async load(indexName: IndexName): Promise<EmbeddingIndex> {
    const filePath = this.indexPath(indexName);
    if (!fs.existsSync(filePath)) {
      return { ...DEFAULT_INDEX, entries: [] };
    }

    try {
      const content = fs.readFileSync(filePath, "utf-8");
      if (!content.trim()) {
        return { ...DEFAULT_INDEX, entries: [] };
      }
      return JSON.parse(content) as EmbeddingIndex;
    } catch {
      console.error(
        `[twining] Corrupt embedding index ${indexName}, returning empty`,
      );
      return { ...DEFAULT_INDEX, entries: [] };
    }
  }

  /** Save an embedding index atomically with file locking. */
  async save(indexName: IndexName, index: EmbeddingIndex): Promise<void> {
    const filePath = this.indexPath(indexName);

    // Ensure file exists for proper-lockfile
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, "");
    }

    const release = await lockfile.lock(filePath, LOCK_OPTIONS);
    try {
      fs.writeFileSync(filePath, JSON.stringify(index));
    } finally {
      await release();
    }
  }

  /** Add a single entry to an index. Loads, appends, saves atomically. */
  async addEntry(
    indexName: IndexName,
    id: string,
    vector: number[],
  ): Promise<void> {
    const filePath = this.indexPath(indexName);

    // Ensure file exists for proper-lockfile
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, "");
    }

    const release = await lockfile.lock(filePath, LOCK_OPTIONS);
    try {
      // Read current index
      const content = fs.readFileSync(filePath, "utf-8");
      const index: EmbeddingIndex =
        content.trim() ? (JSON.parse(content) as EmbeddingIndex) : { ...DEFAULT_INDEX, entries: [] };

      // Replace existing entry with same ID, or append
      const existingIdx = index.entries.findIndex((e) => e.id === id);
      if (existingIdx >= 0) {
        index.entries[existingIdx] = { id, vector };
      } else {
        index.entries.push({ id, vector });
      }

      // Write back
      fs.writeFileSync(filePath, JSON.stringify(index));
    } finally {
      await release();
    }
  }

  /** Remove entries by IDs from an index. */
  async removeEntries(indexName: IndexName, ids: string[]): Promise<void> {
    const filePath = this.indexPath(indexName);
    if (!fs.existsSync(filePath)) return;

    const release = await lockfile.lock(filePath, LOCK_OPTIONS);
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      if (!content.trim()) return;

      const index = JSON.parse(content) as EmbeddingIndex;
      const idSet = new Set(ids);
      index.entries = index.entries.filter((e) => !idSet.has(e.id));

      fs.writeFileSync(filePath, JSON.stringify(index));
    } finally {
      await release();
    }
  }

  /** Get a single vector by ID. Returns null if not found. */
  async getVector(
    indexName: IndexName,
    id: string,
  ): Promise<number[] | null> {
    const index = await this.load(indexName);
    const entry = index.entries.find((e) => e.id === id);
    return entry?.vector ?? null;
  }
}
