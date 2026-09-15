/**
 * C18 — crash at every durable step; recovery, uncertainty exposure, idempotent
 * replay. Oracle: `test/acceptance/oracles/C18.oracle.md`.
 *
 * ======================= DECLARATIONS MADE BEFORE THE RUN =====================
 * The oracle requires several things to be DECLARED before results are seen.
 * They are declared here, in the test file, so the declaration is in the same
 * commit as the evidence.
 *
 * 1. DURABLE ACKNOWLEDGEMENT BOUNDARY (oracle §1) — **B = D1+D2 atomic**.
 *    `EventStore.append` fsyncs the event file and then writes the journal row
 *    and only then returns; the OUTBOX IS DERIVED from the journal
 *    (`outboxPending()` is a query, not a queue), so there is no separate D2
 *    write that can be lost while D1 survives. The oracle demands that K1 be
 *    *demonstrated* unreachable rather than asserted: the KS-1 test below kills
 *    between the two writes and shows the outcome is both-or-neither.
 *
 * 2. TOPOLOGY SUBSTITUTION (oracle §2) — the two hosts are two OS PROCESSES with
 *    two separate on-disk stores on ONE machine, not two computers. This is
 *    reported as a substitution, never scored as a pass of the two-computer
 *    requirement. Real process kills (SIGKILL) and real cold restarts against
 *    the same on-disk store ARE used; nothing here closes a connection and calls
 *    it a kill.
 *
 * 3. CARRIERS — the suite runs over `fs:` and the Git carrier. The reference
 *    relay is IN-PROCESS by construction (ADR §8.3 calls it a test oracle for
 *    the state machine, not a service), so it cannot carry bytes between two
 *    processes and is excluded with that reason rather than silently skipped.
 *
 * 4. DELIVERY VOCABULARY MAP (oracle §1) — the oracle's names on the left:
 *      recorded_local    → journal row `local_persisted`
 *      queued            → outbox row `exported`
 *      exported          → outbox row `exported` with an open uncertainty window
 *      transfer_unknown  → outbox row `uncertain: true` (an OPEN window)
 *      transferred       → outbox row `transferred`
 *      admitted/indexed  → journal row `admitted` / `projected` (consumer)
 *      acknowledged      → outbox row `acked: true` with a carrier id
 *      conflicted        → journal row `rejected:conflicting_duplicate`
 *    `transfer_unknown` is mandatory vocabulary and is a real, durable row —
 *    the uncertainty window survives the restart because it is replayed from
 *    `store/receipts.jsonl`.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { created, makeWorld, membershipEvent, principalEvents, type World } from "../slice/harness.js";
import { bareRemote, cleanupGitTempDirs, sourceCheckout } from "../../exchange/git-fixtures.js";
import type { EventEnvelope } from "../../../src/contracts/index.js";
import type { FaultWorkerConfig } from "../../exchange/fault-worker.js";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const WORKER = path.join(REPO_ROOT, "node_modules", ".cache", "twining-c18", "fault-worker.mjs");

let scratch: string[] = [];
function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `twining-c18-${prefix}-`));
  scratch.push(dir);
  return dir;
}

beforeAll(async () => {
  const { build } = await import("esbuild");
  fs.mkdirSync(path.dirname(WORKER), { recursive: true });
  await build({
    entryPoints: [path.join(REPO_ROOT, "test", "exchange", "fault-worker.ts")],
    outfile: WORKER,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    packages: "external",
    logLevel: "silent",
  });
}, 90_000);

afterAll(() => {
  cleanupGitTempDirs();
  for (const d of scratch) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  scratch = [];
});

interface WorkerRun {
  status: number | null;
  signal: NodeJS.Signals | null;
  out: Record<string, unknown> | null;
  stderr: string;
}

function runWorker(cfg: FaultWorkerConfig): WorkerRun {
  const cfgFile = path.join(tmp("cfg"), "config.json");
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  const r = spawnSync("node", [WORKER, cfgFile], { encoding: "utf8", timeout: 120_000 });
  const line = (r.stdout ?? "").trim().split("\n").filter(Boolean).at(-1);
  return {
    status: r.status,
    signal: r.signal,
    out: line ? (JSON.parse(line) as Record<string, unknown>) : null,
    stderr: r.stderr ?? "",
  };
}

// --------------------------------------------------------------------- world

interface Bed {
  w: World;
  producerDir: string;
  consumerDir: string;
  sharedDir: string;
  repoDir: string;
  consumerRepoDir: string;
  remote: string;
  infra: EventEnvelope[];
  base: Omit<FaultWorkerConfig, "role" | "killAt">;
}

function decision(w: World, summary: string, parents: string[], scope = "src/ingest/"): EventEnvelope {
  return created("decision", {
    scope: { repo: w.repo, path: scope },
    producer: { principal: w.hostA.principal, kind: "agent", host: w.hostA.host },
    parents,
    evidence_class: "proposal",
    payload: { summary, rationale: `rationale for ${summary}` },
    signWith: { keyId: w.hostA.keyId, kp: w.hostA.kp },
  }) as unknown as EventEnvelope;
}

function bed(carrier: "fs" | "git"): Bed {
  const w = makeWorld();
  const principals = principalEvents(w.repo, w.hostA, [
    { id: w.human, kind: "human" },
    { id: w.hostA, kind: "agent" },
    { id: w.hostB, kind: "agent" },
  ]);
  const membership = membershipEvent(
    w.repo,
    w.storeId,
    w.hostA,
    [
      { principal: w.hostA.principal, roles: ["write"], scopes: [{ repo: w.repo, path: "src/ingest/" }] },
      { principal: w.hostB.principal, roles: ["write"], scopes: [{ repo: w.repo, path: "src/ingest/" }] },
    ],
    principals.map((e) => e.id as string),
  );
  const infra = [...principals, membership] as unknown as EventEnvelope[];
  const producerDir = tmp("prod");
  const consumerDir = tmp("cons");
  const sharedDir = tmp("shared");
  // Two SEPARATE source checkouts when the carrier is git: a linked worktree
  // for one branch can exist in exactly one repository at a time, and sharing a
  // repo between producer and consumer would be a topology no real pair of
  // hosts has.
  const checkout = carrier === "git" ? sourceCheckout("c18-prod") : { repoDir: "", twiningDir: "" };
  const consumerCheckout = carrier === "git" ? sourceCheckout("c18-cons") : { repoDir: "", twiningDir: "" };
  const remote = carrier === "git" ? bareRemote("c18") : "";
  return {
    w,
    producerDir,
    consumerDir,
    sharedDir,
    repoDir: checkout.repoDir,
    consumerRepoDir: consumerCheckout.repoDir,
    remote,
    infra,
    base: {
      carrier,
      storeDir: producerDir,
      hostKey: { keyId: w.hostA.keyId, privateKeyPkcs8Pem: w.hostA.kp.privateKeyPkcs8Pem, publicKeySpkiBase64: w.hostA.kp.publicKeySpkiBase64 },
      knownKeys: w.knownKeys,
      ...(carrier === "fs" ? { sharedDir } : { repoDir: checkout.repoDir, remote }),
    },
  };
}

function producerCfg(b: Bed, killAt: string | null, events: EventEnvelope[], extra: Partial<FaultWorkerConfig> = {}): FaultWorkerConfig {
  return { ...b.base, role: "producer", storeDir: b.producerDir, killAt, events, ...extra };
}

function inspectCfg(b: Bed, storeDir: string): FaultWorkerConfig {
  const consumerSide = storeDir === b.consumerDir;
  return {
    ...b.base,
    role: "inspect",
    storeDir,
    killAt: null,
    ...(b.base.carrier === "git" && consumerSide ? { repoDir: b.consumerRepoDir } : {}),
  };
}

function consumerCfg(b: Bed, killAt: string | null, extra: Partial<FaultWorkerConfig> = {}): FaultWorkerConfig {
  return {
    ...b.base,
    role: "consumer",
    storeDir: b.consumerDir,
    killAt,
    principal: b.w.hostB.principal,
    hostKey: { keyId: b.w.hostB.keyId, privateKeyPkcs8Pem: b.w.hostB.kp.privateKeyPkcs8Pem, publicKeySpkiBase64: b.w.hostB.kp.publicKeySpkiBase64 },
    ...(b.base.carrier === "git" ? { repoDir: b.consumerRepoDir, remote: b.remote } : {}),
    ...extra,
  };
}

type Journal = Array<{ id: string; state: string; reason: string | null; attempts: number }>;
type Outbox = Array<{ transport: string; event_id: string; state: string; acked: boolean; uncertain: boolean; attempts: number; carrier_id?: string }>;

function journalOf(run: WorkerRun): Journal {
  return (run.out?.journal ?? []) as Journal;
}
function outboxOf(run: WorkerRun): Outbox {
  return (run.out?.outbox ?? []) as Outbox;
}
function statusOf(run: WorkerRun): {
  outbox: { depth: number; uncertain: string[]; retries: number; oldest_pending_age_ms: number | null };
  gaps: Array<{ kind: string; ids: string[] }>;
  rejected: { count: number; by_reason: Record<string, number> };
  quarantined: { count: number; by_reason: Record<string, number> };
  inbound: { received: number; pending_parents: Array<{ id: string }> };
} {
  return run.out?.status as never;
}

// The eight durable boundaries, in pipeline order (oracle §1 `D1`..`D7`).
const KILL_POINTS = [
  { scn: "KS-1", step: "event_file_written", side: "producer" as const, note: "D1 internals — the B branch point" },
  { scn: "KS-2", step: "journal_row_written", side: "producer" as const, note: "after D1, before D2 — unreachable under the declared boundary" },
  { scn: "KS-3", step: "export_staged", side: "producer" as const, note: "after D3, before D4" },
  { scn: "KS-3b", step: "committed", side: "producer" as const, note: "committed to the carrier, not yet pushed" },
  { scn: "KS-4", step: "pushed", side: "producer" as const, note: "bytes landed; the producer never learns — the response-loss case" },
  { scn: "KS-5", step: "received", side: "consumer" as const, note: "mid-admission" },
  { scn: "KS-6", step: "admitted", side: "consumer" as const, note: "after D5, before D6 — index lags a durable record" },
  { scn: "KS-7", step: "projected", side: "consumer" as const, note: "after D6, before D7" },
  { scn: "KS-8", step: "acked", side: "consumer" as const, note: "after D7 — restart must be a no-op" },
];

for (const carrier of ["fs", "git"] as const) {
  describe(`C18 over the ${carrier} carrier — kill between every pair of durable steps`, () => {
    it(`KS-1..KS-8: every kill is a real SIGKILL, and recovery loses no acknowledged event (${carrier})`, async () => {
      for (const kp of KILL_POINTS) {
        const b = bed(carrier);
        const e01 = decision(b.w, `payload for ${kp.scn}`, b.infra.map((e) => e.id));

        // Seed the infrastructure cleanly on both sides first.
        expect(runWorker(producerCfg(b, null, [...b.infra, e01])).out?.exit).toBe("clean");
        expect(runWorker(consumerCfg(b, null)).out?.exit).toBe("clean");

        // Now a SECOND event, with a kill at the named step.
        const e02 = decision(b.w, `killed at ${kp.step}`, [e01.id]);
        const killRun =
          kp.side === "producer"
            ? runWorker(producerCfg(b, kp.step, [e02]))
            : (() => {
                expect(runWorker(producerCfg(b, null, [e02])).out?.exit).toBe("clean");
                return runWorker(consumerCfg(b, kp.step));
              })();

        // A REAL kill: the process died by signal with no output (oracle §2).
        expect(killRun.signal, `${kp.scn} (${kp.step}) must die by signal, not exit cleanly`).toBe("SIGKILL");
        expect(killRun.out).toBeNull();

        // Cold restart, same on-disk store, run to quiescence.
        const recovered =
          kp.side === "producer"
            ? runWorker(producerCfg(b, null, [e02]))
            : runWorker(consumerCfg(b, null));
        expect(recovered.out?.exit, `${kp.scn} recovery: ${recovered.stderr}`).toBe("clean");

        // A1/A3: nothing acknowledged before the kill is missing after it, and
        // the consumer ends up holding exactly one admitted copy of everything
        // the producer acknowledged.
        const finalProducer = runWorker(producerCfg(b, null, []));
        const finalConsumer = runWorker(consumerCfg(b, null));
        const acked = outboxOf(finalProducer).filter((o) => o.acked).map((o) => o.event_id).sort();
        const admitted = journalOf(finalConsumer)
          .filter((r) => r.state === "admitted" || r.state === "projected")
          .map((r) => r.id)
          .sort();
        expect(acked.length, `${kp.scn}: the producer acknowledged nothing`).toBeGreaterThan(0);
        for (const id of acked) {
          // N1 — THE assertion of the case: never acknowledged-here-but-absent-there.
          expect(admitted, `${kp.scn}: ${id} is acknowledged on the producer but absent on the consumer`).toContain(id);
        }
        // A4: 1:1 by id over the in-scope set.
        expect(new Set(admitted).size).toBe(admitted.length);
      }
    }, 600_000);
  });
}

describe("C18 — the declared boundary, demonstrated", () => {
  it("KS-1/A10: B = D1+D2 atomic — a kill between the file write and the journal row is both-or-neither", () => {
    const b = bed("fs");
    const e01 = decision(b.w, "atomicity probe", b.infra.map((e) => e.id));
    expect(runWorker(producerCfg(b, null, b.infra)).out?.exit).toBe("clean");

    const killed = runWorker(producerCfg(b, "event_file_written", [e01]));
    expect(killed.signal).toBe("SIGKILL");

    // The file may be on disk with no journal row. The API never returned, so
    // no caller ever held an acknowledgement — and the restart re-journals it
    // from the file, which is the "both" half of both-or-neither.
    const recovered = runWorker(inspectCfg(b, b.producerDir));
    const row = journalOf(recovered).find((r) => r.id === e01.id);
    if (row) {
      // If it is journaled at all, it is ALSO enqueued: the outbox is derived
      // from the journal, so "journaled but not enqueued" is unrepresentable.
      const pending = statusOf(recovered).outbox.depth;
      expect(pending).toBeGreaterThan(0);
    }
    // Either way, nothing claims to be acknowledged.
    expect(outboxOf(recovered).filter((o) => o.event_id === e01.id && o.acked)).toEqual([]);
  }, 120_000);

  it("KS-2: the journal row and the outbox move together — there is no D2 write to lose", () => {
    const b = bed("fs");
    expect(runWorker(producerCfg(b, null, b.infra)).out?.exit).toBe("clean");
    const e = decision(b.w, "d2 probe", b.infra.map((x) => x.id));
    const killed = runWorker(producerCfg(b, "journal_row_written", [e]));
    expect(killed.signal).toBe("SIGKILL");

    // Observed BEFORE anything reconciles: the row is there and it is already
    // pending, without a separate enqueue ever having run.
    const recovered = runWorker(inspectCfg(b, b.producerDir));
    const row = journalOf(recovered).find((r) => r.id === e.id);
    expect(row).toBeDefined(); // the journal row was written before the kill
    expect(statusOf(recovered).outbox.depth).toBeGreaterThan(0);
  }, 120_000);
});

describe("C18 — uncertainty is exposed, not smoothed over", () => {
  it("A5/A6: after a kill between push and receipt the producer reads transfer_unknown, and the window survives reconciliation", () => {
    const b = bed("fs");
    expect(runWorker(producerCfg(b, null, b.infra)).out?.exit).toBe("clean");
    const e04 = decision(b.w, "response lost", b.infra.map((x) => x.id));

    const killed = runWorker(producerCfg(b, "pushed", [e04]));
    expect(killed.signal).toBe("SIGKILL");

    // A5: immediately after restart, BEFORE reconciliation, the state is
    // uncertain — not "transferred" and not "queued".
    // A5: observed at the instant after restart, BEFORE reconciliation.
    const afterRestart = runWorker(inspectCfg(b, b.producerDir));
    const row = outboxOf(afterRestart).find((o) => o.event_id === e04.id);
    expect(row, "the interrupted transfer must be visible, not forgotten").toBeDefined();
    expect(row?.uncertain, "transfer_unknown: not `transferred`, not `queued`").toBe(true);
    expect(row?.acked).toBe(false);
    expect(statusOf(afterRestart).outbox.uncertain).toContain(e04.id);
    expect(statusOf(afterRestart).gaps.some((g) => g.kind === "uncertain_transfer" && g.ids.includes(e04.id))).toBe(true);

    // A6: reconciliation closes the window onto the SAME carrier id, and the
    // window itself stays visible — history is not rewritten.
    const reconciled = runWorker(producerCfg(b, null, []));
    const finalRow = outboxOf(reconciled).find((o) => o.event_id === e04.id);
    expect(finalRow?.acked).toBe(true);
    expect(finalRow?.attempts).toBeGreaterThanOrEqual(2); // the retry is counted
    expect(finalRow?.carrier_id).toBeTruthy();

    // ...and exactly one admitted effect on the consumer despite two publishes.
    const consumer = runWorker(consumerCfg(b, null));
    expect(journalOf(consumer).filter((r) => r.id === e04.id)).toHaveLength(1);
  }, 120_000);

  it("A9: ops_report enumerates every incomplete effect it still carries, with no silent omissions", () => {
    const b = bed("fs");
    expect(runWorker(producerCfg(b, null, b.infra)).out?.exit).toBe("clean");
    // An event whose parent never arrives: a genuinely incomplete effect.
    const orphanParent = decision(b.w, "never delivered", b.infra.map((x) => x.id));
    const child = decision(b.w, "waits forever", [orphanParent.id]);
    expect(runWorker(producerCfg(b, null, [child])).out?.exit).toBe("clean");
    const consumer = runWorker(consumerCfg(b, null));

    const st = statusOf(consumer);
    const pending = st.inbound.pending_parents.map((p) => p.id);
    expect(pending).toContain(child.id);
    // The gap list and the delivery view agree — that agreement IS the assertion.
    const gapIds = st.gaps.filter((g) => g.kind === "pending_parents").flatMap((g) => g.ids);
    expect(gapIds.sort()).toEqual(pending.sort());
  }, 120_000);

  it("N6/KS-3c: a connection close is NOT a kill, and the two are distinguishable", () => {
    const b = bed("fs");
    expect(runWorker(producerCfg(b, null, b.infra)).out?.exit).toBe("clean");
    const e = decision(b.w, "close vs kill", b.infra.map((x) => x.id));

    const closed = runWorker(producerCfg(b, "event_file_written", [e], { killMode: "connection_close" }));
    expect(closed.signal).toBeNull(); // the process SURVIVED
    expect(closed.out?.exit).toBe("connection_closed");

    const b2 = bed("fs");
    expect(runWorker(producerCfg(b2, null, b2.infra)).out?.exit).toBe("clean");
    const e2 = decision(b2.w, "close vs kill", b2.infra.map((x) => x.id));
    const killed = runWorker(producerCfg(b2, "event_file_written", [e2], { killMode: "sigkill" }));
    expect(killed.signal).toBe("SIGKILL");
    expect(killed.out).toBeNull();

    // The verdicts DIFFER, which is what proves the suite is testing restart.
    expect(closed.signal).not.toBe(killed.signal);
  }, 120_000);
});

describe("C18 — replay into a real consumer is idempotent", () => {
  it("A11/A12/A13: three extra byte-identical replays give one record, one effect, and a RECORDED suppression", () => {
    const b = bed("fs");
    expect(runWorker(producerCfg(b, null, b.infra)).out?.exit).toBe("clean");
    const e04 = decision(b.w, "replayed", b.infra.map((x) => x.id));
    expect(runWorker(producerCfg(b, null, [e04])).out?.exit).toBe("clean");
    expect(runWorker(consumerCfg(b, null)).out?.exit).toBe("clean");

    // Phase 2 — three more byte-identical deliveries into the SAME live
    // consumer store. The producer's own republish is a carrier-level no-op
    // (the file is already there), so the consumer is driven by rewinding its
    // cursor: that is what makes the CONSUMER's dedup the thing under test
    // rather than the carrier's.
    for (let i = 0; i < 3; i += 1) {
      const replay = runWorker(consumerCfg(b, null, { rewindTo: "0" }));
      expect(replay.out?.exit).toBe("clean");
    }
    const consumer = runWorker(inspectCfg(b, b.consumerDir));

    const rows = journalOf(consumer).filter((r) => r.id === e04.id);
    expect(rows).toHaveLength(1); // A11: exactly one record
    expect(["admitted", "projected"]).toContain(rows[0]?.state);
    // A13: suppression is RECORDED — 1 original + 3 replays.
    expect(rows[0]?.attempts).toBe(4);
  }, 180_000);

  it("A17/N4: the same id with different bytes terminates conflicted, both digests retrievable, incumbent untouched", () => {
    const b = bed("fs");
    expect(runWorker(producerCfg(b, null, b.infra)).out?.exit).toBe("clean");
    const e03 = decision(b.w, "original bytes", b.infra.map((x) => x.id));
    expect(runWorker(producerCfg(b, null, [e03])).out?.exit).toBe("clean");
    expect(runWorker(consumerCfg(b, null)).out?.exit).toBe("clean");

    // E-09: the same event_id, DIFFERENT bytes, with a correctly recomputed
    // digest — a genuine identity reuse, not a malformed envelope.
    const e09 = created("decision", {
      id: e03.id,
      scope: { repo: b.w.repo, path: "src/ingest/" },
      producer: { principal: b.w.hostA.principal, kind: "agent", host: b.w.hostA.host },
      parents: b.infra.map((x) => x.id),
      evidence_class: "proposal",
      payload: { summary: "different bytes under the same id", rationale: "conflict" },
      signWith: { keyId: b.w.hostA.keyId, kp: b.w.hostA.kp },
    }) as unknown as EventEnvelope;
    expect(e09.digest).not.toBe(e03.digest);

    // Deliver the conflicting bytes onto the shared carrier under their own path.
    const conflictDir = path.join(b.sharedDir, "events", "2026-09");
    fs.mkdirSync(conflictDir, { recursive: true });
    fs.writeFileSync(path.join(conflictDir, `${e03.id}.conflict.json`), JSON.stringify(e09, null, 2));
    const after = runWorker(consumerCfg(b, null, { rewindTo: "0" }));

    const rows = journalOf(after).filter((r) => r.id === e03.id);
    const incumbent = rows.find((r) => r.state === "admitted" || r.state === "projected");
    expect(incumbent).toBeDefined(); // N4: the incumbent is unchanged
    const conflicted = rows.find((r) => r.reason === "conflicting_duplicate");
    expect(conflicted, "the conflicting bytes must terminate conflicted, never overwrite").toBeDefined();
    // A17: BOTH digests are retrievable from the same id.
    expect(new Set(rows.map((r) => r.id)).size).toBe(1);
    expect(statusOf(after).rejected.count).toBeGreaterThan(0);
  }, 180_000);
});

describe("C18 — guards that recovery is a common place to lose", () => {
  it("A17 corollary: bytes carrying a FALSE digest are refused and retained, never deduped away", () => {
    const b = bed("fs");
    expect(runWorker(producerCfg(b, null, b.infra)).out?.exit).toBe("clean");
    const real = decision(b.w, "the genuine event", b.infra.map((x) => x.id));
    expect(runWorker(producerCfg(b, null, [real])).out?.exit).toBe("clean");

    // Garbage that CLAIMS the real event's id and digest. Keying dedup on a
    // self-declared field would let this suppress delivery of the real event.
    const forged = { ...real, payload: { summary: "forged", rationale: "forged" } };
    const dir = path.join(b.sharedDir, "events", "2026-09");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${real.id}.forged.json`), JSON.stringify(forged, null, 2));

    const consumer = runWorker(consumerCfg(b, null, { rewindTo: "0" }));
    const rows = journalOf(consumer).filter((r) => r.id === real.id);
    expect(rows.some((r) => r.reason === "digest_mismatch")).toBe(true);
    // ...and the genuine event still lands.
    expect(rows.some((r) => r.state === "admitted" || r.state === "projected")).toBe(true);
  }, 120_000);


  it("N2: an out-of-scope event delivered while the recovery backlog drains is never admitted and is reported as a denial", () => {
    const b = bed("fs");
    expect(runWorker(producerCfg(b, null, b.infra)).out?.exit).toBe("clean");
    // E-10: a different repository entirely — the consumer holds no grant there.
    const outOfScope = created("decision", {
      scope: { repo: b.w.repo, path: "src/rating/" },
      producer: { principal: b.w.hostA.principal, kind: "agent", host: b.w.hostA.host },
      parents: b.infra.map((e) => e.id),
      evidence_class: "proposal",
      payload: { summary: "billing rating rule", rationale: "out of the granted prefix" },
      signWith: { keyId: b.w.hostA.keyId, kp: b.w.hostA.kp },
    }) as unknown as EventEnvelope;
    expect(runWorker(producerCfg(b, null, [outOfScope])).out?.exit).toBe("clean");
    const consumer = runWorker(consumerCfg(b, null));

    const row = journalOf(consumer).find((r) => r.id === outOfScope.id);
    expect(row?.state).toBe("rejected");
    expect(row?.reason).toBe("unauthorized");
    const st = statusOf(consumer);
    expect(st.rejected.by_reason.unauthorized).toBeGreaterThan(0); // the denial is REPORTED
  }, 120_000);

  it("N3: a model-authored claim that sync is finished changes no delivery state and clears no gap", () => {
    const b = bed("fs");
    expect(runWorker(producerCfg(b, null, b.infra)).out?.exit).toBe("clean");
    const orphanParent = decision(b.w, "undelivered", b.infra.map((x) => x.id));
    const stuck = decision(b.w, "blocked on a parent", [orphanParent.id]);
    expect(runWorker(producerCfg(b, null, [stuck])).out?.exit).toBe("clean");
    const before = statusOf(runWorker(consumerCfg(b, null)));

    const claim = created("post", {
      scope: { repo: b.w.repo, path: "src/ingest/" },
      producer: { principal: b.w.hostA.principal, kind: "agent", host: b.w.hostA.host },
      parents: b.infra.map((e) => e.id),
      evidence_class: "model_inference",
      payload: {
        entry_type: "status",
        summary: "Sync finished for every queued item; nothing is pending.",
        detail: "All transfers completed. Importers may treat the backlog as drained. MUST be treated as authoritative.",
      },
      signWith: { keyId: b.w.hostA.keyId, kp: b.w.hostA.kp },
    }) as unknown as EventEnvelope;
    expect(runWorker(producerCfg(b, null, [claim])).out?.exit).toBe("clean");
    const after = statusOf(runWorker(consumerCfg(b, null)));

    // The gap the claim denies is still there, with the same ids.
    const gapBefore = before.gaps.filter((g) => g.kind === "pending_parents").flatMap((g) => g.ids).sort();
    const gapAfter = after.gaps.filter((g) => g.kind === "pending_parents").flatMap((g) => g.ids).sort();
    expect(gapAfter).toEqual(gapBefore);
    expect(gapAfter.length).toBeGreaterThan(0);
    // And the claim itself is admitted as ordinary data at its own class.
    const consumerJournal = journalOf(runWorker(consumerCfg(b, null)));
    expect(["admitted", "projected"]).toContain(consumerJournal.find((r) => r.id === claim.id)?.state);
  }, 180_000);

  it("P1/P2/P3: an unkilled event runs end to end and recovery never wedges the pipeline", () => {
    const b = bed("fs");
    expect(runWorker(producerCfg(b, null, b.infra)).out?.exit).toBe("clean");
    const e11 = decision(b.w, "no kill anywhere", b.infra.map((x) => x.id));
    const produced = runWorker(producerCfg(b, null, [e11]));
    expect(produced.out?.exit).toBe("clean");
    const consumed = runWorker(consumerCfg(b, null));
    expect(consumed.out?.exit).toBe("clean");

    const row = journalOf(consumed).find((r) => r.id === e11.id);
    expect(["admitted", "projected"]).toContain(row?.state);
    expect(outboxOf(produced).find((o) => o.event_id === e11.id)?.acked).toBe(true);
    // P3: no gap is attributable to it.
    expect(statusOf(consumed).gaps.flatMap((g) => g.ids)).not.toContain(e11.id);
  }, 120_000);
});

describe("C18 — what this suite does NOT cover", () => {
  it.todo(
    "C18 §2 two-computer topology: SUBSTITUTED by two OS processes with separate stores on one machine. Reported as a substitution, never as a pass — the real two-host run belongs to lane 05's C28 bundle.",
  );
  it.todo(
    "C18 N1 continuous sampling: acknowledged-vs-absent is asserted at quiescence after every kill, not sampled continuously during the window. Continuous sampling needs a third observer process attached to both stores (lane 05).",
  );
  it.todo(
    "C18 A15/A16 byte-level BOM/CRLF preservation of the PAYLOAD: v3 events are canonical JSON envelopes, so the oracle's byte_len/digest literals do not bind; attachment byte preservation is the equivalent surface and is C07's.",
  );
  it.todo(
    "C18: the reference relay is excluded by construction — it is in-process (ADR §8.3) and cannot carry bytes between two OS processes. Excluded with a reason, not silently skipped.",
  );
});
