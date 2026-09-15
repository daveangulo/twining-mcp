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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runHook } from "../../hooks/run-hook";

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

    // GAP — no PreCompact event is registered at all...
    expect(Object.keys(hooks)).not.toContain("PreCompact");

    // ...and no SessionStart entry targets a compaction source either, so
    // nothing re-injects context after a compaction.
    const sessionStartEntries = hooks.SessionStart as Array<{
      matcher?: string;
    }>;
    const compactMatchers = sessionStartEntries.filter((entry) =>
      (entry.matcher ?? "").toLowerCase().includes("compact"),
    );
    expect(compactMatchers).toEqual([]);
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

    // GAP — the active decision's summary is nowhere in the injected
    // context: instructions are injected, the working set is not.
    expect(ctx).not.toContain(DECISION_SUMMARY);
    expect(ctx).not.toContain("ZORBLAX-QUUX-7741");
  });
});
