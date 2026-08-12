import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scoreItem, buildProbes, auditStaleness } from "../../src/engine/staleness";
import type { Decision, BlackboardEntry } from "../../src/utils/types";

describe("scoreItem", () => {
  const allKnownProbes = {
    scopePathExists: () => true,
    fileExists: () => true,
    branchKnown: () => true,
  };
  const allMissingProbes = {
    scopePathExists: () => false,
    fileExists: () => false,
    branchKnown: () => false,
  };

  it("scores 0 when all signals are healthy", () => {
    const r = scoreItem(
      { scope: "src/auth/", affected_files: ["src/auth/x.ts"], provenance: { branch: "main" } },
      allKnownProbes,
    );
    expect(r.score).toBe(0);
    expect(r.reasons).toEqual([]);
  });

  it("caps scope_path_missing at 0.8 — a lone heuristic must not read as certainty (D3)", () => {
    const r = scoreItem(
      { scope: "removed-dir/", affected_files: [], provenance: { branch: "main" } },
      { ...allKnownProbes, scopePathExists: () => false },
    );
    expect(r.score).toBeCloseTo(0.8);
    expect(r.reasons[0]?.signal).toBe("scope_path_missing");
    // Below the default 0.95 threshold: cannot flag alone.
    expect(r.score).toBeLessThan(0.95);
  });

  it("scores by proportion when only some affected_files are missing", () => {
    const r = scoreItem(
      {
        scope: "src/auth/",
        affected_files: ["a.ts", "b.ts", "c.ts", "d.ts"],
        provenance: { branch: "main" },
      },
      {
        ...allKnownProbes,
        fileExists: (f: string) => f === "a.ts" || f === "b.ts",
      },
    );
    expect(r.score).toBeCloseTo(0.5);
    expect(r.reasons[0]?.signal).toBe("affected_files_missing");
  });

  it("caps branch_gone at 0.4 — post-merge deletion is hygiene, not content rot (D3)", () => {
    const r = scoreItem(
      { scope: "src/auth/", affected_files: [], provenance: { branch: "feature/x" } },
      { ...allKnownProbes, branchKnown: () => false },
    );
    expect(r.score).toBeCloseTo(0.4);
    expect(r.reasons[0]?.signal).toBe("branch_gone");
  });

  it("two independent signals corroborate into the flaggable band (max(noisy-or, 0.95))", () => {
    const r = scoreItem(
      {
        scope: "src/auth/",
        affected_files: ["a.ts", "b.ts"],
        provenance: { branch: "feature/x" },
      },
      {
        scopePathExists: () => true,
        fileExists: (f: string) => f === "a.ts", // 1/2 missing → 0.5
        branchKnown: () => false,                 // 0.4
      },
    );
    // noisy-or would be 0.7; corroboration (2+ signals) lifts to 0.95 —
    // without this, blackboard entries (no affected_files field) could
    // never reach the default threshold at all.
    expect(r.score).toBeCloseTo(0.95);
    expect(r.score).toBeLessThan(1.0);
    expect(r.reasons.length).toBe(2);
  });

  it("a blackboard-shaped item (scope + branch only) flags when both signals fire", () => {
    const r = scoreItem(
      { scope: "analysis/gone/", provenance: { branch: "worktree-dead" } },
      allMissingProbes,
    );
    expect(r.score).toBeCloseTo(0.95);
    expect(r.score).toBeGreaterThanOrEqual(0.95);
  });

  it("caps affected_files_missing at 0.95 — no heuristic ever emits 1.0 (D3)", () => {
    const r = scoreItem(
      { scope: "src/auth/", affected_files: ["a.ts", "b.ts"], provenance: { branch: "main" } },
      { ...allKnownProbes, fileExists: () => false },
    );
    expect(r.score).toBeCloseTo(0.95);
    expect(r.score).toBeLessThan(1.0);
  });

  it("corroborated signals cross the 0.95 threshold; no combination reaches exactly 1.0", () => {
    const r = scoreItem(
      {
        scope: "gone/",
        affected_files: ["a.ts"],
        provenance: { branch: "feature/x" },
      },
      allMissingProbes,
    );
    // 1 − (1−0.8)(1−0.95)(1−0.4) = 0.994
    expect(r.score).toBeGreaterThan(0.95);
    expect(r.score).toBeLessThan(1.0);
  });

  it("scores 0 when scope is 'project' (categorical, not a path)", () => {
    const r = scoreItem(
      { scope: "project", affected_files: [], provenance: { branch: "main" } },
      { scopePathExists: () => null, fileExists: () => true, branchKnown: () => true },
    );
    expect(r.score).toBe(0);
    expect(r.reasons).toEqual([]);
  });

  it("scores 0 when item has no signals at all (no affected_files, no provenance, scope=project)", () => {
    const r = scoreItem(
      { scope: "project" },
      { scopePathExists: () => null, fileExists: () => true, branchKnown: () => true },
    );
    expect(r.score).toBe(0);
  });
});

describe("buildProbes — real filesystem & git", () => {
  let dir: string;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  function mkRepo(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "twining-staleness-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: d });
    execFileSync("git", ["config", "user.email", "t@x"], { cwd: d });
    execFileSync("git", ["config", "user.name", "t"], { cwd: d });
    execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: d });
    execFileSync("git", ["commit", "-q", "-m", "init", "--allow-empty"], { cwd: d });
    return d;
  }

  it("scope_path_missing: detects deleted directories", () => {
    dir = mkRepo();
    fs.mkdirSync(path.join(dir, "src", "auth"), { recursive: true });
    const probes = buildProbes(dir);
    expect(probes.scopePathExists("src/auth/")).toBe(true);
    expect(probes.scopePathExists("src/gone/")).toBe(false);
    expect(probes.scopePathExists("project")).toBe(null);
    expect(probes.scopePathExists("architecture")).toBe(null);
  });

  it("compound scopes: probes per segment instead of statting the whole string (D3 field cases)", () => {
    dir = mkRepo();
    fs.mkdirSync(path.join(dir, "specs", "claim-machinery"), { recursive: true });
    fs.mkdirSync(path.join(dir, "rfcs"), { recursive: true });
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true });
    fs.writeFileSync(path.join(dir, "specs", "claim-machinery", "spec.md"), "x");
    const probes = buildProbes(dir);

    // The four verbatim field false positives — every one must now resolve.
    expect(probes.scopePathExists("specs/ + rfcs/")).toBe(true);
    expect(probes.scopePathExists("rfcs/, specs/claim-machinery/")).toBe(true);
    expect(probes.scopePathExists("specs/claim-machinery/spec.md §2.7")).toBe(true);
    expect(probes.scopePathExists(".github/workflows/ tools/ tests/")).toBe(true);

    // All segments genuinely gone still reads missing.
    expect(probes.scopePathExists("vanished/ + also-gone/")).toBe(false);
    // Purely categorical compound stays null.
    expect(probes.scopePathExists("architecture design")).toBe(null);
  });

  it("fileExists: a git-mv'd file (basename survives in the index) counts as present (D3)", () => {
    dir = mkRepo();
    fs.mkdirSync(path.join(dir, "analysis", "scratch", "archive"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "analysis", "scratch", "archive", "epistemic-steelman.md"),
      "moved here",
    );
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "add"], { cwd: dir });
    const probes = buildProbes(dir);

    // Recorded at the old location; moved to archive/ per repo convention.
    expect(probes.fileExists("analysis/scratch/epistemic-steelman.md")).toBe(true);
    // Genuinely deleted file is still missing.
    expect(probes.fileExists("analysis/scratch/never-existed.md")).toBe(false);
  });

  it("fileExists: the moved-not-gone inference requires a UNIQUE basename — common names stay missing", () => {
    dir = mkRepo();
    // Two surviving index.ts files elsewhere in the repo.
    fs.mkdirSync(path.join(dir, "src", "auth"), { recursive: true });
    fs.mkdirSync(path.join(dir, "src", "billing"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "auth", "index.ts"), "a");
    fs.writeFileSync(path.join(dir, "src", "billing", "index.ts"), "b");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "add"], { cwd: dir });
    const probes = buildProbes(dir);

    // A deleted subsystem's index.ts must NOT read as "moved" just because
    // unrelated index.ts files survive — that would permanently mute the
    // file signal for exactly the wholesale-deleted dirs it exists to catch.
    expect(probes.fileExists("src/payments/index.ts")).toBe(false);
  });

  it("branch_gone: detects deleted branches", () => {
    dir = mkRepo();
    execFileSync("git", ["branch", "feature/keep"], { cwd: dir });
    const probes = buildProbes(dir);
    expect(probes.branchKnown("main")).toBe(true);
    expect(probes.branchKnown("feature/keep")).toBe(true);
    expect(probes.branchKnown("feature/gone")).toBe(false);
  });
});

describe("auditStaleness — end to end", () => {
  let dir: string;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("flags only items past threshold, sorted by score desc", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-audit-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@x"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "init", "--allow-empty"], { cwd: dir });
    fs.mkdirSync(path.join(dir, "src", "kept"), { recursive: true });

    const decisions: Decision[] = [
      makeDecision("d1", "src/kept/", { branch: "main" }, []),
      // scope missing (0.8) + branch gone (0.4): corroborated pair → 0.95, flagged
      makeDecision("d2", "src/gone/", { branch: "feature/dead" }, []),
      // scope missing + all files missing + branch gone → 0.994: flagged
      makeDecision("d3", "src/gone/", { branch: "feature/dead" }, [
        "src/gone/a.ts",
        "src/gone/b.ts",
      ]),
      // single weak signal (branch gone, 0.4): far below threshold
      makeDecision("d4", "src/kept/", { branch: "feature/dead" }, []),
    ];
    const entries: BlackboardEntry[] = [
      makeEntry("e1", "project", { branch: "main" }),                              // no signals
    ];

    const result = auditStaleness(decisions, entries, {
      threshold: 0.95,
      projectRoot: dir,
    });

    const ids = result.candidates.map((c) => c.id);
    expect(ids).toEqual(["d3", "d2"]); // sorted by score desc
    expect(result.candidates[0]!.score).toBeGreaterThan(0.95);
    expect(result.candidates[0]!.score).toBeLessThan(1.0);
    expect(result.candidates[1]!.score).toBeCloseTo(0.95);
  });

  it("does not flag branch_gone when listing branches fails (non-git dir)", () => {
    // Use a dir without git init so listLocalBranches returns empty set.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-audit-nogit-"));
    const decisions: Decision[] = [
      makeDecision("d1", "project", { branch: "anything" }, []),
    ];
    const result = auditStaleness(decisions, [], {
      threshold: 0.95,
      projectRoot: dir,
    });
    // branch_gone is neutralized when we can't enumerate branches.
    expect(result.candidates).toEqual([]);
  });

  it("flags branch_gone for blackboard entries even when no decisions are passed (regression)", () => {
    // Pre-fix bug: knownBranchesEmpty heuristic mis-fired on empty decisions[]
    // and silently neutralized branch_gone for all blackboard entries in a
    // healthy git repo. A blackboard-only audit must still detect dead branches.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-audit-bb-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@x"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "init", "--allow-empty"], { cwd: dir });
    // Repo has only `main`; entry references a branch that doesn't exist.

    const entries: BlackboardEntry[] = [
      makeEntry("e-dead-branch", "project", { branch: "feature/long-gone" }),
    ];

    // Threshold below the 0.4 branch_gone cap — this test pins that the
    // SIGNAL fires for blackboard-only audits, not that it flags at the
    // default threshold (it deliberately cannot, D3).
    const result = auditStaleness([], entries, {
      threshold: 0.3,
      projectRoot: dir,
    });
    expect(result.candidates.map((c) => c.id)).toEqual(["e-dead-branch"]);
    expect(result.candidates[0]!.reasons[0]?.signal).toBe("branch_gone");
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

function makeEntry(
  id: string,
  scope: string,
  provenance: { branch?: string; commit_sha?: string },
): BlackboardEntry {
  return {
    id,
    timestamp: new Date().toISOString(),
    agent_id: "main",
    entry_type: "status",
    tags: [],
    scope,
    summary: `${id} summary`,
    detail: "",
    provenance: { recorded_at: new Date().toISOString(), ...provenance },
  };
}
