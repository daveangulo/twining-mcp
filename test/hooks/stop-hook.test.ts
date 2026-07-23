import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeWorktreeFixture, runHook } from "./run-hook";

/**
 * Build a tmp repo with optional .twining/ + sentinel + session marker.
 * Since plugin 1.16.0 the stop hook is marker-based (#43): it compares the
 * record sentinel against THIS session's activity marker
 * (.twining/.sessions/<session_id>, written by the PostToolUse activity
 * hook on every Edit/Write). The previous dirty-file-mtime scan is gone —
 * mtime was a leaky proxy that false-blocked on concurrent worktrees,
 * formatter touches, and alphabetical head-cap truncation.
 */
function makeRepo(opts: {
  initTwining?: boolean;
  sentinelTime?: number; // unix seconds (content of .last-record)
  markerTime?: number; // unix seconds (content of .sessions/<id>)
  sessionId?: string;
  gitInit?: boolean;
}): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-stop-"));
  if (opts.gitInit !== false) {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
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
  if (opts.markerTime !== undefined) {
    const sessionsDir = path.join(dir, ".twining", ".sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, opts.sessionId ?? "sess-1"),
      String(opts.markerTime),
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
    repo = makeRepo({
      initTwining: true,
      sentinelTime: 1,
      markerTime: NOW(),
    });
    const result = runHook({
      script: "stop-hook.sh",
      stdin: JSON.stringify({ session_id: "sess-1" }),
      env: { TWINING_DISABLED: "true" },
      cwd: repo.dir,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it("no .twining/ directory: silent allow (unrelated repo, global install)", () => {
    repo = makeRepo({ initTwining: false });
    const result = runHook({
      script: "stop-hook.sh",
      stdin: JSON.stringify({ session_id: "sess-1" }),
      cwd: repo.dir,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it("stop_hook_active=true: silent allow (no infinite block loops)", () => {
    repo = makeRepo({
      initTwining: true,
      sentinelTime: 1,
      markerTime: NOW(),
    });
    const result = runHook({
      script: "stop-hook.sh",
      stdin: JSON.stringify({ session_id: "sess-1", stop_hook_active: true }),
      cwd: repo.dir,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it("no sentinel ever written: silent allow (fresh clone / server down)", () => {
    repo = makeRepo({ initTwining: true, markerTime: NOW() });
    const result = runHook({
      script: "stop-hook.sh",
      stdin: JSON.stringify({ session_id: "sess-1" }),
      cwd: repo.dir,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it("no session marker: silent allow — the #43 field false-block scenario", () => {
    // A dirty tree with files newer than the sentinel used to block here,
    // even for read-only sessions. Without a marker for THIS session, the
    // session did no recordable file edits — always allow.
    repo = makeRepo({ initTwining: true, sentinelTime: NOW() - 3600 });
    fs.writeFileSync(path.join(repo.dir, "dirty.txt"), "uncommitted");
    const result = runHook({
      script: "stop-hook.sh",
      stdin: JSON.stringify({ session_id: "sess-1" }),
      cwd: repo.dir,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it("no session_id in hook input: silent allow (fail open)", () => {
    repo = makeRepo({
      initTwining: true,
      sentinelTime: NOW() - 3600,
      markerTime: NOW(),
    });
    const result = runHook({
      script: "stop-hook.sh",
      stdin: JSON.stringify({}),
      cwd: repo.dir,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it("session marker newer than sentinel: block asking for twining_record", () => {
    repo = makeRepo({
      initTwining: true,
      sentinelTime: NOW() - 3600,
      markerTime: NOW(),
      sessionId: "sess-1",
    });
    const result = runHook({
      script: "stop-hook.sh",
      stdin: JSON.stringify({ session_id: "sess-1" }),
      cwd: repo.dir,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('"decision":"block"');
    expect(result.stdout).toContain("twining_record");
    expect(result.stdout).toContain("findings");
  });

  it("sentinel newer than session marker (recorded after last edit): silent allow", () => {
    repo = makeRepo({
      initTwining: true,
      sentinelTime: NOW(),
      markerTime: NOW() - 3600,
      sessionId: "sess-1",
    });
    const result = runHook({
      script: "stop-hook.sh",
      stdin: JSON.stringify({ session_id: "sess-1" }),
      cwd: repo.dir,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it("another session's marker never blocks this session", () => {
    repo = makeRepo({
      initTwining: true,
      sentinelTime: NOW() - 3600,
      markerTime: NOW(),
      sessionId: "other-session",
    });
    const result = runHook({
      script: "stop-hook.sh",
      stdin: JSON.stringify({ session_id: "sess-1" }),
      cwd: repo.dir,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it("path-traversal session_id is sanitized: silent allow, no escape from .sessions/", () => {
    repo = makeRepo({ initTwining: true, sentinelTime: NOW() - 3600 });
    // A hostile/broken session_id must not read files outside .sessions/.
    fs.writeFileSync(path.join(repo.dir, ".twining", "evil"), String(NOW()));
    const result = runHook({
      script: "stop-hook.sh",
      stdin: JSON.stringify({ session_id: "../evil" }),
      cwd: repo.dir,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it("non-git directory with marker newer than sentinel: still blocks (gate no longer needs git)", () => {
    repo = makeRepo({
      initTwining: true,
      sentinelTime: NOW() - 3600,
      markerTime: NOW(),
      sessionId: "sess-1",
      gitInit: false,
    });
    const result = runHook({
      script: "stop-hook.sh",
      stdin: JSON.stringify({ session_id: "sess-1" }),
      cwd: repo.dir,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('"decision":"block"');
  });
});

describe("stop-hook.sh worktree/TWINING_PROJECT store resolution", () => {
  let fixture: ReturnType<typeof makeWorktreeFixture>;
  afterEach(() => fixture?.cleanup());

  function seedMainStore(fx: ReturnType<typeof makeWorktreeFixture>) {
    // Block-worthy state in the MAIN store: stale sentinel + fresh marker.
    fs.writeFileSync(
      path.join(fx.main, ".twining", ".last-record"),
      String(NOW() - 3600),
    );
    const sessionsDir = path.join(fx.main, ".twining", ".sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, "sess-1"), String(NOW()));
  }

  it("linked worktree: gates against the main checkout's .twining (block)", () => {
    fixture = makeWorktreeFixture("twining-stop-wt-");
    seedMainStore(fixture);
    const result = runHook({
      script: "stop-hook.sh",
      stdin: JSON.stringify({ session_id: "sess-1" }),
      cwd: fixture.wt,
    });
    expect(result.exitCode).toBe(0);
    // Without the redirect the worktree has no .twining → silent allow.
    expect(result.stdout).toContain('"decision":"block"');
  });

  it("TWINING_PROJECT: gates against the targeted store from an unmanaged cwd", () => {
    fixture = makeWorktreeFixture("twining-stop-proj-");
    seedMainStore(fixture);
    const result = runHook({
      script: "stop-hook.sh",
      stdin: JSON.stringify({ session_id: "sess-1" }),
      env: { TWINING_PROJECT: fixture.main },
      cwd: fixture.root, // no .twining, no .git here
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('"decision":"block"');
  });

  it("TWINING_WORKTREE_LOCAL=true: keeps worktree-local (no redirect, silent allow)", () => {
    fixture = makeWorktreeFixture("twining-stop-wtlocal-");
    seedMainStore(fixture);
    const result = runHook({
      script: "stop-hook.sh",
      stdin: JSON.stringify({ session_id: "sess-1" }),
      env: { TWINING_WORKTREE_LOCAL: "true" },
      cwd: fixture.wt, // has no .twining of its own → not twining-managed
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it("nested worktree + TWINING_WORKTREE_LOCAL=true: never binds the main store", () => {
    // `git worktree add ./wts/feat` layout: the worktree lives INSIDE the
    // main checkout, so a walk-up that ignores the worktree boundary would
    // reach main and gate against ITS store — while the server (which
    // resolves cwd-local under the opt-out) writes .last-record into the
    // worktree store, making the block unsatisfiable from the worktree.
    fixture = makeWorktreeFixture("twining-stop-wtnested-", { nested: true });
    seedMainStore(fixture); // block-worthy state in MAIN — must not be read
    const result = runHook({
      script: "stop-hook.sh",
      stdin: JSON.stringify({ session_id: "sess-1" }),
      env: { TWINING_WORKTREE_LOCAL: "true" },
      cwd: fixture.wt, // no .twining of its own → fail-open, silent allow
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it("nested worktree whose main lacks .twining: never binds an ancestor store", () => {
    // Milder variant, no opt-out: main has no .twining, but an UNRELATED
    // ancestor above it does. The worktree root is a walk boundary — the
    // hook must fail open, not gate against the ancestor's store.
    fixture = makeWorktreeFixture("twining-stop-wtanc-", {
      nested: true,
      mainTwining: false,
    });
    // Block-worthy state in the ancestor (fixture.root) store.
    fs.mkdirSync(path.join(fixture.root, ".twining", ".sessions"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(fixture.root, ".twining", ".last-record"),
      String(NOW() - 3600),
    );
    fs.writeFileSync(
      path.join(fixture.root, ".twining", ".sessions", "sess-1"),
      String(NOW()),
    );
    const result = runHook({
      script: "stop-hook.sh",
      stdin: JSON.stringify({ session_id: "sess-1" }),
      cwd: fixture.wt,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });
});

describe("activity-marker-hook.sh (#43)", () => {
  let repo: { dir: string; cleanup: () => void };
  afterEach(() => repo?.cleanup());

  it("writes an epoch-seconds marker for the session on a file-editing tool call", () => {
    repo = makeRepo({ initTwining: true });
    const before = NOW();
    const result = runHook({
      script: "activity-marker-hook.sh",
      stdin: JSON.stringify({ session_id: "sess-abc", tool_name: "Edit" }),
      cwd: repo.dir,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("");
    const marker = path.join(repo.dir, ".twining", ".sessions", "sess-abc");
    expect(fs.existsSync(marker)).toBe(true);
    const t = parseInt(fs.readFileSync(marker, "utf-8").trim(), 10);
    expect(t).toBeGreaterThanOrEqual(before);
  });

  it("updates the marker on subsequent calls", () => {
    repo = makeRepo({ initTwining: true });
    const marker = path.join(repo.dir, ".twining", ".sessions", "sess-abc");
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, "1");
    runHook({
      script: "activity-marker-hook.sh",
      stdin: JSON.stringify({ session_id: "sess-abc" }),
      cwd: repo.dir,
    });
    const t = parseInt(fs.readFileSync(marker, "utf-8").trim(), 10);
    expect(t).toBeGreaterThan(1);
  });

  it("no session_id: writes nothing, exits 0", () => {
    repo = makeRepo({ initTwining: true });
    const result = runHook({
      script: "activity-marker-hook.sh",
      stdin: JSON.stringify({ tool_name: "Edit" }),
      cwd: repo.dir,
    });
    expect(result.exitCode).toBe(0);
    expect(
      fs.existsSync(path.join(repo.dir, ".twining", ".sessions")),
    ).toBe(false);
  });

  it("no .twining/: writes nothing, exits 0", () => {
    repo = makeRepo({ initTwining: false });
    const result = runHook({
      script: "activity-marker-hook.sh",
      stdin: JSON.stringify({ session_id: "sess-abc" }),
      cwd: repo.dir,
    });
    expect(result.exitCode).toBe(0);
  });

  it("TWINING_DISABLED=true: writes nothing, exits 0", () => {
    repo = makeRepo({ initTwining: true });
    const result = runHook({
      script: "activity-marker-hook.sh",
      stdin: JSON.stringify({ session_id: "sess-abc" }),
      env: { TWINING_DISABLED: "true" },
      cwd: repo.dir,
    });
    expect(result.exitCode).toBe(0);
    expect(
      fs.existsSync(path.join(repo.dir, ".twining", ".sessions")),
    ).toBe(false);
  });

  it("sanitizes path-traversal session_id instead of writing outside .sessions/", () => {
    repo = makeRepo({ initTwining: true });
    const result = runHook({
      script: "activity-marker-hook.sh",
      stdin: JSON.stringify({ session_id: "../../evil" }),
      cwd: repo.dir,
    });
    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(path.join(repo.dir, "evil"))).toBe(false);
    expect(fs.existsSync(path.join(repo.dir, ".twining", "evil"))).toBe(false);
  });
});

describe("activity-marker-hook.sh worktree/TWINING_PROJECT store resolution", () => {
  let fixture: ReturnType<typeof makeWorktreeFixture>;
  afterEach(() => fixture?.cleanup());

  const marker = (root: string, id = "sess-w") =>
    path.join(root, ".twining", ".sessions", id);

  it("linked worktree: writes the marker into the main checkout's .twining", () => {
    fixture = makeWorktreeFixture("twining-am-wt-");
    const result = runHook({
      script: "activity-marker-hook.sh",
      stdin: JSON.stringify({ session_id: "sess-w", tool_name: "Edit" }),
      cwd: fixture.wt,
    });
    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(marker(fixture.main))).toBe(true);
    expect(fs.existsSync(path.join(fixture.wt, ".twining"))).toBe(false);
  });

  it("linked worktree with a local .twining still shares the main store by default", () => {
    fixture = makeWorktreeFixture("twining-am-wtboth-");
    fs.mkdirSync(path.join(fixture.wt, ".twining"));
    const result = runHook({
      script: "activity-marker-hook.sh",
      stdin: JSON.stringify({ session_id: "sess-w", tool_name: "Edit" }),
      cwd: fixture.wt,
    });
    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(marker(fixture.main))).toBe(true);
    expect(fs.existsSync(marker(fixture.wt))).toBe(false);
  });

  it("TWINING_PROJECT wins over the walk-up result (absolute path)", () => {
    fixture = makeWorktreeFixture("twining-am-proj-");
    // cwd has its OWN .twining — explicit targeting must still win.
    fs.mkdirSync(path.join(fixture.wt, ".twining"));
    const result = runHook({
      script: "activity-marker-hook.sh",
      stdin: JSON.stringify({ session_id: "sess-w", tool_name: "Edit" }),
      env: { TWINING_PROJECT: fixture.main },
      cwd: fixture.wt,
    });
    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(marker(fixture.main))).toBe(true);
    expect(fs.existsSync(marker(fixture.wt))).toBe(false);
  });

  it("relative TWINING_PROJECT resolves against cwd (server semantics)", () => {
    fixture = makeWorktreeFixture("twining-am-rel-");
    const result = runHook({
      script: "activity-marker-hook.sh",
      stdin: JSON.stringify({ session_id: "sess-w", tool_name: "Edit" }),
      env: { TWINING_PROJECT: "main" },
      cwd: fixture.root, // root/main/.twining exists
    });
    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(marker(fixture.main))).toBe(true);
  });

  it("TWINING_WORKTREE_LOCAL=true keeps the worktree-local store", () => {
    fixture = makeWorktreeFixture("twining-am-wtlocal-");
    fs.mkdirSync(path.join(fixture.wt, ".twining"));
    const result = runHook({
      script: "activity-marker-hook.sh",
      stdin: JSON.stringify({ session_id: "sess-w", tool_name: "Edit" }),
      env: { TWINING_WORKTREE_LOCAL: "true" },
      cwd: fixture.wt,
    });
    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(marker(fixture.wt))).toBe(true);
    expect(fs.existsSync(marker(fixture.main))).toBe(false);
  });

  it("nested worktree + TWINING_WORKTREE_LOCAL=true never touches the main store", () => {
    // `git worktree add ./wts/feat` layout: the worktree is INSIDE the main
    // checkout. The boundary must stop the walk at the worktree root — the
    // marker must not land in main's .sessions/ (the store the server, which
    // resolves cwd-local under the opt-out, never reads).
    fixture = makeWorktreeFixture("twining-am-wtnested-", { nested: true });
    const result = runHook({
      script: "activity-marker-hook.sh",
      stdin: JSON.stringify({ session_id: "sess-w", tool_name: "Edit" }),
      env: { TWINING_WORKTREE_LOCAL: "true" },
      cwd: fixture.wt,
    });
    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(marker(fixture.main))).toBe(false);
    expect(fs.existsSync(path.join(fixture.wt, ".twining"))).toBe(false);
  });

  it("submodule gitdir (.git/modules/...) never redirects", () => {
    fixture = makeWorktreeFixture("twining-am-submod-");
    // parent/sub is a submodule checkout with its own .twining: .git is a
    // FILE, but its gitdir points at .git/modules/ — must stay local.
    const sub = path.join(fixture.root, "sub");
    fs.mkdirSync(path.join(sub, ".twining"), { recursive: true });
    fs.mkdirSync(path.join(fixture.root, ".git", "modules", "sub"), {
      recursive: true,
    });
    fs.writeFileSync(path.join(sub, ".git"), "gitdir: ../.git/modules/sub\n");
    const result = runHook({
      script: "activity-marker-hook.sh",
      stdin: JSON.stringify({ session_id: "sess-w", tool_name: "Edit" }),
      cwd: sub,
    });
    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(marker(sub))).toBe(true);
  });
});
