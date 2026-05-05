import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  detectDeletedBranches,
  readKnownBranches,
} from "../../src/engine/branch-watcher";

let tmp: string;

afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

function makeRepo(): { project: string; twiningDir: string } {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "twining-bw-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: project });
  execFileSync("git", ["config", "user.email", "t@x"], { cwd: project });
  execFileSync("git", ["config", "user.name", "t"], { cwd: project });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: project });
  execFileSync("git", ["commit", "-q", "-m", "init", "--allow-empty"], {
    cwd: project,
  });
  const twiningDir = path.join(project, ".twining");
  fs.mkdirSync(twiningDir, { recursive: true });
  tmp = project;
  return { project, twiningDir };
}

describe("detectDeletedBranches", () => {
  it("first run records the initial snapshot and returns no deletions", () => {
    const { project, twiningDir } = makeRepo();
    execFileSync("git", ["branch", "feature/a"], { cwd: project });
    execFileSync("git", ["branch", "feature/b"], { cwd: project });

    const r = detectDeletedBranches(twiningDir, project);
    expect(r.initial_record).toBe(true);
    expect(r.enumerated).toBe(true);
    expect(r.deleted_branches).toEqual([]);
    expect(r.current_branches).toEqual(["feature/a", "feature/b", "main"]);
    expect(r.state_recorded_at).toBeNull();

    const state = readKnownBranches(twiningDir);
    expect(state).not.toBeNull();
    expect(state!.branches).toEqual(["feature/a", "feature/b", "main"]);
  });

  it("subsequent run with no changes returns empty deletions", () => {
    const { project, twiningDir } = makeRepo();
    detectDeletedBranches(twiningDir, project); // initial
    const r = detectDeletedBranches(twiningDir, project);
    expect(r.initial_record).toBe(false);
    expect(r.deleted_branches).toEqual([]);
    expect(r.state_recorded_at).not.toBeNull();
  });

  it("detects a branch that was previously known and is now gone", () => {
    const { project, twiningDir } = makeRepo();
    execFileSync("git", ["branch", "feature/short-lived"], { cwd: project });

    detectDeletedBranches(twiningDir, project); // record snapshot incl. feature/short-lived

    execFileSync("git", ["branch", "-D", "feature/short-lived"], {
      cwd: project,
    });

    const r = detectDeletedBranches(twiningDir, project);
    expect(r.initial_record).toBe(false);
    expect(r.deleted_branches).toEqual(["feature/short-lived"]);
    expect(r.current_branches).toEqual(["main"]);
  });

  it("does not flag newly-added branches", () => {
    const { project, twiningDir } = makeRepo();
    detectDeletedBranches(twiningDir, project); // initial: just main

    execFileSync("git", ["branch", "feature/new"], { cwd: project });
    const r = detectDeletedBranches(twiningDir, project);
    expect(r.deleted_branches).toEqual([]);
    expect(r.current_branches).toContain("feature/new");
  });

  it("returns enumerated=false in a non-git directory and does NOT touch state", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "twining-bw-nogit-"));
    fs.mkdirSync(path.join(tmp, ".twining"));
    const r = detectDeletedBranches(path.join(tmp, ".twining"), tmp);
    expect(r.enumerated).toBe(false);
    expect(r.initial_record).toBe(false);
    expect(r.deleted_branches).toEqual([]);
    // No state file should be created when enumeration fails.
    expect(
      fs.existsSync(path.join(tmp, ".twining", ".last-known-branches.json")),
    ).toBe(false);
  });

  it("recovers gracefully from a corrupted state file (treats as initial run)", () => {
    const { project, twiningDir } = makeRepo();
    fs.writeFileSync(
      path.join(twiningDir, ".last-known-branches.json"),
      "{ this is not json",
    );
    const r = detectDeletedBranches(twiningDir, project);
    expect(r.initial_record).toBe(true);
    expect(r.deleted_branches).toEqual([]);
  });

  it("commit=false (dry-run) does NOT advance the snapshot, so deletions persist across previews", () => {
    const { project, twiningDir } = makeRepo();
    execFileSync("git", ["branch", "feature/preview-target"], { cwd: project });

    // Establish baseline.
    detectDeletedBranches(twiningDir, project, true);

    // Delete the branch.
    execFileSync("git", ["branch", "-D", "feature/preview-target"], { cwd: project });

    // First preview — sees the deletion.
    const preview1 = detectDeletedBranches(twiningDir, project, false);
    expect(preview1.deleted_branches).toEqual(["feature/preview-target"]);

    // Second preview — must still see the same deletion. If the first preview
    // had silently advanced the baseline, this would return [] and the user
    // would lose the candidate without ever acting on it.
    const preview2 = detectDeletedBranches(twiningDir, project, false);
    expect(preview2.deleted_branches).toEqual(["feature/preview-target"]);

    // Now commit — advances baseline. After this, the deletion is consumed.
    detectDeletedBranches(twiningDir, project, true);
    const after = detectDeletedBranches(twiningDir, project, true);
    expect(after.deleted_branches).toEqual([]);
  });
});
