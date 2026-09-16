# The `twining` CLI

`twining` runs every Twining command from a shell, over the same command core
the MCP server runs. Same commands, same input schemas, same result JSON, same
store resolution — only the transport differs.

## Why it exists

Some agent hosts cannot reach a Twining MCP server:

- **Codex sandboxes** run shell commands with no network, a plugin cannot put
  anything on `PATH`, and only the sandbox's own `cwd` (plus `/tmp`) is
  writable. A linked worktree's *main* checkout is read-only there.
- **Enterprise command allowlists** match exact command identity, which a
  stdio MCP server spawned by a host does not present.

A shell command is the one interface those hosts always have. Nothing about
the CLI is a second implementation: `src/cli/twining.ts` is an argv front end
over `src/core/commands/*`, and `src/server.ts` is an MCP front end over the
same definitions (`src/core/command-def.ts` does the registration).

## Install

Per project (recommended — pins the version alongside the MCP server):

```bash
npm i -D twining-mcp
npx twining capabilities
```

Globally:

```bash
npm i -g twining-mcp
twining capabilities
```

Both bins ship from the same package: `twining-mcp` (the stdio MCP server,
unchanged) and `twining` (this CLI).

> The Claude Code **plugin** bundles the MCP server, not the CLI. If you want
> `twining` on a machine, install the npm package.

## Usage

```
twining <command> [--json '<json>' | --input-file <f> | --stdin]
                  [--project <dir>] [--agent-id <id>]
twining capabilities [--project <dir>]
twining migrate [--project <dir>] [--dry-run] [--check] [--reverse]
twining validate-records [--project <dir>] [--json]
twining --version | --help
```

`<command>` is a `twining_*` tool name. The prefix is optional, so
`twining assemble` and `twining twining_assemble` are the same call; the
envelope always reports the canonical `twining_*` name.

### Input

Commands take a single JSON object, from exactly one of:

| flag | source |
| --- | --- |
| `--json '<json>'` | the argument itself |
| `--input-file <path>` | a file (handy when the payload has quotes a shell would eat) |
| `--stdin` | standard input |
| *(none)* | `{}` |

`--agent-id <id>` fills `agent_id` when the command accepts one and the
payload did not set it.

Input is validated against the command's zod schema before it runs — the same
validation the MCP transport applies — so a payload the server would reject is
not quietly accepted here.

An unrecognized flag, or a payload passed as a bare positional argument, is
**refused** (exit 2) rather than ignored. This is not pedantry:
`twining twining_archive --jsonn '{"retain":200}'` would otherwise drop the
payload and run an argument-free `twining_archive`, which sweeps the whole
board. A dropped payload must never look like a successful call. (A flag's
*value* may start with `-` — only unknown flags are refused.)

### Output

Exactly one JSON envelope on stdout, newline-terminated, and nothing else.
Every diagnostic (`[twining] …` store notices, ingest lines, the keyword
fallback notice) goes to stderr.

```json
{"ok":true,"schema_version":"1","server_version":"2.17.0","command":"twining_assemble","project_root":"/repo","store_dir":"/repo/.twining","result":{"briefing":"…"}}
```

```json
{"ok":false,"schema_version":"1","server_version":"2.17.0","command":"twining_why","error":{"code":"INVALID_INPUT","message":"Provide a scope or a list of decision ids"}}
```

`result` is byte-identical to what the matching MCP tool returns inside its
`content[0].text`.

Every success envelope also names the store it actually used — `project_root`
and `store_dir`, always absolute. Check them when a call surprises you: inside
a linked git worktree a cwd-default call targets the **main** checkout's store
(see [Store resolution](#store-resolution)), and writing to the wrong store is
the one failure mode the CLI cannot detect on your behalf.

`--version` and `--help` are the two exceptions: they print plain text, because
they describe the binary rather than invoking a command. Machine-readable
version and command metadata live in `twining capabilities`.

### Exit codes

| code | meaning |
| --- | --- |
| `0` | the command succeeded |
| `1` | the command ran and failed — `error.code` says why |
| `2` | the invocation was wrong: usage, unknown command, unparseable input, or input the schema rejects |

The split is deliberate: exit 2 means *fix your invocation*, exit 1 means *the
call was well-formed and Twining said no*.

Error codes you will see at exit 2: `USAGE`, `UNKNOWN_COMMAND`,
`INVALID_JSON`, `INVALID_ARGUMENTS`. At exit 1 you get the command's own code
(`INVALID_INPUT`, `NOT_FOUND`, `PERSIST_FAILED`, `INTERNAL_ERROR`, …) plus
`STORE_UNWRITABLE`, described below.

### `twining capabilities`

Lists every command with its surface flag and a JSON Schema derived from the
zod shape, plus the resolved store:

```json
{
  "ok": true,
  "schema_version": "1",
  "server_version": "2.17.0",
  "command": "capabilities",
  "result": {
    "name": "twining",
    "server_version": "2.17.0",
    "schema_version": "1",
    "project_root": "/repo",
    "store_dir": "/repo/.twining",
    "store_exists": true,
    "store_writable": true,
    "commands": [
      {
        "name": "twining_assemble",
        "surface": "default",
        "description": "Your FIRST call every session. …",
        "input_schema": { "type": "object", "properties": { "task": {…} } }
      }
    ]
  }
}
```

`capabilities` never creates a store and never writes anything — it is safe to
run in a read-only tree, which is exactly when `store_writable: false` is the
answer you need.

`surface` (`"default"` | `"full"`) says which **MCP tool surface** the command
appears on: `"full"` means an MCP peer sees it only with config
`tools.full_surface: true`, which hides 25 of the 41 commands.

`requires_mode: "full"` is the **second, independent** MCP gate — config
`tools.mode`. A `"lite"` install registers no lifecycle or graph tools at all,
whatever `full_surface` says, so `twining_status`, `twining_archive`,
`twining_add_entity`, `twining_add_relation`, `twining_neighbors`,
`twining_graph_query` and `twining_prune_graph` are absent there. The field is
omitted on commands both modes register.

**The CLI dispatches every command regardless of either gate** — they exist to
keep an LLM's tool list short, and a shell has no tool list. Both fields are
reported so you can tell why an MCP peer may not see a command you just ran.

## Store resolution

Identical to the server (`src/utils/project-root.ts`):

1. `--project <dir>` — verbatim, never redirected.
2. `TWINING_PROJECT` — resolved against the cwd, never redirected.
3. the cwd — and **only** on this branch, a linked git worktree redirects to
   its main checkout root, so worktree teammates share one store. Set
   `TWINING_WORKTREE_LOCAL=true` to opt out.

### `STORE_UNWRITABLE`

Before touching anything, the CLI checks that the resolved store is writable
(the `.twining` directory if it exists, otherwise the project root it would be
created in). If it is not, the command exits **1** with:

```json
{"ok":false,…,"error":{"code":"STORE_UNWRITABLE","message":"Twining store /main/.twining is unusable: /main is not writable by this process. …"}}
```

It never falls back to another store. Silently writing somewhere else would
split a project's coordination state in two without anyone noticing, which is
worse than a loud failure.

The common sandbox shape: you are inside a linked worktree, rule 3 redirects
to the main checkout, and the sandbox made the main checkout read-only. Two
fixes, both explicit:

```bash
TWINING_WORKTREE_LOCAL=true twining status   # keep a worktree-local store
twining status --project "$PWD"              # or name the target outright
```

## Offline behavior

A CLI invocation never reaches the network.

Twining's semantic search uses a local ONNX model (`Xenova/all-MiniLM-L6-v2`,
cached in `.twining/models/`). When that model is **not** already on disk, the
CLI does not try to download it — it goes straight to keyword search and says
so on stderr:

```
[twining] No local embedding model at /repo/.twining/models/Xenova/all-MiniLM-L6-v2 — using keyword search (offline mode: no download attempted).
```

Keyword search is the same fallback the server uses when ONNX is unavailable;
retrieval quality drops, nothing breaks. If the model *is* cached, the CLI uses
it, still with remote fetches disabled.

The CLI also skips the server's background work — the pending-queue drain and
its 60s timer, and the sqlite startup embedding reconcile — because a process
that exits in milliseconds must not start writes it cannot finish. The queue is
drained (at-least-once, idempotent) by the next server start; nothing is lost.

No dashboard is started, and no telemetry is initialized, on any CLI path.

## Codex sandbox notes

- **No network.** Covered above — the model is the only thing that would have
  wanted it.
- **`cwd` and `/tmp` are writable; a linked worktree's main checkout is not.**
  This is the `STORE_UNWRITABLE` case. Decide once, per session, whether you
  want a worktree-local store (`TWINING_WORKTREE_LOCAL=true`) or an explicit
  `--project`, and export it.
- **A plugin cannot put a command on `PATH`.** Install the npm package and call
  it through `npx twining …`, or install globally.
- **Enterprise allowlists match exact command identity.** `npx twining …` and
  `twining …` are stable, greppable command identities; a stdio MCP server
  spawned by a host is not.

## Gates from a shell

Both Twining lifecycle gates work exactly as they do over MCP:

```bash
# Gate 1 — before reading code or making changes
twining assemble --json '{"task":"add rate limiting","scope":"src/api/"}'
twining why --json '{"scope":"src/api/limiter.ts"}'

# during the work
twining post --json '{"entry_type":"finding","summary":"limiter shares the auth cache"}'

# Gate 2 — before committing or ending
twining record --json '{
  "summary":"Added a token-bucket limiter to the API edge",
  "decisions":["Chose token bucket over sliding window — bursty traffic"],
  "findings":["warning: limiter shares the auth cache"],
  "affected_files":["src/api/limiter.ts"]
}'
```

`twining_record`, `twining_post` and `twining_decide` refresh
`.twining/.last-record` from the CLI just as they do over MCP, so the
pre-commit hook's Gate 2 check is satisfied either way.

## Calling it from hooks

Hooks are shell scripts, which makes the CLI the natural fit — a hook no
longer needs a running server to record something.

```bash
#!/usr/bin/env bash
# Best-effort: a hook must never fail the operation it observes.
twining post \
  --project "$CLAUDE_PROJECT_DIR" \
  --agent-id "stop-hook" \
  --json "$(printf '{"entry_type":"status","summary":%s}' "$(jq -Rn --arg s "$SUMMARY" '$s')")" \
  >/dev/null 2>&1 || true
```

Three things to get right:

1. **Pass `--project` explicitly.** A hook's cwd is not reliably the project
   root, and the worktree redirect only applies to the cwd branch.
2. **Build the JSON with a tool, not string concatenation.** `jq -Rn` (above)
   or `--input-file` with a temp file; summaries contain quotes and newlines.
3. **Decide what a failure means.** `|| true` if the hook must not block;
   otherwise read the exit code — `2` means the hook itself is wrong and will
   never work, `1` means Twining refused this particular call.

## Differences from the MCP server

Small, and all deliberate:

| | MCP server | CLI |
| --- | --- | --- |
| tool/command surface | `tools.full_surface` hides 25 of 41 commands; `tools.mode: "lite"` hides 7 more | every command dispatchable; `surface` + `requires_mode` reported in `capabilities` |
| embedding model | downloads on first use if absent | never downloads; keyword fallback |
| pending-queue drain | on startup + every 60s | skipped (left to the server) |
| dashboard, telemetry | started / initialized | never |
| `TWINING_DISABLED=true` | server exits 0 immediately | ignored — a CLI call is a deliberate act, like `migrate` |
| quality nudge | once per server session | once per process, i.e. potentially once per invocation |

`config.tools.full_surface` still gates provisional minting inside
`twining_record` on both fronts — that is a behavior gate, not a surface gate.

---

## v3 verbs (lane 03, foundation programme)

These verbs exist only in the `twining` CLI. They are **not** command-registry
commands and therefore not MCP tools, and that is deliberate:

- **`twining rule` must be unreachable from a dispatcher.** The signing ceremony
  is the only producer of a `human_ruling` (ADR §2.3). Registering it as a
  command and refusing at runtime would leave the capability one forgotten guard
  away from being real; making it CLI-native means there is no code path from an
  MCP peer to a ruling at all.
- **`identity`, `sync` and `doctor` are operator verbs** about this machine and
  this store, not about the project's records. Key management does not belong on
  an LLM's tool list.
- **`events` is a raw log reader.** The retrieval surface is lane 04's.

Every verb prints the usual one-line JSON envelope on stdout, except `hook`
(below), whose stdout belongs to the host.

### `twining identity init [--human] [--label <name>]`

Mints this machine's **host key** (`~/.twining/identity/host/host.json`, mode
0600) if absent, and creates or upgrades `.twining/store.json` to format 3.
Idempotent: a second run keeps the existing `store_id` — events already cite it.

`--human` additionally mints a **human principal** whose private key is
passphrase-encrypted (PKCS8 + aes-256-cbc) under
`~/.twining/identity/human-<p_…>/key.json`. The passphrase is read from the TTY,
or from `TWINING_HUMAN_PASSPHRASE` for automated qualification runs. There is no
unprotected form. A key shorter than 8 characters is refused rather than written.

`TWINING_IDENTITY_HOME` overrides the identity directory (used by tests so a run
never touches your real keys).

### `twining rule --scope <path> --statement <text> [--cites <ids>] [--grants <principal:role>] [--requirements <k=v>]`

The ruling ceremony. Refuses, in this order, when:

| Refusal | Code |
|---|---|
| invoked through the command registry | `REGISTRY_INVOCATION` |
| `TWINING_AGENT_CONTEXT` is set | `AGENT_CONTEXT` |
| stdin is not a TTY | `NOT_A_TTY` |
| the store is not on format 3 | `STORE_NOT_V3` |
| this machine holds no human key | `NO_HUMAN_KEY` |

On success it signs a `ruling` event **with the human key** (never the host key)
and appends it through the `ceremony` ingress — the only ingress whose allowed
class set contains `human_ruling`.

The first ceremony on a store with no membership policy also writes the
bootstrap `membership` that makes that human key the store's root of trust
(ADR §7). Later ceremonies find the policy already there and change nothing:
"the bootstrap key is the root of trust" must not quietly become "whoever runs
the ceremony becomes the root of trust".

An automated run produces rulings by calling `appendRuling()` with a fixture
human key — never by faking a TTY.

### `twining events ls [--limit <n>] [--kind <k>] [--record <id>]` / `twining events show <id>`

Reads the admitted event log. `show` distinguishes **not admitted** from **not
here**: an event present on disk but quarantined reports its delivery state and
reason rather than "not found".

### `twining sync [--remote <name>] [--path <dir>]`

Flushes the outbox and pulls the inbox through a `Transport`. It prefers lane
02's `src/exchange/git-transport.ts` when that module exists and otherwise wires
the fs carrier, reporting which one it used in `carrier`.

`published.uncertain` is reported separately from success and failure. After a
lost receipt the producer does not know whether the bytes landed, and saying so
is the only honest answer; the next flush retries the identical event ids, never
new ones.

### `twining doctor`

Active bindings (project root, store dir, **and separately** the producing
checkout's branch/commit — those are different things and are never inferred
from one another), identity (key **ids** only; no key material, ever), capture
coverage per host, installed hook provenance, and journal counts.

Its `honest_limits` array says what the numbers do *not* mean — notably that
coverage describes what the adapter captures, not that a host is installed.

### `twining hook <claude-code|codex> <EventName>`

The shim the shell hooks call. Reads the host's event JSON on stdin and prints
the host's response JSON on stdout — **not** a Twining envelope, because stdout
here is the host's channel. **Always exits 0**: a memory layer that breaks the
user's turn because its own store was unwritable has made itself the problem.

Two honest caveats about what "does nothing" means here:

- **The host key is minted on first invocation regardless of store format.**
  `openRuntime` calls `ensureHostIdentity` before it checks the format, so the
  first hook event on any store creates `~/.twining/identity/host/host.json`.
  Nothing is written to the *project* on a 2.x store, and no events are
  produced, but the machine-level key file does appear.
- **`SessionStart` still emits the 2.x gate context on a non-v3 store.** That is
  deliberate (on 2.x the gates are the whole capture mechanism), but it means
  the verb is not silent there. It is silent for every other event, and the
  `plugin/hooks/v3-capture-hook.sh` shim exits before calling the CLI at all
  unless `.twining/store.json` says `"format": 3` — so in the shipped hook
  configuration the 2.x path is untouched.
