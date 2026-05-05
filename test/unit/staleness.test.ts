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

  it("scores 1.0 when scope path is missing", () => {
    const r = scoreItem(
      { scope: "removed-dir/", affected_files: [], provenance: { branch: "main" } },
      { ...allKnownProbes, scopePathExists: () => false },
    );
    expect(r.score).toBe(1.0);
    expect(r.reasons[0]?.signal).toBe("scope_path_missing");
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

  it("scores 1.0 when branch is gone", () => {
    const r = scoreItem(
      { scope: "src/auth/", affected_files: [], provenance: { branch: "feature/x" } },
      { ...allKnownProbes, branchKnown: () => false },
    );
    expect(r.score).toBe(1.0);
    expect(r.reasons[0]?.signal).toBe("branch_gone");
  });

  it("takes max() across signals — multiple weak signals don't compound", () => {
    const r = scoreItem(
      {
        scope: "src/auth/",
        affected_files: ["a.ts", "b.ts"],
        provenance: { branch: "feature/x" },
      },
      {
        scopePathExists: () => true,
        fileExists: (f: string) => f === "a.ts", // 1/2 missing → 0.5
        branchKnown: () => false,                 // 1.0
      },
    );
    expect(r.score).toBe(1.0); // max, not 0.5 + 1.0
    expect(r.reasons.length).toBe(2);
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
      makeDecision("d2", "src/gone/", { branch: "main" }, []),                     // scope missing
      makeDecision("d3", "src/kept/", { branch: "feature/dead" }, []),             // branch gone
    ];
    const entries: BlackboardEntry[] = [
      makeEntry("e1", "project", { branch: "main" }),                              // no signals
    ];

    const result = auditStaleness(decisions, entries, {
      threshold: 0.95,
      projectRoot: dir,
    });

    const ids = result.candidates.map((c) => c.id);
    expect(ids).toContain("d2");
    expect(ids).toContain("d3");
    expect(ids).not.toContain("d1");
    expect(ids).not.toContain("e1");
    expect(result.candidates[0]!.score).toBeGreaterThanOrEqual(result.candidates[1]!.score);
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
