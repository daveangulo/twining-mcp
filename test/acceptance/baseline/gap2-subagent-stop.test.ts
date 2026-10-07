/**
 * Gap 2 (subagent-stop) baseline reproduction — requirements R04, R08, R10.
 *
 * Under test: plugin/hooks/subagent-stop-hook.sh at baseline commit 07230e6.
 * Setup idioms mirror test/hooks/subagent-stop-hook.test.ts (isolated mkdtemp
 * cwd, runHook helper, pending-posts.jsonl line splitting).
 *
 * POSITIVE CONTROL — proves the instrument works: with a SubagentStop payload
 * and a .twining dir present, the hook appends exactly one line to
 * .twining/pending-posts.jsonl and that line is parseable JSON.
 *
 * GAP — the queued post is a generic status entry only. Its key set is exactly
 * {entry_type, summary, detail, scope, agent_id, tags}: it carries no field for
 * review/qualification state, no finisher identity, no assignment/attempt
 * linkage, and no next action. A downstream consumer therefore cannot tell
 * whether the subagent's work was reviewed, who finished it, which assignment
 * or attempt it belongs to, or what should happen next.
 *
 * FLIPPED BY LANE 03 (runtime integration, 2026-09-15). The 2.x assertions are
 * kept verbatim as CONTROLS — on a store with no .twining/store.json the
 * legacy hook still queues exactly the generic post, and that is correct, not
 * a defect. The flip is the block at the bottom: on a v3-enabled store the
 * adapter records a `reported_result` carrying finisher, assignment, attempt,
 * stage and an ordered next action — and states that the task is NOT complete,
 * not accepted and not merged, because a worker return is none of those
 * (oracle C06 A2/A3/A4).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runHook } from "../../hooks/run-hook";
import { handleClaudeCodeHook } from "../../../src/adapters/claude-code.js";
import { ensureStoreDescriptor } from "../../../src/adapters/identity.js";
import { openRuntime } from "../../../src/adapters/runtime.js";
import { STORE_FORMAT_VERSION } from "../../../src/contracts/index.js";

let dir: string;

beforeEach(() => {
  // Every test runs from an isolated tmp dir — never from the repo root,
  // which has its own live .twining/ the hook would otherwise write into.
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-gap2-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Field names that would carry the coordination state the gap says is missing. */
const REVIEW_STATE_FIELDS = [
  "review",
  "review_state",
  "reviewed",
  "reviewed_by",
  "qualification",
  "qualified",
  "qualification_state",
  "verdict",
  "outcome",
  "status",
  "result",
];
const FINISHER_FIELDS = [
  "finisher",
  "finished_by",
  "completed_by",
  "finisher_id",
  "actor",
];
const ASSIGNMENT_FIELDS = [
  "assignment",
  "assignment_id",
  "attempt",
  "attempt_id",
  "attempt_number",
  "task_id",
  "work_item",
  "parent_agent_id",
];
const NEXT_ACTION_FIELDS = [
  "next_action",
  "next",
  "next_steps",
  "follow_up",
  "followup",
  "recommendation",
  "action",
];

/** Exactly the generic status-post shape the hook emits at baseline. */
const GENERIC_KEYS = [
  "agent_id",
  "detail",
  "entry_type",
  "scope",
  "summary",
  "tags",
];

function queuedPosts(twiningDir: string): unknown[] {
  const pendingPath = path.join(twiningDir, "pending-posts.jsonl");
  expect(fs.existsSync(pendingPath)).toBe(true);
  return fs
    .readFileSync(pendingPath, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

describe("Gap 2 baseline: SubagentStop queues a state-free generic status post", () => {
  it("positive control: exactly one parseable JSON line is appended to pending-posts.jsonl", () => {
    const twining = path.join(dir, ".twining");
    fs.mkdirSync(twining);

    const result = runHook({
      script: "subagent-stop-hook.sh",
      stdin: JSON.stringify({
        hook_event_name: "SubagentStop",
        agent_type: "code-reviewer",
        transcript_path: path.join(dir, "transcript.jsonl"),
        session_id: "sess-gap2",
      }),
      cwd: dir,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const pendingPath = path.join(twining, "pending-posts.jsonl");
    expect(fs.existsSync(pendingPath)).toBe(true);

    const lines = fs
      .readFileSync(pendingPath, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(1);
    expect(() => JSON.parse(lines[0]!)).not.toThrow();
    // Instrument is live: the hook really did write, and we can read its payload.
    expect(typeof JSON.parse(lines[0]!)).toBe("object");
  });

  it("gap: the queued post is entry_type 'status' with a generic 'Subagent completed:' summary", () => {
    const twining = path.join(dir, ".twining");
    fs.mkdirSync(twining);

    const result = runHook({
      script: "subagent-stop-hook.sh",
      stdin: JSON.stringify({
        hook_event_name: "SubagentStop",
        agent_type: "code-reviewer",
        transcript_path: path.join(dir, "transcript.jsonl"),
        session_id: "sess-gap2",
      }),
      cwd: dir,
    });
    expect(result.exitCode).toBe(0);

    const posts = queuedPosts(twining);
    expect(posts).toHaveLength(1);
    const post = posts[0] as Record<string, unknown>;

    expect(post.entry_type).toBe("status");
    expect(typeof post.summary).toBe("string");
    expect(post.summary as string).toMatch(/^Subagent completed:/);
    // Nothing beyond the agent label distinguishes one completion from another.
    expect(post.summary).toBe("Subagent completed: code-reviewer");
    expect(post.detail).toBe("");
  });

  it("gap: the post carries NO review/qualification, finisher, assignment/attempt, or next-action field", () => {
    const twining = path.join(dir, ".twining");
    fs.mkdirSync(twining);

    const result = runHook({
      script: "subagent-stop-hook.sh",
      stdin: JSON.stringify({
        hook_event_name: "SubagentStop",
        agent_type: "code-reviewer",
        transcript_path: path.join(dir, "transcript.jsonl"),
        session_id: "sess-gap2",
      }),
      cwd: dir,
    });
    expect(result.exitCode).toBe(0);

    const post = queuedPosts(twining)[0] as Record<string, unknown>;
    const keys = Object.keys(post);

    // CONTROL (lane 03): this store has no store.json, so it is 2.x and the
    // legacy hook's generic post is the expected output. The v3 field set is
    // asserted in the flipped block at the end of this file.
    // R04 — no review / qualification state is recorded.
    for (const field of REVIEW_STATE_FIELDS) {
      expect(keys).not.toContain(field);
    }
    // R08 — no finisher identity beyond the raw agent label.
    for (const field of FINISHER_FIELDS) {
      expect(keys).not.toContain(field);
    }
    // R10 — no assignment/attempt linkage and no next action.
    for (const field of ASSIGNMENT_FIELDS) {
      expect(keys).not.toContain(field);
    }
    for (const field of NEXT_ACTION_FIELDS) {
      expect(keys).not.toContain(field);
    }

    // The key set is EXACTLY the generic one — nothing else is smuggled in
    // under a name the lists above happen not to cover.
    expect([...keys].sort()).toEqual(GENERIC_KEYS);

    // tags say only that a hook fired for a subagent stop — no state either.
    expect(post.tags).toEqual(["subagent-stop", "hook-generated"]);
    expect(post.scope).toBe("project");
    expect(post.agent_id).toBe("code-reviewer");
  });

  it("gap: identical generic post even when the payload offers richer state to record", () => {
    const twining = path.join(dir, ".twining");
    fs.mkdirSync(twining);

    // A payload carrying exactly the state the gap says is lost.
    const result = runHook({
      script: "subagent-stop-hook.sh",
      stdin: JSON.stringify({
        hook_event_name: "SubagentStop",
        agent_type: "code-reviewer",
        session_id: "sess-gap2",
        transcript_path: path.join(dir, "transcript.jsonl"),
        assignment_id: "assign-42",
        attempt: 2,
        review_state: "needs-review",
        finisher: "orchestrator-1",
        next_action: "run the verification suite",
      }),
      cwd: dir,
    });
    expect(result.exitCode).toBe(0);

    const post = queuedPosts(twining)[0] as Record<string, unknown>;

    // None of the supplied state survives into the queued post.
    expect([...Object.keys(post)].sort()).toEqual(GENERIC_KEYS);
    const serialized = JSON.stringify(post);
    for (const dropped of [
      "assign-42",
      "needs-review",
      "orchestrator-1",
      "run the verification suite",
      "sess-gap2",
    ]) {
      expect(serialized).not.toContain(dropped);
    }
  });
});

/**
 * THE FLIP (lane 03). Same trigger, v3-enabled store: the capture path records
 * the coordination state the baseline proved was lost.
 */
describe("CLOSED (lane 03): on a v3 store the worker return carries its state", () => {
  it("records finisher, assignment/attempt, stage and next action — and denies completion", async () => {
    const twining = path.join(dir, ".twining");
    fs.mkdirSync(twining, { recursive: true });
    ensureStoreDescriptor(twining, { format: STORE_FORMAT_VERSION });
    const identityHome = path.join(dir, "identity");
    fs.mkdirSync(identityHome, { recursive: true });
    const env = { ...process.env, HOME: dir, TWINING_IDENTITY_HOME: identityHome };

    const runtime = openRuntime({ projectRoot: dir, env });
    try {
      const out = await handleClaudeCodeHook(
        "SubagentStop",
        {
          hook_event_name: "SubagentStop",
          agent_type: "code-reviewer",
          agent_id: "assign-42",
          session_id: "sess-gap2",
          transcript_path: path.join(dir, "transcript.jsonl"),
          last_assistant_message: "Reviewed and merged. Task complete.",
          cwd: dir,
        },
        { runtime, ingress: "adapter" },
      );

      const created = out.events.find((e) => e.kind === "created");
      expect(created, "the v3 path must capture the return").toBeTruthy();
      const post = created!.payload as Record<string, unknown>;

      // R04 — review/qualification state is recorded, in its honest form: the
      // work is NOT complete, NOT accepted and NOT merged.
      expect(post.stage).toBe("worker_returned_review_pending");
      expect(post.task_completion_state).toBe("not_complete");
      expect(post.acceptance_state).toBe("none_recorded");
      expect(post.merge_state).toBe("not_merged");

      // R08 — a finisher identity beyond the raw agent label.
      const finisher = post.finisher as Record<string, unknown>;
      expect(finisher.session).toBe("sess-gap2");
      expect(finisher.agent).toBe("assign-42");
      expect(finisher.host).toBeTruthy();

      // R10 — assignment/attempt linkage and an ordered next action.
      expect(post.assignment).toBe("assign-42");
      expect(post.attempt).toBe("assign-42:1");
      expect(post.parent_session).toBe("sess-gap2");
      const next = post.next_action as { ordered: boolean; items: unknown[] };
      expect(next.ordered).toBe(true);
      expect(next.items.length).toBeGreaterThan(0);

      // The worker CLAIMED completion. The claim is preserved verbatim and
      // still confers nothing — the class stays reported_result.
      expect(created!.evidence_class).toBe("reported_result");
      expect(post.detail).toContain("Task complete.");
      expect(post.promoted).toBe(false);
    } finally {
      runtime.close();
    }
  }, 60_000);
});
