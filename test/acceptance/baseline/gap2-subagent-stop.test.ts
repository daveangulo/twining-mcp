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
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runHook } from "../../hooks/run-hook";

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
