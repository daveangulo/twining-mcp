import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeWorktreeFixture, runHook } from "./run-hook";

let dir: string;

beforeEach(() => {
  // Every test runs from an isolated tmp dir — never from the repo root,
  // which has its own live .twining/ the hook would otherwise write into.
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-sash-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("subagent-stop-hook.sh", () => {
  it("exits 0 with no output when TWINING_DISABLED=true", () => {
    fs.mkdirSync(path.join(dir, ".twining"));
    const result = runHook({
      script: "subagent-stop-hook.sh",
      stdin: JSON.stringify({ agent_type: "worker" }),
      env: { TWINING_DISABLED: "true" },
      cwd: dir,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("");
    expect(fs.existsSync(path.join(dir, ".twining", "pending-posts.jsonl"))).toBe(
      false,
    );
  });

  it("does nothing when no .twining directory exists", () => {
    const result = runHook({
      script: "subagent-stop-hook.sh",
      stdin: JSON.stringify({ agent_type: "worker" }),
      cwd: dir,
    });
    expect(result.exitCode).toBe(0);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("queues a pending post instead of writing blackboard.jsonl directly", () => {
    fs.mkdirSync(path.join(dir, ".twining"));
    const result = runHook({
      script: "subagent-stop-hook.sh",
      stdin: JSON.stringify({ agent_type: "code-reviewer" }),
      cwd: dir,
    });
    expect(result.exitCode).toBe(0);

    // The locked blackboard file is never touched by the hook
    expect(fs.existsSync(path.join(dir, ".twining", "blackboard.jsonl"))).toBe(
      false,
    );

    const pendingPath = path.join(dir, ".twining", "pending-posts.jsonl");
    expect(fs.existsSync(pendingPath)).toBe(true);
    const lines = fs
      .readFileSync(pendingPath, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(1);

    // Line must parse and match the PendingProcessor's PendingPost shape
    const post = JSON.parse(lines[0]!);
    expect(post).toMatchObject({
      entry_type: "status",
      summary: "Subagent completed: code-reviewer",
      scope: "project",
      agent_id: "code-reviewer",
      tags: ["subagent-stop", "hook-generated"],
    });
  });

  it("falls back to agent_name when agent_type is absent", () => {
    fs.mkdirSync(path.join(dir, ".twining"));
    const result = runHook({
      script: "subagent-stop-hook.sh",
      stdin: JSON.stringify({ agent_name: "gsd-executor" }),
      cwd: dir,
    });
    expect(result.exitCode).toBe(0);
    const pendingPath = path.join(dir, ".twining", "pending-posts.jsonl");
    const lines = fs
      .readFileSync(pendingPath, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(1);
    const post = JSON.parse(lines[0]!);
    expect(post).toMatchObject({
      summary: "Subagent completed: gsd-executor",
      agent_id: "gsd-executor",
    });
  });

  it("falls back to description when agent_type and agent_name are absent", () => {
    fs.mkdirSync(path.join(dir, ".twining"));
    const result = runHook({
      script: "subagent-stop-hook.sh",
      stdin: JSON.stringify({ description: "refactor auth module" }),
      cwd: dir,
    });
    expect(result.exitCode).toBe(0);
    const pendingPath = path.join(dir, ".twining", "pending-posts.jsonl");
    const lines = fs
      .readFileSync(pendingPath, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(1);
    const post = JSON.parse(lines[0]!);
    expect(post).toMatchObject({
      summary: "Subagent completed: refactor auth module",
      agent_id: "refactor auth module",
    });
  });

  it("posts nothing when agent_type, agent_name, and description are all absent", () => {
    fs.mkdirSync(path.join(dir, ".twining"));
    const result = runHook({
      script: "subagent-stop-hook.sh",
      stdin: JSON.stringify({ transcript_path: "/tmp/foo.jsonl" }),
      cwd: dir,
    });
    expect(result.exitCode).toBe(0);
    expect(
      fs.existsSync(path.join(dir, ".twining", "pending-posts.jsonl")),
    ).toBe(false);
  });

  it("linked worktree: queues the pending post in the MAIN checkout's .twining", () => {
    const fixture = makeWorktreeFixture("twining-sash-wt-");
    try {
      const result = runHook({
        script: "subagent-stop-hook.sh",
        stdin: JSON.stringify({ agent_type: "worker" }),
        cwd: fixture.wt,
      });
      expect(result.exitCode).toBe(0);
      expect(
        fs.existsSync(path.join(fixture.main, ".twining", "pending-posts.jsonl")),
      ).toBe(true);
      expect(fs.existsSync(path.join(fixture.wt, ".twining"))).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  it("TWINING_PROJECT: queues the pending post in the targeted store", () => {
    const fixture = makeWorktreeFixture("twining-sash-proj-");
    try {
      const result = runHook({
        script: "subagent-stop-hook.sh",
        stdin: JSON.stringify({ agent_type: "worker" }),
        env: { TWINING_PROJECT: fixture.main },
        cwd: fixture.root, // no .twining, no .git here
      });
      expect(result.exitCode).toBe(0);
      expect(
        fs.existsSync(path.join(fixture.main, ".twining", "pending-posts.jsonl")),
      ).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it("TWINING_WORKTREE_LOCAL=true: keeps worktree-local (no store → nothing queued)", () => {
    const fixture = makeWorktreeFixture("twining-sash-wtlocal-");
    try {
      const result = runHook({
        script: "subagent-stop-hook.sh",
        stdin: JSON.stringify({ agent_type: "worker" }),
        env: { TWINING_WORKTREE_LOCAL: "true" },
        cwd: fixture.wt, // has no .twining of its own
      });
      expect(result.exitCode).toBe(0);
      expect(
        fs.existsSync(path.join(fixture.main, ".twining", "pending-posts.jsonl")),
      ).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  it("appends when pending-posts.jsonl already has queued entries", () => {
    const twining = path.join(dir, ".twining");
    fs.mkdirSync(twining);
    fs.writeFileSync(
      path.join(twining, "pending-posts.jsonl"),
      '{"entry_type":"status","summary":"earlier"}\n',
    );
    const result = runHook({
      script: "subagent-stop-hook.sh",
      stdin: JSON.stringify({ agent_type: "worker" }),
      cwd: dir,
    });
    expect(result.exitCode).toBe(0);
    const lines = fs
      .readFileSync(path.join(twining, "pending-posts.jsonl"), "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});
