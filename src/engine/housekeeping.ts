/**
 * Housekeeping engine — periodic maintenance for Twining stores.
 * Orchestrates archival, deduplication, stale decision surfacing,
 * dangling warning detection, graph pruning, and metrics rotation.
 *
 * Dry-run by default — preview before executing.
 */
import fs from "node:fs";
import path from "node:path";
import type { BlackboardStore } from "../storage/blackboard-store.js";
import type { DecisionStore } from "../storage/decision-store.js";
import type { Archiver } from "./archiver.js";
import type { GraphEngine } from "./graph.js";
import type { BlackboardEntry, Decision } from "../utils/types.js";
import { auditStaleness, type StaleItem } from "./staleness.js";
import { detectDeletedBranches } from "./branch-watcher.js";

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
  archived: { count: number; file: string };
  deduplicated: { removed: number };
  stale_provisionals: { count: number; items: StaleProvisional[] };
  promoted_provisionals: { count: number; ids: string[] };
  dangling_warnings: { count: number; items: DanglingWarning[] };
  graph_pruned: { removed: number };
  metrics_rotated: { removed: number };
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
  dry_run: boolean;
  summary: string;
}

export class HousekeepingEngine {
  constructor(
    private readonly twiningDir: string,
    private readonly blackboardStore: BlackboardStore,
    private readonly decisionStore: DecisionStore,
    private readonly archiver: Archiver,
    private readonly graphEngine: GraphEngine | null,
    private readonly projectRoot: string | null = null,
    private readonly stalenessThreshold: number = DEFAULT_STALENESS_THRESHOLD,
  ) {}

  async run(options?: {
    stale_days?: number;
    metrics_retention_days?: number;
    execute?: boolean;
    promote_provisionals?: boolean;
    staleness_review?: boolean;
    merge_sweep?: boolean;
  }): Promise<HousekeepingResult> {
    const staleDays = options?.stale_days ?? STALE_PROVISIONAL_DAYS;
    const metricsRetentionDays = options?.metrics_retention_days ?? METRICS_RETENTION_DAYS;
    const execute = options?.execute ?? false;
    const promoteProvisionals = options?.promote_provisionals ?? false;
    const stalenessReview = options?.staleness_review ?? false;
    const mergeSweep = options?.merge_sweep ?? false;

    const result: HousekeepingResult = {
      archived: { count: 0, file: "" },
      deduplicated: { removed: 0 },
      stale_provisionals: { count: 0, items: [] },
      promoted_provisionals: { count: 0, ids: [] },
      dangling_warnings: { count: 0, items: [] },
      graph_pruned: { removed: 0 },
      metrics_rotated: { removed: 0 },
      dry_run: !execute,
      summary: "",
    };

    const now = Date.now();

    // 1. Archive old blackboard entries
    if (execute) {
      try {
        const archiveResult = await this.archiver.archive({ summarize: false });
        result.archived.count = archiveResult.archived_count;
        result.archived.file = archiveResult.archive_file;
      } catch {
        // Non-fatal
      }
    }

    // 2. Deduplicate blackboard entries (same entry_type + summary + scope → keep newest)
    try {
      const { entries } = await this.blackboardStore.read();
      const seen = new Map<string, BlackboardEntry>();
      const duplicateIds: string[] = [];

      // Walk newest-first so we keep the latest
      const sorted = [...entries].sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
      );
      for (const entry of sorted) {
        const key = `${entry.entry_type}|${entry.summary}|${entry.scope}`;
        if (seen.has(key)) {
          duplicateIds.push(entry.id);
        } else {
          seen.set(key, entry);
        }
      }

      if (duplicateIds.length > 0 && execute) {
        await this.blackboardStore.dismiss(duplicateIds);
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
    if (mergeSweep && this.projectRoot) {
      try {
        const sweep = detectDeletedBranches(this.twiningDir, this.projectRoot);
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
    result.summary = parts.length > 0
      ? prefix + parts.join(", ")
      : "Nothing to clean up";

    return result;
  }
}
