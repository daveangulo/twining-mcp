/**
 * Blackboard CRUD operations.
 * Append-only JSONL storage for shared state entries.
 * Includes mtime-based caching to avoid redundant disk reads.
 */
import fs from "node:fs";
import path from "node:path";
import { appendJSONL, readJSONL } from "./file-store.js";
import { generateId } from "../utils/ids.js";
import type { BlackboardEntry } from "../utils/types.js";

export class BlackboardStore {
  private readonly blackboardPath: string;
  private cachedEntries: BlackboardEntry[] | null = null;
  private cachedMtime: number = 0;

  constructor(twiningDir: string) {
    this.blackboardPath = path.join(twiningDir, "blackboard.jsonl");
  }

  /** Read all entries from disk, using mtime cache when possible. */
  private async readAll(): Promise<BlackboardEntry[]> {
    try {
      if (!fs.existsSync(this.blackboardPath)) {
        this.cachedEntries = [];
        this.cachedMtime = 0;
        return [];
      }
      const stat = fs.statSync(this.blackboardPath);
      if (this.cachedEntries !== null && stat.mtimeMs === this.cachedMtime) {
        return this.cachedEntries;
      }
      const entries = await readJSONL<BlackboardEntry>(this.blackboardPath);
      this.cachedEntries = entries;
      this.cachedMtime = stat.mtimeMs;
      return entries;
    } catch {
      // On any stat/read error, fall through to uncached read
      this.cachedEntries = null;
      this.cachedMtime = 0;
      return readJSONL<BlackboardEntry>(this.blackboardPath);
    }
  }

  /** Append a new entry, generating ID and timestamp. */
  async append(
    entry: Omit<BlackboardEntry, "id" | "timestamp">,
  ): Promise<BlackboardEntry> {
    const full: BlackboardEntry = {
      ...entry,
      id: generateId(),
      timestamp: new Date().toISOString(),
    };
    await appendJSONL(this.blackboardPath, full);
    // Invalidate cache — next read will re-parse
    this.cachedEntries = null;
    return full;
  }

  /** Read entries with optional filters. */
  async read(filters?: {
    entry_types?: string[];
    tags?: string[];
    scope?: string;
    since?: string;
    limit?: number;
  }): Promise<{ entries: BlackboardEntry[]; total_count: number }> {
    let entries = await this.readAll();

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
      entries = entries.filter(
        (e) =>
          e.scope.startsWith(filterScope) || filterScope.startsWith(e.scope),
      );
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

  /** Get the N most recent entries, optionally filtered by type. */
  async recent(n?: number, entry_types?: string[]): Promise<BlackboardEntry[]> {
    let entries = await this.readAll();

    if (entry_types && entry_types.length > 0) {
      entries = entries.filter((e) => entry_types.includes(e.entry_type));
    }

    const count = n ?? 20;
    return entries.slice(-count).reverse();
  }

  /** Remove entries by ID. Returns the IDs that were actually found and removed. */
  async dismiss(ids: string[]): Promise<{ dismissed: string[]; not_found: string[] }> {
    const idSet = new Set(ids);
    const bbPath = this.blackboardPath;

    if (!fs.existsSync(bbPath)) {
      return { dismissed: [], not_found: ids };
    }

    const lockfileModule = await import("proper-lockfile");
    const release = await lockfileModule.default.lock(bbPath, {
      retries: { retries: 10, factor: 1.5, minTimeout: 50, maxTimeout: 1000 },
      stale: 10000,
    });

    try {
      const content = fs.readFileSync(bbPath, "utf-8");
      const lines = content.split("\n").filter((line) => line.trim().length > 0);
      const kept: string[] = [];
      const dismissed: string[] = [];

      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as BlackboardEntry;
          if (idSet.has(entry.id)) {
            dismissed.push(entry.id);
          } else {
            kept.push(line);
          }
        } catch {
          kept.push(line); // Preserve unparseable lines
        }
      }

      const not_found = ids.filter((id) => !dismissed.includes(id));

      if (dismissed.length > 0) {
        const newContent = kept.length > 0 ? kept.join("\n") + "\n" : "";
        fs.writeFileSync(bbPath, newContent);
        // Invalidate cache
        this.cachedEntries = null;
      }

      return { dismissed, not_found };
    } finally {
      await release();
    }
  }
}
