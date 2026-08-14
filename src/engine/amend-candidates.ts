/**
 * Amend-candidates reporter — the re-scoped field D13 ask 1, in the shape
 * the field's measurements dictated: commit-provenance derivation is dead
 * (their 1:1 bail fires on 96% of the backlog; provenance yields the files
 * a session TOUCHED, not the files a decision GOVERNS), so this pass only
 * PROPOSES candidates by scope enumeration + term overlap, for per-record
 * confirmation through twining_amend. It is report-only by construction —
 * there is no execute mode, matching the entity-scope-repair
 * opt-in-housekeeping precedent but stricter: proposals are never written.
 */
import fs from "node:fs";
import path from "node:path";
import type { IDecisionStore } from "../storage/interfaces.js";

/** Empty-list decisions examined per run — beyond this, counted as truncated. */
const MAX_DECISIONS = 50;
/** Files walked per scope — beyond this, the scope's walk stops (noted). */
const MAX_FILES_PER_SCOPE = 500;
/** Candidates reported per decision. */
const MAX_CANDIDATES = 5;

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".twining",
  "dist",
  "build",
  "coverage",
]);

const STOPWORDS = new Set([
  "the", "and", "for", "with", "over", "into", "from", "that", "this",
  "not", "are", "was", "use", "chose", "instead",
]);

export interface AmendCandidateReport {
  /** Empty-affected_files active decisions actually examined. */
  decisions_scanned: number;
  /** Examined decisions beyond MAX_DECISIONS — rerun after amending to reach them. */
  decisions_truncated: number;
  /** Skipped: scope "project" enumerates the whole repo and cannot be ranked honestly. */
  skipped_project_scope: number;
  /** Skipped: the scope path does not exist under the project root. */
  scope_missing: number;
  decisions_with_candidates: Array<{
    id: string;
    summary: string;
    scope: string;
    status: string;
    candidates: Array<{ file: string; overlap: number }>;
    /** Set when the scope walk hit MAX_FILES_PER_SCOPE — ranking saw a subset. */
    walk_truncated?: boolean;
  }>;
  note: string;
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3 && !STOPWORDS.has(t)),
  );
}

function walkFiles(dir: string, cap: number): { files: string[]; truncated: boolean } {
  const files: string[] = [];
  let truncated = false;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (files.length >= cap) {
        truncated = true;
        return { files, truncated };
      }
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(full);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  }
  return { files, truncated };
}

/**
 * Report candidate affected_files for active decisions whose list is empty.
 * Pure read — the write path is twining_amend, per record, after human or
 * agent confirmation.
 */
export async function reportAmendCandidates(
  decisionStore: IDecisionStore,
  projectRoot: string,
): Promise<AmendCandidateReport> {
  const index = await decisionStore.getIndex();
  const empties = index.filter(
    (e) => e.status === "active" && e.affected_files.length === 0,
  );

  const report: AmendCandidateReport = {
    decisions_scanned: 0,
    decisions_truncated: 0,
    skipped_project_scope: 0,
    scope_missing: 0,
    decisions_with_candidates: [],
    note:
      "Report-only: nothing was written. Confirm per record with twining_amend({decision_id, add_affected_files}) — candidates are term-overlap guesses over the scope tree, not assertions.",
  };

  const projectScoped = empties.filter((e) => e.scope === "project");
  report.skipped_project_scope = projectScoped.length;
  const scannable = empties.filter((e) => e.scope !== "project");
  const toScan = scannable.slice(0, MAX_DECISIONS);
  report.decisions_truncated = scannable.length - toScan.length;

  for (const entry of toScan) {
    const scopePath = path.join(projectRoot, entry.scope);
    // A file-like scope is its own best candidate when it exists.
    let stat: fs.Stats | null = null;
    try {
      stat = fs.statSync(scopePath);
    } catch {
      report.scope_missing++;
      report.decisions_scanned++;
      continue;
    }
    report.decisions_scanned++;

    const decision = await decisionStore.get(entry.id);
    const decisionTokens = tokenize(
      `${entry.summary} ${decision?.rationale ?? ""}`,
    );

    let files: string[];
    let walkTruncated = false;
    if (stat.isFile()) {
      files = [scopePath];
    } else {
      const walked = walkFiles(scopePath, MAX_FILES_PER_SCOPE);
      files = walked.files;
      walkTruncated = walked.truncated;
    }

    const scored = files
      .map((f) => {
        const rel = path.relative(projectRoot, f);
        const overlap = [...tokenize(rel)].filter((t) =>
          decisionTokens.has(t),
        ).length;
        return { file: rel, overlap };
      })
      .filter((c) => c.overlap > 0)
      .sort((a, b) => b.overlap - a.overlap || a.file.localeCompare(b.file))
      .slice(0, MAX_CANDIDATES);

    if (scored.length > 0) {
      report.decisions_with_candidates.push({
        id: entry.id,
        summary: entry.summary,
        scope: entry.scope,
        status: entry.status,
        candidates: scored,
        ...(walkTruncated ? { walk_truncated: true } : {}),
      });
    }
  }

  return report;
}
