# Codex CLI host: hook capabilities and the Twining adapter

**What this covers.** What the installed Codex CLI lets a hook observe and inject, what Twining's `codex` adapter does with each event, how to check both on your own machine, and what is still unproven. **Commit described:** `foundation/v3` at `0f9fd985` (`twining --version` → `twining 2.16.1`; the v3 build has no 3.x version stamp yet). **Host described:** `codex-cli 0.154.0`, Homebrew cask, `/opt/homebrew/bin/codex -> /opt/homebrew/Caskroom/codex/0.154.0/bin/codex` (Mach-O arm64, sha256 `4f85982624b3898c8991cb80c0981b2aa71070e3537046c9a95950318a95afcc`).

Commands below use `CLI="node <checkout>/dist/cli/twining.js"` on a built checkout of `0f9fd985`, `TWINING_OFFLINE=1`, and a throwaway `HOME` / `TWINING_IDENTITY_HOME` so nothing touches your real identity. `<P>` is a scratch project directory.

## Real-host verification status — NOT VERIFIED

**Twining's capture has not been observed working on a real Codex host.** Claude Code's working capture is not evidence about Codex. Everything under "What the adapter does" below pipes hand-written payloads into the CLI; no Codex process ran.

- The only real-host attempt is recorded in the programme log as **DN19** (`docs/plans/2026-09-15-foundation-programme-log.md`): `codex exec --dangerously-bypass-hook-trust` printed `hook: SessionStart Completed`, the hook command produced no filesystem effect (no log, no marker, no events), and `UserPromptSubmit` never fired in exec mode. No command output or transcript of that run survives; it is **reported, not reproduced**. The matrix report carries the Codex arms of R10/R11 as unavailable for the same reason.
- **Reproduction — UNAVAILABLE.** It needs a real Codex session (calls a model) with owner-granted hook trust, and the owner has not trusted any Twining hook. `~/.codex/config.toml` trusts only the two gsd hooks in `~/.codex/hooks.json`:
  ```
  $ grep -n '^\[hooks.state\|trusted_hash\|^\[features\|^hooks *=' ~/.codex/config.toml
  115:[hooks.state]
  117:[hooks.state."/Users/dave/.codex/hooks.json:post_tool_use:0:0"]
  118:trusted_hash = "sha256:5d1b871c854e20393d10b7adc5931fff451968ee020e56705b8e5a200929d849"
  120:[hooks.state."/Users/dave/.codex/hooks.json:session_start:0:0"]
  121:trusted_hash = "sha256:2602b6c050ea166814f5c5130d65a433c1ac6f79bf18656f960b002ac4c052a4"
  ```
  That is the complete output: no `[features]`, no `hooks =` kill switch. The persisted trust key is `<hooks.json path>:<event>:<group>:<hook>` with only `trusted_hash`.
- Open questions only a real session can settle: whether `--dangerously-bypass-hook-trust` lets a hook run but leaves it sandboxed without a writable filesystem (consistent with the binary string *"Hooks can run outside the sandbox after you trust them."*, not demonstrated); whether it also bypasses **project** trust (the binary says *"config, hooks, and exec policies are disabled in the following folders until the project is trusted, but skills still load."*); whether `codex exec` ever fires `UserPromptSubmit`; and which `tool_name` (`Bash` or `unified_exec`) a tool event carries. **UNAVAILABLE on this machine; not attempted.**

## Known defects and limits at this commit

| # | What the operator sees | Reproduce | Impact | Workaround |
|---|---|---|---|---|
| 1 | Real-host Codex capture unproven | see section above | Codex arm of capture/recall untested | none |
| 2 | Nothing captured in a Codex session: no Codex registration ships | `ls <repo>/.codex` → No such file; `grep -c 'v3-capture-hook.sh' plugin/hooks/hooks.json` → 7, all `claude-code` | Codex sessions write no Twining events | hand-register the shim (see "Registering by hand"); untested on a real host |
| 3 | Generated matrix and `doctor` say Twining injects on `PreToolUse`/`PostToolUse`; it does nothing there | `printf '{…"hook_event_name":"PreToolUse"…}' \| $CLI hook codex PreToolUse --project <P>` → stdout empty, stderr `codex adapter has no handler for PreToolUse` | `capture_coverage.codex.injects_on` overstates; no Codex commit gate exists | read those rows as host capability, not adapter behaviour |
| 4 | Generated `Interrupt` row lists captured fields; adapter captures nothing | same with `Interrupt` → `no handler for Interrupt` | row is wrong | none needed |
| 5 | Generated captured-field columns for SessionStart/PreCompact/PostCompact are approximate | `$CLI events show <id>` on the observation (see the adapter table below) | `model`, `permission_mode`, `transcript_path` are not recorded on SessionStart; compaction records `transcript` basename, never `model` | none needed |
| 6 | The newest event stays `NOT_ADMITTED` until the next **hook** run; a session's final `SessionEnd` receipt stays unadmitted | `$CLI decide …` then `$CLI events show <its id>` → exit 1 `NOT_ADMITTED` | `events ls` omits it and `events show` refuses it (after the 12-call run below, `doctor` counts total 12 / admitted 11); the last flush stays invisible until the next session | run any hook (e.g. `hook codex Stop`) to admit; none for the last event of the last session |
| 7 | A direct `twining hook codex SessionStart` registration on a 2.x store injects the 2.x "Gate 1 / Gate 2" prose | `$CLI hook codex SessionStart --project <dir with empty .twining>` → 993-byte gate prose, stderr `store is not v3-enabled…` | 2.x prose that v3 forbids (`FORBIDDEN_PROSE_REMINDERS`) | register through `v3-capture-hook.sh`, which exits silently on a 2.x store |
| 8 | `PostCompact` stderr begins with `PreCompact cannot inject context on this host…` | `hook codex PostCompact` | misleading log line only | ignore the first line |
| 9 | A subagent's own assignment appears in working sets as `- [verified observation] <bare id>` with no content | `hook codex SubagentStart` then read its `additionalContext` | the dispatched worker is told nothing about its assignment | none (`src/adapters/working-set.ts:renderRecord` has no branch for `work` records) |
| 10 | `twining migrate` on a store that was never 2.x exits 2 with a raw ENOENT; `migrate-status` says `not_started` | `$CLI identity init --project <P>`, two hook calls, then `$CLI migrate --project <P>` (or `--dry-run`) → exit 2, stderr `migrate: ENOENT: no such file or directory, open '<P>/.twining/decisions/index.json'`; `store.json` ids unchanged | confusing on a v3-native hook-capture store | do not run `migrate` on a store created by `identity init` |
| 11 | Real-host test passes vacuously | from source, not a run: `test/adapters/real-host.test.ts` returns after printing `NOT TESTED on Codex` when no events are written | a green suite does not mean Codex was tested | read stderr; see "Next step" |
| 12 | Without the shim, `producer.turn` is absent; CLI-ingress events take provenance from the shell's cwd, not `--project` | see "Turn and provenance" | events attribute to the wrong repo/branch if the CLI runs elsewhere | run CLI writes from inside the project; use the shim for hooks |
| 13 | The generated block names the host version only, not the Twining commit that rendered it | inspect the `BEGIN GENERATED` marker | staleness after a `CODEX_MATRIX` change is invisible without the pin test | run `npx vitest run test/adapters/host-matrix-docs.test.ts` (not run for this page) |

At this commit the `UserPromptSubmit` delta does not list the SessionStart bookkeeping observation (hook bookkeeping observations are left out of working sets), and `doctor` reports `repo_ids_cited` / `repo_ids_undeclared`.

## Check the installed host

```
$ ls -l /opt/homebrew/bin/codex; codex --version
… /opt/homebrew/bin/codex -> /opt/homebrew/Caskroom/codex/0.154.0/bin/codex
codex-cli 0.154.0
$ codex --help | grep -A2 'dangerously-bypass-hook-trust'
      --dangerously-bypass-hook-trust
          Run enabled hooks without requiring persisted hook trust for this invocation. DANGEROUS.
          Intended only for automation that already vets hook sources
$ codex plugin --help        # Commands: add, list, marketplace, remove, help
$ ls ~/.codex/plugins/cache/ # claude-plugins-official openai-bundled openai-curated-remote openai-primary-runtime
$ ls ~/.agents/plugins/marketplace.json   # No such file or directory
```

`--dangerously-bypass-hook-trust` (env `BYPASS_HOOK_TRUST`) is separate from `--dangerously-bypass-approvals-and-sandbox`: bypassing the sandbox does not bypass hook trust.

## The host's hook surface (from the installed binary)

The binary embeds one draft-07 JSON Schema per `<event>.command.input|output` — 23 in all; `session-end.command.output` does not exist. List them:

```
$ strings -n 8 <codex binary> | grep -o '"title": *"[a-z-]*\.command\.\(input\|output\)"' | sort | uniq -c
```

To read field sets, parse each title's enclosing JSON object (brace-match outward from the title, keep the object whose `title` matches):

```js
// node extract.mjs <codex binary> <outdir>
import fs from 'node:fs'; const [bin,out]=process.argv.slice(2); const b=fs.readFileSync(bin).toString('latin1');
const end=(s,i)=>{let d=0,q=false,e=false;for(let j=i;j<i+2e5;j++){const c=s[j];if(q){if(e)e=false;else if(c==='\\')e=true;else if(c==='"')q=false;continue}
 if(c==='"')q=true;else if(c==='{')d++;else if(c==='}'&&--d===0)return j}return -1};
for(const m of b.matchAll(/"title": *"([a-z-]+\.command\.(?:input|output))"/g))for(let k=m.index;k>m.index-2e5;k--){if(b[k]!=='{')continue;
 const e=end(b,k);if(e<m.index)continue;try{const o=JSON.parse(b.slice(k,e+1));if(o.title===m[1]){fs.writeFileSync(`${out}/${m[1]}.json`,JSON.stringify(o,null,1));break}}catch{}}
```

Result: 23 parsed, every one `additionalProperties: false`. Exactly 12 events: `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `SubagentStart`, `SubagentStop`, `Stop`, `Interrupt`.

| Event | Input fields (required; optional in *italics*) | Can inject? | Block / deny (schema) |
|---|---|---|---|
| SessionStart | `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, `permission_mode`, `source` ∈ startup\|resume\|clear\|compact | **yes** | no |
| SessionEnd | `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `reason` (const `other`) — no `model`, no `permission_mode` | no — no output schema at all | no |
| UserPromptSubmit | common¹ + `turn_id`, `prompt`; *`agent_id`, `agent_type`* | **yes** | `decision:"block"` + `reason` |
| PreToolUse | common¹ + `turn_id`, `tool_name`, `tool_use_id`, `tool_input`; *`agent_id`, `agent_type`* | **yes** | `permissionDecision` ∈ allow\|deny\|ask; `decision` ∈ approve\|block; `updatedInput` |
| PermissionRequest | common¹ + `turn_id`, `tool_name`, `tool_input`; *`agent_id`, `agent_type`* | no (`hookSpecificOutput` has no `additionalContext`) | `decision.behavior` ∈ allow\|deny |
| PostToolUse | common¹ + `turn_id`, `tool_name`, `tool_use_id`, `tool_input`, `tool_response`; *`agent_id`, `agent_type`* | **yes** | `decision:"block"`; schema also has `updatedMCPToolOutput` |
| PreCompact / PostCompact | `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, `turn_id`, `trigger` ∈ manual\|auto; *`agent_id`, `agent_type`* — no `permission_mode` | no — output is only `continue`, `stopReason`, `suppressOutput`, `systemMessage` | halt only (`continue:false`) |
| SubagentStart | common¹ + `turn_id`, `agent_id`, `agent_type` | **yes** | no |
| SubagentStop | common¹ + `turn_id`, `agent_id`, `agent_type`, `agent_transcript_path`, `stop_hook_active`, `last_assistant_message` | no | `decision:"block"` |
| Stop | common¹ + `turn_id`, `stop_hook_active`, `last_assistant_message` | no | `decision:"block"` |
| Interrupt | common¹ + `turn_id` | no — output is `systemMessage` only | no |

¹ common = `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, `permission_mode` (`permission_mode` ∈ default\|acceptEdits\|plan\|dontAsk\|bypassPermissions).

**Five events inject**, all through `hookSpecificOutput.additionalContext`: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, SubagentStart. **Seven observe only:** PermissionRequest, PreCompact, PostCompact, SessionEnd, Stop, SubagentStop, Interrupt. A compaction hook can watch (and halt) compaction but cannot feed text back; re-seeding after compaction rides `SessionStart` with `source: "compact"` and the next `UserPromptSubmit`. `systemMessage` on observe-only events goes to the user/transcript, not the model.

`PermissionRequest` reserves `interrupt`, `updatedInput`, `updatedPermissions`; its schema says *"PermissionRequest hooks currently fail closed if this field is present"* (2 hits: `strings -n 8 <codex binary> | grep -oF '<that sentence>' | wc -l` → 2, and `LC_ALL=C grep -aoF` on the raw binary → 2).

**`mcp_server{name,source}` is not observable on this installed host.** No Codex 0.154.0 hook input schema declares it (`grep -l mcp_server <outdir>/*.json` → nothing; the quoted `"mcp_server"` has 0 hits in the binary), and every input schema rejects unknown properties. It is a Claude Code field; nothing here tests it on Claude Code.

**Tool names.** There are no per-tool events; shell and patch tools are reached by matching `tool_name` on PreToolUse/PostToolUse/PermissionRequest. The binary's internal names are `apply_patch` and `unified_exec` (71 hits); the docs say to match `Bash`, `apply_patch` or an MCP tool name, and that `Edit`/`Write` also match `apply_patch` (`Edit|Write` has 0 hits in the binary). **Which string a real session emits is NOT VERIFIED** — log one `PreToolUse` payload before writing a matcher.

### What the docs add (docs-stated, NOT demonstrated)

From `https://learn.chatgpt.com/docs/hooks` (`https://developers.openai.com/codex/hooks` answers `HTTP/2 308` to it); each quotation below is on the page as served on 2026-10-06. No run here exercised any of it, and the schemas do not encode it.

- `SubagentStart`: *"continue: false is parsed for compatibility, but it doesn't stop the subagent from starting."* `Stop`: `decision:"block"` *"doesn't reject the turn"* — it makes Codex continue. `SubagentStop`: `decision:"block"` asks Codex to continue the subagent.
- PreToolUse: *`permissionDecision: "ask"`, legacy `decision: "approve"`, `continue: false`, `stopReason` and `suppressOutput` are "parsed but not supported yet"*. PostToolUse: *"updatedMCPToolOutput and suppressOutput are parsed but not supported yet."*
- Handlers: `command` and `mcp_tool`; *"prompt and agent handlers are parsed but skipped."* Default timeout 600 s; `Interrupt` 1 s default, 3 s maximum. `SessionEnd` does not support MCP tool hooks and always runs synchronously.
- Matchers target `tool_name`, `trigger`, `source` or `agent_type`, and are ignored on `UserPromptSubmit`, `Stop`, `Interrupt`.
- Injection budget roughly 2,500 tokens per hook-output message (`additionalContextLimit`), excess spilled to a temp file with a head-and-tail preview; up to eight background (`async`) hooks per session, which cannot block, approve or rewrite.
- Hook sources are additive: *"Higher-precedence config layers don't replace lower-precedence hooks."* Project `.codex/` hooks load only in a trusted project. Kill switch `[features] hooks = false`.

Where the docs and binary differ: `SessionEnd` has no `model` in the binary; `PreToolUse` accepts `ask`; `PostToolUse` carries `updatedMCPToolOutput` (documented as unsupported); `Interrupt` output is `systemMessage` only. The binary wins for field sets.

## Plugins and trust

- **Install** with `codex plugin add|list|remove|marketplace`. Marketplaces: `<repo>/.agents/plugins/marketplace.json` and `~/.agents/plugins/marketplace.json`; installs cache under `~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/`. A plugin's hooks default to `hooks/hooks.json`; hook commands see `${PLUGIN_ROOT}`, `${PLUGIN_DATA}` and the aliases `CLAUDE_PLUGIN_ROOT` / `CLAUDE_PLUGIN_DATA` (all present in the binary and the plugin docs).
- **Installing does not trust hooks.** Plugin docs: *"Installing or enabling a plugin doesn't automatically trust its hooks. Plugin-bundled hooks are non-managed hooks…"* Trust is per hook, by content hash (`trusted_hash`); `HookTrustStatus` is managed\|trusted\|untrusted\|modified, so editing a trusted hook re-arms review. Review with `/hooks` in the TUI. The binary carries `skipping materialized plugin hook trust after account changed` — that a changed account re-arms trust is inferred from that string, NOT demonstrated.
- **Managed hooks** (system/MDM/`requirements.toml`) are trusted by policy; `allow_managed_hooks_only` and `managed_dir` exist in the binary.
- **Twining's Codex plugin is parked, not on this branch.** `git ls-tree -r --name-only HEAD -- plugins | wc -l` → `0`. It lives at `dedaaccf` on `wip/codex-plugin` only (`git branch -a --contains dedaaccf`). Its `plugins/twining/.codex-plugin/plugin.json` declares `skills` and `mcpServers` and no `hooks`; its `hooks/hooks.json` runs the **2.x** scripts (`session-start-context.sh`, `pre-commit-hook.sh`, `stop-hook.sh`, …) and never the v3 adapter (`git grep -n 'hook codex\|v3-capture\|twining hook' dedaaccf -- plugins/` → exit 1). It is right for a 2.x store and wrong for a v3 one.

## Installed Twining hooks for Codex: none

- `plugin/hooks/hooks.json` registers `v3-capture-hook.sh` seven times, every one `bash "${CLAUDE_PLUGIN_ROOT}/hooks/v3-capture-hook.sh" claude-code <Event>`.
- No repo `.codex/` directory; `git grep -n 'hook codex\|codex SessionStart\|\.codex/hooks.json' HEAD -- . ':!docs/operations/hosts-codex-capabilities.md'` → exit 1.
- `~/.codex/hooks.json` holds only the owner's two gsd hooks; `doctor` with the real `HOME` reports `{"scope":"codex-user","file":"/Users/dave/.codex/hooks.json",…,"mentions_twining":false}`.
- The only Codex registration in the tree is the one `test/adapters/real-host.test.ts` writes into a fresh temp project, for SessionStart, UserPromptSubmit, SubagentStop and Stop only — not PreCompact, PostCompact, SubagentStart or SessionEnd, which the adapter handles (from source, not a run).

**Registering by hand (untested on a real host).** The shim is host-agnostic: its first argument is the host. A Codex entry would read `bash "<plugin>/hooks/v3-capture-hook.sh" codex <Event>` for SessionStart, UserPromptSubmit, PreCompact, PostCompact, SubagentStart, SubagentStop, Stop and SessionEnd, followed by per-hook trust in `/hooks`. Offline, the shim does what it should (with `TWINING_CLI_JS` pointing at the built CLI):

```
$ printf '{"session_id":"codex-shim",…,"turn_id":"shim-turn-7","prompt":"via shim"}' \
  | TWINING_PROJECT=<2.x project> bash plugin/hooks/v3-capture-hook.sh codex SessionStart
exit 0, stdout 0 bytes, stderr 0 bytes, .twining still empty          # inert on a 2.x store
$ … | TWINING_PROJECT=<P> bash plugin/hooks/v3-capture-hook.sh codex UserPromptSubmit
exit 0, stdout {"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"## Twining — working set…
```

The post it wrote carries `producer.turn: "shim-turn-7"` and attachment `anchor: "prompt:shim-turn-7"`: the shim copies the payload `turn_id` into `TWINING_TURN_ID`.

## What the adapter claims (generated)

The block below is rendered from `CODEX_MATRIX` (`src/adapters/codex.ts`); do not hand-edit it. `test/adapters/host-matrix-docs.test.ts` is meant to pin it. That test was not run for this page. What was checked instead: at `0f9fd985`, `renderMatrixTable(CODEX_MATRIX)` from the built `dist/` appears verbatim in this file, and the file contains the headings and rows the test looks for. Its PreToolUse, PostToolUse, Interrupt and captured-field claims are wrong about the adapter — defects 3–5.

<!-- BEGIN GENERATED: codex@0.154.0 — source of record is src/adapters/host-capability.ts consumers -->

| Event | Captured fields | Injects? | Channel | Twining events written | Receipt |
|---|---|---|---|---|---|
| `SessionStart` | `session_id`, `source`, `cwd`, `model`, `permission_mode`, `transcript_path` | yes | `hookSpecificOutput.additionalContext` | `created(observation)`, `receipt(injected)` | `injected` |
| `UserPromptSubmit` | `session_id`, `turn_id`, `prompt`, `cwd`, `model`, `agent_id`, `agent_type` | yes | `hookSpecificOutput.additionalContext` | `created(post/human_statement)`, `receipt(injected)` | `injected` |
| `PreCompact` | `session_id`, `turn_id`, `trigger`, `cwd`, `model` | **no** | — | `created(observation)` | — |
| `PostCompact` | `session_id`, `turn_id`, `trigger` | **no** | — | `created(observation)` | — |
| `SubagentStart` | `session_id`, `turn_id`, `agent_id`, `agent_type` | yes | `hookSpecificOutput.additionalContext` | `created(work/assignment)`, `receipt(injected)` | `injected` |
| `SubagentStop` | `session_id`, `turn_id`, `agent_id`, `agent_type`, `last_assistant_message`, `agent_transcript_path` | **no** | — | `created(post/reported_result)` | — |
| `PreToolUse` | `tool_name`, `tool_input`, `tool_use_id`, `turn_id` | yes | `hookSpecificOutput.additionalContext` | — | — |
| `PostToolUse` | `tool_name`, `tool_input`, `tool_response`, `turn_id` | yes | `hookSpecificOutput.additionalContext` | — | — |
| `Stop` | `session_id`, `turn_id`, `last_assistant_message`, `stop_hook_active` | **no** | — | `receipt(projected)` | `projected` |
| `SessionEnd` | `session_id`, `reason`, `cwd` | **no** | — | `receipt(projected)` | `projected` |
| `Interrupt` | `session_id`, `turn_id` | **no** | — | — | — |
| `PermissionRequest` | — | **no** | — | — | — |

**Captures:** session_start, user_prompt, compaction, dispatch, worker_return, turn_end, session_end

**Injects on:** SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, SubagentStart

**Cannot observe:** 
- Notification (no such event exists on this host)
- TurnStart / TurnEnd (no turn-boundary events; turn_id is exposed but never fires an event)
- dedicated apply_patch / exec_command events (reached only by tool_name matching)
- SessionEnd structured output (the binary carries session-end.command.input but no .output schema)

**Per-event notes**

- `SessionStart` — source ∈ startup|resume|clear|compact. This is the ONLY post-compaction re-seeding channel on this host.
- `UserPromptSubmit` — turn_id (not prompt_id) is the turn identity on this host; matchers are accepted but ignored for this event.
- `PreCompact` — CANNOT INJECT — the output schema has no hookSpecificOutput member. Halt-only (continue:false).
- `PostCompact` — CANNOT INJECT — same schema shape as PreCompact. Recovery rides SessionStart(resume)/UserPromptSubmit.
- `SubagentStart` — continue:false parses but is not honored — this hook cannot block a dispatch.
- `SubagentStop` — CANNOT INJECT — no hookSpecificOutput member. decision:"block" means CONTINUE the subagent, not reject it.
- `PreToolUse` — the commit gate. tool_name is Bash|apply_patch|<mcp tool>; the binary's internal names are apply_patch/unified_exec.
- `PostToolUse` — also carries updatedMCPToolOutput, a mutation channel Twining deliberately does not use.
- `Stop` — CANNOT INJECT — no hookSpecificOutput member. decision:"block" tells Codex to continue, it does not reject the turn.
- `SessionEnd` — CANNOT INJECT and has NO output schema at all; always synchronous even with async:true, and mcp_tool handlers are unsupported.
- `Interrupt` — CANNOT INJECT — output is systemMessage only, 1–3 s budget. Twining registers nothing here.
- `PermissionRequest` — CANNOT INJECT, and updatedInput/updatedPermissions/interrupt FAIL CLOSED if present. Twining registers nothing here.

<!-- END GENERATED -->

## What the adapter does (offline, no Codex process)

Setup on a fresh scratch store, launched from a non-git directory:

```
$ $CLI identity init --project <P>
→ exit 0; result.store {"store_id":"s_…","repo_id":"r_…","format":3,"created":true,"file":"<P>/.twining/store.json"}
$ cat <P>/.twining/store.json        # {"store_id":"s_…","repo_ids":["r_…"],"format":3,"created_at":"…"}
$ TWINING_INGRESS=cli $CLI decide --project <P> --json '{"domain":"architecture","scope":"src/","summary":"PLUTONIUM-3 is the agreed retry ceiling (synthetic seed)","context":"codex hook demo","rationale":"seeded so a SessionStart working set has one record to inject"}'
→ exit 0; stderr: No local embedding model at … — using keyword search (offline mode: no download attempted).
```

Each hook call: `printf '%s' '<payload>' | TWINING_SESSION_ID=codex-demo-1 TWINING_TURN_ID=<turn> $CLI hook codex <Event> --project <P>`, with a payload carrying exactly the binary's required fields. Every exit code was 0. Stderr is shown without the `[twining] ` prefix.

| Event | stdout | stderr | Events written |
|---|---|---|---|
| SessionStart | `additionalContext` (below) | none | observation (`check_method: "codex SessionStart hook"`) + receipt `injected` (events: the seed decision, turn `startup:0`) |
| UserPromptSubmit | `additionalContext` (below) | none | post `human_statement` (`entry_type: status`, tags `human-statement, codex`) + receipt `injected` (events: that post only) |
| PreCompact | empty | `PreCompact cannot inject context on this host — additionalContext is discarded. Re-seeding rides SessionStart(source=compact).` / `codex PreCompact cannot inject context (no additionalContext member in its output schema); the captured records reach the model at the next SessionStart or UserPromptSubmit instead` | observation `result: {kind: compaction, trigger: auto, last_injected_event, last_payload_hash, turns: 2, transcript: "rollout.jsonl", injects: false, injection_channel: null}` |
| PostCompact | empty | the same two lines, the first still saying `PreCompact` (defect 8) | observation, `result.kind: post_compaction`, otherwise as PreCompact |
| SubagentStart | `additionalContext` (below) | `SubagentStart injects into the SUBAGENT, never the parent session.` | work `assignment` (`external_id: worker-1`, `stage: dispatched`, `agent_type: explorer`, `authority: "reference only; this record grants nothing"`, `producer.asserted_actor: worker-1`) + receipt `injected` (3 events, session `codex-demo-1/worker-1`) |
| SubagentStop | empty | `a worker return is a reported_result — it is not completion, merge or acceptance` / `codex SubagentStop cannot inject context …` | post `reported_result` (`stage: worker_returned_review_pending`, `task_completion_state: not_complete`, `acceptance_state: none_recorded`, `merge_state: not_merged`) |
| PreToolUse, PostToolUse, Interrupt, PermissionRequest | empty | `codex adapter has no handler for <Event>; nothing captured, nothing claimed` | none (raw event files 10 before and 10 after the four calls) |
| Stop | empty | `codex Stop cannot inject context …` | receipt `projected`, `cursor.position` = newest event |
| SessionEnd | empty | `SessionEnd discards all hook output on this host; flush only.` / `codex SessionEnd cannot inject …` | receipt `projected` — written but not admitted (defect 6) |

Injected texts (a few hundred bytes each on a store this size):

```
SessionStart:
## Twining — working set for this scope

- [proposal] PLUTONIUM-3 is the agreed retry ceiling (synthetic seed)
  scope: src
  why: seeded so a SessionStart working set has one record to inject
  (does not authorize action on its own)

Evidence class is stated per item and is NOT changed by the wording of the item. Only a RULING carries human authority; everything else is a claim.

UserPromptSubmit:  ## Twining — new since your last injected context
                   - [human statement] status: Reply with the single word OK.  (+ scope, disclaimer, footer)
SubagentStart:     ## Twining — working set for this scope
                   - [verified observation] <work id>   ← the worker's own assignment, bare id (defect 9)
                   then the human statement and the seed proposal, as above
```

No v3 payload contains "Gate 1 / Gate 2" prose. The SessionStart observation records only `{kind: session_start, host: codex, session, start_source, cwd}` (defect 5).

After the run, there are 12 raw events: the seed `decide` plus 2+2+1+1+2+1+0+1+1 from the hooks, as in the last column above.

```
$ $CLI events ls --project <P> --limit 50        → result.total 11, shown 11, all signed: true
$ ls <P>/.twining/events/*/ | wc -l              → 12
$ $CLI events show <12th id, the SessionEnd receipt> --project <P>
→ exit 1 {"ok":false,…,"error":{"code":"NOT_ADMITTED","message":"event … exists in state \"local_persisted\" but is not admitted"}}
$ $CLI doctor --project <P>
→ bindings: store_format 3, v3_enabled true, repo_ids ["r_…"], repo_ids_cited ["r_…"], repo_ids_undeclared []
  events {"total":12,"admitted":11,"quarantined":0,"rejected":0}; hooks [] (scratch HOME)
  capture_coverage.codex {required_lifecycle_points:7, captured:7, gaps:[], cross_backend_substitution_claims:[],
                          injects_on:["SessionStart","UserPromptSubmit","PreToolUse","PostToolUse","SubagentStart"]}
  honest_limits: "coverage above describes what the ADAPTER captures, not that a host is currently installed", …
$ jq -c . <P>/.twining/adapters/sessions/codex-demo-1.json      # file is pretty-printed; compacted here
→ {"session_id":"codex-demo-1","last_injected_event":"<the human_statement>","last_receipt_id":"<its receipt>","last_payload_hash":"sha256:…","updated_at":"…","turns":2}
$ $CLI migrate-status --project <P>
→ {"format":3,"migration":"not_started",…,"remaining_steps":["manifest","events","idmap","verify","finalize"],"events":12,…}   # bare JSON, no envelope
```

### Admission lag (defect 6)

On a fresh store, launched from a non-git directory:

```
decide                        → events ls total 0, raw 1; events show <decide> → exit 1 NOT_ADMITTED
hook codex SessionEnd         → total 1, raw 2; the decide now shows (exit 0); the SessionEnd receipt NOT_ADMITTED
decide (second)               → total 1, raw 3; both the receipt and the new decide NOT_ADMITTED
hook codex Stop               → total 3, raw 4; both admitted; the Stop receipt NOT_ADMITTED
```

A CLI `decide` admits nothing; read-only commands admit nothing; the next hook run admits everything before it. From source, not a run: the hook handlers call `runtime.store.admit()` before appending their own receipt.

### Turn and provenance (defect 12)

- `hook codex UserPromptSubmit` with `TWINING_TURN_ID=env-turn-X` and payload `"turn_id":"payload-turn-Y"`: the post has `producer.turn: "env-turn-X"` and attachment `anchor: "prompt:payload-turn-Y"`; the receipt has `producer.turn: "env-turn-X"`, `payload.turn: "payload-turn-Y"`. With `TWINING_TURN_ID` unset (`env -u`) and `"turn_id":"payload-turn-Z"`: **no** `producer.turn`; the anchor and `payload.turn` still say `payload-turn-Z`. Through the shim the two agree (see above).
- Hook-path provenance follows the payload `cwd`; CLI-path provenance follows the shell's cwd. With a one-commit stand-in git repo `<G>` and the store in non-git `<P>`: `hook codex SessionStart` launched from a non-git dir with payload `cwd` = `<G>` records `source: {repo, worktree, branch: "main", commit, dirty: false}`; launched from `<G>` with payload `cwd` = `<P>` it records `{repo, worktree}` only. `decide` launched from `<G>` records branch/commit/dirty; launched from a non-git dir, worktree only. `doctor` reports `bindings.source_cwd` = the launch directory.

### On a 2.x store (defect 7)

```
$ printf '{"session_id":"codex-v2",…,"hook_event_name":"SessionStart",…,"source":"startup"}' \
  | $CLI hook codex SessionStart --project <dir whose .twining has no store.json>
exit 0; stdout 993 bytes {"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"## Coordination — Twining Lifecycle Gates\n\n… Gate 1 — Context Assembly … Gate 2 — Record …"}}
stderr: [twining] store is not v3-enabled; emitting the 2.x lifecycle-gate context unchanged
```

No files are written. The shim's guard (`[[ -f "$STORE_JSON" ]] || exit 0` and a `"format": 3` grep in `plugin/hooks/v3-capture-hook.sh`) runs before the CLI, so only the shim is silent on a 2.x store.

## Honest limits on this host

- **Seven of twelve events observe only** (PermissionRequest, PreCompact, PostCompact, SessionEnd, Stop, SubagentStop, Interrupt). The adapter emits nothing on stdout for those it handles and never returns a field the host's schema would reject.
- **Compaction recovery rides `SessionStart(source=resume|compact)` and the next `UserPromptSubmit`.**
- **`SessionEnd` has no output schema at all.**
- **Hooks need separate trust.** Until a Twining hook is trusted it does not run and Twining captures nothing — reported as a gap, never filled with another host's evidence.
- **`tool_name` is unverified** (`Bash` vs `unified_exec`); confirm before relying on a matcher.
- **No Twining Codex registration ships** (defect 2), so a Codex session today captures nothing.

## Cross-backend honesty

`capture_coverage.codex.cross_backend_substitution_claims` was `[]` in every `doctor` run above. That it is always `[]` is from source, not a run: `codexCoverage()` returns a literal `[]` typed `never[]`. Claude Code's ability to do something is never offered as evidence that Codex did it.

## Next step for real-host verification

The test cannot work as written: Codex keys trust by hooks.json **path** + event + index + content hash, and `test/adapters/real-host.test.ts` writes its `.codex/hooks.json` into a new `mkdtemp` project every run, so one interactive trust never matches the next run (from source, not a run). Either register the probe at a stable path (`~/.codex/hooks.json`, or a fixed project listed under `[projects]` in `~/.codex/config.toml`), trust it once via `/hooks`, and point the test there; or change the test to reuse a fixed directory. Then run `TWINING_REAL_HOST=1 npx vitest run test/adapters/real-host.test.ts -t Codex` and treat a `NOT TESTED on Codex` stderr line as a failure, not a pass (defect 11). From source, not a run: without `TWINING_REAL_HOST` the file's 4 tests (3 Claude Code, 1 Codex) sit inside `describe.skipIf(!REAL)` and should be reported as skipped. No vitest run for this page checked that. **The run itself is UNAVAILABLE here: it is a real Codex session calling a model, and the owner has not granted hook trust to any Twining hook.**

## Sources

- Installed binary `/opt/homebrew/Caskroom/codex/0.154.0/bin/codex` (sha256 above): embedded schemas, serde names (`HookEventName`, `HookTrustStatus`, `HookStateToml { enabled, trusted_hash }`, `HookHandlerConfig::{Command, McpTool}`), trust and plugin strings. Authoritative for field sets.
- `https://learn.chatgpt.com/docs/hooks` and `https://developers.openai.com/plugins/build/plugins` — runtime semantics, docs-stated only. The hooks page itself says to *"use this page as the release behavior reference"*; this guide pins field sets to the installed binary instead.
- Programme log DN19 and the foundation matrix report (R10/R11) for the unreproduced real-host attempt.
