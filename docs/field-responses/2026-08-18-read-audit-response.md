# Response: read-context quality audit of 2026-08-15 — dispositions, corrections, and what shipped

**STATUS: disposition complete — Wave 1 of the fixes SHIPPED as `twining-mcp 2.16.0` / plugin `1.34.0` (2026-08-18).**
Authored 2026-08-18 by the Twining project in response to the read-path
audit report of 2026-08-15. Every finding was classified against HEAD by a
12-cluster triage (one agent per finding cluster, file:line evidence, every
FIXED/INVALID/PARTIAL verdict adversarially challenged), and the fixes then
survived our standing pre-tag review (7 lenses, every finding adversarially
verified — that review caught majors in our own fixes for the 8th
consecutive release, three of them in code written *for this response*;
they are fixed and regression-pinned in the shipped build).

**How to read this:** §1 is what to do today — your three amnesia stores
are rescuable *now*, before any upgrade. §2 untangles which build measured
what, because it changes how several of your findings resolve. §3 is the
full disposition table. §4–§5 are the corrections we owe you and the
confirmations you asked for. §8 answers your §7 CLAUDE.md list. §10
corrects two things in the memo we already sent you.

First: this is the most useful external review this project has received.
The thesis — that a defect set failing uniformly toward "nothing to do"
compounds into a coherent false picture of a quiet store — is confirmed,
was reproduced live on our own store during triage, and is now the
organizing principle of a four-release remediation plan. Your published
retractions made the report *more* credible, not less, and several of them
saved us from fixing the wrong thing.

---

## 1. Do these now (no upgrade required)

1. **De-arm the three amnesia stores today.** Your own arms B and C are the
   rescue: in each of `agentic-platform-code/`, `agentic-platform-oss/`,
   and `claude-code-explore/`, either run `npx twining-mcp@latest migrate`
   (arm C — imports the legacy tier into sqlite) or simply delete the
   0-byte `twining.db` (arm B — the store reverts to the files backend and
   reads correctly). Do not wait for the guard fix to reach you; the guard
   prevents *recurrence*, it does not import your 1,342 stranded decisions.
2. **Sweep the twelve latent stores** the same way — any 0-byte
   `twining.db` beside legacy content is one boot away from the same state.
   After 2.16.0 the auto-resolver ignores 0-byte/garbage db files entirely,
   so the latent class is disarmed going forward.
3. **Commit the report file.** Your own §7 operational note: it is
   untracked in a shared checkout, which is the one combination
   `git checkout --` cannot restore. It is the best external review this
   store has produced; it should not live only in `/tmp` notes.
4. **Upgrade, with one caveat our earlier memo missed:** update the plugin
   to ≥1.34.0 **and note that a plugin upgrade alone does not move your
   npx-rung sessions** — the launcher prefers the registry-resolved server
   (rung 1), and if a registry age-policy or cache is what pinned you to
   2.6.0, it will keep doing so until that window passes regardless of the
   plugin version. Until then, your one-call self-test stands
   (`twining_amend` present → 2.13-class); from 2.16.0 the class is closed
   permanently: **`twining_status` returns `server_version`** (plus
   `backend` and `backend_reason`), so a session can finally tell what
   serves it.
5. **Verify the rescue** with a derivation that cannot lie sideways: after
   de-arming, `twining_status.active_decisions` in each store should match
   your legacy-index counts (770/766-class for `agentic-platform-code`,
   417, 150 — your arm-C measurement showed migrate also salvages the 4
   index-desync orphans, so expect the post-migrate number to be the
   *file* count, not the index count).

---

## 2. Build provenance — what measured what

This section changes how several findings resolve, so it comes before the
table. The registry timeline (npm publish timestamps, checked from our
side):

| date | npm `latest` | plugin bundle |
|---|---|---|
| 2026-08-12 | 2.7.0 → 2.8.0 | 1.26.0 (2.8.0) |
| 2026-08-13 | 2.9.0 → 2.12.0 | 1.27.0–1.30.0 |
| 2026-08-14 | 2.13.0 | 1.31.0 (2.13.0) |
| **2026-08-15 (audit day)** | **2.13.0** | **1.31.0 (2.13.0)** |
| 2026-08-16 | 2.14.0, 2.15.0 | 1.32.0, 1.33.0 |
| 2026-08-18 | **2.16.0** | **1.34.0** |

Three consequences:

- **Ask 0a's premise does not hold: npm was never behind the bundle.** On
  audit day both were 2.13.0. Your session resolving 2.6.0 through npx is
  a field-side resolution artifact — most consistent with a registry
  minimum-release-age policy or an offline/cached packument (we cannot
  prove which from here; your `npm view` being unrunnable is itself
  consistent with a constrained registry path). This is *worse* news than
  a publish lag in one way: it means it can recur, and it is why the
  self-identification fixes (server_version in responses) shipped first.
- **Your S3-A "regression window, diff 1.30.0→1.31.0" theory is wrong —
  nothing regressed.** The honest `total_matched`/`returned` split shipped
  in **2.9.0** (2026-08-13) and never went away. Your session measured
  2.6.0; your reviewer's session measured 2.13.0; both were correct about
  the build they touched. There is no diff to hunt.
- **Every "verdict on the running build" in your report is a verdict on
  2.6.0**, which predates the entire 2.7–2.15 fix train. The table below
  therefore distinguishes "fixed before your audit (you measured an old
  build)" from "fixed in 2.16.0 because of your audit" from "open/planned".

---

## 3. Disposition table

Verdicts are against 2.16.0. "≤2.9.0" = was already fixed when you audited;
you measured the 2.6.0 arm. **W2/W3/W4** = scheduled waves of the
remediation plan (read-path honesty / scope semantics / payload contracts).

| Your finding | Verdict | Disposition |
|---|---|---|
| **S0** 0-byte db → silent total amnesia | **Confirmed — your top-ranking was right; it was live at HEAD and our own tests enshrined it** | **Fixed 2.16.0**: `twining.db` counts as sqlite state only with nonzero size AND the SQLite magic header; ambiguity lands on `files` per the module's own rule. The two tests that asserted the 0-byte→sqlite behavior were rewritten; your arm A/B/C matrix is now the regression suite |
| **S0** explicit `backend: sqlite` arm also silent | **Confirmed** | **Fixed 2.16.0**: runtime check at the factory covers the explicit path the resolver never sees — legacy content a tier's table lacks warns loudly at boot AND leads `twining_status` warnings. Tier-matched and id-precise (see §6) |
| **S0** warning inverted (safe path warns, dangerous silent) | **Confirmed** | **Fixed 2.16.0** as above |
| **S0** no tool reports the backend | **Confirmed** | **Fixed 2.16.0**: `twining_status` → `backend`, `backend_reason` (`sqlite-state \| legacy-content \| fresh \| explicit \| fallback`) |
| **S0** v1 index desync silently hides decisions | **Confirmed** | **Fixed 2.16.0**: status warns with the count; `twining_housekeeping({repair_index: true, execute: true})` salvages under the index lock (shape-gated — see §7) |
| **S0-B** two builds, sessions can't tell which | **Confirmed** | **Fixed 2.16.0**: `server_version` in status. Launcher rung order unchanged (deliberate — see DD-3, §9) |
| **S1-A** assemble budget starvation + false "No active decisions" | **Confirmed at HEAD — reproduced on our own store during triage** | **W2** (2.17.0): `decisions_in_scope`/`decisions_omitted`/`truncated`, the sentence gated on verified-zero, a reserved decisions floor. Shipped now (2.16.0, docs): the `token_estimate ≈ max_tokens` truncation signature and the large-`max_tokens` workaround are in the tool description — your caller-side cure, published |
| **S1-A** `decisions_count` is not a scope census | **Confirmed — your three-layer mechanism v3 is exactly right** | **W2** + shipped docs note ("selection, not census; use `twining_why total_in_scope`") |
| **S1-B** three tools, three populations, none documented | **Confirmed; your unconfirmed hypothesis verified in source** (§5) | **W2/W3**: per-tool population docs + `affected_files` on why |
| **S1-C** fabricated-scope imperative briefing | **Confirmed** | **W3**: `scope_resolved: false` labeled notice (never a hard error — first-touch virtual scopes are legitimate) |
| **S1-D** continue-work status frozen at write time | **Partial** — age stamps + the scopeless-leak fix shipped 2.10.0, which is why your reviewer's probes saw no replay; live-status join still absent | **W2**: suppress acknowledged handoffs; no bare `[BLOCKED]` without age. (Handoff surface is deprecated (#33) — we won't build joins on a tier scheduled for removal) |
| **S1-E** `why` scope match is raw bidirectional prefix | **Confirmed — `"spec"` really out-matches `"specs/"` at HEAD; your (a)/(b)/(c) split is the right cut** | **W3** (2.18.0, isolated behavior-change release): segment-boundary matching preserving ancestor inheritance, `matched_via` per row, `directly_scoped_count` — your existence-check becomes possible. Cheaper than you feared: the exact/descendant/ancestor classification already exists internally, unexposed |
| **S1-F** store root frozen; cd cannot retarget | **Confirmed; the freeze is inherent to stdio spawning — the defect is the silence** | **W3**: store identity echoed in every response via the single result seam. Per-call project param declined (reopens store lifecycle/locking) |
| **S2-A** export/read/recent/neighbors unbounded | **Confirmed** | **W4** (2.19.0): shared disclosure shape + budget knobs; read/recent detail truncation with an `ids:` full-fetch escape hatch; export knobs full-by-default |
| **S2-B** token_estimate echoes the budget | **Confirmed** | **W2**: measured from the serialized payload; `max_tokens` bounds the whole response |
| **S2-C** verify unaffordable, superlinear | **Confirmed — your one-line-hoist diagnosis was exactly right** | **Fixed 2.16.0**: scope population fetched once (was per stale file), git log memoized per distinct file (was per entry). Call counts pinned by test. Bounding/`skip_reason`/clean-set: **W4**; content-hash drift signal: DD-1 (§9) |
| **S2-D** ratify-queue derivations | **Partial** — the count mechanisms were fixed in 2.9.0; the canonical declarations were missing | **Fixed 2.16.0 (docs)**: status description declares `provisional_decisions` the canonical store-wide count; triage description declares `counts.open.by_kind.decision` the scoped variant and warns off `open.total`. Mechanism correction in §4 |
| **S2-E** stop hook | **Your withdrawal was correct; the surviving marker-path gap was real** | **Fixed 2.15.0/plugin 1.33.0** (edit-path filter, canonicalized, worktree-aware) — verified against your exact `/tmp`-notes scenario. Also: our `docs/hooks.md` still described the pre-1.16 mtime design your readers diagnosed — plausibly the source of the misread; rewritten, with a read-only audit recipe |
| **S3-A** `total_matched = min(limit, …)`, no `returned` | **Was already fixed when you audited (2.9.0)** — your 2.6.0 session measured the old build | Shipped addition (2.16.0): `count_semantics: "pre_page_floored_v2"` on every search/query response — your ask 2, the permanent end of the generation-skew class |
| **S3-B** no relevance floor; band uncalibrated | **Partial** — the floored `total_matched` shipped 2.9.0; but your data shows the hardcoded 0.30 floor sits *below* your plausible-absent class (0.337), which is the strongest argument for your do-not-hardcode ask | **W2**: configurable `relevance_floor` + `top_relevance` echo. Your T≈0.45 stays store-calibrated, not shipped as a constant |
| **S3-C** lifecycle-blind ranking | **The rank deboost shipped 2.9.0** (your measured instance re-scores below the superseders); your two *cheaper preferred* remedies had not shipped | **W2**: `superseded_by` projected onto search rows; `status` array / `exclude_status`. Your "a superseded decision's CHOICE is dead; its ARTIFACTS may still be in force" rule is quoted in our plan |
| **S3-G** search blind to blackboard tier | **Confirmed** | **W2**: `blackboard_matches_excluded` count on search_decisions; query-tier fixes (`decisions_total_matched` was computed then discarded; `decisions_excluded_by_filter`; filter passthrough). Your dedup-by-id trap: see §7 mirror note |
| **S3-D** disclosure inconsistent across surface | **Partial** (2.7.0/2.9.0 closed three rows of your table) | **W4**: one shared disclosure contract across every record-returning tool; your "prose vs fields" pattern gets a dedicated audit pass with sentences generated *from* the fields |
| **S3-E** graph write-only | **Direction already settled** — 2.11.0–2.15.0 invested heavily in the graph (origin markers, upsert, dedup, indexes) | Not re-litigated; the remaining surfacing work is the tracked neighbors reduced-form item, now widened to include `limit` + payload dedup (**W4**) |
| **S3-F** narrow scope doesn't cut cost | **Confirmed** | **W3** docs + optional `scope_match` param after the matcher change |
| **S4-1** double render | **Confirmed — reproduced on our own store** | **Fixed 2.16.0, both halves**: assemble render AND read/query/recent responses; the assemble budget now costs the deduped text, so the reclaimed space reaches selection capacity too |
| **S4-2** record 10.3% INVALID_INPUT | **Cause profile is build-relative**: the dominant historical cause (over-length summary rejection, ~38% of failures) died in 1.24.0, before your audit; per-decision/per-finding failures became soft response fields earlier still | Shipped 2.16.0: empty summary → named repairable message; `reason_rejected` optional on record AND decide (BEHAVIORS DECIDE-02 reworded to match). Residual rate: we need your data — **verification question #3, §11** |
| **S4-3** agent_id free-text, 84.6% unknown | Confirmed; design decision | DD-4 (§9) |
| **S4-4** metrics lack size/count/scope | **Confirmed — "highest value per line" was right** | **Fixed 2.16.0**: `response_bytes`, `result_count` (best-effort first-array), `scope` on every metrics entry |
| **S4-5** dead v1 artifacts mislead | Confirmed | **W4**: MIGRATED-README marker (zero-risk half); relocation stays a design call ("legacy files are their own backup" is deliberate) |
| **S4-7** uncheckpointed WAL | **Confirmed — no checkpoint policy existed anywhere** | **Fixed 2.16.0**: housekeeping execute runs `wal_checkpoint(TRUNCATE)`; the server closes the db on session end (signals AND stdin close), which checkpoints |
| **S4-8** discover returns 95 zero-overlap "matches" | **Confirmed** | **Fixed 2.16.0**: zero-overlap excluded by default with `excluded_zero_overlap` count (absence stays reportable); `min_score: 0` restores the roster; `twining_delegate` carries the same count |
| **S4-9** archive threshold / committed rolls undetectable | **Split**: the threshold counting the archivable partition is documented design (the #35 loop fix — do not "fix" the count); roll detectability is real, and our review found the compactor can eat legitimate roll markers as loop junk | **W4**: archive stats in status/housekeeping + compactor signature fix. Mirror-authority half folds into the named file-wins precedence decision (DD-8) |
| **S4-12** commits: typo ≡ unlinked | **Confirmed** | **Fixed 2.16.0**, twice: our first fix's `false` branch was dead code (`cat-file -e <hash>^{commit}` exits 128 for missing objects — caught by our own pre-tag review) — shipped form uses `rev-parse --quiet --verify` with empirically verified exit codes, plus **prefix-aware hash lookup in both backends** (stored 7-char links vs full-SHA queries missed in both directions) |
| **S4-14** no read-only mode; status mutates | **Confirmed** | **W4**: `.gitignore` reconciliation moves off the pure-read boot path; full `TWINING_READ_ONLY` mode is DD-6. Shipped now: the read-only audit recipe in `docs/hooks.md` (including the pending-queue caveat our own review caught) |
| **S4-15** archived-visibility untested | **Was already defined + tested when you audited (2.9.0)**: archived decisions are included, de-ranked, and the description says so | One residual wart you'll recognize: a status filter matching zero candidates reports `fallback_mode: true` (mislabel, matches your "only fallback_mode call" observation) — W2 ride-along |
| §3 "good use today" sequence | Endorsed | Steps 1–3's blind spots shrink each wave; step 0 (git log first) we simply agree with |

---

## 4. Corrections we owe you

Named plainly, since your report modeled exactly this.

1. **S2-D's mechanism dispute resolves as: both sides were right about
   different builds.** Your measurement (limit-clamped counts, "a nonsense
   query returned the whole population", "`total_matched: 0` with rows
   cannot occur") is correct **for 2.6.0** — and dead at ≥2.9.0, where the
   count is a floored pre-slice population and `total_matched: 0` beside
   rows is real and *meaningful* ("nothing above the noise floor"). The
   store provisional you discredited described ≥2.9.0 behavior; your
   refutation of it was measured on 2.6.0. Neither instrument was lying;
   they were pointed at different servers — which is your own S0-B finding,
   applied one level deeper. `count_semantics` exists so this class of
   dispute can never need a four-agent investigation again.
2. **Your S1-A fill-order model is not literally the code's** — warnings
   fill first from the full budget, non-warnings then compete score-ranked
   under a 90% cap, needs get a safety pass, and handoffs bypass the budget
   entirely. Your *conclusion* (decisions starve exactly where governance
   is densest) is confirmed and unchanged; we note the mechanism only so
   the W2 fix (a reserved decisions floor) reads as the right shape.
3. **Our earlier fix for your S4-12 would not have closed it** — our
   pre-tag review proved the existence probe's "no such commit" branch was
   unreachable and the lookup could assert "never linked" about a linked
   commit queried by its short form. Both are fixed in the shipped build;
   we mention it because your report's standard ("a fix that does not close
   the audited scenario is a major") is the standard our review now runs.

## 5. Confirmations you could not make from outside

- **S1-B hypothesis confirmed in source**: `why`'s population is
  scope-match OR `affected_files`-match OR symbol-exact
  (`decision-store.ts getByScope`); `summarize` counts scope-string
  ownership only. Your 4/4 prediction (`why ≥ summarize`) is code fact.
- **Your "no read tool exposes affected_files" meta-finding**: confirmed;
  scheduled W2 (full rows + `ids` drill-down on `why`).
- **S1-E is cheaper to fix than your report assumed**: the
  exact/descendant/ancestor classification already exists inside `why`'s
  ranking (`whySpecificity`) and is discarded; `matched_via` is exposure,
  not new matching machinery.
- **Your S2-E retraction was right, and the trail that misled your readers
  was ours**: `docs/hooks.md` still documented the pre-1.16 mtime design
  ("four hooks", no activity-marker section). Rewritten.

## 6. What shipped in 2.16.0 — precision notes

Two mechanisms worth knowing beyond the table:

- **The amnesia warning is tier-matched and id-precise.** It compares each
  legacy tier against *its* table (a migrated blackboard-only store's
  forever-empty decisions table no longer cries wolf — a trust-critical
  warning must not train you to ignore it), and where the legacy decisions
  index is readable it flags any legacy id absent from the db — so
  post-flip decisions accumulating on top of an unread legacy tier (the
  long-lived variant of your S0) no longer mask it. The reverse shape also
  warns: a sqlite→files *fallback* boot beside a populated `records/` tree
  reports `records_unread` — that session may be reading stale history.
- **The index repair is shape-gated.** Only files that are recognizably
  decisions with id matching the filename are salvaged; strays (merge
  artifacts, index backups) count in `skipped_invalid` and are never
  modified — our review demonstrated an unvalidated salvage could poison
  the index and take down every scope read, which would have been your
  "advertised remediation makes it worse" pattern.

## 7. One trap note for your side

Your S3-G mirror-dedup observation (105 legacy `entry_type: "decision"`
posts with distinct ULIDs from their store twins): correct, and do NOT
dedupe by id. One nuance from our archaeology: entries of that type can
also be *direct agent posts* from before 2026-02 (the type was only closed
to callers then), so "legacy-era decision entry" ≠ "auto-mirror" in every
case. W2 ships a `legacy_mirror` annotation on the posts tier plus a
housekeeping census so your stores can see their exposure; back-filling
`source_decision_id` happens only on exact-summary unique matches.

## 8. Your §7 CLAUDE.md corrections — verdicts

1. *"`twining_why` is scope-exact" is false* — **confirmed in source**;
   keep your correction until W3 ships segment-boundary matching +
   `matched_via`, then re-derive.
2. *"`total_matched: 0` with rows MEANS ABSENCE" is inoperable* — true on
   2.6.0, **false at ≥2.9.0** where that state is real and means "below the
   noise floor". After your upgrade, check `count_semantics` and re-instate
   the rule for `pre_page_floored_v2` responses.
3. *Ratify derivations* — adopt: `twining_status.provisional_decisions`
   (canonical, store-wide) and `twining_triage counts.open.by_kind.decision`
   (scoped). Both are now stated in the tool descriptions themselves.
4. *Retirement rationale named the wrong mechanism* — see §4.1; on
   ≥2.9.0 the "relevance-floor" description is the correct one.
5. *`[BLOCKED]` phantom remedy vacuous* — your evidence critique stands;
   the class shrank in 2.10.0 (age stamps + scopeless-leak fix) and W2
   suppresses acknowledged replays entirely.
6. *`verify` unaffordable* — re-measure after upgrading: 2.16.0 removes
   both cost terms you identified (your 5–8 min calls should drop to
   seconds at your scale). Keep the "cannot see populated-but-untouched"
   caveat — that is structural until DD-1.

## 9. Named design decisions (not patched, deliberately)

| ID | Question | State |
|---|---|---|
| DD-1 | Non-temporal drift signal (content hash at record time) + verify partial results | Decided together with the tracked diff-capture follow-up |
| DD-2 | Bundle without `@huggingface/transformers` (your withdrawn workaround note was right — forcing the bundle kills semantic search) | Open: project-local `createRequire` fallback vs status quo; stakes reduced now that the bundle's keyword mode is honestly labeled |
| DD-3 | Launcher rung order / PKG_SPEC exact-pin | Open: an exact pin would have kept your sessions off 2.6.0 but trades availability under age policies — your report's own bundle measurement argues against bundle-first |
| DD-4 | agent_id identity model | Open |
| DD-5 | record INVALID_INPUT residual rate | **Blocked on your data — question #3 below** |
| DD-6 | Full read-only server mode | After W4's reconcile-deferral half |
| DD-8 | File-wins ingest precedence (your S4-9 mirror-authority evidence folded in) | Named decision, standing do-not-patch |
| DD-10 | Retrieval v2: FTS5+BM25 hybrid, first-class exact-match mode, sibling clustering, kind weighting (your S3-B asks c/d) | Spec after W2; exact-match mode ships in W2 |

## 10. Corrections to the memo we already sent you

1. Its open-follow-ups list still shows the **sqlite relation-lookup index
   as open — it shipped in 2.15.0** (the memo's own §changelog says so two
   sections earlier). Ignore the stale line.
2. Its verification step references a version report that **did not exist
   when we sent it** — as of 2.16.0 it does: `twining_status.server_version`
   is the check.
3. It lacks the npx-rung caveat now stated in §1.4.

## 11. Verification questions (numbering continues from the memo)

3. **The `twining_record` error distribution** (for DD-5): from your
   `metrics.jsonl`, the `error_code` + message distribution of failed
   `record` calls, ideally split before/after your 1.24.0-era sessions.
   Your 10.3% aggregates all history; we believe the dominant cause died in
   1.24.0 and need your data to size what remains.
4. **Post-rescue counts** (§1.5): after de-arming the three amnesia
   stores, `twining_status.active_decisions` per store, so both sides can
   pin the recovery against your legacy-index counts.
5. **Post-upgrade re-probe of your §3 sequence**: with `server_version`
   confirming ≥2.16.0, re-run your steps 1–3 on one warning-dense scope.
   Our claim to falsify: step 1's briefing still starves decisions (W2 is
   unshipped) **but** its description now tells you so, and steps 2–3's
   counts now carry the fields your workarounds reconstructed by hand.

---

*Fix train context for your changelog reading: 2.9.0 = honest search
counts + noise floor + retired-status deboost; 2.10.0 = amend + handoff age
stamps; 2.13.0 = relation dedup; 2.14.0 = persist-honest lifecycle writes;
2.15.0 = revert-warning surface + hook edit-path filter; 2.16.0 = this
response's Wave 1. CHANGELOG.md now carries full entries for 2.13.0–2.15.0
(2.13.0 was tag-only with no changelog entry when you audited, and
2.14.0–2.15.0 initially shipped the same way — your "no version signal"
complaint applied to our release notes too).*
