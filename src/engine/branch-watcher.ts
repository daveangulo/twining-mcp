/**
 * Branch-merge sweep — the Phase 4 piece of #7.
 *
 * Tracks the local branch set across housekeeping runs. The first run records
 * a snapshot; subsequent runs diff against it to find branches that were
 * present last time but are gone now (deleted, typically post-merge). Entries
 * and decisions whose `provenance.branch` matches the deleted set are
 * surfaced as candidates for archival via `twining_archive_stale`.
 *
 * Why not derive from `git branch --merged main` alone? Because once a branch
 * has been deleted you can no longer ask whether it was merged or
 * force-deleted — only the user's intent at the time of deletion matters,
 * and the action ("archive entries from that branch") is the same in either
 * case. So we treat any "previously seen, now gone" branch as a candidate
 * trigger and let the human-in-the-loop archive flow gate the actual cleanup.
 */
import fs from "node:fs";
import path from "node:path";
import { listLocalBranches } from "../utils/git-branches.js";

const STATE_FILE = ".last-known-branches.json";

export interface KnownBranchesState {
  recorded_at: string;
  branches: string[];
}

export interface BranchSweepResult {
  /** True on the very first run for a project — state file was just created. */
  initial_record: boolean;
  /** Current local branch list, sorted. */
  current_branches: string[];
  /** Branches present in the previous snapshot but absent now, sorted. */
  deleted_branches: string[];
  /** When the previous snapshot was taken (null on initial_record). */
  state_recorded_at: string | null;
  /** Whether branch enumeration succeeded. False = no-op (stat-quo state). */
  enumerated: boolean;
}

export function readKnownBranches(twiningDir: string): KnownBranchesState | null {
  const p = path.join(twiningDir, STATE_FILE);
  if (!fs.existsSync(p)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf-8")) as KnownBranchesState;
    if (!Array.isArray(parsed.branches) || typeof parsed.recorded_at !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeKnownBranches(twiningDir: string, branches: Set<string>): void {
  const state: KnownBranchesState = {
    recorded_at: new Date().toISOString(),
    branches: [...branches].sort(),
  };
  fs.writeFileSync(
    path.join(twiningDir, STATE_FILE),
    JSON.stringify(state, null, 2),
    "utf-8",
  );
}

/**
 * Diff current branches against the recorded snapshot. The state file is
 * updated only when `commit: true` — preview passes ({ execute: false } in
 * housekeeping) compute the diff but leave the snapshot untouched, otherwise
 * a dry-run would silently advance the baseline and consume deletions
 * before the user has a chance to act on them.
 *
 * - First-ever run, commit=true: writes the snapshot, initial_record=true, no deletions.
 * - First-ever run, commit=false: still reports initial_record=true (so callers
 *   know there's no prior baseline) but does NOT write the file.
 * - Subsequent run with no changes: returns empty deletion set.
 * - Subsequent run with deletions: returns the deleted branches.
 * - Branch enumeration failure (non-git, git missing): returns enumerated=false
 *   without touching the state file.
 */
export function detectDeletedBranches(
  twiningDir: string,
  projectRoot: string,
  commit: boolean = true,
): BranchSweepResult {
  const current = listLocalBranches(projectRoot);
  if (current === null) {
    return {
      initial_record: false,
      current_branches: [],
      deleted_branches: [],
      state_recorded_at: null,
      enumerated: false,
    };
  }

  const previous = readKnownBranches(twiningDir);
  if (previous === null) {
    if (commit) writeKnownBranches(twiningDir, current);
    return {
      initial_record: true,
      current_branches: [...current].sort(),
      deleted_branches: [],
      state_recorded_at: null,
      enumerated: true,
    };
  }

  const previousSet = new Set(previous.branches);
  const deleted = [...previousSet].filter((b) => !current.has(b)).sort();
  if (commit) writeKnownBranches(twiningDir, current);

  return {
    initial_record: false,
    current_branches: [...current].sort(),
    deleted_branches: deleted,
    state_recorded_at: previous.recorded_at,
    enumerated: true,
  };
}
