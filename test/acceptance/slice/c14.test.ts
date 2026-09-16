/**
 * C14 — ref rewind / snapshot rewind. Oracle: C14.oracle.md (v1.0.0).
 *
 * DECLARED OBSERVABLE MAPPING (oracle §1 requires five read surfaces):
 *   list_events(store)          → store.events({}) / store.journalRows()
 *   current_view(store, scope)  → store.query({ scope })  (+ currentUseClaim for qualification)
 *   receipts(store, event_id)   → store.deliveryState(id) (local ladder + transfers[])
 *   history(store, record_id)   → store.history(record_id) + store.get(record_id).history
 *   rebuild_from_durable(store) → store.rebuild() → { projection_digest, acknowledged_events_lost }
 *   representations[]           → store.representations(event_id) — projection state on the
 *                                 admission log, NEVER a field of the immutable envelope
 *                                 (lead ruling, conflict 6 / C14-D1).
 *
 * TWO ARMS (lead ruling, C14-ASM-1 / conflict 5):
 *   Arm A — the exchange-side directory (the carrier) is rewound. The received
 *           set shrinks; the admitted set does not, and the replica reports
 *           `checkout_behind_journal` rather than silently revoking.
 *   Arm B — the directory holding the store's event files is rewound
 *           (source-branch mode). Same invariant, harder trigger: the files are
 *           physically gone and the journal still holds the admitted set.
 *
 * Git-specific role: NOT covered here. Lane 02 ships `fs:` and the reference
 * relay; §10's transport variant is the second mandatory arm per C14-D8, and an
 * unimplemented Git adapter is explicitly not marked covered by it.
 */
import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { currentUseClaim } from "../../../src/events/projection.js";
import type { EventStore } from "../../../src/events/event-store.js";
import { GitTransport, EXCHANGE_BRANCH } from "../../../src/exchange/git-transport.js";
import { git, gitTry, revParse } from "../../../src/exchange/git.js";
import { Inbox } from "../../../src/exchange/inbox.js";
import { bareRemote, cleanupGitTempDirs, dirtyTheCheckout, fingerprintCheckout, sourceCheckout } from "../../exchange/git-fixtures.js";
import type { EventEnvelope } from "../../../src/contracts/index.js";
import {
  admitAndProject,
  buildEvent,
  cleanupTempDirs,
  created,
  keysOf,
  makeIdentity,
  makeWorld,
  membershipEvent,
  newStore,
  principalEvents,
  tempDir,
  type Identity,
  type World,
} from "./harness.js";

afterAll(cleanupTempDirs);
afterAll(cleanupGitTempDirs);

const PAY = "src/pay/";
const LEDGER = "src/ledger/";
const C1AA = "1".repeat(40);
const C2AA = "2".repeat(40);
const C3AA = "3".repeat(40);
const C5BB = "5".repeat(40);

interface C14World extends World {
  ava: Identity;
  bo: Identity;
  scribeB: Identity;
  extraKeys: Record<string, { publicKeySpkiBase64: string; human?: boolean }>;
}

function c14World(): C14World {
  const base = makeWorld();
  const ava = makeIdentity();
  const bo = makeIdentity();
  const scribeB = makeIdentity();
  return { ...base, ava, bo, scribeB, extraKeys: keysOf([[ava, true], [bo, true], [scribeB, false]]) };
}

function fixture(w: C14World) {
  const scope = (p: string, head?: string) => ({ repo: w.repo, path: p, ...(head ? { revision: { head } } : {}) });
  const principals = principalEvents(w.repo, w.hostA, [
    { id: w.ava, kind: "human" },
    { id: w.bo, kind: "human" },
    { id: w.scribeB, kind: "agent" },
    { id: w.hostA, kind: "agent" },
  ]);
  const membership = membershipEvent(
    w.repo,
    w.storeId,
    w.hostA,
    [
      { principal: w.ava.principal, roles: ["rule", "write"], scopes: [{ repo: w.repo, path: PAY }, { repo: w.repo, path: LEDGER }] },
      { principal: w.scribeB.principal, roles: ["write"], scopes: [{ repo: w.repo }] },
      { principal: w.hostA.principal, roles: ["write"], scopes: [{ repo: w.repo }] },
    ],
    principals.map((e) => e.id as string),
  );
  const infra = [...principals, membership];
  const infraIds = infra.map((e) => e.id as string);

  // K0 seed — four records in src/pay/.
  const rec050 = created("ruling", {
    scope: scope(PAY, C1AA),
    producer: { principal: w.ava.principal, kind: "human", host: w.ava.host },
    parents: infraIds,
    evidence_class: "human_ruling",
    payload: { statement: "retries capped at 3" },
    signWith: { keyId: w.ava.keyId, kp: w.ava.kp },
  });
  const rec300 = created("ruling", {
    scope: scope(PAY, C3AA),
    producer: { principal: w.ava.principal, kind: "human", host: w.ava.host },
    parents: infraIds,
    evidence_class: "human_ruling",
    payload: { statement: "vendor sandbox key allowed" },
    signWith: { keyId: w.ava.keyId, kp: w.ava.kp },
  });
  const rec100 = created("ruling", {
    scope: scope(PAY, C2AA),
    producer: { principal: w.ava.principal, kind: "human", host: w.ava.host },
    parents: [rec050.id as string],
    evidence_class: "human_ruling",
    payload: { statement: "retries capped at 5", supersedes: [rec050.id as string] },
    signWith: { keyId: w.ava.keyId, kp: w.ava.kp },
  });
  const ev003 = buildEvent({
    kind: "superseded",
    record: { type: "ruling", id: rec050.id as string },
    scope: scope(PAY),
    producer: { principal: w.ava.principal, kind: "human", host: w.ava.host },
    parents: [rec100.id as string],
    evidence_class: "human_ruling",
    payload: { target: rec050.id as string, by: rec100.id as string, reason: "raised after incident review" },
    signWith: { keyId: w.ava.keyId, kp: w.ava.kp },
  });
  const rec200 = created("decision", {
    scope: scope(PAY, C3AA),
    producer: { principal: w.scribeB.principal, kind: "agent", host: w.bo.host, asserted_actor: "agt-scribe-b" },
    parents: [rec100.id as string],
    evidence_class: "model_inference",
    payload: { summary: "cap should be 10", rationale: "inferred from retry histograms" },
    signWith: { keyId: w.scribeB.keyId, kp: w.scribeB.kp },
  });
  const ev005 = buildEvent({
    kind: "revoked",
    record: { type: "ruling", id: rec300.id as string },
    scope: scope(PAY),
    producer: { principal: w.ava.principal, kind: "human", host: w.ava.host },
    parents: [rec300.id as string],
    evidence_class: "human_ruling",
    payload: { target: rec300.id as string, reason: "sandbox key leaked" },
    signWith: { keyId: w.ava.keyId, kp: w.ava.kp },
  });
  const ev006 = created("observation", {
    scope: scope(PAY, C3AA),
    producer: { principal: w.hostA.principal, kind: "agent", host: w.hostA.host },
    parents: infraIds,
    evidence_class: "verified_observation",
    payload: { source_kind: "file", source_uri: "src/pay/settle.ts", observed_at: "2026-09-15T10:00:00.000Z", volatile: false, result: { revision: "c3aa", sha: "aa03" } },
    signWith: { keyId: w.hostA.keyId, kp: w.hostA.kp },
  });

  const k0 = [rec050, rec300, rec100, ev003, rec200, ev005, ev006];
  return { infra, infraIds, rec050, rec300, rec100, ev003, rec200, ev005, ev006, k0, scope };
}

type Fixture = ReturnType<typeof fixture>;

/** A git-shaped observation the harness issues explicitly (lead ruling C14-D2). */
function sourceObservation(w: C14World, f: Fixture, op: string, head: string, extra: Record<string, unknown> = {}) {
  return created("observation", {
    scope: { repo: w.repo, path: PAY },
    producer: { principal: w.hostA.principal, kind: "agent", host: w.hostA.host },
    parents: f.infraIds,
    evidence_class: "verified_observation",
    payload: {
      source_kind: "commit",
      observed_at: "2026-09-15T11:00:00.000Z",
      volatile: true,
      check_method: `git ${op}`,
      result: { op, head, ...extra },
    },
    signWith: { keyId: w.hostA.keyId, kp: w.hostA.kp },
  });
}

async function seeded(w: C14World, f: Fixture, dir = tempDir("c14")): Promise<EventStore> {
  const store = newStore(w, w.hostA, dir, w.extraKeys);
  for (const e of [...f.infra, ...f.k0]) store.receive(e, "fs:carrier", `events/2026-09/${(e as { id: string }).id}.json`);
  await admitAndProject(store);
  return store;
}

/**
 * The K0 projection over the CASE's record ids only (appendix B X-5): the
 * `principal`/`membership` infrastructure records are repo-scoped and so match
 * every path query by design, and are enumerated apart rather than counted in.
 */
async function k0View(store: EventStore, w: C14World, f: Fixture): Promise<Record<string, string>> {
  const caseIds = new Set([f.rec050, f.rec100, f.rec200, f.rec300].map((e) => (e as { id: string }).id));
  const out: Record<string, string> = {};
  for (const rec of await store.query({ scope: { repo: w.repo, path: PAY }, include_retired: true, include_archived: true })) {
    if (caseIds.has(rec.record_id)) out[rec.record_id] = rec.status;
  }
  return out;
}

describe("C14 — no silent loss or resurrection across a rewind", () => {
  it("K0: the seeded lifecycle is what the oracle declares", async () => {
    const w = c14World();
    const f = fixture(w);
    const store = await seeded(w, f);
    expect(await k0View(store, w, f)).toEqual({
      [f.rec050.id as string]: "superseded",
      [f.rec100.id as string]: "active",
      [f.rec200.id as string]: "active",
      [f.rec300.id as string]: "revoked",
    });
    expect((await store.get(f.rec200.id as string))?.authorizes_action).toBe(false);
    expect((await store.get(f.rec100.id as string))?.authorizes_action).toBe(true);
    store.close();
  });

  it("Arm A — A-CUR1/A-EV1/N1/N2/N3: rewinding the CARRIER changes the received set, never the admitted set", async () => {
    const w = c14World();
    const f = fixture(w);
    const carrierDir = tempDir("c14-carrier");
    fs.mkdirSync(path.join(carrierDir, "events", "2026-09"), { recursive: true });
    for (const e of [...f.infra, ...f.k0]) {
      fs.writeFileSync(path.join(carrierDir, "events", "2026-09", `${(e as { id: string }).id}.json`), JSON.stringify(e, null, 2));
    }
    const store = await seeded(w, f);
    const before = await k0View(store, w, f);

    // T1/T2 — the carrier checkout is rewound to c1aa: three event files vanish
    for (const e of [f.rec100, f.ev003, f.rec200]) {
      fs.rmSync(path.join(carrierDir, "events", "2026-09", `${(e as { id: string }).id}.json`), { force: true });
    }
    expect(fs.existsSync(path.join(carrierDir, "events", "2026-09", `${f.rec100.id as string}.json`))).toBe(false);

    // The replica's own admitted set is untouched — the rewind is upstream.
    expect(await k0View(store, w, f)).toEqual(before); // A-CUR1
    expect(store.checkoutStatus().status).toBe("ok"); // its own checkout is intact
    for (const e of f.k0) {
      const held = (await store.events({})).find((x) => x.id === e.id);
      expect(held?.digest).toBe(e.digest); // A-EV1 / N3
    }
    expect((await store.get(f.rec050.id as string))?.status).toBe("superseded"); // N1
    expect((await store.get(f.rec300.id as string))?.status).toBe("revoked"); // N2
    store.close();
  });

  it("Arm B — A-EV3/A-CUR2/N3: rewinding the directory that HOLDS the store reports checkout_behind_journal", async () => {
    const w = c14World();
    const f = fixture(w);
    const dir = tempDir("c14-armb");
    const store = await seeded(w, f, dir);
    const before = await k0View(store, w, f);
    const beforeDigest = store.projectionDigest();

    // `reset --hard` removes the event files that live inside the working tree.
    const month = path.join(dir, "events", "2026-09");
    const removed = [f.rec100, f.ev003].map((e) => (e as { id: string }).id);
    for (const id of removed) fs.rmSync(path.join(month, `${id}.json`), { force: true });

    // The journal still holds the admitted set and SAYS the checkout is behind.
    const status = store.checkoutStatus();
    expect(status.status).toBe("checkout_behind_journal");
    expect(status.missing.sort()).toEqual(removed.sort());
    expect(await k0View(store, w, f)).toEqual(before); // A-CUR1: no lifecycle change
    expect((await store.get(f.rec050.id as string))?.status).toBe("superseded"); // N1: no resurrection

    // Restore the checkout and rebuild: nothing acknowledged is lost (A-EV3).
    for (const e of [f.rec100, f.ev003]) fs.writeFileSync(path.join(month, `${(e as { id: string }).id}.json`), JSON.stringify(e, null, 2));
    const rebuilt = await store.rebuild();
    expect(rebuilt.acknowledged_events_lost).toBe(0); // A-EV3
    expect(rebuilt.lost).toEqual([]);
    expect(rebuilt.projection_digest).toBe(beforeDigest); // A-CUR2
    store.close();
  });

  it("A-EV2/A-EV5/A-EV8/N4: a rewind observation is an observation — it changes no record lifecycle", async () => {
    const w = c14World();
    const f = fixture(w);
    const store = await seeded(w, f);
    const before = await k0View(store, w, f);

    const checkout = sourceObservation(w, f, "checkout", C1AA);
    const reset = sourceObservation(w, f, "reset", C1AA);
    const rewrite = sourceObservation(w, f, "history_rewrite", C5BB, { rewritten_pairs: [[C2AA, "2b".repeat(20)], [C3AA, "3b".repeat(20)]] });
    for (const e of [checkout, reset, rewrite]) store.receive(e, "harness");
    await admitAndProject(store);

    for (const e of [checkout, reset, rewrite]) {
      const rec = await store.get((e as { id: string }).id);
      expect(rec?.record_type).toBe("observation"); // A-EV2/5/8
      expect(rec?.evidence_class).toBe("verified_observation");
    }
    // N4: no git operation produced a record.create/supersede/revoke/restore
    expect(await k0View(store, w, f)).toEqual(before);
    const lifecycleKinds = (await store.events({ kinds: ["superseded", "revoked", "restored", "reinstated", "archived"] })).map((e) => e.id);
    expect(lifecycleKinds.sort()).toEqual([f.ev003.id, f.ev005.id].sort());
    store.close();
  });

  it("A-EV4/A-EV6/A-EV7/N6: a rewrite adds a representation, never an event; redelivery admits once", async () => {
    const w = c14World();
    const f = fixture(w);
    const store = await seeded(w, f);

    // T4 — the same bytes arrive again under a NEW carrier path (changed layout)
    store.receive(f.rec200, "fs:carrier", `v2/events/${f.rec200.id as string}.json`);
    // T5 — the cherry-pick re-carries the same bytes under a third path
    store.receive(f.rec200, "fs:carrier", `c4bb/events/${f.rec200.id as string}.json`);
    await admitAndProject(store);

    const reps = store.representations(f.rec200.id as string);
    expect(reps.map((r) => r.carrier_id).sort()).toEqual(
      [`events/2026-09/${f.rec200.id as string}.json`, `v2/events/${f.rec200.id as string}.json`, `c4bb/events/${f.rec200.id as string}.json`].sort(),
    ); // A-EV4/A-EV7: three representations, one event
    expect(reps.every((r) => r.reachable)).toBe(true);

    // A-EV4: an unreachable old representation is retained, not deleted
    store.markRepresentationUnreachable(`events/2026-09/${f.rec200.id as string}.json`);
    const after = store.representations(f.rec200.id as string);
    expect(after).toHaveLength(3);
    expect(after.find((r) => r.carrier_id.startsWith("events/"))?.reachable).toBe(false);

    // A-EV6/N6: three delivery attempts, one admitted effect, one instance
    const st = await store.deliveryState(f.rec200.id as string);
    expect(st?.attempts).toBe(3);
    expect(st?.admissions).toBe(1);
    expect((await store.events({})).filter((e) => e.id === f.rec200.id)).toHaveLength(1);
    store.close();
  });

  it("A-CUR3/A-CUR4/N5: a rewritten revision refuses qualification and identical bytes elsewhere never requalify", async () => {
    const w = c14World();
    const f = fixture(w);
    const store = await seeded(w, f);

    const rec100 = await store.get(f.rec100.id as string);
    const rec050 = await store.get(f.rec050.id as string);
    // rec-050's anchor c1aa survived the rebase; rec-100's c2aa did not
    expect(currentUseClaim(rec100!, { repo: w.repo, path: PAY, revision: { head: C2AA } })).toEqual({ ok: true });
    expect(currentUseClaim(rec100!, { repo: w.repo, path: PAY, revision: { head: "2b".repeat(20) } })).toEqual({ ok: false, reason: "stale_revision" }); // A-CUR3
    // N5: byte-identical content at a different revision requalifies nothing —
    // qualification is keyed to revision identity, not to content.
    expect(currentUseClaim(rec100!, { repo: w.repo, path: PAY, revision: { head: C5BB } })).toEqual({ ok: false, reason: "stale_revision" }); // A-CUR4
    expect(rec050?.scope.revision?.head).toBe(C1AA); // historical anchor untouched
    store.close();
  });

  it("P1/A-CUR7/A-CUR8/A-HIS1: an authorized reinstatement works and surfaces the contradiction", async () => {
    const w = c14World();
    const f = fixture(w);
    const store = await seeded(w, f);

    const ev020 = buildEvent({
      kind: "reinstated",
      record: { type: "ruling", id: f.rec050.id as string },
      scope: { repo: w.repo, path: PAY },
      producer: { principal: w.ava.principal, kind: "human", host: w.ava.host },
      parents: [f.ev003.id as string],
      evidence_class: "human_ruling",
      payload: { target: f.rec050.id as string, reason: "the incident review was withdrawn" },
      signWith: { keyId: w.ava.keyId, kp: w.ava.kp },
    });
    store.receive(ev020, "fs:carrier");
    await admitAndProject(store);

    const rec050 = await store.get(f.rec050.id as string);
    expect(rec050?.status).toBe("restored_applicable"); // A-CUR7 / P1
    expect(rec050?.applicable).toBe(true);
    // A-CUR8: the pair with the still-applicable successor is surfaced, not auto-resolved
    expect(rec050?.conflicts).toEqual([f.rec100.id]);
    expect((await store.get(f.rec100.id as string))?.conflicts).toEqual([f.rec050.id]);
    expect((await store.get(f.rec100.id as string))?.status).toBe("active");
    // qualification refuses while the contradiction stands
    expect(currentUseClaim(rec050!, { repo: w.repo, path: PAY, revision: { head: C1AA } })).toEqual({ ok: false, reason: "conflicted" });

    // A-HIS1: the supersession window is preserved in history
    expect(rec050?.history).toEqual([f.rec050.id, f.ev003.id, ev020.id]);
    expect(rec050?.superseded_by).toEqual([f.rec100.id]);
    // N11: the reinstatement altered neither class, producer nor original anchor
    expect(rec050?.evidence_class).toBe("human_ruling");
    expect(rec050?.producer).toBe(w.ava.principal);
    expect(rec050?.scope.revision?.head).toBe(C1AA);
    store.close();
  });

  it("N2/A-EV9/A-HIS3: reinstating a REVOKED record is refused, visibly", async () => {
    const w = c14World();
    const f = fixture(w);
    const store = await seeded(w, f);

    const ev021 = buildEvent({
      kind: "reinstated",
      record: { type: "ruling", id: f.rec300.id as string },
      scope: { repo: w.repo, path: PAY },
      producer: { principal: w.ava.principal, kind: "human", host: w.ava.host },
      parents: [f.ev005.id as string],
      evidence_class: "human_ruling",
      payload: { target: f.rec300.id as string, reason: "we need the sandbox key back" },
      signWith: { keyId: w.ava.keyId, kp: w.ava.kp },
    });
    store.receive(ev021, "fs:carrier");
    await admitAndProject(store);

    const rec300 = await store.get(f.rec300.id as string);
    expect(rec300?.status).toBe("revoked"); // N2 — immediate-rejection condition
    expect(rec300?.applicable).toBe(false);
    expect(rec300?.authorizes_action).toBe(false);
    // A-EV9/A-HIS3: the refusal is recorded with a reason, never silent
    const refusal = rec300?.contested.find((c) => c.event === ev021.id);
    expect(refusal?.reason).toMatch(/withdrawn_authority_cannot_be_reinstated/);
    expect(rec300?.history).toContain(ev021.id);
    store.close();
  });

  it("N7/A-HIS4: an inference cannot supersede a ruling by citing the rewind; the refusal is recorded", async () => {
    const w = c14World();
    const f = fixture(w);
    const store = await seeded(w, f);

    const ev022 = buildEvent({
      kind: "superseded",
      record: { type: "ruling", id: f.rec100.id as string },
      scope: { repo: w.repo, path: PAY },
      producer: { principal: w.scribeB.principal, kind: "agent", host: w.bo.host },
      parents: [f.rec100.id as string, f.rec200.id as string],
      evidence_class: "model_inference",
      payload: { target: f.rec100.id as string, by: f.rec200.id as string, reason: "the rebase invalidated the cap" },
      signWith: { keyId: w.scribeB.keyId, kp: w.scribeB.kp },
    });
    store.receive(ev022, "fs:carrier");
    await admitAndProject(store);

    const rec100 = await store.get(f.rec100.id as string);
    expect(rec100?.status).toBe("active"); // N7
    expect(rec100?.superseded_by).toHaveLength(0);
    expect(rec100?.contested.find((c) => c.event === ev022.id)?.reason).toBe("lower_evidence_class_cannot_supersede_human_ruling");
    // A-HIS4: rec-200's history shows the refused supersede, and it leaves current()
    const rec200 = await store.get(f.rec200.id as string);
    expect(rec200?.status).toBe("contested");
    expect(rec200?.history).toContain(ev022.id);
    expect((await store.query({ scope: { repo: w.repo, path: PAY } })).map((r) => r.record_id)).not.toContain(f.rec200.id);
    store.close();
  });

  it("P2/A-HIS2: an explicit fresh observation requalifies at the new head while the old one stays retrievable", async () => {
    const w = c14World();
    const f = fixture(w);
    const store = await seeded(w, f);

    const ev031 = created("observation", {
      scope: { repo: w.repo, path: PAY, revision: { head: C5BB } },
      producer: { principal: w.hostA.principal, kind: "agent", host: w.hostA.host },
      parents: f.infraIds,
      evidence_class: "verified_observation",
      payload: { source_kind: "file", source_uri: "src/pay/settle.ts", observed_at: "2026-09-15T12:00:00.000Z", volatile: false, result: { revision: "c5bb", sha: "bb05" } },
      signWith: { keyId: w.hostA.keyId, kp: w.hostA.kp },
    });
    store.receive(ev031, "fs:carrier");
    await admitAndProject(store);

    const fresh = await store.get(ev031.id as string);
    expect(currentUseClaim(fresh!, { repo: w.repo, path: PAY, revision: { head: C5BB } })).toEqual({ ok: true }); // P2
    const old = await store.get(f.ev006.id as string);
    expect(old?.scope.revision?.head).toBe(C3AA); // A-HIS2: original qualification retained
    expect((old?.body as { result: { sha: string } }).result.sha).toBe("aa03");
    store.close();
  });

  it("P3/A-RCP1/A-RCP4/N9: the ordinary pipeline still works and no receipt ever becomes task_ack", async () => {
    const w = c14World();
    const f = fixture(w);
    const store = await seeded(w, f);

    const ev030 = created("ruling", {
      scope: { repo: w.repo, path: LEDGER, revision: { head: C5BB } },
      producer: { principal: w.ava.principal, kind: "human", host: w.ava.host },
      parents: f.infraIds,
      evidence_class: "human_ruling",
      payload: { statement: "ledger entries are append-only" },
      signWith: { keyId: w.ava.keyId, kp: w.ava.kp },
    });
    store.receive(ev030, "fs:carrier");
    await admitAndProject(store);

    expect((await store.deliveryState(ev030.id as string))?.state).toBe("projected"); // P3 / A-RCP4
    expect((await store.query({ scope: { repo: w.repo, path: LEDGER }, record_type: "ruling" })).map((r) => r.record_id)).toEqual([ev030.id]);
    // A-RCP1/N9: task_ack is not a state lane 02 can reach at all
    for (const e of [...f.k0, ev030]) {
      const st = await store.deliveryState((e as { id: string }).id);
      expect(st?.state).not.toBe("task_acked");
      expect(st?.state).not.toBe("injected");
    }
    expect(await store.events({ kinds: ["receipt"] })).toHaveLength(0);
    store.close();
  });

  it("A-CUR9/A-RCP3: rebuild reproduces the projection and recovers receipts rather than defaulting them", async () => {
    const w = c14World();
    const f = fixture(w);
    const dir = tempDir("c14-rcp");
    const store = await seeded(w, f, dir);
    store.receive(f.rec200, "fs:carrier", `v2/events/${f.rec200.id as string}.json`);
    await admitAndProject(store);

    const beforeDigest = store.projectionDigest();
    const beforeReceipt = await store.deliveryState(f.rec200.id as string);
    const beforeReps = store.representations(f.rec200.id as string);

    const rebuilt = await store.rebuild();
    expect(rebuilt.projection_digest).toBe(beforeDigest); // A-CUR9
    expect(rebuilt.acknowledged_events_lost).toBe(0);
    const afterReceipt = await store.deliveryState(f.rec200.id as string);
    expect(afterReceipt?.attempts).toBe(beforeReceipt?.attempts); // A-RCP3: recovered, not defaulted
    expect(afterReceipt?.admissions).toBe(1);
    expect(store.representations(f.rec200.id as string)).toEqual(beforeReps);
    store.close();
  });

  it.todo("C14 A-EV6: three delivery attempts across a REAL cherry-pick re-carry needs the producer-side attempt counter to be driven by the Git arm's outbox, which lane 03's `twining sync` owns");
  it.todo("C14 A-CUR5/N8: an offline replica labelling its view `incomplete` with a known cursor gap needs lane 04's retrieval surface");
});

/**
 * ========================= C14 §10 — THE GIT ARM =========================
 *
 * The oracle's §10 is explicit that an unimplemented Git adapter must NOT be
 * marked covered by an alternative transport's run. This block is that arm,
 * over real git: real commits, real reflog-less force-pushes, real rebases,
 * real cherry-picks, and disposable bare repositories as remotes.
 *
 * Two topologies, matching the lead's C14-ASM-1 ruling:
 *   Git Arm A — the EXCHANGE ref is rewound. The store lives beside the
 *               rewound history, so the received set shrinks and the admitted
 *               set does not.
 *   Git Arm B — source-branch mode: the event files are TRACKED, so a
 *               `reset --hard` physically removes them from the store's own
 *               directory. This is the oracle's hard variant (§11 assumption 1)
 *               and the one that produces `checkout_behind_journal`.
 */
describe("C14 §10 Git arm — real git history movement", () => {
  interface GitWorld {
    w: C14World;
    f: Fixture;
    remote: string;
    producerRepo: string;
    transport: GitTransport;
    consumer: EventStore;
    consumerTransport: GitTransport;
    inbox: Inbox;
  }

  async function gitWorld(): Promise<GitWorld> {
    const w = c14World();
    const f = fixture(w);
    const remote = bareRemote("c14");
    const producer = sourceCheckout("c14-prod");
    const consumerCheckout = sourceCheckout("c14-cons");

    const transport = new GitTransport({ twiningDir: producer.twiningDir, repoDir: producer.repoDir, remote });
    await transport.publish([...f.infra, ...f.k0] as unknown as EventEnvelope[]);

    const consumer = newStore(w, w.hostB, consumerCheckout.twiningDir, w.extraKeys);
    const consumerTransport = new GitTransport({ twiningDir: consumerCheckout.twiningDir, repoDir: consumerCheckout.repoDir, remote });
    const inbox = new Inbox(consumer, consumerTransport, w.hostB.principal);
    await inbox.pull();
    return { w, f, remote, producerRepo: producer.repoDir, transport, consumer, consumerTransport, inbox };
  }

  it("A-EV1/A-CUR1: the K0 lifecycle arrives intact over the Git carrier", async () => {
    const g = await gitWorld();
    expect(await k0View(g.consumer, g.w, g.f)).toEqual({
      [g.f.rec050.id as string]: "superseded",
      [g.f.rec100.id as string]: "active",
      [g.f.rec200.id as string]: "active",
      [g.f.rec300.id as string]: "revoked",
    });
    // Carrier identity is the COMMIT SHA, and it is recorded as a representation.
    const reps = g.consumer.representations(g.f.rec100.id as string);
    expect(reps).toHaveLength(1);
    expect(reps[0]?.carrier_id).toMatch(/^[0-9a-f]{40}$/);
    expect(reps[0]?.carrier).toContain("git:");
    g.consumer.close();
  });

  it("N1/N2/N3/A-EV1: reset + force-push of the exchange ref changes the RECEIVED set, never the admitted set", async () => {
    const g = await gitWorld();
    const before = await k0View(g.consumer, g.w, g.f);
    const beforeDigest = g.consumer.projectionDigest();

    // T2/T3 — the producer rewinds the exchange ref to its genesis and force-pushes.
    const pwt = g.transport.exchangeDir;
    const genesis = git(pwt, ["rev-list", "--max-parents=0", "HEAD"]).trim();
    git(pwt, ["reset", "--hard", genesis]);
    git(pwt, ["push", "--force", g.remote, `HEAD:refs/heads/${EXCHANGE_BRANCH}`]);

    // The consumer polls again. Its cursor is unreachable: a REWIND, reported.
    const after = await g.inbox.pull();
    expect(g.consumerTransport.lastGap.gap).toBe(true);
    expect(after.polled).toBe(0); // the carrier now holds nothing

    // ...and the consumer's own admitted set is untouched (N1/N2/N3).
    expect(await k0View(g.consumer, g.w, g.f)).toEqual(before);
    expect(g.consumer.projectionDigest()).toBe(beforeDigest);
    expect((await g.consumer.get(g.f.rec050.id as string))?.status).toBe("superseded");
    expect((await g.consumer.get(g.f.rec300.id as string))?.status).toBe("revoked");
    for (const e of g.f.k0) {
      expect((await g.consumer.events({})).find((x) => x.id === (e as { id: string }).id)?.digest).toBe((e as { digest: string }).digest);
    }
    g.consumer.close();
  });

  it("A-EV4/A-EV7: a rebase and a cherry-pick re-carry the same bytes under NEW commits — new representations, one event", async () => {
    const g = await gitWorld();
    const pwt = g.transport.exchangeDir;
    const repBefore = g.consumer.representations(g.f.rec200.id as string);
    expect(repBefore).toHaveLength(1);

    // A RELAYOUT: the same bytes under a different path — a different commit.
    const relocated = path.join(pwt, "v2", "events");
    fs.mkdirSync(relocated, { recursive: true });
    fs.writeFileSync(path.join(relocated, `${g.f.rec200.id as string}.json`), `${JSON.stringify(g.f.rec200, null, 2)}\n`);
    git(pwt, ["add", "--", `v2/events/${g.f.rec200.id as string}.json`]);
    git(pwt, ["commit", "--no-verify", "-m", "relayout"]);

    // A CHERRY-PICK: a commit authored on a side branch, replayed onto the
    // exchange branch. Same bytes, a third path, a third commit id.
    // Detached one commit back, so the replay lands on a DIFFERENT parent and
    // git is forced to mint a new commit id for identical bytes.
    git(pwt, ["checkout", "-q", "--detach", "HEAD~1"]);
    fs.mkdirSync(path.join(pwt, "c4bb", "events"), { recursive: true });
    fs.writeFileSync(path.join(pwt, "c4bb", "events", `${g.f.rec200.id as string}.json`), `${JSON.stringify(g.f.rec200, null, 2)}\n`);
    git(pwt, ["add", "--", `c4bb/events/${g.f.rec200.id as string}.json`]);
    git(pwt, ["commit", "--no-verify", "-m", "side-branch carry"]);
    const sideCommit = revParse(pwt, "HEAD") as string;
    git(pwt, ["checkout", "-q", EXCHANGE_BRANCH]);
    git(pwt, ["cherry-pick", sideCommit]);
    expect(revParse(pwt, "HEAD")).not.toBe(sideCommit); // a NEW commit id for the same bytes
    git(pwt, ["push", "--force", g.remote, `HEAD:refs/heads/${EXCHANGE_BRANCH}`]);

    await g.inbox.pull();

    // ONE event, MORE THAN ONE representation (A-EV4/A-EV7), and exactly one
    // admitted effect however many times the bytes were re-carried (N6).
    expect((await g.consumer.events({})).filter((e) => e.id === g.f.rec200.id)).toHaveLength(1);
    const reps = g.consumer.representations(g.f.rec200.id as string);
    expect(reps.length).toBeGreaterThan(1);
    expect(new Set(reps.map((r) => r.carrier_id)).size).toBe(reps.length);
    const st = await g.consumer.deliveryState(g.f.rec200.id as string);
    expect(st?.admissions).toBe(1);
    expect(st?.attempts).toBeGreaterThan(1);

    // A-EV4: an old representation is retained and marked unreachable, not deleted.
    g.consumer.markRepresentationUnreachable(repBefore[0]?.carrier_id as string);
    const after = g.consumer.representations(g.f.rec200.id as string);
    expect(after).toHaveLength(reps.length);
    expect(after.find((r) => r.carrier_id === repBefore[0]?.carrier_id)?.reachable).toBe(false);
    g.consumer.close();
  });

  it("N2: deleting the exchange branch outright revokes nothing — the tombstoned and revoked states survive", async () => {
    const g = await gitWorld();
    // Tombstone a record first, so the rewind has something to try to resurrect.
    const tomb = buildEvent({
      kind: "tombstoned",
      record: { type: "decision", id: g.f.rec200.id as string },
      scope: { repo: g.w.repo, path: PAY },
      producer: { principal: g.w.ava.principal, kind: "human", host: g.w.ava.host },
      parents: [g.f.rec200.id as string],
      evidence_class: "human_ruling",
      payload: { target: g.f.rec200.id as string, reason: "withdrawn", purge: false },
      signWith: { keyId: g.w.ava.keyId, kp: g.w.ava.kp },
    });
    await g.transport.publish([tomb as unknown as EventEnvelope]);
    await g.inbox.pull();
    expect((await g.consumer.get(g.f.rec200.id as string))?.status).toBe("tombstoned");

    // Delete the branch on the remote entirely.
    git(g.transport.exchangeDir, ["push", g.remote, `:refs/heads/${EXCHANGE_BRANCH}`]);
    expect(gitTry(g.remote, ["rev-parse", "--quiet", "--verify", EXCHANGE_BRANCH]).status).not.toBe(0);

    // The consumer polls into a carrier that no longer exists upstream.
    await g.inbox.pull();
    expect((await g.consumer.get(g.f.rec200.id as string))?.status).toBe("tombstoned"); // N2
    expect((await g.consumer.get(g.f.rec300.id as string))?.status).toBe("revoked");
    expect((await g.consumer.get(g.f.rec050.id as string))?.status).toBe("superseded");
    g.consumer.close();
  });

  it("A-CUR9: divergent heads on the exchange ref converge by union, and both replicas project identically", async () => {
    const g = await gitWorld();
    // A second producer publishes from its own checkout while the first is offline.
    const second = sourceCheckout("c14-prod2");
    const t2 = new GitTransport({ twiningDir: second.twiningDir, repoDir: second.repoDir, remote: g.remote });
    const ev030 = created("ruling", {
      scope: { repo: g.w.repo, path: LEDGER, revision: { head: C5BB } },
      producer: { principal: g.w.ava.principal, kind: "human", host: g.w.ava.host },
      parents: g.f.infraIds,
      evidence_class: "human_ruling",
      payload: { statement: "ledger entries are append-only" },
      signWith: { keyId: g.w.ava.keyId, kp: g.w.ava.kp },
    });
    await t2.publish([ev030 as unknown as EventEnvelope]);

    // The first producer publishes too, then both union-merge.
    const ev031 = created("ruling", {
      scope: { repo: g.w.repo, path: PAY, revision: { head: C5BB } },
      producer: { principal: g.w.ava.principal, kind: "human", host: g.w.ava.host },
      parents: g.f.infraIds,
      evidence_class: "human_ruling",
      payload: { statement: "settlement retries are capped at 5" },
      signWith: { keyId: g.w.ava.keyId, kp: g.w.ava.kp },
    });
    await g.transport.publish([ev031 as unknown as EventEnvelope]);
    await t2.publish([]);

    expect(g.transport.carriedEventIds()).toContain(ev030.id as string);
    expect(t2.carriedEventIds()).toContain(ev031.id as string);

    await g.inbox.pull();
    expect((await g.consumer.get(ev030.id as string))?.status).toBe("active"); // P3
    expect((await g.consumer.get(ev031.id as string))?.status).toBe("active");
    g.consumer.close();
  });

  it("Git Arm B (source-branch mode): a reset --hard removes the event FILES and the journal still holds the admitted set", async () => {
    const w = c14World();
    const f = fixture(w);
    const checkout = sourceCheckout("c14-armb-git");
    // Events ride the working branch, tracked, inside the store directory.
    const storeDir = path.join(checkout.repoDir, "store");
    const store = newStore(w, w.hostA, storeDir, w.extraKeys);
    for (const e of [...f.infra, ...f.k0]) store.receive(e, "git:source-branch", "commit-pending");
    await admitAndProject(store);
    const before = await k0View(store, w, f);
    const beforeDigest = store.projectionDigest();

    // Track and commit the store's event files, then reset --hard back past them.
    git(checkout.repoDir, ["add", "-A", "--", "store"]);
    git(checkout.repoDir, ["commit", "--no-verify", "-m", "events on the working branch"]);
    git(checkout.repoDir, ["reset", "--hard", "HEAD~1"]);
    expect(fs.existsSync(path.join(storeDir, "events", "2026-09", `${f.rec100.id as string}.json`))).toBe(false);

    // A-EV3/A-CUR1/N1: the files are physically gone, and NOTHING was revoked.
    const status = store.checkoutStatus();
    expect(status.status).toBe("checkout_behind_journal");
    expect(status.missing.length).toBeGreaterThan(0);
    await store.project(); // re-project with the files absent — the hard case
    expect(await k0View(store, w, f)).toEqual(before);
    expect(store.projectionDigest()).toBe(beforeDigest);
    expect((await store.get(f.rec050.id as string))?.status).toBe("superseded"); // N1
    expect((await store.get(f.rec300.id as string))?.status).toBe("revoked"); // N2

    // The gap is reported on the observability surface, not left implicit.
    const exchange = await store.exchangeStatus();
    expect(exchange.store.checkout).toBe("checkout_behind_journal");
    expect(exchange.gaps.find((g) => g.kind === "checkout_behind_journal")?.ids.sort()).toEqual(status.missing.sort());
    store.close();
  });

  it("N10: a full Git exchange cycle performs no unsolicited write to the user's source checkout", async () => {
    const w = c14World();
    const f = fixture(w);
    const remote = bareRemote("c14-n10");
    const checkout = sourceCheckout("c14-n10");
    dirtyTheCheckout(checkout.repoDir);
    const before = fingerprintCheckout(checkout.repoDir);

    const transport = new GitTransport({ twiningDir: checkout.twiningDir, repoDir: checkout.repoDir, remote });
    await transport.publish([...f.infra, ...f.k0] as unknown as EventEnvelope[]);
    await transport.poll(null);
    // ...including across a rewind of the exchange checkout.
    git(transport.exchangeDir, ["reset", "--hard", git(transport.exchangeDir, ["rev-list", "--max-parents=0", "HEAD"]).trim()]);
    await transport.poll({ transport: transport.id(), position: "0".repeat(40) });
    await transport.ack(w.hostB.principal, { transport: transport.id(), position: "0" });

    expect(fingerprintCheckout(checkout.repoDir)).toEqual(before);
  });
});
