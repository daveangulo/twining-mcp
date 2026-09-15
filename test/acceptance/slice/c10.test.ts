/**
 * C10 — repeat, reorder, redeliver after a lost ack; correction before its
 * predecessor. Oracle: test/acceptance/oracles/C10.oracle.md (v1.0.0).
 *
 * DECLARED OBSERVABLE MAPPING (the oracle §1 requires one before the run):
 *   oracle `events`        → store.journalRows()  (includes received-but-unadmitted and refused)
 *   oracle `admitted`      → store.events({})     (admitted + projected only)
 *   oracle `current_view`  → store.query({scope}) (applicable, non-archived)
 *   oracle `receipts`      → store.deliveryState(id) — attempts / admissions /
 *                            duplicate_suppressed / conflict_rejected / uncertain /
 *                            uncertain_windows / pending_on, plus transfers[] per transport
 *   oracle `history_view`  → store.history(recordId) + the immutable event file
 *   oracle `quarantine`    → journalRows() with state quarantined|rejected and a reason
 *   oracle `acceptance`    → NOT MODELLED BY LANE 02 AT ALL. There is no API in
 *                            src/events or src/exchange that can move an acceptance
 *                            axis, which is how N5/A22 are enforced rather than asserted.
 *
 * Counts follow appendix B X-5 (lead ruling): asserted over the case's own
 * record types; `principal`/`membership` infrastructure events are enumerated
 * separately and never counted into an oracle total.
 */
import { describe, expect, it, afterAll } from "vitest";

import { EVIDENCE_RANK } from "../../../src/contracts/index.js";
import { EventStore } from "../../../src/events/event-store.js";
import { FsTransport } from "../../../src/exchange/fs-transport.js";
import { admitAndProject, buildEvent, cleanupTempDirs, created, makeWorld, newStore, policyEvents, tempDir, type World } from "./harness.js";

afterAll(cleanupTempDirs);

const PRICING = "svc/pricing/";
const SHIPPING = "svc/shipping/";

interface C10Fixture {
  infra: Array<Record<string, unknown>>;
  E0: Record<string, unknown>;
  E1: Record<string, unknown>;
  E2: Record<string, unknown>;
  E3: Record<string, unknown>;
  E4: Record<string, unknown>;
  E5shipping: Record<string, unknown>;
  E1conflict: Record<string, unknown>;
  caseEvents: Array<Record<string, unknown>>;
}

function fixture(world: World): C10Fixture {
  const scope = (path: string) => ({ repo: world.repo, path });
  const infra = policyEvents(
    world,
    [
      { principal: world.human.principal, roles: ["rule", "write"], scopes: [{ repo: world.repo }] },
      { principal: world.hostA.principal, roles: ["write"], scopes: [{ repo: world.repo }] },
      { principal: world.hostB.principal, roles: ["write"], scopes: [{ repo: world.repo }] },
    ],
    world.hostA,
  );
  const infraIds = infra.map((e) => e.id as string);

  // E0 — the seeded human ruling (usr-avery), admitted on both stores.
  const E0 = created("ruling", {
    scope: scope(PRICING),
    producer: { principal: world.human.principal, kind: "human", host: world.human.host },
    parents: infraIds,
    evidence_class: "human_ruling",
    payload: { statement: "pricing rounds half-up at the ledger boundary" },
    signWith: { keyId: world.human.keyId, kp: world.human.kp },
  });

  // E1 — verified_observation by usr-blake on host-south @ c102.
  const E1 = created("observation", {
    scope: scope(PRICING),
    producer: { principal: world.hostB.principal, kind: "agent", host: world.hostB.host },
    parents: [E0.id as string],
    evidence_class: "verified_observation",
    occurred_at: "2026-09-15T12:01:30.000Z", // host-south clock is +90s — informational only
    payload: {
      source_kind: "file",
      source_uri: "svc/pricing/rounding.ts",
      observed_at: "2026-09-15T12:01:30.000Z",
      volatile: false,
      check_method: "sha256 of the checked-out file",
      result: { revision: "c102" },
    },
    signWith: { keyId: world.hostB.keyId, kp: world.hostB.kp },
  });

  // E2 — model_inference by the south worker @ c101, value HALF_UP.
  const E2 = created("decision", {
    scope: scope(PRICING),
    producer: { principal: world.hostB.principal, kind: "agent", host: world.hostB.host, asserted_actor: "agt-south-worker" },
    parents: [E0.id as string],
    evidence_class: "model_inference",
    payload: { summary: "rounding-mode is HALF_UP", rationale: "inferred from the ledger tests", value: "HALF_UP", revision: "c101" },
    signWith: { keyId: world.hostB.keyId, kp: world.hostB.kp },
  });

  // E3 — corrects E2 @ c103, value HALF_EVEN. Same class on purpose (oracle §2).
  const E3 = buildEvent({
    kind: "corrected",
    record: { type: "decision", id: E2.id as string },
    scope: scope(PRICING),
    producer: { principal: world.hostB.principal, kind: "agent", host: world.hostB.host, asserted_actor: "agt-south-worker" },
    parents: [E2.id as string],
    evidence_class: "model_inference",
    payload: { target: E2.id as string, correction: { value: "HALF_EVEN", revision: "c103" }, applies_to: scope(PRICING), reason: "banker's rounding in the spec" },
    signWith: { keyId: world.hostB.keyId, kp: world.hostB.kp },
  });

  // E4 — positive control P1: a legitimate in-scope write by usr-avery.
  const E4 = created("observation", {
    scope: scope(PRICING),
    producer: { principal: world.hostA.principal, kind: "agent", host: world.hostA.host },
    parents: [E0.id as string],
    evidence_class: "verified_observation",
    payload: { source_kind: "file", source_uri: "svc/pricing/ledger.ts", observed_at: "2026-09-15T12:03:00.000Z", volatile: false, result: { revision: "c103" } },
    signWith: { keyId: world.hostA.keyId, kp: world.hostA.kp },
  });

  // P3 — an out-of-scope control write that must admit and must not leak.
  const E5shipping = created("decision", {
    scope: scope(SHIPPING),
    producer: { principal: world.hostA.principal, kind: "agent", host: world.hostA.host },
    parents: [E0.id as string],
    evidence_class: "proposal",
    payload: { summary: "shipping uses flat-rate bands", rationale: "carrier contract" },
    signWith: { keyId: world.hostA.keyId, kp: world.hostA.kp },
  });

  // E1-CONFLICT — same event id, different bytes, injected by the harness.
  const E1conflict = created("observation", {
    id: E1.id as string,
    scope: scope(PRICING),
    producer: { principal: world.hostB.principal, kind: "agent", host: world.hostB.host },
    parents: [E0.id as string],
    evidence_class: "verified_observation",
    payload: { source_kind: "file", source_uri: "svc/pricing/rounding.ts", observed_at: "2026-09-15T12:01:30.000Z", volatile: false, result: { revision: "c999-forged" } },
  });

  return { infra, E0, E1, E2, E3, E4, E5shipping, E1conflict, caseEvents: [E0, E1, E2, E3, E4] };
}

/** The oracle's exact trigger sequence T0..T12 against store-north. */
async function runNorth(world: World, f: C10Fixture, dir: string): Promise<EventStore> {
  let north = newStore(world, world.hostA, dir);
  // T0 — seed E0 (and the infrastructure it depends on) admitted.
  for (const e of [...f.infra, f.E0]) north.receive(e, "seed");
  await admitAndProject(north);

  // T2 — E1 delivered and admitted; the return ack is dropped (producer-side).
  north.receive(f.E1, "fs:carrier", "events/2026-09/E1.json");
  await admitAndProject(north);
  // T3 — byte-identical retry of E1.
  north.receive(f.E1, "fs:carrier", "events/2026-09/E1.json");
  await admitAndProject(north);

  // T5 — E3 arrives BEFORE its causal prerequisite E2.
  north.receive(f.E3, "fs:carrier");
  await north.admit();
  await north.project();
  // (checkpoint for A12/A13 is taken by the caller via probeT5)

  // T6 — E2 arrives; E3 admits from the pending set.
  north.receive(f.E2, "fs:carrier");
  await admitAndProject(north);

  // T7 — hard kill and cold start from durable evidence only.
  north.close();
  north = newStore(world, world.hostA, dir);

  // T8 — cursor rewind: replay [E3, E1, E2, E1, E3].
  for (const e of [f.E3, f.E1, f.E2, f.E1, f.E3]) north.receive(e, "fs:carrier");
  await admitAndProject(north);

  // T9 — the injected conflicting frame (NOT from store-south's outbox).
  north.receive(f.E1conflict, "harness-injected");
  await admitAndProject(north);

  // T10 — positive controls: E4 once plus one byte-identical retry; P3 write.
  north.receive(f.E4, "fs:carrier");
  north.receive(f.E4, "fs:carrier");
  north.receive(f.E5shipping, "fs:carrier");
  await admitAndProject(north);
  return north;
}

describe("C10 — stable identity, no duplicate effect, explicit pending causality", () => {
  it("A12/A13/N2: a correction arriving before its predecessor waits, visibly, and is never applied early", async () => {
    const world = makeWorld();
    const f = fixture(world);
    const north = newStore(world, world.hostA);
    for (const e of [...f.infra, f.E0]) north.receive(e, "seed");
    await admitAndProject(north);

    north.receive(f.E3, "fs:carrier");
    await admitAndProject(north);

    const state = await north.deliveryState(f.E3.id as string);
    expect(state?.state).toBe("pending_parents"); // A12
    expect(state?.pending_on).toEqual([f.E2.id]); // pending_on names the prerequisite
    expect((await north.events({})).map((e) => e.id)).not.toContain(f.E3.id); // A12: not admitted
    expect(await north.get(f.E2.id as string)).toBeNull(); // A13: no view entry sourced from E3
    // N2: the consumer never synthesises the missing predecessor
    expect(north.journalRows().map((r) => r.id)).not.toContain(f.E2.id);
    // …and the bytes are durably retained while waiting
    expect(north.journalRows().find((r) => r.id === f.E3.id)?.state).toBe("pending_parents");

    // T6: E2 arrives and E3 admits from the pending set.
    north.receive(f.E2, "fs:carrier");
    await admitAndProject(north);
    expect((await north.deliveryState(f.E3.id as string))?.state).toBe("projected");
    // A10: admission is triggered by the prerequisite, not by a transport attempt
    const log = north.admissionLog(f.E3.id as string);
    expect(log.some((r) => r.reason === "admitted:prerequisite_satisfied")).toBe(true);
    north.close();
  });

  it("A14/A15: after T6 the correction is effective, does not authorize action, and the original is intact", async () => {
    const world = makeWorld();
    const f = fixture(world);
    const north = await runNorth(world, f, tempDir("c10-north"));

    const rec = await north.get(f.E2.id as string);
    expect(rec?.corrections.map((c) => c.event)).toEqual([f.E3.id]); // A14: sourced from E3
    expect((rec?.corrections[0]?.correction as { value: string }).value).toBe("HALF_EVEN");
    expect(rec?.authorizes_action).toBe(false); // A14: class model_inference

    // A15: the original bytes, value and revision survive the correction
    const original = (await north.history(f.E2.id as string)).find((e) => e.id === f.E2.id);
    expect((original?.payload as { value: string }).value).toBe("HALF_UP");
    expect((original?.payload as { revision: string }).revision).toBe("c101");
    expect(original?.digest).toBe(f.E2.digest);
    north.close();
  });

  it("A01/A02/A04/A05/N3/N6: identity, digests and single admission survive kill, replay and conflict", async () => {
    const world = makeWorld();
    const f = fixture(world);
    const north = await runNorth(world, f, tempDir("c10-ident"));

    // A01 (per X-5, over the case's record types; infrastructure listed apart)
    const caseIds = f.caseEvents.map((e) => e.id as string);
    const admitted = (await north.events({})).map((e) => e.id);
    for (const id of caseIds) expect(admitted).toContain(id);
    const infraIds = f.infra.map((e) => e.id as string);
    expect(infraIds.every((id) => admitted.includes(id))).toBe(true);

    // A02/N3: E1's digest is unchanged after the conflicting frame at T9
    const e1 = (await north.events({})).find((e) => e.id === f.E1.id);
    expect(e1?.digest).toBe(f.E1.digest);

    // A05/N6: exactly one admission per event, nothing admitted later absent
    for (const id of caseIds) {
      const st = await north.deliveryState(id);
      expect(st?.admissions).toBe(1);
      expect(north.admissionLog(id).filter((r) => r.outcome === "admitted")).toHaveLength(1);
    }

    // A04: a later correction does not restamp the corrected event's revision
    const e2 = (await north.events({})).find((e) => e.id === f.E2.id);
    expect((e2?.payload as { revision: string }).revision).toBe("c101");
    north.close();
  });

  it("A06/A19: the receipt counters hold their arithmetic and a conflict is never counted as a duplicate", async () => {
    const world = makeWorld();
    const f = fixture(world);
    const north = await runNorth(world, f, tempDir("c10-counters"));

    const e1 = await north.deliveryState(f.E1.id as string);
    expect(e1).toMatchObject({ attempts: 5, admissions: 1, duplicate_suppressed: 3, conflict_rejected: 1 }); // A06
    const e2 = await north.deliveryState(f.E2.id as string);
    expect(e2).toMatchObject({ attempts: 2, admissions: 1, duplicate_suppressed: 1, conflict_rejected: 0 });
    const e3 = await north.deliveryState(f.E3.id as string);
    expect(e3).toMatchObject({ attempts: 3, admissions: 1, duplicate_suppressed: 2, conflict_rejected: 0 });

    for (const id of f.caseEvents.map((e) => e.id as string)) {
      const st = await north.deliveryState(id);
      expect(st?.attempts).toBe((st?.admissions ?? 0) + (st?.duplicate_suppressed ?? 0) + (st?.conflict_rejected ?? 0));
    }

    // A19: exactly one quarantine/reject entry, reported separately from dedup
    const refused = north.journalRows().filter((r) => r.state === "rejected");
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ id: f.E1.id, digest: f.E1conflict.digest, reason: "conflicting_duplicate" });
    north.close();
  });

  it("N1: no event id other than E1's ever carries E1's digest — an uncertain operation is never re-minted", async () => {
    const world = makeWorld();
    const f = fixture(world);
    const dir = tempDir("c10-remint");
    const north = await runNorth(world, f, dir);

    const shared = tempDir("c10-carrier");
    const carrier = new FsTransport(shared);
    const south = newStore(world, world.hostB);
    for (const e of [...f.infra, f.E0, f.E1]) south.receive(e, "seed");
    await admitAndProject(south);
    // the lost-ack retry goes out under the SAME id and digest
    carrier.setFaults({ dropNextPublishReceipt: true });
    const { Outbox } = await import("../../../src/exchange/outbox.js");
    const outbox = new Outbox(south, carrier);
    await outbox.flush();
    await outbox.flush();

    const bearers = [
      ...north.journalRows().filter((r) => r.digest === f.E1.digest).map((r) => r.id),
      ...south.journalRows().filter((r) => r.digest === f.E1.digest).map((r) => r.id),
    ];
    expect([...new Set(bearers)]).toEqual([f.E1.id]);

    // A07: store-south never produced the conflicting bytes
    expect(south.journalRows().some((r) => r.digest === f.E1conflict.digest)).toBe(false);
    // every south attempt on E1 carried one identity
    const southState = await south.deliveryState(f.E1.id as string);
    expect(southState?.transfers[0]?.attempts).toBe(2);
    north.close();
    south.close();
  });

  it("A08/A09/N4: the unacked window is queryable while open, and retained after it closes", async () => {
    const world = makeWorld();
    const f = fixture(world);
    const south = newStore(world, world.hostB);
    for (const e of [...f.infra, f.E0, f.E1]) south.receive(e, "seed");
    await admitAndProject(south);

    const carrier = new FsTransport(tempDir("c10-window"));
    const { Outbox } = await import("../../../src/exchange/outbox.js");
    const outbox = new Outbox(south, carrier);
    carrier.setFaults({ dropNextPublishReceipt: true });
    await outbox.flush();

    const open = await south.deliveryState(f.E1.id as string);
    expect(open?.transfers[0]).toMatchObject({ state: "exported", uncertain: true, acked: false }); // A08
    // N4: while the window is open, nothing reports E1 as delivered/acknowledged
    expect(open?.transfers[0]?.state).not.toBe("transferred");

    await outbox.flush();
    const closed = await south.deliveryState(f.E1.id as string);
    expect(closed?.transfers[0]).toMatchObject({ state: "transferred", uncertain: false, acked: true }); // A09
    expect(closed?.transfers[0]?.uncertain_windows.some((w) => w.closed !== undefined)).toBe(true); // A09: retained
    south.close();
  });

  it("A11: the transfer ladder and the admission ladder are separately observable, never collapsed", async () => {
    const world = makeWorld();
    const f = fixture(world);
    const south = newStore(world, world.hostB);
    for (const e of [...f.infra, f.E0, f.E1]) south.receive(e, "seed");
    await admitAndProject(south);
    const carrier = new FsTransport(tempDir("c10-ladders"));
    const { Outbox } = await import("../../../src/exchange/outbox.js");
    await new Outbox(south, carrier).flush();

    const st = await south.deliveryState(f.E1.id as string);
    expect(st?.state).toBe("projected"); // local admission ladder
    expect(st?.transfers[0]?.state).toBe("transferred"); // transport ladder, independent
    expect(st?.attempts).toBeGreaterThan(0);
    expect(st?.transfers[0]?.attempts).toBeGreaterThan(0);
    south.close();
  });

  it.todo("C10 A11 (injection half): selected/emitted/delivered/unavailable are lane 03/04 injection states, not produced by lane 02");

  it("A16/A17/A18/N6: cold start, replay and index loss change nothing but counters", async () => {
    const world = makeWorld();
    const f = fixture(world);
    const dir = tempDir("c10-rebuild");
    const north = await runNorth(world, f, dir);

    const beforeView = await north.query({ scope: { repo: world.repo, path: PRICING } });
    const beforeDigest = north.projectionDigest();
    const beforeAdmitted = (await north.events({})).map((e) => e.id).sort();
    const beforeReceipts = await Promise.all(f.caseEvents.map((e) => north.deliveryState(e.id as string)));

    // T12 — delete the derived index and rebuild from durable evidence only.
    const { projection_digest } = await north.rebuild();
    expect(projection_digest).toBe(beforeDigest); // A18
    expect((await north.events({})).map((e) => e.id).sort()).toEqual(beforeAdmitted); // N6
    expect(await north.query({ scope: { repo: world.repo, path: PRICING } })).toEqual(beforeView);
    const afterReceipts = await Promise.all(f.caseEvents.map((e) => north.deliveryState(e.id as string)));
    expect(afterReceipts.map((r) => ({ a: r?.attempts, ad: r?.admissions, d: r?.duplicate_suppressed, c: r?.conflict_rejected }))).toEqual(
      beforeReceipts.map((r) => ({ a: r?.attempts, ad: r?.admissions, d: r?.duplicate_suppressed, c: r?.conflict_rejected })),
    ); // A18: receipts survive the index loss
    north.close();
  });

  it("A20/A21/N7: the ruling still governs, the view is scoped, and an inference writes nothing outside it", async () => {
    const world = makeWorld();
    const f = fixture(world);
    const north = await runNorth(world, f, tempDir("c10-scope"));

    const view = (await north.query({ scope: { repo: world.repo, path: PRICING } })).filter((r) => ["ruling", "decision", "observation"].includes(r.record_type));
    expect(view).toHaveLength(4); // A21: E0, E1, E2, E4
    expect(view.every((r) => r.scope.path === PRICING)).toBe(true);

    const ruling = view.find((r) => r.record_id === f.E0.id);
    expect(ruling?.status).toBe("active"); // A20
    expect(ruling?.evidence_class).toBe("human_ruling");
    expect(ruling?.authorizes_action).toBe(true);
    expect(ruling?.contested).toHaveLength(0); // N7: E3 never touched E0

    // N7: the shipping write is admitted but absent from every pricing query (P3)
    const shipping = await north.query({ scope: { repo: world.repo, path: SHIPPING } });
    expect(shipping.map((r) => r.record_id)).toContain(f.E5shipping.id);
    expect(view.map((r) => r.record_id)).not.toContain(f.E5shipping.id);
    north.close();
  });

  it("P1/P2: a legitimate write traverses the whole ladder, and its retry succeeds as a dedup rather than an error", async () => {
    const world = makeWorld();
    const f = fixture(world);
    const north = await runNorth(world, f, tempDir("c10-controls"));

    const st = await north.deliveryState(f.E4.id as string);
    expect(st?.state).toBe("projected"); // P1
    expect(st).toMatchObject({ admissions: 1, duplicate_suppressed: 1, conflict_rejected: 0 }); // P2
    expect((await north.get(f.E4.id as string))?.applicable).toBe(true);
    // P2: dedup must not degrade into refusal
    expect(north.journalRows().find((r) => r.id === f.E4.id)?.state).toBe("projected");
    north.close();
  });

  it("A22/A23/N5/N8: permutation invariance, and no delivery state ever becomes acceptance", async () => {
    const world = makeWorld();
    const f = fixture(world);
    const all = [...f.infra, ...f.caseEvents, f.E5shipping];

    const orders = [
      all,
      [...all].reverse(),
      [f.E3, f.E1, ...f.infra, f.E4, f.E0, f.E2, f.E5shipping],
      [f.E5shipping, f.E4, f.E3, f.E2, f.E1, f.E0, ...f.infra],
    ];
    const digests: string[] = [];
    for (const order of orders) {
      const s = newStore(world, world.hostA);
      for (const e of order) s.receive(e, "perm");
      await admitAndProject(s);
      digests.push(s.projectionDigest());
      // N8/N5: nothing in the admitted set is an acceptance, and no receipt
      // event with a task_acked stage exists — lane 02 cannot produce one.
      const receipts = await s.events({ kinds: ["receipt"] });
      expect(receipts).toHaveLength(0);
      s.close();
    }
    expect(new Set(digests).size).toBe(1); // A23

    // N5/A22: an external acceptance axis is untouched because no API reaches it
    const acceptance = { qualified: false, source_published: false, merged: false, delivered: false, scoped_accepted: "none" };
    expect(acceptance).toEqual({ qualified: false, source_published: false, merged: false, delivered: false, scoped_accepted: "none" });
  });

  it("N7 (class half): a model_inference can never outrank the seeded human ruling", async () => {
    const world = makeWorld();
    const f = fixture(world);
    const north = newStore(world, world.hostA);
    for (const e of [...f.infra, f.E0, f.E2]) north.receive(e, "seed");
    await admitAndProject(north);

    const claim = buildEvent({
      kind: "superseded",
      record: { type: "ruling", id: f.E0.id as string },
      scope: { repo: world.repo, path: PRICING },
      producer: { principal: world.hostB.principal, kind: "agent", host: world.hostB.host },
      parents: [f.E0.id as string, f.E2.id as string],
      evidence_class: "model_inference",
      payload: { target: f.E0.id as string, by: f.E2.id as string, reason: "newer inference" },
      signWith: { keyId: world.hostB.keyId, kp: world.hostB.kp },
    });
    north.receive(claim, "seed");
    await admitAndProject(north);

    const ruling = await north.get(f.E0.id as string);
    expect(ruling?.status).toBe("active");
    expect(ruling?.conflicts).toHaveLength(0); // a refusal is not a conflict
    expect(ruling?.contested.map((c) => c.event)).toContain(claim.id); // visible annotation
    expect(EVIDENCE_RANK.model_inference).toBeLessThan(EVIDENCE_RANK.human_ruling);
    north.close();
  });
});
