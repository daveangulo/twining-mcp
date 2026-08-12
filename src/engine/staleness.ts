/**
 * Staleness detection — scores blackboard entries and decisions on three
 * deterministic signals:
 *
 *   1. scope_path_missing (0.8) — no path-like segment of the scope exists on
 *      disk. Scopes are free text in the field: compound lists
 *      ("specs/ + rfcs/", "rfcs/, specs/x/"), section refs ("spec.md §2.7"),
 *      and multi-path strings are split and probed per segment.
 *   2. affected_files_missing (proportion) — share of an entry's
 *      affected_files no longer resolvable. A file whose basename still
 *      exists in the git index counts as present (git-mv'd, not gone).
 *   3. branch_gone (0.4) — provenance.branch is no longer in refs/heads.
 *      Deliberately weak: post-merge branch deletion is normal hygiene and
 *      says nothing about content liveness; merge_sweep is the sanctioned,
 *      human-gated flow for branch-deletion cleanup.
 *
 * Signals combine by noisy-or (1 − Π(1−sᵢ)) so independent evidence
 * corroborates, and NO single heuristic can reach 1.0 by construction —
 * a lone heuristic firing must never read as certainty (field defect D3:
 * a uniform wall of 1.0 scores invited a bulk archive that would have
 * silently blinded assemble/why on live decisions). With the default 0.95
 * threshold, only a near-total affected_files miss or corroborated signals
 * can flag an item. Items with no checkable signals score 0.
 *
 * Semantic-content review (LLM-judged "Wave 3 / HMS Lancaster" cases) is out
 * of scope here — see follow-up issue.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { BlackboardEntry, Decision } from "../utils/types.js";
import { listLocalBranches } from "../utils/git-branches.js";

const SCOPE_PATH_MISSING_SCORE = 0.8;
const BRANCH_GONE_SCORE = 0.4;

export interface StalenessReason {
  signal: "scope_path_missing" | "affected_files_missing" | "branch_gone";
  score: number;
  detail: string;
}

export interface StaleItem {
  id: string;
  kind: "decision" | "blackboard";
  summary: string;
  scope: string;
  score: number;
  reasons: StalenessReason[];
  branch?: string;
  commit_sha?: string;
  recorded_at?: string;
}

export interface StalenessAuditOptions {
  threshold: number;
  projectRoot: string;
}

export interface StalenessAuditResult {
  threshold: number;
  candidates: StaleItem[];
}

/**
 * Score one decision or blackboard entry. Pure given probe results.
 * Exported for unit testing without filesystem.
 */
export function scoreItem(
  item: { scope: string; affected_files?: string[]; provenance?: { branch?: string } },
  probes: {
    scopePathExists: (scope: string) => boolean | null; // null = not a path
    fileExists: (file: string) => boolean;
    branchKnown: (branch: string) => boolean;
  },
): { score: number; reasons: StalenessReason[] } {
  const reasons: StalenessReason[] = [];

  // Signal 1: scope path missing
  const scopeProbe = probes.scopePathExists(item.scope);
  if (scopeProbe === false) {
    reasons.push({
      signal: "scope_path_missing",
      score: SCOPE_PATH_MISSING_SCORE,
      detail: `no path-like segment of scope "${item.scope}" exists on disk`,
    });
  }

  // Signal 2: affected files missing (proportion, capped below certainty —
  // an existsSync+basename miss is still a heuristic, never proof)
  if (item.affected_files && item.affected_files.length > 0) {
    const missing = item.affected_files.filter((f) => !probes.fileExists(f));
    if (missing.length > 0) {
      const proportion = missing.length / item.affected_files.length;
      reasons.push({
        signal: "affected_files_missing",
        score: Math.min(proportion, 0.95),
        detail: `${missing.length}/${item.affected_files.length} affected files missing: ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ", …" : ""}`,
      });
    }
  }

  // Signal 3: branch gone — corroborating evidence only, never decisive
  if (item.provenance?.branch && !probes.branchKnown(item.provenance.branch)) {
    reasons.push({
      signal: "branch_gone",
      score: BRANCH_GONE_SCORE,
      detail: `originating branch "${item.provenance.branch}" no longer exists (normal post-merge cleanup — corroborating signal only)`,
    });
  }

  // Noisy-or: independent signals corroborate; a single capped heuristic
  // can never reach the certainty band on its own. Two or more independent
  // structural signals ARE the corroboration this scoring demands, so a
  // corroborated item is lifted to the flaggable band — without this,
  // blackboard entries (which have no affected_files field) topped out at
  // 1−(0.2·0.6)=0.88 < 0.95 and could NEVER be flagged (review finding),
  // while pre-D3 they flagged on any single signal. Still capped below 1.0:
  // heuristics never emit certainty.
  const noisyOr =
    reasons.length > 0
      ? 1 - reasons.reduce((acc, r) => acc * (1 - r.score), 1)
      : 0;
  const score = reasons.length >= 2 ? Math.max(noisyOr, 0.95) : noisyOr;
  return { score, reasons };
}

/**
 * Split a free-text scope into probeable path segments. Field scopes are
 * compound ("specs/ + rfcs/", "rfcs/, specs/x/", ".github/workflows/ tools/")
 * and carry section refs ("spec.md §2.7") — statting the whole string as one
 * path is guaranteed-false. Exported for unit testing.
 */
export function splitScopeSegments(scope: string): string[] {
  return scope
    .split(/[,+]|\s+/)
    .map((s) => s.replace(/§.*$/, "").trim())
    .filter((s) => s.length > 0);
}

/** Build the three probes for a real project root. Cheap one-shot setup. */
export function buildProbes(projectRoot: string): {
  scopePathExists: (scope: string) => boolean | null;
  fileExists: (file: string) => boolean;
  branchKnown: (branch: string) => boolean;
} {
  const knownBranches = listLocalBranches(projectRoot);
  // Distinguish "branch listing failed" (return null) from "listing succeeded
  // but returned empty" (legitimately empty repo). When listing fails the
  // probe always returns true so branch_gone never fires.
  const listingFailed = knownBranches === null;
  const branches = knownBranches ?? new Set<string>();

  // One-shot basename index of git-tracked files. A recorded affected_file
  // whose basename still exists in the index was moved (archive/
  // conventions, refactors), not destroyed — treating git-mv'd files as
  // missing inverted the signal: hygiene-compliant history read as rot.
  // The inference requires the basename to be UNIQUE in the index (review
  // finding): common names — index.ts, types.ts, README.md — match dozens
  // of unrelated survivors, which would mute the file signal permanently
  // for exactly the wholesale-deleted subsystems it exists to catch.
  // null = git unavailable → no fallback, existsSync alone decides.
  const basenameCounts: Map<string, number> | null = (() => {
    try {
      const out = execFileSync("git", ["ls-files", "-z"], {
        cwd: projectRoot,
        encoding: "utf-8",
        maxBuffer: 64 * 1024 * 1024,
      });
      const counts = new Map<string, number>();
      for (const f of out.split("\0")) {
        if (!f) continue;
        const base = path.basename(f);
        counts.set(base, (counts.get(base) ?? 0) + 1);
      }
      return counts;
    } catch {
      return null;
    }
  })();

  return {
    scopePathExists: (scope: string) => {
      if (!scope || scope === "project" || scope === "global") return null;
      const segments = splitScopeSegments(scope);
      // Categorical strings ("architecture") are not paths — return null.
      const pathLike = segments.filter(
        (s) => s.includes("/") || s.includes("."),
      );
      if (pathLike.length === 0) return null;
      // ANY existing segment proves the scope still points at something real.
      return pathLike.some((segment) => {
        const candidate = segment.endsWith("/")
          ? segment.slice(0, -1)
          : segment;
        return fs.existsSync(path.join(projectRoot, candidate));
      });
    },
    fileExists: (file: string) => {
      if (!file) return true;
      if (fs.existsSync(path.join(projectRoot, file))) return true;
      // Moved-not-gone: basename survives UNIQUELY in the git index.
      return basenameCounts !== null
        ? basenameCounts.get(path.basename(file)) === 1
        : false;
    },
    branchKnown: (branch: string) =>
      listingFailed ? true : branches.has(branch),
  };
}

export function auditStaleness(
  decisions: Decision[],
  blackboardEntries: BlackboardEntry[],
  options: StalenessAuditOptions,
): StalenessAuditResult {
  const probes = buildProbes(options.projectRoot);
  const candidates: StaleItem[] = [];

  for (const d of decisions) {
    const { score, reasons } = scoreItem(d, probes);
    if (score >= options.threshold && reasons.length > 0) {
      const item: StaleItem = {
        id: d.id,
        kind: "decision",
        summary: d.summary,
        scope: d.scope,
        score,
        reasons,
      };
      if (d.provenance?.branch) item.branch = d.provenance.branch;
      if (d.provenance?.commit_sha) item.commit_sha = d.provenance.commit_sha;
      if (d.provenance?.recorded_at) item.recorded_at = d.provenance.recorded_at;
      candidates.push(item);
    }
  }

  for (const e of blackboardEntries) {
    const { score, reasons } = scoreItem(
      { scope: e.scope, provenance: e.provenance },
      probes,
    );
    if (score >= options.threshold && reasons.length > 0) {
      const item: StaleItem = {
        id: e.id,
        kind: "blackboard",
        summary: e.summary,
        scope: e.scope,
        score,
        reasons,
      };
      if (e.provenance?.branch) item.branch = e.provenance.branch;
      if (e.provenance?.commit_sha) item.commit_sha = e.provenance.commit_sha;
      if (e.provenance?.recorded_at) item.recorded_at = e.provenance.recorded_at;
      candidates.push(item);
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  return { threshold: options.threshold, candidates };
}
