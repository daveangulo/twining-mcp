/**
 * Gap 5 — staleness scoring is blind to remote/social liveness signals.
 * Requirements R04, R12. Baseline reproduction (no source changes).
 *
 * src/engine/staleness.ts scores on three purely LOCAL, filesystem/git-local
 * signals: scope_path_missing, affected_files_missing, branch_gone. There is
 * no signal derived from remote state — no open/merged PR touching the scope,
 * no review or acceptance event, no upstream activity. Consequence: a decision
 * whose scope directory, affected file and provenance branch all still exist
 * locally scores exactly 0 and carries zero reasons, regardless of what has
 * happened to it remotely (superseded by a merged PR, rejected in review,
 * never accepted). The scorer has nothing to say about it.
 *
 * Instrument proof (positive control): deleting the affected file makes the
 * same scorer, on the same repo, produce a non-zero score with a reason — so a
 * 0 in the gap assertions is the scorer finding nothing to report, not a dead
 * harness.
 *
 * Setup idioms (mkRepo, tmpdir + afterEach rmSync, buildProbes/scoreItem/
 * auditStaleness usage, makeDecision shape) mirror test/unit/staleness.test.ts.
 */
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scoreItem, buildProbes, auditStaleness } from "../../../src/engine/staleness";
import type { Decision } from "../../../src/utils/types";

/** The three signals the baseline scorer knows about — all local. */
const LOCAL_SIGNALS = [
  "scope_path_missing",
  "affected_files_missing",
  "branch_gone",
] as const;

/** Vocabulary a remote PR / review / acceptance signal would have to use. */
const REMOTE_SIGNAL_VOCABULARY =
  /\b(pr|pull_request|review|reviewed|approv|accept|merged|remote|upstream|ci)\b/i;

describe("gap 5 — staleness has no remote PR/review/acceptance signal", () => {
  let dir: string;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  function mkRepo(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "twining-gap5-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: d });
    execFileSync("git", ["config", "user.email", "t@x"], { cwd: d });
    execFileSync("git", ["config", "user.name", "t"], { cwd: d });
    execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: d });
    execFileSync("git", ["commit", "-q", "-m", "init", "--allow-empty"], { cwd: d });
    return d;
  }

  /**
   * A repo where every LOCAL liveness signal for the decision below is green:
   * scope dir `src/auth/` exists, affected file `src/auth/handler.ts` exists
   * and is tracked, provenance branch `main` exists.
   */
  function mkLiveRepo(): string {
    const d = mkRepo();
    fs.mkdirSync(path.join(d, "src", "auth"), { recursive: true });
    fs.writeFileSync(path.join(d, "src", "auth", "handler.ts"), "export const handler = 1;\n");
    // A second tracked file so the scope directory survives a later `git rm`.
    fs.writeFileSync(path.join(d, "src", "auth", "keep.ts"), "export const keep = 1;\n");
    execFileSync("git", ["add", "-A"], { cwd: d });
    execFileSync("git", ["commit", "-q", "-m", "add auth"], { cwd: d });
    return d;
  }

  const decision: Decision = makeDecision(
    "d-remote-only-rot",
    "src/auth/",
    { branch: "main" },
    ["src/auth/handler.ts"],
  );

  it("POSITIVE CONTROL: removing the affected file makes the scorer fire (score > 0)", () => {
    dir = mkLiveRepo();
    // Delete the file and drop it from the index — a genuinely gone file, not
    // a git-mv'd one (its basename no longer survives in `git ls-files`).
    execFileSync("git", ["rm", "-q", "src/auth/handler.ts"], { cwd: dir });

    const { score, reasons } = scoreItem(decision, buildProbes(dir));

    expect(score).toBeGreaterThan(0);
    expect(reasons.map((r) => r.signal)).toEqual(["affected_files_missing"]);
    // And it surfaces end to end through the audit at the default threshold.
    const audit = auditStaleness([decision], [], { threshold: 0.95, projectRoot: dir });
    expect(audit.candidates.map((c) => c.id)).toEqual(["d-remote-only-rot"]);
  });

  it("GAP: an all-local-green decision scores exactly 0 with no reasons", () => {
    dir = mkLiveRepo();
    const probes = buildProbes(dir);

    // Pin that each local probe really is green (so the 0 below is "nothing to
    // say", not "probes broken").
    expect(probes.scopePathExists("src/auth/")).toBe(true);
    expect(probes.fileExists("src/auth/handler.ts")).toBe(true);
    expect(probes.branchKnown("main")).toBe(true);

    const { score, reasons } = scoreItem(decision, probes);

    // No remote signal exists to contribute evidence, so the score floors at 0
    // no matter what happened to this decision off-disk.
    expect(score).toBe(0);
    expect(reasons).toEqual([]);

    // End to end: nothing is ever a candidate, at any threshold, because
    // auditStaleness also requires reasons.length > 0.
    expect(
      auditStaleness([decision], [], { threshold: 0, projectRoot: dir }).candidates,
    ).toEqual([]);
  });

  it("GAP: the scorer's entire signal vocabulary is the three local signals", () => {
    dir = mkLiveRepo();

    // Runtime: drive every probe to its failing state — this emits the
    // exhaustive set of signals the scorer is capable of producing.
    const allMissing = scoreItem(
      {
        scope: "gone/",
        affected_files: ["gone/a.ts"],
        provenance: { branch: "feature/dead" },
      },
      {
        scopePathExists: () => false,
        fileExists: () => false,
        branchKnown: () => false,
      },
    );
    const emitted = allMissing.reasons.map((r) => r.signal).sort();
    expect(emitted).toEqual([...LOCAL_SIGNALS].sort());

    // Static: the exported StalenessReason union names exactly those three —
    // no remote/PR/review/acceptance member exists to be emitted.
    const srcPath = fileURLToPath(
      new URL("../../../src/engine/staleness.ts", import.meta.url),
    );
    const src = fs.readFileSync(srcPath, "utf-8");
    const union = src.match(/interface\s+StalenessReason\s*\{[\s\S]*?signal:\s*([^;]+);/);
    expect(union).not.toBeNull();
    const declared = union![1]!
      .split("|")
      .map((s) => s.trim().replace(/^"|"$/g, ""))
      .filter((s) => s.length > 0)
      .sort();
    expect(declared).toEqual([...LOCAL_SIGNALS].sort());
    for (const name of declared) {
      expect(name).not.toMatch(REMOTE_SIGNAL_VOCABULARY);
    }
  });
});

function makeDecision(
  id: string,
  scope: string,
  provenance: { branch?: string; commit_sha?: string },
  affected_files: string[],
): Decision {
  return {
    id,
    timestamp: new Date().toISOString(),
    agent_id: "main",
    domain: "test",
    scope,
    summary: `${id} summary`,
    context: "ctx",
    rationale: "r",
    constraints: [],
    alternatives: [],
    depends_on: [],
    confidence: "medium",
    status: "active",
    reversible: true,
    affected_files,
    affected_symbols: [],
    commit_hashes: [],
    provenance: { recorded_at: new Date().toISOString(), ...provenance },
  };
}
