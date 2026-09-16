# Claude Code CLI (`claude`) as installed at /Users/dave/code/twining-mcp — darwin 25.6.0 — 2.1.272 (Claude Code)

Hook capability matrix gathered in Stage 0 (workflow wf_f80a3b3b-ac2, 2026-09-15). Read-only survey of the installed host plus official docs; no model sessions were run. Lane 03 must re-verify every row in the real host before relying on it.

> **Hook capability matrix — Claude Code 2.1.272**
> Source of record: https://code.claude.com/docs/en/hooks (the requested `https://docs.claude.com/en/docs/claude-code/hooks` returns **301 → code.claude.com/docs/en/hooks**). Raw markdown pulled from `https://code.claude.com/docs/en/hooks.md` (3806 lines) and read directly; the auto-summarized fetch was wrong on several events (it claimed PreToolUse/SubagentStart cannot inject, and invented field names for ConfigChange/Notification/InstructionsLoaded), so every row below comes from the doc's own per-event input/decision tables.
> All version-gated fields named in the doc (`prompt_id` ≥ 2.1.196, `scratchpad_dir` ≥ 2.1.257, `PreModelSwitch`/`PostModelSwitch` ≥ 2.1.251, `classifierContext` ≥ 2.1.236, SessionStart resume-cost fields ≥ 2.1.251, `fork` matcher ≥ 2.1.214) are available at 2.1.272.

## Common input fields (every event)

`session_id`, `prompt_id` (UUID; absent until first user input), `transcript_path`, `cwd`, `scratchpad_dir` (may be absent), `permission_mode` (`default|plan|acceptEdits|auto|dontAsk|bypassPermissions`; not delivered to every event), `effort` (`{level: low|medium|high|xhigh|max}`; only for events inside a tool-use context), `hook_event_name`. Plus `agent_id` (inside a subagent) and `agent_type` (subagent or `--agent`).

## Universal JSON output fields

`continue` (false stops Claude; outranks event decisions), `stopReason`, `suppressOutput` (accepted, no effect), `systemMessage`, `terminalSequence` (OSC 0/1/2/9/99/777 + BEL only). Event-specific control lives in top-level `decision`/`reason` or in `hookSpecificOutput` (which requires `hookEventName`). All output strings capped at 10,000 chars.

## Matrix

| Event | Matchers | Event-specific input fields (+ common) | Inject context? | Channel | Block? |
|---|---|---|---|---|---|
| **SessionStart** | `startup`, `resume`, `clear`, `compact`, `fork` | `source`, `model` (optional), `agent_type`, `session_title`; on resume/fork: `seconds_since_last_response`, `context_tokens`, `prompt_cache_likely_expired`, `estimated_cache_write_usd` | **Yes** | plain stdout **and** `hookSpecificOutput.additionalContext` (+ `initialUserMessage`, `sessionTitle`, `watchPaths`, `reloadSkills`) | No — exit 2 shows stderr to user only |
| **Setup** | `init`, `maintenance` | `trigger` | **No** — `additionalContext` explicitly discarded | — | No |
| **InstructionsLoaded** | `session_start`, `nested_traversal`, `path_glob_match`, `include`, `compact` | `file_path`, `memory_type`, `load_reason`, `globs`, `trigger_file_path`, `parent_file_path` | **No** | — | No |
| **UserPromptSubmit** | none (always fires) | `prompt` | **Yes** | plain stdout **and** `hookSpecificOutput.additionalContext` (+ `sessionTitle`, `suppressOriginalPrompt`) | Yes — exit 2 or `decision:"block"` + `reason`; erases the prompt |
| **UserPromptExpansion** | command/skill name (`command_name`) | `expansion_type`, `command_name`, `command_args`, `command_source`, `prompt` | **Yes** | plain stdout **and** `hookSpecificOutput.additionalContext` | Yes — exit 2 or `decision:"block"` |
| **MessageDisplay** | none | `turn_id`, `message_id`, `index`, `final`, `delta` | **No** — `displayContent` is screen-only; Claude never sees it | — | No |
| **PreToolUse** | tool name (all but `EndConversation`) | `tool_name`, `tool_input`, `tool_use_id` | **Yes** | `hookSpecificOutput.additionalContext` (ignored when `permissionDecision:"defer"`); `permissionDecisionReason` also reaches Claude on `deny` | Yes — exit 2, or `permissionDecision` `allow`/`deny`/`ask`/`defer` (+ `updatedInput`) |
| **PermissionRequest** | tool name | `tool_name`, `tool_input`, `permission_suggestions[]` (no `tool_use_id`) | **No** | — (`decision.message` on deny reaches Claude as the denial reason) | Yes, but only via `hookSpecificOutput.decision.behavior` allow/deny (+`updatedInput`, `updatedPermissions`, `interrupt`). **Exit 2 is not honored** |
| **PostToolUse** | tool name (or `*`) | `tool_name`, `tool_input`, `tool_response`, `tool_use_id`, `duration_ms` | **Yes** | `hookSpecificOutput.additionalContext` (+ `updatedToolOutput`, `updatedMCPToolOutput`, `classifierContext` → auto-mode classifier, not Claude) | No block (tool already ran); exit 2 shows stderr to Claude; `decision:"block"`+`reason` appends feedback |
| **PostToolUseFailure** | tool name | `tool_name`, `tool_input`, `tool_use_id`, `error`, `is_interrupt`, `duration_ms` | **Yes** | `hookSpecificOutput.additionalContext` | No block; exit 2 shows stderr to Claude |
| **PostToolBatch** | none | `tool_calls[]` (`tool_name`, `tool_input`, `tool_use_id`, `tool_response` as serialized `tool_result`) | **Yes** | `hookSpecificOutput.additionalContext` | Yes — exit 2 / `decision:"block"` / `continue:false` stops the loop before the next model call |
| **PermissionDenied** | tool name | `tool_name`, `tool_input`, `tool_use_id`, `reason` | **No** | — (only `hookSpecificOutput.retry: true`) | No — denial already happened; exit 2 and stderr ignored |
| **Notification** | `permission_prompt`, `idle_prompt`, `auth_success`, `elicitation_dialog`, `elicitation_url_dialog`, `elicitation_complete`, `elicitation_response`, `agent_needs_input`, `agent_completed`, `quota_auto_resume_fired`, `quota_auto_resume_stale`, `quota_auto_resume_disabled` | `message`, `title` (optional), `notification_type` | **No** | — (`terminalSequence` still honored) | No |
| **SubagentStart** | agent type (`general-purpose`, `Explore`, `Plan`, custom `name`, `^plugin:agent$`) | `agent_id`, `agent_type` | **Yes — into the subagent, not the parent** | `hookSpecificOutput.additionalContext` | No — exit 2 stderr shown in the subagent's transcript only |
| **SubagentStop** | agent type | `stop_hook_active`, `agent_id`, `agent_type`, `agent_transcript_path`, `last_assistant_message`, `background_tasks[]`, `session_crons[]` | **Yes — into the subagent** (for the parent use a `PostToolUse` hook on `Agent`) | `hookSpecificOutput.additionalContext` | Yes — exit 2 or `decision:"block"`+`reason` keeps the subagent running |
| **TaskCreated** | none | `task_id`, `task_subject`, `task_description`, `teammate_name`, `team_name` (deprecated) | **No** (block `reason` returns to Claude as the tool error) | — | Yes — exit 2 or `decision:"block"` rolls back creation; `continue:false` ignored |
| **TaskCompleted** | none | `task_id`, `task_subject`, `task_description`, `teammate_name`, `team_name` (deprecated) | **No** | — | Yes — exit 2 blocks completion; `{"continue":false,"stopReason"}` stops a teammate (ignored when `TaskUpdate` triggered it) |
| **Stop** | none | `stop_hook_active`, `last_assistant_message`, `background_tasks[]`, `session_crons[]` | **Yes** | `hookSpecificOutput.additionalContext` (transcript label `Stop hook feedback`) | Yes — exit 2 or `decision:"block"`+`reason`; 8-consecutive-continuation cap |
| **StopFailure** | `rate_limit`, `overloaded`, `authentication_failed`, `oauth_org_not_allowed`, `account_on_hold`, `billing_error`, `invalid_request`, `model_not_found`, `server_error`, `max_output_tokens`, `cloud_credential_error`, `unknown` | `error`, `error_details`, `last_assistant_message` (holds the API error text) | **No** — all output discarded except `terminalSequence` | — | No |
| **TeammateIdle** | none | `teammate_name`, `team_name` (deprecated) | **No** (exit-2 stderr goes to the teammate as feedback) | — | Yes — exit 2 keeps the teammate working; `{"continue":false,"stopReason"}` stops it |
| **ConfigChange** | `user_settings`, `project_settings`, `local_settings`, `policy_settings`, `skills` | `source`, `file_path` (optional) | **No** (`reason` is "accepted but never shown") | — | Yes — exit 2 or `decision:"block"`, except `policy_settings` |
| **CwdChanged** | none | `old_cwd`, `new_cwd` | **No** (`systemMessage` → brief terminal notice to the user) | — (`watchPaths` output supported) | No |
| **DirectoryAdded** | `slash_command`, `register_repo_root` | `directory`, `source` | **Qualified yes** — with `source: "slash_command"` the hook's `systemMessage` is delivered to Claude as context on the next turn; with `register_repo_root` it goes only to the debug log. No `additionalContext` field | `systemMessage` (slash_command only) | No — the directory is already added |
| **FileChanged** | literal filenames split on `\|` (e.g. `.envrc\|.env`) | `file_path`, `event` (`change`/`add`/`unlink`) | **No** | — (`watchPaths` output supported) | No |
| **WorktreeCreate** | none | `name` | **No** | — | Yes — any non-zero exit fails creation. Must print the worktree path (command) or return `hookSpecificOutput.worktreePath` (HTTP) |
| **WorktreeRemove** | none | `worktree_path` | **No** — JSON output discarded | — | Partial — non-zero exit fails removal if the directory still exists |
| **PreCompact** | `manual`, `auto` | `trigger`, `custom_instructions` (null for auto) | **No** | — | Yes — exit 2 or `decision:"block"` blocks compaction |
| **PostCompact** | `manual`, `auto` | `trigger`, `compact_summary` | **No** | — | No |
| **PreModelSwitch** | canonical model name / regex | `from_model`, `to_model`, `requested_model`, `source`, `context_tokens`, `prompt_cache_warm`, `cache_ttl`, `estimated_cache_write_usd`, `pricing` | **No** — explicitly does **not** accept `additionalContext` | — | Yes — exit 2, `decision:"block"`, or `permissionDecision` `allow`/`deny`/`ask`. A timeout also blocks |
| **PostModelSwitch** | canonical model name / regex | same as PreModelSwitch, plus `source` values `auto` and `resume` | **Yes** | plain stdout **and** `hookSpecificOutput.additionalContext`, delivered with the next request | No — the model already changed |
| **SessionEnd** | `clear`, `resume`, `logout`, `prompt_input_exit`, `other` | `reason` | **No** — JSON output discarded | — | No. Default timeout 1.5 s (budget raisable to 60 s) |
| **Elicitation** | MCP server name | `mcp_server_name`, `message`, `mode` (`form`/`url`), `url`, `elicitation_id`, `requested_schema` | **No** — `content` goes to the MCP server, not Claude | — | Yes — exit 2 denies; `hookSpecificOutput.action` accept/decline/cancel |
| **ElicitationResult** | MCP server name | `mcp_server_name`, `action`, `mode`, `elicitation_id`, `content` | **No** | — | Yes — exit 2 forces `decline`; `hookSpecificOutput.action`/`content` override the user's response |

## Events that CANNOT inject context into the model's turn (20)

`Setup`, `InstructionsLoaded`, `MessageDisplay`, `PermissionRequest`, `PermissionDenied`, `Notification`, `TaskCreated`, `TaskCompleted`, `StopFailure`, `TeammateIdle`, `ConfigChange`, `CwdChanged`, `FileChanged`, `WorktreeCreate`, `WorktreeRemove`, `PreCompact`, `PostCompact`, `PreModelSwitch`, `SessionEnd`, `Elicitation`, `ElicitationResult`.

(`DirectoryAdded` is the edge case: no `additionalContext`, but a `slash_command`-sourced hook's `systemMessage` is delivered to Claude on the next turn. `SubagentStart`/`SubagentStop` inject into the **subagent**, never the parent session.)

## Notes relevant to a gate-enforcement design

- Only four events accept **plain stdout** as context: `SessionStart`, `UserPromptExpansion`, `UserPromptSubmit`, `PostModelSwitch`. Everywhere else stdout goes to the debug log and JSON is required.
- Exit 2 always wins over JSON on events that can block (a JSON `permissionDecision: "allow"` cannot override it). Exit 2 is **not** honored on `PermissionRequest`.
- `Stop`/`SubagentStop` get both a hard block (`decision:"block"` + `reason`, rendered as a hook error) and a soft channel (`hookSpecificOutput.additionalContext`, rendered as `Stop hook feedback`) — both are subject to `stop_hook_active` and the 8-continuation cap.
- `PreToolUse` on a git-commit Bash command is the only pre-action gate that both blocks and injects context in one response.

## Cannot inject / unsupported

- Setup — additionalContext explicitly discarded on every exit code
- InstructionsLoaded — JSON output discarded, observability only
- MessageDisplay — displayContent is screen-only; Claude never sees it
- PermissionRequest — no additionalContext; only the decision object
- PermissionDenied — only hookSpecificOutput.retry
- Notification — systemMessage/continue discarded
- TaskCreated — block reason returns as a tool error, no context channel
- TaskCompleted — no context channel
- StopFailure — all output ignored except terminalSequence
- TeammateIdle — exit-2 stderr is teammate feedback, not context
- ConfigChange — reason accepted but never shown
- CwdChanged — systemMessage is a terminal notice to the user only
- FileChanged — systemMessage is a terminal notice to the user only
- WorktreeCreate — stdout is consumed as the worktree path
- WorktreeRemove — JSON output discarded
- PreCompact — systemMessage/continue discarded
- PostCompact — systemMessage/continue discarded
- PreModelSwitch — documented as not accepting additionalContext
- SessionEnd — JSON output discarded
- Elicitation — content goes to the MCP server, not Claude
- ElicitationResult — overrides go to the MCP server, not Claude

## Sources

- https://code.claude.com/docs/en/hooks — canonical Hooks reference (https://docs.claude.com/en/docs/claude-code/hooks returns HTTP 301 to this URL)
- https://code.claude.com/docs/en/hooks.md — raw markdown of the same page (3806 lines), read directly for every per-event input/decision table
- Local CLI: `claude --version` → 2.1.272 (Claude Code); `claude --help` → confirms hook-adjacent flags --include-hook-events and --bare (skip hooks)
- Doc sections used verbatim: #common-input-fields, #json-output, #exit-code-output, #exit-code-2-behavior-per-event, #decision-control, #add-context-for-claude, and each ### event section

---

# Lane 03 — what the Twining adapter actually does on this host

Added 2026-09-15 by lane 03 (runtime integration). The survey above records what
the HOST offers; this section records what Twining's adapter DOES with it. The
table is generated from `src/adapters/claude-code.ts` (`CLAUDE_CODE_MATRIX`) and
`test/adapters/host-matrix-docs.test.ts` fails if this file drifts from the code —
a capability claim that only lives in prose is a claim nobody notices going stale.

The adapter is active only on a **v3-enabled store** (`.twining/store.json` with
`"format": 3`). On a 2.x store every row below is inert and the pre-existing
hooks behave exactly as they did.

<!-- BEGIN GENERATED: claude-code@2.1.272 — source of record is src/adapters/host-capability.ts consumers -->

| Event | Captured fields | Injects? | Channel | Twining events written | Receipt |
|---|---|---|---|---|---|
| `SessionStart` | `session_id`, `source`, `cwd`, `transcript_path`, `model`, `agent_type` | yes | `hookSpecificOutput.additionalContext` | `observation(session_start)`, `receipt(injected)` | `injected` |
| `UserPromptSubmit` | `session_id`, `prompt_id`, `prompt`, `cwd` | yes | `hookSpecificOutput.additionalContext` | `created(post/human_statement)`, `receipt(injected)` | `injected` |
| `PreCompact` | `session_id`, `trigger`, `custom_instructions`, `cwd` | **no** | — | `created(observation)` | — |
| `SubagentStart` | `session_id`, `agent_id`, `agent_type`, `cwd` | yes | `hookSpecificOutput.additionalContext` | `created(work/assignment)`, `receipt(injected)` | `injected` |
| `SubagentStop` | `session_id`, `agent_id`, `agent_type`, `last_assistant_message`, `agent_transcript_path`, `stop_hook_active` | yes | `hookSpecificOutput.additionalContext` | `created(post/reported_result)` | — |
| `PreToolUse` | `tool_name`, `tool_input`, `tool_use_id` | yes | `hookSpecificOutput.additionalContext` | — | — |
| `PostToolUse` | `tool_name`, `tool_input`, `tool_use_id` | yes | `hookSpecificOutput.additionalContext` | — | — |
| `Stop` | `session_id`, `last_assistant_message`, `stop_hook_active` | yes | `hookSpecificOutput.additionalContext` | `receipt(projected)` | `projected` |
| `SessionEnd` | `session_id`, `reason`, `cwd` | **no** | — | `receipt(projected)` | `projected` |

**Captures:** session_start, user_prompt, compaction, dispatch, worker_return, turn_end, session_end

**Injects on:** SessionStart, UserPromptSubmit, SubagentStart, SubagentStop, Stop

**Cannot observe:** nothing known

**Per-event notes**

- `SessionStart` — matchers startup|resume|clear|compact|fork; `compact` is the only channel that can re-seed after a compaction, because PreCompact/PostCompact cannot inject.
- `UserPromptSubmit` — the literal prompt is stored byte-for-byte with its sha256; deltas since the last receipt are injected.
- `PreCompact` — CANNOT INJECT — the host discards additionalContext on this event. Durable progress is captured here and re-seeded through SessionStart(compact).
- `SubagentStart` — injects into the SUBAGENT, never the parent. The work record is a reference (R04) — recorded, never granted.
- `SubagentStop` — a worker return. Never a completion: stage, finisher and next action are recorded and task_completion_state stays not_complete.
- `PreToolUse` — unchanged from 2.x — the git-commit gate. Not a v3 capture point.
- `PostToolUse` — unchanged from 2.x — the per-session activity marker.
- `Stop` — flushes the outbox; never blocks.
- `SessionEnd` — CANNOT INJECT — all JSON output is discarded. Default timeout 1.5 s, so the flush must be cheap.

<!-- END GENERATED -->

## Honest limits on this host

- **PreCompact cannot inject.** Claude Code discards `additionalContext` on
  `PreCompact` *and* `PostCompact`. Compaction is therefore CAPTURED there
  (cursors, last injected event, last payload hash) and RE-SEEDED at
  `SessionStart` with `source: "compact"`, which is a genuine injection channel.
  The adapter says so in its stderr notes on every PreCompact; it does not
  report the event as covered in both directions.
- **SessionEnd discards all hook output** and defaults to a 1.5 s budget, so the
  flush there is admit + project + one receipt, and nothing else.
- **SubagentStart/SubagentStop inject into the SUBAGENT, never the parent.** A
  worker's return reaches the parent at the parent's next injecting event.
- **A worker return is never a completion.** `SubagentStop` writes a
  `reported_result` whose payload states `task_completion_state: "not_complete"`,
  `acceptance_state: "none_recorded"` and `merge_state: "not_merged"`, and keeps
  the worker's own text verbatim with its sha256. The worker claiming otherwise
  changes none of those fields.
- **No prose reminders are injected on a v3 store.** Capture happens at the hook
  boundary, so the payload carries the working set and nothing else. The 2.x gate
  text (which does contain "Gate 1"/"Gate 2") is emitted only on a 2.x store,
  where those gates are the entire capture mechanism.

## Installed hooks

`plugin/hooks/hooks.json` registers `v3-capture-hook.sh` for SessionStart
(`startup|resume|clear|compact|fork`), UserPromptSubmit, PreCompact,
SubagentStart, SubagentStop, Stop and SessionEnd. The PreToolUse commit gate and
the PostToolUse activity marker are unchanged from 2.x. The shim resolves the
CLI through `plugin/scripts/launch-cli.sh` and exits 0 silently when it cannot —
a memory layer that breaks the user's turn because it could not find its own
binary is a worse failure than one that does not capture.
