/**
 * Blackboard archiver.
 * Moves old entries to archive files, preserving decisions.
 * Posts summary findings after archiving.
 * Phase 3: LIFE-01, LIFE-02, LIFE-03 implementation.
 */
import fs from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";
import { readJSONL, appendJSONL, ensureDir } from "../storage/file-store.js";
import type { BlackboardStore } from "../storage/blackboard-store.js";
import type { BlackboardEngine } from "./blackboard.js";
import type { IndexManager } from "../embeddings/index-manager.js";
import type { BlackboardEntry } from "../utils/types.js";

const LOCK_OPTIONS: lockfile.LockOptions = {
  retries: { retries: 10, factor: 1.5, minTimeout: 50, maxTimeout: 1000 },
  stale: 10000,
};

export class Archiver {
  private readonly twiningDir: string;
  private readonly blackboardStore: BlackboardStore;
  private readonly blackboardEngine: BlackboardEngine;
  private readonly indexManager: IndexManager | null;

  constructor(
    twiningDir: string,
    blackboardStore: BlackboardStore,
    blackboardEngine: BlackboardEngine,
    indexManager: IndexManager | null,
  ) {
    this.twiningDir = twiningDir;
    this.blackboardStore = blackboardStore;
    this.blackboardEngine = blackboardEngine;
    this.indexManager = indexManager;
  }

  /**
   * Archive old blackboard entries.
   * Decision entries are never archived (LIFE-03).
   * Archived entries are moved to archive/{YYYY-MM-DD}-blackboard.jsonl.
   * Optionally posts a summary finding (LIFE-02).
   */
  async archive(options?: {
    before?: string;
    keep_decisions?: boolean;
    summarize?: boolean;
  }): Promise<{
    archived_count: number;
    archive_file: string;
    summary?: string;
  }> {
    const cutoff = options?.before ?? new Date().toISOString();
    const keepDecisions = options?.keep_decisions ?? true;
    const summarize = options?.summarize ?? true;

    const bbPath = path.join(this.twiningDir, "blackboard.jsonl");

    // Ensure blackboard file exists for locking
    if (!fs.existsSync(bbPath)) {
      return { archived_count: 0, archive_file: "" };
    }

    // Lock blackboard for the full read-partition-rewrite cycle
    if (!fs.existsSync(bbPath)) {
      fs.writeFileSync(bbPath, "");
    }
    const release = await lockfile.lock(bbPath, LOCK_OPTIONS);

    let toArchive: BlackboardEntry[] = [];
    let toKeep: BlackboardEntry[] = [];

    try {
      // Read all entries (no lock needed since we hold it)
      const content = fs.readFileSync(bbPath, "utf-8");
      const lines = content
        .split("\n")
        .filter((line) => line.trim().length > 0);
      const allEntries: BlackboardEntry[] = [];
      for (const line of lines) {
        try {
          allEntries.push(JSON.parse(line) as BlackboardEntry);
        } catch {
          // Skip corrupt lines
        }
      }

      // Partition: entries before cutoff go to archive, UNLESS they are decisions
      for (const entry of allEntries) {
        const isOldEnough = entry.timestamp < cutoff;
        const isDecision = entry.entry_type === "decision";
        const shouldKeep = !isOldEnough || (keepDecisions && isDecision);

        if (shouldKeep) {
          toKeep.push(entry);
        } else {
          toArchive.push(entry);
        }
      }

      // If nothing to archive, release lock and return early
      if (toArchive.length === 0) {
        return { archived_count: 0, archive_file: "" };
      }

      // Rewrite blackboard with only kept entries
      const keptContent =
        toKeep.length > 0
          ? toKeep.map((e) => JSON.stringify(e)).join("\n") + "\n"
          : "";
      fs.writeFileSync(bbPath, keptContent);
    } finally {
      await release();
    }

    // Write archived entries to archive file (outside blackboard lock)
    const archiveDir = path.join(this.twiningDir, "archive");
    ensureDir(archiveDir);

    const dateStr = cutoff.slice(0, 10); // YYYY-MM-DD
    const archiveFile = path.join(archiveDir, `${dateStr}-blackboard.jsonl`);

    // Append each archived entry to the archive file
    for (const entry of toArchive) {
      await appendJSONL(archiveFile, entry);
    }

    // Remove archived entry embeddings (best-effort)
    if (this.indexManager) {
      try {
        const archivedIds = toArchive.map((e) => e.id);
        await this.indexManager.removeEntries("blackboard", archivedIds);
      } catch {
        // Best-effort — don't fail archive if embedding cleanup fails
      }
    }

    // Build and post summary if requested
    let summaryText: string | undefined;
    if (summarize) {
      summaryText = this.buildSummary(toArchive);
      await this.blackboardEngine.post({
        entry_type: "finding",
        summary: `Archive: ${toArchive.length} entries archived`,
        detail: summaryText,
        tags: ["archive"],
        scope: "project",
      });
    }

    return {
      archived_count: toArchive.length,
      archive_file: archiveFile,
      summary: summaryText,
    };
  }

  /** Build a human-readable summary of archived entries. */
  private buildSummary(archived: BlackboardEntry[]): string {
    // Group by entry_type
    const groups = new Map<string, BlackboardEntry[]>();
    for (const entry of archived) {
      if (!groups.has(entry.entry_type)) groups.set(entry.entry_type, []);
      groups.get(entry.entry_type)!.push(entry);
    }

    const parts: string[] = [];
    parts.push(`Archive summary: ${archived.length} entries archived.`);

    for (const [type, entries] of groups) {
      // Sort by timestamp descending for recency
      const sorted = entries.sort((a, b) =>
        b.timestamp.localeCompare(a.timestamp),
      );
      const topSummaries = sorted
        .slice(0, 3)
        .map((e) => e.summary)
        .join("; ");
      parts.push(`${type}: ${entries.length} entries (${topSummaries}).`);
    }

    let summary = parts.join(" ");
    // Cap at 2000 chars
    if (summary.length > 2000) {
      summary = summary.slice(0, 1997) + "...";
    }
    return summary;
  }
}
