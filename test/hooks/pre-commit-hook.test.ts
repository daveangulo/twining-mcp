import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runHook } from "./run-hook";

/**
 * Build a tmp git repo with optional .twining/ + sentinel + initial commits.
 */
function makeRepo(opts: {
  initTwining?: boolean;
  sentinelTime?: number; // unix seconds
  withInitialCommit?: boolean;
}): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-pre-commit-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });

  if (opts.initTwining) {
    fs.mkdirSync(path.join(dir, ".twining"));
  }
  if (opts.sentinelTime !== undefined) {
    fs.writeFileSync(
      path.join(dir, ".twining", ".last-record"),
      String(opts.sentinelTime),
    );
  }
  if (opts.withInitialCommit) {
    fs.writeFileSync(path.join(dir, "seed.txt"), "seed");
    execFileSync("git", ["add", "seed.txt"], { cwd: dir });
    execFileSync(
      "git",
      ["commit", "-q", "-m", "seed", "--allow-empty"],
      { cwd: dir, env: { ...process.env, GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z", GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z" } },
    );
  }
  return {
    dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Real linked worktree via `git worktree add`: main checkout with an
 * untracked .twining/ (so the worktree gets none), seed commit dated
 * 2020-01-01, and a sibling worktree whose .git FILE points at
 * <main>/.git/worktrees/wt.
 */
function makeWorktreeRepo(opts: { sentinelTime?: number }): {
  main: string;
  wt: string;
  cleanup: () => void;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "twining-pre-commit-wt-"));
  const main = path.join(root, "main");
  fs.mkdirSync(main);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: main });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: main });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: main });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: main });
  fs.writeFileSync(path.join(main, "seed.txt"), "seed");
  execFileSync("git", ["add", "seed.txt"], { cwd: main });
  execFileSync(
    "git",
    ["commit", "-q", "-m", "seed"],
    { cwd: main, env: { ...process.env, GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z", GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z" } },
  );
  fs.mkdirSync(path.join(main, ".twining"));
  if (opts.sentinelTime !== undefined) {
    fs.writeFileSync(
      path.join(main, ".twining", ".last-record"),
      String(opts.sentinelTime),
    );
  }
  execFileSync("git", ["worktree", "add", "-q", "../wt", "-b", "wtb"], {
    cwd: main,
  });
  return {
    main,
    wt: path.join(root, "wt"),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function hookInput(command: string, transcriptPath = "/tmp/nonexistent"): string {
  return JSON.stringify({
    tool_name: "Bash",
    tool_input: { command },
    transcript_path: transcriptPath,
  });
}

describe("pre-commit-hook.sh", () => {
  let repo: { dir: string; cleanup: () => void };
  afterEach(() => repo?.cleanup());

  describe("escape hatch", () => {
    it("TWINING_DISABLED=true: silent allow even when sentinel is missing", () => {
      repo = makeRepo({ initTwining: true, withInitialCommit: true });
      const result = runHook({
        script: "pre-commit-hook.sh",
        stdin: hookInput("git commit -m 'x'"),
        cwd: repo.dir,
        env: { TWINING_DISABLED: "true" },
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("permissionDecision");
    });

    it("no .twining/ directory: silent allow (not a twining-managed repo)", () => {
      repo = makeRepo({ initTwining: false, withInitialCommit: true });
      const result = runHook({
        script: "pre-commit-hook.sh",
        stdin: hookInput("git commit -m 'x'"),
        cwd: repo.dir,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("");
    });
  });

  describe("trigger detection", () => {
    it("non-commit Bash command: silent allow", () => {
      repo = makeRepo({ initTwining: true });
      const result = runHook({
        script: "pre-commit-hook.sh",
        stdin: hookInput("ls -la"),
        cwd: repo.dir,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("");
    });

    it("Bug C: command containing 'git commit' substring inside heredoc/pipe — silent allow", () => {
      // Reproducer for #11 Bug 2: pbcopy of release notes that mention "git commit"
      repo = makeRepo({ initTwining: true });
      const result = runHook({
        script: "pre-commit-hook.sh",
        stdin: hookInput(`echo "instructions: run git commit -m foo" | pbcopy`),
        cwd: repo.dir,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("");
    });

    it("Bug C: 'git commit-tree' (different command) — silent allow", () => {
      repo = makeRepo({ initTwining: true });
      const result = runHook({
        script: "pre-commit-hook.sh",
        stdin: hookInput("git commit-tree -m x HEAD^{tree}"),
        cwd: repo.dir,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("");
    });

    it("git commit --amend: silent allow regardless of sentinel state", () => {
      repo = makeRepo({ initTwining: true, withInitialCommit: true });
      const result = runHook({
        script: "pre-commit-hook.sh",
        stdin: hookInput("git commit --amend --no-edit"),
        cwd: repo.dir,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("");
    });

    it("Bug D: command JSON containing escaped quotes is parsed correctly", () => {
      // Reproducer for #13: bash regex [^"]+ truncates at first \"
      // Stale sentinel (older than HEAD) so recognition produces a deny.
      repo = makeRepo({
        initTwining: true,
        withInitialCommit: true,
        sentinelTime: 1,
      });
      // A real commit with a quoted message — JSON-encoded with escaped quotes
      const result = runHook({
        script: "pre-commit-hook.sh",
        stdin: hookInput(`git commit -m "fix: handle \\"escaped\\" quotes"`),
        cwd: repo.dir,
      });
      // Stale sentinel → block. The point of this test is that we recognize
      // it AS a git commit (and therefore deny), proving the JSON parse worked.
      expect(result.stdout).toContain("permissionDecision");
      expect(result.stdout).toContain("deny");
    });
  });

  describe("sentinel vs HEAD comparison", () => {
    it("sentinel newer than HEAD commit time: allow", () => {
      // Initial commit dated 2020-01-01 ≈ 1577836800 epoch
      repo = makeRepo({
        initTwining: true,
        withInitialCommit: true,
        sentinelTime: 9999999999, // far in the future
      });
      const result = runHook({
        script: "pre-commit-hook.sh",
        stdin: hookInput("git commit -m 'next'"),
        cwd: repo.dir,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("permissionDecision");
    });

    it("sentinel older than HEAD commit time: deny", () => {
      repo = makeRepo({
        initTwining: true,
        withInitialCommit: true, // commit at 2020-01-01
        sentinelTime: 1, // older than the HEAD commit
      });
      const result = runHook({
        script: "pre-commit-hook.sh",
        stdin: hookInput("git commit -m 'next'"),
        cwd: repo.dir,
      });
      expect(result.stdout).toContain("permissionDecision");
      expect(result.stdout).toContain("deny");
      expect(result.stdout).toContain("twining_record");
    });

    it("Bug A: assistant prose containing 'git commit' in transcript is irrelevant — sentinel decides", () => {
      // Reproducer for the markdown report: with old hook, assistant text containing
      // "git commit" would advance LAST_COMMIT past LAST_TWINING. New hook ignores
      // the transcript entirely.
      repo = makeRepo({
        initTwining: true,
        withInitialCommit: true,
        sentinelTime: 9999999999,
      });
      const tmpTranscript = path.join(repo.dir, "transcript.jsonl");
      fs.writeFileSync(
        tmpTranscript,
        '{"role":"assistant","content":"explaining the git commit issue"}\n'.repeat(50) +
          '{"toolUse":{"name":"Bash","input":{"command":"git commit -m old"}}}\n',
      );
      const result = runHook({
        script: "pre-commit-hook.sh",
        stdin: hookInput("git commit -m 'next'", tmpTranscript),
        cwd: repo.dir,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("permissionDecision");
    });

    it("Bug B: same-turn record then commit — sentinel makes flush latency moot", () => {
      // Reproducer for #11 Bug 1: in same-turn batching, the transcript flush
      // hasn't happened yet but the sentinel was written synchronously by the
      // record handler. Hook reads sentinel, sees it's newer than HEAD, allows.
      repo = makeRepo({
        initTwining: true,
        withInitialCommit: true,
        sentinelTime: Math.floor(Date.now() / 1000),
      });
      // Empty transcript — simulates pre-flush state
      const tmpTranscript = path.join(repo.dir, "transcript.jsonl");
      fs.writeFileSync(tmpTranscript, "");
      const result = runHook({
        script: "pre-commit-hook.sh",
        stdin: hookInput("git commit -m 'next'", tmpTranscript),
        cwd: repo.dir,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("permissionDecision");
    });

    it("no sentinel at all: allow with a visible warning (fail open, W1.3)", () => {
      // Fresh clone / MCP server never booted — the gate is unsatisfiable
      // (record tools unreachable), so it must not be the reason a commit
      // is impossible (issue class B3). Warn instead of deny.
      repo = makeRepo({ initTwining: true, withInitialCommit: true });
      const result = runHook({
        script: "pre-commit-hook.sh",
        stdin: hookInput("git commit -m 'first'"),
        cwd: repo.dir,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('"permissionDecision":"allow"');
      expect(result.stdout).not.toContain('"deny"');
      expect(result.stdout).toContain("no record sentinel");
    });

    it("sentinel present but stale after fail-open window: normal gating resumes (deny)", () => {
      // Once any record has been written, the sentinel exists forever and
      // the stale-sentinel deny path applies again.
      repo = makeRepo({
        initTwining: true,
        withInitialCommit: true, // commit at 2020-01-01
        sentinelTime: 1,
      });
      const result = runHook({
        script: "pre-commit-hook.sh",
        stdin: hookInput("git commit -m 'next'"),
        cwd: repo.dir,
      });
      expect(result.stdout).toContain("deny");
    });

    it("linked worktree with stale main sentinel: deny (gates against the shared store)", () => {
      // Without the redirect the worktree has no .twining → silent allow;
      // the deny proves the hook resolved the MAIN checkout's store.
      const wtRepo = makeWorktreeRepo({ sentinelTime: 1 }); // older than 2020 HEAD
      try {
        const result = runHook({
          script: "pre-commit-hook.sh",
          stdin: hookInput("git commit -m 'next'"),
          cwd: wtRepo.wt,
        });
        expect(result.stdout).toContain("deny");
        expect(result.stdout).toContain("twining_record");
      } finally {
        wtRepo.cleanup();
      }
    });

    it("linked worktree with fresh main sentinel: allow", () => {
      const wtRepo = makeWorktreeRepo({ sentinelTime: 9999999999 });
      try {
        const result = runHook({
          script: "pre-commit-hook.sh",
          stdin: hookInput("git commit -m 'next'"),
          cwd: wtRepo.wt,
        });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).not.toContain("permissionDecision");
      } finally {
        wtRepo.cleanup();
      }
    });

    it("TWINING_WORKTREE_LOCAL=true in a worktree: silent allow (no shared store, no redirect)", () => {
      const wtRepo = makeWorktreeRepo({ sentinelTime: 1 });
      try {
        const result = runHook({
          script: "pre-commit-hook.sh",
          stdin: hookInput("git commit -m 'next'"),
          env: { TWINING_WORKTREE_LOCAL: "true" },
          cwd: wtRepo.wt,
        });
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe("");
      } finally {
        wtRepo.cleanup();
      }
    });

    it("TWINING_PROJECT: gates against the targeted store from a repo without .twining", () => {
      repo = makeRepo({ initTwining: false, withInitialCommit: true });
      const target = fs.mkdtempSync(path.join(os.tmpdir(), "twining-pre-commit-target-"));
      fs.mkdirSync(path.join(target, ".twining"));
      fs.writeFileSync(path.join(target, ".twining", ".last-record"), "1");
      try {
        const result = runHook({
          script: "pre-commit-hook.sh",
          stdin: hookInput("git commit -m 'next'"),
          env: { TWINING_PROJECT: target },
          cwd: repo.dir,
        });
        expect(result.stdout).toContain("deny");
      } finally {
        fs.rmSync(target, { recursive: true, force: true });
      }
    });

    it("sentinel exists but no commits yet (fresh repo, recorded): allow", () => {
      repo = makeRepo({
        initTwining: true,
        sentinelTime: Math.floor(Date.now() / 1000),
        withInitialCommit: false,
      });
      const result = runHook({
        script: "pre-commit-hook.sh",
        stdin: hookInput("git commit -m 'first'"),
        cwd: repo.dir,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("permissionDecision");
    });
  });
});
