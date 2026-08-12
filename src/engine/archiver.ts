/**
 * Blackboard archiver.
 * Moves old entries to archive files, preserving decisions.
 * Posts summary findings after archiving.
 * Phase 3: LIFE-01, LIFE-02, LIFE-03 implementation.
 */
import fs from "node:fs";
import path from "node:path";
import { ensureDir } from "../storage/file-store.js";
import { computeResolvedIds } from "./resolution.js";
import type { BlackboardEngine } from "./blackboard.js";
import type { BlackboardEntry } from "../utils/types.js";
import type { IBlackboardStore, IIndexManager } from "../storage/interfaces.js";

/**
 * Sentinel cutoff meaning "no age filter". The auto-archive trigger and the
 * sweep it fires MUST both use it: if the trigger counts future-stamped
 * entries (clock rolled back, git-synced store authored on a faster clock)
 * but the sweep's cutoff=now excludes them, the trigger re-fires on every
 * post while archiving nothing — the #35 counted-but-never-archived loop
 * through the clock-skew door.
 */
export const NO_AGE_CUTOFF = "9999-12-31T23:59:59.999Z";

export interface ArchivePartitionOptions {
  before?: string;
  keep_decisions?: boolean;
  /** Exempts unresolved needs, warnings, AND open questions (D4 widened
   *  the set to match triage's open-obligation concept). */
  keep_open_needs_warnings?: boolean;
  /**
   * Count-based retention (D4): keep the newest `retain` non-exempt entries
   * on the board regardless of age. Count-based, not age-based, because the
   * #35 field outage proved an age cutoff cannot bound a same-hour burst.
   * Undefined/0 = no retention (legacy explicit-call semantics).
   */
  retain?: number;
}

export interface ArchivePartition {
  to_archive: BlackboardEntry[];
  kept_open_count: number;
  retained_count: number;
  cutoff: string;
}

/**
 * THE archive partition — the single source of truth for "what would a sweep
 * archive". Used by Archiver.plan()/archive() AND by the blackboard
 * auto-archive trigger count: the two MUST stay the same function, because
 * any entry class that is counted by the trigger but never archived by the
 * sweep re-arms the trigger permanently (the #35 auto-archive feedback
 * loop). Sharing the partition makes that drift impossible by construction.
 */
export function partitionArchivable(
  allEntries: BlackboardEntry[],
  resolvedIds: Set<string>,
  options?: ArchivePartitionOptions,
): ArchivePartition {
  const cutoff = options?.before ?? new Date().toISOString();
  const keepDecisions = options?.keep_decisions ?? true;
  const keepOpen = options?.keep_open_needs_warnings ?? true;
  const retain = options?.retain ?? 0;

  const toArchive: BlackboardEntry[] = [];
  let keptOpen = 0;
  for (const entry of allEntries) {
    const isOldEnough = entry.timestamp < cutoff;
    if (!isOldEnough) continue;
    if (keepDecisions && entry.entry_type === "decision") continue;
    if (
      keepOpen &&
      (entry.entry_type === "need" ||
        entry.entry_type === "warning" ||
        entry.entry_type === "question") &&
      !resolvedIds.has(entry.id)
    ) {
      keptOpen++;
      continue;
    }
    toArchive.push(entry);
  }

  // Retention: the newest K archivable entries stay on the board. Applied
  // after exemptions so K is a floor of recent working memory, not a quota
  // consumed by open obligations.
  let retainedCount = 0;
  let finalToArchive = toArchive;
  if (retain > 0 && toArchive.length > 0) {
    const sorted = [...toArchive].sort(
      (a, b) => b.timestamp.localeCompare(a.timestamp) || b.id.localeCompare(a.id),
    );
    const retained = new Set(sorted.slice(0, retain).map((e) => e.id));
    retainedCount = Math.min(retain, sorted.length);
    finalToArchive = toArchive.filter((e) => !retained.has(e.id));
  }

  return {
    to_archive: finalToArchive,
    kept_open_count: keptOpen,
    retained_count: retainedCount,
    cutoff,
  };
}

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
   * Compute the archive partition without touching the store (#39).
   * Entries before the cutoff are archivable UNLESS they are decisions
   * (LIFE-03) or unresolved need/warning/question entries (#40, widened to
   * questions by D4). An item counts as resolved when explicitly resolved
   * (status "resolved", D2) or when any other entry back-references it via
   * relates_to — age is the wrong archival signal for open obligations,
   * which matter MORE as they age, not less. `retain` keeps the newest K
   * archivable entries on the board (D4 count-based retention).
   */
  async plan(options?: ArchivePartitionOptions): Promise<ArchivePartition> {
    // Read through the store interface — backend-agnostic (W2.2). The old
    // implementation read and rewrote blackboard.jsonl directly, which would
    // silently no-op under the sqlite backend.
    const { entries: allEntries } = await this.blackboardStore.read();

    // Resolvers archived in earlier runs aren't visible here — that fails
    // toward keeping the entry, never toward losing an open obligation
    // (explicit D2 status survives regardless).
    const resolvedIds = computeResolvedIds(allEntries);

    return partitionArchivable(allEntries, resolvedIds, options);
  }

  /**
   * Archive old blackboard entries.
   * Decision entries are never archived (LIFE-03); unresolved need/warning
   * entries are exempt unless keep_open_needs_warnings is false (#40).
   * Archived entries are moved to archive/{YYYY-MM-DD}-blackboard.jsonl.
   * Optionally posts a summary finding (LIFE-02).
   */
  async archive(options?: ArchivePartitionOptions & {
    summarize?: boolean;
  }): Promise<{
    archived_count: number;
    archive_file: string;
    kept_open_count: number;
    retained_count: number;
    summary?: string;
  }> {
    const summarize = options?.summarize ?? true;

    const {
      to_archive: toArchive,
      kept_open_count,
      retained_count,
      cutoff,
    } = await this.plan(options);

    if (toArchive.length === 0) {
      return { archived_count: 0, archive_file: "", kept_open_count, retained_count };
    }

    // Write archived entries to the archive file BEFORE removing them from
    // the store, so a crash between the two steps duplicates rather than
    // loses entries. Archive files stay on disk under .twining/archive/
    // regardless of backend.
    const archiveDir = path.join(this.twiningDir, "archive");
    ensureDir(archiveDir);
    // Filename dated by run day, clamped: with the NO_AGE_CUTOFF sentinel a
    // cutoff-derived name would grow one 9999-12-31 file forever (review
    // finding); explicit historical cutoffs keep their dated files.
    const nowIso = new Date().toISOString();
    const dateStr = (cutoff < nowIso ? cutoff : nowIso).slice(0, 10); // YYYY-MM-DD
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
      kept_open_count,
      retained_count,
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
