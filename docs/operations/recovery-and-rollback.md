# Recovery and rollback — operator guide

Covers: bootstrapping a v3 store, what runs without a human, scope behaviour, the alert surface, upgrading a 2.x store with `migrate --to 3`, recovery, rollback and erasure. Describes `foundation/v3` at **`0f9fd985`** (server version string `2.16.1`). Behavioural statements were run at that commit with `TWINING_OFFLINE=1` on scratch stores and quote the command and trimmed output (`…` marks a cut). Two exceptions were **not run at this commit** and are labelled where they appear: §5.5 and K23 (the old 2.16.1 bundle reaches the network even with `TWINING_OFFLINE=1`, so it was not run again). Statements labelled **(from source, not a run)** are code readings; **UNAVAILABLE** / **NOT VERIFIED** items give the reason. Ids, timestamps, ports, counts on the large store and durations differ on every run.

`twining` is the CLI (`dist/cli/twining.js`); `twining-mcp` is the server binary (`dist/index.js`) with subcommands `migrate`, `rollback`, `migrate-status`, `events ls|show`, `validate-records`. `<dir>` is a project; its store is `<dir>/.twining`.

## Known defects and limits at this commit

| # | What the operator sees | Reproduction | Impact | Workaround |
| --- | --- | --- | --- | --- |
| K1 | After a completed `migrate --to 3`, every write from the same build fails `FORMAT_VERSION_TOO_NEW` | §5.1 | A migrated store is read-only to the build that migrated it (`SUPPORTED_CONFIG_VERSION = 2`, `src/config.ts:15`, from source) | Bootstrap with `identity init` (§1) for a writable v3 store |
| K2 | `migrate --to 3` on a large legacy store with non-ULID hook-era ids exits 1 `VERIFICATION FAILED`, store left `incomplete` | §5.4 | Cannot finalize; the dry run does not predict it | None; the store stays a writable 2.x store, nothing lost |
| K3 | `twining events ls` on an `incomplete` migration answers `STORE_ROLLED_BACK` | §5.4 | Wrong message | `twining-mcp events ls`, `twining-mcp migrate-status` |
| K4 | `doctor` on an `incomplete` migration: `v3_enabled:false`, `events:null` beside thousands of event files | §5.4 | Hides the half-migrated state | `twining-mcp migrate-status` |
| K5 | `sync --remote origin` reports success but publishes into `<store>/exchange-fs`; nothing reaches the remote | §6.2 | No exchange over git | `sync --path` (but see K6) |
| K6 | Events from another replica stay `quarantined / signature_required` and never reach `read`/`assemble` | §6.3 | Exchange delivers bytes, not records | None; no verb trusts a peer key |
| K7 | Deleting `store/events.db` empties the admitted view; nothing re-journals the files | §6.1 | Not recoverable at the operator surface | Restore the file from backup |
| K8 | After `rollback --to 2`, `twining post` still writes a v3 event and the re-upgrade adds a legacy copy | §7.2 | One write, two v3 records | None |
| K9 | `migrate --to 3` on an identity-init store re-imports the mirror's `records/`: each earlier write exists as a `proposal` and a `legacy_unverified` event | §5.2 | Duplicates; then K1 | Do not migrate an identity-init store |
| K10 | Assemble `selection.repo` is `r_49c0eb9a6e072f6f8bcfb5f99d` on every store | §3.2 | Packet does not carry the store's repo id | None |
| K11 | `assemble`/`why` label signed native events `legacy_unverified` | §3.2 | Wrong trust class in the packet | `twining events show <id>` |
| K12 | The id `twining post` returns is not the event id; `events show <2.x id>` → `NOT_ADMITTED` | §3.2 | Two identities per write | Find the event with `twining-mcp events ls` |
| K13 | Event `source` and `doctor.bindings.source` follow the process cwd, not `--project` | §3.2 | Provenance names the wrong checkout | Run with the project as cwd |
| K14 | `doctor.hooks` rows depend on the cwd; doctor cannot see the installed plugin lacks v3 capture hooks | §1.3 | Hooks report is not about the project | Run from the project; read the plugin's `hooks.json` |
| K15 | `SessionStart(source=compact)` in the same session injects nothing | §2.2 | Restart after compaction carries no working set (shim; host NOT VERIFIED) | Next `UserPromptSubmit` injects the delta |
| K16 | A `codex Stop` receipt is on disk but never admitted; after a migration it is `quarantined / signature_required` | §2.2, §5.2 | `events_held` exceeds `admitted` by one | None |
| K17 | `twining dismiss` writes no v3 event | §8 | Log and 2.x view diverge | None |
| K18 | `twining-mcp --help` starts the MCP server and creates a full 2.x `.twining/` (`config.yml`, `twining.db`, `blackboard.jsonl`, …) in the cwd | §0 | No help; an unwanted 2.x store appears wherever it was typed | `twining --help` (writes nothing) |
| K19 | `twining-mcp events --project <dir> ls` silently reads the cwd | §0 | Wrong store | Put `--project` after the subcommand |
| K20 | `exchange_status.migration.state` is always `"unknown"` | §4 | Not a migration alert | `twining-mcp migrate-status` |
| K21 | `"mode":"lessons"` in `assemble` is accepted and ignored | §3.1 | `lessons` unreachable | None |
| K22 | `records/RECORDS-FROZEN.md` names `.twining/store/twining.db`; the file is `.twining/twining.db` | §5.1 | Misleading text | Ignore that path |
| K23 | The committed pre-v3 bundle ignores `TWINING_OFFLINE`, downloads the model; a truncated download breaks the new CLI's embedding init (not run at `0f9fd985`, §5.5) | §5.5 | Network egress from the old client | Do not run it where egress is forbidden |
| K24 | No tombstone, purge, forget or key-trust verb | §8 | Erasure and trust are store API only | None |
| K25 | The generated `.gitignore` covers only `records/**/*.tmp`, not `events/**/*.tmp`. A `kill -9` during `migrate` *can* leave `events/**/<id>.json.<pid>.<rand>.tmp` if it lands mid-write (timing-dependent; kills at 1 s and 3 s left none, §5.3) and resume does not remove one | §5.3 | If a temp file is left, the suggested `git add .twining/events` commits it | After any interrupted migration run `find .twining/events -name '*.tmp'` and delete hits before committing |
| K26 | The real migration of a ~30 MB legacy store takes minutes to over an hour, while the dry run takes under a second; measured 751 s alone, 1178–1180 s with three migrations sharing the machine, and up to about 73 min in an earlier run | §5.4 | Long write window, duration not predicted by the dry run | Plan for it; run it alone |

**Fixed in `0f9fd985`:** `migrate --to 3` after `identity init` no longer replaces the store and repo ids or quarantines the store's own native events (§5.2); `migrate-status` on an identity-init store reports the declared `repo_id` (was `null`); `doctor` reports `repo_ids_cited` / `repo_ids_undeclared` (§4); the hook working set no longer lists the hooks' bookkeeping observations (§2.2).

## 0. The surface

```
$ twining --help
usage: twining <command> [--json '<json>' | --input-file <f> | --stdin]
                        [--project <dir>] [--agent-id <id>]
       twining identity init [--human] [--label <name>]
       twining events ls [--limit <n>] [--kind <k>] | twining events show <id>
       twining sync [--remote <name>] [--path <dir>]
       twining doctor
       twining hook <claude-code|codex> <EventName>       (hook shim; reads stdin)
       twining migrate [--project <dir>] [--dry-run] [--check] [--reverse] [--to 3]
       twining rollback --to 2 [--project <dir>] [--dry-run]
       twining migrate-status [--project <dir>]
       …
Every command prints ONE JSON envelope on stdout; diagnostics go to stderr.
Exit codes: 0 ok, 1 command error, 2 usage / unknown command / bad input.
```

Gotchas (each run; `twining capabilities` lists 41 commands):

```
$ twining capabilities --json            # exit 2: "unknown option \"--json\""
$ twining events --project <dir> show x  # v3 store: exit 2 "USAGE": twining events: usage: twining events ls|show
                                         # store without an event log: exit 1 "STORE_NOT_V3": this store has no event log — run `twining identity init` to create one
$ twining-mcp events --project <dir> ls  # exit 2, cwd used: events: no .twining/events/ directory — this store is not on v3
$ twining status --exchange              # "code":"USAGE","message":"unknown option \"--exchange\""
$ twining-mcp --help </dev/null          # exit 0 at stdin EOF; it started the server: stderr [twining] Dashboard: http://127.0.0.1:<port>
$ ls -A .twining                         # empty cwd before, K18 (`twining capabilities` leaves it empty): .gitattributes .gitignore agents archive blackboard.jsonl config.yml decisions embeddings graph handoffs twining.db
$ twining-mcp migrate --to 3 --check     # exit 2: --check is not supported with --to 3 (use `twining-mcp migrate-status`)
```

Two readers: `twining events ls|show` reads **admitted** events from the derived journal; `twining-mcp events ls|show` lists the **files** under `.twining/events/`. On disk → `twining-mcp events`; admitted → `twining events`; why not → `exchange_status`.

## 1. Setup and bootstrap

### 1.1 Identity-init bootstrap (the writable v3 path)

```
$ TWINING_IDENTITY_HOME=<home> twining identity init --project <dir>
{"ok":true,…,"result":{"identity_home":"<home>","host":{"host_id":"h_…","principal_id":"p_…","key_id":"k_…",…},
 "store":{"store_id":"s_01M497J8Z3GF2H26TH15WDSM6V","repo_id":"r_01M497J8Z3GF2H26TH15WDSM6T","format":3,"created":true,…}}
$ cat <dir>/.twining/store.json
{"store_id":"s_01M497J8Z3GF2H26TH15WDSM6V","repo_ids":["r_01M497J8Z3GF2H26TH15WDSM6T"],"format":3,"created_at":"…"}
$ ls -A <dir>/.twining
store.json
$ twining post --project <dir> --json '{"entry_type":"finding","summary":"AUTH-FINDING jwt","scope":"src/auth/"}'
{"ok":true,…,"result":{"id":"01M497J9263NA2H6B8PR9SX4W5",…}}
$ ls -A <dir>/.twining; ls <dir>/.twining/store
.gitignore .last-record cursors events records store store.json twining.db
events.db receipts.jsonl
```

`adapters/` (hook session cursors, §2.2) appears only after the first hook runs.

There is no `config.yml`, so the store stays writable. The generated `.gitignore` lists `embeddings/*.index archive/ models/ metrics.jsonl pending-posts.jsonl pending-actions.jsonl .last-record .last-known-branches.json .sessions/ twining.db twining.db-wal twining.db-shm records/**/*.tmp store/ exchange/`; commit `events/`, `cursors/`, `attachments/` and `store.json`.

A human key:
```
$ TWINING_HUMAN_PASSPHRASE=short twining identity init --human --label ops --project <dir>   # exit 1, "code":"PASSPHRASE_REQUIRED"
$ TWINING_HUMAN_PASSPHRASE='<8+ chars>' twining identity init --human --label ops --project <dir>   # exit 0
$ … | jq -c '.result|keys'     → ["host","human","humans","identity_home","store"]
$ … | jq -c '.result.human'    → {"principal_id":"p_…","key_id":"k_…","label":"ops","file":"<home>/human-p_…/key.json","note":"this key is the roo…"}
```

The output carries ids, label, file path and a note. The key files (`<home>/host/host.json`, `<home>/human-<principal>/key.json`) hold `private_key`/`public_key`/`encrypted_private_key`; none of those values appears in the stdout or stderr of either command (checked with `grep -F` per value).

### 1.2 Store layout

Durable: `events/**` (immutable event files), `attachments/` (legacy bytes, after a migration), `store.json`. Derived: `store/events.db` (journal) beside `store/receipts.jsonl`, and `twining.db` (2.x sqlite, top level). There is no `.twining/events.db`. A migration adds `legacy/{manifest,id-map,migration-state}.json`, `records/RECORDS-FROZEN.md` and `config.yml` `version: 3` (+ `.pre-migrate.bak`).

### 1.3 Hooks provenance — `doctor` reports the cwd's hooks (K14)

```
$ cd <this repository> && twining doctor --project <scratch> | jq -c '[.result.hooks[]|{scope,mentions_twining}]'
[{"scope":"project","mentions_twining":true},{"scope":"user","mentions_twining":true},{"scope":"codex-user","mentions_twining":false}]
$ cd <non-git dir> && twining doctor --project <scratch> | jq -c '[.result.hooks[].scope]'
["user","codex-user"]
$ ls ~/.claude/plugins/twining
ls: /Users/<user>/.claude/plugins/twining: No such file or directory
$ grep -c v3-capture-hook ~/.claude/plugins/cache/twining-marketplace/twining/1.34.1/hooks/hooks.json
0
```

(From source, not a run:) `project`/`codex-repo` candidates are `path.join(process.cwd(), …)` and the `plugin` candidate is `~/.claude/plugins/twining/hooks/hooks.json` (`src/cli/v3-verbs.ts`), not the plugin cache where the plugin is actually installed.

## 2. Automation boundaries — what runs without a human

### 2.1 What the tree's plugin registers (from source, not a run)

`plugin/hooks/hooks.json` registers `v3-capture-hook.sh claude-code <Event>` on `SessionStart` (`startup|resume|clear|compact|fork`), `UserPromptSubmit`, `PreCompact`, `SubagentStart`, `SubagentStop`, `Stop`, `SessionEnd`, beside the 2.x hooks. No Codex carrier exists under `plugin/`. Host tables: `hosts-claude-code-capabilities.md`, `hosts-codex-capabilities.md` (pinned by `test/adapters/host-matrix-docs.test.ts`).

### 2.2 What the shim does on a seeded store (not a host)

Seed: two posts and two decisions on an identity-init store; payloads piped into `twining hook` with `TWINING_SESSION_ID` set, cwd = project.

```
$ echo '{"session_id":"op-s1","hook_event_name":"SessionStart","source":"startup"}' | twining hook claude-code SessionStart
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"## Twining — working set for this scope\n\n
- [proposal] seed2\n  scope: src/authz\n  why: Chose RBAC over ABAC for src/authz/ — simpler\n  (does not authorize action on its own)\n
- [proposal] seed … - [proposal] warning: AUTHZ-WARNING rbac … - [proposal] finding: AUTH-FINDING jwt …\n\n
Evidence class is stated per item and is NOT changed by the wording of the item. Only a RULING carries human authority; everything else is a claim."}}
$ … UserPromptSubmit "hello from operator"   → "## Twining — new since your last injected context\n\n- [human statement] status: hello from operator\n  scope: session:op-s1 …"
$ … PreCompact trigger=auto                   → stderr: [twining] PreCompact cannot inject context on this host — additionalContext is discarded. Re-seeding rides SessionStart(source=compact).
$ … SessionStart source=compact (same session) → stderr: [twining] nothing to inject: the working set for this scope is empty
$ … SessionStart source=compact (new session)  → full working set, 5 items (the human statement + 4 proposals)
$ … codex Stop                                 → stderr: [twining] codex Stop cannot inject context (no additionalContext member in its output schema); …
$ twining-mcp events ls | awk '{print $2,$3,$5}' | sort | uniq -c
   2 created decision proposal
   4 created observation verified_observation
   1 created post human_statement
   2 created post proposal
   4 receipt - proposal
$ twining exchange_status → "events_held":13,"admitted":12 … "quarantined":{"count":0,…}
```

The hooks' own observations are written but no longer listed as items (fixed in `0f9fd985`). The 13th, unadmitted file is the `codex Stop` receipt (K16). A continuation `SessionStart` re-seeds only the delta after the cursor's `last_injected_event` (`.twining/adapters/sessions/<session>.json`); a new session gets the full set. Re-injection after compaction therefore rides `UserPromptSubmit`, not `SessionStart(compact)` (K15).

### 2.3 Real-host proof — UNAVAILABLE

Claude Code: the installed plugin (1.34.1) has no v3 capture hook (§1.3) and no real Claude Code session ran these hooks; installing the tree's plugin is the owner's action. Codex: no Codex real host here; `hosts-codex-capabilities.md` records real-host status NOT VERIFIED (hooks need interactive trust). Every result in §2.2 is a shim result.

## 3. Scope behaviour

### 3.1 What each scope sees

```
$ twining assemble --json '{"task":"audit scope","scope":"src/auth/"}' | jq -c '.result.retrieval.selection|{repo,repo_identity_source,suppressed,mode}'
{"repo":"r_49c0eb9a6e072f6f8bcfb5f99d","repo_identity_source":"derived-from-path","suppressed":{"out_of_query_scope":3},"mode":"strict"}
$ … "scope":"src/authz/"  → "suppressed":{"out_of_query_scope":3}
$ … "scope":"src/"        → "suppressed":{}, decisions_count 2
$ … "scope":"src/auth/","mode":"lessons"  → "ok":true, "mode":"strict", emitted_bytes_sha256 identical to the call without "mode"
```

`src/auth` and `src/authz` never see each other (segment boundaries). Scope denials appear only in `selection.suppressed`, not in `exchange_status`. `lessons` is not passed through until an entitlement source exists (`src/core/commands/context.ts`, from source, not a run). Offline the packet still says `versions.index:"embeddings/1"` while stderr says `No local embedding model … using keyword search`; only `token_usage.conservative_fallback:true` tells you.

### 3.2 Identity in the read path (K10–K13)

- **Repo id.** `store.json` declares `r_01M497J8Z3GF2H26TH15WDSM6T`; the packet says `r_49c0eb9a6e072f6f8bcfb5f99d`, on every store, before and after a migration. `printf 'instance:0' | shasum -a 256 | cut -c1-26` → `49c0eb9a6e072f6f8bcfb5f99d`. (From source, not a run:) the CLI builds its `ContextAssembler` without a store directory (`src/core/context.ts:241`), so `src/engine/context-assembler.ts:273` uses `deriveRepoId("instance:<n>")`; the `0f9fd985` change to `src/retrieval/store-identity.ts` is not on this path. **Still reproduces.**
- **Trust class.** The packet says `lifecycle_resolver:"legacy-status-field"`, `trust.evidence_class:"legacy_unverified"`; the briefing reads `_Evidence class: legacy_unverified — Migrated from a 2.x store with no authorship proof. …_` although nothing was migrated and the events are signed `proposal`s.
- **Two ids per write.**
  ```
  $ twining post …                                   → "id":"01M49A8N5EN50ZS4TWYJ02GK9G"
  $ twining-mcp events ls                            → 01M49A8N6CQ7CS61WFV8WXSYBY  created  post … proposal
  $ twining events show 01M49A8N5EN50ZS4TWYJ02GK9G   → "code":"NOT_ADMITTED","message":"no event 01M49A8N5EN50ZS4TWYJ02GK9G in this store"
  ```
- **Provenance follows the cwd.** Same `--project`:
  ```
  $ cd <this repository> && twining doctor --project <scratch> | jq -c '.result.bindings.source|keys'
  ["branch","commit","dirty","repo","worktree"]      # this repository's HEAD, not the project's
  $ cd <non-git dir> && twining doctor --project <scratch> | jq -c '.result.bindings.source|keys'
  ["repo","worktree"]
  ```

## 4. Troubleshooting and the alert surface

| Question | Run | Answer |
| --- | --- | --- |
| Is the event on disk? | `twining-mcp events ls\|show <id> --project <dir>` | file listing / raw envelope; migrated rows flagged `legacy id-mapped` |
| Is it admitted; why not? | `twining events show <id> --project <dir>` | envelope + `delivery` + `admission_log`, or exit 1 `NOT_ADMITTED`, e.g. `event 01M498Q9… exists in state "quarantined" (signature_required) but is not admitted` |
| Queue, quarantine, gaps | `twining exchange_status [--json '{"include_ids":true}']` | below |
| Migration state | `twining migrate_status` / `twining-mcp migrate-status` | below |
| Store identity, hooks | `twining doctor --project <dir>` | below |
| Derived index wrong | — | no operator rebuild (§6.1) |

`exchange_status` after four writes, before any hook ran:

```
{"store":{"events_held":4,"admitted":0,"projected":0,"checkout":"ok"},"outbox":{"depth":4,"oldest_pending_age_ms":476,…,"by_transport":[]},
 "rejected":{"count":0,…},"quarantined":{"count":0,"retryable":0,"by_reason":{}},…,"gaps":[],"revoked_credentials":[],
 "migration":{"state":"unknown","note":"migration state is owned by the migrate/rollback lane; …"}}
```

CLI writes are journaled but admitted only when a hook runs (`twining events ls` → `total 0`; `twining-mcp events ls` → 4 files). `migration.state` is always `"unknown"` (K20); `by_transport` fills after a `sync`; foreign events land in `quarantined.by_reason` (§6.3).

`migrate_status` on an identity-init store (the `twining-mcp` form has the same fields without `next_command` and `rolled_back`):

```
{"format":3,"migration":"not_started","completed_steps":[],"remaining_steps":["manifest","events","idmap","verify","finalize"],
 "store_id":"s_01M497J8Z3…","repo_id":"r_01M497J8Z3…","events":4,…,"next_command":"twining migrate --to 3 --dry-run   (writes legacy/manifest.json and nothing else)"}
```

Do not follow that `next_command` on an identity-init store (K9). Other values: `twining migrate --to 3   (resume: the interrupted run left config.version unchanged)` when `incomplete`; `twining migrate --to 3   (re-upgrade; post-rollback writes are preserved)` when `rolled_back`.

`doctor` (new fields at `0f9fd985`):

```
$ twining doctor --project <dir> | jq -c '.result.bindings|{store_format,repo_ids,repo_ids_cited,repo_ids_undeclared,v3_enabled}', '.result.events'
{"store_format":3,"repo_ids":["r_01M497J8Z3…"],"repo_ids_cited":["r_01M497J8Z3…"],"repo_ids_undeclared":[],"v3_enabled":true}
{"total":4,"admitted":0,"quarantined":0,"rejected":0}
```

Non-empty `repo_ids_undeclared` marks a store a pre-`0f9fd985` build migrated after `identity init`; a rerun does not heal it and the repair is a deliberate edit of `store.json` and `legacy/migration-state.json` (from source, not a run; no such store was produced here). With no store, `doctor` says `store_format "2 (no store.json)"`, `events:null`.

Not reproduced: an event whose parent was rejected settles `rejected / unsatisfiable_parent` per `test/exchange/admission-trust.test.ts` ("R14 …") and `delivery.conflict_rejected` per `test/acceptance/cases/c18.test.ts` — **NOT VERIFIED** (need a two-replica scenario).

Log hygiene: the host `private_key`/`public_key` values and the human `public_key`/`encrypted_private_key` values do not appear in the stdout/stderr of `identity init` (host and human, failed and successful) nor, for three replicas' host private keys, in the `sync --path` output or the shared directory (§6.3); the passphrase does not appear either. Other commands' output was not audited for key material.

## 5. Upgrades — `migrate --to 3`

### 5.1 Small clean 2.x store

Built with the CLI, no `identity init`: 3 posts and 1 record.

```
$ twining-mcp migrate-status --project <dir> | jq -c '{format,migration}'
{"format":1,"migration":"not_started"}
$ twining-mcp migrate --project <dir> --to 3 --dry-run          # exit 0
  legacy files: 10  records: 6  created: 0  derived: 0  rivals: 0  damaged: 0  conflicts: 0
  note: dry run: legacy/manifest.json written; no events, no config change
$ twining-mcp migrate --project <dir> --to 3                    # exit 0, about a second
  legacy files: 10  records: 6  created: 6  derived: 0  rivals: 0  damaged: 0  conflicts: 0
  note: legacy files were not modified — they remain their own backup
  note: records/ is frozen (records/RECORDS-FROZEN.md); the authority is events/ + attachments/
  Next steps (nothing has been committed for you):
    git add .twining/events .twining/attachments .twining/legacy .twining/store.json .twining/config.yml .twining/records/RECORDS-FROZEN.md
    git commit -m "chore: migrate .twining to the v3 event store"
  Teammates on 2.x go READ-ONLY on this store until they update.
$ twining-mcp migrate-status --project <dir>
{"format":3,"migration":"complete",…,"events":6,"attachments":6,"legacy_records":6,"id_map_entries":6,"records_frozen":true}
$ twining-mcp migrate --project <dir> --to 3      →  already present (id+digest match, no new effect): 6
$ grep -o '`.twining/store/twining.db`' .twining/records/RECORDS-FROZEN.md   →  `.twining/store/twining.db`   (K22)
$ twining post --project <dir> --json '{…}'       # exit 1 (K1)
[twining] .twining/ format version 3 is newer than this twining-mcp release supports (2). … Reads still work; writes are refused to prevent divergence.
{"ok":false,…,"error":{"code":"FORMAT_VERSION_TOO_NEW",…}}
```

`twining read` and `doctor` still work. Migrated events carry `attachments[]` and a `legacy` block, visible with `twining-mcp events show <id>`.

### 5.2 An identity-init store — do not migrate it (K9)

On the §2.2 store (13 event files):

```
$ twining-mcp migrate --project <dir> --to 3 --dry-run   →  legacy files: 8  records: 8  created: 0 …
$ twining-mcp migrate --project <dir> --to 3             →  exit 0, legacy files: 8  records: 8  created: 8 …
$ jq -c . .twining/store.json
{"store_id":"s_01M497J8Z3GF2H26TH15WDSM6V","repo_id":"r_01M497J8Z3GF2H26TH15WDSM6T","repo_ids":["r_01M497J8Z3GF2H26TH15WDSM6T"],"format":3,"created_at":"<init time>","migrated_from":2}
$ grep -rhoE '"repo": ?"r_[A-Za-z0-9]+"' .twining/events | sort | uniq -c
  34 "repo": "r_01M497J8Z3GF2H26TH15WDSM6T"
$ twining-mcp events ls | awk '{print $2,$3,$5,$6,$7}' | sort | uniq -c
   2 created decision legacy_unverified legacy id-mapped
   2 created decision proposal
   2 created entity legacy_unverified legacy id-mapped
   4 created post legacy_unverified legacy id-mapped
   2 created post proposal
   …
$ twining exchange_status → "events_held":21,"admitted":20 … "quarantined":{"count":1,"retryable":1,"by_reason":{"signature_required":1}}
```

**Fixed in `0f9fd985`:** both ids are kept and the native `proposal` events stay admitted; `doctor` shows `repo_ids_undeclared: []`. The one quarantined event is the `codex Stop` receipt that was never admitted before (K16). **Still reproducing:** each earlier post and decision now also exists as a legacy copy, `config.yml` becomes `version: 3`, and the next `twining post` is refused `FORMAT_VERSION_TOO_NEW`.

### 5.3 Interrupt and resume

Two more copies of the §5.4 store, each killed with `kill -9` early in the real run (1 s and 3 s):

```
$ twining-mcp migrate --project <dir> --to 3 & sleep 3; kill -9 $!   → exit 137
$ find .twining -name '*.tmp' | wc -l                                 → 0      (also 0 for the 1 s kill)
$ twining-mcp migrate-status | jq -c '{migration,completed_steps,events,attachments,id_map_entries}'
{"migration":"incomplete","completed_steps":[],"events":155,"attachments":154,"id_map_entries":0}     # 1 s kill: 11 / 10
$ twining-mcp migrate --project <dir> --to 3                         # resume, exit 1
  already present (id+digest match, no new effect): 154              # 1 s kill: 10
  note: VERIFICATION FAILED — config.version was NOT changed; nothing is frozen
$ twining-mcp migrate-status → {"migration":"incomplete","completed_steps":["manifest","events","idmap","verify"],"events":18577,"attachments":11003,"id_map_entries":11003}
$ diff <(cd uninterrupted/.twining/events && find . -type f | sort) <(cd resumed/.twining/events && find . -type f | sort)   # no output, both kills
$ find resumed/.twining -name '*.tmp' | wc -l                        → 0
```

The counts at the kill depend on timing. Resume produces the same event file names and counts as the uninterrupted run and stops at the same verification failure. File bytes differ between copies because each store gets its own migration host, principal and repo ids (and so its own digests). A kill that lands mid-write can leave a temp file that is not git-ignored (K25), so check with `find .twining/events -name '*.tmp'` before committing. The kill-at-each-durable-step harness is `test/migrate/v3-forward.test.ts` (with `test/migrate/kill-harness.ts`), cited by `test/acceptance/cases/c21.test.ts` "A-INT-01/A-INT-02 …" and "A-INT-03 idempotent rerun". **Tests only** for kills at specific durable steps; no operator command targets a step.

### 5.4 Large legacy store with non-ULID hook-era ids

A copy of a long-lived 2.x store (~30 MB without models, embeddings and sqlite; v1 + v2 layouts, ~6,000 `records/` files, 171 decisions, a 384-line `blackboard.jsonl`, 1.x hook-era ids such as `hook-1772306420555`):

```
$ twining-mcp migrate-status → {"format":1,"migration":"not_started"}
$ twining-mcp migrate --project <dir> --to 3 --dry-run                  # exit 0, under a second
  legacy files: 6426  records: 9813  created: 0  derived: 0  rivals: 1510  damaged: 0  conflicts: 1510
  finding: conflict:duplicate_declared_id 01KHMSD2TJ… — declared by graph/entities.json, records/graph/entities/01KHMSD2TJ….json with different bytes
$ twining-mcp migrate --project <dir> --to 3                            # exit 1 after 751 s, the only process running (K26)
  legacy files: 6426  records: 9813  created: 11003  derived: 7574  rivals: 1510  damaged: 0  conflicts: 1510
  finding: rejected:schema hook-1772306420555 — id: expected a ULID
  …   missing: hook-1772306420555   …   attachment: hook-1772306420555:absent
  note: VERIFICATION FAILED — config.version was NOT changed; nothing is frozen
$ … | grep -oE '(ambiguity|conflict|rejected):[a-z_]+' | sort | uniq -c
3572 ambiguity:archived_by_legacy_archiver
1510 conflict:duplicate_declared_id
 877 rejected:schema          # id ×320, record.id ×438, parents.1 ×119: "expected a ULID"; 20 missing, 20 attachment …:absent
$ twining-mcp migrate-status
{"format":1,"migration":"incomplete","completed_steps":["manifest","events","idmap","verify"],"remaining_steps":["finalize"],"store_id":null,"repo_id":null,"events":18577,"attachments":11003,…}
$ ls .twining/store.json; grep version .twining/config.yml
ls: …/store.json: No such file or directory
version: 2
$ twining events ls                                                     # K3
{"ok":false,…,"error":{"code":"STORE_ROLLED_BACK","message":"this store is rolled back to v2; its retained event archive is readable with `twining-mcp events ls` …"}}
$ twining doctor | jq -c '.result.bindings.store_format, .result.bindings.v3_enabled, .result.events'    # K4
"2 (no store.json)"  false  null
$ twining-mcp events ls | tail -1 → # 18577 event file(s) under .twining/events/
$ twining post …  → "ok":true                     # still a writable 2.x store
$ twining-mcp rollback --to 2 --dry-run  → exit 2: rollback: this store is not on v3 (no completed migration) — nothing to roll back
```

Counts grow with the source store; these are from one copy. The dry run reports no schema rejections; only the real run finds them (K2). Legacy files are untouched. A rerun after the complete failed run is idempotent and fails the same way:

```
$ twining-mcp migrate --project <dir> --to 3                            # exit 1 after 382 s (two other migrations running)
  already present (id+digest match, no new effect): 18577
  note: VERIFICATION FAILED — config.version was NOT changed; nothing is frozen
$ diff <(event file list before) <(event file list after)               # no output
$ twining migrate_status | jq -r .result.next_command   → twining migrate --to 3   (resume: the interrupted run left config.version unchanged)
```

Following that `next_command` repeats the same failure.

### 5.5 Old clients — the committed 2.16.1 bundle

**Not run at `0f9fd985`.** These results come from an earlier commit of this branch whose `plugin/` tree is byte-identical to `0f9fd985`'s. The bundle ignores `TWINING_OFFLINE` and reaches the network (K23), so it was not run again. Treat this section as NOT VERIFIED at this commit.

- Finalized v3 store: `plugin/server/twining-server.mjs` starts, logs the `format version 3 is newer …` line; over JSON-RPC `tools/call twining_post` → `{"error":true,"message":".twining/ format is newer than this release supports — writes are refused to prevent divergence.","code":"FORMAT_VERSION_TOO_NEW"}`; status reads work. Its `migrate --check` is not format-aware (`check passed: target contains every source record.`).
- `incomplete` store: plain 2.x. Rolled-back store: it writes the 2.x view (`[twining] Ingested records: +2 ~3 -0`); every retained event file kept its sha256.
- With `TWINING_OFFLINE=1` it fetched part of `onnx/model.onnx` (megabytes, cut off at exit); the new CLI then logged `Load model from …/model.onnx failed:Protobuf parsing failed` and fell back to keyword search.
- No schema-negotiation event exists: `c21.test.ts` `it.todo("A-OLD-04 UNAVAILABLE: …")`. `c21.test.ts` "U4/U9: the old client is refused before AND during rollback" disagrees with the rolled-back run above — NOT VERIFIED which is intended.

### 5.6 Qualification items that are tests only

Byte identity and injective id mapping: `c21.test.ts` A-REC-01…03. The must-never-happen set (unknown stays unknown, no promotion from caller fields, lifecycle unaltered, conflict retained, truncation is not reconstruction): A-REC-05, A-REC-07, A-HIST-02, A-REC-09, A-REC-11. Dirty work preserved: A-REC-08. **UNAVAILABLE at the operator level**: no command drives them, so the only evidence is the test suite. No run covered a SQLite-only v2 store with no export.

## 6. Recovery

### 6.1 Losing `store/events.db` — not recoverable (K7)

Finalized small store, 8 event files, 7 admitted:

```
$ rm .twining/store/events.db*
$ twining events ls                        → "total":0
$ twining exchange_status                  → "events_held":0,"admitted":0,"projected":0,"checkout":"ok", "gaps":[]
$ twining doctor                           → "events":{"total":0,"admitted":0,"quarantined":0,"rejected":0}
$ twining-mcp migrate --project <dir> --to 3   →  exit 0, legacy files: 11  records: 1  created: 1 …
$ twining events ls                        → "total":1        # 8 files on disk
```

The next command recreates an empty `events.db` (~100 KB). On an identity-init store after the same `rm`, a `SessionStart` hook injected nothing (`nothing to inject: the working set for this scope is empty`), added a 14th file, and `twining events ls` stayed `total 0`; `assemble` still returned 2 decisions (it reads the 2.x sqlite). No CLI or MCP verb calls the store's `rebuild()` (`grep -rn '\.rebuild(' src` → nothing). The byte-identical-rebuild claim rests on `docs/reports/2026-09-resource-measurements.md` and `scripts/qualify/c28-remote/run.sh` (written for a second computer) — **UNAVAILABLE** here.

### 6.2 Git carrier via a bare repository (K5)

Bare `remote.git` (one-machine stand-in; a real network remote is UNAVAILABLE), `cloneA`/`cloneB`, `identity init` in each with separate identity homes.

```
$ cd cloneA && twining sync --remote origin --project cloneA        # exit 0
{"ok":true,…,"result":{"carrier":"fs:…/cloneA/.twining/exchange-fs",…,"published":{"attempted":1,"transferred":1,…},"received":{"polled":1,"admitted":1,"duplicates":1,…}}}
$ git --git-dir remote.git for-each-ref --format='%(refname)'
refs/heads/main
$ cd cloneB && twining sync --remote origin --project cloneB  → "carrier":"fs:…/cloneB/.twining/exchange-fs" … "polled":0
$ twining events ls --project cloneB → "total":0
```

(From source, not a run:) `src/cli/v3-verbs.ts:548` calls `new mod.GitTransport(projectRoot, remote)` positionally; the constructor takes `{twiningDir, repoDir, remote?, …}` (`src/exchange/git-transport.ts`); the throw is caught and `sync` falls back to an `FsTransport` inside the store.

### 6.3 Shared directory (`sync --path`) — bytes arrive, records do not (K6)

```
$ twining sync --path <shared> --project cloneA  → "published":{"attempted":1,"transferred":1}, "received":{"polled":1,"admitted":1,"duplicates":1,"quarantined":[]}
$ twining sync --path <shared> --project cloneB  → "published":{"attempted":1,"transferred":1}, "received":{"polled":2,"admitted":1,"duplicates":1,…,"quarantined":["<A's event>"]}
$ twining sync --path <shared> --project cloneA  → "published":{"attempted":0,…}, "received":{"polled":1,"admitted":0,…,"quarantined":["<B's event>"]}
$ twining exchange_status --project cloneA       → "events_held":2,"admitted":1 … "quarantined":{"count":1,"retryable":1,"by_reason":{"signature_required":1}}
$ twining read --project cloneA                  → ["FROM-A finding"]
$ ls <shared>                                    → cursors events index.jsonl
```

A fresh replica with no publishes: `"polled":2,"admitted":0,"quarantined":[both]`, `by_reason {"signature_required":2}`. No operator verb adds a peer key (`grep -rn knownKeys src/cli` → 0). Why the reason is `signature_required` is **not established by a run**; (from source, not a run) the runtime knows only this host's and local human keys (`src/adapters/runtime.ts`) and `src/events/event-store.ts` folds `SIGNER_UNKNOWN` into `signature_required`. Two physical computers: **UNAVAILABLE**.

### 6.4 Crash at each durable boundary — tests only

`test/exchange/fault-worker.ts` is a real producer/consumer process killed with `SIGKILL` (or connection close) between any two durable steps over `fs` and `git` carriers, driven by `test/acceptance/cases/c18.test.ts` ("KS-1..KS-8: every kill is a real SIGKILL, and recovery loses no acknowledged event", and a "what this suite does NOT cover" block). It has no standalone entry point, so an operator cannot drive it. **Tests only.**

### 6.5 Not covered

Backup consistency across source/outbox/index; credential rotation (only `exchange_status.revoked_credentials[]` is observable; no verb sets it); source-access revocation; retention; import into a clean installation on a second computer — **UNAVAILABLE** (no second computer; the one-machine stand-ins cannot exchange records, §6.2–6.3).

## 7. Rollback — including writes made after the upgrade

Bar: a backup that loses post-upgrade records is not lossless; an unsupported downgrade must be visible, keep the new records and stop old clients corrupting them; retained records must be inspectable and re-importable; unavailable functionality is reported separately from data preservation.

### 7.1 Rollback, a write, re-upgrade (the §5.1 store)

```
$ twining-mcp rollback --project <dir> --to 2 --dry-run   # exit 0, ends "(dry run: nothing was written)"
$ twining-mcp rollback --project <dir> --to 2             # exit 0
# Rollback report — v3 → 2
## Data preservation
- events retained: 6 …
$ twining-mcp migrate-status | jq -c '{migration,records_frozen}'   → {"migration":"rolled_back","records_frozen":false}
$ jq -c '{format}' .twining/store.json; grep version .twining/config.yml
{"format":3}
version: 2
$ ls .twining/legacy
id-map.json manifest.json migration-state.json pre-rollback-originals rollback-report.json ROLLBACK-REPORT.md view-manifest.json
$ twining events ls → 6;  twining-mcp events ls → # 6 event file(s)
$ twining post --json '{…"summary":"POST-ROLLBACK-WRITE-1"…}'   → "01M498X48903WV4G5YVST3JQVZ"
$ twining-mcp events ls → # 7 event file(s) under .twining/events/
$ twining-mcp migrate --project <dir> --to 3              # exit 0: legacy files: 11  records: 1  created: 1 …
$ twining-mcp migrate-status → {"migration":"complete","events":8,"attachments":7,"id_map_entries":7,"records_frozen":true}
$ twining read → ["LEGACY-FINDING-A","LEGACY-FINDING-B","LEGACY-FINDING-C","legacy seed","POST-ROLLBACK-WRITE-1"]
$ twining-mcp migrate --project <dir> --to 3              → already present (id+digest match, no new effect): 1
```

`legacy/ROLLBACK-REPORT.md` lists what to commit — `.twining/legacy/view-manifest.json` is "REQUIRED. Without it the next `twining migrate --to 3` reads every view file as a new legacy record and creates a rival body for every record you have" — and a separate "Unavailable functionality (NOT data loss)" section. Retained events stay inspectable while rolled back. Requirements (3) and (4) are met.

### 7.2 The post-rollback write becomes two records (K8)

```
$ grep -l POST-ROLLBACK-WRITE-1 -r .twining/events | wc -l
2
$ … | jq -c '{id,ec:.evidence_class,legacy:(.legacy!=null)}'
{"id":"01M498X48TZ8F6BCQ09CG9AKME","ec":"proposal","legacy":false}
{"id":"01M498X48903WV4G5YVST3JQVZ","ec":"legacy_unverified","legacy":true}
```

Rollback leaves `store.json` at `format: 3`, so the mirror keeps writing events while rolled back, and the re-upgrade ingests the 2.x view of the same write. Requirement (1) holds for bytes, fails for identity. Writes after a **completed** upgrade cannot be tested: this build refuses them (K1). Requirement (2) is partial: the version stamp stops old clients on a finalized store; on a rolled-back store they may write the 2.x view (§5.5).

## 8. Erasure limits

Twining cannot erase anything from a clone someone already has, a backup, a mirror or a host's own transcript, and no report may claim otherwise.

```
$ twining capabilities | jq -r '.result.commands[].name' | grep -iE 'tomb|purge|forget|erase|redact|retract|revoke|dismiss'
twining_dismiss
$ twining dismiss --json '{"ids":["01M49A8N5EN50ZS4TWYJ02GK9G"],"reason":"erasure probe"}'
{"dismissed":["01M49A8N5EN50ZS4TWYJ02GK9G"],"not_found":[]}
$ twining-mcp events ls
01M49A8N6CQ7CS61WFV8WXSYBY  created       post         …  proposal
01M49A8NDHPQRBEVCYDK8KNPBQ  created       observation  …  verified_observation
01M49A8NE6KDZ01NEJHDZAMG76  receipt       -            -  proposal
# 3 event file(s) under .twining/events/
$ twining events ls --kind tombstoned → "total":0;   twining read → "total_count":0
$ grep -l ERASE-ME -r .twining/archive → .twining/archive/<date>-blackboard.jsonl
```

The record leaves the 2.x view and stays `created` in the log; the dismissal lands in `archive/`, which `.gitignore` excludes (K17). (From source, not a run:) `src/adapters/v3-mirror.ts` `COMMAND_EVENT_MAP` has no `twining_dismiss`; `purge`, `forget`, `localErasures`, `erasureReport` exist only as `src/events/event-store.ts` API. Retract/redact/purge, redelivery after redaction, a restored backup refusing to qualify from a stale copy, and the per-location erasure report are covered by `test/acceptance/cases/c20.test.ts` — **tests only, UNAVAILABLE at the operator level**.
