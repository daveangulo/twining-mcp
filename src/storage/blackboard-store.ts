/**
 * Blackboard CRUD operations.
 * Append-only JSONL storage for shared state entries.
 */
import path from "node:path";
import { appendJSONL, readJSONL } from "./file-store.js";
import { generateId } from "../utils/ids.js";
import type { BlackboardEntry } from "../utils/types.js";

export class BlackboardStore {
  private readonly blackboardPath: string;

  constructor(twiningDir: string) {
    this.blackboardPath = path.join(twiningDir, "blackboard.jsonl");
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
    let entries = await readJSONL<BlackboardEntry>(this.blackboardPath);

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
      entries = entries.slice(0, filters.limit);
    }

    return { entries, total_count };
  }

  /** Get the N most recent entries, optionally filtered by type. */
  async recent(n?: number, entry_types?: string[]): Promise<BlackboardEntry[]> {
    let entries = await readJSONL<BlackboardEntry>(this.blackboardPath);

    if (entry_types && entry_types.length > 0) {
      entries = entries.filter((e) => entry_types.includes(e.entry_type));
    }

    const count = n ?? 20;
    return entries.slice(-count);
  }
}
