/**
 * Codex CLI host adapter (lane 03, brief step 4).
 *
 * Codex 0.154.0 has exactly 12 hook events and exactly FIVE that can inject
 * (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
 * `SubagentStart`) — those are the five output schemas in the shipped binary
 * that declare `additionalContext`. Seven observe only.
 *
 * The consequences are structural, not stylistic, and this module encodes them
 * rather than describing them:
 *
 *   - **PreCompact and PostCompact cannot inject.** Their output schemas are
 *     `additionalProperties: false` with no `hookSpecificOutput` member at all,
 *     so a compaction hook that returned `additionalContext` would be rejected
 *     by the host's own schema. Compaction RECOVERY therefore rides
 *     `SessionStart(source=resume)` and the next `UserPromptSubmit`.
 *   - **SubagentStop and Stop cannot inject.** A worker return is captured and
 *     surfaces on the parent's next injecting event, never at the stop itself.
 *   - **SessionEnd has no output schema whatsoever.** The flush must print
 *     nothing and finish inside the host's synchronous window.
 *
 * Capture is shared with the Claude Code adapter on purpose: the same lifecycle
 * points produce the same events, so a coordinator reading the store cannot
 * tell which host wrote them — only the capability matrix differs.
 */
import type { EventEnvelope } from "../contracts/index.js";
import type { HostCapabilityMatrix } from "./host-capability.js";
import {
  handleFlush,
  handlePreCompact,
  handleSessionStart,
  handleSubagentStart,
  handleSubagentStop,
  handleUserPromptSubmit,
  type ClaudeHookInput,
  type HandlerDeps,
  type HookOutcome,
} from "./claude-code.js";

export const CODEX_MATRIX: HostCapabilityMatrix = {
  host: "codex",
  version: "0.154.0",
  captures: ["session_start", "user_prompt", "compaction", "dispatch", "worker_return", "turn_end", "session_end"],
  injects: ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "SubagentStart"],
  cannotObserve: [
    "Notification (no such event exists on this host)",
    "TurnStart / TurnEnd (no turn-boundary events; turn_id is exposed but never fires an event)",
    "dedicated apply_patch / exec_command events (reached only by tool_name matching)",
    "SessionEnd structured output (the binary carries session-end.command.input but no .output schema)",
  ],
  events: [
    {
      event: "SessionStart",
      captures: ["session_id", "source", "cwd", "model", "permission_mode", "transcript_path"],
      injects: true,
      channel: "hookSpecificOutput.additionalContext",
      writes: ["created(observation)", "receipt(injected)"],
      receipt: "injected",
      note: "source ∈ startup|resume|clear|compact. This is the ONLY post-compaction re-seeding channel on this host.",
    },
    {
      event: "UserPromptSubmit",
      captures: ["session_id", "turn_id", "prompt", "cwd", "model", "agent_id", "agent_type"],
      injects: true,
      channel: "hookSpecificOutput.additionalContext",
      writes: ["created(post/human_statement)", "receipt(injected)"],
      receipt: "injected",
      note: "turn_id (not prompt_id) is the turn identity on this host; matchers are accepted but ignored for this event.",
    },
    {
      event: "PreCompact",
      captures: ["session_id", "turn_id", "trigger", "cwd", "model"],
      injects: false,
      channel: null,
      writes: ["created(observation)"],
      receipt: null,
      note: "CANNOT INJECT — the output schema has no hookSpecificOutput member. Halt-only (continue:false).",
    },
    {
      event: "PostCompact",
      captures: ["session_id", "turn_id", "trigger"],
      injects: false,
      channel: null,
      writes: ["created(observation)"],
      receipt: null,
      note: "CANNOT INJECT — same schema shape as PreCompact. Recovery rides SessionStart(resume)/UserPromptSubmit.",
    },
    {
      event: "SubagentStart",
      captures: ["session_id", "turn_id", "agent_id", "agent_type"],
      injects: true,
      channel: "hookSpecificOutput.additionalContext",
      writes: ["created(work/assignment)", "receipt(injected)"],
      receipt: "injected",
      note: "continue:false parses but is not honored — this hook cannot block a dispatch.",
    },
    {
      event: "SubagentStop",
      captures: ["session_id", "turn_id", "agent_id", "agent_type", "last_assistant_message", "agent_transcript_path"],
      injects: false,
      channel: null,
      writes: ["created(post/reported_result)"],
      receipt: null,
      note: "CANNOT INJECT — no hookSpecificOutput member. decision:\"block\" means CONTINUE the subagent, not reject it.",
    },
    {
      event: "PreToolUse",
      captures: ["tool_name", "tool_input", "tool_use_id", "turn_id"],
      injects: true,
      channel: "hookSpecificOutput.additionalContext",
      writes: [],
      receipt: null,
      note: "the commit gate. tool_name is Bash|apply_patch|<mcp tool>; the binary's internal names are apply_patch/unified_exec.",
    },
    {
      event: "PostToolUse",
      captures: ["tool_name", "tool_input", "tool_response", "turn_id"],
      injects: true,
      channel: "hookSpecificOutput.additionalContext",
      writes: [],
      receipt: null,
      note: "also carries updatedMCPToolOutput, a mutation channel Twining deliberately does not use.",
    },
    {
      event: "Stop",
      captures: ["session_id", "turn_id", "last_assistant_message", "stop_hook_active"],
      injects: false,
      channel: null,
      writes: ["receipt(projected)"],
      receipt: "projected",
      note: "CANNOT INJECT — no hookSpecificOutput member. decision:\"block\" tells Codex to continue, it does not reject the turn.",
    },
    {
      event: "SessionEnd",
      captures: ["session_id", "reason", "cwd"],
      injects: false,
      channel: null,
      writes: ["receipt(projected)"],
      receipt: "projected",
      note: "CANNOT INJECT and has NO output schema at all; always synchronous even with async:true, and mcp_tool handlers are unsupported.",
    },
    {
      event: "Interrupt",
      captures: ["session_id", "turn_id"],
      injects: false,
      channel: null,
      writes: [],
      receipt: null,
      note: "CANNOT INJECT — output is systemMessage only, 1–3 s budget. Twining registers nothing here.",
    },
    {
      event: "PermissionRequest",
      captures: [],
      injects: false,
      channel: null,
      writes: [],
      receipt: null,
      note: "CANNOT INJECT, and updatedInput/updatedPermissions/interrupt FAIL CLOSED if present. Twining registers nothing here.",
    },
  ],
};

/** Events on this host whose output schema accepts `additionalContext`. */
export const CODEX_INJECTING_EVENTS = new Set(CODEX_MATRIX.injects);

/**
 * Codex names the turn `turn_id`; Claude Code names it `prompt_id`. Normalise
 * once so the shared handlers see one shape, and keep BOTH on the input so a
 * capture never loses the host's own field name.
 */
function normalise(input: Record<string, unknown>): ClaudeHookInput {
  const out: ClaudeHookInput = { ...(input as ClaudeHookInput) };
  if (out.prompt_id === undefined && typeof input.turn_id === "string") {
    out.prompt_id = input.turn_id;
  }
  return out;
}

const HANDLERS: Record<string, (i: ClaudeHookInput, d: HandlerDeps) => Promise<HookOutcome>> = {
  SessionStart: handleSessionStart,
  UserPromptSubmit: handleUserPromptSubmit,
  PreCompact: handlePreCompact,
  PostCompact: handlePreCompact,
  SubagentStart: handleSubagentStart,
  SubagentStop: handleSubagentStop,
  Stop: handleFlush,
  SessionEnd: handleFlush,
};

export async function handleCodexHook(
  event: string,
  raw: Record<string, unknown>,
  deps: HandlerDeps,
): Promise<HookOutcome> {
  const handler = HANDLERS[event];
  if (!handler) {
    return {
      stdout: "",
      exitCode: 0,
      events: [] as EventEnvelope[],
      notes: [`codex adapter has no handler for ${event}; nothing captured, nothing claimed`],
    };
  }
  // Stamp the host BEFORE delegating: the shared handlers write the capture,
  // and a capture that names the wrong host is unfixable after the fact.
  const outcome = await handler(normalise(raw), { ...deps, host: "codex" });

  if (!CODEX_INJECTING_EVENTS.has(event)) {
    // The capture stands; the injection does not. The note is emitted for
    // EVERY observe-only event, not only when something was about to be
    // dropped — "this event cannot inject" is a property of the host, and a
    // reader of the notes should not have to infer it from silence (C15 D2).
    const { injected: _dropped, ...rest } = outcome;
    return {
      ...rest,
      stdout: "",
      notes: [
        ...outcome.notes,
        `codex ${event} cannot inject context (no additionalContext member in its output schema); ` +
          "the captured records reach the model at the next SessionStart or UserPromptSubmit instead",
      ],
    };
  }

  // SessionStart on Codex has no `fork` source; nothing to translate, but the
  // hookEventName in the emitted JSON must be the host's own name.
  return outcome;
}

/**
 * What this host honestly covers. `compaction` is `supported` for CAPTURE and
 * the absence of an injection channel on that event is reported as a note, not
 * as a substitution: the re-seed happens on a different event, on this same
 * host, which is exactly what `cross_backend_substitution_claims: []` means.
 */
export function codexCoverage(): {
  host: string;
  required_lifecycle_points: number;
  captured: number;
  coverage: Record<string, "supported" | "unsupported">;
  gaps: Array<{ kind: string; observed_at: string; captured: false; status: "uncaptured_event_gap" }>;
  cross_backend_substitution_claims: never[];
  injects_on: string[];
} {
  const coverage: Record<string, "supported" | "unsupported"> = {
    session_start: "supported",
    user_prompt: "supported",
    compaction: "supported",
    dispatch: "supported",
    worker_return: "supported",
    turn_end: "supported",
    session_end: "supported",
  };
  return {
    host: "codex",
    required_lifecycle_points: Object.keys(coverage).length,
    captured: Object.values(coverage).filter((v) => v === "supported").length,
    coverage,
    gaps: [],
    cross_backend_substitution_claims: [],
    injects_on: [...CODEX_INJECTING_EVENTS],
  };
}
