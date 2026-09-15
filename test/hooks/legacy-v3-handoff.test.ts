/**
 * The v3 handoff guard in the LEGACY hooks.
 *
 * Why this file exists: the flipped gap-1 test spawns `v3-capture-hook.sh`
 * directly, so it proves the v3 path injects the working set — and proves
 * nothing at all about whether the 2.x path stopped. Those are different
 * scripts, and the review found the guard that was supposed to silence the old
 * one was mis-quoted and never matched. Both payloads reached the model on a
 * v3 store, gate prose and all (C15 A2-NO-PROSE).
 *
 * So the assertions here run the legacy scripts themselves, against a real
 * format-3 store, and each is paired with a 2.x control proving the script
 * still does its old job when it should.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runHook } from "./run-hook";

let dir: string;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "twining-handoff-")));
  fs.mkdirSync(path.join(dir, ".twining"), { recursive: true });
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Write a store.json in the shape the real CLI writes it (pretty-printed). */
function writeStore(format: number): void {
  fs.writeFileSync(
    path.join(dir, ".twining", "store.json"),
    JSON.stringify(
      { store_id: "s_01ARZ3NDEKTSV4RRFFQ69G5FAV", repo_ids: ["r_01ARZ3NDEKTSV4RRFFQ69G5FAV"], format, created_at: "2026-09-15T00:00:00.000Z" },
      null,
      2,
    ) + "\n",
  );
}

const sessionStartPayload = (): string =>
  JSON.stringify({ session_id: "s", hook_event_name: "SessionStart", source: "startup", cwd: dir });

const subagentStopPayload = (): string =>
  JSON.stringify({ hook_event_name: "SubagentStop", agent_type: "code-reviewer", session_id: "s", transcript_path: path.join(dir, "t.jsonl") });

describe("session-start-context.sh", () => {
  it("CONTROL: on a 2.x store it still injects the gate context", () => {
    const r = runHook({ script: "session-start-context.sh", stdin: sessionStartPayload(), cwd: dir });
    expect(r.exitCode).toBe(0);
    // The instrument is live: the legacy hook really does produce its payload.
    expect(r.stdout.length).toBeGreaterThan(0);
    expect(r.stdout).toContain("Gate 1");
  });

  it("CONTROL: a format-2 store.json does not silence it either", () => {
    writeStore(2);
    const r = runHook({ script: "session-start-context.sh", stdin: sessionStartPayload(), cwd: dir });
    expect(r.stdout).toContain("Gate 1");
  });

  it("on a FORMAT-3 store it emits nothing — the v3 hook owns the event", () => {
    writeStore(3);
    const r = runHook({ script: "session-start-context.sh", stdin: sessionStartPayload(), cwd: dir });
    expect(r.exitCode).toBe(0);
    // Not merely "no gate prose": nothing at all, or two payloads reach the
    // model on the same event.
    expect(r.stdout).toBe("");
    expect(r.stdout).not.toContain("Gate 1");
    expect(r.stdout).not.toContain("Gate 2");
  });
});

describe("subagent-stop-hook.sh", () => {
  it("CONTROL: on a 2.x store it still queues the generic pending post", () => {
    const r = runHook({ script: "subagent-stop-hook.sh", stdin: subagentStopPayload(), cwd: dir });
    expect(r.exitCode).toBe(0);
    const pending = path.join(dir, ".twining", "pending-posts.jsonl");
    expect(fs.existsSync(pending)).toBe(true);
    expect(fs.readFileSync(pending, "utf8")).toContain("Subagent completed: code-reviewer");
  });

  it("on a FORMAT-3 store it writes no pending post — the v3 capture owns it", () => {
    writeStore(3);
    const r = runHook({ script: "subagent-stop-hook.sh", stdin: subagentStopPayload(), cwd: dir });
    expect(r.exitCode).toBe(0);
    // A 2.x pending post alongside the v3 reported_result would double-count
    // the same worker return in two different shapes.
    expect(fs.existsSync(path.join(dir, ".twining", "pending-posts.jsonl"))).toBe(false);
  });
});

describe("the guard pattern itself", () => {
  it("matches a pretty-printed store.json, which is the shape actually written", () => {
    writeStore(3);
    const raw = fs.readFileSync(path.join(dir, ".twining", "store.json"), "utf8");
    // The literal the hooks grep for. Written out here so a future edit to the
    // scripts' quoting cannot silently stop matching without failing a test.
    expect(raw).toMatch(/"format"[ \t]*:[ \t]*3/);
  });
});
