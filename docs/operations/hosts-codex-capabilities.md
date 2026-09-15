# Codex CLI (OpenAI) — /opt/homebrew/bin/codex → /opt/homebrew/Caskroom/codex/0.154.0/bin/codex (Mach-O arm64, Homebrew cask) — codex-cli 0.154.0

Hook capability matrix gathered in Stage 0 (workflow wf_f80a3b3b-ac2, 2026-09-15). Read-only survey of the installed host plus official docs; no model sessions were run. Lane 03 must re-verify every row in the real host before relying on it.

# Codex CLI 0.154.0 — Hook & Injection Capability Matrix

Verified two ways: (1) the official docs at `https://learn.chatgpt.com/docs/hooks` (`https://developers.openai.com/codex/hooks` 308-redirects there), and (2) the **JSON Schemas embedded in the installed binary itself** (`strings` over `/opt/homebrew/Caskroom/codex/0.154.0/bin/codex`, schema titles `<event>.command.input` / `<event>.command.output`). Where the two disagree, **the binary is authoritative and is what is recorded below**. No Codex session was started; nothing calling a model was run.

## Event inventory — exactly 12

The binary's `HookEventName` enum and the set of embedded schemas both yield the same 12 and no more:

`PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `SubagentStart`, `SubagentStop`, `Stop`, `Interrupt`

## The matrix

| Event | Input fields (required unless noted) | Inject context? | Channel | Block / deny? |
|---|---|---|---|---|
| **SessionStart** | `session_id`, `transcript_path` (nullable), `cwd`, `hook_event_name`, `model`, `permission_mode`, `source` ∈ `startup\|resume\|clear\|compact` | **YES** | `hookSpecificOutput.additionalContext` | No |
| **SessionEnd** | `session_id`, `transcript_path` (nullable), `cwd`, `hook_event_name`, `reason` (const `other`) | **NO** | — (no output schema exists at all) | No |
| **UserPromptSubmit** | `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, `permission_mode`, `turn_id`, `prompt`; optional `agent_id`, `agent_type` | **YES** | `hookSpecificOutput.additionalContext` | **YES** — `decision:"block"` + `reason`, or exit 2 |
| **PreToolUse** | `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, `permission_mode`, `turn_id`, `tool_name`, `tool_use_id`, `tool_input`; optional `agent_id`, `agent_type` | **YES** | `hookSpecificOutput.additionalContext` | **YES** — `hookSpecificOutput.permissionDecision` ∈ `allow\|deny\|ask`, or top-level `decision` ∈ `approve\|block`, or exit 2. Also **mutates** via `hookSpecificOutput.updatedInput` |
| **PermissionRequest** | `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, `permission_mode`, `turn_id`, `tool_name`, `tool_input`; optional `agent_id`, `agent_type` | **NO** | `hookSpecificOutput` exists but holds only `hookEventName` + `decision` — **no `additionalContext` member** | **YES** — `hookSpecificOutput.decision.behavior` ∈ `allow\|deny` (+ `message`). Any `deny` wins across hooks |
| **PostToolUse** | `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, `permission_mode`, `turn_id`, `tool_name`, `tool_use_id`, `tool_input`, `tool_response` | **YES** | `hookSpecificOutput.additionalContext` | **YES** — `decision:"block"` + `reason`, or exit 2. Also **mutates** via `hookSpecificOutput.updatedMCPToolOutput` |
| **PreCompact** | `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, `turn_id`, `trigger` ∈ `manual\|auto`; optional `agent_id`, `agent_type` | **NO** | — (**output schema has no `hookSpecificOutput` member**) | Halt-only — `continue:false` + `stopReason` |
| **PostCompact** | `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, `turn_id`, `trigger` ∈ `manual\|auto`; optional `agent_id`, `agent_type` | **NO** | — (**output schema has no `hookSpecificOutput` member**) | Halt-only — `continue:false` + `stopReason` |
| **SubagentStart** | `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, `permission_mode`, `turn_id`, `agent_id`, `agent_type` | **YES** | `hookSpecificOutput.additionalContext` | No (`continue:false` parses but is not honored) |
| **SubagentStop** | above **plus** `agent_transcript_path` (nullable), `stop_hook_active` (bool), `last_assistant_message` (nullable) | **NO** | — (no `hookSpecificOutput` member) | `decision:"block"` + `reason`, or exit 2 — semantics are *continue the subagent*, not reject |
| **Stop** | `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, `permission_mode`, `turn_id`, `stop_hook_active`, `last_assistant_message` | **NO** | — (no `hookSpecificOutput` member) | `decision:"block"` + `reason`, or exit 2 — tells Codex to **continue**, does not reject the turn |
| **Interrupt** | `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, `permission_mode`, `turn_id` | **NO** | — output schema is **`systemMessage` only** | No — purely advisory; 1–3 s budget |

All input schemas are `draft-07`, `additionalProperties: false`. `permission_mode` enum is `default | acceptEdits | plan | dontAsk | bypassPermissions`. `turn_id` is documented in-schema as *"Codex extension: expose the active turn id to internal turn-scoped hooks."*

## Stated plainly: which events observe without injecting

**Five events can inject**, all through the single field `hookSpecificOutput.additionalContext` (string): `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `SubagentStart`. These are exactly the five `*HookSpecificOutputWire` definitions in the binary that declare an `additionalContext` property.

**Seven events observe only** — they cannot put text in front of the model: `PermissionRequest`, `PreCompact`, `PostCompact`, `SessionEnd`, `Stop`, `SubagentStop`, `Interrupt`.

### Pre/post-compaction is not an injection channel — verified

The package's claim is **correct**, and it holds at the schema level, not merely by convention:

- The docs state outright, under *Output Constraints*: *"Events Cannot Inject Context: `PermissionRequest`, `PreCompact`, `PostCompact`, `SessionEnd`, `Stop`, `Interrupt`, `SubagentStop`."*
- The binary corroborates structurally. `pre-compact.command.output` and `post-compact.command.output` are `additionalProperties: false` objects whose **entire** property set is `continue`, `stopReason`, `suppressOutput`, `systemMessage`. There is no `hookSpecificOutput` member and no `PreCompactHookSpecificOutputWire`/`PostCompactHookSpecificOutputWire` definition anywhere in the binary. A compaction hook returning `additionalContext` would be rejected by its own output schema.

The practical consequence: a hook can *watch* compaction happen (and can abort it with `continue:false`), but **the outcome of compaction cannot be fed back to the model by the hook**. To get text in after a compaction you must ride `SessionStart` with `source == "compact"`, which is a genuine injection channel. That is the supported re-seeding path.

`systemMessage` on the non-injecting events surfaces to the **user/transcript**, not as model context — do not mistake it for an injection channel.

## Notable divergences: shipped binary vs. published docs

Recorded because they are load-bearing if you write hooks against the doc page:

1. **`SessionEnd` has no `model` and no `permission_mode`.** The docs list both. The binary's required set is only `cwd`, `hook_event_name`, `reason`, `session_id`, `transcript_path`. `SessionEnd` also has **no output schema at all** — it is pure fire-and-forget, and separately cannot use `mcp_tool` handlers and always runs synchronously even when `async: true`.
2. **`PreCompact`/`PostCompact` have no `permission_mode`.** The docs list it; the binary does not.
3. **`PreToolUse.permissionDecision` has three values, not two**: `allow | deny | ask`. The docs show only `deny|allow`. There is additionally a distinct top-level `decision` enum `approve | block`.
4. **`PostToolUse` has an undocumented mutation field**: `hookSpecificOutput.updatedMCPToolOutput` — it can rewrite an MCP tool's result before the model sees it. This is a second, more powerful channel than `additionalContext` and is absent from the doc page.
5. **`PermissionRequest` has three reserved fields that fail closed**: `interrupt`, `updatedInput`, `updatedPermissions`. The schema descriptions say verbatim *"PermissionRequest hooks currently fail closed if this field is present"* (and if `interrupt` is `true`). Emitting them denies the action.
6. **`Interrupt`'s output is `systemMessage` only** — it lacks even `continue`/`suppressOutput`, narrower than the docs imply.

## Tool coverage — apply_patch and exec_command

There are no dedicated per-tool events. File edits and shell execution are reached by **matching on `tool_name` within `PreToolUse`/`PostToolUse`/`PermissionRequest`**. Documented `tool_name` values are `Bash`, `apply_patch`, or an MCP tool name, and for `apply_patch` the matcher also accepts the aliases `Edit` and `Write`. Note the binary's own internal tool identifiers are `apply_patch` and `unified_exec` — `Bash`/`Edit`/`Write` are Claude-compatibility names presented at the hook boundary. Verify the exact `tool_name` string your build emits by logging one `PreToolUse` payload before hard-coding a matcher.

## Handlers, matchers, limits

- **Two handler types.** `type: "command"` (fields `command`, `timeout` default 600 s, `async`, `statusMessage`, `additionalContextLimit`, plus a `Windows` variant) and `type: "mcp_tool"` (fields `server`, `tool`, `input` with `${field.nested}` placeholders, `timeout`, `statusMessage`). MCP-tool hooks run synchronously, request no tool approval, and trigger no further hooks. `SessionEnd` does not support `mcp_tool`.
- **Matcher targets.** `tool_name` for the three tool events; `trigger` for `PreCompact`/`PostCompact`; `source` for `SessionStart`; `agent_type` for `SubagentStart`/`SubagentStop`. Matchers are **ignored** for `UserPromptSubmit`, `Stop`, `Interrupt`.
- **Injection budget.** ~2,500 tokens per hook by default, tunable per handler via `additionalContextLimit`. Overflow spills to `<temp_dir>/hook_outputs/<session_id>/<uuid>.txt` and the model receives a head-and-tail preview. The binary carries the string `ignoring additionalContextLimit for …`, so the cap is silently dropped for handlers where it does not apply.
- **Background hooks.** `async: true`; max **8 concurrent** per session; cannot block; output is delivered "at the next safe point in the conversation."
- **Discovery/precedence.** `~/.codex/hooks.json` → `~/.codex/config.toml` → `<repo>/.codex/hooks.json` → `<repo>/.codex/config.toml`. TOML inline form is `[[hooks.EventName]]` / `[[hooks.EventName.hooks]]`. Kill switch: `[features] hooks = false`.

## Plugins: install, trust, and PLUGIN_ROOT

**Install.** Via `codex plugin add|list|remove` and `codex plugin marketplace` (confirmed in `codex plugin --help` on this machine). Marketplaces are `marketplace.json` files at **repo scope** `$REPO_ROOT/.agents/plugins/marketplace.json` and **personal scope** `~/.agents/plugins/marketplace.json` — both paths are present as literal strings in the binary. Entry `source` types: `local`, `url`, `git-subdir`, `npm`. `policy.installation` ∈ `AVAILABLE | INSTALLED_BY_DEFAULT | NOT_AVAILABLE`. Installs cache to `~/.codex/plugins/cache/$MARKETPLACE_NAME/$PLUGIN_NAME/$VERSION/`. A plugin may carry skills (`skills/<name>/SKILL.md`), MCP servers (`mcp.json`), hooks, assets, and app mappings (`.app.json`); the portable manifest is `plugin.json` (`$schema: https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`) with an optional Codex overlay at `.codex-plugin/plugin.json`. When `extensions.com.openai` is an object it **replaces** that overlay wholesale — the two are not merged.

**Hooks need separate trust — yes, definitively.** Two independent gates:

1. *Project trust.* The binary states: *"config, hooks, and exec policies are disabled in the following folders until the project is trusted, but skills still load."* Note the asymmetry — **skills load in an untrusted project, hooks do not**.
2. *Per-hook trust, by content hash.* Codex records trust against the hook definition's hash (`HookStateToml { enabled, trusted_hash }`, persisted under `hooks.state`). `HookTrustStatus` is `managed | trusted | untrusted | modified`. The TUI carries the strings *"New hook - review required"*, *"Modified since last trusted - review required"*, *"Hooks need review"*, *"Hooks can run outside the sandbox after you trust them."*, *"Trust all and continue"*, *"Continue without trusting (hooks won't run)"*. **Editing a trusted hook re-arms the gate** — the hash no longer matches and it reverts to `modified`. Manage with `/hooks` in the CLI.

**Installing a plugin does not trust its hooks.** Docs, verbatim: *"Installing or enabling a plugin doesn't automatically trust its hooks. Plugin-bundled hooks are non-managed hooks, so Codex skips them until the user reviews and trusts the current hook definition."* The binary carries the matching runtime paths: `failed to trust materialized plugin hooks`, `skipping materialized plugin hook trust after account changed`, `(plugin hook trust update was cancelled: …)`. **Changing accounts re-arms plugin hook trust.**

**Bypass and enterprise override.** `--dangerously-bypass-hook-trust` (env `BYPASS_HOOK_TRUST`) runs enabled hooks without persisted trust for one invocation: *"DANGEROUS. Intended only for automation that already vets hook sources."* Note this is a **separate flag** from `--dangerously-bypass-approvals-and-sandbox` — bypassing the sandbox does not bypass hook trust. Managed hooks (system/MDM/cloud/`requirements.toml`) are trusted by policy and **cannot be disabled**; admins pin them with `[hooks] allow_managed_hooks_only = true` and `managed_dir` (binary also exposes `hooks.managed_dir` and `hooks.windows_managed_dir`).

**PLUGIN_ROOT.** A plugin's hooks live at `hooks/hooks.json` under the plugin root by default; the manifest can override with a `hooks` entry (e.g. `{"name": "repo-policy", "hooks": "./hooks/hooks.json"}`). Paths in `extensions.com.openai` or a compatibility manifest must be **relative to the plugin root and start with `./`**. Files are addressed at runtime through:

- `${PLUGIN_ROOT}` — installed plugin root directory
- `${PLUGIN_DATA}` — plugin's writable data directory
- `CLAUDE_PLUGIN_ROOT` / `CLAUDE_PLUGIN_DATA` — legacy compatibility aliases

All four names are present in the 0.154.0 binary. Codex refuses MCP configs that escape the root: *"Agent Plugins MCP config resolves outside the plugin root; disabling MCP."*

## Caveats on this matrix

- Everything above is from static inspection plus the official docs. **No hook was actually fired**, because exercising one requires a Codex session that calls a model, which was out of scope. Wire-schema evidence is strong for field names, types, and the presence/absence of injection channels; it is *not* evidence of runtime ordering, dedup, or failure semantics.
- The six divergences listed above mean the doc page should not be treated as exact for 0.154.0. Log one real payload per event before depending on a field.
- `Bash` vs `unified_exec` as the emitted `tool_name` is the single item I would confirm empirically first — it determines whether existing matchers fire at all.

## Cannot inject / unsupported

- Notification — no such hook event exists in Codex 0.154.0 (the binary's HookEventName enum has exactly 12 variants and Notification is not one of them); this is a Claude Code event with no Codex counterpart
- SessionResume as a distinct event — folded into SessionStart and discriminated by `source == "resume"`; matchers filter on `source` (startup|resume|clear|compact)
- TurnStart / TurnEnd — no dedicated turn-boundary events. `turn_id` is exposed on 10 of the 12 events (schema comment: 'Codex extension: expose the active turn id to internal turn-scoped hooks') but there is no event that fires at turn start or turn end. UserPromptSubmit is the closest proxy for turn start; Stop for turn end
- Dedicated apply_patch / exec_command events — no per-tool events exist. Both are reached only by matching on `tool_name` inside PreToolUse / PostToolUse / PermissionRequest
- SessionEnd output — the binary contains `session-end.command.input` but NO `session-end.command.output` schema, so SessionEnd hooks have no structured return channel of any kind
- SessionEnd with mcp_tool handlers — explicitly unsupported per docs; SessionEnd also always runs synchronously even when async:true
- Context injection from PermissionRequest, PreCompact, PostCompact, SessionEnd, Stop, SubagentStop, Interrupt — no additionalContext member exists in any of their output schemas
- PermissionRequest input rewriting — `updatedInput` and `updatedPermissions` are reserved and FAIL CLOSED if present; `interrupt` fails closed if true
- Blocking from SessionStart, SubagentStart, SessionEnd, Interrupt — SubagentStart parses continue:false but does not honor it
- Matchers on UserPromptSubmit, Stop, Interrupt — matcher field is accepted but ignored
- Hook handler types beyond two — only `command` and `mcp_tool` exist (binary: HookHandlerConfig::Command with 6 elements, HookHandlerConfig::McpTool with 5 elements; TUI labels them Command / MCP Server)

## Sources

- https://learn.chatgpt.com/docs/hooks — official Codex hooks documentation; https://developers.openai.com/codex/hooks returns HTTP 308 Permanent Redirect to this URL
- https://developers.openai.com/plugins/build/plugins — official plugin build documentation (install, marketplaces, trust, PLUGIN_ROOT, manifest schema)
- Local binary: /opt/homebrew/bin/codex -> /opt/homebrew/Caskroom/codex/0.154.0/bin/codex (Mach-O 64-bit executable arm64); `codex --version` => 'codex-cli 0.154.0'
- Local binary embedded JSON Schemas (draft-07), extracted via `strings`: titles session-start|session-end|user-prompt-submit|pre-tool-use|permission-request|post-tool-use|pre-compact|post-compact|subagent-start|subagent-stop|stop|interrupt .command.input/.output — 23 schemas total (session-end has input only). AUTHORITATIVE where it differs from the doc page.
- Local binary serde type names: HookEventName enum (12 variants), HookTrustStatus (managed|trusted|untrusted|modified), HookStateToml {enabled, trusted_hash}, HookHandlerConfig::{Command,McpTool}, PreToolUseHookSpecificOutputWire (5 elements), PostToolUseHookSpecificOutputWire (3 elements incl. updatedMCPToolOutput), SessionStart/SubagentStart/UserPromptSubmit HookSpecificOutputWire (2 elements each), PermissionRequestHookSpecificOutputWire (2 elements, no additionalContext)
- `zsh -lc 'codex --help'` — documents --dangerously-bypass-hook-trust ('Run enabled hooks without requiring persisted hook trust for this invocation. DANGEROUS. Intended only for automation that already vets hook sources'), distinct from --dangerously-bypass-approvals-and-sandbox
- `zsh -lc 'codex plugin --help'` — subcommands add | list | marketplace | remove
- Local binary trust-flow strings: 'New hook - review required', 'Modified since last trusted - review required', 'Hooks need review', 'Hooks can run outside the sandbox after you trust them.', 'Trust all and continue', 'Continue without trusting (hooks won't run)', 'failed to write hook trust:', 'hooks.state', 'config/batchWrite failed while updating hook trust in TUI'
- Local binary plugin-trust strings: 'failed to trust materialized plugin hooks', 'skipping materialized plugin hook trust after account changed', '(plugin hook trust update was cancelled:', 'Agent Plugins MCP config resolves outside the plugin root; disabling MCP', 'BYPASS_HOOK_TRUST'
- Local binary project-trust string: 'config, hooks, and exec policies are disabled in the following folders until the project is trusted, but skills still load.'
- Local binary config keys: hooks.managed_dir, hooks.windows_managed_dir, allow_managed_hooks_only, and marketplace paths ~/.agents/plugins/marketplace.json and <repo-root>/.agents/plugins/marketplace.json, .codex-plugin/plugin.json
