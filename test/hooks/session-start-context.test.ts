// test/hooks/session-start-context.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeWorktreeFixture, runHook } from "./run-hook";

const EXPECTED_CONTEXT_FRAGMENT = "Twining MCP tools are available";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-ssc-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Shim dir holding symlinks to only the named real binaries — simulates a
 * PATH-restricted spawn (e.g. a cmux teammate). `node` resolves via
 * process.execPath: `command -v node` could return a version-manager shim
 * that breaks under the restricted PATH, while execPath is the real binary
 * running vitest.
 */
function makeShim(utils: string[]): string {
  const shimDir = path.join(dir, "shim-bin");
  fs.mkdirSync(shimDir);
  for (const util of utils) {
    const real =
      util === "node"
        ? process.execPath
        : spawnSync("bash", ["-c", `command -v ${util}`], { encoding: "utf8" })
            .stdout.trim();
    fs.symlinkSync(real, path.join(shimDir, util));
  }
  return shimDir;
}

/**
 * Fake HOME whose ~/.profile pins PATH to the shim dir. The hook probes the
 * launcher through a login shell (`sh -lc`, mirroring the server spawn), and
 * login shells rebuild PATH from /etc/profile (macOS path_helper, CI distro
 * defaults) — which resurrects the real npx and defeats the shim. ~/.profile
 * runs after /etc/profile, so it wins on macOS and Linux alike.
 */
function makeLoginHome(shimDir: string): string {
  const home = path.join(dir, "home");
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, ".profile"), `PATH="${shimDir}"\nexport PATH\n`);
  return home;
}

describe("session-start-context.sh", () => {
  it("emits a JSON envelope with hookSpecificOutput.additionalContext in a twining project", () => {
    fs.mkdirSync(path.join(dir, ".twining"));
    const result = runHook({ script: "session-start-context.sh", cwd: dir });
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(payload.hookSpecificOutput.additionalContext).toContain(EXPECTED_CONTEXT_FRAGMENT);
    expect(payload.hookSpecificOutput.additionalContext).toContain("twining_assemble");
    expect(payload.hookSpecificOutput.additionalContext).toContain("twining_record");
    // Gates delivery moved here from the removed ensure-claude-md-gates.sh —
    // the context must carry the full gate guidance, not just a reminder.
    expect(payload.hookSpecificOutput.additionalContext).toContain("Gate 1");
    expect(payload.hookSpecificOutput.additionalContext).toContain("Gate 2");
    expect(payload.hookSpecificOutput.additionalContext).toContain("findings");
  });

  it("exits 0 with no output when no .twining/ directory exists", () => {
    const result = runHook({ script: "session-start-context.sh", cwd: dir });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it("exits 0 with no output when TWINING_DISABLED=true", () => {
    fs.mkdirSync(path.join(dir, ".twining"));
    const result = runHook({
      script: "session-start-context.sh",
      env: { TWINING_DISABLED: "true" },
      cwd: dir,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it("emits a PATH warning instead of the gates when the probe finds no runtime at all", () => {
    fs.mkdirSync(path.join(dir, ".twining"));
    // Shim holds only the utilities the hook itself needs — no sh, no node,
    // so the launcher probe fails entirely (runner=none node=none).
    const shimDir = makeShim(["bash", "dirname", "cat"]);
    const result = runHook({
      script: "session-start-context.sh",
      env: { PATH: shimDir },
      cwd: dir,
    });
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(payload.hookSpecificOutput.additionalContext).toContain("npx");
    expect(payload.hookSpecificOutput.additionalContext).toContain("MCP server unavailable");
    // The commit gate still blocks in initialized checkouts — the warning
    // must carry the escape hatch, not the false "gates do NOT apply" claim.
    expect(payload.hookSpecificOutput.additionalContext).toContain("TWINING_DISABLED");
    expect(payload.hookSpecificOutput.additionalContext).not.toContain("gates do NOT apply");
    // The gates must be suppressed — they are unsatisfiable without the server.
    expect(payload.hookSpecificOutput.additionalContext).not.toContain("Gate 1");
    expect(payload.hookSpecificOutput.additionalContext).not.toContain(EXPECTED_CONTEXT_FRAGMENT);
  });

  it("emits the gates when node exists but npm/npx do not (bundled rung rescues the npm-less distro)", () => {
    fs.mkdirSync(path.join(dir, ".twining"));
    // sh + node but no npm tree and no npx: the launcher probe now reports
    // runner=bundled (the plugin ships a server bundle), so the gates apply.
    const shimDir = makeShim(["bash", "dirname", "cat", "sh", "node"]);
    const result = runHook({
      script: "session-start-context.sh",
      env: { PATH: shimDir, HOME: makeLoginHome(shimDir) },
      cwd: dir,
    });
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    const ctx = payload.hookSpecificOutput.additionalContext;
    expect(ctx).toContain(EXPECTED_CONTEXT_FRAGMENT);
    expect(ctx).toContain("Gate 1");
    expect(ctx).not.toContain("MCP server unavailable");
  });

  it("emits the node-found warning with the probed version when node is too old for the bundle", () => {
    fs.mkdirSync(path.join(dir, ".twining"));
    // Fake node answering --version with v18.19.0: too old for the bundled
    // rung, and no npm/npx/global — the probe reports runner=none with a
    // node version, so the hook must warn (with the version interpolated)
    // and suppress the gates.
    const shimDir = makeShim(["bash", "dirname", "cat", "sh"]);
    fs.writeFileSync(
      path.join(shimDir, "node"),
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "v18.19.0"; exit 0; fi\nexit 1\n',
      { mode: 0o755 },
    );
    const result = runHook({
      script: "session-start-context.sh",
      env: { PATH: shimDir, HOME: makeLoginHome(shimDir) },
      cwd: dir,
    });
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    const ctx = payload.hookSpecificOutput.additionalContext;
    expect(ctx).toContain("MCP server unavailable");
    expect(ctx).toContain("v18.19.0"); // interpolated probed node version
    expect(ctx).toContain("TWINING_DISABLED");
    expect(ctx).not.toContain("Gate 1");
    expect(ctx).not.toContain(EXPECTED_CONTEXT_FRAGMENT);
  });

  it("emits the gates when the launcher probe resolves a runner (working npx on PATH)", () => {
    fs.mkdirSync(path.join(dir, ".twining"));
    const shimDir = makeShim(["bash", "dirname", "cat", "sh", "node"]);
    // Fake npx that answers --version: the launcher's execution probe
    // resolves runner=npx, so the full gates context must be emitted.
    fs.writeFileSync(path.join(shimDir, "npx"), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
    const result = runHook({
      script: "session-start-context.sh",
      env: { PATH: shimDir, HOME: makeLoginHome(shimDir) },
      cwd: dir,
    });
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.hookSpecificOutput.additionalContext).toContain(EXPECTED_CONTEXT_FRAGMENT);
    expect(payload.hookSpecificOutput.additionalContext).toContain("Gate 1");
  });

  it("emits the JSON envelope when TWINING_DISABLED is set to a non-true value (e.g. '1')", () => {
    fs.mkdirSync(path.join(dir, ".twining"));
    const result = runHook({
      script: "session-start-context.sh",
      env: { TWINING_DISABLED: "1" },
      cwd: dir,
    });
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.hookSpecificOutput.hookEventName).toBe("SessionStart");
  });

  it("linked worktree: injects context and prunes markers in the MAIN checkout's store", () => {
    const fixture = makeWorktreeFixture("twining-ssc-wt-");
    try {
      const sessionsDir = path.join(fixture.main, ".twining", ".sessions");
      fs.mkdirSync(sessionsDir, { recursive: true });
      const oldMarker = path.join(sessionsDir, "ancient-session");
      fs.writeFileSync(oldMarker, "1");
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      fs.utimesSync(oldMarker, eightDaysAgo, eightDaysAgo);

      const result = runHook({ script: "session-start-context.sh", cwd: fixture.wt });

      expect(result.exitCode).toBe(0);
      // Without the redirect the worktree has no .twining → silent exit.
      const payload = JSON.parse(result.stdout);
      expect(payload.hookSpecificOutput.hookEventName).toBe("SessionStart");
      expect(fs.existsSync(oldMarker)).toBe(false); // pruned in MAIN's store
    } finally {
      fixture.cleanup();
    }
  });

  it("TWINING_PROJECT: injects context for the targeted store from an unmanaged cwd", () => {
    const fixture = makeWorktreeFixture("twining-ssc-proj-");
    try {
      const result = runHook({
        script: "session-start-context.sh",
        env: { TWINING_PROJECT: fixture.main },
        cwd: fixture.root, // no .twining, no .git here
      });
      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.hookSpecificOutput.hookEventName).toBe("SessionStart");
    } finally {
      fixture.cleanup();
    }
  });

  it("TWINING_WORKTREE_LOCAL=true: keeps worktree-local (no store → silent exit)", () => {
    const fixture = makeWorktreeFixture("twining-ssc-wtlocal-");
    try {
      const result = runHook({
        script: "session-start-context.sh",
        env: { TWINING_WORKTREE_LOCAL: "true" },
        cwd: fixture.wt, // has no .twining of its own
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("");
    } finally {
      fixture.cleanup();
    }
  });

  it("prunes session activity markers older than 7 days, keeps recent ones (#43)", () => {
    const sessionsDir = path.join(dir, ".twining", ".sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    const oldMarker = path.join(sessionsDir, "ancient-session");
    const newMarker = path.join(sessionsDir, "recent-session");
    fs.writeFileSync(oldMarker, "1");
    fs.writeFileSync(newMarker, String(Math.floor(Date.now() / 1000)));
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldMarker, eightDaysAgo, eightDaysAgo);

    const result = runHook({ script: "session-start-context.sh", cwd: dir });

    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(oldMarker)).toBe(false);
    expect(fs.existsSync(newMarker)).toBe(true);
  });
});
