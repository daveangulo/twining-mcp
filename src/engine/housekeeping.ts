/**
 * Housekeeping engine — periodic maintenance for Twining stores.
 * Orchestrates archival, deduplication, stale decision surfacing,
 * dangling warning detection, graph pruning, and metrics rotation.
 *
 * Dry-run by default — preview before executing.
 */
import fs from "node:fs";
import { reportAmendCandidates, type AmendCandidateReport } from "./amend-candidates.js";
import { dedupRelations, type RelationDedupReport } from "./relation-dedup.js";
import path from "node:path";
import type { Archiver } from "./archiver.js";
import { NO_AGE_CUTOFF } from "./archiver.js";
import { appendDismissalTombstones } from "./tombstones.js";
import type { GraphEngine } from "./graph.js";
import type { BlackboardEntry, Decision } from "../utils/types.js";
import { auditStaleness, type StaleItem } from "./staleness.js";
import { detectDeletedBranches } from "./branch-watcher.js";
import {
  compactArchives,
  formatBytes,
  type ArchiveCompactionReport,
} from "./archive-compactor.js";
import type { IBlackboardStore, IDecisionStore } from "../storage/interfaces.js";
import {
  repairEntityScopes,
  type EntityScopeRepairReport,
} from "./entity-scope-repair.js";

/** Default: flag provisionals older than 7 days. */
const STALE_PROVISIONAL_DAYS = 7;

/** Default: flag at score >= this when the user explicitly requests staleness review. */
const DEFAULT_STALENESS_THRESHOLD = 0.95;

/** Default: keep metrics for 30 days. */
const METRICS_RETENTION_DAYS = 30;

export interface StaleProvisional {
  id: string;
  summary: string;
  scope: string;
  age_days: number;
}

export interface DanglingWarning {
  id: string;
  summary: string;
  scope: string;
  age_days: number;
}

export interface HousekeepingResult {
  /** Report-only amend candidates (re-scoped field D13 ask 1); write path is twining_amend. */
  amend_candidates?: AmendCandidateReport;
  /** Set when amend_candidates was requested but could not run — never a silent no-op. */
  amend_candidates_error?: string;
  /** Legacy duplicate-relation dedup (wave-2 follow-up); preview unless execute. */
  relation_dedup?: RelationDedupReport;
  archived: { count: number; file: string; kept_open: number };
  deduplicated: { removed: number };
  stale_provisionals: { count: number; items: StaleProvisional[] };
  promoted_provisionals: { count: number; ids: string[] };
  dangling_warnings: { count: number; items: DanglingWarning[] };
  graph_pruned: { removed: number };
  metrics_rotated: { removed: number };
  superseded_backfill: {
    fixed: number;
    dangling: number;
    items: Array<{ id: string; superseded_by: string }>;
  };
  staleness_review?: {
    threshold: number;
    candidates: StaleItem[];
  };
  merge_sweep?: {
    initial_record: boolean;
    enumerated: boolean;
    current_branches: string[];
    deleted_branches: string[];
    since: string | null;
    candidates: Array<{
      id: string;
      kind: "decision" | "blackboard";
      summary: string;
      scope: string;
      branch: string;
      commit_sha?: string;
      recorded_at?: string;
    }>;
  };
  archive_compaction?: ArchiveCompactionReport;
  entity_scope_repair?: EntityScopeRepairReport;
  dry_run: boolean;
  summary: string;
}

export class HousekeepingEngine {
  constructor(
    private readonly twiningDir: string,
    private readonly blackboardStore: IBlackboardStore,
    private readonly decisionStore: IDecisionStore,
    private readonly archiver: Archiver,
    private readonly graphEngine: GraphEngine | null,
    private readonly projectRoot: string | null = null,
    private readonly stalenessThreshold: number = DEFAULT_STALENESS_THRESHOLD,
    /** Newest-K retention for the opt-in archive pass (config archive.retain_recent). */
    private readonly archiveRetain: number = 0,
  ) {}

  async run(options?: {
    stale_days?: number;
    metrics_retention_days?: number;
    execute?: boolean;
    promote_provisionals?: boolean;
    staleness_review?: boolean;
    merge_sweep?: boolean;
    /**
     * Report candidate affected_files for active decisions with empty
     * lists (scope walk + term overlap). ALWAYS report-only — execute has
     * no effect; confirm per record with twining_amend.
     */
    amend_candidates?: boolean;
    /**
     * Dedup legacy duplicate (source, target, type) graph relations —
     * survivor is the oldest edge (the one live upserts already merge
     * into); properties fold in under origin precedence. Preview unless
     * execute is set.
     */
    dedup_relations?: boolean;
    compact_archives?: boolean;
    /**
     * Recompute graph entity scopes from their decided_by relations, undoing
     * the pre-fix last-writer-wins overwrite. Dry-run unless execute is set.
     */
    repair_entity_scopes?: boolean;
    /**
     * Set true to run the blackboard archive pass (step 1). OFF BY DEFAULT
     * since D4: the pass takes no age cutoff, so on `execute: true` it used
     * to sweep the whole live board as a side effect of any maintenance
     * call — an agent reaching for the `compact_archives` repair got a
     * full-board archive it never asked for. When enabled, the sweep
     * retains the newest `archive.retain_recent` entries (constructor).
     */
    archive?: boolean;
  }): Promise<HousekeepingResult> {
    const staleDays = options?.stale_days ?? STALE_PROVISIONAL_DAYS;
    const metricsRetentionDays = options?.metrics_retention_days ?? METRICS_RETENTION_DAYS;
    const execute = options?.execute ?? false;
    const promoteProvisionals = options?.promote_provisionals ?? false;
    const stalenessReview = options?.staleness_review ?? false;
    const mergeSweep = options?.merge_sweep ?? false;
    const amendCandidatesOpt = options?.amend_candidates ?? false;
    const dedupRelationsOpt = options?.dedup_relations ?? false;
    const compactArchivesOpt = options?.compact_archives ?? false;
    const repairEntityScopesOpt = options?.repair_entity_scopes ?? false;
    const archiveEnabled = options?.archive ?? false;

    const result: HousekeepingResult = {
      archived: { count: 0, file: "", kept_open: 0 },
      deduplicated: { removed: 0 },
      stale_provisionals: { count: 0, items: [] },
      promoted_provisionals: { count: 0, ids: [] },
      dangling_warnings: { count: 0, items: [] },
      graph_pruned: { removed: 0 },
      metrics_rotated: { removed: 0 },
      superseded_backfill: { fixed: 0, dangling: 0, items: [] },
      dry_run: !execute,
      summary: "",
    };

    const now = Date.now();

    // 1. Archive old blackboard entries. Preview runs the same partition
    // via archiver.plan() so its count — and every downstream pass — matches
    // what execute will do (#39); previously preview skipped this pass
    // entirely and computed dedup/warnings on pre-archive state.
    let plannedArchiveIds = new Set<string>();
    if (!archiveEnabled) {
      // Explicitly skipped — leave counts at zero so the report does not imply
      // a sweep happened.
    } else if (execute) {
      try {
        // NO_AGE_CUTOFF: the pass is documented as age-blind, twining_status
        // counts archivable with the same sentinel, and the auto-trigger
        // already unified count and sweep on it — a cutoff=now sweep here
        // would strand future-stamped entries the status warning counted
        // (review finding: counted-but-never-archived drift across surfaces).
        const archiveResult = await this.archiver.archive({
          summarize: false,
          retain: this.archiveRetain,
          before: NO_AGE_CUTOFF,
        });
        result.archived.count = archiveResult.archived_count;
        result.archived.file = archiveResult.archive_file;
        result.archived.kept_open = archiveResult.kept_open_count;
      } catch {
        // Non-fatal
      }
    } else {
      try {
        // Same retain and cutoff as execute — preview/execute parity (#39).
        const plan = await this.archiver.plan({
          retain: this.archiveRetain,
          before: NO_AGE_CUTOFF,
        });
        result.archived.count = plan.to_archive.length;
        result.archived.kept_open = plan.kept_open_count;
        plannedArchiveIds = new Set(plan.to_archive.map((e) => e.id));
      } catch {
        // Non-fatal
      }
    }

    // 2. Deduplicate blackboard entries (same entry_type + summary + scope → keep newest)
    try {
      const { entries: boardEntries } = await this.blackboardStore.read();
      // Execute reads post-archive state; preview simulates it (#39).
      const entries = execute
        ? boardEntries
        : boardEntries.filter((e) => !plannedArchiveIds.has(e.id));
      const seen = new Map<string, BlackboardEntry>();
      const duplicateIds: string[] = [];
      const doomed: BlackboardEntry[] = [];

      // Walk newest-first so we keep the latest. Entries carrying a D2
      // lifecycle stamp (status "resolved") are excluded from dedup in BOTH
      // roles (review finding): deleting a resolved copy destroys the
      // resolution audit twining_resolve promises to preserve, and letting a
      // resolved copy shadow an open same-text repost silently deletes an
      // open obligation. A resolved entry and its recurrence are different
      // facts, not duplicates.
      const sorted = [...entries].sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
      );
      for (const entry of sorted) {
        if (entry.status === "resolved") continue;
        const key = `${entry.entry_type}|${entry.summary}|${entry.scope}`;
        if (seen.has(key)) {
          duplicateIds.push(entry.id);
          doomed.push(entry);
        } else {
          seen.set(key, entry);
        }
      }

      if (duplicateIds.length > 0 && execute) {
        await this.blackboardStore.dismiss(duplicateIds);
        // Every dismissal path tombstones (review finding: dedup was the
        // last path that hard-deleted without one).
        appendDismissalTombstones(this.twiningDir, doomed, {
          reason: "duplicate of a newer same-text entry",
          dismissed_by: "housekeeping-dedup",
        });
      }
      result.deduplicated.removed = duplicateIds.length;

      // 6. Surface dangling warnings (never auto-removed, just reported)
      const warnings = entries.filter((e) => e.entry_type === "warning");
      result.dangling_warnings.items = warnings.map((w) => ({
        id: w.id,
        summary: w.summary,
        scope: w.scope,
        age_days: Math.floor((now - new Date(w.timestamp).getTime()) / (24 * 60 * 60 * 1000)),
      }));
      result.dangling_warnings.items.sort((a, b) => b.age_days - a.age_days);
      result.dangling_warnings.count = result.dangling_warnings.items.length;
    } catch {
      // Non-fatal
    }

    // 3. Surface stale provisional decisions (report always, promote only if opted in)
    try {
      const cutoff = new Date(
        now - staleDays * 24 * 60 * 60 * 1000,
      ).toISOString();
      const index = await this.decisionStore.getIndex();
      const staleProvisionals = index.filter(
        (e) => e.status === "provisional" && e.timestamp < cutoff,
      );

      result.stale_provisionals.items = staleProvisionals.map((e) => ({
        id: e.id,
        summary: e.summary,
        scope: e.scope,
        age_days: Math.floor((now - new Date(e.timestamp).getTime()) / (24 * 60 * 60 * 1000)),
      }));
      result.stale_provisionals.items.sort((a, b) => b.age_days - a.age_days);
      result.stale_provisionals.count = staleProvisionals.length;

      // Only promote if explicitly requested
      if (promoteProvisionals && execute && staleProvisionals.length > 0) {
        for (const entry of staleProvisionals) {
          await this.decisionStore.updateStatus(entry.id, "active");
        }
        result.promoted_provisionals.count = staleProvisionals.length;
        result.promoted_provisionals.ids = staleProvisionals.map((e) => e.id);
      }
    } catch {
      // Non-fatal
    }

    // 4. Prune orphaned graph entities
    if (this.graphEngine) {
      try {
        const pruneResult = await this.graphEngine.prune(undefined, !execute);
        result.graph_pruned.removed = execute ? pruneResult.total_removed : pruneResult.total_orphans_found;
      } catch {
        // Non-fatal
      }
    }

    // 5. Rotate metrics — remove entries older than retention period
    try {
      const metricsPath = path.join(this.twiningDir, "metrics.jsonl");
      if (fs.existsSync(metricsPath)) {
        const cutoff = new Date(
          now - metricsRetentionDays * 24 * 60 * 60 * 1000,
        ).toISOString();
        const content = fs.readFileSync(metricsPath, "utf-8");
        const lines = content.split("\n").filter((l) => l.trim());
        const kept: string[] = [];
        let removed = 0;

        for (const line of lines) {
          try {
            const entry = JSON.parse(line) as { timestamp?: string };
            if (entry.timestamp && entry.timestamp < cutoff) {
              removed++;
            } else {
              kept.push(line);
            }
          } catch {
            kept.push(line); // Keep unparseable lines
          }
        }

        if (removed > 0 && execute) {
          fs.writeFileSync(metricsPath, kept.join("\n") + (kept.length > 0 ? "\n" : ""));
        }
        result.metrics_rotated.removed = removed;
      }
    } catch {
      // Non-fatal
    }

    // 7. Staleness review — opt-in (provenance-aware orphan detection).
    if (stalenessReview && this.projectRoot) {
      try {
        const allDecisionEntries = await this.decisionStore.getIndex();
        const decisions: Decision[] = [];
        for (const entry of allDecisionEntries) {
          if (entry.status !== "active") continue;
          const d = await this.decisionStore.get(entry.id);
          if (d) decisions.push(d);
        }
        const { entries: bbEntries } = await this.blackboardStore.read();
        const audit = auditStaleness(decisions, bbEntries, {
          threshold: this.stalenessThreshold,
          projectRoot: this.projectRoot,
        });
        result.staleness_review = audit;
      } catch {
        // Non-fatal — staleness review is opt-in and shouldn't break housekeeping
      }
    }

    // 8. Merge sweep — opt-in (branch-watcher diff vs last housekeeping snapshot).
    if (dedupRelationsOpt && this.graphEngine) {
      try {
        result.relation_dedup = await dedupRelations(
          this.graphEngine.graphStore,
          execute,
        );
      } catch (error) {
        console.error("[twining] relation dedup failed (non-fatal):", error);
      }
    }

    if (amendCandidatesOpt) {
      if (this.projectRoot) {
        try {
          result.amend_candidates = await reportAmendCandidates(
            this.decisionStore,
            this.projectRoot,
          );
        } catch (error) {
          console.error("[twining] amend-candidates report failed (non-fatal):", error);
          result.amend_candidates_error =
            error instanceof Error ? error.message : String(error);
        }
      } else {
        // Never a silent no-op (review finding): the caller asked and must
        // hear why nothing came back.
        result.amend_candidates_error = "unavailable: no project root configured";
      }
    }

    // Snapshot file is only updated when execute=true; dry-runs compute the
    // diff against the existing baseline without advancing it, so a preview
    // can never silently consume deletions before the user acts.
    if (mergeSweep && this.projectRoot) {
      try {
        const sweep = detectDeletedBranches(
          this.twiningDir,
          this.projectRoot,
          execute,
        );
        const candidates: NonNullable<HousekeepingResult["merge_sweep"]>["candidates"] = [];

        if (sweep.deleted_branches.length > 0) {
          const deletedSet = new Set(sweep.deleted_branches);
          // Active decisions only — archived ones are already off the books.
          const decisionIndex = await this.decisionStore.getIndex();
          for (const idx of decisionIndex) {
            if (idx.status !== "active") continue;
            const d = await this.decisionStore.get(idx.id);
            if (!d?.provenance?.branch) continue;
            if (!deletedSet.has(d.provenance.branch)) continue;
            const item: NonNullable<HousekeepingResult["merge_sweep"]>["candidates"][number] = {
              id: d.id,
              kind: "decision",
              summary: d.summary,
              scope: d.scope,
              branch: d.provenance.branch,
            };
            if (d.provenance.commit_sha) item.commit_sha = d.provenance.commit_sha;
            if (d.provenance.recorded_at) item.recorded_at = d.provenance.recorded_at;
            candidates.push(item);
          }

          const { entries: bbEntries } = await this.blackboardStore.read();
          for (const e of bbEntries) {
            if (!e.provenance?.branch) continue;
            if (!deletedSet.has(e.provenance.branch)) continue;
            const item: NonNullable<HousekeepingResult["merge_sweep"]>["candidates"][number] = {
              id: e.id,
              kind: "blackboard",
              summary: e.summary,
              scope: e.scope,
              branch: e.provenance.branch,
            };
            if (e.provenance.commit_sha) item.commit_sha = e.provenance.commit_sha;
            if (e.provenance.recorded_at) item.recorded_at = e.provenance.recorded_at;
            candidates.push(item);
          }
        }

        result.merge_sweep = {
          initial_record: sweep.initial_record,
          enumerated: sweep.enumerated,
          current_branches: sweep.current_branches,
          deleted_branches: sweep.deleted_branches,
          since: sweep.state_recorded_at,
          candidates,
        };
      } catch {
        // Non-fatal — merge sweep is opt-in and shouldn't break housekeeping
      }
    }

    // 9. Superseded back-link backfill — supersede was one-directional before
    // v1.25 (#31): the target's status flipped but superseded_by was never
    // written, so a retired decision could not point at its replacement. Scan
    // decisions carrying a supersedes link; where the target exists and lacks
    // the back-link, report it (preview) or write it (execute). The write
    // preserves the target's current status — backfill fills the pointer, it
    // does not relitigate lifecycle. Dangling targets (historical supersedes
    // of since-deleted decisions) are counted and skipped, never fabricated.
    try {
      const index = await this.decisionStore.getIndex();
      // target id → superseding id; index order is chronological (ULID), so a
      // later supersessor of the same target overwrites an earlier one.
      const pending = new Map<string, string>();
      let dangling = 0;
      for (const entry of index) {
        const d = await this.decisionStore.get(entry.id);
        if (!d?.supersedes) continue;
        const target = await this.decisionStore.get(d.supersedes);
        if (!target) {
          dangling++;
          continue;
        }
        if (target.superseded_by) continue;
        pending.set(target.id, d.id);
      }

      if (execute) {
        for (const [targetId, supersededBy] of pending) {
          const target = await this.decisionStore.get(targetId);
          if (!target) continue;
          await this.decisionStore.updateStatus(targetId, target.status, {
            superseded_by: supersededBy,
          });
        }
      }

      result.superseded_backfill.items = [...pending].map(
        ([id, superseded_by]) => ({ id, superseded_by }),
      );
      result.superseded_backfill.fixed = pending.size;
      result.superseded_backfill.dangling = dangling;
    } catch {
      // Non-fatal
    }

    // 10. Archive compaction — opt-in repair pass for the pre-1.24.0
    // auto-archive feedback loop (#35). Streams archive/*.jsonl, drops only
    // entries matching the archiver's own summary signature, and (execute
    // only) atomically rewrites files, deleting any left empty.
    if (compactArchivesOpt) {
      try {
        result.archive_compaction = await compactArchives(this.twiningDir, {
          execute,
        });
      } catch {
        // Non-fatal — compaction is opt-in and shouldn't break housekeeping
      }
    }

    // 11. Entity scope repair — opt-in backfill for graph entities whose
    // scope was overwritten before the union fix (utils/entity-properties.ts).
    if (repairEntityScopesOpt && this.graphEngine) {
      try {
        result.entity_scope_repair = await repairEntityScopes(
          this.graphEngine.graphStore,
          { execute },
        );
      } catch {
        // Non-fatal — repair is opt-in and must not break housekeeping.
      }
    }

    // Dedupe: if both staleness_review and merge_sweep ran, an entry from a
    // recently-deleted branch will appear in both candidate lists (branch_gone
    // signal vs deleted-branch sweep). Remove the staleness duplicate so the
    // caller doesn't see the same ID framed two different ways. merge_sweep
    // wins because it's the more specific signal.
    if (result.staleness_review && result.merge_sweep) {
      const sweepIds = new Set(result.merge_sweep.candidates.map((c) => c.id));
      result.staleness_review.candidates =
        result.staleness_review.candidates.filter((c) => !sweepIds.has(c.id));
    }

    // Build summary
    const prefix = execute ? "" : "[preview] ";
    const verb = execute ? "" : "would ";
    const parts: string[] = [];
    if (result.archived.count > 0) parts.push(`${verb}archive ${result.archived.count} entries`);
    if (result.deduplicated.removed > 0) parts.push(`${verb}remove ${result.deduplicated.removed} duplicates`);
    if (result.stale_provisionals.count > 0) parts.push(`${result.stale_provisionals.count} stale provisionals need review`);
    if (result.dangling_warnings.count > 0) parts.push(`${result.dangling_warnings.count} unresolved warnings`);
    if (result.promoted_provisionals.count > 0) parts.push(`promoted ${result.promoted_provisionals.count} provisionals`);
    if (result.graph_pruned.removed > 0) parts.push(`${verb}prune ${result.graph_pruned.removed} orphaned entities`);
    if (result.metrics_rotated.removed > 0) parts.push(`${verb}rotate ${result.metrics_rotated.removed} old metrics`);
    if (result.superseded_backfill.fixed > 0) parts.push(`${verb}backfill ${result.superseded_backfill.fixed} superseded_by back-link(s)`);
    if (result.superseded_backfill.dangling > 0) parts.push(`${result.superseded_backfill.dangling} dangling supersedes target(s) skipped`);
    if (result.staleness_review && result.staleness_review.candidates.length > 0) {
      parts.push(`${result.staleness_review.candidates.length} items ≥ score ${result.staleness_review.threshold} flagged stale`);
    }
    if (result.merge_sweep) {
      if (result.merge_sweep.initial_record) {
        parts.push(`merge_sweep: recorded initial branch snapshot (${result.merge_sweep.current_branches?.length ?? 0} branches)`);
      } else if (result.merge_sweep.deleted_branches.length > 0) {
        parts.push(`merge_sweep: ${result.merge_sweep.deleted_branches.length} deleted branch(es), ${result.merge_sweep.candidates.length} entries from them`);
      }
    }
    if (result.archive_compaction && result.archive_compaction.total_junk > 0) {
      const ac = result.archive_compaction;
      parts.push(
        `${verb}drop ${ac.total_junk} loop-junk archive entries (~${formatBytes(ac.total_bytes_reclaimable)})`,
      );
    }
    result.summary = parts.length > 0
      ? prefix + parts.join(", ")
      : "Nothing to clean up";

    return result;
  }
}
