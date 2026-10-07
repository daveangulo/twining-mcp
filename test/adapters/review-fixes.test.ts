/**
 * Regression pins for the adversarial review of lane/03-runtime (fb35c17).
 *
 * One test per confirmed finding, each written to fail against the code as it
 * was. They live together because they share one property: every one of them
 * was a case where the implementation reported something that had not happened
 * — a receipt for an unreached state, a class claiming a check nobody ran, a
 * host label naming the wrong host. Those are the failures that survive tests
 * written from the happy path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleClaudeCodeHook } from "../../src/adapters/claude-code.js";
import { handleCodexHook } from "../../src/adapters/codex.js";
import { buildWorkingSet } from "../../src/adapters/working-set.js";
import { makeFixture, runtimeFor, seedDecision, type Fixture } from "./helpers.js";

let fx: Fixture;
beforeEach(() => {
  fx = makeFixture("twining-reviewfix-");
});
afterEach(() => {
  vi.restoreAllMocks();
  fx.cleanup();
});

const deps = (runtime: ReturnType<typeof runtimeFor>) => ({ runtime, ingress: "adapter" as const });

describe("#2 — a flush that failed writes no `projected` receipt", () => {
  it("writes the receipt when the projection succeeds (positive control)", async () => {
    const runtime = runtimeFor(fx);
    const out = await handleClaudeCodeHook(
      "Stop",
      { hook_event_name: "Stop", session_id: "s", cwd: fx.projectRoot },
      deps(runtime),
    );
    expect(out.events.some((e) => e.kind === "receipt")).toBe(true);
    runtime.close();
  });

  it("writes NO receipt when project() throws, and says why", async () => {
    const runtime = runtimeFor(fx);
    vi.spyOn(runtime.store!, "project").mockRejectedValue(new Error("disk full"));

    const out = await handleClaudeCodeHook(
      "Stop",
      { hook_event_name: "Stop", session_id: "s", cwd: fx.projectRoot },
      deps(runtime),
    );
    // A `projected` receipt asserts a state the projection never reached.
    expect(out.events.filter((e) => e.kind === "receipt")).toHaveLength(0);
    expect(out.notes.join(" ")).toMatch(/flush failed/);
    expect(out.notes.join(" ")).toMatch(/no receipt written/);
    // ...and the turn is still not broken.
    expect(out.exitCode).toBe(0);
    runtime.close();
  });
});

describe("#3 — budget-omitted records stay reachable", () => {
  it("does not advance the cursor past records the budget dropped", async () => {
    const seed = runtimeFor(fx);
    for (let i = 0; i < 6; i++) {
      await seedDecision(seed, `decision ${i} padded out so a tiny budget must drop some of them`);
    }
    seed.close();

    const runtime = runtimeFor(fx);
    const tiny = await buildWorkingSet(runtime.store!, { scope: runtime.scope, budget: 300 });
    expect(tiny.omitted.length, "the fixture must actually force an omission").toBeGreaterThan(0);
    // With records still undelivered the cursor may not move past them, or the
    // next turn asks for "changes since the newest event" and they are gone.
    expect(tiny.cursor).toBeUndefined();

    // Everything that did not fit is still reachable on the next injection.
    const next = await buildWorkingSet(runtime.store!, {
      scope: runtime.scope,
      budget: 300,
      ...(tiny.cursor ? { sinceEventId: tiny.cursor } : {}),
    });
    for (const dropped of tiny.omitted) {
      expect([...next.included, ...next.omitted]).toContain(dropped);
    }
    runtime.close();
  });

  it("advances the cursor when everything fitted (positive control)", async () => {
    const seed = runtimeFor(fx);
    await seedDecision(seed, "the only record, comfortably inside the budget");
    seed.close();

    const runtime = runtimeFor(fx);
    const ws = await buildWorkingSet(runtime.store!, { scope: runtime.scope, budget: 100_000 });
    expect(ws.omitted).toEqual([]);
    expect(ws.cursor).toBeTruthy();
    runtime.close();
  });
});

describe("#6 — a Codex capture is stamped `codex`", () => {
  it("names the real host in result.host, check_method, system and tags", async () => {
    const runtime = runtimeFor(fx);

    const start = await handleCodexHook(
      "SessionStart",
      { hook_event_name: "SessionStart", session_id: "s", source: "startup", cwd: fx.projectRoot },
      deps(runtime),
    );
    const observation = start.events.find((e) => e.record?.type === "observation")!;
    const payload = observation.payload as { check_method: string; result: Record<string, unknown> };
    expect(payload.result.host).toBe("codex");
    expect(payload.check_method).toContain("codex");
    expect(payload.result.host).not.toBe("claude-code");

    const prompt = await handleCodexHook(
      "UserPromptSubmit",
      { hook_event_name: "UserPromptSubmit", session_id: "s", turn_id: "t1", prompt: "hi", cwd: fx.projectRoot },
      deps(runtime),
    );
    expect((prompt.events.find((e) => e.class === undefined && e.evidence_class === "human_statement")!.payload as { tags: string[] }).tags).toContain("codex");

    const dispatch = await handleCodexHook(
      "SubagentStart",
      { hook_event_name: "SubagentStart", session_id: "s", turn_id: "t1", agent_id: "a1", agent_type: "w", cwd: fx.projectRoot },
      deps(runtime),
    );
    expect((dispatch.events.find((e) => e.record?.type === "work")!.payload as { system: string }).system).toBe("codex");
    runtime.close();
  });

  it("PostCompact records its own kind, distinct from PreCompact", async () => {
    const runtime = runtimeFor(fx);
    const pre = await handleCodexHook(
      "PreCompact",
      { hook_event_name: "PreCompact", session_id: "s", turn_id: "t", trigger: "auto", cwd: fx.projectRoot },
      deps(runtime),
    );
    const post = await handleCodexHook(
      "PostCompact",
      { hook_event_name: "PostCompact", session_id: "s", turn_id: "t", trigger: "auto", cwd: fx.projectRoot },
      deps(runtime),
    );
    const kindOf = (o: typeof pre): unknown =>
      (o.events.find((e) => e.record?.type === "observation")!.payload as { result: { kind: unknown } }).result.kind;
    expect(kindOf(pre)).toBe("compaction");
    expect(kindOf(post)).toBe("post_compaction");
    // Both are Codex captures, and both say so.
    expect((post.events[0]!.payload as { result: { host: string } }).result.host).toBe("codex");
    runtime.close();
  });

  it("a Claude Code capture still says claude-code (positive control)", async () => {
    const runtime = runtimeFor(fx);
    const out = await handleClaudeCodeHook(
      "SessionStart",
      { hook_event_name: "SessionStart", session_id: "s", source: "startup", cwd: fx.projectRoot },
      deps(runtime),
    );
    const payload = out.events.find((e) => e.record?.type === "observation")!.payload as {
      result: { host: string };
    };
    expect(payload.result.host).toBe("claude-code");
    runtime.close();
  });
});
