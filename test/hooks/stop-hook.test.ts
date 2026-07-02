import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runHook } from "./run-hook";

/**
 * Build a tmp git repo with optional .twining/ + sentinel + dirty files.
 * The 1.10.0 stop hook is transcript-free: it compares the record sentinel
 * against the newest mtime of dirty working-tree files.
 */
function makeRepo(opts: {
  initTwining?: boolean;
  sentinelTime?: number; // unix seconds (content of .last-record)
  gitInit?: boolean;
}): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-stop-"));
  if (opts.gitInit !== false) {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: dir,
    });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
    execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  }
  if (opts.initTwining) {
    fs.mkdirSync(path.join(dir, ".twining"));
  }
  if (opts.sentinelTime !== undefined) {
    fs.writeFileSync(
      path.join(dir, ".twining", ".last-record"),
      String(opts.sentinelTime),
    );
  }
  return {
    dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

const NOW = () => Math.floor(Date.now() / 1000);

describe("stop-hook.sh", () => {
  let repo: { dir: string; cleanup: () => void };
  afterEach(() => repo?.cleanup());

  it("TWINING_DISABLED=true: silent allow", () => {
    repo = makeRepo({ initTwining: true, sentinelTime: 1 });
    fs.writeFileSync(path.join(repo.dir, "dirty.txt"), "uncommitted");
    const result = runHook({
      script: "stop-hook.sh",
      stdin: JSON.stringify({}),
      env: { TWINING_DISABLED: "true" },
      cwd: repo.dir,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it("no .twining/ directory: silent allow (unrelated repo, global install)", () => {
    repo = makeRepo({ initTwining: false });
    fs.writeFileSync(path.join(repo.dir, "dirty.txt"), "uncommitted");
    const result = runHook({
      script: "stop-hook.sh",
      stdin: JSON.stringify({}),
      cwd: repo.dir,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it("stop_hook_active=true: silent allow (no infinite block loops)", () => {
    repo = makeRepo({ initTwining: true, sentinelTime: 1 });
    fs.writeFileSync(path.join(repo.dir, "dirty.txt"), "uncommitted");
    const result = runHook({
      script: "stop-hook.sh",
      stdin: JSON.stringify({ stop_hook_active: true }),
      cwd: repo.dir,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it("no sentinel ever written: silent allow (fresh clone / server down)", () => {
    repo = makeRepo({ initTwining: true });
    fs.writeFileSync(path.join(repo.dir, "dirty.txt"), "uncommitted");
    const result = runHook({
      script: "stop-hook.sh",
      stdin: JSON.stringify({}),
      cwd: repo.dir,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it("dirty file newer than sentinel: block asking for twining_record", () => {
    repo = makeRepo({ initTwining: true, sentinelTime: NOW() - 3600 });
    fs.writeFileSync(path.join(repo.dir, "dirty.txt"), "uncommitted"); // mtime = now
    const result = runHook({
      script: "stop-hook.sh",
      stdin: JSON.stringify({}),
      cwd: repo.dir,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('"decision":"block"');
    expect(result.stdout).toContain("twining_record");
    expect(result.stdout).toContain("findings");
  });

  it("sentinel newer than every dirty file: silent allow", () => {
    repo = makeRepo({ initTwining: true, sentinelTime: NOW() + 3600 });
    fs.writeFileSync(path.join(repo.dir, "dirty.txt"), "uncommitted");
    const result = runHook({
      script: "stop-hook.sh",
      stdin: JSON.stringify({}),
      cwd: repo.dir,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it("clean working tree: silent allow (pre-commit hook gated committed work)", () => {
    repo = makeRepo({ initTwining: true, sentinelTime: 1 });
    // .twining/ is untracked but excluded from the dirty scan; nothing else dirty
    const result = runHook({
      script: "stop-hook.sh",
      stdin: JSON.stringify({}),
      cwd: repo.dir,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it(".twining/-only changes never count as dirty (recording touches .twining)", () => {
    repo = makeRepo({ initTwining: true, sentinelTime: NOW() - 3600 });
    // Blackboard write with mtime newer than the sentinel — must not block
    fs.writeFileSync(
      path.join(repo.dir, ".twining", "blackboard.jsonl"),
      '{"entry_type":"status"}\n',
    );
    const result = runHook({
      script: "stop-hook.sh",
      stdin: JSON.stringify({}),
      cwd: repo.dir,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it("non-git directory: silent allow (fail open)", () => {
    repo = makeRepo({ initTwining: true, sentinelTime: 1, gitInit: false });
    fs.writeFileSync(path.join(repo.dir, "dirty.txt"), "uncommitted");
    const result = runHook({
      script: "stop-hook.sh",
      stdin: JSON.stringify({}),
      cwd: repo.dir,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });
});
