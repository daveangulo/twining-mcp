/**
 * Staleness detection — scores blackboard entries and decisions on three
 * deterministic signals:
 *
 *   1. scope_path_missing — scope looks like a file/dir path and no longer exists.
 *   2. affected_files_missing — proportion of an entry's affected_files no longer on disk.
 *   3. branch_gone — provenance.branch is no longer in the local git ref list
 *      (i.e. branch was deleted, typically after merge).
 *
 * Final score is max() of the three signals; an entry is flagged when the score
 * crosses a configurable threshold (default 0.95). Items with no checkable
 * signals (scope=="project", no affected_files, no provenance) score 0 and are
 * never flagged.
 *
 * Semantic-content review (LLM-judged "Wave 3 / HMS Lancaster" cases) is out
 * of scope here — see follow-up issue.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { BlackboardEntry, Decision } from "../utils/types.js";

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
      score: 1.0,
      detail: `scope "${item.scope}" no longer exists on disk`,
    });
  }

  // Signal 2: affected files missing (proportion)
  if (item.affected_files && item.affected_files.length > 0) {
    const missing = item.affected_files.filter((f) => !probes.fileExists(f));
    if (missing.length > 0) {
      const proportion = missing.length / item.affected_files.length;
      reasons.push({
        signal: "affected_files_missing",
        score: proportion,
        detail: `${missing.length}/${item.affected_files.length} affected files missing: ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ", …" : ""}`,
      });
    }
  }

  // Signal 3: branch gone
  if (item.provenance?.branch && !probes.branchKnown(item.provenance.branch)) {
    reasons.push({
      signal: "branch_gone",
      score: 1.0,
      detail: `originating branch "${item.provenance.branch}" no longer exists`,
    });
  }

  const score = reasons.length > 0
    ? Math.max(...reasons.map((r) => r.score))
    : 0;
  return { score, reasons };
}

/** Build the three probes for a real project root. Cheap one-shot setup. */
export function buildProbes(projectRoot: string): {
  scopePathExists: (scope: string) => boolean | null;
  fileExists: (file: string) => boolean;
  branchKnown: (branch: string) => boolean;
} {
  const knownBranches = listLocalBranches(projectRoot);

  return {
    scopePathExists: (scope: string) => {
      if (!scope || scope === "project" || scope === "global") return null;
      // Heuristic: a "path-like" scope contains "/" or matches a real entry on disk.
      // Strings like "architecture" or "implementation" are categorical, not paths — return null.
      const looksLikePath = scope.includes("/") || scope.includes(".");
      if (!looksLikePath) return null;
      const candidate = scope.endsWith("/") ? scope.slice(0, -1) : scope;
      return fs.existsSync(path.join(projectRoot, candidate));
    },
    fileExists: (file: string) => {
      if (!file) return true;
      return fs.existsSync(path.join(projectRoot, file));
    },
    branchKnown: (branch: string) => knownBranches.has(branch),
  };
}

function listLocalBranches(projectRoot: string): Set<string> {
  try {
    const out = execFileSync(
      "git",
      ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
      {
        cwd: projectRoot,
        encoding: "utf-8",
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    return new Set(
      out
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
    );
  } catch {
    // Not a git repo or git unavailable — return empty set, branch_gone never fires.
    return new Set();
  }
}

export function auditStaleness(
  decisions: Decision[],
  blackboardEntries: BlackboardEntry[],
  options: StalenessAuditOptions,
): StalenessAuditResult {
  // If no probes can fire (not a git repo, no FS), still score deterministic
  // signals. branch_gone naturally returns false when the known set is empty
  // because we treat empty as "can't tell" — adjust below.
  const probes = buildProbes(options.projectRoot);
  const knownBranchesEmpty = probes.branchKnown("__sentinel_does_not_exist__") === false
    && !probes.branchKnown(decisions[0]?.provenance?.branch ?? "")
    && !decisions.some((d) => d.provenance?.branch && probes.branchKnown(d.provenance.branch));
  // If branch listing failed, neutralize the branch_gone signal so we don't
  // false-flag every provenance-stamped entry.
  const safeProbes = {
    ...probes,
    branchKnown: knownBranchesEmpty
      ? () => true // can't check → assume known (no false flag)
      : probes.branchKnown,
  };

  const candidates: StaleItem[] = [];

  for (const d of decisions) {
    const { score, reasons } = scoreItem(d, safeProbes);
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
      safeProbes,
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
