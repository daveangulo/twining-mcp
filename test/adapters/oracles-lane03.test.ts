/**
 * Oracle-derived assertions reachable from lane 03 (the runtime): C06, C15, C27.
 *
 * Scope discipline, stated up front. Each of these cases spans several lanes;
 * this file asserts ONLY the facets an adapter/CLI can be held to — capture
 * coverage, injection receipts, byte preservation, delivery-state separation,
 * honest unsupported-host reporting. Facets that belong to retrieval (lane 04),
 * exchange (lane 02) or the action-qualification engine are `it.todo` with the
 * oracle's own id, so the gap is enumerable rather than invisible.
 *
 * Oracle vocabulary is oracle-local by the oracles' own rule; the mapping to
 * implementation names is written out at each assertion instead of being
 * smuggled into a shared type (all three cases name the same concepts
 * differently, and merging two oracle facets into one field is forbidden).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleClaudeCodeHook } from "../../src/adapters/claude-code.js";
import { handleCodexHook, codexCoverage, CODEX_MATRIX } from "../../src/adapters/codex.js";
import { claudeCodeCoverage, CLAUDE_CODE_MATRIX } from "../../src/adapters/claude-code.js";
import { findProseReminders, FORBIDDEN_PROSE_REMINDERS } from "../../src/adapters/host-capability.js";
import { LEGACY_SESSION_START_CONTEXT } from "../../src/adapters/legacy-gate-text.js";
import { LibraryAdapter } from "../../src/adapters/library.js";
import { sha256Hex } from "../../src/contracts/index.js";
import { makeFixture, runtimeFor, seedDecision, type Fixture } from "./helpers.js";

let fx: Fixture;
beforeEach(() => {
  fx = makeFixture("twining-oracle-");
});
afterEach(() => {
  fx.cleanup();
});

const deps = (runtime: ReturnType<typeof runtimeFor>) => ({ runtime, ingress: "adapter" as const });

// ────────────────────────────────────────────────────────────────────── C06

describe("C06 — worker returns while its review remains pending", () => {
  it("A15: capture and post-compaction re-injection happen with NO prose instruction in context", async () => {
    const seed = runtimeFor(fx);
    await seedDecision(seed, "the constraint the parent must still honour after compaction");
    seed.close();

    const runtime = runtimeFor(fx);
    // 1. a worker returns
    await handleClaudeCodeHook(
      "SubagentStop",
      { session_id: "sess-p-114", agent_id: "svc-worker-w7", agent_type: "worker", last_assistant_message: "done", cwd: fx.projectRoot },
      deps(runtime),
    );
    // 2. compaction is observed (this event cannot inject on this host)
    const pre = await handleClaudeCodeHook(
      "PreCompact",
      { session_id: "sess-p-114", trigger: "auto", cwd: fx.projectRoot },
      deps(runtime),
    );
    expect(pre.stdout).toBe("");

    // 3. the receiving turn after compaction
    const after = await handleClaudeCodeHook(
      "SessionStart",
      { session_id: "sess-p-114", source: "compact", prompt_id: "turn-114-08", cwd: fx.projectRoot },
      deps(runtime),
    );
    const delivered: string = JSON.parse(after.stdout).hookSpecificOutput.additionalContext;

    // "with no prose memory instruction in model context"
    expect(findProseReminders(delivered)).toEqual([]);

    // "emitted packet bytes/hash are linked to host / session / turn"
    const receipt = after.events.find((e) => e.kind === "receipt")!;
    const rp = receipt.payload as Record<string, unknown>;
    expect(rp.payload_hash).toBe(`sha256:${sha256Hex(Buffer.from(delivered, "utf-8"))}`);
    expect(rp.host).toBe(runtime.identity.host_id);
    expect(rp.session).toBe("sess-p-114");
    expect(rp.turn).toBe("turn-114-08");
    runtime.close();
  });

  it("A8 (adapter half): an injection receipt is `injected`, never a task acknowledgement", async () => {
    const seed = runtimeFor(fx);
    await seedDecision(seed, "delivered into a turn, which is not the same as accepted");
    seed.close();

    const runtime = runtimeFor(fx);
    const out = await handleClaudeCodeHook(
      "SessionStart",
      { session_id: "s", source: "startup", cwd: fx.projectRoot },
      deps(runtime),
    );
    const stages = out.events.filter((e) => e.kind === "receipt").map((e) => (e.payload as Record<string, unknown>).stage);
    expect(stages).toContain("injected");
    // `inclusion_in_context: delivered` and `task_level_acknowledgement:
    // not_acknowledged` are DIFFERENT states by different principals. Nothing
    // in the adapter can produce the latter, which is how the separation is
    // enforced rather than asserted.
    expect(stages).not.toContain("task_acked");

    await runtime.store!.admit();
    const all = await runtime.store!.events({ kinds: ["receipt"] });
    expect(all.every((e) => (e.payload as Record<string, unknown>).stage !== "task_acked")).toBe(true);
    runtime.close();
  });

  it("A7 / N5: the worker's text is retained verbatim, unpromoted, and no normalized copy replaces it", async () => {
    const runtime = runtimeFor(fx);
    // Awkward bytes on purpose: a normalized re-encoding would change the hash.
    const claim = "﻿Signed off by the reviewer.\r\nMerged.";
    const out = await handleClaudeCodeHook(
      "SubagentStop",
      { session_id: "s", agent_id: "w7", agent_type: "worker", last_assistant_message: claim, cwd: fx.projectRoot },
      deps(runtime),
    );
    const created = out.events.find((e) => e.kind === "created")!;
    const p = created.payload as Record<string, unknown>;

    expect(created.evidence_class).toBe("reported_result");
    expect(p.detail).toBe(claim);
    expect(p.promoted).toBe(false);
    expect(p.original_text_preserved).toBe(true);
    // The attachment hashes the ORIGINAL octets; there is exactly one, so no
    // normalized variant can shadow it.
    expect(created.attachments).toHaveLength(1);
    expect(created.attachments![0]!.sha256).toBe(sha256Hex(Buffer.from(claim, "utf-8")));
    runtime.close();
  });

  it("N1: no field of the captured return says the work is complete, accepted or merged", async () => {
    const runtime = runtimeFor(fx);
    const out = await handleClaudeCodeHook(
      "SubagentStop",
      { session_id: "s", agent_id: "w7", agent_type: "worker", last_assistant_message: "x", cwd: fx.projectRoot },
      deps(runtime),
    );
    const p = out.events.find((e) => e.kind === "created")!.payload as Record<string, unknown>;
    // Every state field that COULD claim completion is present and negative.
    expect(p.task_completion_state).toBe("not_complete");
    expect(p.acceptance_state).toBe("none_recorded");
    expect(p.merge_state).toBe("not_merged");
    runtime.close();
  });

  it.todo("C06 A1–A5, A12–A14: current applicable view + action qualification (qualification engine, not lane 03)");
  it.todo("C06 A9/A10: redelivery dedup and conflicting-identity quarantine (lane 02 exchange)");
  it.todo("C06 N2 + recall_scope: scope-filtered recall across every retrieval path (lane 04)");
});

// ────────────────────────────────────────────────────────────────────── C15

describe("C15 — Codex parent/worker lifecycle, compaction, second backend", () => {
  it("A1-CAP-COVERAGE: five lifecycle points are captured, each bound to host/session", async () => {
    const runtime = runtimeFor(fx);
    const captured: string[] = [];

    const record = async (event: string, input: Record<string, unknown>, kind: string) => {
      const out = await handleCodexHook(event, { ...input, cwd: fx.projectRoot }, deps(runtime));
      if (out.events.some((e) => e.kind === "created")) captured.push(kind);
    };

    await record("SessionStart", { session_id: "sess-A", source: "startup" }, "session_start");
    await record("SubagentStart", { session_id: "sess-A", turn_id: "t1", agent_id: "att-1", agent_type: "w" }, "dispatch");
    await record("SubagentStop", { session_id: "sess-A", turn_id: "t1", agent_id: "att-1", agent_type: "w", last_assistant_message: "r" }, "worker_return");
    await record("PreCompact", { session_id: "sess-A", turn_id: "t2", trigger: "auto" }, "compaction");
    await record("SessionStart", { session_id: "sess-A", source: "resume" }, "session_resume");

    expect(captured).toEqual(["session_start", "dispatch", "worker_return", "compaction", "session_resume"]);

    await runtime.store!.admit();
    const events = (await runtime.store!.events({})).filter((e) => e.kind === "created");
    // Each carries host and session identity, not just a timestamp.
    for (const e of events) {
      expect(e.producer.host).toBe(runtime.identity.host_id);
      expect(e.producer.principal).toBe(runtime.identity.principal_id);
    }
    runtime.close();
  });

  it("A2-NO-PROSE: zero forbidden substrings across every delivered payload", async () => {
    const seed = runtimeFor(fx);
    await seedDecision(seed, "a fact that arrives without being asked for");
    seed.close();

    const runtime = runtimeFor(fx);
    const delivered: string[] = [];
    for (const [event, input] of [
      ["SessionStart", { session_id: "s", source: "startup" }],
      ["UserPromptSubmit", { session_id: "s", turn_id: "t1", prompt: "go" }],
      ["SubagentStart", { session_id: "s", turn_id: "t1", agent_id: "a", agent_type: "w" }],
      ["Stop", { session_id: "s", turn_id: "t1" }],
      ["SessionEnd", { session_id: "s", reason: "other" }],
    ] as Array<[string, Record<string, unknown>]>) {
      const out = await handleCodexHook(event, { ...input, cwd: fx.projectRoot }, deps(runtime));
      if (out.injected) delivered.push(out.injected.text);
    }

    const union = delivered.join("\n");
    expect(union.length, "the union must be non-empty or the scan proves nothing").toBeGreaterThan(0);
    for (const forbidden of FORBIDDEN_PROSE_REMINDERS) {
      expect(union, `forbidden reminder present: ${forbidden}`).not.toContain(forbidden);
    }
    runtime.close();
  });

  it("PROSE-REMINDER FALLBACK ON (instrument control): the scan MUST fail when the fallback is on", async () => {
    // The control the oracle demands: with the prose fallback enabled, A2 fails
    // while coverage still reads 5/5 — proving that coverage alone never
    // demonstrates hook-driven capture.
    const legacy = makeFixture("twining-oracle-2x-", { v3: false });
    try {
      const runtime = runtimeFor(legacy);
      const out = await handleClaudeCodeHook(
        "SessionStart",
        { session_id: "s", source: "startup", cwd: legacy.projectRoot },
        { runtime, ingress: "adapter", legacyGateText: LEGACY_SESSION_START_CONTEXT },
      );
      const delivered: string = JSON.parse(out.stdout).hookSpecificOutput.additionalContext;
      // The instrument fires — so its silence on the v3 path above is real.
      expect(findProseReminders(delivered).length).toBeGreaterThan(0);
      // ...and coverage is unaffected, which is the point of the control.
      expect(claudeCodeCoverage().captured).toBe(claudeCodeCoverage().required_lifecycle_points);
      runtime.close();
    } finally {
      legacy.cleanup();
    }
  });

  it("C1-INJECTION-TRACE-COMPLETE (adapter half): the receipt names ids, hash and the receiving triple", async () => {
    const seed = runtimeFor(fx);
    const id = await seedDecision(seed, "a record whose delivery must be traceable");
    seed.close();

    const runtime = runtimeFor(fx);
    const out = await handleClaudeCodeHook(
      "SessionStart",
      { session_id: "sess-t1", source: "startup", prompt_id: "t1", cwd: fx.projectRoot },
      deps(runtime),
    );
    const rp = out.events.find((e) => e.kind === "receipt")!.payload as Record<string, unknown>;
    expect(rp.events).toContain(id); // record ids...
    expect(rp.payload_hash).toBeTruthy(); // ...emitted byte hash...
    expect([rp.host, rp.session, rp.turn]).toEqual([runtime.identity.host_id, "sess-t1", "t1"]); // ...receiving triple
    runtime.close();
  });

  it("C2-SELECTED-EMITTED-DELIVERED: a budget-dropped record is an explicit omission, never a silent drop", async () => {
    const seed = runtimeFor(fx);
    for (let i = 0; i < 6; i++) {
      await seedDecision(seed, `decision number ${i} with enough text to consume the tiny budget under test`);
    }
    seed.close();

    const runtime = runtimeFor(fx);
    const out = await handleClaudeCodeHook(
      "SessionStart",
      { session_id: "s", source: "startup", cwd: fx.projectRoot },
      { runtime, ingress: "adapter", budget: 320 },
    );
    const inj = out.injected!;
    expect(inj.selected).toBeGreaterThan(inj.emitted.length);
    expect(inj.omitted.length).toBe(inj.selected - inj.emitted.length);
    // The omission is stated IN the delivered payload too, with a count — a
    // reader of the packet can tell it is incomplete without consulting a log.
    expect(inj.text).toMatch(/further record\(s\) matched but did not fit the budget/);
    runtime.close();
  });

  it("C3-BYTE-DISTINCTNESS: a BOM/CRLF variant hashes differently and is not conflated", async () => {
    const runtime = runtimeFor(fx);
    const plain = "review the ledger migration";
    const variant = `﻿${plain}\r\n`;

    const a = await handleClaudeCodeHook(
      "UserPromptSubmit",
      { session_id: "s", prompt_id: "t1", prompt: plain, cwd: fx.projectRoot },
      deps(runtime),
    );
    const b = await handleClaudeCodeHook(
      "UserPromptSubmit",
      { session_id: "s", prompt_id: "t2", prompt: variant, cwd: fx.projectRoot },
      deps(runtime),
    );
    const ha = a.events.find((e) => e.kind === "created")!.attachments![0]!.sha256;
    const hb = b.events.find((e) => e.kind === "created")!.attachments![0]!.sha256;
    expect(ha).not.toBe(hb);
    // Recomputing over the stored bytes reproduces the stored hash exactly.
    expect(ha).toBe(sha256Hex(Buffer.from(plain, "utf-8")));
    expect(hb).toBe(sha256Hex(Buffer.from(variant, "utf-8")));
    runtime.close();
  });

  it("D1-CAPABILITY-MATRIX: each host declares captures / injects / cannot_observe", () => {
    for (const matrix of [CLAUDE_CODE_MATRIX, CODEX_MATRIX]) {
      expect(matrix.captures.length).toBeGreaterThan(0);
      expect(Array.isArray(matrix.injects)).toBe(true);
      expect(Array.isArray(matrix.cannotObserve)).toBe(true);
    }
    // Codex genuinely cannot observe things Claude Code can; the matrix says so
    // rather than both hosts claiming the same surface.
    expect(CODEX_MATRIX.cannotObserve.length).toBeGreaterThan(0);
    expect(CODEX_MATRIX.injects).not.toContain("PreCompact");
    expect(CLAUDE_CODE_MATRIX.injects).not.toContain("PreCompact");
  });

  it("D2-UNSUPPORTED-NOT-COVERED: no host claims another backend's evidence", () => {
    expect(claudeCodeCoverage().cross_backend_substitution_claims).toEqual([]);
    expect(codexCoverage().cross_backend_substitution_claims).toEqual([]);
  });

  it("D3-NO-INFERRED-INTEGRATION: an inject is only 'verified' when a receipt for THAT session exists", async () => {
    const seed = runtimeFor(fx);
    await seedDecision(seed, "the parent's context");
    seed.close();

    const runtime = runtimeFor(fx);
    // The PARENT session is injected into...
    await handleClaudeCodeHook(
      "SessionStart",
      { session_id: "sess-parent", source: "startup", cwd: fx.projectRoot },
      deps(runtime),
    );
    // ...and the worker session is captured but never injected into.
    await handleCodexHook(
      "SubagentStop",
      { session_id: "sess-W2", turn_id: "t", agent_id: "w", agent_type: "w", last_assistant_message: "r", cwd: fx.projectRoot },
      deps(runtime),
    );

    await runtime.store!.admit();
    const receipts = await runtime.store!.events({ kinds: ["receipt"] });
    const sessions = receipts
      .filter((e) => (e.payload as Record<string, unknown>).stage === "injected")
      .map((e) => (e.payload as Record<string, unknown>).session);

    // inject_verified for sess-W2 is FALSE — and it is false because no
    // receipt names it, not because of anything the parent's config says.
    expect(sessions).toContain("sess-parent");
    expect(sessions).not.toContain("sess-W2");
    runtime.close();
  });

  it.todo("C15 B1/B2/PC1: whole-envelope token budget and truncated-cannot-qualify (lane 04 + qualification)");
  it.todo("C15 B3: tokenizer fallback labelling (lane 04 owns the tokenizer)");
  it.todo("C15 E1/E2: evidence-class gate on action qualification (qualification engine)");
  it.todo("C15 F1: dedup — 2 receipts, 1 semantic effect (lane 02 exchange)");
  it.todo("C15 F2: cross-tenant candidate exclusion (lane 04 retrieval)");
});

// ────────────────────────────────────────────────────────────────────── C27

describe("C27 — two compactions and a host restart with work pending", () => {
  it("A2: a record already delivered to a turn is not delivered into a second one", async () => {
    const seed = runtimeFor(fx);
    const id = await seedDecision(seed, "delivered exactly once into a receiving turn");
    seed.close();

    const first = runtimeFor(fx);
    const a = await handleClaudeCodeHook(
      "SessionStart",
      { session_id: "sess-PS-32", source: "startup", cwd: fx.projectRoot },
      deps(first),
    );
    expect(a.injected!.emitted).toContain(id);
    first.close();

    // A HOST RESTART: a brand new process/runtime over the same store.
    const afterRestart = runtimeFor(fx);
    const b = await handleClaudeCodeHook(
      "SessionStart",
      { session_id: "sess-PS-32", source: "resume", cwd: fx.projectRoot },
      deps(afterRestart),
    );
    // delivery_count_to_context(id) == 1 — the cursor survived the restart, so
    // the same record is not double-counted as two deliveries.
    expect(b.injected?.emitted ?? []).not.toContain(id);
    afterRestart.close();
  });

  it("A3: local_durable and admitted are separately readable, and differ before a flush", async () => {
    const runtime = runtimeFor(fx);
    const ev = await runtime.append({
      kind: "created",
      recordType: "post",
      evidenceClass: "proposal",
      payload: { entry_type: "finding", summary: "written but not yet admitted" },
      ingress: "cli",
    });

    // Before admission: durable locally, NOT admitted. Reporting the second as
    // the first is the "receipt-state collapse" the oracle's control names —
    // it makes a restart look clean when it was not.
    const before = await runtime.store!.deliveryState(ev!.id);
    expect(before!.state).toBe("local_persisted");
    expect(before!.state).not.toBe("admitted");

    await runtime.store!.admit();
    const after = await runtime.store!.deliveryState(ev!.id);
    expect(["admitted", "projected"]).toContain(after!.state);
    runtime.close();
  });

  it("C2: source bytes survive capture unchanged, and the digest is a separate value from them", async () => {
    const runtime = runtimeFor(fx);
    const bytes = "﻿correction: the ledger cutoff is 14:00 UTC\r\n";
    const out = await handleClaudeCodeHook(
      "UserPromptSubmit",
      { session_id: "s", prompt_id: "t", prompt: bytes, cwd: fx.projectRoot },
      deps(runtime),
    );
    const created = out.events.find((e) => e.kind === "created")!;
    // The oracle asserts stability and INEQUALITY, never a magic literal.
    const sourceHash = created.attachments![0]!.sha256;
    expect(sourceHash).toBe(sha256Hex(Buffer.from(bytes, "utf-8")));
    // The envelope digest covers the canonical envelope, not the source bytes —
    // three different values, three fields.
    expect(created.digest).not.toBe(`sha256:${sourceHash}`);
    const normalized = bytes.replace(/^﻿/, "").replace(/\r\n/g, "\n");
    expect(sourceHash).not.toBe(sha256Hex(Buffer.from(normalized, "utf-8")));
    runtime.close();
  });

  it("G1 (adapter half): the operator report names incomplete work rather than hiding it", async () => {
    const runtime = runtimeFor(fx);
    await runtime.append({
      kind: "created",
      recordType: "post",
      evidenceClass: "proposal",
      payload: { entry_type: "status", summary: "pending at the moment of the restart" },
      ingress: "cli",
    });
    const rows = runtime.store!.journalRows();
    const unadmitted = rows.filter((r) => r.state === "local_persisted");
    // The operator surface (`twining doctor`) counts these separately from
    // admitted ones; an "everything is fine" report after a restart with work
    // outstanding is the failure the oracle is guarding against.
    expect(unadmitted.length).toBeGreaterThan(0);
    runtime.close();
  });

  it.todo("C27 A1/A4/A5: producer cursor, finisher resolution, pending-operation set (store + qualification)");
  it.todo("C27 B1–B3: replay dedup and bytes-conflict classification (lane 02 exchange)");
  it.todo("C27 D1–D4, E1–E3: action gate, instruction isolation, scope isolation, freshness (lanes 04 + qualification)");
});

// ─────────────────────────────────────────────────────── library backend (R11)

describe("second backend without hooks (R11)", () => {
  it("a library-embedded coordinator produces the same capture shape", async () => {
    const runtime = runtimeFor(fx);
    const adapter = new LibraryAdapter(runtime);
    await adapter.dispatch({ assignment: "asg-1", worker: "bedrock-model", system: "bedrock" });
    await adapter.relayResult({ assignment: "asg-1", worker: "bedrock-model" }, { text: "returned" });
    await adapter.flush();

    const records = await runtime.store!.query({});
    expect(records.some((r) => r.record_type === "work")).toBe(true);
    const returned = records.find((r) => r.evidence_class === "reported_result");
    expect(returned, "the worker return must be captured with the same class as a hook capture").toBeTruthy();
    runtime.close();
  });
});
