/**
 * Claude Code host adapter (lane 03, brief step 3).
 *
 * The bash hooks are a thin shim: they resolve the CLI and pipe the host's
 * JSON through it. ALL payload logic lives here so it is testable without a
 * host — `handleClaudeCodeHook` takes the parsed hook input plus an open
 * runtime and returns (a) the exact JSON the hook must print and (b) the
 * events that were written.
 *
 * Three invariants this module exists to hold:
 *
 *  1. **Capture is hook-driven, never prose-driven.** On a v3 store the
 *     injected payload is the working set and nothing else — no "remember to
 *     call", no "Gate 1" (C15 A2-NO-PROSE). The 2.x gate text is still emitted
 *     on a non-v3 store, because on a 2.x store the gates ARE the mechanism.
 *  2. **Every injection leaves a receipt.** `injected` receipts carry the
 *     sha256 of the bytes the host received plus host/session/turn, so "what
 *     did that turn actually see" is answerable from the store rather than
 *     from a log line (C06 A15, C15 C1, C27 A2).
 *  3. **A worker's return is a `reported_result`, never a completion.**
 *     SubagentStop records finisher / stage / next action and says outright
 *     that the task is not complete (C06 A3, AQ2, N1).
 */
import path from "node:path";

import { sha256Hex, type EventEnvelope, type Ingress, type Scope } from "../contracts/index.js";
import { buildWorkingSet, type WorkingSet } from "./working-set.js";
import type { HostCapabilityMatrix } from "./host-capability.js";
import {
  payloadHash,
  readSessionCursor,
  writeSessionCursor,
  type V3Runtime,
} from "./runtime.js";

// ---------------------------------------------------------------- the matrix

/**
 * Claude Code 2.1.272. Every row was taken from the per-event input/decision
 * tables in the host's own hooks reference and is re-asserted by
 * test/adapters/claude-code.test.ts against docs/operations/hosts-claude-code-capabilities.md.
 */
export const CLAUDE_CODE_MATRIX: HostCapabilityMatrix = {
  host: "claude-code",
  version: "2.1.272",
  captures: ["session_start", "user_prompt", "compaction", "dispatch", "worker_return", "turn_end", "session_end"],
  injects: ["SessionStart", "UserPromptSubmit", "SubagentStart", "SubagentStop", "Stop"],
  cannotObserve: [],
  events: [
    {
      event: "SessionStart",
      captures: ["session_id", "source", "cwd", "transcript_path", "model", "agent_type"],
      injects: true,
      channel: "hookSpecificOutput.additionalContext",
      writes: ["observation(session_start)", "receipt(injected)"],
      receipt: "injected",
      note: "matchers startup|resume|clear|compact|fork; `compact` is the only channel that can re-seed after a compaction, because PreCompact/PostCompact cannot inject.",
    },
    {
      event: "UserPromptSubmit",
      captures: ["session_id", "prompt_id", "prompt", "cwd"],
      injects: true,
      channel: "hookSpecificOutput.additionalContext",
      writes: ["created(post/human_statement)", "receipt(injected)"],
      receipt: "injected",
      note: "the literal prompt is stored byte-for-byte with its sha256; deltas since the last receipt are injected.",
    },
    {
      event: "PreCompact",
      captures: ["session_id", "trigger", "custom_instructions", "cwd"],
      injects: false,
      channel: null,
      writes: ["created(observation)"],
      receipt: null,
      note: "CANNOT INJECT — the host discards additionalContext on this event. Durable progress is captured here and re-seeded through SessionStart(compact).",
    },
    {
      event: "SubagentStart",
      captures: ["session_id", "agent_id", "agent_type", "cwd"],
      injects: true,
      channel: "hookSpecificOutput.additionalContext",
      writes: ["created(work/assignment)", "receipt(injected)"],
      receipt: "injected",
      note: "injects into the SUBAGENT, never the parent. The work record is a reference (R04) — recorded, never granted.",
    },
    {
      event: "SubagentStop",
      captures: ["session_id", "agent_id", "agent_type", "last_assistant_message", "agent_transcript_path", "stop_hook_active"],
      injects: true,
      channel: "hookSpecificOutput.additionalContext",
      writes: ["created(post/reported_result)"],
      receipt: null,
      note: "a worker return. Never a completion: stage, finisher and next action are recorded and task_completion_state stays not_complete.",
    },
    {
      event: "PreToolUse",
      captures: ["tool_name", "tool_input", "tool_use_id"],
      injects: true,
      channel: "hookSpecificOutput.additionalContext",
      writes: [],
      receipt: null,
      note: "unchanged from 2.x — the git-commit gate. Not a v3 capture point.",
    },
    {
      event: "PostToolUse",
      captures: ["tool_name", "tool_input", "tool_use_id"],
      injects: true,
      channel: "hookSpecificOutput.additionalContext",
      writes: [],
      receipt: null,
      note: "unchanged from 2.x — the per-session activity marker.",
    },
    {
      event: "Stop",
      captures: ["session_id", "last_assistant_message", "stop_hook_active"],
      injects: true,
      channel: "hookSpecificOutput.additionalContext",
      writes: ["receipt(projected)"],
      receipt: "projected",
      note: "flushes the outbox; never blocks.",
    },
    {
      event: "SessionEnd",
      captures: ["session_id", "reason", "cwd"],
      injects: false,
      channel: null,
      writes: ["receipt(projected)"],
      receipt: "projected",
      note: "CANNOT INJECT — all JSON output is discarded. Default timeout 1.5 s, so the flush must be cheap.",
    },
  ],
};

// ------------------------------------------------------------------- inputs

export interface ClaudeHookInput {
  hook_event_name?: string;
  session_id?: string;
  prompt_id?: string;
  transcript_path?: string;
  cwd?: string;
  source?: string;
  trigger?: string;
  prompt?: string;
  agent_id?: string;
  agent_type?: string;
  last_assistant_message?: string;
  agent_transcript_path?: string;
  reason?: string;
  custom_instructions?: string | null;
  model?: unknown;
  [k: string]: unknown;
}

export interface HookOutcome {
  /** Exactly what the hook prints on stdout (empty string = print nothing). */
  stdout: string;
  /** Always 0 for capture hooks: a memory layer never breaks the host's turn. */
  exitCode: number;
  /** Events appended, in order. */
  events: EventEnvelope[];
  /**
   * Bytes handed to the host, when this event injected — plus the selection
   * arithmetic behind them. `selected` is what matched, `emitted` what fitted
   * the budget, `omitted` what did not. They are reported separately because
   * collapsing them is the exact failure C15 C2 names: an adapter that says
   * "delivered 8 of 8" when it emitted 6 has not lost the records, it has lost
   * the ability to tell you it lost them.
   */
  injected?: {
    text: string;
    hash: string;
    receipt?: string;
    selected: number;
    emitted: string[];
    omitted: string[];
  };
  /** Honest per-event note (e.g. "PreCompact cannot inject"). */
  notes: string[];
}

function additionalContext(event: string, text: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: text, ...extra },
  });
}

/** The scope a hook's events carry: the repo, narrowed by nothing we cannot prove. */
function hookScope(runtime: V3Runtime, input: ClaudeHookInput): Scope {
  const scope: Scope = { ...runtime.scope };
  if (input.session_id) scope.task = `session:${input.session_id}`;
  return scope;
}

/**
 * Bring the local replica up to date before reading it.
 *
 * Events appended by an earlier hook are `local_persisted` until they are
 * admitted; a working set built off an un-admitted log would silently omit
 * everything this session just captured. Admission and projection are both
 * idempotent, so running them here costs a no-op when nothing changed and
 * closes the gap when something did.
 */
async function settle(runtime: V3Runtime): Promise<void> {
  if (!runtime.store) return;
  try {
    await runtime.store.admit();
    await runtime.store.project();
  } catch {
    // A projection failure must not stop the turn; the next flush retries.
  }
}

// ------------------------------------------------------------------ handlers

export interface HandlerDeps {
  runtime: V3Runtime;
  ingress: Ingress;
  /** 2.x instruction text, used ONLY when the store is not v3-enabled. */
  legacyGateText?: string;
  budget?: number;
}

/**
 * SessionStart — assemble the bounded working set, inject it, and write the
 * `injected` receipt with the payload hash and the session/turn it went to.
 *
 * On `source: "compact"` this is the ONLY re-seeding channel Claude Code
 * offers (PreCompact and PostCompact both discard output), which is why the
 * compaction observation written at PreCompact is read back here.
 */
export async function handleSessionStart(input: ClaudeHookInput, deps: HandlerDeps): Promise<HookOutcome> {
  const { runtime } = deps;
  const notes: string[] = [];
  const events: EventEnvelope[] = [];
  const session = input.session_id ?? "unknown-session";

  if (!runtime.enabled) {
    // 2.x store: behave exactly as before. The gate prose IS the mechanism
    // here, so it is correct to emit it — and it is correct that the v3 path
    // never does.
    notes.push("store is not v3-enabled; emitting the 2.x lifecycle-gate context unchanged");
    return {
      stdout: deps.legacyGateText ? additionalContext("SessionStart", deps.legacyGateText) : "",
      exitCode: 0,
      events,
      notes,
    };
  }

  const store = runtime.store;
  if (!store) return { stdout: "", exitCode: 0, events, notes: ["v3 store unavailable"] };
  await settle(runtime);

  // A session_start observation: which host/session/source, and what the
  // producing worktree was. `verified_observation` because the adapter checked
  // these itself — they came from the host, not from a model.
  const started = await runtime.append({
    kind: "created",
    recordType: "observation",
    evidenceClass: "verified_observation",
    scope: hookScope(runtime, input),
    payload: {
      source_kind: "other",
      observed_at: new Date().toISOString(),
      volatile: false,
      check_method: "claude-code SessionStart hook",
      result: {
        kind: "session_start",
        host: "claude-code",
        session,
        start_source: input.source ?? "startup",
        cwd: input.cwd ?? null,
      },
    },
    ingress: deps.ingress,
  });
  if (started) events.push(started);

  const cursor = readSessionCursor(runtime.twiningDir, session);
  // A resume/compact start re-seeds from the last receipt; a cold start takes
  // the whole working set.
  const isContinuation = input.source === "resume" || input.source === "compact" || input.source === "fork";
  const ws: WorkingSet = await buildWorkingSet(store, {
    scope: runtime.scope,
    ...(deps.budget !== undefined ? { budget: deps.budget } : {}),
    ...(isContinuation && cursor?.last_injected_event ? { sinceEventId: cursor.last_injected_event } : {}),
  });

  if (ws.empty) {
    notes.push("nothing to inject: the working set for this scope is empty");
    writeSessionCursor(runtime.twiningDir, {
      session_id: session,
      ...(ws.cursor ? { last_injected_event: ws.cursor } : {}),
      updated_at: new Date().toISOString(),
      turns: (cursor?.turns ?? 0) + 1,
    });
    return { stdout: "", exitCode: 0, events, notes };
  }

  const hash = payloadHash(ws.text);
  const receipt = await runtime.receipt({
    stage: "injected",
    events: ws.included,
    payloadHash: hash,
    session,
    turn: input.prompt_id ?? `${input.source ?? "startup"}:0`,
    ingress: deps.ingress,
  });
  if (receipt) events.push(receipt);

  writeSessionCursor(runtime.twiningDir, {
    session_id: session,
    ...(ws.cursor ? { last_injected_event: ws.cursor } : {}),
    ...(receipt ? { last_receipt_id: receipt.id } : {}),
    last_payload_hash: hash,
    updated_at: new Date().toISOString(),
    turns: (cursor?.turns ?? 0) + 1,
  });

  return {
    stdout: additionalContext("SessionStart", ws.text),
    exitCode: 0,
    events,
    injected: {
      text: ws.text,
      hash,
      ...(receipt ? { receipt: receipt.id } : {}),
      selected: ws.included.length + ws.omitted.length,
      emitted: ws.included,
      omitted: ws.omitted,
    },
    notes,
  };
}

/**
 * UserPromptSubmit — the literal prompt becomes a `human_statement`, stored
 * with the sha256 of its exact bytes as an attachment record.
 *
 * `human_statement` proves a human typed it. It does NOT make what they typed
 * authoritative (ADR §2.2): only a ruling that cites it can do that.
 */
export async function handleUserPromptSubmit(input: ClaudeHookInput, deps: HandlerDeps): Promise<HookOutcome> {
  const { runtime } = deps;
  const notes: string[] = [];
  const events: EventEnvelope[] = [];
  const session = input.session_id ?? "unknown-session";
  const prompt = typeof input.prompt === "string" ? input.prompt : "";

  if (!runtime.enabled || !runtime.store) {
    return { stdout: "", exitCode: 0, events, notes: ["store is not v3-enabled; no capture"] };
  }
  if (prompt.length === 0) {
    return { stdout: "", exitCode: 0, events, notes: ["empty prompt; nothing captured"] };
  }

  const bytes = Buffer.from(prompt, "utf-8");
  const statement = await runtime.append({
    kind: "created",
    recordType: "post",
    evidenceClass: "human_statement",
    scope: hookScope(runtime, input),
    payload: {
      entry_type: "status",
      summary: truncate(prompt.replace(/\s+/g, " ").trim(), 200),
      detail: prompt,
      tags: ["human-statement", "claude-code"],
    },
    attachments: [
      {
        sha256: sha256Hex(bytes),
        bytes: bytes.byteLength,
        media_type: "text/plain",
        source_kind: "transcript_excerpt" as const,
        encoding: "utf-8",
        ...(input.prompt_id ? { anchor: `prompt:${input.prompt_id}` } : {}),
      },
    ],
    ingress: deps.ingress,
  });
  if (statement) events.push(statement);

  // Deltas since the last receipt — never the whole set again.
  await settle(runtime);
  const cursor = readSessionCursor(runtime.twiningDir, session);
  const ws = await buildWorkingSet(runtime.store, {
    scope: runtime.scope,
    ...(deps.budget !== undefined ? { budget: deps.budget } : {}),
    ...(cursor?.last_injected_event ? { sinceEventId: cursor.last_injected_event } : {}),
  });

  if (ws.empty) {
    notes.push("no new records since the last injection; nothing added to this turn");
    return { stdout: "", exitCode: 0, events, notes };
  }

  const hash = payloadHash(ws.text);
  const receipt = await runtime.receipt({
    stage: "injected",
    events: ws.included,
    payloadHash: hash,
    session,
    turn: input.prompt_id ?? "unknown-turn",
    ingress: deps.ingress,
  });
  if (receipt) events.push(receipt);

  writeSessionCursor(runtime.twiningDir, {
    session_id: session,
    ...(ws.cursor ? { last_injected_event: ws.cursor } : {}),
    ...(receipt ? { last_receipt_id: receipt.id } : {}),
    last_payload_hash: hash,
    updated_at: new Date().toISOString(),
    turns: (cursor?.turns ?? 0) + 1,
  });

  return {
    stdout: additionalContext("UserPromptSubmit", ws.text),
    exitCode: 0,
    events,
    injected: {
      text: ws.text,
      hash,
      ...(receipt ? { receipt: receipt.id } : {}),
      selected: ws.included.length + ws.omitted.length,
      emitted: ws.included,
      omitted: ws.omitted,
    },
    notes,
  };
}

/**
 * PreCompact — capture durable progress. This hook CANNOT inject: Claude Code
 * discards `additionalContext` on PreCompact (and on PostCompact). We say so
 * in the returned notes rather than pretending the event is covered both ways.
 * The re-seed happens at SessionStart(compact).
 */
export async function handlePreCompact(input: ClaudeHookInput, deps: HandlerDeps): Promise<HookOutcome> {
  const { runtime } = deps;
  const notes = [
    "PreCompact cannot inject context on this host — additionalContext is discarded. " +
      "Re-seeding rides SessionStart(source=compact).",
  ];
  const events: EventEnvelope[] = [];
  if (!runtime.enabled) return { stdout: "", exitCode: 0, events, notes };

  const session = input.session_id ?? "unknown-session";
  const cursor = readSessionCursor(runtime.twiningDir, session);

  const observed = await runtime.append({
    kind: "created",
    recordType: "observation",
    evidenceClass: "verified_observation",
    scope: hookScope(runtime, input),
    payload: {
      source_kind: "other",
      observed_at: new Date().toISOString(),
      volatile: false,
      check_method: "claude-code PreCompact hook",
      result: {
        kind: "compaction",
        host: "claude-code",
        session,
        trigger: input.trigger ?? "auto",
        // The cursors a resumed session needs to pick up where this one left off.
        last_injected_event: cursor?.last_injected_event ?? null,
        last_payload_hash: cursor?.last_payload_hash ?? null,
        turns: cursor?.turns ?? 0,
        transcript: input.transcript_path ? path.basename(input.transcript_path) : null,
        injects: false,
        injection_channel: null,
      },
    },
    ingress: deps.ingress,
  });
  if (observed) events.push(observed);

  return { stdout: "", exitCode: 0, events, notes };
}

/**
 * SubagentStart — a `work` record for the dispatch. R04: work references are
 * RECORDED, never granted. Creating this record assigns nothing and authorizes
 * nothing; it only makes the assignment/attempt identities observable.
 */
export async function handleSubagentStart(input: ClaudeHookInput, deps: HandlerDeps): Promise<HookOutcome> {
  const { runtime } = deps;
  const events: EventEnvelope[] = [];
  const notes: string[] = ["SubagentStart injects into the SUBAGENT, never the parent session."];
  if (!runtime.enabled || !runtime.store) return { stdout: "", exitCode: 0, events, notes };

  const session = input.session_id ?? "unknown-session";
  const agentId = input.agent_id ?? "unknown-agent";

  const work = await runtime.append({
    kind: "created",
    recordType: "work",
    evidenceClass: "verified_observation",
    scope: hookScope(runtime, input),
    payload: {
      kind: "assignment",
      system: "claude-code",
      external_id: agentId,
      owner: session,
      stage: "dispatched",
      agent_type: input.agent_type ?? null,
      // Recorded, never granted — the phrase is in the record so a reader
      // cannot mistake it for an authorization.
      authority: "reference only; this record grants nothing",
    },
    ingress: deps.ingress,
  });
  if (work) events.push(work);

  await settle(runtime);
  const ws = await buildWorkingSet(runtime.store, {
    scope: runtime.scope,
    ...(deps.budget !== undefined ? { budget: deps.budget } : {}),
  });
  if (ws.empty) return { stdout: "", exitCode: 0, events, notes };

  const hash = payloadHash(ws.text);
  const receipt = await runtime.receipt({
    stage: "injected",
    events: ws.included,
    payloadHash: hash,
    session: `${session}/${agentId}`,
    turn: "subagent-start",
    ingress: deps.ingress,
  });
  if (receipt) events.push(receipt);

  return {
    stdout: additionalContext("SubagentStart", ws.text),
    exitCode: 0,
    events,
    injected: {
      text: ws.text,
      hash,
      ...(receipt ? { receipt: receipt.id } : {}),
      selected: ws.included.length + ws.omitted.length,
      emitted: ws.included,
      omitted: ws.omitted,
    },
    notes,
  };
}

/**
 * SubagentStop — the worker returned. This is `reported_result`: "the worker
 * said", not "it is so" (ADR §2.2).
 *
 * The payload names the finisher, the stage, the assignment/attempt and the
 * next action, and states `task_completion_state: "not_complete"` explicitly —
 * a return is not a completion, a merge or an acceptance (C06 A3/AQ2/N1).
 * This is the field set baseline gap 2 proved was missing.
 */
export async function handleSubagentStop(input: ClaudeHookInput, deps: HandlerDeps): Promise<HookOutcome> {
  const { runtime } = deps;
  const events: EventEnvelope[] = [];
  const notes: string[] = [];
  if (!runtime.enabled) return { stdout: "", exitCode: 0, events, notes: ["store is not v3-enabled; no capture"] };

  const session = input.session_id ?? "unknown-session";
  const agentId = input.agent_id ?? "unknown-agent";
  const agentType = input.agent_type ?? "unknown";
  const last = typeof input.last_assistant_message === "string" ? input.last_assistant_message : "";

  const result = await runtime.append({
    kind: "created",
    recordType: "post",
    evidenceClass: "reported_result",
    scope: hookScope(runtime, input),
    payload: {
      entry_type: "status",
      summary: truncate(`Worker returned: ${agentType} (${agentId}) — review pending`, 200),
      detail: last,
      tags: ["worker-return", "claude-code", "reported-result"],
      // The five distinct identities C06 A2 requires be separately observable.
      finisher: { principal: runtime.identity.principal_id, session, host: runtime.identity.host_id, agent: agentId },
      assignment: agentId,
      attempt: `${agentId}:1`,
      job: input.agent_transcript_path ? path.basename(input.agent_transcript_path) : agentId,
      worker_session: agentId,
      parent_session: session,
      // Separately observable states — a return sets exactly one of them.
      stage: "worker_returned_review_pending",
      task_completion_state: "not_complete",
      acceptance_state: "none_recorded",
      merge_state: "not_merged",
      next_action: {
        ordered: true,
        items: [
          { rank: 1, action: "review the worker's returned result", blocking: true },
          { rank: 2, action: "requalify any live source state the result depends on", blocking: true },
          { rank: 3, action: "acceptance decision by an authorized human", blocking: false },
        ],
      },
      original_text_preserved: true,
      promoted: false,
    },
    attachments:
      last.length > 0
        ? [
            {
              sha256: sha256Hex(Buffer.from(last, "utf-8")),
              bytes: Buffer.byteLength(last, "utf-8"),
              media_type: "text/plain",
              source_kind: "transcript_excerpt" as const,
              encoding: "utf-8",
              anchor: `agent:${agentId}`,
            },
          ]
        : undefined,
    ingress: deps.ingress,
  });
  if (result) events.push(result);

  notes.push("a worker return is a reported_result — it is not completion, merge or acceptance");
  return { stdout: "", exitCode: 0, events, notes };
}

/**
 * Stop / SessionEnd — flush. SessionEnd discards all JSON output on this host
 * (1.5 s default budget), so the flush must be cheap and must not try to say
 * anything to the model.
 */
export async function handleFlush(input: ClaudeHookInput, deps: HandlerDeps): Promise<HookOutcome> {
  const { runtime } = deps;
  const events: EventEnvelope[] = [];
  const notes: string[] = [];
  const event = input.hook_event_name === "SessionEnd" ? "SessionEnd" : "Stop";
  if (event === "SessionEnd") notes.push("SessionEnd discards all hook output on this host; flush only.");
  if (!runtime.enabled || !runtime.store) return { stdout: "", exitCode: 0, events, notes };

  // Bring the local replica's projection up to date with everything appended
  // this turn: cheap, idempotent, and it is what makes the next SessionStart's
  // working set correct.
  try {
    await runtime.store.admit();
    await runtime.store.project();
  } catch (e) {
    notes.push(`flush failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
  }

  const receipt = await runtime.receipt({
    stage: "projected",
    events: [],
    session: input.session_id ?? "unknown-session",
    ingress: deps.ingress,
  });
  if (receipt) events.push(receipt);
  return { stdout: "", exitCode: 0, events, notes };
}

// ------------------------------------------------------------------ dispatch

const HANDLERS: Record<string, (i: ClaudeHookInput, d: HandlerDeps) => Promise<HookOutcome>> = {
  SessionStart: handleSessionStart,
  UserPromptSubmit: handleUserPromptSubmit,
  PreCompact: handlePreCompact,
  SubagentStart: handleSubagentStart,
  SubagentStop: handleSubagentStop,
  Stop: handleFlush,
  SessionEnd: handleFlush,
};

export function claudeCodeSupports(event: string): boolean {
  return event in HANDLERS;
}

export async function handleClaudeCodeHook(
  event: string,
  input: ClaudeHookInput,
  deps: HandlerDeps,
): Promise<HookOutcome> {
  const handler = HANDLERS[event];
  if (!handler) {
    return {
      stdout: "",
      exitCode: 0,
      events: [],
      notes: [`claude-code adapter has no handler for ${event}; nothing captured, nothing claimed`],
    };
  }
  return handler(input, deps);
}

/** Coverage the adapter can honestly claim on this host. */
export function claudeCodeCoverage(): {
  host: string;
  required_lifecycle_points: number;
  captured: number;
  coverage: Record<string, "supported" | "unsupported">;
  gaps: Array<{ kind: string; observed_at: string; captured: false; status: "uncaptured_event_gap" }>;
  cross_backend_substitution_claims: never[];
} {
  const coverage: Record<string, "supported" | "unsupported"> = {
    session_start: "supported",
    user_prompt: "supported",
    // The compaction EVENT is observed; injection after it is not possible on
    // that event and is stated as such, not counted twice.
    compaction: "supported",
    dispatch: "supported",
    worker_return: "supported",
    turn_end: "supported",
    session_end: "supported",
  };
  return {
    host: "claude-code",
    required_lifecycle_points: Object.keys(coverage).length,
    captured: Object.values(coverage).filter((v) => v === "supported").length,
    coverage,
    gaps: [],
    cross_backend_substitution_claims: [],
  };
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}
