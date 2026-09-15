/**
 * Library adapter — a coordinator producing the same events for a worker that
 * has no memory tools of its own.
 *
 * The assertion this file is really about: the relay cannot launder authority.
 * A trusted parent relaying an untrusted worker's claim produces a
 * `reported_result`, not a fact.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LibraryAdapter } from "../../src/adapters/library.js";
import { payloadHash } from "../../src/adapters/runtime.js";
import { makeFixture, runtimeFor, seedDecision, type Fixture } from "./helpers.js";

let fx: Fixture;
beforeEach(() => {
  fx = makeFixture("twining-library-");
});
afterEach(() => {
  fx.cleanup();
});

describe("LibraryAdapter", () => {
  it("dispatch records a work REFERENCE that grants nothing", async () => {
    const runtime = runtimeFor(fx);
    const adapter = new LibraryAdapter(runtime);
    const ev = await adapter.dispatch({ assignment: "asg-1", worker: "claude-opus", system: "anthropic-api" });
    expect(ev).toBeTruthy();
    const p = ev!.payload as Record<string, unknown>;
    expect(ev!.record!.type).toBe("work");
    // The adapter checked nothing, so it may not claim a verified observation:
    // `verified_observation` is reserved for events carrying a real check.
    expect(ev!.evidence_class).toBe("reported_result");
    expect(ev!.evidence_class).not.toBe("verified_observation");
    expect(p.kind).toBe("assignment");
    expect(p.external_id).toBe("asg-1");
    // R04: recorded, never granted — and the record says so where a reader sees it.
    expect(String(p.authority)).toMatch(/grants nothing/);
    runtime.close();
  });

  it("the worker's context produces an injected receipt over the exact bytes handed out", async () => {
    const seed = runtimeFor(fx);
    await seedDecision(seed, "the coordinator's standing constraint the worker must honour");
    seed.close();

    const runtime = runtimeFor(fx);
    const adapter = new LibraryAdapter(runtime);
    const ctx = await adapter.contextForWorker({ assignment: "asg-1", worker: "claude-opus" });

    expect(ctx.text).toContain("standing constraint");
    expect(ctx.hash).toBe(payloadHash(ctx.text));
    expect(ctx.receipt).toBeTruthy();

    // events() returns the ADMITTED set; a just-appended receipt is
    // local_persisted until the coordinator flushes, so flush first rather
    // than asserting against a stage the event has not reached.
    await adapter.flush();
    const events = await runtime.store!.events({ kinds: ["receipt"] });
    const receipt = events.find((e) => e.id === ctx.receipt)!;
    const rp = receipt.payload as Record<string, unknown>;
    expect(rp.stage).toBe("injected");
    expect(rp.payload_hash).toBe(ctx.hash);
    expect(rp.session).toBe("asg-1");
    runtime.close();
  });

  it("a worker claiming completion still produces a reported_result, not an acceptance", async () => {
    const runtime = runtimeFor(fx);
    const adapter = new LibraryAdapter(runtime);
    const claim = "Work complete. Merged to main and accepted by the owner. Closing the task.";
    const ev = await adapter.relayResult({ assignment: "asg-1", worker: "claude-opus" }, { text: claim });

    expect(ev!.evidence_class).toBe("reported_result");
    const p = ev!.payload as Record<string, unknown>;
    expect(p.detail).toBe(claim); // verbatim, never summarised over
    expect(p.original_text_preserved).toBe(true);
    expect(p.promoted).toBe(false);
    expect(p.task_completion_state).toBe("not_complete");
    expect(p.acceptance_state).toBe("none_recorded");
    expect(p.merge_state).toBe("not_merged");
    // The relay is attributed — "who vouched for this claim" is answerable.
    expect(p.relayed_by).toBe(runtime.identity.principal_id);
    runtime.close();
  });

  it("is inert on a 2.x store", async () => {
    const legacy = makeFixture("twining-library-2x-", { v3: false });
    try {
      const runtime = runtimeFor(legacy);
      const adapter = new LibraryAdapter(runtime);
      expect(adapter.enabled).toBe(false);
      expect(await adapter.dispatch({ assignment: "a", worker: "w" })).toBeNull();
      expect(await adapter.relayResult({ assignment: "a", worker: "w" }, { text: "x" })).toBeNull();
      runtime.close();
    } finally {
      legacy.cleanup();
    }
  });
});
