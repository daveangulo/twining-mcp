# The `twining` CLI

`twining` runs every Twining command from a shell over the same command core the MCP server uses: the same commands, input schemas, result JSON and store resolution. Only the transport is different. This guide also covers the v3 operator verbs (`identity`, `rule`, `events`, `sync`, `doctor`, `hook`) and the `twining-mcp` binary's store subcommands.

**What this describes.** Commit `0f9fd985` on `foundation/v3`. `package.json` there is `2.16.1`, so both binaries print `2.16.1`, not the CHANGELOG's `[Unreleased] — 2.17.0`. Every output below came from running that build with `TWINING_OFFLINE=1`, and with `TWINING_IDENTITY_HOME` set to a throwaway directory for verbs that touch identity. Output is trimmed (`…` marks a cut) and otherwise unchanged. Paths appear as `<proj>`, and ids, timestamps and ports change on every run. Statements based on reading code rather than a run are labelled **(from source, not a run)**. What could not be produced on one machine without a TTY, a real agent host or a network is marked **UNAVAILABLE**, with the reason.

## Known defects and limits at this commit

| # | What you see | Reproduce | Impact | Workaround |
|---|---|---|---|---|
| 1 | `twining post`/`record` on a store migrated with `migrate --to 3` fail `FORMAT_VERSION_TOO_NEW`, exit 1. The MCP server's `twining_post` refuses with the same code, but its stdio `tools/call` result carries **no `isError`**: the refusal is only inside `content[0].text` (`{"error":true,"message":".twining/ format is newer…","code":"FORMAT_VERSION_TOO_NEW"}`). | `twining-mcp migrate --to 3 && twining post --json '{"entry_type":"status","summary":"x"}'`; for MCP, `tools/call twining_post` with the same arguments over stdio | No registry write (Gate 2 included) lands on a migrated store from this build. An MCP client that checks only `isError` reads the refused post as a success. | None for a migrated store. A store that only had `identity init` still accepts writes. See [recovery §1.2](operations/recovery-and-rollback.md). |
| 2 | `assemble`'s `result.retrieval.selection.repo` is `r_49c0eb9a6e072f6f8bcfb5f99d` with `repo_identity_source: "derived-from-path"` on **every** store, migrated v3 stores included. | `twining assemble --json '{"task":"t","scope":"project"}'`, read `.result.retrieval.selection` | The packet's repo identity is a constant and ignores `store.json`. Whether this excludes v3 evidence was not tested. | None. Cause (from source, not a run): `src/core/context.ts` `createTwiningContext` builds `ContextAssembler` without the store dir, so the identity is the hash of `instance:0`. |
| 3 | `twining sync --remote origin` always reports `carrier: "fs:…/.twining/exchange-fs"`. Nothing reaches the remote, and `--remote nosuch` "succeeds" too. | `twining sync --remote origin`, then `git --git-dir=<remote> for-each-ref` | No git-carrier exchange. | `--path <shared dir>` between checkouts on one machine. Cause: `src/cli/v3-verbs.ts` (sync) calls `new GitTransport(projectRoot, remote)`, but the class takes one options object. The throw is swallowed. |
| 4 | `SessionStart` with `"source":"compact"` injects only what is new since the session's last injection. If nothing is new it prints `nothing to inject`. | `startup`, then `compact` for one `session_id` through `twining hook claude-code SessionStart` | After compaction the model may get no working set back, though `PreCompact` says re-seeding rides this event. | None. Real-host effect UNAVAILABLE (no live session). |
| 5 | A `SubagentStart` dispatch record appears in later working sets as `- [verified observation] 01M…`: an id and no text. | `twining hook claude-code SubagentStart`, then `… UserPromptSubmit`, same session | The model sees an unexplained id. | None. |
| 6 | The v3 verbs and `migrate-status` ignore unknown flags and exit 0. | `twining events ls --limt 5; echo $?` → `0` | A typo in a flag goes unnoticed. | Check the result, not the exit code. |
| 7 | `twining record` writes git's own errors to stderr: 132 lines of `git diff --no-index` usage outside a git repo, or `fatal: ambiguous argument 'HEAD'` in a repo with no commits. | `twining record --json '{"summary":"x"}'` in a non-git directory | Hooks that scan stderr see noise. The command still succeeds. | Redirect stderr, or run in a repo that has a commit. |
| 8 | `twining-mcp --help` starts the MCP server, creates a full 2.x `.twining/` in the cwd and binds the dashboard port. | `twining-mcp --help </dev/null; ls .twining` | Leaves a store where none was wanted. | `twining-mcp help` (usage, exit 2) or `--version`. |
| 9 | `twining --help` says every command prints one JSON envelope, which the `migrate` family and `hook` do not. It also leaves out `events ls --record`. | `twining --help` | Scripts that trust the help text break. | Use [Output](#output). |
| 10 | Events a hook writes after its own admission pass (its injection receipt always, and a `SessionStart` observation) are missing from `twining events ls` until a **later** hook run or `sync`. | `hook … UserPromptSubmit`, then `twining events ls --kind receipt` → `total 0` | Counts look short right after a hook. | `twining sync`, or wait for the next hook event. |
| 11 | After `identity init` → a hook capture → `migrate --to 3`, the hook's receipt ended up `quarantined (signature_required)`, and `doctor` shows `quarantined: 1`. Seen once in that sequence. | that sequence, then `twining doctor` and `twining events show <receipt id>` | One injection receipt is never admitted. | None known. |
| 12 | `events show` returns `NOT_ADMITTED` both for an id that does not exist and for one that is quarantined. Only the message differs. | `twining events show 01NOPE` | Code-based handling cannot tell the two apart. | Read `error.message`. |
| 13 | After `rollback --to 2`, `store.json` keeps `"format": 3`. `twining events ls` answers normally (no `STORE_ROLLED_BACK`), and the shipped capture shim keeps capturing. | `rollback --to 2`, then one `UserPromptSubmit` through `plugin/hooks/v3-capture-hook.sh` → event files 1 → 3 | Capture continues after a rollback. | `TWINING_DISABLED=true`, or remove the hooks. See [recovery §5.5, §8](operations/recovery-and-rollback.md). |
| 14 | `identity init` on a 2.x store with records writes `format: 3` and migrates nothing (`migration: "not_started"`, `events: 0`). The shim starts capturing anyway. | `twining identity init && twining-mcp migrate-status` | The event log starts empty beside the 2.x records. | `twining-mcp migrate --to 3` (then see row 1). |
| 15 | `twining doctor` (even with no store) and `twining hook` on a 2.x store create `<identity home>/host/host.json`. | `TWINING_IDENTITY_HOME=/tmp/x twining doctor; ls /tmp/x/host` | A machine key appears unasked. | Point `TWINING_IDENTITY_HOME` somewhere disposable. |
| 16 | `doctor.hooks` always reads the real `~/.claude/settings.json` and `~/.codex/hooks.json`, whatever the project. | `twining doctor` in any directory | It reports the user scope, not this project's hooks. | None. |
| 17 | `acknowledge` on a missing handoff returns `INTERNAL_ERROR`, not `NOT_FOUND`. | `twining acknowledge --agent-id a --json '{"handoff_id":"01NOPE"}'` | Inconsistent error codes. | Match on the message. |
| 18 | A `provisional` decision in `record` is dropped when `tools.full_surface` is false, but the call returns `ok: true`, exit 0. | see [Differences](#differences-from-the-mcp-server) | A silent partial write. | Check `result.decision_errors`. |
| 19 | Invoked as `twining …`, the `migrate`/`rollback`/`validate-records` messages still say `twining-mcp`. | `twining rollback --to 3` | Cosmetic. | — |
| 20 | `npm i twining-mcp` / `npx twining` were never run. The plugin's launcher says no published `twining-mcp@^2.0.0` carries the `twining` bin. | — | The install blocks may not work against the registry yet. | A built checkout plus `TWINING_CLI_JS`. UNAVAILABLE: no network. |

**Fixed in 0f9fd985.** The working set no longer lists the `SessionStart` bookkeeping observation as a bare id. After `SessionStart` + `UserPromptSubmit`, `additionalContext` holds only the prompt's post. `migrate --to 3` after `identity init` now keeps the `store_id` and `repo_id` that `identity init` minted. `doctor` now also reports the repo ids that events cite and flags any that `store.json` does not declare (see [`doctor`](#twining-doctor)).

**UNAVAILABLE on this machine:** a real Codex host (the owner has not granted hook trust), a live Claude Code session driven through the shim, a second computer or a network remote, an interactive TTY for `twining rule`, and a CLI run without `TWINING_OFFLINE` (it could download a model).

## Why it exists

Some agent hosts cannot reach an MCP server. **Codex sandboxes** run shell commands with no network, a plugin cannot put anything on `PATH`, and only the sandbox's `cwd` (plus `/tmp`) is writable, so a linked worktree's main checkout is read-only. **Enterprise command allowlists** match exact command identity, which a stdio MCP server spawned by a host does not present. A shell command is the one interface those hosts always have. The CLI is not a second implementation: `src/cli/twining.ts` is an argv front end over `src/core/commands/*`, and `src/server.ts` is an MCP front end over the same definitions (from source, not a run).

## Install

```bash
npm i -D twining-mcp && npx twining capabilities   # per project (pins the version)
npm i -g twining-mcp && twining capabilities       # global
```

**NOT VERIFIED (row 20).** At this commit `package.json` declares `"bin": {"twining-mcp": "./dist/index.js", "twining": "./dist/cli/twining.js"}`. `plugin/scripts/launch-cli.sh` says "no published version in [`^2.0.0`] carries the `twining` bin or the `hook` verb".

The Claude Code **plugin** bundles the server (`plugin/server/twining-server.mjs`) but not the CLI. Its capture hooks look for the CLI in this order: `TWINING_CLI_JS`, `./node_modules/twining-mcp/dist/cli/twining.js`, `<plugin>/server/twining-cli.mjs` (not shipped), `twining` on `PATH`. If none is found they exit 0 silently:

```
$ sh plugin/scripts/launch-cli.sh --probe                                              → runner=none node=v26.8.2
$ TWINING_CLI_JS=<build>/dist/cli/twining.js sh plugin/scripts/launch-cli.sh --probe   → runner=override node=v26.8.2
```

## Usage

```
$ twining --help
usage: twining <command> [--json '<json>' | --input-file <f> | --stdin]
                        [--project <dir>] [--agent-id <id>]
       twining capabilities [--project <dir>]
…
       twining events ls [--limit <n>] [--kind <k>] | twining events show <id>
…
       twining --version | --help

Commands are the twining_* tool names (the twining_ prefix may be omitted).
Run `twining capabilities` for the full list with JSON Schemas.
Every command prints ONE JSON envelope on stdout; diagnostics go to stderr.
Exit codes: 0 ok, 1 command error, 2 usage / unknown command / bad input.
exit=0
$ twining --version     → twining 2.16.1
```

The first cut is three lines (`identity init`, and `rule` across two lines ending `(TTY only)`), the second seven (one line each for `sync`, `doctor`, `hook`, `migrate`, `rollback`, `migrate-status`, `validate-records`). `<command>` is a `twining_*` tool name. The prefix is optional, and the envelope always reports the canonical name (`assemble` → `"command":"twining_assemble"`).

### Input

Each command takes one JSON object from exactly one source: `--json '<json>'`, `--input-file <path>` or `--stdin`. With none of them the input is `{}`. All three sources work, and passing two is refused:

```
$ twining assemble --json '{}' --stdin   →
{"ok":false,"schema_version":"1","server_version":"2.16.1","command":"twining_assemble","error":{"code":"INVALID_JSON","message":"pass at most one of --json, --input-file, --stdin"}}   exit=2
```

`--agent-id <id>` fills `agent_id` when the command takes one and the payload did not set it. Input is checked against the command's zod schema, the same validation MCP applies:

```
$ twining acknowledge --json '{"handoff_id":"01NOPE"}'                → {"ok":false,…,"error":{"code":"INVALID_ARGUMENTS","message":"agent_id: Required"}}   exit=2
$ twining acknowledge --agent-id audit --json '{"handoff_id":"01NOPE"}' → {"ok":false,…,"error":{"code":"INTERNAL_ERROR","message":"Handoff not found: 01NOPE"}}   exit=1
$ twining post --json '{"entry_type":"bogus"}'
{"ok":false,…,"error":{"code":"INVALID_ARGUMENTS","message":"entry_type: Invalid enum value. Expected 'need' | 'offer' | … | 'warning', received 'bogus'; summary: Required"}}   exit=2
```

**Unknown flags.** Registry commands and `capabilities` refuse an unknown flag, a bare positional payload, or a flag before the command, with exit 2. Otherwise `twining archive --jsonn '{"retain":200}'` would drop the payload and sweep the whole board:

```
$ twining assemble --jsonn '{}'
{"ok":false,…,"error":{"code":"USAGE","message":"unknown option \"--jsonn\""}}
$ twining assemble '{}'
{"ok":false,…,"error":{"code":"USAGE","message":"unexpected argument \"{}\" — pass the payload with --json '<json>', --input-file <f>, or --stdin"}}
$ twining --project <dir> doctor
{"ok":false,…,"command":null,"error":{"code":"USAGE","message":"expected a command, got the flag \"--project\""}}
```

That protection does not cover the v3 verbs (row 6). Each line below ran with `>/dev/null 2>&1`:

```
[identity init --bogus] exit=0   [events ls --bogus] exit=0   [sync --bogus] exit=0   [doctor --bogus] exit=0
[migrate-status --bogus] exit=0  [validate-records --bogus] exit=2  [capabilities --bogus] exit=2  [status --bogus] exit=2
```

### Output

Registry commands, `capabilities`, `identity`, `rule`, `events`, `sync` and `doctor` print exactly one JSON envelope on stdout, and Twining's diagnostics go to stderr. A success envelope names the store it actually used:

```json
{"ok":true,"schema_version":"1","server_version":"2.16.1","command":"twining_post","project_root":"<proj>","store_dir":"<proj>/.twining","result":{"id":"01M4924296GJTG8JR3E8W9B5SN","timestamp":"2026-10-06T16:53:02.886Z"}}
```

Check `project_root` and `store_dir` when a call surprises you. Inside a linked worktree a cwd-default call writes to the **main** checkout's store ([Store resolution](#store-resolution)).

`result` is byte-identical to the MCP tool's `content[0].text`. On one store, `twining assemble --json '{"task":"offline check","scope":"src/"}'` and the server's `tools/call twining_assemble` with the same arguments over stdio both returned 1,464 bytes, and `cmp -s` found them identical.

These commands print no envelope: `--version`/`--help` (plain text), `migrate` (a plain-text report), `rollback --to 2` (Markdown), `migrate-status` (pretty-printed JSON), `validate-records` (text, or pretty JSON with `--json`) and `hook` (the host's hook-response JSON, or nothing).

### Exit codes

| code | meaning | examples from runs |
|---|---|---|
| `0` | success | `post`, `status`, `assemble`, `capabilities` |
| `1` | well-formed call, Twining said no | `why --json '{}'` → `INVALID_INPUT`. `trace --json '{"decision_id":"01NOPE"}'` → `NOT_FOUND`. A missing handoff → `INTERNAL_ERROR`. A read-only project → `STORE_UNWRITABLE`. A migrated store → `FORMAT_VERSION_TOO_NEW`. |
| `2` | fix your invocation | `USAGE`. `UNKNOWN_COMMAND` (`twining nosuchcommand`). `INVALID_JSON` (`--json 'not json'`, two sources). `INVALID_ARGUMENTS` (bad `entry_type`, `assemble` without `scope`). |

The v3 verbs use the same split. Seen in runs: `USAGE` (2) for `identity` with no subcommand, `rule` without `--scope`/`--statement`, and `events show` with no id. At 1: `PASSPHRASE_REQUIRED`, `NOT_A_TTY`, `AGENT_CONTEXT`, `NOT_ADMITTED` and `STORE_NOT_V3`. Defined in `src/cli/v3-verbs.ts` but **not reached** (from source, not a run): `UNLOCK_FAILED`, `RULING_REFUSED`, `NO_HUMAN_KEY`, `REGISTRY_INVOCATION`, `STORE_ROLLED_BACK`, `STORE_UNAVAILABLE`, `SYNC_FAILED`. `hook` always exits 0. The `migrate` family has its own scheme ([below](#the-twining-mcp-binary-and-its-subcommands)).

### `twining capabilities`

This lists every command with its surface and a JSON Schema. It takes only `--project`, and `capabilities --json` is refused (`USAGE`, exit 2). The output is one line of about 50 KB, and the size moves with the path because the project directory is embedded four times. Parsed from a run in an empty directory:

```
commands: 41  by surface: {"full":25,"default":16}
requires_mode=full: twining_add_entity,twining_add_relation,twining_archive,twining_graph_query,twining_neighbors,twining_prune_graph,twining_status
store_exists: false  store_writable: true
input_schema without additionalProperties:false: twining_status {"type":"object"}
```

Each entry has `name`, `surface`, `description` and `input_schema`, and seven also have `requires_mode`. Forty schemas are draft-07 with `additionalProperties: false`. `twining_status` takes no input, and its schema is exactly `{"type":"object"}`. `capabilities` writes nothing: the directory stayed empty. In a `chmod 555` directory it still answers, so it is the safe probe:

```
$ twining capabilities | <print ok, store_exists, store_writable>   → true false false   exit=0
$ twining status   → {"ok":false,…,"error":{"code":"STORE_UNWRITABLE",…}}   exit=1
```

`surface: "full"` means an MCP peer sees the command only with config `tools.full_surface: true`. `requires_mode: "full"` is a second MCP gate, since `tools.mode: "lite"` registers none of those seven. **The CLI dispatches every command whatever either gate says.** Both fields are reported so you can see why an MCP peer is missing a command.

## Store resolution

The rules match the server's (`src/utils/project-root.ts`):

1. `--project <dir>`, used as given.
2. `TWINING_PROJECT`, resolved against the cwd.
3. The cwd. **Only here** is a linked git worktree redirected to its main checkout. `TWINING_WORKTREE_LOCAL=true` opts out.

From a linked worktree `<proj>-wt` of `<proj>`:

```
$ twining capabilities | grep -o '"project_root":"[^"]*"' | head -1                            → "project_root":"<proj>"
$ TWINING_WORKTREE_LOCAL=true twining capabilities | grep -o '"project_root":"[^"]*"' | head -1 → "project_root":"<proj>-wt"
```

### `STORE_UNWRITABLE`

Before touching anything, the CLI checks that the resolved store (or the root it would be created in) is writable. If not, it exits 1 and never falls back to another store:

```json
{"ok":false,…,"command":"twining_status","error":{"code":"STORE_UNWRITABLE","message":"Twining store <ro>/.twining is unusable: <ro> is not writable by this process. Project root resolved to <ro>. Twining will NOT silently fall back to another store. Fix it by pointing at a writable project (--project <dir> or TWINING_PROJECT=<dir>), or — if this is a git worktree whose main checkout is read-only (a common sandbox shape) — keep the store worktree-local with TWINING_WORKTREE_LOCAL=true."}}
```

In the sandbox shape, choose explicitly between `TWINING_WORKTREE_LOCAL=true twining status` and `twining status --project "$PWD"`. The combined case (redirect plus a read-only main checkout) was **not staged**. The redirect and the refusal were each run separately.

## Offline behaviour

If the embedding model (`Xenova/all-MiniLM-L6-v2` under `.twining/models/`) is not on disk, the CLI uses keyword search and says so on stderr:

```
[twining] No local embedding model at <proj>/.twining/models/Xenova/all-MiniLM-L6-v2 — using keyword search (offline mode: no download attempted).
```

The CLI builds its context with `{ background: false, offline: true }` (`src/cli/twining.ts`, from source, not a run). **UNAVAILABLE:** a run without `TWINING_OFFLINE` showing that the CLI never downloads, because that run could download. To close it where a download is acceptable: `env -u TWINING_OFFLINE twining post --json '{"entry_type":"status","summary":"x"}'`.

The **server** honours `TWINING_OFFLINE` set to `1`, `true` or `yes`. Each was run over stdio JSON-RPC on a store with one post, and each printed the notice above. An empty value counts as off (from source: `offlineFromEnvironment`, `src/core/context.ts`) and was not run.

`background: false` skips the server's startup pending-queue drain, its 60 s repeat and the sqlite embedding reconcile (from source, not a run; no output shows it). No CLI run printed the server's `[twining] Dashboard:` line, which the server prints on every start. Telemetry is constructed only in `src/index.ts` (from source, not a run), and the default `config.yml` has `analytics.telemetry.enabled: false`.

## Codex sandbox notes

**UNAVAILABLE: none of this was shown on a real Codex host.** The owner has not granted hook trust (see [`hosts-codex-capabilities.md`](operations/hosts-codex-capabilities.md)), so the Codex adapter has only been fed synthetic stdin. What follows is design rationale. *No network*: the model is the only thing that would want it. *Only `cwd` and `/tmp` are writable*: that is the `STORE_UNWRITABLE` case, so decide per session between `TWINING_WORKTREE_LOCAL=true` and an explicit `--project`, and export it. *No `PATH` from plugins*: call `npx twining …` or install globally (row 20). *Allowlists*: `npx twining …` and `twining …` are stable command identities.

## Gates from a shell

```bash
twining assemble --json '{"task":"add rate limiting","scope":"src/api/"}'   # Gate 1
twining why --json '{"scope":"src/api/limiter.ts"}'
twining post --json '{"entry_type":"finding","summary":"limiter shares the auth cache"}'
twining record --json '{"summary":"Added a token-bucket limiter","decisions":["Chose token bucket over sliding window — bursty traffic"],"findings":["warning: limiter shares the auth cache"],"affected_files":["src/api/limiter.ts"]}'   # Gate 2
```

`scope` is required on `assemble`:

```
$ twining assemble --json '{"task":"audit"}'
twining: invalid input for twining_assemble — scope: Required          (stderr)
{"ok":false,…,"error":{"code":"INVALID_ARGUMENTS","message":"scope: Required"}}   exit=2
```

`record`, `post` and `decide` refresh `.twining/.last-record` (10 bytes, a Unix timestamp), the file the pre-commit hook checks. The `record` above returned `"message":"Recorded status + 1 decision(s) + 1 finding(s)"`, exit 0. Two caveats: these writes are refused on a migrated store (row 1), and `record` writes git's own errors to stderr (row 7).

## Calling it from hooks

```bash
#!/usr/bin/env bash
# Best-effort: a hook must never fail the operation it observes.
twining post --project "$CLAUDE_PROJECT_DIR" --agent-id stop-hook \
  --json "$(jq -cn --arg s "$SUMMARY" '{entry_type:"status",summary:$s}')" \
  >/dev/null 2>&1 || true
```

Pass `--project`, because a hook's cwd is not reliably the project root. Build JSON with a tool (`jq`, or `--input-file`), not by concatenating strings. Decide what failure means: `|| true` to stay non-blocking, or read the exit code (2 means the hook is wrong, 1 means Twining refused this call). For v3 capture the plugin ships a shim that does all three ([`twining hook`](#twining-hook-claude-codecodex-eventname)).

## Differences from the MCP server

| | MCP server | CLI |
|---|---|---|
| command surface | `tools.full_surface` hides 25 of 41, and `tools.mode: "lite"` hides 7 | every command can be dispatched |
| embedding model | downloads if absent unless `TWINING_OFFLINE` or config `embeddings.offline` is set | always offline (from source); keyword fallback |
| pending-queue drain | at startup and every 60 s | skipped (from source, not a run) |
| dashboard | started (`[twining] Dashboard: http://127.0.0.1:<port>`) | never seen in any CLI run |
| `TWINING_DISABLED=true` | exits 0 at once; in an empty directory, no output and nothing created | ignored (`capabilities` ran, exit 0); the shipped hook shim honours it |
| quality nudge | once per server process: three sequential `twining_record` calls (two decisions, no findings) gave the nudge on call 1 only | once per invocation: two consecutive `twining record` runs both carried `quality_nudge` |

`tools.full_surface` also gates provisional minting inside `record`, on both front ends. Payload `{"summary":"provisional probe","decisions":[{"summary":"Provisional probe decision","rationale":"probe","status":"provisional"}]}`:

```
full_surface: false   CLI and MCP: "decisions_created":[]  "message":"Recorded status + 1 decision error(s)"
                      "decision_errors":["\"Provisional probe decision\": status requires tools.full_surface: true — … this decision was NOT recorded"]   exit=0
full_surface: true    CLI and MCP: "decisions_created":[{"id":"01M492ME…","summary":"Provisional probe decision"}]  "message":"Recorded status + 1 decision(s)"
                      twining status → "active_decisions":0,"provisional_decisions":2
```

---

## The `twining-mcp` binary and its subcommands

`twining-mcp` is the stdio MCP server and also carries the store subcommands. The procedures that use them (upgrade, recovery, rollback) are in [`operations/recovery-and-rollback.md`](operations/recovery-and-rollback.md), §6–§8. This section documents the commands themselves.

**There is no `--help`.** Any first argument that starts with `-` (other than `--version`/`-v`) starts the server (row 8):

```
$ twining-mcp --help </dev/null      → stderr: [twining] Dashboard: http://127.0.0.1:<port>   exit=0
$ ls -A .twining
.gitattributes .gitignore agents archive blackboard.jsonl config.yml decisions embeddings graph handoffs twining.db
$ twining-mcp help
twining-mcp: unknown subcommand "help"
usage: twining-mcp [--project <dir>]                      (start the MCP server)
       twining-mcp migrate [--project <dir>] [--dry-run] [--check] [--reverse] [--to 3]
       twining-mcp rollback --to 2 [--project <dir>] [--dry-run]
       twining-mcp migrate-status [--project <dir>]
       twining-mcp events ls|show <id> [--project <dir>]
       twining-mcp validate-records [--project <dir>] [--json]
       twining-mcp --version
exit=2
```

`twining migrate | rollback | migrate-status | validate-records` forward to the same code with the same output (row 19). **`twining events` is a different command from `twining-mcp events`.** The first reads the admitted live log as envelopes. The second reads event files with no database and keeps working on a rolled-back store. Exit codes here: 2 for usage and environment errors ("no `.twining/`", "not on v3"), 1 for a verification failure, record findings or an unknown event id. `migrate-status` exits 0 even with no store.

### `migrate`

Without `--to`, `migrate` is the legacy files → sqlite path. On a fresh 2.x store:

```
$ twining-mcp migrate --check
twining-mcp migrate — files → sqlite check
  posts: 0  decisions: 0  entities: 0  relations: 0  handoffs: 0  …  check passed: target contains every source record.   exit=0
$ twining-mcp migrate --dry-run   → …  dry-run: nothing written. Re-run without --dry-run to migrate.      exit=0
```

`migrate --to 3` is the v3 event-store migration. Its dry run **writes `legacy/manifest.json`**, and says so:

```
$ twining-mcp migrate --to 3 --dry-run
twining migrate --to 3 — dry run
  legacy files: 5  records: 1  created: 0  derived: 0  rivals: 0  damaged: 0  conflicts: 0
  manifest: <proj>/.twining/legacy/manifest.json
  note: dry run: legacy/manifest.json written; no events, no config change
$ twining-mcp migrate --to 3
twining migrate --to 3 — forward migration
  legacy files: 5  records: 1  created: 1  derived: 0  rivals: 0  damaged: 0  conflicts: 0
  …
  note: records/ is frozen (records/RECORDS-FROZEN.md); the authority is events/ + attachments/
  Next steps (nothing has been committed for you):
    git add .twining/events .twining/attachments .twining/legacy .twining/store.json .twining/config.yml .twining/records/RECORDS-FROZEN.md
  …  Teammates on 2.x go READ-ONLY on this store until they update.   exit=0
```

After that, `config.yml` says `version: 3`, and this build's own registry writes are refused (row 1). Each of the following is refused with exit 2 and the subcommand usage block:

| invocation | stderr first line |
|---|---|
| `migrate --to 3 --check` | `migrate: --check is not supported with --to 3 (use \`twining-mcp migrate-status\`)` |
| `migrate --to 3 --reverse` | `migrate: --reverse is not supported with --to 3 (use \`twining-mcp rollback --to 2\`)` |
| `migrate --to 2 --reverse` | `migrate: --reverse targets format 1, not 2 — drop --to, or drop --reverse` |
| `migrate --check --dry-run` | `migrate: --check and --dry-run are mutually exclusive` |
| `migrate --to 4` | `migrate: unsupported target format 4 (expected 2 or 3)` |
| `migrate --help` | `migrate: unknown argument: --help` |
| `migrate --check`, no store | `migrate: no .twining/ directory at <dir>/.twining — nothing to migrate` (no usage block) |

**After `identity init`.** `identity init` writes only `repo_ids` to `store.json`. `migrate-status` now reads it, and `migrate --to 3` keeps both ids, adding `repo_id` and `migrated_from`:

```
$ twining identity init | grep -o '"store":{[^}]*}'   → "store":{"store_id":"s_01M4927G8KYWDNX400VWV7SS09","repo_id":"r_01M4927G8JAH2AE4KKW598B7YN","format":3,"created":true,…}
$ twining-mcp migrate --to 3 && cat .twining/store.json
{ "store_id": "s_01M4927G8KYWDNX400VWV7SS09", "repo_id": "r_01M4927G8JAH2AE4KKW598B7YN",
  "repo_ids": ["r_01M4927G8JAH2AE4KKW598B7YN"], "format": 3, …, "migrated_from": 2 }
```

### `migrate-status`

This prints JSON with no envelope and exits 0, even with no `.twining/` (`"format": 1, "migration": "not_started"`). One store's life, one key per line in the real output:

```json
{ "format": 1, "migration": "not_started", "completed_steps": [], "remaining_steps": ["manifest","events","idmap","verify","finalize"], "store_id": null, "repo_id": null, "events": 0, … }
{ "format": 3, "migration": "complete", "completed_steps": ["manifest","events","idmap","verify","finalize"], "store_id": "s_9TSZ…", "repo_id": "r_F3YB…", "events": 1, "attachments": 1, "legacy_records": 1, "manifest_present": true, "id_map_entries": 1, "records_frozen": true }
{ "format": 3, "migration": "rolled_back", …, "records_frozen": false, "rolled_back_at": "…" }
```

After a rollback, `store.json` still says `"format": 3` while `config.yml` says `version: 2`. Only `migration: "rolled_back"` tells you it is rolled back (row 13).

### `rollback --to 2 [--dry-run]`

This prints a Markdown report and exits 0. `--dry-run` appends `(dry run: nothing was written)`. Key lines:

```
# Rollback report — v3 → 2
## Data preservation          - events retained: 1 … events/, attachments/ and cursors/ are UNCHANGED and remain the authority
## Commit these (…)            - **`.twining/legacy/view-manifest.json`** — REQUIRED. Without it the next `twining migrate --to 3` reads every view file as a new legacy record …
## Unavailable functionality (NOT data loss)   - **multi_part_records** … **scope_tuple**   (ten named capabilities)
```

Refusals, exit 2: `rollback` → `rollback: --to 2 is required (got nothing)`, `--to 3` → `(got 3)`, and on a store never migrated → `rollback: this store is not on v3 (no completed migration) — nothing to roll back`. Afterwards `.twining/legacy/` holds `id-map.json manifest.json migration-state.json pre-rollback-originals rollback-report.json ROLLBACK-REPORT.md view-manifest.json`.

### `twining-mcp events ls [--limit N]` / `events show <event-id>`

```
$ twining-mcp events ls
01M4927G6AW9PWVDN3AY0RNC77  created  post  01M4927G6AW9…  legacy_unverified  legacy  id-mapped
01M4927GMWX9B1QPEDBTPV1T1A  created  post  01M4927GMWX9…  human_statement
01M4927GNVZ41K6ZWFDD15M49C  receipt  -     -              proposal
# 3 event file(s) under .twining/events/
```

It lists event **files**, admitted or not, so the quarantined receipt from row 11 appears here but not in `twining events ls`. The listing was the same before and after `rollback --to 2`. Errors on a v3 store: no id → `events show: an event id is required` (exit 2). `--limit 0` → `events: --limit takes a positive integer (got 0)` (exit 2). Unknown id → `events show: no event 01NOPE under .twining/events/` (exit **1**). On a 2.x store or with no store, every form gives `events: no .twining/events/ directory — this store is not on v3` (exit 2).

### `validate-records [--json]`

```
$ twining-mcp validate-records
twining-mcp validate-records — <proj>
  records dir: present  files checked: 1  store: sqlite-era
  git: not a repository (tracked-file checks skipped)
  ok                                                                   exit=0
```

A stray `records/posts/<month>/STRAY.json.tmp` is not a finding. An unparseable `.json` is:

```
$ echo 'not json' > .twining/records/posts/2026-10/BAD.json; twining-mcp validate-records
  records dir: present  files checked: 2  store: sqlite-era
  unparseable: .twining/records/posts/2026-10/BAD.json (Unexpected token 'o', "not json
" is not valid JSON)
  1 record problem(s) — repair before committing this tree            exit=1
$ twining-mcp validate-records --json   → { …, "findings": [ { "path": ".twining/records/posts/2026-10/BAD.json", "kind": "unparseable", … } ], "tracked": null, "ok": false }   exit=1
```

`twining validate-records` also exits 1 there. Usage errors and a missing store (`validate-records: no .twining/ under <dir>`) exit 2. Finding kinds from the tracked-file checks in a git repo were not staged.

---

## v3 verbs

These exist only in the `twining` CLI. They are not registry commands, so they are not MCP tools and are not among the 41. That is deliberate: `twining rule` must have no code path from an MCP peer, because the signing ceremony is the only producer of a `human_ruling`. `identity`, `sync` and `doctor` are operator verbs about this machine and store, and `events` is a raw log reader. Each prints one envelope except `hook`, and each ignores unknown flags (row 6).

### `twining identity init [--human] [--label <name>]`

This mints the machine's host key at `<identity home>/host/host.json` (mode 0600) and creates `.twining/store.json` at format 3, each only if absent. `TWINING_IDENTITY_HOME` overrides the default `~/.twining/identity`. A second run returns `"created":false` with the same `store_id`.

```
$ twining identity   → {"ok":false,…,"error":{"code":"USAGE","message":"usage: twining identity init [--human] [--label <name>]"}}   exit=2
$ twining identity init   → {"ok":true,…,"command":"identity",…,"result":{"identity_home":"<idhome>","host":{"host_id":"h_01M4925B…","principal_id":"p_01M4925B…","key_id":"k_01M4925B…","file":"<idhome>/host/host.json"},"store":{"store_id":"s_01M4925BQH1YXF611S5DKF1RTG","repo_id":"r_01M4925BQH1YXF611S5DKF1RTF","format":3,"created":true,"file":"<proj>/.twining/store.json"},"humans":[]}}
$ cat .twining/store.json   → { "store_id": "s_01M4925BQH1YXF611S5DKF1RTG", "repo_ids": ["r_01M4925BQH1YXF611S5DKF1RTF"], "format": 3, "created_at": "…" }
```

`--human` also mints a human principal. Its private key is passphrase-encrypted at `<identity home>/human-<p_…>/key.json`, with the passphrase read from the TTY or from `TWINING_HUMAN_PASSPHRASE`. There is no unprotected form:

```
$ TWINING_HUMAN_PASSPHRASE=short twining identity init --human --label auditor
{"ok":false,…,"error":{"code":"PASSPHRASE_REQUIRED","message":"a human key needs a passphrase of at least 8 characters"}}   exit=1
$ TWINING_HUMAN_PASSPHRASE=<8+ chars> twining identity init --human --label auditor
…"humans":[],"human":{"principal_id":"p_01M4925BXT…","key_id":"k_01M4925BXT…","label":"auditor","file":"<idhome>/human-p_…/key.json","note":"this key is the root of trust for rulings on this machine. …"}}}
$ ls -l <idhome>/host/host.json <idhome>/human-*/key.json      → both -rw------- (409 and 582 bytes)
```

`humans` lists humans minted **before** this call. The key file's fields are `principal_id,key_id,public_key,encrypted_private_key,label,created_at`, and `encrypted_private_key` is a PKCS#8 `ENCRYPTED PRIVATE KEY` PEM block:

```
$ openssl asn1parse -in key.pem | grep -E 'PBES2|PBKDF2|INTEGER|hmac|aes' | awk '{print $NF}' | paste -sd' ' -   → :PBES2 :PBKDF2 :0800 :hmacWithSHA256 :aes-256-cbc
$ openssl pkey -in key.pem -passin pass:<passphrase> -noout -text | head -1   → ED25519 Private-Key:
```

That is PBKDF2 with 2048 iterations and HMAC-SHA256, then AES-256-CBC. A wrong passphrase fails with `Could not find private key`. `identity init` **is not the migration** (row 14).

### `twining rule --scope <path> --statement <text> […]`

This is the ruling ceremony. **It cannot run without a TTY, and nothing here shows it succeeding.** With stdin from `/dev/null`:

```
$ twining rule
{"ok":false,…,"error":{"code":"USAGE","message":"usage: twining rule --scope <path> --statement <text> [--cites <ids>] [--grants <principal:role>] [--requirements <key=value>]"}}   exit=2
$ twining rule --scope src/ --statement 'audit statement'
{"ok":false,…,"error":{"code":"NOT_A_TTY","message":"stdin is not a TTY — the ruling ceremony runs only at an interactive terminal"}}   exit=1
$ TWINING_AGENT_CONTEXT=1 twining rule --scope src/ --statement 'audit statement'
{"ok":false,…,"error":{"code":"AGENT_CONTEXT","message":"TWINING_AGENT_CONTEXT is set: this process is running inside an agent host, so it is not a human at a terminal and cannot perform the ceremony"}}   exit=1
```

The checks run in the order `USAGE`, then `AGENT_CONTEXT` (before the TTY check), then `NOT_A_TTY`. **UNAVAILABLE (needs a human at a terminal):** `STORE_NOT_V3`, `NO_HUMAN_KEY`, `UNLOCK_FAILED`, `RULING_REFUSED` and the success path. `REGISTRY_INVOCATION` has no CLI path at all (from source). By design (from source, not a run): success signs a `ruling` event with the **human** key and appends it through the `ceremony` ingress. On a store with no membership policy, the first ceremony also writes the bootstrap `membership` that makes that key the store's root of trust. Automated tests produce rulings through `appendRuling()` with a fixture key, not by faking a TTY.

### `twining events ls` and `twining events show`

`twining events ls [--limit <n>] [--kind <k>] [--record <id>]` and `twining events show <id>` read the **admitted** live log, as envelopes. `twining events` alone runs `ls`. After `hook claude-code SessionStart` and `UserPromptSubmit` on a fresh v3 store:

```json
{"ok":true,…,"command":"events",…,"result":{"total":2,"shown":2,"events":[
 {"id":"01M4925CFJ…","kind":"created","record":{"type":"observation",…},"evidence_class":"verified_observation","producer":"p_…","scope":{"repo":"r_01M4925BQH…","task":"session:sess-1"},"digest":"sha256:…","signed":true},
 {"id":"01M4925CK7…","kind":"created","record":{"type":"post",…},"evidence_class":"human_statement",…}]}}
```

`--kind` filters on **event** kinds (`created`, `receipt`, …), so `--kind session_start` returns `total 0`. The other lifecycle kinds it accepts are listed in `src/contracts/lifecycle.ts` (from source), and none was produced here. `--limit n` keeps the newest n, oldest first (`--kind created --limit 1` → `"total":4,"shown":1`). `--record <post id>` → `"total":1,"shown":1`, and an unknown id returns `ok:true` with an empty list.

**Admission lag (row 10).** In the run above, `--kind receipt` gave `total 0`. The receipt's admission log (`events show`) shows `local_persisted` at seq 5 from the hook that wrote it and `admitted` at seq 7 during the **next** hook run. Which commands admit, measured after one more `UserPromptSubmit`:

```
after [events ls] total=28   after [doctor] total=28   after [status] total=28   after [sync] total=29   after [events ls] total=29
```

Hook runs and `sync` admit pending events. `events`, `doctor`, `status` and registry commands do not. `events show <id>` returns the signed envelope with `delivery` and `admission_log`:

```json
{"ok":true,…,"result":{"event":{"v":3,"id":"01M4925CKQ…","kind":"receipt","scope":{"repo":"r_…"},"producer":{"principal":"p_…","kind":"agent","host":"h_…"},"source":{"repo":"r_…","worktree":"wt_…","branch":"main","commit":"d86264e0…","dirty":true},"parents":[],"evidence_class":"proposal","payload":{"stage":"injected","consumer":"p_…","events":["01M4925CK7…"],"session":"sess-1","turn":"unknown-turn",…},"digest":"sha256:…","sig":{"alg":"ed25519","key":"k_…","value":"…"}},"delivery":{"state":"projected","attempts":1,"admissions":1,…},"admission_log":[{"seq":5,…,"outcome":"local_persisted","reason":"appended via adapter",…},{"seq":7,…,"outcome":"admitted","reason":"admitted:validated",…}]}}
```

Not found and not admitted share one code (row 12):

```
$ twining events show 01NOPE   → {"ok":false,…,"error":{"code":"NOT_ADMITTED","message":"no event 01NOPE in this store"}}   exit=1
$ twining events show 01M4927GNVZ41K6ZWFDD15M49C
{"ok":false,…,"error":{"code":"NOT_ADMITTED","message":"event 01M4927GNVZ41K6ZWFDD15M49C exists in state \"quarantined\" (signature_required) but is not admitted"}}   exit=1
```

On a 2.x store: `STORE_NOT_V3`, exit 1, `this store has no event log — run \`twining identity init\` to create one`. On a rolled-back store it answers normally (row 13).

### `twining sync [--remote <name>] [--path <dir>]`

`sync` flushes the outbox and pulls the inbox. **At this commit it always uses the filesystem carrier** (row 3). With a bare-repo `origin`:

```
$ twining sync --remote origin
{"ok":true,…,"command":"sync",…,"result":{"carrier":"fs:<proj>/.twining/exchange-fs","transport":"fs:<proj>/.twining/exchange-fs","published":{"attempted":8,"transferred":8,"uncertain":[]},"received":{"polled":8,"admitted":2,"duplicates":8,"conflicts":[],"pending_parents":[],"quarantined":[],"rejected":[],"ack_recorded":true},"checkout":{"status":"ok","missing":[]}}}
$ git --git-dir=<remote.git> for-each-ref   → d86264e01bb4642f88207a4bec49ccf3540e18ea commit	refs/heads/main   (nothing else)
```

Why, probing the built module `dist/exchange/git-transport.js`:

```
exports: EXCHANGE_BRANCH,EXCHANGE_REF,GitTransport,UnionViolationError,cursorFileName,redactRemote,redactText
positional ctor (as v3-verbs.ts calls it) THREW: The "path" argument must be of type string. Received undefined
options ctor ({ twiningDir, repoDir }): OK
```

The carrier directory is `--path <dir>`, then `TWINING_EXCHANGE_DIR`, then `.twining/exchange-fs`. All three were run, and `--path` wins over the variable. `sync --path <shared>` gave `carrier: "fs:<shared>"`, after which `<shared>` held `cursors events index.jsonl`. That is how two checkouts on one machine exchange (what the receiver does with the bytes: [recovery §7.3](operations/recovery-and-rollback.md)). On a 2.x store: `STORE_NOT_V3`, `nothing to sync: this store has no event log`, exit 1. `published.uncertain` was `[]` in every run, since no lost receipt was staged. **UNAVAILABLE:** a second computer or a network remote.

### `twining doctor`

`doctor` reports bindings (project root, store, and separately the producing checkout's branch and commit), key **ids** (never key material), capture coverage per host, installed-hook provenance and event counts. On a v3 store after hooks and `sync`:

```
$ twining doctor | <print result.bindings, result.events>
{"project_root":"<proj>","store_dir":"<proj>/.twining","source_cwd":"<proj>","source":{"repo":"r_01M4925BQH…","worktree":"wt_…","branch":"main","commit":"d86264e0…","dirty":true},"store_format":3,"store_id":"s_01M4925BQH…","repo_ids":["r_01M4925BQH…"],"repo_ids_cited":["r_01M4925BQH…"],"repo_ids_undeclared":[],"v3_enabled":true}
{"total":8,"admitted":8,"quarantined":0,"rejected":0}
```

The top-level keys are `bindings, identity, capture_coverage, hooks, events, honest_limits`. `identity` gives host and human key ids and labels, with the note `key ids only — no key material is ever printed by this command`. `capture_coverage` shows 7 of 7 lifecycle points `supported` for both `claude-code` and `codex`. It describes the adapter, not an installed host (the first `honest_limits` entry says so), and real Codex behaviour is UNAVAILABLE.

`repo_ids_cited` / `repo_ids_undeclared` compare the repo ids events carry with those `store.json` declares. After a deliberate edit of `store.json` to declare another id:

```
"repo_ids":["r_00000000000000000000000000"],"repo_ids_cited":["r_01M4927G8J…"],"repo_ids_undeclared":["r_01M4927G8J…"]
honest_limits += "events cite repo id(s) store.json does not declare (r_01M4927G8J…): the retrieval gate authorizes by the declared id, so those events are outside it; a pre-fix migrate --to 3 after identity init leaves this shape and a rerun does not heal it — repair is a deliberate edit of store.json and legacy/migration-state.json"
```

`source.branch`/`commit`/`dirty` appear only in a git checkout. Elsewhere `source` is `{"repo":…,"worktree":…}`, or just `{"worktree":…}` with no store. With no store, `doctor` reports `"store_format":"2 (no store.json)"`, `"store_id":null`, `"v3_enabled":false`, `"events":null`, and a third `honest_limits` entry, `this store is on the 2.x format: no events are being written; 2.x behavior is unchanged`. It writes nothing to the project but does mint the host key (row 15). `hooks` reads the user's real home files (row 16).

### `twining hook <claude-code|codex> <EventName>`

This is the shim that shell hooks call. It reads the host's event JSON on stdin and prints the host's response JSON on stdout, never a Twining envelope. **It always exits 0**, including on bad input. On a fresh v3 store:

```
$ printf '{"session_id":"sess-1","hook_event_name":"SessionStart","cwd":"<proj>","source":"startup"}' | twining hook claude-code SessionStart
[twining] nothing to inject: the working set for this scope is empty          (stderr; stdout empty)
$ printf '{"session_id":"sess-1","hook_event_name":"UserPromptSubmit","cwd":"<proj>","prompt":"hello from the audit"}' | twining hook claude-code UserPromptSubmit
{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"## Twining — working set for this scope\n\n- [human statement] status: hello from the audit\n  scope: session:sess-1\n  (does not authorize action on its own)\n\nEvidence class is stated per item and is NOT changed by the wording of the item. Only a RULING carries human authority; everything else is a claim."}}
$ printf '…"prompt":"second prompt"}' | twining hook claude-code UserPromptSubmit   → {"hookSpecificOutput":{…,"additionalContext":"## Twining — new since your last injected context\n\n- [human statement] status: second prompt\n …"}}
$ printf 'not json' | twining hook claude-code Stop     → stderr: twining hook: could not parse the host's JSON on stdin (Unexpected token 'o', …)
$ printf '[1,2]' | twining hook claude-code Stop        → stderr: twining hook: the host's stdin was valid JSON but not an object; nothing captured
$ twining hook                                         → stderr: twining hook: usage: twining hook <claude-code|codex> <EventName>   (exit 0)
```

`SessionStart` records an `observation` (`verified_observation`). `UserPromptSubmit` records the prompt as a `post` (`human_statement`) plus a `receipt` for what was injected. Later prompts in the session inject only what is new, and so does `SessionStart` with `source: "compact"` (row 4). `hook codex SessionStart` for another session returned a Claude-Code-shaped `hookSpecificOutput` with both posts. Whether Codex accepts that shape is UNAVAILABLE.

Every shipped event, on a 2.x store and on a v3 store. All runs exited 0, stderr lines start with `[twining] `, and `—` means empty:

| event | 2.x store: stdout / stderr | v3 store: stdout / stderr |
|---|---|---|
| `SessionStart` | 2.x gate context (`## Coordination — Twining Lifecycle Gates…`) / `store is not v3-enabled; emitting the 2.x lifecycle-gate context unchanged` | working set, or `nothing to inject` |
| `UserPromptSubmit` | — / `store is not v3-enabled; no capture` | working set / — |
| `PreCompact` | — / `PreCompact cannot inject context on this host — additionalContext is discarded. Re-seeding rides SessionStart(source=compact).` | same |
| `SubagentStart` | — / `SubagentStart injects into the SUBAGENT, never the parent session.` | working set / same notice |
| `Stop` | — / — | — / — |
| `SubagentStop` | — / `store is not v3-enabled; no capture` | — / `a worker return is a reported_result — it is not completion, merge or acceptance` |
| `SessionEnd` | — / `SessionEnd discards all hook output on this host; flush only.` | same |

On the 2.x store the `codex` adapter printed `no capture` for `UserPromptSubmit`; `codex adapter has no handler for PreToolUse; nothing captured, nothing claimed` (same for `PostToolUse`); and for `Stop`, `codex Stop cannot inject context (no additionalContext member in its output schema); …`. None of these runs wrote `store.json` or any event, but the host key was minted (row 15).

**Options and environment.** `--project <dir>` works: run from `/` with `--project <proj>`, the prompt was captured into `<proj>` and no `/.twining` was created. `TWINING_SESSION_ID` / `TWINING_TURN_ID` are stamped on every event as `producer.session` / `producer.turn`. They neither override the payload's `session_id` for `scope.task` nor stand in when it is missing:

| stdin `session_id` | env | post `scope` | post `producer` |
|---|---|---|---|
| `payload-sess` | `env-sess` / `env-turn` | `{repo, task:"session:payload-sess"}` | `{…,"session":"env-sess","turn":"env-turn"}` |
| *(absent)* | `env-only-sess` / `env-turn` | `{repo}`, **no task** | `{…,"session":"env-only-sess","turn":"env-turn"}` |

**The shipped plugin wiring.** `plugin/hooks/hooks.json` runs `v3-capture-hook.sh claude-code <Event>` for `SessionStart` (`startup|resume|clear|compact|fork`), `UserPromptSubmit`, `PreCompact` (`manual|auto`), `SubagentStart`, `Stop`, `SubagentStop` and `SessionEnd`. The shim exits 0 without calling the CLI when `TWINING_DISABLED=true`, when no `.twining/` is found, when `store.json` lacks `"format": 3`, or when the launcher finds no CLI (from source, `plugin/hooks/v3-capture-hook.sh`). Run end to end:

```
$ printf '{…"session_id":"sess-shim-1",…,"prompt":"via the shipped shim"}' | TWINING_CLI_JS=<build>/dist/cli/twining.js bash plugin/hooks/v3-capture-hook.sh claude-code UserPromptSubmit
{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"## Twining — working set for this scope\n\n- [human statement] status: via the shipped shim\n  scope: session:sess-shim-1\n …"}}
$ printf '{…"prompt":"disabled"}' | TWINING_DISABLED=true TWINING_CLI_JS=… bash plugin/hooks/v3-capture-hook.sh claude-code UserPromptSubmit; echo $?   → 0 (stdout empty; nothing captured)
$ printf '{…"prompt":"no cli"}' | bash plugin/hooks/v3-capture-hook.sh claude-code UserPromptSubmit; echo $?   → 0 (no CLI found: silent no-op)
```

The `"format": 3` test still matches after `rollback --to 2` (row 13). **UNAVAILABLE:** real host behaviour. Every hook run here fed synthetic stdin. No live Claude Code session went through the shim, and Codex cannot run these hooks on this machine (hook trust not granted).
