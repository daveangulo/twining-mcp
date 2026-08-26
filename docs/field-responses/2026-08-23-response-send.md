# Response send: delivering the read-audit response + the wave-2 verification and routing replies

Three payloads, one send, read in this order:

1. **F2** — `docs/field-responses/2026-08-18-read-audit-response.md`
   (answers the 2026-08-15 read-context audit; committed 2026-08-18, never
   sent; ships **unamended** — its §1 is time-sensitive).
2. **Doc 2** — `docs/field-responses/2026-08-23-wave2-verification-response.md`
   (answers your `2026-08-17-twining-wave2-verification.md`: D14 closed,
   D15 answered with a corrected evidence story, the lineage defect
   confirmed, `twining_verify`).
3. **Doc 3** — `docs/field-responses/2026-08-23-routing-upstream-response.md`
   (answers `TWINING-ROUTING-UPSTREAM.md`: verdict per proposal; for the
   wfos lane, not the design lane).

This file is the delivery wrapper: retrieval, cover note, a ready-to-paste
session prompt for the field machine, and what comes back. It supersedes
`2026-08-16-memo-send.md` as the current send (that wrapper's D14/D15
instructions are corrected in its Errata block and in Doc 2).

**Batch precondition — a gate, not a note.** Doc 2 and the prepared-issues
file (`docs/field-responses/2026-08-23-routing-issues-prepared.md`, named
by Doc 3 §0) are deliverables of the same batch, and the ship memo's and
08-16 wrapper's Errata blocks (both appended 2026-08-25) ride in the same
push; this wrapper's retrieval lines and section references assume all of
them are on `main` before the send. Send gate, run from any directory
before the cover note is dropped — every line must print `ok`:

```sh
RAW=https://raw.githubusercontent.com/daveangulo/twining-mcp/main/docs/field-responses
for f in 2026-08-18-read-audit-response 2026-08-23-wave2-verification-response \
         2026-08-23-routing-upstream-response 2026-08-23-routing-issues-prepared \
         2026-08-13-wave2-ship-memo; do
  curl -fsLo /dev/null $RAW/$f.md && echo "ok      $f" || echo "MISSING $f"
done
curl -fsSL $RAW/2026-08-13-wave2-ship-memo.md | grep -q '^## Errata (2026-08-25)' && echo "ok      memo errata" || echo "MISSING memo errata"
```

Doc 2 references below are by topic (D14, D15, lineage) rather than
section number.

**The send does not wait on any code.** Nothing in the three payloads needs
a release the field does not already have: F2 §1's rescue works on the
build they are running; the lineage defect has an interim housekeeping fix
today; the D15 discriminators are archaeology on their own store. The
2026-08-17 doc's archive condition is acknowledgment, which Doc 2 is.

## 1. Getting the three files onto the field machine

All three, plus the prepared-issues file that rides with Doc 3, are on
`main` of `daveangulo/twining-mcp`. From the field machine, either:

```sh
# from a twining-mcp checkout on that machine
git -C ~/code/twining-mcp pull
SRC=~/code/twining-mcp/docs/field-responses
DST=<field-repo>/<memo-dir>          # see the path note below
cp $SRC/2026-08-18-read-audit-response.md          $DST/2026-08-18-twining-read-audit-response.md
cp $SRC/2026-08-23-wave2-verification-response.md  $DST/2026-08-23-twining-wave2-verification-response.md
cp $SRC/2026-08-23-routing-upstream-response.md    $DST/2026-08-23-twining-routing-upstream-response.md
# the four routing issues as prepared (their text + our per-issue wave-slot
# comment) — forwarded to the wfos lane in place of issue links until filed
cp $SRC/2026-08-23-routing-issues-prepared.md      $DST/2026-08-23-twining-routing-issues-prepared.md
# required: refresh the ship memo — its body is unchanged, but it now ends
# in a dated Errata block that session-prompt step 7 reads before archiving
cp $SRC/2026-08-13-wave2-ship-memo.md              $DST/2026-08-13-twining-wave2-ship-memo.md
```

or without a checkout:

```sh
RAW=https://raw.githubusercontent.com/daveangulo/twining-mcp/main/docs/field-responses
DST=<field-repo>/<memo-dir>
curl -fsSL $RAW/2026-08-18-read-audit-response.md          -o $DST/2026-08-18-twining-read-audit-response.md
curl -fsSL $RAW/2026-08-23-wave2-verification-response.md  -o $DST/2026-08-23-twining-wave2-verification-response.md
curl -fsSL $RAW/2026-08-23-routing-upstream-response.md    -o $DST/2026-08-23-twining-routing-upstream-response.md
curl -fsSL $RAW/2026-08-23-routing-issues-prepared.md      -o $DST/2026-08-23-twining-routing-issues-prepared.md
curl -fsSL $RAW/2026-08-13-wave2-ship-memo.md              -o $DST/2026-08-13-twining-wave2-ship-memo.md   # required: step 7 reads its Errata block
```

**Destination path — still an assumption, now with one data point.** The
08-16 wrapper assumed `docs/twining/`; the field's own verification doc
cites the memo at `analysis/scratch/2026-08-13-twining-wave2-ship-memo.md`
(their §header), so that is where it actually landed. Put the three files
wherever that lane keeps prior Twining memos; the session prompt below
takes the directory as its first line. The `twining-` infix in the
destination names mirrors their naming; drop it if they did not keep it.

Deliver to `agentic-platform-design` first (F2 and Doc 2 address that
lane). Doc 3 addresses the wfos lane — we do not know its path from here;
the session prompt asks the design-lane session to forward it (plan §6.1
assumption 4). The `agentic-platform-code` / `agentic-platform-oss`
siblings need only F2 §1.1 (the rescue) and F2 §1.4 (the upgrade caveat).

## 2. Cover note (drop in the field repo's inbox/handoff channel, or as
the commit message for the three files)

> Three Twining docs, one send, read in order: read-audit response →
> wave-2 verification response → routing-upstream response.
>
> **Time-sensitive first:** `agentic-platform-code` and
> `agentic-platform-oss` are still armed amnesia stores — your 2026-08-17
> doc §1 re-confirmed it (775 and 417 unread records — your audit's corrected
> file counts; your §1 repeats the earlier 776/418 — behind a 0-byte
> `twining.db`). The read-audit response §1 is the rescue and needs no
> upgrade: `npx twining-mcp@latest migrate` in each, or delete the 0-byte
> db. Do it first because it is time-sensitive, not because anything waits
> on it — the archaeology steps (session prompt steps 2–4) run on the
> design store and can proceed in parallel; its order relative to the
> plugin update does not matter either — F2 §1.1 needs no upgrade, and
> 2.16.0's resolver treats a 0-byte db as absent
> (`src/storage/backend-resolve.ts:55-69`) either way. Then report
> `twining_status.active_decisions` per store (its question #4). The
> guard that prevents recurrence shipped in 2.16.0 / plugin 1.34.0; it
> does not import the stranded records.
>
> **D15 is answered: the reopening is not conceded; the memo's instrument
> phrasing is.** Our memo's sentence ("every real promote writes one") was
> ambiguous, and that is our fault: a status post is written only by a call that flips at
> least one id — a call landing wholly in `already_active` writes no post,
> in source at 2.6.0, 2.13.0, 2.15.0 and HEAD (`src/engine/decisions.ts`
> :918 / :1150 / :1219 / :1219). So your single post is exactly what two calls
> (flip, then silent repeat) predict; singularity confirms the two-call
> story rather than refuting it. Your third hypothesis (creation-time
> mirror/db status divergence) is refuted three independent ways —
> measured on 2.6.0/2.13.0/2.15.0/HEAD, in source at all of them, and by
> your own found post, whose `detail` names the id and so can only have
> come from a call whose `promoted` contained it. We did find a real
> defect of ours nearby (promote never dedupes its input, so `[X, X]` in
> one call yields the id in both buckets with one post) — the fix ships in
> W2 (unshipped). Which mechanism produced your incident is field-decidable and Doc 2
> asks for five discriminators; none of them change what we ship.
>
> **D14 closed by mutual agreement**, with two corrections we owe you: the
> `git log -p` instruction was structurally unusable (pathspec restores
> create no commit) — the memo now carries an Errata block saying so; and
> file-wins ingest does not explain your same-turn readback — we do not
> bank it either.
>
> **Your wave-3 lineage defect is confirmed in source** (forward-only
> walk) and ships in W2 (reverse-scan fallback + `lineage_unresolved` +
> counts); ask 3 ships as a write-time transaction with an explicit
> boundary: it cannot defend against an ingest revert. Interim fix today:
> `twining_housekeeping` already backfills one-sided `superseded_by`
> links — preview, then execute, then commit.
>
> **`twining_verify`**: the runtime half (per-file git log, per-entry
> scope fetch) was fixed in 2.16.0 before your measurement reached us;
> the ~198K-token payload is W4, with your numbers as the acceptance
> criteria. Re-measure once on ≥2.16.0.
>
> **Routing proposals** (Doc 3, for the wfos lane): P1 diagnosis
> accepted, fix corrected (their composition mis-handles subdir-of-
> worktree; `gitRootOf` does not exist yet); P2 accepted with the rule
> reworded (the server never ancestor-walks — it creates at cwd); P3
> merged with our own store-identity work; P4 goes design-doc-first.
> Filing is ours to do (your EMU account cannot); the four issues are
> prepared, not yet filed — if and when they are, the numbers come to you
> in a separate note mapped to your #(F1)–#(F4) placeholders (Doc 3 §0).
> Until then the prepared file carries your text plus our wave-slot
> comment per issue.
>
> Archive your 2026-08-17 doc on receipt — its condition was
> acknowledgment, met by Doc 2. The ship memo's own gate (≥2.15/≥1.33)
> was already met per your §1; read its Errata block, then archive it.

## 3. Session prompt for the field machine (paste into a Claude session
in the `agentic-platform-design` repo)

```
The Twining response docs are in <memo-dir>/:
  2026-08-18-twining-read-audit-response.md           (F2)
  2026-08-23-twining-wave2-verification-response.md   (Doc 2)
  2026-08-23-twining-routing-upstream-response.md     (Doc 3)
  2026-08-23-twining-routing-issues-prepared.md       (Doc 3's four issues, as prepared)
  2026-08-13-twining-wave2-ship-memo.md               (refreshed copy; Errata block at its end — step 7)
Read F2 §1 first, then Doc 2 in full, then Doc 3's cover. Execute:

0. Build state, every scope. `claude plugin list` for user scope AND every
   project scope on this machine — your 2026-08-17 doc §1 named three
   project scopes still pinning 1.24.1 / 1.26.0 / 1.30.0. Update to
   ≥1.34.0 in every scope that pins it: user scope is `claude plugin
   update twining@twining-marketplace`; each project pin is, from inside
   that project, `claude plugin update --scope project
   twining@twining-marketplace` (`-s, --scope <user|project|local|managed>`
   on the CLI we checked 2026-08-25 — use the scope `claude plugin list`
   shows for that row; if your CLI lacks `--scope`, running the update
   from inside the project is the fallback). Re-run `claude plugin list` afterward: every row
   must read ≥1.34.0 (a stale project pin shadows user scope). Restart,
   then call twining_status: from 2.16.0 it returns server_version,
   backend, and backend_reason. If server_version is ABSENT you are on
   <2.16.0 — the absence is itself the version signal; see F2 §1.4 for
   why a plugin update alone may not move an npx-rung session. Stamp
   every number below with the server_version it was measured on. Step 1
   does not depend on this step — either order works.

1. Rescue the amnesia stores (F2 §1.1, no upgrade required). From each of
   agentic-platform-code/ and agentic-platform-oss/ (and
   claude-code-explore/ if it is still armed) run `npx twining-mcp@latest
   migrate --project "$PWD"` — it is a CLI, any shell works, but pin the
   root: without `--project` the CLI resolves the store exactly as the
   server does, so a `TWINING_PROJECT` exported in that shell would
   redirect the rescue, and its report never prints which store it
   touched (`src/migrate/cli.ts:19-23`, `:79-84`) — and paste its
   `decisions: N` line; or delete the 0-byte twining.db. For the
   twining_status readback (F2's verification question #4:
   active_decisions, plus backend/backend_reason if ≥2.16.0 — absent on
   older builds), open a session IN each sibling repo: twining_status
   reports only the store the server is bound to, so the design-lane
   session cannot read the siblings. If those sessions cannot be opened
   this pass, the migrate line is the acceptable readback. Expected
   `active_decisions`: 770 / 417 / 150 (F2 §1.5, Doc 2 §5 — file count minus
   superseded, not the index count). Sweep the
   latent stores per F2 §1.2.

2. Repair the D14 target's lineage now (Doc 2's lineage section, interim
   fix). FIRST snapshot the metrics file — `cp .twining/metrics.jsonl
   <safe-path>` — and extract F2 #3 from it (step 3 below): the execute
   call in this step rotates metrics entries older than 30 days, which
   is the "before" half of that split. Then, on the design store:
   twining_housekeeping({}) — preview — and read superseded_backfill: it
   should list
   { id: 01KZVRHRTP519Q93NC961RS1FR, superseded_by: 01KZW2Q3WHD7QN2GHKZEAP3BMW }
   plus any other one-sided links. If the preview's `items` omits the id,
   check `dangling` (the supersessor's target was unreadable) and whether
   twining_why already shows superseded_by on it (backfill skips a target
   that already carries one) before treating it as a defect. Then
   twining_housekeeping({execute: true}) — leave promote_provisionals and
   archive unset (both default false; your ratify queue is untouched).
   The backfill pass writes the pointer only and preserves status, but
   execute:true is not backfill-only: it also rotates metrics.jsonl
   entries older than 30 days, dismisses duplicate blackboard entries
   (tombstoned), prunes relation-less graph entities, and on sqlite runs
   a WAL checkpoint — read the preview's metrics_rotated, deduplicated
   and graph_pruned counts first; non-zero there is expected, not a
   defect. Then COMMIT .twining/ immediately — review `git status
   .twining/` for deletions before `git add` (your §2 incident): the
   repair is a mirror write like any other lifecycle write, and until it
   is committed it is exposed to the same file-wins revert that ate the
   original supersession. Verify: twining_why({scope:
   "specs/registry-service/", lineage: true}) — the target row now
   carries superseded_by: 01KZW2Q3WHD7QN2GHKZEAP3BMW and a lineage_head
   that is the terminal of the forward walk from it (01KZW2Q3… itself if
   it has no superseded_by; otherwise whatever it resolves to — your §4
   names 01KZW28ZNQT98H02DG95CMRKD4 as the live replacement). Report the
   head it resolves to, not a mismatch against either id, plus
   fixed/dangling counts.

3. Answer Doc 2's D15 discriminators, all five, from your own store and
   transcripts: (a) the original promote call's response payload verbatim
   — was `promoted` truly `[]`, and did the request's decision_ids
   contain the id more than once? (b) that call's timestamp relative to
   the found post's 2026-08-13T04:33:49.802Z; (c) the found post's
   agent_id (a non-'main' name identifies promote#1's actor; 'main' is
   uninformative); (d) session/transcript evidence of an MCP-timeout
   retry of the promote — you report chronic MCP-budget blowouts;
   (e) every twining_housekeeping call in the 04:19–04:38Z window and
   whether any passed promote_provisionals — the one silent promote lane.
   Then the continuing verification questions: F2 #3 (twining_record
   error_code distribution from the metrics.jsonl snapshot you took in
   step 2, split before/after your 1.24.0-era sessions), F2 #5 re-run on
   ≥2.16.0 with server_version stated, and Doc 2's own #6 (the five
   discriminators above), #7 (the verify re-measurement, step 4) and #8
   (the backfill result, step 2). Do NOT name a single root cause —
   report the discriminators; Doc 2 explains which mechanism each one
   selects.

4. Re-measure twining_verify on ≥2.16.0 with the same call as before:
   twining_verify({scope: "specs/"}). Report wall-clock and payload
   tokens, and server_version. Expect the runtime to drop from minutes to
   seconds (2.16.0, commit 8809cff); expect the payload to still be large
   — bounding is W4 and your 198K / 120s figures are its acceptance
   criteria. Report both numbers even if the call still blows the MCP
   budget; the split is the point.

5. Forward Doc 3 to the wfos lane (the lane that wrote
   TWINING-ROUTING-UPSTREAM.md). Filing state is read from the CURRENT
   Doc 3 on main, not your local copy — a filing line, if any, is
   appended to the end of that file after the send:
   `curl -fsSL https://raw.githubusercontent.com/daveangulo/twining-mcp/main/docs/field-responses/2026-08-23-routing-upstream-response.md | tail -20`.
   As of this send there is none: forward
   2026-08-23-twining-routing-issues-prepared.md — their own issue text
   plus our per-issue wave-slot comment — and say the numbers follow when
   filed. Do not wait for them. (If a filing line has appeared by the time
   you run this, forward the issue links instead.) Bring back: (a) Doc 3
   §5 item 1 — does the corrected P1 composition (repo root, then worktree
   main) retire the placement ruling requested in bcs/wfos-chassis#58, as
   their cover note claimed? (b) — ours, not in Doc 3 §5 — if Doc 3
   §1.2's two P1 corrections change anything they want in Issue 1's text
   before filing, say so; otherwise it files as prepared (Doc 3 §0:
   their text essentially verbatim). Doc 3 §5 items 2–3 are post-W3 —
   not due now. Step 6 does not wait on the wfos lane: if their answers
   are not back when you write the response doc, record item 5 as
   PENDING with the forward date; the wfos lane sends its answers as its
   own file (or a section appended to yours) and it is carried back the
   same way.

6. Write the answers to 1–5 as a response doc in <memo-dir>/ named by
   your date in your own pattern (e.g.
   2026-08-2X-twining-wave3-verification.md), stamped with HEAD,
   server_version and plugin pin per your own measurement-instant rule;
   twining_record it; commit. It gets carried back to the twining-mcp
   repo.

7. Archive: your 2026-08-17 wave-2 verification doc (its STATUS condition
   — acknowledgment of the D15 reopening and the lineage defect — is met
   by Doc 2, which answers both); and the 2026-08-13 ship memo — its gate
   (≥2.15/≥1.33 plus the CLAUDE.md retirements) was already satisfied per
   your §1 and §5 — after reading the Errata block now appended at its
   end, in the refreshed copy placed in <memo-dir>/ by this send (not
   your analysis/scratch original, which predates the block; the body
   above the block is unchanged). F2 states no archive condition of its own: treat it as
   done once step 1's rescue is complete and F2 #3/#4/#5 are in your
   response doc. Doc 2: per its STATUS line. Doc 3: do NOT archive — it
   stays LIVE with the wfos lane until its filing line is appended and
   W3 ships (its §5 items 2–3 are post-W3 asks).
```

## 4. What comes back

One file from the design lane, `<their-date>-twining-wave3-verification.md`,
plus the wfos lane's reply (possibly separate — step 5 does not make the
design-lane doc wait on it), carrying:

- **Rescue counts** (F2 #4): `active_decisions` + `backend`/`backend_reason`
  per de-armed store, against the expected 770 / 417 / 150 (F2 §1.5; Doc 2 §5
  carries the 775/417 file-count reconciliation).
- **Lineage repair**: `superseded_backfill` preview and execute counts, the
  post-commit `twining_why … lineage: true` row for
  `01KZVRHRTP519Q93NC961RS1FR` now carrying `superseded_by` +
  `lineage_head`. Reading rule: backfill skips a target only when it
  already carries `superseded_by` or its supersessor's target is
  unreadable (counted in `dangling`; `src/engine/housekeeping.ts:519-527`)
  — if the preview's `items` omits the id, diagnose from those two before
  escalating. Only a row that was listed in the preview and is still
  one-sided after execute + commit is new evidence for the W2 breakdown —
  bring the housekeeping result verbatim.
- **D15 discriminators (a)–(e)** (Doc 2 #6) plus F2 #3/#5 and Doc 2 #7/#8. How to read
  them (Doc 2's D15 section has the full mapping): a verbatim `promoted: []` with
  no duplicate in `decision_ids` selects two calls; a duplicated id in one
  request selects our input-dedupe defect; a non-'main' `agent_id` on the
  post or a transcript retry identifies promote#1's actor; a
  `promote_provisionals` housekeeping call in the window selects the
  silent lane. **The old criterion in the 08-16 wrapper ("post absent AND
  no trace fits → reopen") is superseded**: a present post beside an
  `already_active` readback is the predicted shape, not a contradiction.
  Whatever comes back selects among mechanisms; every fix in W2/W4 ships
  regardless.
- **`twining_verify` re-measurement** on ≥2.16.0: wall-clock, payload
  tokens, `server_version`. Seconds-class runtime confirms 8809cff at
  their scale and decides whether W4's git-spawn item is scheduled or
  retired; the payload number is carried into W4's acceptance test.
- **The wfos lane's answers** — or `PENDING` with the forward date, if
  they had not come back when the design-lane doc was written: Doc 3 §5
  item 1, the #58-retirement claim; and our own optional question, whether
  Doc 3 §1.2's corrections change anything they want in Issue 1's text
  before we file (silence = file as prepared). §5 items 2–3 are post-W3
  and not expected here.
- **Build-state stamp** from step 0 — needed because three stale project
  pins on that machine are the expected source of any future report that
  contradicts these docs (their own §1 advice: ask for the pin first).

Anything unanswerable from their side (e.g. the original promote payload
was never captured) is a valid answer — say so and the discriminator is
simply unavailable; do not reconstruct it.

*Version anchors: every `file:line` in this wrapper is HEAD `0f65ef0`
(2.16.0 / plugin 1.34.0) except the per-version `decisions.ts` guard
lines, which are stamped with their version inline; commit `8809cff` is
in `v2.16.0`.*
