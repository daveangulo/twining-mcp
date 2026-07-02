# Twining MCP — Design & Code Review (July 2026)

Scope: full-repo design and code review of `twining-mcp` v1.20.0 (server) / plugin v1.9.1, cross-referenced against all 11 open and closed GitHub issues. The question asked: are there structural issues, and is there a better way to deliver this functionality — functionally better, faster/more scalable, and easier to operate and support.

## Verdict

The core product idea is sound and validated: a shared blackboard + decision log that survives context windows is genuinely useful, and the issue tracker shows a real external user getting real value. The test discipline is unusually strong (~1.8:1 test-to-code ratio, LLM-judged evals, hook tests). But the system has three structural problems that the issue history independently confirms, and all three trace to the same root decision: **one stdio server process per Claude Code session, coordinating through hand-rolled JSON files and bash hooks.**

1. **The storage engine is unsafe under exactly the concurrency the product exists to serve.** Multi-agent, multi-session coordination is the pitch, but writes are non-atomic whole-file rewrites with advisory locks, reads are unlocked, and one crash mid-write can destroy the decision index or graph.
2. **The enforcement layer (bash hooks) is where the product actually breaks in the field.** 6 of the 9 externally-filed issues (#8, #9, #10, #11, #13, #18) are hook-layer failures, not server bugs. The pre-commit hook was already rewritten once (#11/#13) to abandon transcript grepping — and the Stop hook still uses the abandoned technique today.
3. **The per-session process model multiplies every resource.** N sessions = N ~200MB embedding models, N dashboard HTTP servers fighting for ports (#19 is exactly this), N independent caches with mtime-based coherence, N processes racing on the same files.

The better delivery shape is not a rewrite: **keep the MCP surface and the plugin, but move storage to SQLite, unify the runtime into one per-project service, and finish the sentinel-based hook hardening you already started.** Details and a sequenced roadmap below.

---

## What the issue tracker says

| Theme | Issues | Status |
|---|---|---|
| Hook fragility (transcript grep race, regex JSON parse, prompt-hook crash) | #8, #11, #13 | closed, partially fixed |
| Hook intrusiveness (CLAUDE.md stomping, no per-project disable) | #9, #10 | closed |
| Recording quality degrades under hook nagging | #18 | **open** |
| Data lifecycle / staleness / GC | #7 (closed), #16 | **open** |
| Dashboard multi-instance / port conflicts | #2 (closed), #19 | **open** |

Two readings of this table matter:

- **Nobody has filed an issue against the coordination model itself.** The blackboard/decision/assemble loop works. The friction is entirely in *how it's enforced and operated*.
- **The hook bugs are a class, not incidents.** #11 and #13 were both "shell script parses semi-structured text with grep/regex" failures. The fix (sentinel file + `git log` comparison) was the right move — but it was applied to one of the two gates. The same class of bug is still live in `stop-hook.sh`.

---

## Structural findings

### A. Storage layer — HIGH severity cluster

**A1. No atomic writes anywhere.** Every store writes with `fs.writeFileSync` directly onto the live file (`src/storage/file-store.ts:40,112`, `graph-store.ts:73-93`, `decision-store.ts:57,134`, `index-manager.ts:79,114`). There is no temp-file + `rename` pattern anywhere in `src/storage` or `src/embeddings` (verified by grep). `proper-lockfile` serializes writers but does nothing for atomicity: a process killed mid-write leaves truncated JSON. For the whole-file stores (`entities.json`, `relations.json`, `decisions/index.json`, embedding `*.index`), a truncated file means `JSON.parse` throws and the entire dataset is unreadable.

**A2. Unlocked reads can observe torn writes across processes.** `readJSON` (`file-store.ts:19-22`) and the graph/decision index readers take no lock while another *process* may be mid-rewrite. The in-file comment "No locking needed for reads" (`file-store.ts:71`) is only true for the append-only JSONL path that skips corrupt lines — not for whole-file JSON.

**A3. O(n) whole-file rewrite on every mutation.** Adding one entity rewrites all of `entities.json`; one decision status change rewrites the full `decisions/index.json`; one embedding rewrites the entire index (each vector serialized as ~6-8KB of JSON text). This repo's own `.twining/` already has 131 decisions and a 95KB blackboard; every operation gets slower as the corpus grows, unboundedly.

**A4. Split-lock inconsistency in the graph.** `addRelation` reads entities unlocked then locks only `relations.json`; `removeEntities` locks the two files sequentially (`graph-store.ts:113-141, 214-252`). Concurrent add+remove can produce dangling relations. Entities and relations have no transactional boundary.

**A5. Cache coherence rests on mtime granularity.** Per-process caches keyed on `mtimeMs` (`blackboard-store.ts:29-36`, `decision-store.ts:144-152`) can serve stale data when two writes land within one mtime tick — and every session process has its own cache.

**A6. Schema version exists; migrations don't.** `config.ts:10` writes `version: 1`, but nothing in the codebase reads or acts on it, and individual records carry no version at all. Because `.twining/` is long-lived per project (and in this repo, *committed to git*), any future format change silently breaks existing deployments. This is the most consequential longevity gap.

### B. Enforcement layer (plugin hooks) — HIGH severity cluster

**B1. Stop hook still transcript-greps.** `stop-hook.sh:24-38` greps the transcript for `twining_record|twining_decide|twining_post` and compares line numbers against the last Edit/Write. This is precisely the technique the pre-commit hook's own header comment documents as unreliable (latency races → #11, format brittleness → #13). Known failure modes: assistant *prose* mentioning "twining_record" satisfies the gate; a record made before the final edit blocks a fully-recorded session; any transcript format drift breaks it silently.

**B2. Stop hook fires in every repo, Twining-managed or not.** Unlike the pre-commit hook (which checks for `.twining/` at `pre-commit-hook.sh:55`), `stop-hook.sh` has no directory guard (verified). Globally installed, it blocks session exit in projects that have never opted into Twining. This is the same class of complaint as #10.

**B3. Fresh-clone / server-down commit lockout.** The pre-commit gate compares gitignored `.twining/.last-record` against HEAD's commit time. On a fresh clone the sentinel is absent → first commit blocked until the MCP server (launched via unpinned `npx -y twining-mcp`) successfully boots and records. If npm is unreachable or the latest published version is broken, commits are blocked indefinitely; the escape hatch (`TWINING_DISABLED=true`) is easy to miss.

**B4. SubagentStop hook appends to `blackboard.jsonl` raw, bypassing the store and its locks** (`subagent-stop-hook.sh:39-44`). Concurrent subagent completions can interleave partial lines into the same file the server is writing with locks. It also posts a status entry on *every* subagent stop — the blackboard-spam anti-pattern `BEHAVIORS.md` itself warns against.

**B5. CLAUDE.md mutation on every SessionStart.** `ensure-claude-md-gates.sh` appends a ~24-line gates block to the project's tracked `CLAUDE.md` (creating it if absent), producing surprise diffs — issue #9 in the flesh. The opt-out is an undocumented sentinel file (`.twining/.no-claude-md-gates`). SessionStart hooks can inject `additionalContext` without touching any file; the mutation approach is unnecessary.

**B6. Issue #18 is a design signal, not a bug.** Nag-on-exit produces compliance-quality records ("Claude checks the box"). Enforcement can guarantee *that* a record happens, never that it's *good*. The quality lever is prompt-side (what the record schema and skills ask for), not hook-side.

### C. Runtime model — HIGH

**C1. Per-session process multiplication.** Each Claude Code session spawns its own server: its own `Xenova/all-MiniLM-L6-v2` ONNX model (~150-250MB resident, loaded per process — `embedder.ts:27-33,126-129`), its own dashboard HTTP server (port-scan 24282..24287, `http-server.ts:115-143`), its own caches, its own `PendingProcessor`. Issue #19 (port fights with Serena) is a direct symptom. The dashboard "already running" check only suppresses browser auto-open, not the redundant server.

**C2. First-use model download blocks the first post.** The embedding model downloads on first `embed()` with no timeout; the first `twining_post` after install stalls on a network fetch.

**C3. In-memory assembly log defeats its own gate.** The "did this agent assemble before deciding?" check lives in process memory (`context-assembler.ts:49`), so it resets per session process and is never shared — the gate it feeds is effectively decorative in multi-session use.

### D. Surface area and overhead — MEDIUM

**D1. 35 tools, 3 competing counts in docs.** Source defines 35 `twining_*` tools; `BEHAVIORS.md` says 32 (and omits `twining_record`, the current headline tool); README documents ~35; STATE.md flags the dispute itself. The lite-mode default of 6 tools is the right call — but the eval ground truth (`BEHAVIORS.md`) scores against a tool surface that no longer matches what ships.

**D2. ~12-15k tokens of static per-session overhead.** ~10.4k tokens of plugin artifacts (at 99.4% of the self-imposed +20% cap — 213 bytes of headroom), plus the CLAUDE.md gates block (~680 tokens), MCP instructions (~380 tokens, whose header still says "3 mandatory gates" while the body says 2), plus tool schemas. `measure-plugin-tokens.sh --ci` exists but no workflow calls it, so the cap is not enforced.

**D3. Version/doc skew.** Server 1.20.0, plugin 1.9.1, STATE.md says 1.17.0/1.8.0; `docs/hooks.md` still documents the SessionStart prompt hook removed after #8; README says `metrics.jsonl` is gitignored but it is git-tracked (141 files under `.twining/` are committed, including metrics).

**D4. Dual error conventions.** Tools return `{error:true, code}` JSON-in-text; engines throw `TwiningError` or bare `Error`; the telemetry wrapper has to sniff both by re-parsing every tool response (`instrumented-server.ts:32-79`). Error codes are free-form strings.

### E. Things that are good and worth keeping

- Lite/full tool gating (6 core tools by default) — right instinct; most competitors ship the sprawl.
- Zod schemas on every tool; consistent "never throw to transport" discipline.
- Telemetry done right: opt-in default-off, `DO_NOT_TRACK`/`CI` honored, hashed identity.
- The sentinel + `git log` pre-commit fix — the correct pattern, ready to be generalized.
- Test culture: hook tests, coordination benchmarks, transcript-replay evals, LLM judges with graceful key-absent skip.
- STATE.md's candor about dogfooding debt and doc drift — the project knows where it is.

---

## The better way to deliver this

The functionality users demonstrably want (issues #7, #16, #18 are all about *the data being useful over time*) is: durable, queryable, cross-session project memory with lifecycle management. The current delivery vehicle taxes that goal with file-format fragility, process multiplication, and hook policing. Three moves fix it without abandoning the MCP + plugin form factor:

### 1. SQLite as the storage engine (highest leverage, fully incremental)

Replace the JSON-file stores with a single `.twining/twining.db` in WAL mode:

- **Correctness for free:** atomic transactions kill findings A1-A5 outright — no torn writes, no split locks, no lockfile races, safe concurrent multi-process access (WAL is designed for exactly the N-writers-one-file case).
- **Performance and scale:** indexed queries replace O(n) full-file parse-and-rewrite. Blackboard reads by scope/type/time become `WHERE` clauses. The 131-decision N+1 file-read pattern in context assembly becomes one query.
- **Embeddings scale too:** store vectors as BLOBs (or `sqlite-vec` for ANN when corpora grow); incremental insert instead of rewriting a JSON blob per add; query without loading the whole index.
- **Migrations become real:** `PRAGMA user_version` + a migration runner closes finding A6 before the on-disk format spreads further.
- **Operationally simpler:** one file to back up, inspect (`sqlite3` CLI), or delete. Node 22+ has `node:sqlite` built in; `better-sqlite3` covers Node 18/20. Keep a one-shot importer from the current JSON layout, and optionally a JSONL export for the git-committed-state workflow this repo itself uses.

This is the single change that most improves function (queryability), performance (indexes), scale (no O(n) writes), and supportability (one inspectable file, versioned schema).

### 2. One per-project service instead of N per-session processes

Keep the stdio MCP entry point per session (that's the MCP contract), but make it a **thin shim**: first session to start becomes (or spawns) the project daemon; subsequent shims connect to it (unix socket, or localhost port recorded in `.twining/daemon.json` with a liveness check). The daemon owns:

- the SQLite handle (single writer, trivially consistent),
- **one** embedding model (~200MB once, not per session — fixes C1; embed queue means proper batching, fixing the sequential `embedBatch`),
- **one** dashboard (fixes #19's root cause; bind port 0 and record the assigned port, eliminating range-scan fights with Serena entirely),
- the assembly log and caches (fixes C3, A5 — one process, one cache, actually-shared gate state).

Fallback: if daemon spawn fails, the shim runs standalone exactly as today — no new hard dependency. This can ship after (and independently of) the SQLite move.

### 3. Finish the enforcement redesign you already started — and shift quality prompt-side

- **Generalize the sentinel pattern to the Stop hook.** The server already writes `.twining/.last-record`; the Stop hook should compare it against the session's last mutating tool use (or simply against session start time), never grep transcripts. Delete the transcript parsing entirely (closes the #11/#13 bug class for good).
- **Guard every hook on `.twining/` existence** and honor `TWINING_DISABLED` uniformly (closes B2, the residue of #10).
- **Fail open when the server is down.** If the sentinel is missing *and* the server never booted this session, warn once and allow the commit — a coordination tool must never be the reason a user can't commit (closes B3). Pin the server version in `plugin/.mcp.json` so the plugin/server pair ships tested together instead of resolving "latest" at session start.
- **Stop mutating CLAUDE.md.** Deliver the gates via the SessionStart hook's `additionalContext` output (already the mechanism in `session-start-context.sh`) and delete `ensure-claude-md-gates.sh` (closes B5/#9 permanently).
- **Route the SubagentStop post through the server** (an MCP call or a `pending-posts.jsonl` handled by the existing `PendingProcessor`) instead of raw appends (closes B4).
- **Answer #18 in the schema, not the hook.** The Stop hook can only extract compliance. Move the quality bar into `twining_record`'s prompt surface: ask for findings/warnings/surprises explicitly, and have the *server* respond with a cheap deterministic critique (e.g., "no findings recorded for a 12-file change — anything surprising?") once, not repeatedly. For #16 (semantic staleness), the issue's own option (a) — skill-driven, no server-side model dependency — is the right call and keeps the server surface narrow.

### Sequenced roadmap

| Phase | Work | Effort | Pays off |
|---|---|---|---|
| 0. Stop the bleeding | Temp-file+rename atomic writes; lock reads of whole-file JSON; route subagent-stop through PendingProcessor | Small | A1, A2, B4 — corruption risk gone this week |
| 1. Hook hardening | Sentinel-based Stop hook; `.twining/` guards everywhere; fail-open on server-down; kill CLAUDE.md mutation; pin server version in `.mcp.json` | Small | B1-B5, closes the #8-#13 bug class, #9, #10 |
| 2. SQLite migration | One DB, WAL, importer from JSON, `user_version` migrations; embeddings as BLOBs | Medium | A1-A6, C-adjacent, D-supportability |
| 3. Project daemon | Shim + daemon; single embedder, single dashboard on ephemeral port | Medium-Large | C1-C3, #19, #2-class UX |
| 4. Hygiene | Reconcile BEHAVIORS.md/STATE.md/README to the shipped 35-tool surface; fix metrics.jsonl gitignore-vs-README contradiction; fix "3 gates" comment in instructions.ts; wire `measure-plugin-tokens.sh --ci` and an eval smoke into CI; unify error codes into an enum | Small, ongoing | D1-D4, eval trustworthiness |

Phases 0-1 are days of work and eliminate the two categories responsible for every field-reported bug. Phase 2 is the structural core. Phase 3 is the scalability/operability payoff. None of them changes the MCP tool contract, the plugin UX, or the data users have already accumulated (the importer carries it forward).

---

*Review conducted 2026-07-02 against commit `8eb7998` on `main`. Sources: full `src/` and `plugin/` review, all 11 GitHub issues (open and closed), CI workflows, test suites, and the repo's own committed `.twining/` state.*
