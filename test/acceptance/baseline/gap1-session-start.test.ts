// test/acceptance/baseline/gap1-session-start.test.ts
//
// Gap 1 (session-start; requirements R10, R11) — BASELINE REPRODUCTION.
//
// Claim under test: at baseline the session-start surface injects *gate
// instructions* only. It never injects the project's *working set* (the
// active decisions the next session needs), and there is no compaction-time
// re-injection surface at all.
//
// Each test pairs a POSITIVE CONTROL (proves the instrument reads the real
// artifact and would see the thing if it were there) with the GAP ASSERTION
// (proves the thing is absent). A failing control means the test is broken,
// not that the gap closed.
//
// Setup idioms mirror test/hooks/session-start-context.test.ts verbatim:
// mkdtempSync per test, runHook() from the shared harness, JSON.parse of
// stdout into hookSpecificOutput.additionalContext.
//
// FLIPPED BY LANE 03 (runtime integration, 2026-09-15). The gap assertions
// below now assert the CLOSED state; the positive controls are unchanged and
// still prove the instrument reads the real artifact. Two things closed it:
//   R11 — plugin/hooks/hooks.json now registers PreCompact and a SessionStart
//         entry whose matcher includes `compact`, so compaction has both a
//         capture point and (through SessionStart) a re-seeding channel.
//   R10 — on a v3-enabled store (.twining/store.json format 3) the capture
//         hook injects the bounded WORKING SET. The 2.x path is deliberately
//         untouched and is kept below as a control: on a store without
//         store.json the legacy hook still injects gate instructions only.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runHook } from "../../hooks/run-hook";
import { bundleCli } from "../../cli/bundle-cli.js";
import { ensureStoreDescriptor } from "../../../src/adapters/identity.js";
import { openRuntime } from "../../../src/adapters/runtime.js";
import { STORE_FORMAT_VERSION } from "../../../src/contracts/index.js";

const HOOKS_JSON = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "plugin",
  "hooks",
  "hooks.json",
);

/** Gate-instruction marker — present in the baseline additionalContext. */
const GATE_INSTRUCTION_MARKER = "twining_assemble";

/**
 * Distinctive enough that it cannot collide with any literal in the hook's
 * static heredoc — if it appears in additionalContext, it came from the store.
 */
const DECISION_SUMMARY =
  "Chose ZORBLAX-QUUX-7741 transport over the legacy pipe — baseline working-set probe";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-gap1-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Seed a file-backend .twining store holding exactly one ACTIVE decision:
 * decisions/index.json (the array the file backend lists from) plus the
 * full decisions/<id>.json record.
 */
function seedActiveDecision(projectRoot: string): void {
  const id = "01ZORBLAXQUUX7741BASELINE0";
  const timestamp = new Date().toISOString();
  const decisionsDir = path.join(projectRoot, ".twining", "decisions");
  fs.mkdirSync(decisionsDir, { recursive: true });

  const indexEntry = {
    id,
    timestamp,
    domain: "architecture",
    scope: "src/transport/",
    summary: DECISION_SUMMARY,
    confidence: "high",
    status: "active",
    affected_files: ["src/transport/zorblax.ts"],
    affected_symbols: [],
    commit_hashes: [],
  };
  fs.writeFileSync(
    path.join(decisionsDir, "index.json"),
    JSON.stringify([indexEntry], null, 2),
  );

  const decision = {
    ...indexEntry,
    agent_id: "baseline-probe",
    context: "Baseline acceptance fixture for gap 1.",
    rationale: "The working set must reach the next session automatically.",
    constraints: [],
    alternatives: [],
    depends_on: [],
    reversible: true,
    assumptions: [],
  };
  fs.writeFileSync(
    path.join(decisionsDir, `${id}.json`),
    JSON.stringify(decision, null, 2),
  );
}

/** SessionStart payload as Claude Code delivers it on stdin. */
function sessionStartPayload(projectRoot: string): string {
  return JSON.stringify({
    session_id: "gap1-baseline-session",
    transcript_path: path.join(projectRoot, "transcript.jsonl"),
    cwd: projectRoot,
    hook_event_name: "SessionStart",
    source: "startup",
  });
}

describe("Gap 1 baseline — session-start context (R10, R11)", () => {
  it("R11: hooks.json registers no compaction-time re-injection surface", () => {
    const raw = fs.readFileSync(HOOKS_JSON, "utf8");
    const parsed = JSON.parse(raw);
    const hooks = parsed.hooks as Record<string, unknown>;

    // POSITIVE CONTROL — the instrument really is reading the plugin's hook
    // registry: the events we know exist are present and shaped as expected.
    expect(hooks).toBeTruthy();
    expect(Object.keys(hooks)).toContain("SessionStart");
    expect(Array.isArray(hooks.SessionStart)).toBe(true);
    expect(JSON.stringify(hooks.SessionStart)).toContain(
      "session-start-context.sh",
    );

    // CLOSED (lane 03) — PreCompact is registered, so compaction is observed...
    expect(Object.keys(hooks)).toContain("PreCompact");
    expect(JSON.stringify(hooks.PreCompact)).toContain("v3-capture-hook.sh");

    // ...and a SessionStart entry matches a compaction source, which is the
    // only channel that can put text back in front of the model afterwards
    // (PreCompact/PostCompact both discard additionalContext on this host).
    const sessionStartEntries = hooks.SessionStart as Array<{
      matcher?: string;
    }>;
    const compactMatchers = sessionStartEntries.filter((entry) =>
      (entry.matcher ?? "").toLowerCase().includes("compact"),
    );
    expect(compactMatchers.length).toBeGreaterThan(0);
  });

  it("R10: the hook injects gate instructions but not the active working set", () => {
    seedActiveDecision(dir);
    // Sanity: the fixture is on disk and readable where the hook would look.
    const indexPath = path.join(dir, ".twining", "decisions", "index.json");
    expect(fs.readFileSync(indexPath, "utf8")).toContain(DECISION_SUMMARY);

    const result = runHook({
      script: "session-start-context.sh",
      stdin: sessionStartPayload(dir),
      cwd: dir,
    });

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.hookSpecificOutput.hookEventName).toBe("SessionStart");
    const ctx: string = payload.hookSpecificOutput.additionalContext;

    // POSITIVE CONTROL — the instrument captured real injected context, and
    // that context does carry the gate instructions. If this fails the test
    // is broken (e.g. the launcher probe found no runner), not the gap.
    expect(ctx).toContain(GATE_INSTRUCTION_MARKER);
    expect(ctx).toContain("Gate 1");

    // CONTROL, NOT A GAP (lane 03): this store has no .twining/store.json, so
    // it is a 2.x store and the legacy hook is still the whole mechanism —
    // gate instructions, no working set. The v3 behavior is asserted below on
    // a v3-enabled store; the two paths must not bleed into each other.
    expect(ctx).not.toContain(DECISION_SUMMARY);
    expect(ctx).not.toContain("ZORBLAX-QUUX-7741");
  });

  it("CLOSED (lane 03): on a v3 store the capture hook injects the working set itself", async () => {
    // The v3 store the adapter writes and reads. Seeding goes through the
    // event store rather than the legacy files, because that IS the change:
    // the working set comes from admitted events, not from decisions/index.json.
    ensureStoreDescriptor(path.join(dir, ".twining"), { format: STORE_FORMAT_VERSION });
    const identityHome = path.join(dir, "identity");
    fs.mkdirSync(identityHome, { recursive: true });
    const env = { ...process.env, HOME: dir, TWINING_IDENTITY_HOME: identityHome };

    const seed = openRuntime({ projectRoot: dir, env });
    await seed.append({
      kind: "created",
      recordType: "decision",
      evidenceClass: "proposal",
      payload: { summary: DECISION_SUMMARY, rationale: "the working set must reach the next session automatically" },
      ingress: "cli",
    });
    await seed.store!.admit();
    await seed.store!.project();
    seed.close();

    const cliBundle = await bundleCli();
    const result = spawnSync(
      "bash",
      [path.resolve(__dirname, "..", "..", "..", "plugin", "hooks", "v3-capture-hook.sh"), "claude-code", "SessionStart"],
      {
        cwd: dir,
        input: sessionStartPayload(dir),
        encoding: "utf8",
        timeout: 60_000,
        env: {
          PATH: process.env.PATH,
          HOME: dir,
          TWINING_IDENTITY_HOME: identityHome,
          TWINING_CLI_JS: cliBundle,
          TWINING_CLI_NO_PATH_RECOVERY: "1",
        },
      },
    );

    expect(result.status).toBe(0);
    const ctx: string = JSON.parse((result.stdout ?? "").trim()).hookSpecificOutput.additionalContext;

    // THE FLIP — the active decision now reaches the session by itself.
    expect(ctx).toContain(DECISION_SUMMARY);
    expect(ctx).toContain("ZORBLAX-QUUX-7741");

    // ...and it arrives WITHOUT the prose reminders the 2.x path relies on,
    // because capture no longer depends on the model being told to capture
    // (oracle C15 A2-NO-PROSE).
    expect(ctx).not.toContain("Gate 1");
    expect(ctx).not.toContain("Gate 2");
  }, 120_000);
});
