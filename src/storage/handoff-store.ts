/**
 * Handoff CRUD operations.
 * Individual JSON files per handoff with a JSONL index for fast listing.
 * Follows DecisionStore's individual-file pattern.
 */
import fs from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";
import {
  readJSON,
  writeJSON,
  appendJSONL,
  readJSONL,
  writeJSONL,
  ensureDir,
} from "./file-store.js";
import { generateId } from "../utils/ids.js";
import type {
  HandoffRecord,
  HandoffResult,
  HandoffIndexEntry,
} from "../utils/types.js";

const INDEX_LOCK_OPTIONS: lockfile.LockOptions = {
  retries: { retries: 10, factor: 1.5, minTimeout: 50, maxTimeout: 1000 },
  stale: 10000,
};

export class HandoffStore {
  private readonly handoffsDir: string;
  private readonly indexPath: string;

  constructor(twiningDir: string) {
    this.handoffsDir = path.join(twiningDir, "handoffs");
    this.indexPath = path.join(this.handoffsDir, "index.jsonl");
  }

  /**
   * Create a new handoff record.
   * Writes individual JSON file, then appends to JSONL index.
   */
  async create(
    input: Omit<HandoffRecord, "id" | "created_at">,
  ): Promise<HandoffRecord> {
    ensureDir(this.handoffsDir);

    const record: HandoffRecord = {
      ...input,
      id: generateId(),
      created_at: new Date().toISOString(),
    };

    // File-first: write individual file before updating index
    const filePath = path.join(this.handoffsDir, `${record.id}.json`);
    await writeJSON(filePath, record);

    // Append lightweight index entry
    const indexEntry = this.toIndexEntry(record);
    await appendJSONL(this.indexPath, indexEntry);

    return record;
  }

  /**
   * Get a single handoff by ID.
   * Returns null if file doesn't exist.
   */
  async get(id: string): Promise<HandoffRecord | null> {
    const filePath = path.join(this.handoffsDir, `${id}.json`);
    try {
      return await readJSON<HandoffRecord>(filePath);
    } catch {
      // ENOENT or other error — return null
      return null;
    }
  }

  /**
   * List handoff index entries with optional filtering.
   * Reads from JSONL index for fast listing.
   */
  async list(
    filters?: {
      source_agent?: string;
      target_agent?: string;
      scope?: string;
      since?: string;
      limit?: number;
    },
  ): Promise<HandoffIndexEntry[]> {
    let entries = await readJSONL<HandoffIndexEntry>(this.indexPath);

    if (filters) {
      if (filters.source_agent) {
        entries = entries.filter(
          (e) => e.source_agent === filters.source_agent,
        );
      }
      if (filters.target_agent) {
        entries = entries.filter(
          (e) => e.target_agent === filters.target_agent,
        );
      }
      if (filters.scope) {
        const filterScope = filters.scope;
        entries = entries.filter(
          (e) =>
            e.scope?.startsWith(filterScope) ||
            filterScope.startsWith(e.scope ?? ""),
        );
      }
      if (filters.since) {
        const since = filters.since;
        entries = entries.filter((e) => e.created_at >= since);
      }
    }

    // Sort by created_at descending (newest first), ULID tiebreaker
    entries.sort(
      (a, b) =>
        b.created_at.localeCompare(a.created_at) ||
        b.id.localeCompare(a.id),
    );

    // Apply limit
    if (filters?.limit !== undefined) {
      entries = entries.slice(0, filters.limit);
    }

    return entries;
  }

  /**
   * Acknowledge a handoff.
   * Updates individual file and rewrites index entry atomically under lock.
   */
  async acknowledge(
    id: string,
    acknowledgedBy: string,
  ): Promise<HandoffRecord> {
    const filePath = path.join(this.handoffsDir, `${id}.json`);

    // Ensure index file exists for locking (appendJSONL creates lazily)
    ensureDir(this.handoffsDir);
    if (!fs.existsSync(this.indexPath)) {
      fs.writeFileSync(this.indexPath, "");
    }

    // Lock index for atomic read-modify-write of both file and index.
    // We do direct fs reads/writes inside the lock to avoid nested locking
    // (readJSONL/writeJSONL/writeJSON use their own locks internally).
    const release = await lockfile.lock(this.indexPath, INDEX_LOCK_OPTIONS);
    try {
      let record: HandoffRecord;
      try {
        record = JSON.parse(fs.readFileSync(filePath, "utf-8")) as HandoffRecord;
      } catch {
        throw new Error(`Handoff not found: ${id}`);
      }

      // Update acknowledgment fields
      record.acknowledged_by = acknowledgedBy;
      record.acknowledged_at = new Date().toISOString();

      // Rewrite individual file (direct write, no nested lock)
      fs.writeFileSync(filePath, JSON.stringify(record, null, 2));

      // Rewrite index with updated entry (direct read/write, no nested lock)
      const indexContent = fs.readFileSync(this.indexPath, "utf-8");
      const entries: HandoffIndexEntry[] = indexContent
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as HandoffIndexEntry);
      const updatedEntries = entries.map((e) =>
        e.id === id ? { ...e, acknowledged: true } : e,
      );
      const newContent = updatedEntries.length > 0
        ? updatedEntries.map((e) => JSON.stringify(e)).join("\n") + "\n"
        : "";
      fs.writeFileSync(this.indexPath, newContent);

      return record;
    } finally {
      await release();
    }
  }

  /**
   * Compute aggregate result_status and create a lightweight index entry.
   */
  private toIndexEntry(record: HandoffRecord): HandoffIndexEntry {
    const resultStatus = this.computeResultStatus(record.results);
    return {
      id: record.id,
      created_at: record.created_at,
      source_agent: record.source_agent,
      target_agent: record.target_agent,
      scope: record.scope,
      summary: record.summary,
      result_status: resultStatus,
      acknowledged: false,
    };
  }

  /**
   * Compute aggregate result_status from results array.
   * - If no results, "completed"
   * - If all same status, that status
   * - If mixed, "mixed"
   */
  private computeResultStatus(
    results: HandoffResult[],
  ): HandoffIndexEntry["result_status"] {
    if (results.length === 0) return "completed";

    const statuses = new Set(results.map((r) => r.status));
    if (statuses.size === 1) {
      return results[0]!.status;
    }
    return "mixed";
  }
}
