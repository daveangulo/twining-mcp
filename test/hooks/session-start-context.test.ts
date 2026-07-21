// test/hooks/session-start-context.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runHook } from "./run-hook";

const EXPECTED_CONTEXT_FRAGMENT = "Twining MCP tools are available";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-ssc-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

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

  it("emits a PATH warning instead of the gates when npx is not on PATH", () => {
    fs.mkdirSync(path.join(dir, ".twining"));
    // Simulate a PATH-restricted spawn (e.g. a cmux teammate): a shim dir
    // holding only the utilities the hook needs, with npx absent.
    const shimDir = path.join(dir, "shim-bin");
    fs.mkdirSync(shimDir);
    for (const util of ["bash", "dirname", "cat"]) {
      const real = spawnSync("bash", ["-c", `command -v ${util}`], { encoding: "utf8" })
        .stdout.trim();
      fs.symlinkSync(real, path.join(shimDir, util));
    }
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
    // The gates must be suppressed — they are unsatisfiable without the server.
    expect(payload.hookSpecificOutput.additionalContext).not.toContain("Gate 1");
    expect(payload.hookSpecificOutput.additionalContext).not.toContain(EXPECTED_CONTEXT_FRAGMENT);
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
