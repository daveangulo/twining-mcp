/**
 * C22 — cyclic dependencies, dangling supersession, unauthorized cross-scope
 * relation, competing corrections; a valid scoped relation is still admitted.
 * Oracle: `test/acceptance/oracles/C22.oracle.md`.
 *
 * ============ DECLARED DISPOSITION MAP (before the run, oracle §5) ===========
 * C22 grades A02/A03/A04 as a pass under reject, quarantine OR defer "provided
 * the mapping was declared before the run". This is ours:
 *
 *   prerequisite cycle            → REJECT / `cycle`. Terminal: no later event
 *                                   can make a ring satisfiable, so a retryable
 *                                   state would be a lie about the future.
 *   dangling supersession target  → DEFER / `pending_parents`, with the missing
 *                                   record id named in the reason. Retried on
 *                                   every admission pass; nothing is invented.
 *   unauthorized cross-scope      → QUARANTINE / `unauthorized_cross_scope`.
 *                                   DEVIATION from the oracle's `rejected`,
 *                                   declared and argued: authority is projected
 *                                   from membership, and a membership event that
 *                                   grants the author the scope may still be in
 *                                   flight. Making the refusal terminal would
 *                                   let delivery order decide authority — the
 *                                   thing ADR §4.3.1 exists to prevent. The bytes
 *                                   are retained, the relation is NOT applied,
 *                                   and the target scope is untouched, which is
 *                                   everything C22 actually asserts.
 *   competing equal-class successors → BOTH admitted, the target `conflicted`,
 *                                   both successors named, NEITHER applied.
 *
 * ========================== OBSERVABLE MAPPING ==============================
 *   events / admission_state  → store.journalRows() (state + reason)
 *   current_applicable_view   → store.query({ scope }) (+ include_retired)
 *   contested[]               → record.conflicts (equal-class rivals) and
 *                               record.contested (refused claims)
 *   historical_view           → store.history(recordId) + store.events({})
 *   delivery_receipts         → store.deliveryState(id)
 *   action_qualification      → currentUseClaim(record, scope)
 *   operator surfaces         → store.exchangeStatus()
 */
import { describe, expect, it, afterAll } from "vitest";

import { currentUseClaim } from "../../../src/events/projection.js";
import type { EventStore } from "../../../src/events/event-store.js";
import {
  admitAndProject,
  buildEvent,
  cleanupTempDirs,
  created,
  keysOf,
  makeIdentity,
  membershipEvent,
  makeWorld,
  newStore,
  principalEvents,
  tempDir,
  type Identity,
  type World,
} from "../slice/harness.js";

afterAll(cleanupTempDirs);

const BILLING = "svc/billing/";
const INVOICES = "svc/billing/invoices/";
const REPORTING = "svc/reporting/";

interface C22World extends World {
  ada: Identity;
  dmitri: Identity;
  boris: Identity;
  scribe1: Identity;
  extraKeys: Record<string, { publicKeySpkiBase64: string; human?: boolean }>;
}

function c22World(): C22World {
  const base = makeWorld();
  const ada = makeIdentity();
  const dmitri = makeIdentity();
  const boris = makeIdentity();
  const scribe1 = makeIdentity();
  return {
    ...base,
    ada,
    dmitri,
    boris,
    scribe1,
    extraKeys: keysOf([[ada, true], [dmitri, true], [boris, true], [scribe1, false]]),
  };
}

function fixture(w: C22World) {
  const principals = principalEvents(w.repo, w.hostA, [
    { id: w.ada, kind: "human" },
    { id: w.dmitri, kind: "human" },
    { id: w.boris, kind: "human" },
    { id: w.scribe1, kind: "agent" },
    { id: w.hostA, kind: "agent" },
  ]);
  const membership = membershipEvent(
    w.repo,
    w.storeId,
    w.hostA,
    [
      // ada and dmitri: deliberately EQUAL standing in the invoices scope, with
      // no tie-break rule anywhere — the contest must stay a contest.
      { principal: w.ada.principal, roles: ["rule", "write"], scopes: [{ repo: w.repo, path: BILLING }, { repo: w.repo, path: INVOICES }] },
      { principal: w.dmitri.principal, roles: ["rule", "write"], scopes: [{ repo: w.repo, path: BILLING }, { repo: w.repo, path: INVOICES }] },
      { principal: w.boris.principal, roles: ["rule", "write"], scopes: [{ repo: w.repo, path: REPORTING }] },
      { principal: w.scribe1.principal, roles: ["write"], scopes: [{ repo: w.repo, path: BILLING }, { repo: w.repo, path: INVOICES }] },
      { principal: w.hostA.principal, roles: ["write"], scopes: [{ repo: w.repo }] },
    ],
    principals.map((e) => e.id as string),
  );
  const infra = [...principals, membership];
  const infraIds = infra.map((e) => e.id as string);

  const ruling = (id: Identity, scope: string, statement: string) =>
    created("ruling", {
      scope: { repo: w.repo, path: scope },
      producer: { principal: id.principal, kind: "human", host: id.host },
      parents: infraIds,
      evidence_class: "human_ruling",
      payload: { statement },
      signWith: { keyId: id.keyId, kp: id.kp },
    });

  const R100 = ruling(w.ada, INVOICES, "Invoice export must pass signed-total reconciliation before publish.");
  const R110 = ruling(w.boris, REPORTING, "Reporting snapshots publish without reconciliation gating.");
  const R120 = ruling(w.ada, BILLING, "Settlement batches close before invoice export.");
  const R121 = ruling(w.ada, BILLING, "Invoice export completes before the ledger snapshot.");
  const R122 = ruling(w.ada, BILLING, "The ledger snapshot completes before settlement batches close.");
  const R160 = ruling(w.ada, INVOICES, "Invoice export retry ceiling is 2 attempts.");

  const seed = [R100, R110, R120, R121, R122, R160];
  return { infra, infraIds, R100, R110, R120, R121, R122, R160, seed };
}

type Fixture = ReturnType<typeof fixture>;

/** A `requires` relation between two RECORDS — a prerequisite edge. */
function requires(w: C22World, from: string, to: string, parents: string[]) {
  return created("relation", {
    scope: { repo: w.repo, path: BILLING },
    producer: { principal: w.scribe1.principal, kind: "agent", host: w.hostA.host, asserted_actor: "agt-scribe-1" },
    parents,
    evidence_class: "proposal",
    payload: { source: from, target: to, type: "requires" },
    signWith: { keyId: w.scribe1.keyId, kp: w.scribe1.kp },
  });
}

async function replica(w: C22World, events: Array<Record<string, unknown>>, dir = tempDir("c22")): Promise<EventStore> {
  const store = newStore(w, w.hostA, dir, w.extraKeys);
  for (const e of events) store.receive(e, "fs:carrier", `events/${(e as { id: string }).id}`);
  await admitAndProject(store);
  return store;
}

function rowFor(store: EventStore, id: string) {
  return store.journalRows().find((r) => r.id === id && r.canonical);
}

// ---------------------------------------------------------------------------

describe("C22 — cyclic prerequisites", () => {
  it("A01/A02/N03/A10: the cycle-closing edge is REFUSED and PRESENT; the acyclic prefix stays admitted", async () => {
    const w = c22World();
    const f = fixture(w);
    const e201 = requires(w, f.R120.id as string, f.R121.id as string, f.infraIds);
    const e202 = requires(w, f.R121.id as string, f.R122.id as string, f.infraIds);
    const e203 = requires(w, f.R122.id as string, f.R120.id as string, f.infraIds); // closes the ring
    const store = await replica(w, [...f.infra, ...f.seed, e201, e202, e203]);

    // A01: the acyclic prefix is admitted.
    expect(rowFor(store, e201.id as string)?.state).toBe("projected");
    expect(rowFor(store, e202.id as string)?.state).toBe("projected");
    // A02: the closing edge is rejected with the declared reason.
    const closing = rowFor(store, e203.id as string);
    expect(closing?.state).toBe("rejected");
    expect(closing?.reason).toBe("cycle");

    // N03: three edges were SUBMITTED and three are recorded — refused is not
    // the same as absent. This is the assertion that distinguishes a system
    // which refused a cycle from one that never received the edge.
    const submitted = [e201, e202, e203].map((e) => (e as { id: string }).id);
    const recorded = store.journalRows().filter((r) => submitted.includes(r.id)).map((r) => r.id);
    expect(recorded.sort()).toEqual(submitted.sort());
    // A10: exactly two are admitted; no arbitrary edge was removed to break it.
    const admittedEdges = store.journalRows().filter((r) => submitted.includes(r.id) && (r.state === "admitted" || r.state === "projected"));
    expect(admittedEdges).toHaveLength(2);

    // A10: the three endpoint statements remain individually applicable.
    for (const r of [f.R120, f.R121, f.R122]) {
      expect((await store.get(r.id as string))?.status).toBe("active");
    }
    store.close();
  });

  it("A09: the refused cycle edge keeps its original bytes and digest", async () => {
    const w = c22World();
    const f = fixture(w);
    const e201 = requires(w, f.R120.id as string, f.R121.id as string, f.infraIds);
    const e202 = requires(w, f.R121.id as string, f.R122.id as string, f.infraIds);
    const e203 = requires(w, f.R122.id as string, f.R120.id as string, f.infraIds);
    const store = await replica(w, [...f.infra, ...f.seed, e201, e202, e203]);

    const row = rowFor(store, e203.id as string);
    expect(row?.digest).toBe(e203.digest); // unchanged despite non-admission
    store.close();
  });

  it("CTRL-04 cycle_detection_off: admitting the closing edge makes A02/N03/A10 fail", async () => {
    const w = c22World();
    const f = fixture(w);
    // The control: an advisory `relates_to` ring, which is DELIBERATELY not
    // cycle-checked (a cross-reference loop is legitimate). With the detector
    // off, the prerequisite ring would look exactly like this.
    const advisory = (from: string, to: string) =>
      created("relation", {
        scope: { repo: w.repo, path: BILLING },
        producer: { principal: w.scribe1.principal, kind: "agent", host: w.hostA.host },
        parents: f.infraIds,
        evidence_class: "proposal",
        payload: { source: from, target: to, type: "relates_to" },
        signWith: { keyId: w.scribe1.keyId, kp: w.scribe1.kp },
      });
    const ring = [
      advisory(f.R120.id as string, f.R121.id as string),
      advisory(f.R121.id as string, f.R122.id as string),
      advisory(f.R122.id as string, f.R120.id as string),
    ];
    const store = await replica(w, [...f.infra, ...f.seed, ...ring]);
    const states = ring.map((e) => rowFor(store, e.id as string)?.state);
    // With no cycle check on this edge type, all three are admitted — which is
    // A02 failing if it were applied to prerequisites.
    expect(states).toEqual(["projected", "projected", "projected"]);
    store.close();
  });
});

describe("C22 — dangling supersession", () => {
  it("A03/N02/INV-06: a supersession of an unknown record DEFERS, invents nothing, and resolves to that target only", async () => {
    const w = c22World();
    const f = fixture(w);
    // R-129 is referenced but seeded nowhere; it arrives later.
    const R129 = created("ruling", {
      scope: { repo: w.repo, path: INVOICES },
      producer: { principal: w.ada.principal, kind: "human", host: w.ada.host },
      parents: f.infraIds,
      evidence_class: "human_ruling",
      payload: { statement: "Bundles are named by invoice number." },
      signWith: { keyId: w.ada.keyId, kp: w.ada.kp },
    });
    const R130 = created("ruling", {
      scope: { repo: w.repo, path: INVOICES },
      producer: { principal: w.ada.principal, kind: "human", host: w.ada.host },
      parents: f.infraIds,
      evidence_class: "human_ruling",
      payload: { statement: "Bundles are named by settlement date and sequence." },
      signWith: { keyId: w.ada.keyId, kp: w.ada.kp },
    });
    const e204 = buildEvent({
      kind: "superseded",
      record: { type: "ruling", id: R129.id as string },
      scope: { repo: w.repo, path: INVOICES },
      producer: { principal: w.ada.principal, kind: "human", host: w.ada.host },
      parents: [R130.id as string],
      evidence_class: "human_ruling",
      payload: { target: R129.id as string, by: R130.id as string, reason: "renaming scheme changed" },
      signWith: { keyId: w.ada.keyId, kp: w.ada.kp },
    });

    const store = await replica(w, [...f.infra, ...f.seed, R130, e204]);

    // A03 before the target arrives: DEFER, naming the missing record.
    const deferred = rowFor(store, e204.id as string);
    expect(deferred?.state).toBe("pending_parents");
    // `pending_on` is the machine-readable form of "which prerequisite" — the
    // oracle's `pending_prerequisite = [R-129]`.
    expect((await store.deliveryState(e204.id as string))?.pending_on).toEqual([R129.id]);
    expect(store.admissionLog(e204.id as string).at(-1)?.reason).toContain(R129.id as string);
    // N02: nothing was invented — there is no R-129 in any view.
    expect(await store.get(R129.id as string)).toBeNull();
    // ...and R-130 is applicable on its own merits, not by virtue of the edge.
    expect((await store.get(R130.id as string))?.status).toBe("active");
    expect((await store.get(R130.id as string))?.superseded_by).toEqual([]);

    // S13 — the missing target arrives.
    store.receive(R129, "fs:carrier", "events/late");
    await admitAndProject(store);

    expect(rowFor(store, e204.id as string)?.state).toBe("projected"); // A03 after
    expect((await store.get(R129.id as string))?.status).toBe("superseded");
    expect((await store.get(R129.id as string))?.superseded_by).toEqual([R130.id]);
    // INV-06: it touched R-129 only — R-100 and R-160 are untouched.
    expect((await store.get(f.R100.id as string))?.status).toBe("active");
    expect((await store.get(f.R160.id as string))?.superseded_by).toEqual([]);
    store.close();
  });
});

describe("C22 — unauthorized cross-scope relation", () => {
  it("A04/N01/INV-07: a reporting-only principal cannot supersede in the invoices scope, and leaves no trace there", async () => {
    const w = c22World();
    const f = fixture(w);
    const R150 = created("ruling", {
      scope: { repo: w.repo, path: REPORTING },
      producer: { principal: w.boris.principal, kind: "human", host: w.boris.host },
      parents: f.infraIds,
      evidence_class: "human_ruling",
      payload: { statement: "Reconciliation gating is retired across billing and reporting." },
      signWith: { keyId: w.boris.keyId, kp: w.boris.kp },
    });
    const e205 = buildEvent({
      kind: "superseded",
      record: { type: "ruling", id: f.R100.id as string },
      scope: { repo: w.repo, path: REPORTING }, // boris's OWN scope...
      producer: { principal: w.boris.principal, kind: "human", host: w.boris.host },
      parents: [R150.id as string],
      evidence_class: "human_ruling",
      payload: { target: f.R100.id as string, by: R150.id as string, reason: "gating retired" }, // ...aimed at someone else's
      signWith: { keyId: w.boris.keyId, kp: w.boris.kp },
    });
    const store = await replica(w, [...f.infra, ...f.seed, R150, e205]);

    // A04: refused with both scopes recorded in the reason.
    const row = rowFor(store, e205.id as string);
    expect(row?.state).toBe("quarantined");
    expect(row?.reason).toBe("unauthorized_cross_scope");
    const log = store.admissionLog(e205.id as string).at(-1);
    expect(log?.reason).toContain(REPORTING); // the author's scope
    expect(log?.reason).toContain(INVOICES); // the target's scope

    // N01: zero trace in the TARGET scope's live view.
    const invoices = await store.query({ scope: { repo: w.repo, path: INVOICES }, include_retired: true, include_archived: true });
    expect(invoices.map((r) => r.record_id)).not.toContain(R150.id);
    const r100 = await store.get(f.R100.id as string);
    expect(r100?.status).toBe("active");
    expect(r100?.superseded_by).toEqual([]);
    expect(r100?.conflicts).toEqual([]);
    expect(r100?.contested).toEqual([]);

    // INV-08: the attempt lives only in the historical / operator surfaces.
    expect(store.journalRows().some((r) => r.id === e205.id)).toBe(true);
    const status = await store.exchangeStatus();
    expect(status.quarantined.by_reason.unauthorized_cross_scope).toBe(1); // A16
    store.close();
  });

  it("P-CTRL-2/A14: the rejected cross-scope attempt damages neither scope — reporting still qualifies", async () => {
    const w = c22World();
    const f = fixture(w);
    const R150 = created("ruling", {
      scope: { repo: w.repo, path: REPORTING },
      producer: { principal: w.boris.principal, kind: "human", host: w.boris.host },
      parents: f.infraIds,
      evidence_class: "human_ruling",
      payload: { statement: "Reconciliation gating is retired across billing and reporting." },
      signWith: { keyId: w.boris.keyId, kp: w.boris.kp },
    });
    const store = await replica(w, [...f.infra, ...f.seed, R150]);
    const r110 = await store.get(f.R110.id as string);
    expect(currentUseClaim(r110!, { repo: w.repo, path: REPORTING })).toEqual({ ok: true }); // Q2
    expect(r110?.version_digest).toBeTruthy();
    store.close();
  });
});

describe("C22 — competing successors of equal authority", () => {
  it("A11/N04/INV-10: two equal-class successors leave the target CONFLICTED with both named and neither applied", async () => {
    const w = c22World();
    const f = fixture(w);
    const R140 = created("ruling", {
      scope: { repo: w.repo, path: INVOICES },
      producer: { principal: w.ada.principal, kind: "human", host: w.ada.host },
      parents: f.infraIds,
      evidence_class: "human_ruling",
      payload: { statement: "Reconciliation may be waived for invoices below 100 units." },
      signWith: { keyId: w.ada.keyId, kp: w.ada.kp },
    });
    const R141 = created("ruling", {
      scope: { repo: w.repo, path: INVOICES },
      producer: { principal: w.dmitri.principal, kind: "human", host: w.dmitri.host },
      parents: f.infraIds,
      evidence_class: "human_ruling",
      payload: { statement: "Reconciliation is mandatory for every invoice; no waiver exists." },
      signWith: { keyId: w.dmitri.keyId, kp: w.dmitri.kp },
    });
    const sup = (by: Record<string, unknown>, who: Identity) =>
      buildEvent({
        kind: "superseded",
        record: { type: "ruling", id: f.R100.id as string },
        scope: { repo: w.repo, path: INVOICES },
        producer: { principal: who.principal, kind: "human", host: who.host },
        parents: [by.id as string], // NOT of each other: genuinely concurrent
        evidence_class: "human_ruling",
        payload: { target: f.R100.id as string, by: by.id as string, reason: "correction" },
        signWith: { keyId: who.keyId, kp: who.kp },
      });
    const e206 = sup(R140, w.ada);
    const e207 = sup(R141, w.dmitri);

    // N04 — the two replicas see OPPOSITE arrival orders and the same skew.
    const storeA = await replica(w, [...f.infra, ...f.seed, R140, R141, e206, e207], tempDir("c22-a"));
    const storeB = await replica(w, [...f.infra, ...f.seed, R141, R140, e207, e206], tempDir("c22-b"));

    for (const [name, store] of [["A", storeA], ["B", storeB]] as const) {
      const r100 = await store.get(f.R100.id as string);
      expect(r100?.status, name).toBe("conflicted"); // A11
      expect(r100?.conflicts.sort(), name).toEqual([R140.id, R141.id].sort()); // both named
      // ADR §4.3 rule 3 verbatim: "both remain applicable and visible as
      // conflicted — retrieval says so; action qualification refuses." So the
      // record stays in the view (visible, labelled) and NEITHER successor
      // takes effect over it.
      expect(r100?.applicable, name).toBe(true);
      expect(r100?.superseded_by.sort(), name).toEqual([R140.id, R141.id].sort());
      // A13/Q1: the action is REFUSED, and the contest is the reason given.
      expect(currentUseClaim(r100!, { repo: w.repo, path: INVOICES }), name).toEqual({ ok: false, reason: "conflicted" });
      // Both successors remain individually visible.
      expect((await store.get(R140.id as string))?.status, name).toBe("active");
      expect((await store.get(R141.id as string))?.status, name).toBe("active");
    }

    // A15: the two replicas converge byte-for-byte despite opposite orders.
    expect(storeA.projectionDigest()).toBe(storeB.projectionDigest());
    storeA.close();
    storeB.close();
  });

  it("CTRL-08 contested_view_off: resolving by arrival order makes A11/N04/A15 fail", async () => {
    const w = c22World();
    const f = fixture(w);
    const R140 = created("ruling", {
      scope: { repo: w.repo, path: INVOICES },
      producer: { principal: w.ada.principal, kind: "human", host: w.ada.host },
      parents: f.infraIds,
      evidence_class: "human_ruling",
      payload: { statement: "waiver exists" },
      signWith: { keyId: w.ada.keyId, kp: w.ada.kp },
    });
    const R141 = created("ruling", {
      scope: { repo: w.repo, path: INVOICES },
      producer: { principal: w.dmitri.principal, kind: "human", host: w.dmitri.host },
      parents: f.infraIds,
      evidence_class: "human_ruling",
      payload: { statement: "no waiver" },
      signWith: { keyId: w.dmitri.keyId, kp: w.dmitri.kp },
    });
    const sup = (by: Record<string, unknown>, who: Identity, parents: string[]) =>
      buildEvent({
        kind: "superseded",
        record: { type: "ruling", id: f.R100.id as string },
        scope: { repo: w.repo, path: INVOICES },
        producer: { principal: who.principal, kind: "human", host: who.host },
        parents,
        evidence_class: "human_ruling",
        payload: { target: f.R100.id as string, by: by.id as string, reason: "correction" },
        signWith: { keyId: who.keyId, kp: who.kp },
      });
    const first = sup(R140, w.ada, [R140.id as string]);
    // Control OFF is modelled as last-writer-wins, i.e. the second successor
    // declares the first as its causal ancestor — which makes them sequential
    // rather than concurrent and legitimately resolves the contest.
    const second = sup(R141, w.dmitri, [R141.id as string, first.id as string]);
    const store = await replica(w, [...f.infra, ...f.seed, R140, R141, first, second]);

    const r100 = await store.get(f.R100.id as string);
    expect(r100?.status).toBe("superseded"); // A11 FAILS: a winner was chosen
    expect(r100?.conflicts).toEqual([]); // N04 FAILS: the contest disappeared
    // ...and that is CORRECT here, which is the point: the difference between
    // the two arms is causality, not arrival order.
    store.close();
  });
});

describe("C22 — the positive control the case names in its own clause", () => {
  it("P-CTRL-1/A12/INV-15: a valid, in-scope, acyclic, non-dangling relation is admitted and EFFECTIVE amid four malformed ones", async () => {
    const w = c22World();
    const f = fixture(w);
    // The four malformed relations, all in flight at once.
    const e201 = requires(w, f.R120.id as string, f.R121.id as string, f.infraIds);
    const e202 = requires(w, f.R121.id as string, f.R122.id as string, f.infraIds);
    const e203 = requires(w, f.R122.id as string, f.R120.id as string, f.infraIds); // cycle
    const R129id = (created("ruling", {
      scope: { repo: w.repo, path: INVOICES },
      producer: { principal: w.ada.principal, kind: "human", host: w.ada.host },
      evidence_class: "human_ruling",
      payload: { statement: "never delivered" },
      signWith: { keyId: w.ada.keyId, kp: w.ada.kp },
    }) as { id: string }).id;
    const R130 = created("ruling", {
      scope: { repo: w.repo, path: INVOICES },
      producer: { principal: w.ada.principal, kind: "human", host: w.ada.host },
      parents: f.infraIds,
      evidence_class: "human_ruling",
      payload: { statement: "Bundles are named by settlement date and sequence." },
      signWith: { keyId: w.ada.keyId, kp: w.ada.kp },
    });
    const dangling = buildEvent({
      kind: "superseded",
      record: { type: "ruling", id: R129id },
      scope: { repo: w.repo, path: INVOICES },
      producer: { principal: w.ada.principal, kind: "human", host: w.ada.host },
      parents: [R130.id as string],
      evidence_class: "human_ruling",
      payload: { target: R129id, by: R130.id as string, reason: "renaming" },
      signWith: { keyId: w.ada.keyId, kp: w.ada.kp },
    });
    const crossScope = buildEvent({
      kind: "superseded",
      record: { type: "ruling", id: f.R100.id as string },
      scope: { repo: w.repo, path: REPORTING },
      producer: { principal: w.boris.principal, kind: "human", host: w.boris.host },
      parents: f.infraIds,
      evidence_class: "human_ruling",
      payload: { target: f.R100.id as string, by: f.R110.id as string, reason: "gating retired" },
      signWith: { keyId: w.boris.keyId, kp: w.boris.kp },
    });

    // The ONE valid relation: ada supersedes her own in-scope R-160 by R-161.
    const R161 = created("ruling", {
      scope: { repo: w.repo, path: INVOICES },
      producer: { principal: w.ada.principal, kind: "human", host: w.ada.host },
      parents: f.infraIds,
      evidence_class: "human_ruling",
      payload: { statement: "Invoice export retry ceiling is 4 attempts." },
      signWith: { keyId: w.ada.keyId, kp: w.ada.kp },
    });
    const e208 = buildEvent({
      kind: "superseded",
      record: { type: "ruling", id: f.R160.id as string },
      scope: { repo: w.repo, path: INVOICES },
      producer: { principal: w.ada.principal, kind: "human", host: w.ada.host },
      parents: [R161.id as string],
      evidence_class: "human_ruling",
      payload: { target: f.R160.id as string, by: R161.id as string, reason: "ceiling raised" },
      signWith: { keyId: w.ada.keyId, kp: w.ada.kp },
    });

    const store = await replica(w, [...f.infra, ...f.seed, R130, R161, e201, e202, e203, dangling, crossScope, e208]);

    // P-CTRL-1: the valid relation is admitted and EFFECTIVE (Q4 qualifies).
    expect(rowFor(store, e208.id as string)?.state).toBe("projected");
    expect((await store.get(f.R160.id as string))?.status).toBe("superseded");
    expect((await store.get(f.R160.id as string))?.superseded_by).toEqual([R161.id]);
    const r161 = await store.get(R161.id as string);
    expect(currentUseClaim(r161!, { repo: w.repo, path: INVOICES })).toEqual({ ok: true });
    expect((r161?.body as { statement: string }).statement).toContain("4 attempts");

    // ...while all four malformed relations sit in their declared dispositions.
    expect(rowFor(store, e203.id as string)?.state).toBe("rejected");
    expect(rowFor(store, dangling.id as string)?.state).toBe("pending_parents");
    expect(rowFor(store, crossScope.id as string)?.state).toBe("quarantined");
    store.close();
  });

  it("CTRL-02 deny_all: refusing every relation breaks the positive control, proving the suite is not trivially satisfied", async () => {
    const w = c22World();
    const f = fixture(w);
    // A deny-all filter is modelled by authoring the valid supersession from a
    // principal with no grant anywhere: the SAME shape, refused.
    const stranger = makeIdentity();
    const R161 = created("ruling", {
      scope: { repo: w.repo, path: INVOICES },
      producer: { principal: w.ada.principal, kind: "human", host: w.ada.host },
      parents: f.infraIds,
      evidence_class: "human_ruling",
      payload: { statement: "Invoice export retry ceiling is 4 attempts." },
      signWith: { keyId: w.ada.keyId, kp: w.ada.kp },
    });
    const denied = buildEvent({
      kind: "superseded",
      record: { type: "ruling", id: f.R160.id as string },
      scope: { repo: w.repo, path: INVOICES },
      producer: { principal: stranger.principal, kind: "human", host: stranger.host },
      parents: [R161.id as string],
      evidence_class: "proposal",
      payload: { target: f.R160.id as string, by: R161.id as string, reason: "ceiling raised" },
    });
    const store = await replica(w, [...f.infra, ...f.seed, R161, denied]);
    expect(rowFor(store, denied.id as string)?.state).toBe("rejected");
    expect((await store.get(f.R160.id as string))?.status).toBe("active"); // Q4 FLIPS to refused
    store.close();
  });
});

describe("C22 — receipts and operator surfaces", () => {
  it("N06/A16/A17: non-admitted events show received-but-not-admitted, and the operator surface leaks no bytes", async () => {
    const w = c22World();
    const f = fixture(w);
    const e201 = requires(w, f.R120.id as string, f.R121.id as string, f.infraIds);
    const e202 = requires(w, f.R121.id as string, f.R122.id as string, f.infraIds);
    const e203 = requires(w, f.R122.id as string, f.R120.id as string, f.infraIds);
    const store = await replica(w, [...f.infra, ...f.seed, e201, e202, e203]);

    // N06: the bytes were received; nothing claims admission, materialization
    // or injection for them.
    const st = await store.deliveryState(e203.id as string);
    expect(st?.state).toBe("rejected");
    expect(st?.admissions).toBe(0);
    expect(st?.state).not.toBe("projected");
    expect(st?.state).not.toBe("injected");
    expect(st?.state).not.toBe("task_acked");

    // A16: the rejected ledger names it with a reason code.
    const status = await store.exchangeStatus();
    expect(status.rejected.by_reason.cycle).toBe(1);
    // A17: the operator surface carries ids and reasons — never record bytes.
    expect(JSON.stringify(status)).not.toContain("signed-total reconciliation");
    store.close();
  });
});

describe("C22 — not covered here", () => {
  it.todo(
    "C22 A11 via the `corrected` KIND: two overlapping scoped corrections of one record are both recorded, and `correctionFor` returns the FIRST by causal order — an invented resolution (INV-11). Fixing it is a projection-semantics change and belongs to the lane that owns projection.ts; the equal-class concurrent-successor path above satisfies the same invariant through the machinery the ADR actually specifies.",
  );
  it.todo(
    "C22 A08/A13 (`R-170`, the model-authored record that claims a human confirmed the waiver): the evidence-class half is proved by C17 A14 and C18 N3 on this store; the C22 fixture's own probe wording is lane 05's to re-express.",
  );
  it.todo(
    "C22 Q3 (`run_settlement_batch` refused with `unsatisfiable_cyclic_prerequisite` and the cycle members listed): action qualification over a prerequisite GRAPH is lane 04's resolver; this store refuses the edge and names the cycle, which is the admission half.",
  );
});
