# Claude Code hosts — capabilities and the Twining adapter

**What this covers.** What the Claude Code CLI (`claude`) offers hooks, what Twining's Claude Code adapter and plugin hooks actually capture and inject on it, how to reproduce every behaviour offline, and what is not verified. It describes `foundation/v3` at **0f9fd985** (includes afe8f34d, the working-set renderer change). Commands were run on darwin 25.6.0 against a build of that commit; host Claude Code installed at the time of writing is **2.1.291**.

**Standing rule.** A claim about behaviour is written from a run: the command and its trimmed output are inline. A statement read from code is labelled *(from source, not a run)*. A statement from Claude Code's hooks documentation is labelled as documentation. Anything that needs a real Claude Code session, a real auto-mode subagent, or a host upgrade path is **UNAVAILABLE** here and says why.

## Known defects and limits at this commit

| # | What the operator sees | Reproduce (setup in "Offline demonstration") | Impact | Workaround |
|---|---|---|---|---|
| 1 | Generated matrix says `PreToolUse`/`PostToolUse` inject via `additionalContext`; the adapter has no handler for them | `hook PreToolUse '{…"tool_name":"Bash"…}'` → 0 bytes, stderr `claude-code adapter has no handler for PreToolUse; nothing captured, nothing claimed` | Published capability is wrong | Read "Where the generated block is wrong"; fix belongs in `CLAUDE_CODE_MATRIX` (`src/adapters/claude-code.ts`) then regenerate |
| 2 | Generated matrix says `Stop` and `SubagentStop` inject; adapter prints nothing on either | `hook Stop '{…}'`, `hook SubagentStop '{…}'` → 0 bytes stdout | Same; SubagentStop row also claims injection with no receipt | As #1 |
| 3 | "Captured fields" column lists fields that are not persisted (`transcript_path`, `model`, `agent_type`, `custom_instructions`, `stop_hook_active`, `last_assistant_message` on Stop, `reason`) | `events show <session_start id>` → `result` has only `kind, host, session, start_source, cwd` | Operators over-trust the record | none |
| 4 | Each `SubagentStart` fire for the same `agent_id` writes a new `work` record and a new `injected` receipt | fire `SubagentStart` twice with `"agent_id":"agent-dup"` → two `work` records with identical payloads | If the host re-fires and skips injection (documented), the receipt asserts an injection that did not happen | none |
| 5 | Work records appear in the working set as `- [verified observation] <ULID>` — no content, and labelled as an observation | `hook SubagentStart '{…"agent_id":"agent-abc"…}'` → the subagent's own assignment as a bare id | Noise in every injected set; one line per dispatch, duplicated by #4 | none |
| 6 | After `PreCompact`, `SessionStart(source=compact)` (and `resume`) injects only records newer than the last injection; with nothing new it injects **nothing** | demo runs [8]–[10] → stderr `nothing to inject: the working set for this scope is empty` | The set injected before compaction is not re-sent. The empty resume [8] rewrites the session cursor without `last_payload_hash` and `last_receipt_id` (run shown under the demonstration), so the compaction observation [9] records `"last_payload_hash":null`. Whether the host's compaction drops the earlier injected set from the model's context is UNAVAILABLE (needs a live session) | Start a new session (`startup` injects the full set) |
| 7 | On a v3 store the plugin still emits 2.x gate prose: `stop-hook.sh` blocks Stop, `pre-commit-hook.sh` denies or allows `git commit` with "Call twining_record…" | see "Legacy scripts on a v3 store" | Gate instructions reach the model through block/deny reasons although the adapter injects none | none in the plugin; the scripts lack the `store.json "format": 3` guard |
| 8 | The capture shim finds no CLI unless the project has `./node_modules/twining-mcp` or `TWINING_CLI_JS` is set, so the v3 hooks capture nothing, silently | `sh plugin/scripts/launch-cli.sh --probe` from a project without `node_modules/twining-mcp` → `runner=none` | No v3 capture from the repo's hooks.json as shipped, except in projects that install twining-mcp locally | `export TWINING_CLI_JS=<checkout>/dist/cli/twining.js` |
| 9 | Installed plugin 1.34.1 has no v3 hooks; the repo's plugin is also 1.34.1 | `ls ~/.claude/plugins/cache/twining-marketplace/twining/1.34.1/hooks/` | A session loading the installed plugin cannot run v3 capture (inference from files; no session run) | Bump with `scripts/bump-plugin-version.sh` and release |
| 10 | `twining doctor` does not list the installed marketplace hooks; its `project` probe uses the process cwd, not `--project` | `node $C doctor --project $P` with real HOME → only `~/.claude/settings.json` and `~/.codex/hooks.json` | doctor cannot prove hooks are installed | Inspect the plugin cache directly. Pointer: `src/cli/v3-verbs.ts` `installedHookProvenance` |
| 11 | A hook's own receipt is not admitted until the next hook runs | `doctor` after the last hook → `admitted` = `total − 1`; one more hook → the earlier receipt is admitted | `doctor` counts lag by one event | Ignore a single-event lag |
| 12 | `SubagentStop` stores `last_assistant_message` as the worker's report; documentation says on ≥ 2.1.271 with `SubagentHandback` that field is only the closing note | documentation only; observing it is UNAVAILABLE (needs a real auto-mode session) | Wrong text captured as the worker's return in auto mode | none |
| 13 | `node dist/index.js --help` prints no help; it starts the 2.x server and creates a 2.x `.twining/` in the cwd | `node …/dist/index.js --help </dev/null` → stdout empty, stderr `[twining] Dashboard: http://127.0.0.1:<port>` | Stray store in whatever directory you ran it from | Use `dist/cli/twining.js --help` |
| 14 | `validate-records` reports `ok` on a v3 store without reading the event log | `node $C validate-records --project $P` → `records dir: absent  files checked: 0  store: files-era or empty` / `ok` | Not a v3 check | Use `doctor` / `events ls` |
| 15 | Generated block is pinned at `claude-code@2.1.272`; installed host is 2.1.291 | see "Host versions" | Per-event host behaviour unverified past 2.1.272 | none until a real-host run |

**Fixed in 0f9fd985:** hook bookkeeping observations (`session_start`, `compaction`) no longer appear in the working set, and real observations render their substance and revision instead of a bare id (afe8f34d; shown in the demonstration).

## Host versions

`claude --version` → `2.1.291 (Claude Code)`; `readlink ~/.local/bin/claude` → `…/.local/share/claude/versions/2.1.291`; `ls ~/.local/share/claude/versions` → `2.1.267 2.1.272 2.1.273 2.1.291`.

The matrix below is from the hooks documentation as surveyed for **2.1.272**. What was checked for later versions, by comparing installed binaries only:

- **2.1.273:** `--help` byte-identical to 2.1.272; the 33 quoted hook-event names (`LC_ALL=C grep -a -o -E '"(SessionStart|…|ElicitationResult)"' <binary> | sort -u`) identical. Its upstream CHANGELOG section (read before this commit, not re-fetched) names no hook event or field change.
- **2.1.291:** the same 33 event names (`diff` of the sets empty). `diff <(2.1.273 --help) <(2.1.291 --help)` changes: `--agents` now `<json-or-file>`; `--bare` now says "skip hooks (those defined in settings and by installed plugins; features built into Claude Code are unaffected)"; `--safe-mode` wording; new `--desktop`; `--model` drops its `'claude-fable-5'` example; `attach` and `logs` take `<id|name>` ("Part of the session name works too"); the `project` subcommand line is gone and `purge [options] [path]` is listed in its place. The quoted string `"mcp_server"` matches 0 lines in 2.1.273 and 2 lines in 2.1.291 — consistent with the documented ≥ v2.1.274 `mcp_server` tool-input field, not proof of it.
- **NOT VERIFIED at any version above 2.1.272:** per-event input fields and decision behaviour. That needs a live session. The hooks documentation was last read before 2.1.291 was installed and has not been re-fetched for this commit.
- The upstream CHANGELOG (read before this commit) lists, after 2.1.273, a `SessionStart` fix "sessions continued after `/clear` … missing part of their first message when a SessionStart hook printed output" (2.1.277) and a `SubagentStop` matcher fix for hooks "with a specific `matcher`" (2.1.275; the plugin registers `"matcher": "*"`). Whether either affected this adapter on the installed host is UNAVAILABLE (needs a live session).

## Host capability matrix — Claude Code 2.1.272 (documentation-derived)

Source: https://code.claude.com/docs/en/hooks (`docs.claude.com/en/docs/claude-code/hooks` redirects there). Rows are from the per-event input and decision tables; none is executed evidence.

Common input on every event: `session_id`, `prompt_id`, `transcript_path`, `cwd`, `scratchpad_dir` (may be absent), `permission_mode` (not on every event), `effort` (tool-use contexts only), `hook_event_name`, plus `agent_id`/`agent_type` inside a subagent. Universal output: `continue`, `stopReason`, `suppressOutput`, `systemMessage`, `terminalSequence`; event control via `decision`/`reason` or `hookSpecificOutput`. Documentation: each output string is capped at 10,000 characters; over the cap the host substitutes a file path plus a preview of the first 2,000 characters, with no setting to raise it. A Twining working set over 10,000 characters would therefore reach the model truncated — NOT DEMONSTRATED (no run fed one that large).

| Event | Matchers | Event-specific input | Injects into the model? | Can block? |
|---|---|---|---|---|
| SessionStart | `startup` `resume` `clear` `compact` `fork` | `source`, `model`, `agent_type`, `session_title`; resume/fork: cache-cost fields | **Yes** — stdout or `additionalContext` | No |
| Setup, InstructionsLoaded, MessageDisplay, PermissionDenied, Notification, StopFailure, CwdChanged, FileChanged | per event | per event | No (`MessageDisplay` is screen-only; `PermissionDenied` returns `retry` only) | No |
| UserPromptSubmit | none | `prompt` | **Yes** — stdout or `additionalContext` | Yes — exit 2 / `decision:"block"` |
| UserPromptExpansion | command name | `expansion_type`, `command_name`, `command_args`, `prompt` | **Yes** — stdout or `additionalContext` | Yes |
| PreToolUse | tool name | `tool_name`, `tool_input`, `tool_use_id` (+ `mcp_server` ≥ 2.1.274) | **Yes** — `additionalContext`; `permissionDecisionReason` reaches Claude on `deny` only | Yes — exit 2 / `permissionDecision` |
| PermissionRequest | tool name | `tool_name`, `tool_input`, `permission_suggestions` | No | Yes, via `decision.behavior` only (exit 2 not honoured) |
| PostToolUse | tool name | `tool_name`, `tool_input`, `tool_response` (+ `bashEditDiff` ≥ 2.1.269), `tool_use_id`, `duration_ms` | **Yes** — `additionalContext` | No (feedback only) |
| PostToolUseFailure | tool name | `error`, `is_interrupt`, … | **Yes** — `additionalContext` | No |
| PostToolBatch | none | `tool_calls[]` | **Yes** — `additionalContext` | Yes |
| SubagentStart | agent type | `agent_id`, `agent_type`; re-fires on resume and per team message | **Yes, into the subagent** | No |
| SubagentStop | agent type | `last_assistant_message`, `agent_transcript_path`, `stop_hook_active`, … | **Yes, into the subagent** | Yes |
| TaskCreated, TaskCompleted, TeammateIdle, ConfigChange, PreModelSwitch | per event | per event | No (`PreModelSwitch` explicitly refuses `additionalContext`) | Yes (ConfigChange: not `policy_settings`) |
| Stop | none | `stop_hook_active`, `last_assistant_message`, … | **Yes** — `additionalContext` | Yes — 8-continuation cap |
| DirectoryAdded | `slash_command` `register_repo_root` | `directory`, `source` | Only `systemMessage`, only for `slash_command` | No |
| WorktreeCreate / WorktreeRemove | none | `name` / `worktree_path` | No | Yes / partial |
| PreCompact | `manual` `auto` | `trigger`, `custom_instructions` | **No** | Yes |
| PostCompact | `manual` `auto` | `trigger`, `compact_summary` | **No** | No |
| PostModelSwitch | model | as PreModelSwitch | **Yes** — stdout or `additionalContext` | No |
| SessionEnd | exit reason | `reason` | **No** — output discarded | No; 1.5 s budget, which a plugin hook's `timeout` does not raise |
| Elicitation / ElicitationResult | MCP server | `mcp_server_name`, `action`, … | No (goes to the MCP server) | Yes |

That is 33 events; rows that share a line share their answers. Cannot inject into the model's turn (21): Setup, InstructionsLoaded, MessageDisplay, PermissionRequest, PermissionDenied, Notification, TaskCreated, TaskCompleted, StopFailure, TeammateIdle, ConfigChange, CwdChanged, FileChanged, WorktreeCreate, WorktreeRemove, PreCompact, PostCompact, PreModelSwitch, SessionEnd, Elicitation, ElicitationResult. DirectoryAdded is the edge case.

## What Twining registers on this host

`plugin/hooks/hooks.json` at 0f9fd985, listed with `node -e` over the file — twelve registrations:

| Event | Matcher | Command | timeout (s) |
|---|---|---|---|
| SessionStart | `*` | `session-start-context.sh` (2.x gate text; guarded — silent on a v3 store) | 5 |
| SessionStart | `startup\|resume\|clear\|compact\|fork` | `v3-capture-hook.sh claude-code SessionStart` | 15 |
| UserPromptSubmit | `*` | `v3-capture-hook.sh claude-code UserPromptSubmit` | 15 |
| PreCompact | `manual\|auto` | `v3-capture-hook.sh claude-code PreCompact` | 10 |
| SubagentStart | `*` | `v3-capture-hook.sh claude-code SubagentStart` | 15 |
| PreToolUse | `Bash` | `pre-commit-hook.sh` (2.x commit gate; **unguarded**) | 5 |
| PostToolUse | `Edit\|Write\|MultiEdit\|NotebookEdit` | `activity-marker-hook.sh` (2.x session marker; **unguarded**) | 5 |
| Stop | `*` | `stop-hook.sh` (2.x stop gate; **unguarded**) | 10 |
| Stop | `*` | `v3-capture-hook.sh claude-code Stop` | 15 |
| SubagentStop | `*` | `subagent-stop-hook.sh` (2.x status post; guarded) | 10 |
| SubagentStop | `*` | `v3-capture-hook.sh claude-code SubagentStop` | 15 |
| SessionEnd | `*` | `v3-capture-hook.sh claude-code SessionEnd` | 5 (does not raise the 1.5 s budget, per documentation) |

The adapter acts only on a **v3 store** (`.twining/store.json` with `"format": 3`). The block below is generated from `CLAUDE_CODE_MATRIX` and pinned byte-for-byte by `test/adapters/host-matrix-docs.test.ts`; do not hand-edit it. Re-rendered from the build at 0f9fd985, `doc.includes(renderMatrixTable(CLAUDE_CODE_MATRIX))` is `true`. It is wrong in places (next section).

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

## Where the generated block is wrong

1. **`PreToolUse`/`PostToolUse`:** the adapter has no handler (runs [13]/[14] below), and hooks.json routes those events to the 2.x scripts, whose channel is `permissionDecision` (deny/allow) or nothing. Fix in `CLAUDE_CODE_MATRIX`: `injects: false, channel: null, captures: []`.
2. **`Stop`/`SubagentStop` "Injects? yes":** every Stop, SubagentStop and SessionEnd run below printed 0 bytes on stdout, on both v3 and 2.x stores. The "Injects on" summary should be SessionStart, UserPromptSubmit, SubagentStart.
3. **"Captured fields"** means "read from the host payload", not "persisted" — see the `events show` output below. `cwd` is persisted as `source` provenance (`repo`, `worktree`, `branch`, `commit`, `dirty`) on every event.
4. **`SubagentStart`** does not mention the documented re-fire, and the adapter does not dedupe (defect 4).
5. **`SubagentStop`** captures `last_assistant_message` as the report (defect 12).
6. **`Stop` — "never blocks"** is true of the capture hook only; the registered `stop-hook.sh` can block on a v3 store (defect 7).
7. The marker `claude-code@2.1.272` comes from `CLAUDE_CODE_MATRIX.version` and cannot be bumped without asserting a verification that has not happened.

## Offline demonstration of `twining hook claude-code <Event>`

This shows the adapter's parse → append → render → receipt path and the exact bytes it hands the host. It does not show that Claude Code fires these events with these fields.

Setup (any empty directory `$S`; identity and HOME are redirected so no real key is read or minted):

```sh
export TWINING_OFFLINE=1 HOME=$S/home TWINING_IDENTITY_HOME=$S/home/idh
C=<checkout at 0f9fd985>/dist/cli/twining.js
P=$S/project; mkdir -p $P && cd $P && git init -q -b main && git commit -q --allow-empty -m seed
hook() { printf '%s' "$2" | node $C hook claude-code "$1" --project "$P"; }
node $C identity init --project $P          # [1] ok:true, store.format 3, created:true
cat .twining/store.json                     # [2] multi-line JSON: store_id, repo_ids:["r_…"], format:3, created_at
```

Every payload below also carries `"hook_event_name"`, `"session_id"` and `"cwd":"$P"`; only the event-specific fields are shown. Every run exited 0.

```
[3]  SessionStart {"source":"startup","model":"…","transcript_path":"…"}        session demo-sess-1
     stdout empty; stderr: [twining] nothing to inject: the working set for this scope is empty
[4]  UserPromptSubmit {"prompt_id":"prompt-0001","prompt":"Audit the hosts doc against the merged tree. Do not edit the repo."}
     stdout: {"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"…"}}  (text below)
[5]  Stop {"stop_hook_active":false,"last_assistant_message":"Done."}   → stdout empty, stderr empty
[6]  SessionEnd {"reason":"prompt_input_exit"} → stdout empty; stderr: [twining] SessionEnd discards all hook output on this host; flush only.
[7]  SessionStart {"source":"startup"}  session demo-sess-2 → the same text as [4], hookEventName SessionStart
```

The `additionalContext` of [4] and [7] (the session_start observation [3] wrote is no longer listed):

```
## Twining — working set for this scope

- [human statement] status: Audit the hosts doc against the merged tree. Do not edit the repo.
  scope: session:demo-sess-1
  (does not authorize action on its own)

Evidence class is stated per item and is NOT changed by the wording of the item. Only a RULING carries human authority; everything else is a claim.
```

Receipt binding: `cat .twining/adapters/sessions/demo-sess-2.json` shows `last_injected_event`, `last_receipt_id`, `last_payload_hash`, `turns: 1`; the sha256 of [7]'s `additionalContext` string equals `last_payload_hash`.

```
[8]  SessionStart {"source":"resume","seconds_since_last_response":42,…}  → stdout empty; stderr: nothing to inject: the working set for this scope is empty
     the session file now holds only session_id, last_injected_event (unchanged), updated_at, turns: 2 — last_receipt_id and last_payload_hash are gone
[9]  PreCompact {"trigger":"auto","custom_instructions":null}
     stdout empty; stderr: [twining] PreCompact cannot inject context on this host — additionalContext is discarded. Re-seeding rides SessionStart(source=compact).
[10] SessionStart {"source":"compact"}  → stdout empty; stderr: nothing to inject: the working set for this scope is empty
     session file: the same four keys, turns: 3
[11] SubagentStart {"agent_id":"agent-abc","agent_type":"Explore"}
     stderr: [twining] SubagentStart injects into the SUBAGENT, never the parent session.
     additionalContext: "## Twining — working set for this scope" +
       - [verified observation] 01M4925BEAC7B0APN9JFBXYKCX      ← the work record [11] just wrote (defect 5)
         scope: session:demo-sess-2
       + the human statement + trust footer
[12] SubagentStop {"agent_id":"agent-abc","last_assistant_message":"Task complete. Nothing else to report here.",…}
     stdout empty; stderr: [twining] a worker return is a reported_result — it is not completion, merge or acceptance
[13] PreToolUse {"tool_name":"Bash","tool_input":{"command":"git commit -m x"}}
     stdout empty; stderr: [twining] claude-code adapter has no handler for PreToolUse; nothing captured, nothing claimed
[14] PostToolUse {"tool_name":"Edit",…}  → the same with PostToolUse
[15] Stop → stdout empty, stderr empty         [16] SessionEnd {"reason":"other"} → stdout empty, flush-only note
[17] stdin `this is not json` → stdout empty; stderr: twining hook: could not parse the host's JSON on stdin (Unexpected token 'h', …)
[18] stdin `null` → stdout empty; stderr: twining hook: the host's stdin was valid JSON but not an object; nothing captured
[19],[20] SubagentStart {"agent_id":"agent-dup"} twice → each injects; the [20] set lists three bare-id work records
          (agent-abc, agent-dup, agent-dup) above the reported result "status: Worker returned: Explore (agent-abc) — review pending"
```

What was persisted — `node $C events ls --project $P --limit 200` lists 18 events (5 observations, 2 posts, 3 work, 8 receipts); `node $C events show <id> --project $P` gives these payloads:

```
session_start observation  result {"kind":"session_start","host":"claude-code","session":"demo-sess-2","start_source":"startup","cwd":"$P"}
compaction observation     result {"kind":"compaction",…,"trigger":"auto","last_injected_event":"01M4…","last_payload_hash":null,"turns":2,"transcript":null,"injects":false,"injection_channel":null}
work (×2 for agent-dup)    {"kind":"assignment","system":"claude-code","external_id":"agent-dup","owner":"demo-sess-2","stage":"dispatched","agent_type":"Explore","authority":"reference only; this record grants nothing"}
reported_result post       {"entry_type":"status","summary":"Worker returned: Explore (agent-abc) — review pending","detail":"Task complete. Nothing else to report here.",
                            "finisher":{…,"agent":"agent-abc"},"stage":"worker_returned_review_pending","task_completion_state":"not_complete",
                            "acceptance_state":"none_recorded","merge_state":"not_merged","next_action":{"ordered":true,"items":[review, requalify, human acceptance]},
                            "original_text_preserved":true,"promoted":false}
projected receipt          {"stage":"projected","consumer":"p_…","cursor":{"transport":"local","position":"01M4…"},"host":"h_…","session":"demo-sess-2"}
```

`node $C doctor --project $P` → `events {"total":19,"admitted":18,…}` (defect 11; one more `Stop` hook then gives 20/19 and a second 21/20 — the lag stays at one event), `bindings.store_format 3`, `repo_ids == repo_ids_cited`, `repo_ids_undeclared []`, `v3_enabled true`, `capture_coverage.claude-code` 7/7 "supported" (its `honest_limits` says this describes the adapter, not an installation), `hooks []` under the scratch HOME. `migrate-status` → `"format": 3, "migration": "not_started"` on a store made by `identity init`. **Timing:** a `SessionEnd` flush, including node start-up, took about 0.13–0.15 s on this store (tens of events). Nothing larger was measured; the host's own accounting under its 1.5 s budget was not observed.

### How an observation and a revision-bound record render (afe8f34d)

No CLI verb writes an observation or a revision-bound record into a v3 store at this commit (`twining --help`, `twining capabilities`); the hooks write only bookkeeping observations, which the renderer now omits. To see the new rendering, append through the same runtime the hook verb uses, after a second commit (`git commit -q --allow-empty -m second`):

```js
// node seed.mjs $P   (same env as above)
import { openRuntime } from "<checkout>/dist/adapters/runtime.js";
import { execSync } from "node:child_process";
const P = process.argv[2], rt = openRuntime({ projectRoot: P }), git = (r) => execSync(`git rev-parse ${r}`, { cwd: P }).toString().trim();
await rt.append({ kind: "created", recordType: "observation", evidenceClass: "verified_observation", ingress: "adapter",
  scope: { ...rt.scope, path: "src/auth/" },
  payload: { source_kind: "commit", source_uri: "git log", base: git("HEAD~1"), head: git("HEAD"), observed_at: new Date().toISOString(),
             volatile: false, check_method: "git diff --stat", result: { files_changed: 1, insertions: 3 } } });
await rt.append({ kind: "created", recordType: "post", evidenceClass: "proposal", ingress: "adapter",
  scope: { ...rt.scope, path: "src/auth/", revision: { head: git("HEAD") } },
  payload: { entry_type: "finding", summary: "Token refresh retries twice before failing" } });
```

Then `hook SessionStart '{…"session_id":"demo-sess-3","source":"startup"}'` injected (abridged to the new lines):

```
## Twining — working set for this scope

- [verified observation] files_changed=1 insertions=3
  observed: commit git log via git diff --stat · at 2026-10-06T16:54:15.331Z · volatile: no · over 72aca041..ebae9e39
  scope: src/auth/
- [verified observation] 01M4925CD0T0FHY9JBKZGFRV3R        ← work records, still bare ids (defect 5)
  scope: session:demo-sess-2
…
- [proposal] finding: Token refresh retries twice before failing
  scope: src/auth/ · revision @ebae9e39
  (does not authorize action on its own)
```

An observation now renders its `result` as sorted `key=value` pairs (or its `summary`), its source and check method, and `over base..head` for the range it checked; a record bound to one commit renders `revision @<head>` on its scope line. Shas are shortened to 8 characters.

## Legacy scripts on a v3 store

Same store, run from `$P` with `CLAUDE_PLUGIN_ROOT=<checkout>/plugin`, payload on stdin, e.g. `printf '%s' '{…}' | bash plugin/hooks/pre-commit-hook.sh`:

| Script and condition | Output |
|---|---|
| `session-start-context.sh` | nothing (guarded) |
| `pre-commit-hook.sh`, `git commit -m x`, `.twining/.last-record` = HEAD commit time − 50 s (or equal) | `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Call twining_record before committing — summarize what you did and any choices you made."}}` |
| same, `.last-record` = HEAD + 50 s; or the command is `ls -la` | nothing |
| same, `.last-record` absent | `…"permissionDecision":"allow","permissionDecisionReason":"Twining has no record sentinel in this checkout (fresh clone or MCP server unavailable) — allowing the commit. Call twining_record once the server is up."` (documentation: an `allow` reason is shown to the user, not Claude — not observed) |
| `activity-marker-hook.sh`, Edit inside `$P` | nothing on stdout; writes `.twining/.sessions/<session_id>` = epoch seconds |
| same, Edit of `/etc/hosts` | nothing; no marker written |
| `stop-hook.sh`, marker newer than `.last-record` | `{"decision":"block","reason":"This session edited files after the last twining_record. Call twining_record before ending — what changed, choices you made, and any findings, warnings, or surprises worth leaving for the next session."}` |
| same with `"stop_hook_active":true`; or `.last-record` absent; or marker absent; or `.last-record` newer | nothing |
| `subagent-stop-hook.sh` | nothing; no `.twining/pending-posts.jsonl` (guarded) |

The gate's inputs do come into existence on a v3 store: the 2.x MCP server (`node <checkout>/dist/index.js --project $P`, what `plugin/.mcp.json` launches), driven over stdio through `initialize` → `tools/call twining_post`, answered `{"id":"01M4…","timestamp":"…"}`. On a fresh v3 store (only `store.json`, from `identity init`) that one call also created 2.x state beside it: `.twining/` then held `.gitignore`, `.last-record`, `metrics.jsonl`, `records/`, `store.json` and `twining.db`. `store.json` stayed format 3. So, as registered, "the capture hook never blocks; the legacy stop gate still can".

## Behaviour on a 2.x store

Make one with `node <checkout>/dist/index.js --help </dev/null` in a seeded git repo (defect 13: this creates `.twining/{agents,archive,blackboard.jsonl,config.yml,decisions,embeddings,graph,handoffs,twining.db}` and no `store.json`). Then:

- `hook SessionStart '{…"source":"startup"}'` → the 2.x lifecycle-gate text (892 characters; begins `## Coordination — Twining Lifecycle Gates`, names Gate 1 `twining_assemble`/`twining_why` and Gate 2 `twining_record`), stderr `[twining] store is not v3-enabled; emitting the 2.x lifecycle-gate context unchanged`. `session-start-context.sh` on the same store prints byte-identical output (`cmp`).
- `hook UserPromptSubmit '{…}'` → nothing; stderr `[twining] store is not v3-enabled; no capture`.
- `v3-capture-hook.sh claude-code SessionStart` → nothing.
- `subagent-stop-hook.sh` appends `{"entry_type":"status","summary":"Subagent completed: Explore",…}` to `.twining/pending-posts.jsonl` (its 2.x job).
- PreCompact, SubagentStart, SubagentStop, PreToolUse, PostToolUse, Stop, SessionEnd through `hook` → stdout empty for all seven (SubagentStop: `store is not v3-enabled; no capture`; the others print their usual notes), and an md5 of every file under `.twining/` before and after is unchanged.

## Installed plugin and the capture shim

From `/Users/dave/code/twining-mcp` (the project-scope answer depends on the cwd; from another directory both scopes print `✘ disabled`):

```
$ claude plugin list
  ❯ twining@twining-marketplace   Version: 1.34.1   Scope: project   Status: ✔ enabled
  ❯ twining@twining-marketplace   Version: 1.34.1   Scope: user      Status: ✔ enabled
    Note: Disabled in ~/.claude/settings.json but still loads — project settings enable it, which overrides your user setting
$ ls ~/.claude/plugins/cache/twining-marketplace/twining/1.34.1/hooks/
activity-marker-hook.sh hooks.json pre-commit-hook.sh session-start-context.sh stop-hook.sh subagent-stop-hook.sh
$ grep -c v3-capture-hook ~/.claude/plugins/cache/twining-marketplace/twining/1.34.1/hooks/hooks.json  → 0
$ grep '"version"' plugin/.claude-plugin/plugin.json .claude-plugin/marketplace.json  → both "1.34.1"
$ git log --oneline -3 -- plugin/hooks/v3-capture-hook.sh plugin/.claude-plugin/plugin.json
9e67c637 fix(runtime): lane 03 review round …   fb35c17b feat(runtime): lane 03 …   f4487e78 chore(plugin): 1.34.1 — 2.16.1 bundle rebuild
```

The v3 hooks were added after the last plugin bump, so the installed and in-repo 1.34.1 differ. That a session loading the installed plugin runs no v3 capture is an inference from these files; no session was run, and other registrations (settings.json hooks, a local plugin path) were not checked. CI's `plugin-version-check` job would fail a PR with `plugin/` changes and no bump *(from source, not a run)*.

The shim:

```
$ sh plugin/scripts/launch-cli.sh --probe                 → runner=none node=v26.8.2
$ command -v twining                                       → (nothing)
$ ls plugin/server                                         → public  twining-server.mjs     (no twining-cli.mjs)
$ printf '%s' '{…SessionStart…}' | bash plugin/hooks/v3-capture-hook.sh claude-code SessionStart   → nothing, exit 0
$ TWINING_CLI_JS=<checkout>/dist/cli/twining.js sh plugin/scripts/launch-cli.sh --probe            → runner=override
  …and the same shim call then printed {"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"## Twining — working set…
$ ln -s <checkout> $P/node_modules/twining-mcp; cd $P && sh plugin/scripts/launch-cli.sh --probe   → runner=pin (shim call then injects as above)
```

The shim's rungs are override (`TWINING_CLI_JS`), pin (`./node_modules/twining-mcp/dist/cli/twining.js`, relative to the hook's cwd), bundled (`plugin/server/twining-cli.mjs`), global (`twining` on PATH). `scripts/build-plugin-bundle.mjs` does not emit `twining-cli.mjs` and there is deliberately no npx rung *(from source, not a run)*. Exiting 0 silently when no CLI is found is the right failure mode for a hook, but it is the outcome in every project that neither installs twining-mcp locally nor sets `TWINING_CLI_JS`.

`twining doctor` with the real HOME (identity file mtime unchanged before/after) reported `hooks`: `{"scope":"user","file":"~/.claude/settings.json","mentions_twining":true}` (the `enabledPlugins` entry, not a hook) and `{"scope":"codex-user","file":"~/.codex/hooks.json","mentions_twining":false}`. Run from `/Users/dave/code/twining-mcp` instead of a scratch directory, the same command (same `--project`) adds `{"scope":"project","file":"/Users/dave/code/twining-mcp/.claude/settings.json"}` — the probe follows the cwd. The marketplace cache path is not probed, and `~/.claude/plugins/twining/hooks/hooks.json`, which is probed, does not exist (defect 10).

## Honest limits on this host

- **PreCompact and PostCompact cannot inject.** Compaction is captured at PreCompact (run [9]) and re-seeding rides `SessionStart(source=compact)` — which re-sends only records newer than the last injection, and nothing when there are none (defect 6).
- **SessionEnd discards all output** and runs under a 1.5 s session-end budget that the plugin's `"timeout": 5` does not raise (documentation). The flush there is admit + project + one `projected` receipt (run [16]).
- **SubagentStart/SubagentStop inject into the subagent, never the parent**, and the adapter injects on SubagentStart only. A worker's return reaches the parent at the parent's next injecting event.
- **A worker return is never a completion**: `task_completion_state: "not_complete"`, `acceptance_state: "none_recorded"`, `merge_state: "not_merged"`, an ordered three-step `next_action`. Its `detail` is the host's `last_assistant_message`, which in auto mode with `SubagentHandback` is the closing note, not the report (defect 12).
- **The adapter injects no gate prose on a v3 store** (runs [4], [7]: working set plus trust footer only; `session-start-context.sh` silent), **but the plugin as registered does**, through `stop-hook.sh` and `pre-commit-hook.sh` (defect 7).
- **Capture does not happen as shipped**: the shim resolves no CLI (defect 8) and the installed plugin has no v3 hooks (defect 9).
- **Working-set size**: a set over the host's 10,000-character cap would arrive as a 2,000-character preview (documentation; not demonstrated).

## Real-host status

- **Recorded, not reproduced here — Claude Code 2.1.272.** Blackboard post `01M2KK1826S7045HRAMF5EJ1T9` is in git at 0f9fd985 (`git show 0f9fd985:.twining/records/posts/2026-09/01M2KK1826S7045HRAMF5EJ1T9.json`) but deleted, uncommitted, in the working tree of the main checkout. Its `detail` field, minus the leading `Full summary: `: "Lane 03 real-host evidence (Claude Code 2.1.272, temp synthetic project, TWINING_REAL_HOST=1): session_start + human_statement events and 3 receipts captured; the injected receipt's payload_hash equals sha256 of the bytes the hook printed. Claude Code: SessionStart/UserPromptSubmit/SubagentStart inject; PreCompact/SessionEnd cannot and say so; SubagentStop writes reported_result with finisher/stage/next_action and denies completion. Codex: 5 injecting events, 7 observe-only; hook trust blocks automated verification." That run is `test/adapters/real-host.test.ts`, `describe.skipIf(!REAL)("Claude Code, real host")`, three cases (one-shot `claude -p` session capturing the prompt; a dispatched subagent producing a work reference and a reported_result; the injected receipt's hash matching the bytes handed to the host). It does not cover PreCompact, SessionStart resume/compact/fork/clear, Stop, SessionEnd or the SubagentStart re-fire. No transcript or log of it was kept.
- **UNAVAILABLE — a real-host run at 2.1.273 or 2.1.291.** Command: `cd <checkout> && TWINING_REAL_HOST=1 npx vitest run test/adapters/real-host.test.ts -t "Claude Code"`. It launches real `claude -p` sessions and runs vitest, neither of which was permitted for this document. Until it runs, every host-behaviour row is documentation-verified only.
- **UNAVAILABLE**, each needing a live session: whether the host drops hook-injected context at compaction (bears on defect 6); whether the host skips injection on a SubagentStart re-fire (defect 4); `SubagentHandback`'s effect on `last_assistant_message` (defect 12, needs auto mode); whether 2.1.291 delivers `mcp_server`; whether the 2.1.277 `/clear` + SessionStart-output defect affected the installed host before 2.1.291; whether `permissionDecisionReason` on `allow` reaches the model.
