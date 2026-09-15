/**
 * C16 — partial supersession, revocation, archival, restoration.
 * Oracle: C16.oracle.md (v1.0.0).
 *
 * DECLARED OBSERVABLE MAPPING (oracle §3; §8 requires it fixed before the run):
 *   events(store)                          → store.events({}) (admitted) / journalRows() (everything held)
 *   current(store, scope, include_archived) → store.query({ scope, include_archived, include_retired })
 *   current(..., as_of=t)                  → store.projectionAsOf(<cut event id>) — a replay to a LOGICAL
 *                                            cut (Q6), never a wall-clock filter
 *   history(store, subject)                → store.get(id).history + store.history(id)
 *   receipts(store, event_id)              → store.deliveryState(id): local ladder + transfers[] + the
 *                                            rejected ledger in journalRows()
 *
 * DECLARED MODEL LIMITS (each has a matching todo below, none is a silent relaxation):
 *   L1 A `decision` is the only record type that carries `parts`, and validate.ts
 *      reserves `human_ruling` for `ruling` records — so a multi-part record can
 *      never carry human-ruling authority. D1 is therefore class `proposal`, and
 *      the human authority the case needs lives on separate `ruling` records.
 *   L2 `parts` are `{part_id, text}` with no scope and no evidence class of their
 *      own, so P1/P2/P3 cannot hold three different classes as the oracle's §4
 *      table declares.
 *   L3 The `revoked` payload is `{target, reason}` with no `parts`, so part-level
 *      revocation is unrepresentable; R1 (a `ruling` in svc/billing/invoicing/)
 *      plays the revocable-authority role the oracle gives D1#P1.
 *   L4 Parts carry no version identity, so A1.3's `record_version_id` is asserted
 *      on the parts' own observable fields.
 */
import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";

import type { EventStore } from "../../../src/events/event-store.js";
import { FsTransport } from "../../../src/exchange/fs-transport.js";
import { Outbox } from "../../../src/exchange/outbox.js";
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

const BILLING = "svc/billing/";
const TAX = "svc/billing/tax/";
const INVOICING = "svc/billing/invoicing/";
const LEDGER = "svc/billing/ledger/";
const C1 = "1".repeat(40);
const C2 = "2".repeat(40);
const C3 = "3".repeat(40);

interface C16World extends World {
  hera: Identity;
  juno: Identity;
  scribe: Identity;
  extraKeys: Record<string, { publicKeySpkiBase64: string; human?: boolean }>;
}

function c16World(): C16World {
  const base = makeWorld();
  const hera = makeIdentity();
  const juno = makeIdentity();
  const scribe = makeIdentity();
  return { ...base, hera, juno, scribe, extraKeys: keysOf([[hera, true], [juno, true], [scribe, false]]) };
}

function fixture(w: C16World) {
  const principals = principalEvents(w.repo, w.hostA, [
    { id: w.hera, kind: "human" },
    { id: w.juno, kind: "human" },
    { id: w.scribe, kind: "agent" },
    { id: w.hostA, kind: "agent" },
  ]);
  // hera: all of svc/billing/. juno: svc/billing/tax/ ONLY. agt_scribe: only
  // its own ledger corner — which is what makes EV06's svc/billing/ claim
  // unauthorized rather than merely out-ranked.
  const membership = membershipEvent(
    w.repo,
    w.storeId,
    w.hostA,
    [
      { principal: w.hera.principal, roles: ["rule", "write"], scopes: [{ repo: w.repo, path: BILLING }] },
      { principal: w.juno.principal, roles: ["rule", "write"], scopes: [{ repo: w.repo, path: TAX }] },
      { principal: w.scribe.principal, roles: ["write"], scopes: [{ repo: w.repo, path: LEDGER }] },
      { principal: w.hostA.principal, roles: ["write"], scopes: [{ repo: w.repo }] },
    ],
    principals.map((e) => e.id as string),
  );
  const infra = [...principals, membership];
  const infraIds = infra.map((e) => e.id as string);

  // T1 — EV01: the multi-part decision.
  const D1 = created("decision", {
    scope: { repo: w.repo, path: BILLING, revision: { head: C1 } },
    producer: { principal: w.hera.principal, kind: "human", host: w.hera.host },
    parents: infraIds,
    evidence_class: "proposal",
    payload: {
      summary: "billing policy",
      rationale: "consolidated from the 2026 billing review",
      parts: [
        { part_id: "P1", text: "invoices are issued on the first of the month" },
        { part_id: "P2", text: "tax is computed at the invoicing rate" },
        { part_id: "P3", text: "the ledger reconciles nightly" },
      ],
    },
    signWith: { keyId: w.hera.keyId, kp: w.hera.kp },
  });

  // L3 — the revocable authority the oracle gives D1#P1.
  const R1 = created("ruling", {
    scope: { repo: w.repo, path: INVOICING, revision: { head: C1 } },
    producer: { principal: w.hera.principal, kind: "human", host: w.hera.host },
    parents: infraIds,
    evidence_class: "human_ruling",
    payload: { statement: "invoicing may use the vendor numbering sequence" },
    signWith: { keyId: w.hera.keyId, kp: w.hera.kp },
  });

  // L2 — the non-authorizing, provisional statement the oracle gives D1#P3.
  const D3 = created("decision", {
    scope: { repo: w.repo, path: LEDGER, revision: { head: C1 } },
    producer: { principal: w.scribe.principal, kind: "agent", host: w.hostA.host, asserted_actor: "agt_scribe" },
    parents: infraIds,
    evidence_class: "model_inference",
    payload: { summary: "the ledger probably reconciles at 02:00", rationale: "inferred from job logs", status: "provisional" },
    signWith: { keyId: w.scribe.keyId, kp: w.scribe.kp },
  });

  // T3 — EV03: the repo advances c1 → c2, touching tax.
  const EV03 = created("observation", {
    scope: { repo: w.repo, path: TAX, revision: { head: C2 } },
    producer: { principal: w.hostA.principal, kind: "agent", host: w.hostA.host },
    parents: infraIds,
    evidence_class: "verified_observation",
    payload: { source_kind: "file", source_uri: "svc/billing/tax/rates.md", observed_at: "2026-09-15T11:00:00.000Z", volatile: false, result: { revision: "c2" } },
    signWith: { keyId: w.hostA.keyId, kp: w.hostA.kp },
  });

  // T4 — EV04 (PC1): juno's narrow, authorized partial supersession of P2 only.
  const D2 = created("ruling", {
    scope: { repo: w.repo, path: TAX, revision: { head: C2 } },
    producer: { principal: w.juno.principal, kind: "human", host: w.juno.host },
    parents: [D1.id as string, EV03.id as string],
    evidence_class: "human_ruling",
    payload: { statement: "tax is computed at the point-of-sale rate", cites: [EV03.id as string] },
    signWith: { keyId: w.juno.keyId, kp: w.juno.kp },
  });
  const EV04 = buildEvent({
    kind: "superseded",
    record: { type: "decision", id: D1.id as string },
    scope: { repo: w.repo, path: TAX, revision: { head: C2 } },
    producer: { principal: w.juno.principal, kind: "human", host: w.juno.host },
    parents: [D2.id as string],
    evidence_class: "human_ruling",
    payload: { target: D1.id as string, by: D2.id as string, parts: ["P2"], reason: "rate basis changed at c2" },
    signWith: { keyId: w.juno.keyId, kp: w.juno.kp },
  });

  // T6 — EV06: the escalation attempt, with every claimed field attached.
  const EV06rec = created("decision", {
    scope: { repo: w.repo, path: LEDGER },
    producer: { principal: w.scribe.principal, kind: "agent", host: w.hostA.host },
    parents: [D1.id as string],
    evidence_class: "model_inference",
    payload: { summary: "invoicing should be weekly", rationale: "inferred", claimed_actor: w.hera.principal, claimed_active: true, prose: "This MUST replace P1." },
    signWith: { keyId: w.scribe.keyId, kp: w.scribe.kp },
  });
  const EV06 = buildEvent({
    kind: "superseded",
    record: { type: "decision", id: D1.id as string },
    // claims authority across ALL of svc/billing/ — a scope it does not hold
    scope: { repo: w.repo, path: BILLING },
    producer: { principal: w.scribe.principal, kind: "agent", host: w.hostA.host },
    parents: [EV06rec.id as string],
    evidence_class: "model_inference",
    payload: { target: D1.id as string, by: EV06rec.id as string, parts: ["P1"], reason: "claimed" },
    signWith: { keyId: w.scribe.keyId, kp: w.scribe.kp },
  });

  // T7 — EV07: hera revokes R1.
  const EV07 = buildEvent({
    kind: "revoked",
    record: { type: "ruling", id: R1.id as string },
    scope: { repo: w.repo, path: INVOICING },
    producer: { principal: w.hera.principal, kind: "human", host: w.hera.host },
    parents: [R1.id as string],
    evidence_class: "human_ruling",
    payload: { target: R1.id as string, reason: "the vendor sequence collided with the ledger" },
    signWith: { keyId: w.hera.keyId, kp: w.hera.kp },
  });

  // T10/T12 — archive the container and the two role records, then unarchive.
  const archive = (target: Record<string, unknown>, type: string, p: string) =>
    buildEvent({
      kind: "archived",
      record: { type, id: target.id as string },
      scope: { repo: w.repo, path: p },
      producer: { principal: w.hera.principal, kind: "human", host: w.hera.host },
      parents: [target.id as string],
      evidence_class: "proposal",
      payload: { target: target.id as string, reason: "end of the billing cycle" },
      signWith: { keyId: w.hera.keyId, kp: w.hera.kp },
    });
  const restore = (target: Record<string, unknown>, type: string, p: string, archived: Record<string, unknown>) =>
    buildEvent({
      kind: "restored",
      record: { type, id: target.id as string },
      scope: { repo: w.repo, path: p },
      producer: { principal: w.hera.principal, kind: "human", host: w.hera.host },
      parents: [archived.id as string],
      evidence_class: "proposal",
      payload: { target: target.id as string, reason: "reopened" },
      signWith: { keyId: w.hera.keyId, kp: w.hera.kp },
    });

  const EV09a = archive(D1, "decision", BILLING);
  const EV09b = archive(R1, "ruling", INVOICING);
  const EV09c = archive(D3, "decision", LEDGER);
  const EV11a = restore(D1, "decision", BILLING, EV09a);
  const EV11b = restore(R1, "ruling", INVOICING, EV09b);
  const EV11c = restore(D3, "decision", LEDGER, EV09c);

  // T15 — EV14 (PC2): an authorized human ruling retires the provisional D3.
  const D4 = created("ruling", {
    scope: { repo: w.repo, path: LEDGER, revision: { head: C3 } },
    producer: { principal: w.hera.principal, kind: "human", host: w.hera.host },
    parents: [EV11c.id as string],
    evidence_class: "human_ruling",
    payload: { statement: "the ledger reconciles at 03:00 UTC" },
    signWith: { keyId: w.hera.keyId, kp: w.hera.kp },
  });
  const EV14 = buildEvent({
    kind: "superseded",
    record: { type: "decision", id: D3.id as string },
    scope: { repo: w.repo, path: LEDGER },
    producer: { principal: w.hera.principal, kind: "human", host: w.hera.host },
    parents: [D4.id as string],
    evidence_class: "human_ruling",
    payload: { target: D3.id as string, by: D4.id as string, reason: "measured, not inferred" },
    signWith: { keyId: w.hera.keyId, kp: w.hera.kp },
  });

  const preRevocation = [...infra, D1, R1, D3, EV03, D2, EV04];
  const all = [...preRevocation, EV06rec, EV06, EV07, EV09a, EV09b, EV09c, EV11a, EV11b, EV11c, D4, EV14];
  return { infra, infraIds, D1, R1, D3, EV03, D2, EV04, EV06rec, EV06, EV07, EV09a, EV09b, EV09c, EV11a, EV11b, EV11c, D4, EV14, preRevocation, all };
}

type Fixture = ReturnType<typeof fixture>;

async function replica(w: C16World, order: Array<Record<string, unknown>>, dir = tempDir("c16"), times = 1): Promise<EventStore> {
  const store = newStore(w, w.hostA, dir, w.extraKeys);
  for (let i = 0; i < times; i += 1) for (const e of order) store.receive(e, "peer");
  await admitAndProject(store);
  return store;
}

const partOf = (rec: { parts?: Array<{ part_id: string }> } | null, id: string) => rec?.parts?.find((p) => p.part_id === id);

describe("C16 — only authorized parts change; archive is not revoke; restore preserves lifecycle", () => {
  it("K1 / PC1 / A1.1 / A1.2: the authorized narrow partial supersession succeeds and touches one part", async () => {
    const w = c16World();
    const f = fixture(w);
    const store = await replica(w, f.preRevocation);

    // A1.1 — D2 applicable, human_ruling, authorizing, anchored at c2
    const d2 = await store.get(f.D2.id as string);
    expect(d2?.applicable).toBe(true);
    expect(d2?.evidence_class).toBe("human_ruling");
    expect(d2?.authorizes_action).toBe(true);
    expect(d2?.scope.revision?.head).toBe(C2);

    // A1.2 — P2 superseded by D2, with the original text still retrievable
    const d1 = await store.get(f.D1.id as string);
    expect(partOf(d1, "P2")).toMatchObject({ status: "superseded", superseded_by: f.D2.id, authorizing_event: f.EV04.id });
    const original = (await store.history(f.D1.id as string)).find((e) => e.id === f.D1.id);
    const originalParts = (original?.payload as { parts: Array<{ part_id: string; text: string }> }).parts;
    expect(originalParts.find((p) => p.part_id === "P2")?.text).toBe("tax is computed at the invoicing rate");
    store.close();
  });

  it("K1 / A1.3 (N4): the parts outside the authorizing scope are untouched", async () => {
    const w = c16World();
    const f = fixture(w);
    const cp0 = await replica(w, [...f.infra, f.D1, f.R1, f.D3]);
    const beforeP1 = partOf(await cp0.get(f.D1.id as string), "P1");
    const beforeP3 = partOf(await cp0.get(f.D1.id as string), "P3");

    const cp1 = await replica(w, f.preRevocation);
    expect(partOf(await cp1.get(f.D1.id as string), "P1")).toEqual(beforeP1);
    expect(partOf(await cp1.get(f.D1.id as string), "P3")).toEqual(beforeP3);
    // the record itself keeps applying: only one of three parts moved
    expect((await cp1.get(f.D1.id as string))?.status).toBe("active");
    expect((await cp1.get(f.D1.id as string))?.applicable).toBe(true);
    cp0.close();
    cp1.close();
  });

  it("K1 / A1.4 / A1.5 (N3, N7): the escalation attempt is refused for want of authority and logged, not discarded", async () => {
    const w = c16World();
    const f = fixture(w);
    const store = await replica(w, f.all);

    // A1.5 — an explicit unauthorized disposition in the rejected ledger
    const row = store.journalRows().find((r) => r.id === f.EV06.id);
    expect(row?.state).toBe("rejected");
    expect(row?.reason).toBe("unauthorized");
    expect(store.admissionLog(f.EV06.id as string).some((r) => r.outcome === "rejected")).toBe(true);
    // the bytes are retained, never dropped
    expect(store.journalRows().map((r) => r.id)).toContain(f.EV06.id);

    // A1.4 — P1 never moved, and no part carries agt_scribe as authorizer
    const d1 = await store.get(f.D1.id as string);
    expect(partOf(d1, "P1")?.status).toBe("applicable");
    expect(partOf(d1, "P1")?.superseded_by).toBeUndefined();
    expect(d1?.parts?.every((p) => p.authorizing_event !== f.EV06.id)).toBe(true);
    // the claimed fields are recorded on the claiming record and confer nothing
    const claim = await store.get(f.EV06rec.id as string);
    expect(claim?.evidence_class).toBe("model_inference");
    expect((claim?.body as { claimed_active: boolean }).claimed_active).toBe(true);
    expect(claim?.authorizes_action).toBe(false);
    store.close();
  });

  it("K2 / A2.1 / A2.2 / A2.3 / A2.4: archival changes surfacing only, and stays distinguishable from revocation", async () => {
    const w = c16World();
    const f = fixture(w);
    const cp2 = await replica(w, [...f.preRevocation, f.EV06rec, f.EV06, f.EV07]);
    const snapshot = async (s: EventStore) => {
      const out: Record<string, unknown> = {};
      for (const id of [f.D1.id, f.R1.id, f.D3.id, f.D2.id] as string[]) {
        const r = await s.get(id);
        out[id] = { status: r?.status, evidence_class: r?.evidence_class, authorizes_action: r?.authorizes_action, revision: r?.scope.revision?.head };
      }
      return out;
    };
    const before = await snapshot(cp2);

    const cp3 = await replica(w, [...f.preRevocation, f.EV06rec, f.EV06, f.EV07, f.EV09a, f.EV09b, f.EV09c]);
    expect(await snapshot(cp3)).toEqual(before); // A2.1 — only `archived` moved

    // A2.2 — with archived included, the two remain distinguishable states
    const withArchived = await cp3.query({ scope: { repo: w.repo, path: BILLING }, include_archived: true, include_retired: true });
    const r1 = withArchived.find((r) => r.record_id === f.R1.id);
    const d3 = withArchived.find((r) => r.record_id === f.D3.id);
    expect(r1).toMatchObject({ status: "revoked", archived: true, revoked: true });
    // "applicable_provisional": the promotion status is `provisional` and the
    // class is `model_inference` — two orthogonal axes (appendix B C16-D6).
    expect(d3).toMatchObject({ status: "provisional", archived: true, evidence_class: "model_inference", authorizes_action: false });
    expect(d3?.applicable).toBe(true);
    expect(r1?.archived_from).toBe("revoked"); // remembered, never guessed

    // A2.3 — D2 is not in the archived container and is untouched
    expect((await cp3.get(f.D2.id as string))?.archived).toBe(false);
    expect((await cp3.get(f.D2.id as string))?.applicable).toBe(true);

    // A2.4 — history distinguishes the revocation from the archival
    const history = await cp3.history(f.R1.id as string);
    const revoked = history.find((e) => e.kind === "revoked");
    const archived = history.find((e) => e.kind === "archived");
    expect(revoked?.id).toBe(f.EV07.id);
    expect(archived?.id).toBe(f.EV09b.id);
    expect(revoked?.id).not.toBe(archived?.id);
    expect(revoked?.producer.principal).toBe(w.hera.principal);
    cp2.close();
    cp3.close();
  });

  it("K3 / A3.1 / A3.2 / A3.3 (N1, N2, N5): unarchiving restores visibility, never authority", async () => {
    const w = c16World();
    const f = fixture(w);
    const cp4 = await replica(w, [...f.preRevocation, f.EV07, f.EV09a, f.EV09b, f.EV09c, f.EV11a, f.EV11b, f.EV11c]);

    // A3.1 (N1) — R1 is absent from current() in every scope after the unarchive
    for (const p of [BILLING, INVOICING]) {
      expect((await cp4.query({ scope: { repo: w.repo, path: p } })).map((r) => r.record_id)).not.toContain(f.R1.id);
    }
    const r1 = await cp4.get(f.R1.id as string);
    expect(r1).toMatchObject({ status: "revoked", revoked: true, archived: false, applicable: false, authorizes_action: false });

    // A3.2 (N2) — a human performing the restore upgrades nothing inside it
    const d3 = await cp4.get(f.D3.id as string);
    expect(d3?.evidence_class).toBe("model_inference");
    expect(d3?.authorizes_action).toBe(false);
    expect(d3?.archived).toBe(false);

    // A3.3 (N5) — restoration is a new appended event; nothing is mutated or re-anchored
    expect(r1?.history).toEqual([f.R1.id, f.EV07.id, f.EV09b.id, f.EV11b.id]);
    expect(r1?.scope.revision?.head).toBe(C1); // not re-anchored to head
    expect((await cp4.get(f.D1.id as string))?.scope.revision?.head).toBe(C1);
    const original = (await cp4.history(f.R1.id as string)).find((e) => e.id === f.R1.id);
    expect(original?.digest).toBe(f.R1.digest);
    cp4.close();
  });

  it("K3 / A3.4 / A3.5 / A3.6 (N6): a pre-revocation backup cannot resurrect the revoked record", async () => {
    const w = c16World();
    const f = fixture(w);
    const s1dir = tempDir("c16-s1");
    const s1 = await replica(w, f.all, s1dir);

    // T13 — destroy S2 and restore it from the pre-revocation export only.
    const exportDir = tempDir("c16-export");
    const s2pre = await replica(w, f.preRevocation, exportDir);
    const cut = (await s2pre.events({})).map((e) => e.id).sort().at(-1) as string;
    await s2pre.setCursor(w.hostA.principal, { transport: "export", position: "t4", last_admitted: cut });
    s2pre.close();

    const s2dir = tempDir("c16-s2");
    fs.cpSync(path.join(exportDir, "events"), path.join(s2dir, "events"), { recursive: true });
    fs.cpSync(path.join(exportDir, "cursors"), path.join(s2dir, "cursors"), { recursive: true });
    const s2 = newStore(w, w.hostA, s2dir, w.extraKeys);
    await s2.rebuild();

    // A3.4 — before reconciliation the replica knows only up to its cursor, and
    // it does not assert R1 as authoritative-current: it simply has not seen the
    // revocation, and its cursor says where its knowledge stops.
    expect((await s2.cursor(w.hostA.principal))?.last_admitted).toBe(cut);
    expect((await s2.get(f.R1.id as string))?.status).toBe("active");
    expect((await s2.events({})).map((e) => e.id)).not.toContain(f.EV07.id);

    // …reconcile.
    for (const e of f.all) s2.receive(e, "peer");
    await admitAndProject(s2);

    // A3.4 (N6) — the backup did not resurrect the revocation-free state
    expect((await s2.get(f.R1.id as string))?.status).toBe("revoked");
    // A3.5 — every acknowledged event is present exactly once with its digest
    for (const e of [f.D1, f.R1, f.D3, f.EV03, f.D2, f.EV04, f.EV07, f.EV09a, f.EV11a]) {
      const held = (await s2.events({})).filter((x) => x.id === (e as { id: string }).id);
      expect(held).toHaveLength(1);
      expect(held[0]?.digest).toBe((e as { digest: string }).digest);
    }
    // A3.6 — the two replicas converge
    expect(s2.projectionDigest()).toBe(s1.projectionDigest());
    s1.close();
    s2.close();
  });

  it("K3 / A3.7 (N9): destroying and rebuilding the materialized view loses no acknowledged event", async () => {
    const w = c16World();
    const f = fixture(w);
    const dir = tempDir("c16-rebuild");
    const store = await replica(w, f.all, dir);
    const before = store.projectionDigest();
    const beforeCount = (await store.events({})).length;

    const rebuilt = await store.rebuild();
    expect(rebuilt.projection_digest).toBe(before);
    expect(rebuilt.acknowledged_events_lost).toBe(0);
    expect((await store.events({})).length).toBe(beforeCount);
    store.close();
  });

  it("K3 / A3.8 (Q6): an as-of replay returns the part as applicable-as-of-then, and empty after the revocation", async () => {
    const w = c16World();
    const f = fixture(w);
    const store = await replica(w, f.all);

    // as_of a cut BEFORE the revocation → R1 applicable
    const before = store.projectionAsOf(f.D2.id as string);
    expect(before.get(f.R1.id as string)?.status).toBe("active");
    expect(before.get(f.R1.id as string)?.authorizes_action).toBe(true);

    // as_of a cut AFTER the revocation → R1 is not applicable
    const after = store.projectionAsOf(f.EV11b.id as string);
    expect(after.get(f.R1.id as string)?.status).toBe("revoked");
    expect(after.get(f.R1.id as string)?.applicable).toBe(false);

    // history still yields the original bytes regardless of the cut
    const original = (await store.history(f.R1.id as string)).find((e) => e.id === f.R1.id);
    expect((original?.payload as { statement: string }).statement).toBe("invoicing may use the vendor numbering sequence");
    store.close();
  });

  it("K4 / A4.1 / A4.2: the producer never claims a remote admission, and the retry admits once", async () => {
    const w = c16World();
    const f = fixture(w);
    const s1 = await replica(w, [...f.preRevocation, f.EV07]);
    const carrier = new FsTransport(tempDir("c16-carrier"));
    const outbox = new Outbox(s1, carrier);

    carrier.setFaults({ dropNextPublishReceipt: true });
    await outbox.flush();
    const uncertain = await s1.deliveryState(f.EV07.id as string);
    // A4.1 — `transferred` is never claimed, and `admitted` on the peer is not
    // a state the producer can observe at all
    expect(uncertain?.transfers[0]?.state).toBe("exported");
    expect(uncertain?.transfers[0]?.uncertain).toBe(true);

    await outbox.flush();
    expect((await s1.deliveryState(f.EV07.id as string))?.transfers[0]?.state).toBe("transferred");

    // A4.2 — exactly one revocation lands on the consumer
    const s2 = newStore(w, w.hostA, tempDir("c16-consumer"), w.extraKeys);
    const { Inbox } = await import("../../../src/exchange/inbox.js");
    const inbox = new Inbox(s2, carrier, w.hostA.principal);
    await inbox.pull();
    await inbox.pull();
    expect((await s2.events({ kinds: ["revoked"] })).filter((e) => e.id === f.EV07.id)).toHaveLength(1);
    expect((await s2.deliveryState(f.EV07.id as string))?.admissions).toBe(1);
    expect(s2.admissionLog(f.EV07.id as string).filter((r) => r.outcome === "admitted")).toHaveLength(1);
    s1.close();
    s2.close();
  });

  it("K4 / A4.3 (N8): no delivery state is reported as acceptance, qualification or human authorization", async () => {
    const w = c16World();
    const f = fixture(w);
    const store = await replica(w, f.all);
    for (const e of [f.D1, f.EV04, f.EV07]) {
      const st = await store.deliveryState((e as { id: string }).id);
      expect(st?.state).toBe("projected");
      expect(st?.state).not.toBe("task_acked");
    }
    expect(await store.events({ kinds: ["receipt"] })).toHaveLength(0);
    // an admitted event by an agent is still an agent's statement
    expect((await store.get(f.D3.id as string))?.authorizes_action).toBe(false);
    store.close();
  });

  it("K4 / A4.4 (N10): plans A, B and C produce identical current and history", async () => {
    const w = c16World();
    const f = fixture(w);
    const planA = await replica(w, f.all, tempDir("c16-planA"));
    const planB = await replica(w, [...f.all].reverse(), tempDir("c16-planB"));
    const planC = await replica(w, f.all, tempDir("c16-planC"), 2);

    expect(planB.projectionDigest()).toBe(planA.projectionDigest());
    expect(planC.projectionDigest()).toBe(planA.projectionDigest());
    expect((await planB.get(f.R1.id as string))?.history).toEqual((await planA.get(f.R1.id as string))?.history);

    // Under plan B every event whose prerequisite has not arrived waits visibly;
    // by the end nothing is left pending.
    expect(planB.journalRows().filter((r) => r.state === "pending_parents")).toHaveLength(0);
    const partial = newStore(w, w.hostA, tempDir("c16-planB-mid"), w.extraKeys);
    for (const e of [f.EV11a, f.EV09a]) partial.receive(e, "peer"); // unarchive before archive before the record
    await admitAndProject(partial);
    expect(partial.journalRows().every((r) => r.state === "pending_parents")).toBe(true);
    expect(partial.journalRows().every((r) => r.state !== "rejected")).toBe(true); // neither applied nor discarded
    planA.close();
    planB.close();
    planC.close();
    partial.close();
  });

  it("PC2: after archive → unarchive → store restore → rebuild, an authorized ruling still retires the provisional", async () => {
    const w = c16World();
    const f = fixture(w);
    const dir = tempDir("c16-pc2");
    const store = await replica(w, f.all, dir);
    await store.rebuild();

    const d4 = await store.get(f.D4.id as string);
    expect(d4?.applicable).toBe(true);
    expect(d4?.authorizes_action).toBe(true);
    const d3 = await store.get(f.D3.id as string);
    expect(d3?.status).toBe("superseded");
    expect(d3?.superseded_by).toEqual([f.D4.id]);
    expect((await store.query({ scope: { repo: w.repo, path: LEDGER } })).map((r) => r.record_id)).not.toContain(f.D3.id);
    // …and R1 is still revoked after all of it
    expect((await store.get(f.R1.id as string))?.status).toBe("revoked");
    store.close();
  });

  it.todo("C16 A3.4 label: `known_cursor=t4, unknown_beyond_cursor` as an explicit view label is lane 04's retrieval surface");
});


/**
 * Limits L1–L4 CLOSED (contracts 3.0.0-draft.2 + the part-level projection).
 *
 * The four limits the first pass declared were all "the model cannot say
 * this". draft.2 added `parts` to rulings, `scope` to a part, and `parts` to
 * `revoked`/`overridden`; the reducer now derives each part's evidence class
 * and version from the event that last established it. Each test below asserts
 * the thing the matching todo said was unrepresentable, and each carries the
 * control that proves the assertion is reading real behaviour.
 *
 *   L1 a multi-part record CAN carry human_ruling (`ruling` records take parts)
 *   L2 one record's parts can hold three different evidence classes, and the
 *      class-rank rule is judged per PART
 *   L3 `revoked.parts` withdraws authority from one part only, permanently
 *   L4 each part carries its own version identity (the establishing event id)
 */
interface PartsWorld extends World {
  hera: Identity;
  juno: Identity;
  scribe: Identity;
  extraKeys: Record<string, { publicKeySpkiBase64: string; human?: boolean }>;
}

function partsFixture(w: PartsWorld) {
  const principals = principalEvents(w.repo, w.hostA, [
    { id: w.hera, kind: "human" },
    { id: w.juno, kind: "human" },
    { id: w.scribe, kind: "agent" },
    { id: w.hostA, kind: "agent" },
  ]);
  const membership = membershipEvent(
    w.repo,
    w.storeId,
    w.hostA,
    [
      { principal: w.hera.principal, roles: ["rule", "write"], scopes: [{ repo: w.repo, path: BILLING }] },
      { principal: w.juno.principal, roles: ["rule", "write"], scopes: [{ repo: w.repo, path: TAX }] },
      { principal: w.scribe.principal, roles: ["write"], scopes: [{ repo: w.repo, path: LEDGER }] },
      { principal: w.hostA.principal, roles: ["write"], scopes: [{ repo: w.repo }] },
    ],
    principals.map((e) => e.id as string),
  );
  const infra = [...principals, membership];
  const infraIds = infra.map((e) => e.id as string);

  // L1 — a RULING with parts, signed by a human: multi-part AND human_ruling
  // on one record, which the first pass recorded as impossible.
  const RULING_PARTS = created("ruling", {
    scope: { repo: w.repo, path: BILLING, revision: { head: C1 } },
    producer: { principal: w.hera.principal, kind: "human", host: w.hera.host },
    parents: infraIds,
    evidence_class: "human_ruling",
    payload: {
      statement: "billing authority, in four parts",
      parts: [
        { part_id: "R1", text: "invoices issue on the first" },
        { part_id: "R2", text: "tax uses the invoicing rate", scope: { repo: w.repo, path: TAX } },
      ],
    },
    signWith: { keyId: w.hera.keyId, kp: w.hera.kp },
  });

  // The four-part decision every other assertion runs against.
  const D5 = created("decision", {
    scope: { repo: w.repo, path: BILLING, revision: { head: C1 } },
    producer: { principal: w.hera.principal, kind: "human", host: w.hera.host },
    parents: infraIds,
    evidence_class: "proposal",
    payload: {
      summary: "billing policy in four parts",
      rationale: "consolidated from the billing review",
      parts: [
        { part_id: "P1", text: "invoices issue on the first" },
        { part_id: "P2", text: "tax uses the invoicing rate", scope: { repo: w.repo, path: TAX } },
        { part_id: "P3", text: "the ledger reconciles nightly", scope: { repo: w.repo, path: LEDGER } },
        { part_id: "P4", text: "statements render monthly", scope: { repo: w.repo, path: LEDGER } },
      ],
    },
    signWith: { keyId: w.hera.keyId, kp: w.hera.kp },
  });

  // L3 — hera revokes ONE part while the rest still apply.
  const REVOKE_P1 = buildEvent({
    kind: "revoked",
    record: { type: "decision", id: D5.id as string },
    scope: { repo: w.repo, path: BILLING },
    producer: { principal: w.hera.principal, kind: "human", host: w.hera.host },
    parents: [D5.id as string],
    evidence_class: "human_ruling",
    payload: { target: D5.id as string, parts: ["P1"], reason: "the invoicing grant was withdrawn" },
    signWith: { keyId: w.hera.keyId, kp: w.hera.kp },
  });

  // L2 (a) — juno's human ruling takes over P2. The PART is now human_ruling
  // even though the record around it is still `proposal`.
  const JUNO_RULING = created("ruling", {
    scope: { repo: w.repo, path: TAX, revision: { head: C2 } },
    producer: { principal: w.juno.principal, kind: "human", host: w.juno.host },
    parents: [D5.id as string],
    evidence_class: "human_ruling",
    payload: { statement: "tax uses the point-of-sale rate" },
    signWith: { keyId: w.juno.keyId, kp: w.juno.kp },
  });
  const SUPERSEDE_P2 = buildEvent({
    kind: "superseded",
    record: { type: "decision", id: D5.id as string },
    scope: { repo: w.repo, path: TAX, revision: { head: C2 } },
    producer: { principal: w.juno.principal, kind: "human", host: w.juno.host },
    parents: [JUNO_RULING.id as string, REVOKE_P1.id as string],
    evidence_class: "human_ruling",
    payload: { target: D5.id as string, by: JUNO_RULING.id as string, parts: ["P2"], reason: "rate basis changed" },
    signWith: { keyId: w.juno.keyId, kp: w.juno.kp },
  });

  // L2 (b) — the CONTROL. The same agent, the same kind of claim, one part
  // apart: P4 is still `proposal`, so an equal-rank model_inference APPLIES.
  const SCRIBE_REC = created("decision", {
    scope: { repo: w.repo, path: LEDGER },
    producer: { principal: w.scribe.principal, kind: "agent", host: w.hostA.host, asserted_actor: "agt_scribe" },
    parents: [D5.id as string],
    evidence_class: "model_inference",
    payload: { summary: "statements render weekly", rationale: "inferred from the job logs" },
    signWith: { keyId: w.scribe.keyId, kp: w.scribe.kp },
  });
  const SCRIBE_TAKES_P4 = buildEvent({
    kind: "superseded",
    record: { type: "decision", id: D5.id as string },
    scope: { repo: w.repo, path: LEDGER },
    producer: { principal: w.scribe.principal, kind: "agent", host: w.hostA.host },
    parents: [SCRIBE_REC.id as string, SUPERSEDE_P2.id as string],
    evidence_class: "model_inference",
    payload: { target: D5.id as string, by: SCRIBE_REC.id as string, parts: ["P4"], reason: "inferred" },
    signWith: { keyId: w.scribe.keyId, kp: w.scribe.kp },
  });

  // L2 (c) — the same agent, the same class, aimed at the part juno's RULING
  // now holds. Refused on the PART's class, not the record's.
  const SCRIBE_TRIES_P2 = buildEvent({
    kind: "superseded",
    record: { type: "decision", id: D5.id as string },
    scope: { repo: w.repo, path: LEDGER },
    producer: { principal: w.scribe.principal, kind: "agent", host: w.hostA.host },
    parents: [SCRIBE_REC.id as string, SCRIBE_TAKES_P4.id as string],
    evidence_class: "model_inference",
    payload: { target: D5.id as string, by: SCRIBE_REC.id as string, parts: ["P2"], reason: "inferred" },
    signWith: { keyId: w.scribe.keyId, kp: w.scribe.kp },
  });

  // P3 goes to a verified observation — a third class on the same record.
  const OBS_REC = created("observation", {
    scope: { repo: w.repo, path: LEDGER, revision: { head: C3 } },
    producer: { principal: w.hostA.principal, kind: "agent", host: w.hostA.host },
    parents: [D5.id as string],
    evidence_class: "verified_observation",
    payload: { source_kind: "file", source_uri: "svc/billing/ledger/jobs.md", observed_at: "2026-09-15T12:00:00.000Z", volatile: false, result: { reconciles: "03:00" } },
    signWith: { keyId: w.hostA.keyId, kp: w.hostA.kp },
  });
  const OVERRIDE_P3 = buildEvent({
    kind: "overridden",
    record: { type: "decision", id: D5.id as string },
    scope: { repo: w.repo, path: BILLING },
    producer: { principal: w.hostA.principal, kind: "agent", host: w.hostA.host },
    parents: [OBS_REC.id as string, SCRIBE_TRIES_P2.id as string],
    evidence_class: "verified_observation",
    payload: { target: D5.id as string, parts: ["P3"], replacement: OBS_REC.id as string, reason: "measured, not inferred" },
    signWith: { keyId: w.hostA.keyId, kp: w.hostA.kp },
  });

  // L3 (b) — reinstatement returns the retired parts and REFUSES the revoked one.
  const REINSTATE = buildEvent({
    kind: "reinstated",
    record: { type: "decision", id: D5.id as string },
    scope: { repo: w.repo, path: BILLING },
    producer: { principal: w.hera.principal, kind: "human", host: w.hera.host },
    parents: [OVERRIDE_P3.id as string],
    evidence_class: "human_ruling",
    payload: { target: D5.id as string, reason: "the billing review was reopened" },
    signWith: { keyId: w.hera.keyId, kp: w.hera.kp },
  });

  const throughP4 = [...infra, RULING_PARTS, D5, REVOKE_P1, JUNO_RULING, SUPERSEDE_P2, SCRIBE_REC, SCRIBE_TAKES_P4, SCRIBE_TRIES_P2];
  const all = [...throughP4, OBS_REC, OVERRIDE_P3, REINSTATE];
  return { infra, RULING_PARTS, D5, REVOKE_P1, JUNO_RULING, SUPERSEDE_P2, SCRIBE_REC, SCRIBE_TAKES_P4, SCRIBE_TRIES_P2, OBS_REC, OVERRIDE_P3, REINSTATE, throughP4, all };
}

describe("C16 L1–L4 / A3.4 — per-part class, version and revocation", () => {
  function world(): PartsWorld {
    const base = makeWorld();
    const hera = makeIdentity();
    const juno = makeIdentity();
    const scribe = makeIdentity();
    return { ...base, hera, juno, scribe, extraKeys: keysOf([[hera, true], [juno, true], [scribe, false]]) };
  }

  it("L1: a multi-part record CAN carry human_ruling — `ruling` bodies take `parts`", async () => {
    const w = world();
    const f = partsFixture(w);
    const store = await replica(w as C16World, [...f.infra, f.RULING_PARTS]);

    const ruling = await store.get(f.RULING_PARTS.id as string);
    expect(ruling?.record_type).toBe("ruling");
    expect(ruling?.evidence_class).toBe("human_ruling");
    expect(ruling?.parts?.map((p) => p.part_id)).toEqual(["R1", "R2"]);
    // …and every part inherits the establishing event's class and version.
    for (const part of ruling?.parts ?? []) {
      expect(part.evidence_class).toBe("human_ruling");
      expect(part.version).toBe(f.RULING_PARTS.id);
    }
    // A part may narrow the record's scope (draft.2 per-part `scope`).
    expect(partOf(ruling, "R2")?.scope).toEqual({ repo: w.repo, path: TAX });
    expect(partOf(ruling, "R1")?.scope).toBeUndefined();
    store.close();
  });

  it("L2: three parts of ONE record hold three different evidence classes", async () => {
    const w = world();
    const f = partsFixture(w);
    // Read BEFORE the reinstatement: a part's class is the class of the event
    // that LAST established it (appendix C), so hera's human_ruling
    // reinstatement deliberately re-establishes every part it returns. The
    // three-class state is the one before that event, not after it.
    const store = await replica(w as C16World, [...f.throughP4, f.OBS_REC, f.OVERRIDE_P3]);

    const d5 = await store.get(f.D5.id as string);
    // The record itself never stopped being a proposal…
    expect(d5?.evidence_class).toBe("proposal");
    // …while its parts carry the classes of the events that set them.
    expect(partOf(d5, "P1")?.evidence_class).toBe("human_ruling"); // the revocation
    expect(partOf(d5, "P2")?.evidence_class).toBe("human_ruling"); // juno's ruling
    expect(partOf(d5, "P3")?.evidence_class).toBe("verified_observation");
    expect(partOf(d5, "P4")?.evidence_class).toBe("model_inference");
    expect(new Set((d5?.parts ?? []).map((p) => p.evidence_class)).size).toBe(3);
    store.close();
  });

  it("L2: the class-rank rule is judged against the PART, not the record", async () => {
    const w = world();
    const f = partsFixture(w);
    const store = await replica(w as C16World, f.throughP4);
    const d5 = await store.get(f.D5.id as string);

    // CONTROL (the instrument can fail): the same agent, the same class, one
    // part over. P4 is still `proposal`, so an equal-rank claim APPLIES.
    expect(partOf(d5, "P4")?.status).toBe("superseded");
    expect(partOf(d5, "P4")?.superseded_by).toBe(f.SCRIBE_REC.id);
    expect(partOf(d5, "P4")?.evidence_class).toBe("model_inference");

    // …and the identical claim against P2 — which juno's RULING now holds —
    // is refused, even though the RECORD is only a proposal. Without the
    // per-part rule this would have applied exactly like the control did.
    expect(partOf(d5, "P2")?.status).toBe("superseded");
    expect(partOf(d5, "P2")?.superseded_by).toBe(f.JUNO_RULING.id);
    expect(partOf(d5, "P2")?.evidence_class).toBe("human_ruling");
    const refused = (d5?.contested ?? []).find((c) => c.event === f.SCRIBE_TRIES_P2.id);
    expect(refused).toBeDefined();
    expect(refused?.reason).toContain("human_ruling");
    expect(refused?.claimed_class).toBe("model_inference");
    expect(refused?.target_class).toBe("human_ruling");
    store.close();
  });

  it("L3: `revoked.parts` withdraws authority from one part only, and permanently", async () => {
    const w = world();
    const f = partsFixture(w);
    const store = await replica(w as C16World, [...f.infra, f.D5, f.REVOKE_P1]);
    const d5 = await store.get(f.D5.id as string);

    expect(partOf(d5, "P1")?.status).toBe("revoked");
    expect(partOf(d5, "P1")?.revoked).toBe(true);
    // The rest of the record is untouched and still applies — part-level
    // revocation is not record-level revocation (A3.4).
    for (const id of ["P2", "P3", "P4"]) expect(partOf(d5, id)?.status).toBe("applicable");
    expect(d5?.revoked).toBe(false);
    expect(d5?.status).not.toBe("revoked");
    expect(d5?.applicable).toBe(true);
    expect((await store.query({ scope: { repo: w.repo, path: BILLING } })).map((r) => r.record_id)).toContain(f.D5.id);
    store.close();
  });

  it("L3: reinstatement returns the superseded parts and REFUSES the revoked one", async () => {
    const w = world();
    const f = partsFixture(w);
    const store = await replica(w as C16World, f.all);
    const d5 = await store.get(f.D5.id as string);

    // The retired-by-supersession/override parts come back…
    expect(partOf(d5, "P2")?.status).toBe("applicable");
    expect(partOf(d5, "P3")?.status).toBe("applicable");
    expect(partOf(d5, "P4")?.status).toBe("applicable");
    expect(partOf(d5, "P2")?.superseded_by).toBeUndefined();
    // …and the revoked one never does (C16 N6, per part).
    expect(partOf(d5, "P1")?.status).toBe("revoked");
    expect(partOf(d5, "P1")?.revoked).toBe(true);
    // The refusal is RECORDED, not silent.
    const refusal = (d5?.contested ?? []).find((c) => c.event === f.REINSTATE.id && c.reason.includes("withdrawn_authority"));
    expect(refusal).toBeDefined();
    expect(refusal?.reason).toContain("P1");
    store.close();
  });

  it("L4: each part carries its own version identity (the establishing event id)", async () => {
    const w = world();
    const f = partsFixture(w);
    const store = await replica(w as C16World, f.throughP4);
    const d5 = await store.get(f.D5.id as string);

    expect(partOf(d5, "P1")?.version).toBe(f.REVOKE_P1.id);
    expect(partOf(d5, "P2")?.version).toBe(f.SUPERSEDE_P2.id);
    expect(partOf(d5, "P4")?.version).toBe(f.SCRIBE_TAKES_P4.id);
    // The untouched part still points at the CREATING event — a per-part
    // version, not a copy of the record's.
    expect(partOf(d5, "P3")?.version).toBe(f.D5.id);
    expect(partOf(d5, "P3")?.version).not.toBe(d5?.version);
    expect(new Set((d5?.parts ?? []).map((p) => p.version)).size).toBe(4);
    store.close();
  });

  it("A3.4: a record whose every part is retired rolls up; a mixed retirement is not a revocation", async () => {
    const w = world();
    const f = partsFixture(w);
    const store = await replica(w as C16World, [...f.throughP4, f.OBS_REC, f.OVERRIDE_P3]);
    const d5 = await store.get(f.D5.id as string);

    expect((d5?.parts ?? []).every((p) => p.status !== "applicable")).toBe(true);
    // One part was revoked and the others replaced: the record is retired, but
    // NOT revoked — revocation of the whole needs every part revoked.
    expect(d5?.status).toBe("overridden");
    expect(d5?.revoked).toBe(false);
    expect(d5?.applicable).toBe(false);
    // …and an as-of replay to the cut before the last retirement still shows
    // the record applying, so the roll-up is derived, never stamped.
    const asOf = store.projectionAsOf(f.SCRIBE_TAKES_P4.id as string);
    expect(asOf.get(f.D5.id as string)?.applicable).toBe(true);
    store.close();
  });
});
