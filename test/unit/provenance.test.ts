import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureProvenance } from "../../src/utils/provenance";

describe("captureProvenance", () => {
  let dir: string;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns recorded_at only when projectRoot is null", () => {
    const before = Date.now();
    const p = captureProvenance(null);
    expect(p.branch).toBeUndefined();
    expect(p.commit_sha).toBeUndefined();
    expect(new Date(p.recorded_at).getTime()).toBeGreaterThanOrEqual(before);
  });

  it("returns recorded_at only in a non-git directory", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-prov-"));
    const p = captureProvenance(dir);
    expect(p.branch).toBeUndefined();
    expect(p.commit_sha).toBeUndefined();
    expect(p.recorded_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("captures branch + sha in a real git repo with commits", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-prov-"));
    execFileSync("git", ["init", "-q", "-b", "feature/x"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@x"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "init", "--allow-empty"], { cwd: dir });

    const p = captureProvenance(dir);
    expect(p.branch).toBe("feature/x");
    expect(p.commit_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(p.recorded_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("omits branch on detached HEAD (HEAD ref name)", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-prov-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@x"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "init", "--allow-empty"], { cwd: dir });
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: dir,
      encoding: "utf-8",
    }).trim();
    execFileSync("git", ["checkout", "-q", "--detach", sha], { cwd: dir });

    const p = captureProvenance(dir);
    expect(p.branch).toBeUndefined();
    expect(p.commit_sha).toBe(sha);
  });
});
