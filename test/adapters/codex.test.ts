/**
 * Codex adapter — same capture, different injection channels.
 *
 * The assertions that matter here are the NEGATIVE ones: Codex has seven
 * observe-only events, and the failure mode this file exists to prevent is an
 * adapter that emits `additionalContext` on one of them, gets it dropped by
 * the host's own output schema, and reports the event as covered anyway.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CODEX_MATRIX, CODEX_INJECTING_EVENTS, codexCoverage, handleCodexHook } from "../../src/adapters/codex.js";
import { findProseReminders } from "../../src/adapters/host-capability.js";
import { makeFixture, runtimeFor, seedDecision, type Fixture } from "./helpers.js";

let fx: Fixture;
beforeEach(() => {
  fx = makeFixture("twining-codex-");
});
afterEach(() => {
  fx.cleanup();
});

const deps = (runtime: ReturnType<typeof runtimeFor>) => ({ runtime, ingress: "adapter" as const });

describe("the matrix matches the shipped binary's schemas", () => {
  it("exactly five events can inject", () => {
    expect([...CODEX_INJECTING_EVENTS].sort()).toEqual(
      ["PostToolUse", "PreToolUse", "SessionStart", "SubagentStart", "UserPromptSubmit"].sort(),
    );
  });

  it("the seven observe-only events all declare injects:false with a reason", () => {
    const observeOnly = ["PermissionRequest", "PreCompact", "PostCompact", "SessionEnd", "Stop", "SubagentStop", "Interrupt"];
    for (const name of observeOnly) {
      const row = CODEX_MATRIX.events.find((e) => e.event === name);
      expect(row, `${name} must appear in the matrix`).toBeTruthy();
      expect(row!.injects, `${name} must not claim injection`).toBe(false);
      expect(row!.channel).toBeNull();
      expect(row!.note ?? "", `${name} must say WHY it cannot inject`).toMatch(/CANNOT INJECT|does not use/);
    }
  });

  it("states plainly what this host cannot observe at all", () => {
    expect(CODEX_MATRIX.cannotObserve.join(" ")).toMatch(/Notification/);
    expect(CODEX_MATRIX.cannotObserve.join(" ")).toMatch(/TurnStart/);
  });
});

describe("injection suppression on observe-only events", () => {
  it("SubagentStop captures the return but emits NOTHING on stdout", async () => {
    const runtime = runtimeFor(fx);
    const out = await handleCodexHook(
      "SubagentStop",
      { hook_event_name: "SubagentStop", session_id: "s", turn_id: "t1", agent_id: "w1", agent_type: "reviewer", cwd: fx.projectRoot },
      deps(runtime),
    );
    expect(out.stdout).toBe("");
    // The CAPTURE still happened — suppression is about the channel, not the record.
    const created = out.events.find((e) => e.kind === "created");
    expect(created?.evidence_class).toBe("reported_result");
    runtime.close();
  });

  it("Stop cannot inject, and says the records reach the model on a later event instead", async () => {
    const seed = runtimeFor(fx);
    await seedDecision(seed, "a decision made during a Codex turn");
    seed.close();

    const runtime = runtimeFor(fx);
    const out = await handleCodexHook(
      "Stop",
      { hook_event_name: "Stop", session_id: "s", turn_id: "t1", cwd: fx.projectRoot },
      deps(runtime),
    );
    expect(out.stdout).toBe("");
    expect(out.injected).toBeUndefined();
    expect(out.notes.join(" ")).toMatch(/cannot inject context/);
    expect(out.notes.join(" ")).toMatch(/SessionStart or UserPromptSubmit/);
    runtime.close();
  });

  it("SessionStart CAN inject — and that is the post-compaction re-seeding path", async () => {
    const seed = runtimeFor(fx);
    await seedDecision(seed, "survives the compaction and comes back at resume");
    seed.close();

    const runtime = runtimeFor(fx);
    const compacted = await handleCodexHook(
      "PreCompact",
      { hook_event_name: "PreCompact", session_id: "s", turn_id: "t1", trigger: "auto", cwd: fx.projectRoot },
      deps(runtime),
    );
    expect(compacted.stdout).toBe("");

    const resumed = await handleCodexHook(
      "SessionStart",
      { hook_event_name: "SessionStart", session_id: "s", source: "resume", cwd: fx.projectRoot },
      deps(runtime),
    );
    const payload = JSON.parse(resumed.stdout);
    expect(payload.hookSpecificOutput.additionalContext).toContain("survives the compaction");
    expect(findProseReminders(payload.hookSpecificOutput.additionalContext)).toEqual([]);
    runtime.close();
  });
});

describe("turn identity", () => {
  it("turn_id (Codex) fills the turn the same way prompt_id (Claude Code) does", async () => {
    const runtime = runtimeFor(fx);
    const out = await handleCodexHook(
      "UserPromptSubmit",
      { hook_event_name: "UserPromptSubmit", session_id: "s", turn_id: "codex-turn-9", prompt: "hello", cwd: fx.projectRoot },
      deps(runtime),
    );
    const receipt = out.events.find((e) => e.kind === "receipt");
    // There is a receipt only when something was injected; when there was
    // nothing new, the capture still stands and no receipt is invented.
    if (receipt) expect((receipt.payload as Record<string, unknown>).turn).toBe("codex-turn-9");
    expect(out.events.some((e) => e.evidence_class === "human_statement")).toBe(true);
    runtime.close();
  });
});

describe("honest coverage", () => {
  it("never claims another backend's evidence and lists where it can inject", () => {
    const cov = codexCoverage();
    expect(cov.cross_backend_substitution_claims).toEqual([]);
    expect(cov.injects_on).toContain("SessionStart");
    expect(cov.injects_on).not.toContain("PreCompact");
  });
});
