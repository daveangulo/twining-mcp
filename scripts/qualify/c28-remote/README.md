# C28 remote qualification bundle

A self-contained runbook a human executes on a **second computer** to produce an
artifact bundle the lead can verify. Oracle: `test/acceptance/oracles/C28.oracle.md`.

> **This has never been run on a second machine.** Everything below was written
> and exercised on the development machine only (macOS/arm64, node 26). Until
> Dave runs it end to end on the other computer, C28 is **not-tested**, and the
> substitution notice in `meta.json` says so in the bundle itself.

## What you need

- A second computer with `git`, `node >= 22.13` (the v3 store uses `node:sqlite`) and network access to clone the repo.
- Nothing else. No Twining install, no credentials, no remote service. The runner creates a **disposable bare git repository** in its own work directory and deletes nothing outside it.

## Run it

```sh
git clone <repo-url> /tmp/c28-src && cd /tmp/c28-src
./scripts/qualify/c28-remote/run.sh \
  --repo <repo-url-or-path> \
  --commit <sha> \
  --carrier git-fs
```

`--carrier git-fs` (default) makes the carrier directory a real git working
tree that is committed and pushed to a disposable bare remote, then cloned
back on the consuming side — so the event bytes really do travel through git
objects. `--carrier fs` skips git entirely and uses a shared directory.

The runner prints a work directory and a tarball path. Send the tarball back.

## What it does, phase by phase

Each phase is a **separate OS process** against persistent on-disk stores, so
"restart" means a real process boundary, not a reopened handle.

| phase | what happens |
| --- | --- |
| `seed` | Mints the C28 identity space, seeds store-A: markers M-03/M-06/M-07/M-08/M-11, the two concurrent equally-authorised successors to M-03 (E20 effective 09:00Z, E22 effective 08:55Z but arriving later), boris's unauthorised claim E21, the model-authored claim E50 with `actor`/`active`/`promoted_by` fields, and boris's *authorised* billing write E40 (positive control). |
| `publish` | store-A publishes its outbox to the carrier; M-07 is published three times with an identical digest (the C28 P3 duplicate). |
| *(shell)* | With `git-fs`: commit, push to the bare remote, clone back. The consumer reads the **clone**, not the producer's directory. |
| `poll` | store-B polls the carrier, receives everything, and is additionally handed the deliberate identity collision (M-07's id with M-08's bytes). |
| `rebuild` | store-C is created empty on the same host, fed **only** store-A's durable event files, and rebuilt from them. |
| `assert` | Recomputes the C28 assertions it can from the three stores and writes `results.json`. Everything else is `not-tested`. |
| `bundle` | Dumps views, events, journals, admission logs, projection digests, cursors, timings, `meta.json` (topology + host fingerprint + source commit) and a `manifest.sha256` over every file. |

## What the bundle proves

Recomputable by the verifier from raw bundle data — no trust in the run's own report:

| id | claim |
| --- | --- |
| A2 | three events touch M-03 across the exchange and the refused one is retained |
| A3 | M-03 is explicitly **contested** with two competing successors and no applied resolution |
| A4 | the unauthorised claim never applies to M-03 |
| A6 | the byte twins keep BOM/CRLF and distinct hashes across the carrier |
| A7 | the model-authored claim keeps `model_inference` despite `actor`/`active`/`promoted_by` |
| A10 | three deliveries of M-07 produce exactly one admitted copy |
| A12 | the reused id with different bytes is an explicit conflict with both byte streams retained |
| A13-auth | the unauthorised successor record is refused with an `unauthorized` reason and retained |
| A18 | store-C, rebuilt from durable events alone, has the same projection digest as store-A |
| A19 | the rebuild changes none of: M-03 contested, E50's class |
| A20 | store-C's record set equals store-A's |
| Q5 | **positive control** — boris's authorised billing write is applicable. If this fails the run is void. |

## What the bundle does NOT prove

Read this before quoting any green result.

1. **Not two computers.** Both halves run on one machine as separate processes.
   `meta.json` declares `machines: 1` and the verifier refuses to call C28
   passed. Per C28 A24 a substitution makes the case **unavailable**, never
   passed. Set `C28_MACHINES=2` only when the two halves genuinely ran on two
   physical computers, and say which in the report.
2. **Not the Git transport.** `src/exchange/git-transport.ts` (ADR §8.2) is not
   merged. `--carrier git-fs` pushes the carrier directory through a real bare
   remote, so git object transfer is exercised, but the **exchange-ref
   topology, the never-touch-the-user's-checkout guarantee and commit-sha
   receipts are untested**.
3. **Not a kill test.** No process is SIGKILLed at a durable boundary. C18/C28
   A15 need lane 02's fault suite (a child that dies at a named step).
4. **Not the T2/T3 corpus.** The seed is a handful of marker records, not
   10,000 or 100,000. Scale is measured separately by `scripts/measure/corpus.ts`.
5. **No action qualification, no revocation, no tombstones, no host turns.**
   Q1–Q4, Q6, Q7, A5, A8, A9, A11, A14, A16, A17, A21–A26 are emitted as
   `not-tested` with the reason each is blocked on. They are never emitted as
   passes.
6. **No clock skew and no partition.** The scenario uses a fixed injected
   clock; C28's +7 min host-bravo skew and the P2 partition are simulated by
   event ordering only.

## Verifying a returned bundle

```sh
npx tsx scripts/qualify/c28-remote/verify-bundle.ts /path/to/c28-bundle-*.tar.gz
```

The verifier recomputes every verdict it can **from the raw histories, views,
journals and admission logs** and compares against the bundle's self-report.
A disagreement, a manifest hash mismatch, or a self-reported pass the verifier
cannot independently recompute is a **problem** and the bundle is rejected.
Topology and carrier substitutions are reported as **notes** — the bundle can
be accepted while C28 stays unavailable.

## Known defect this bundle surfaces

**F-PENDING (lane 02).** When an event's causal parent is *rejected*, the
dependent event stays in `pending_parents` forever instead of settling into a
terminal refusal with a reason. Observed for E21 on both store-A and store-B:
its successor record is correctly rejected `unauthorized`, but the supersession
event itself never terminates. C28 A13 requires "the rejection is a receipt
state, not an absence"; C18 A9 requires every incomplete effect to carry a
state, an age and a reason. An event that waits indefinitely on a parent that
will never arrive is exactly the silent incomplete effect both forbid.
`assert` reports A13 as **fail**.
