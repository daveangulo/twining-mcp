# Twining Docs Site — Design Spec

**Date:** 2026-09-01
**Status:** Approved-pending-review (approach and design approved in-session 2026-08-31; this document is the written form for final review)
**Target version documented:** twining-mcp 2.16.0 / plugin 1.34.0

## 1. Summary

A human-voiced documentation site for Twining, built with VitePress, living in-repo under `docs/site/`, deployed to GitHub Pages. It explains the background, the problem Twining exists to solve, how it fits into the landscape of other tools, provides a runbook for two equal audiences (Claude Code plugin users and generic MCP clients), an architecture section, a tool-surface reference that explains what each tool *actually does* (mechanism, side effects, gotchas — not just name and description), and a fully candid account of how the project evolved under benchmark and field feedback. Diagrams (Mermaid) are used liberally.

Plus a bounded **stale-docs fix wave** correcting the verified stale claims in the *existing* docs so the old and new documentation don't disagree.

### Decisions already made (with Dave, 2026-08-31)

1. **Stack:** VitePress in-repo → GitHub Pages. Rejected: Astro Starlight (heavier), plain markdown tree (no site affordances), single Artifact page (not versioned with repo).
2. **Voice:** editorial "we" — warm, opinionated project voice; no single-author first person.
3. **Candor:** fully candid evolution chapter — defect waves, refutations, benchmark limitations, named versions. Field deployment stays anonymous ("a heavy-usage deployment").
4. **Runbook audiences:** equal weight, plugin and generic MCP.
5. **Shape:** approach A — curated narrative (~29 pages across six sections) with build-time-generated tool tables, over B (39 per-tool pages) and C (slim guide). Rationale: mechanism prose groups better by concept than by tool atom; generation kills table rot.
6. **Scope:** include the stale-docs fix wave for existing docs.

### Source of truth

All content is written from the verified research corpus at `.planning/docs-site-research/` (15 files, ~600KB, every claim cited to file:line at HEAD 3543dc6, cross-checked by a critic pass that arbitrated 10 cross-lane contradictions against the code). Where the research and any existing doc disagree, **the research (i.e. the code) wins**. The corpus is gitignored working material; the site cites code, not the corpus.

## 2. Goals / Non-goals

**Goals**

- A new user understands *why* Twining exists and *whether they need it* within one page.
- An operator can install, configure, upgrade, migrate, and debug either deployment shape without reading source.
- A curious reader learns what each of the 39 tools actually does at the mechanism level.
- The evolution chapter builds trust by being verifiably honest, including about our own mistakes.
- Reference tables cannot drift from the server (generated + CI-checked).

**Non-goals**

- Not a replacement for README.md (npm/GitHub landing keeps its own condensed pitch; it gains a link to the site).
- No contributor/internals guide beyond what the architecture section naturally covers (CONTRIBUTING.md remains, gets fix-wave corrections only).
- No versioned-docs infrastructure (one live version, stamped; revisit if a v3 lands).
- No search service (VitePress local search is enough).
- No dark-launch or staging environment.

## 3. Site architecture

### 3.1 Layout

```
docs/site/
  package.json          # own deps: vitepress ^1.6, vitepress-plugin-mermaid, mermaid; NOT added to server package.json
  .vitepress/
    config.mts          # base: '/twining-mcp/', nav, sidebar, local search, docsVersion constant
    theme/              # minimal — default theme + custom footer with version stamp
  scripts/
    extract-tools.mjs   # tool-registry extractor (see 3.3)
  generated/
    tools.json          # committed extractor output (CI-checked for freshness)
  <content dirs per §4>
```

- Own `package.json` keeps the server's dependency tree clean; the site is an independent npm workspace-less subproject (`cd docs/site && npm ci && npm run build`).
- `base: '/twining-mcp/'` for project-pages hosting at `daveangulo.github.io/twining-mcp/`.
- Every page renders a "Written against twining-mcp 2.16.0 / plugin 1.34.0" stamp (footer, single constant in config). Narrative pages that describe behavior additionally carry frontmatter `verifiedAt: 3543dc6`.

### 3.2 Deploy

- `.github/workflows/docs.yml`: on push to `main` touching `docs/site/**`, build and deploy via `actions/deploy-pages` (Pages source = GitHub Actions). Also a PR job that builds without deploying (link check + freshness check, §7).
- **Owner action required (Dave):** enable Pages in repo Settings with source "GitHub Actions". Verified 2026-08-27: Pages is not currently configured (`gh api .../pages` → 404). The workflow will fail until this is done; the plan sequences it as a checkpoint, not a blocker for building the site locally.

### 3.3 Generated tool reference

- `extract-tools.mjs` boots the server's tool registration against a stub MCP server object (the exact pattern `test/plugin-tool-references.test.ts` already uses to census registrations), with both surface configs:
  - default config → the 15-tool default surface
  - `tools.full_surface: true` + `tools.mode: 'full'` → all 39
  - `tools.mode: 'lite'` → the 8-tool lite surface
- Output `generated/tools.json`: per tool — name, title, description, input schema (params, types, defaults, required), surface classification (default / full_surface / lite membership), category.
- Category pages render their tables from this JSON via a small Vue component (or a markdown-generation prebuild step — implementer's choice; criterion: whichever keeps `npm run build` a single command).
- **Why generated:** three stale tool-counts live in the repo today (config comment says 16 hidden; actual 24; STATE.md says lite = 6, actual 8). Hand-written tables are how that happens. The existing `plugin-tool-references` test keeps guarding README/TWINING-REFERENCE; the site's tables are guarded upstream by construction plus the freshness CI check (§7).

## 4. Information architecture

Six sections, ~29 pages (4 start-here, 6 concepts, 7 tool-surface, 7 runbook, 1 landscape, 4 evolution). Per page: the research lane(s) it draws from. Diagram inventory in §5.

### 4.1 Start here

| Page | Content | Source lanes |
|---|---|---|
| Landing (`index.md`) | Hero: the problem in three sentences, what Twining is, install one-liner, three doorways (new user / operator / "why should I trust this") | history-and-landscape |
| The problem | Session amnesia, silently contradicted decisions, multi-agent divergence; why context windows can't be the memory; what "project memory" has to mean (decisions + rationale, not transcripts) | history-and-landscape |
| Install | Tabbed: Claude Code plugin (marketplace, two-scope gotcha) / generic MCP client (the four documented `.mcp.json` variants, npx/global/node forms). Explicit note: per-client paths for Cursor/Windsurf/Desktop are *inferred*, marked as such | runbook, plugin |
| Your first session | Walkthrough: first `twining_assemble` on an empty store → work → `twining_record` → what appeared in `.twining/` → second session shows the payoff | tools-core, runbook |

### 4.2 Concepts

| Page | Content | Source lanes |
|---|---|---|
| The blackboard | Hayes-Roth lineage; orchestrator (1→N lossy relay) vs blackboard (N↔N shared workspace); entry types; the open lane; provenance | history-and-landscape, tools-blackboard-decisions |
| Decisions | What a decision record holds (rationale, alternatives with reason_rejected, confidence, affected files/symbols); the five-state lifecycle; supersession chains as first-class history — contradictions retained and surfaced at read time, never overwritten | tools-blackboard-decisions |
| Context assembly | The five-signal scoring (recency 0.2 / relevance 0.2 / confidence 0.15 / warning-boost 0.1 / graph-reachability 0.35), 168h half-life, semantic floor 0.3 with scope bypass, warning-first budget fill with degrade-before-drop | tools-core, architecture |
| Storage | "SQLite is the runtime store, git is the replication transport": gitignored `twining.db` as derived cache, committed per-ULID `records/` tree, file-wins ingest at startup and on HEAD moves, `lifecycle_reverts` as the alarm; backend auto-resolution; why plain files (merge-friendliness across branches/machines) | architecture |
| The two gates | Honest framing: Gate 1 (assemble-before-work) is **instruction-only** — 90.7% voluntary compliance measured in the field; Gate 2 (record-before-commit) is **hook-enforced** via the `.last-record` sentinel, with deliberate fail-open valves; the "any twining_post satisfies the sentinel" caveat stated plainly | plugin, tools-core |
| Scopes & the knowledge graph | Path-prefix scope semantics; graph auto-population from decisions (always-on) vs opt-in `graph.auto_populate`; declared-vs-derived origin precedence; how assemble consumes reachability | tools-graph-agents |

### 4.3 Tool surface

Landing page: the surface map (39 tools; 15 default / 24 full-surface; 8 lite), the two config switches, and the standing framing — **`twining_record` is the default-surface path**; we do not steer users to flip `full_surface` (decision 01KYXA3B7GFWVWEC2NRY9YANFV).

Category pages (grouping mirrors the server's registrar structure; final assignment at plan time):

1. Context — assemble, why
2. Recording & decisions — record, decide, amend, override, promote, reconsider, search_decisions, link_commit, commits, trace, what_changed
3. Blackboard — post, read, query, recent, summarize, resolve, dismiss, triage, acknowledge
4. Lifecycle & maintenance — status, housekeeping, archive, archive_stale, unarchive, verify
5. Knowledge graph — add_entity, add_relation, graph_query, neighbors, prune_graph
6. Coordination — register, agents, discover, delegate, handoff (with deprecation story), export

Per tool, three blocks:

- **What it's for** — one human paragraph.
- **What actually happens** — mechanism: engine/store calls, files/rows written, side effects (status posts, sentinel writes, graph population, auto-archive triggers, embeddings), ranking/parsing algorithms where they exist (assemble's fill, record's NL parser and its `Rationale:`/em-dash/`because` split rules, why's specificity tiering, housekeeping's preview-parity pipeline), and gotchas the code revealed (supersedes single-decision rule, archive_stale's tombstone-delete vs decisions' status-archive asymmetry, first-resolve-wins, override+new_decision landing on "superseded").
- **Surface & parameters** — generated table.

### 4.4 Runbook

| Page | Content | Source lanes |
|---|---|---|
| Installing & upgrading | Both audiences; server-vs-plugin version relationship; both-plugin-scopes update rule (proven shadowing incident); pinning; the launcher's rung ladder (script labels 0a/0b/1–4, per critic arbitration) and `--probe` with its honest caveat: a healthy `runner=` does **not** mean the server can launch | runbook, plugin, followup-3 |
| Configuration | Every `config.yml` key with default; all 13 `TWINING_*` env vars; **teach exported-env placement for `TWINING_PROJECT`, not the settings.json route** — upstream claude-code#11927 still open (verified 2026-08-31, repro on CC 2.1.235) | runbook, followup-3 |
| Day-2 operations | Housekeeping cadence (preview-by-default; the promote_provisionals+execute bulk warning), archive semantics, staleness review & merge_sweep, export | tools-core, runbook |
| The dashboard | Tabs and what each shows; loopback-bind zero-auth read-only posture; `/api/raw` trust model | followup-2 |
| Migration (files ⇄ sqlite) | `migrate --check/--dry-run/--reverse`, exit codes, the version-2 read-only gating for mixed teams, frozen-records hazard, `repair_index` | architecture, runbook |
| Worktrees, monorepos, multi-machine | Store resolution precedence (`--project` > `TWINING_PROJECT` > linked-worktree redirect > cwd); shared store across worktrees | runbook, plugin |
| Troubleshooting | The 12-entry catalog with *correct* diagnoses: probe caveat, 0-byte-db amnesia (S0), files-backend index desync, npm-link stale dist, Stop-hook false positives, scope shadowing, `CLAUDE_PLUGIN_ROOT` exit 78, worktree store divergence, etc. Explicitly excludes the refuted "git log -p on the mirror file" diagnostic | runbook, evolution-field |

### 4.5 Landscape

One page, honest positioning with URLs: claude-mem (form-factor cousin; captures what Claude *did* vs Twining's what was *decided and why* — and candid about adoption asymmetry), mem0/OpenMemory, Letta/MemGPT, the reference MCP memory server, Zep/Graphiti, ADR tooling (spirit ancestor), orchestration frameworks (different layer, not competitors), CLAUDE.md + Claude Code auto-memory (complementary; when they're enough). Closes with **"When you don't need Twining"** — solo dev, single short-lived project, no multi-session decisions worth auditing.

### 4.6 Evolution

| Page | Content | Source lanes |
|---|---|---|
| Timeline | Feb 2026: v1 in a day → March: retrieval + evals (the changelog-silent window, admitted) → April: `twining_record` + the two gates → July: the design review that called the architecture's root defect out loud (quoted) → v2 → the field-driven release train 2.6.0–2.16.0 | history-and-landscape, evolution-field |
| What the benchmark taught us | What it drove (verify demoted, assemble tiering, the 2-gate lifecycle, `twining_record`, the reduced default surface — run 4005bc41 and the follow-on analyses) AND what its numbers cannot support: the +64 decision-documentation lift was substantially a scorer artifact (regex credited only `twining_decide`, called zero times; fixed in harness c4c1774); stores deleted at teardown so historical runs can't be content-scored; v1-only path snapshots under the 2.6.0 pin; every lift number is dataset- and scorer-version-specific. In-repo eval harness (BEHAVIORS.md as machine-parsed spec, the v2.0.0 gate numbers with their honest footnote: "holdout 42/42" = 42 vitest tests green; the scorer data shows 41/42 pairs above threshold) | evolution-benchmark, followup-1 |
| What the field taught us | The defect waves as narrative: D1–D5 (2.7.0), D7 (2.8.0), D9–D13 waves A–C, D14/D15 (2.14.0) *including the corrections that cut both ways* — D15's reopening refuted (one post is exactly what two promote calls predict), our own memo diagnostic conceded structurally unusable; S0 silent amnesia + index desync (2.16.0); the plugin 1.24.0 every-session guard outage and 1.24.1; the "both sides were right about different builds" version-skew story; measured compliance numbers. Anonymity rule throughout | evolution-field |
| Open at 2.16.0 | file-wins precedence (named open design decision), UNIQUE backstop, per-decision supersedes, neighbors reduced form, handoff removal at v3, the four prepared-not-filed routing issues (as "proposals under discussion", no field detail) | evolution-field, followup-3 |

## 5. Diagram inventory

Mermaid throughout (`vitepress-plugin-mermaid`); target ~18, drawn from the candidates the lanes logged. Committed set (implementer may add, not subtract without recording why):

1. Orchestrator vs blackboard topology (concepts/blackboard)
2. Blackboard entry lifecycle: open → resolved / dismissed(tombstone) / archived (concepts/blackboard)
3. Decision five-state machine with per-transition actors and stamps (concepts/decisions)
4. Assemble pipeline: sources → scope lane + semantic lane (0.3 floor) + graph BFS → weighted scoring → warning-first budget fill (concepts/context-assembly)
5. Storage data flow: tool write → twining.db + records/ ULID export → git commit/pull → HEAD move → file-wins ingest → lifecycle_reverts (concepts/storage)
6. Backend auto-resolution decision tree incl. the S0 before/after arms (concepts/storage)
7. Two-gate session sequence: SessionStart injection → assemble → work/activity marker → record → sentinel → pre-commit check (concepts/gates)
8. Gate 2 enforcement sequence with fail-open valves (concepts/gates)
9. Graph auto-population data flow, declared vs derived precedence (concepts/scopes-graph)
10. Tool-surface map: 39 tools by category, default/full/lite highlighted — generated from tools.json (tools/index)
11. twining_record fan-out sequence: resolves → status post → NL parse per decision → graph population → sentinel (tools/recording)
12. Housekeeping pass pipeline: always-on vs opt-in lanes, preview-parity filter (tools/lifecycle)
13. Launcher resolution ladder flowchart, script labels 0a/0b/1–4, exit codes (runbook/install)
14. Store resolution precedence flowchart, server vs hook variants (runbook/worktrees)
15. Migration state machine files ⇄ sqlite with verify gate and frozen-records hazard (runbook/migration)
16. Layered architecture block diagram: client → stdio → wrapper chain → tool surface → engines → stores → dashboard (architecture, lives on concepts/storage or its own architecture page — plan-time call)
17. Benchmark feedback loop: run → analysis → findings → release → harness fix (evolution/benchmark)
18. Field release-train swimlane: report waves → verification → releases 2.6.0–2.16.0, with refutation call-outs (evolution/field)

Rule: every diagram shows a real mechanism with the real names (function/file/state labels from the research), not decorative boxes.

## 6. Voice & truth constraints

**Voice.** Editorial "we". Plain sentences, concrete examples, first-paragraph payoff per page. Opinionated where we made a bet ("we think decision provenance beats transcript capture; here's why"), neutral where reporting facts. No marketing superlatives. Jokes allowed, sparingly. Contractions yes.

**Truth rules (binding on the implementer):**

1. Every behavioral claim traces to a research-note cite (file:line at 3543dc6) or is re-verified in code. Existing docs are *not* acceptable sources — the lanes logged ~30 places they're stale.
2. Never state the stale counts: "16 hidden tools" (config comment), "lite = 6 tools" (STATE.md), "~32 surface". Correct: 39 registered / 15 default / 24 full-surface-gated / 8 lite.
3. Never repeat: the "git log -p on the mirror file" diagnostic; "unarchive restores to active" (it restores `archived_from`); "hooks block until you record" without the fail-open caveat; the settings.json env route for plugin MCP servers; verify's `checks` default being "all" (engine default is warnings/assembly/drift); "+64 benchmark lift" as a real effect.
4. Field deployment: anonymous, no repo names, no customer-identifying numbers beyond already-published aggregate figures (e.g. 90.7%).
5. Benchmark numbers always carry their scope qualifier (dataset, scorer version, significance).
6. Where behavior is known to have safety valves or sharp edges (promote_provisionals bulk, archive_stale tombstone-delete), the docs say so at the point of use, not in a far-away appendix.

## 7. Testing & CI

- **Build gate:** PR job builds the site (`npm ci && npm run build` in `docs/site/`), failing on VitePress dead links (built-in).
- **Freshness gate:** CI regenerates `tools.json` from source and diffs against the committed copy; drift fails. This runs in the main CI workflow (needs the server's node_modules), sequenced so it doesn't slow the publish path.
- **Existing guards untouched:** `plugin-tool-references.test.ts` keeps pinning README/TWINING-REFERENCE tables; BEHAVIORS.md remains machine-parsed by the eval harness — the fix wave edits to those files must keep both parsers green (run them locally before commit).
- **No prose-pinning tests for the site:** narrative rot is managed by the version stamp + the generated tables carrying all schema-level claims. Recorded as a deliberate non-goal.

## 8. Stale-docs fix wave (bounded)

Scope: correct the verified-stale claims in existing docs; no restructuring. Master list compiled from the lanes' `doc_vs_code_disagreements` (research notes, ~30 items). Headliners:

- README: unarchive row text; troubleshooting rows that survived earlier fixes; add site link.
- docs/TWINING-REFERENCE.md: same unarchive text; conflict-handling description (code posts a finding, never demotes; `conflicts_with` doesn't exist).
- TWINING-DESIGN-SPEC.md: mark superseded sections (stale ASCII architecture, phantom "path" tool, conflict→provisional claim) with pointers to the site rather than rewriting the spec.
- src/config.ts:91 comment ("16 rarely-used tools" → 24); STATE.md lite count.
- plugin coordinator agent's "13 default tools" → 15.
- verify-tools schema text ("default: all") aligned with engine default, or the engine default changed — **code-vs-doc direction decided at plan time; criterion: doc moves to code unless the code behavior is itself a bug with a recorded defect** (the dead `fail_on` param is out of scope for the docs task; posted as a Twining finding instead).
- CLAUDE_TEMPLATE "hooks will block" → honest fail-open phrasing.

Each fix cites its research line in the commit message. Anything requiring a *code* change beyond a comment is out of scope → recorded as findings, not fixed.

## 9. Assumptions

1. GitHub Pages project-site hosting is acceptable (no custom domain). Invalidated → `base` changes, one-line fix.
2. Node ≥22 available in CI for the site build (repo already requires 22.13; workflows can reuse it).
3. The site documents 2.16.0 even if a 2.17.x ships mid-implementation; a version-stamp bump + delta pass is a follow-up task, not a moving target during the build.
4. `vitepress-plugin-mermaid` (2.x) works with VitePress 1.6 out of the box; fallback: VitePress's markdown-it hook rendering mermaid client-side (known pattern), decided at first build failure, recorded.
5. The extractor can import tool registrars via `tsx` without a full `npm run build` of the server. If not, it runs against `dist/` with a build prestep — costs seconds, decided at implementation, recorded.
6. Research corpus in `.planning/docs-site-research/` remains available to the implementing session (this machine).

## 10. Decision points & fallbacks

| Point | Criterion |
|---|---|
| Tool-table rendering: Vue component vs generated markdown | Whichever keeps `npm run build` single-command and diffs readable; prefer generated markdown if component adds >~50 lines of glue |
| Category grouping final assignment (verify/export placement) | Mirror server registrar files; where a tool is genuinely cross-category, place by user intent and cross-link |
| Landscape claims that can't be re-verified at write time | State with "as of <date>" + URL, or cut; never assert unverifiable comparisons |
| Any research claim that fails re-verification during writing | Code wins; correct the corpus note inline, record the correction as a finding |
| Unanticipated decision | Lower-risk action + full rationale via twining_record, continue; halt only for plan-invalidating discoveries per global working agreement |

## 11. Risks & recovery

- **Pages not enabled when deploy first runs** → workflow fails visibly; site still builds in PR CI; recovery: Dave flips the setting, re-run. No rollback needed.
- **Candid chapter overshoots anonymity** → mitigations: the anonymity rule is binding (§6.4); the evolution pages get a dedicated pre-commit review pass against the rule; Dave reviews before deploy.
- **Fix wave breaks a doc-pinning test** → run `plugin-tool-references` + eval parser locally before each fix-wave commit; a red test means the fix text is wrong or the test needs the same correction — resolve toward code, record.
- **Scope creep into per-tool pages** → hard boundary: category pages only; a tool needing >~600 words of mechanism prose gets a collapsible section, not a page.
- **Docs build flakes CI for server-only PRs** → docs jobs path-filtered to `docs/site/**` (plus the freshness check, which is cheap and runs everywhere by design).

## 12. Strongest alternative

Approach B (exhaustive per-tool pages) — rejected with Dave 2026-08-31: doubles hand-written rot surface while the mechanism content genuinely clusters by concept; the generated tables already carry the per-tool schema detail B would restate. Revisit trigger: if category pages exceed ~4,000 words each despite the collapsible rule, B's atomization wins and the split is mechanical.

## 13. Implementation shape (preview — full plan via writing-plans)

Wave 1: scaffold + extractor + CI (deployable empty shell). Wave 2: concepts + tool surface. Wave 3: runbook + architecture. Wave 4: landscape + evolution (with anonymity review). Wave 5: stale-docs fix wave + README link + polish. Each wave ends with a twining_record and a green local build; the anonymity review gate sits before any evolution content merges.
