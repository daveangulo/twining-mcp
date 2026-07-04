/**
 * Blackboard archiver.
 * Moves old entries to archive files, preserving decisions.
 * Posts summary findings after archiving.
 * Phase 3: LIFE-01, LIFE-02, LIFE-03 implementation.
 */
import fs from "node:fs";
import path from "node:path";
import { ensureDir } from "../storage/file-store.js";
import type { BlackboardEngine } from "./blackboard.js";
import type { BlackboardEntry } from "../utils/types.js";
import type { IBlackboardStore, IIndexManager } from "../storage/interfaces.js";

export class Archiver {
  private readonly twiningDir: string;
  private readonly blackboardStore: IBlackboardStore;
  private readonly blackboardEngine: BlackboardEngine;
  private readonly indexManager: IIndexManager | null;

  constructor(
    twiningDir: string,
    blackboardStore: IBlackboardStore,
    blackboardEngine: BlackboardEngine,
    indexManager: IIndexManager | null,
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

    // Read through the store interface — backend-agnostic (W2.2). The old
    // implementation read and rewrote blackboard.jsonl directly, which would
    // silently no-op under the sqlite backend.
    const { entries: allEntries } = await this.blackboardStore.read();

    // Partition: entries before cutoff go to archive, UNLESS they are decisions
    const toArchive: BlackboardEntry[] = [];
    for (const entry of allEntries) {
      const isOldEnough = entry.timestamp < cutoff;
      const isDecision = entry.entry_type === "decision";
      if (isOldEnough && !(keepDecisions && isDecision)) {
        toArchive.push(entry);
      }
    }

    if (toArchive.length === 0) {
      return { archived_count: 0, archive_file: "" };
    }

    // Write archived entries to the archive file BEFORE removing them from
    // the store, so a crash between the two steps duplicates rather than
    // loses entries. Archive files stay on disk under .twining/archive/
    // regardless of backend.
    const archiveDir = path.join(this.twiningDir, "archive");
    ensureDir(archiveDir);
    const dateStr = cutoff.slice(0, 10); // YYYY-MM-DD
    const archiveFile = path.join(archiveDir, `${dateStr}-blackboard.jsonl`);
    const archiveContent =
      toArchive.map((e) => JSON.stringify(e)).join("\n") + "\n";
    fs.appendFileSync(archiveFile, archiveContent);

    // Remove by ID through the store. Entries appended concurrently are
    // untouched (removal is targeted, not a wholesale rewrite).
    await this.blackboardStore.dismiss(toArchive.map((e) => e.id));

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
        _skipAutoArchive: true,
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
