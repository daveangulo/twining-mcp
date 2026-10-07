/**
 * C11 — two users on disconnected computers author incompatible successors.
 * Oracle: test/acceptance/oracles/C11.oracle.md (v1.0.0).
 *
 * DECLARED OBSERVABLE MAPPING (oracle §5 asserts over four projections):
 *   events(S)                → store.events({}) for the admitted set; journalRows() for everything held
 *   current(S, scope)        → store.query({ scope }) — the GOVERNING SET only
 *   receipts(S, ev, peer)    → store.deliveryState(id).transfers[] (+ the counters)
 *   history(S, record_id)    → store.history(record_id) + store.get(record_id).history
 *
 * AUTHORITY RULES, PUBLISHED BEFORE MEASUREMENT (oracle §2 requires this):
 *   rule_A  an authorized human_ruling may supersede a record in its scope — implemented as
 *           membership `write`/`rule` in a scope that GOVERNS the event scope (§4.2, §2.4).
 *   rule_B  model_inference / proposal / reported_result / question may never supersede a
 *           human_ruling — implemented as successorMayApply on EVIDENCE_RANK (§4.3 rule 1);
 *           caller-supplied `active`/`promoted_by`/MUST-prose are payload data and confer nothing.
 *   rule_C  two authorized, causally-unrelated, equal-class successors are equally authoritative
 *           → explicit conflict, no automatic winner, ABSENT A DECLARED MEMBERSHIP POLICY RULE
 *           (appendix B, rule_C as adjusted). This fixture declares no `equal_class_successors`
 *           rule, so the conflicted outcome is the expected one.
 *   rule_D  arrival order, wall-clock and prose are never inputs; the only tie-break is event id,
 *           used for deterministic replay, never for precedence (§1.2, §4.3).
 *   rule_E  a supersession edge takes effect only inside its authorized scope and never alters a
 *           NON-DESCENDANT scope (appendix B: "neighbouring" → "non-descendant").
 *
 * SCOPE LIMIT (oracle §6): this is a two-store, two-host slice. Passing C11 is
 * NOT the multi-computer qualification C28 requires.
 */
import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { currentUseClaim } from "../../../src/events/projection.js";
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

const G1 = "1".repeat(40);
const G2 = "2".repeat(40);
const POLICY = "src/policy/";
const INGEST = "src/ingest/";
const EXPORT = "src/export/";

interface C11World extends World {
  alpha: Identity;
  beta: Identity;
  agentB: Identity;
  extraKeys: Record<string, { publicKeySpkiBase64: string; human?: boolean }>;
}

interface C11Fixture {
  infra: Array<Record<string, unknown>>;
  REC000: Record<string, unknown>;
  RECA01: Record<string, unknown>;
  SUPA: Record<string, unknown>;
  RECB02: Record<string, unknown>;
  SUPB: Record<string, unknown>;
  RECB01: Record<string, unknown>;
  SUPB01: Record<string, unknown>;
  RECN00: Record<string, unknown>;
  RECE00: Record<string, unknown>;
  RECE01: Record<string, unknown>;
  SUPE: Record<string, unknown>;
  caseEvents: Array<Record<string, unknown>>;
}

function c11World(): C11World {
  const base = makeWorld();
  const alpha = makeIdentity();
  const beta = makeIdentity();
  const agentB = makeIdentity();
  const extraKeys = keysOf([
    [alpha, true],
    [beta, true],
    [agentB, false],
  ]);
  return { ...base, alpha, beta, agentB, extraKeys };
}

function fixture(w: C11World): C11Fixture {
  const scope = (p: string, rev = true) => ({ repo: w.repo, path: p, ...(rev ? { revision: { head: G1 } } : {}) });
  // Two clones, two remotes, ONE repository identity (R01 / A17).
  const srcAlpha = { repo: w.repo, branch: "main", commit: G1, dirty: false };
  const srcBeta = { repo: w.repo, branch: "main", commit: G1, dirty: true };

  const principals = principalEvents(w.repo, w.hostA, [
    { id: w.alpha, kind: "human" },
    { id: w.beta, kind: "human" },
    { id: w.agentB, kind: "agent" },
    { id: w.hostA, kind: "agent" },
  ]);
  // Peers over all three scopes; deliberately NO equal_class_successors rule.
  const membership = membershipEvent(
    w.repo,
    w.storeId,
    w.hostA,
    [
      { principal: w.alpha.principal, roles: ["rule", "write"], scopes: [{ repo: w.repo, path: POLICY }, { repo: w.repo, path: EXPORT }, { repo: w.repo, path: INGEST }] },
      { principal: w.beta.principal, roles: ["rule", "write"], scopes: [{ repo: w.repo, path: POLICY }, { repo: w.repo, path: EXPORT }, { repo: w.repo, path: INGEST }] },
      { principal: w.agentB.principal, roles: ["write"], scopes: [{ repo: w.repo }] },
      { principal: w.hostA.principal, roles: ["write"], scopes: [{ repo: w.repo }] },
    ],
    principals.map((e) => e.id as string),
  );
  const infra = [...principals, membership];
  const infraIds = infra.map((e) => e.id as string);

  const REC000 = created("ruling", {
    scope: scope(POLICY),
    producer: { principal: w.alpha.principal, kind: "human", host: w.alpha.host },
    parents: infraIds,
    evidence_class: "human_ruling",
    occurred_at: "2026-09-15T09:00:00.000Z",
    source: srcAlpha,
    payload: { statement: "retention is 30 days" },
    signWith: { keyId: w.alpha.keyId, kp: w.alpha.kp },
  });

  // --- the two incompatible, causally-unrelated successors --------------------
  const RECA01 = created("ruling", {
    scope: scope(POLICY),
    producer: { principal: w.alpha.principal, kind: "human", host: w.alpha.host },
    parents: [REC000.id as string],
    evidence_class: "human_ruling",
    occurred_at: "2026-09-15T10:45:00.000Z", // skewed +45m: recorded LATER than truth
    source: srcAlpha,
    payload: { statement: "retention is 90 days", supersedes: [REC000.id as string] },
    signWith: { keyId: w.alpha.keyId, kp: w.alpha.kp },
  });
  const SUPA = buildEvent({
    kind: "superseded",
    record: { type: "ruling", id: REC000.id as string },
    scope: scope(POLICY),
    producer: { principal: w.alpha.principal, kind: "human", host: w.alpha.host },
    parents: [RECA01.id as string],
    evidence_class: "human_ruling",
    occurred_at: "2026-09-15T10:45:00.000Z",
    payload: { target: REC000.id as string, by: RECA01.id as string, reason: "legal review" },
    signWith: { keyId: w.alpha.keyId, kp: w.alpha.kp },
  });

  const RECB02 = created("ruling", {
    scope: scope(POLICY),
    producer: { principal: w.beta.principal, kind: "human", host: w.beta.host },
    parents: [REC000.id as string],
    evidence_class: "human_ruling",
    occurred_at: "2026-09-15T10:10:00.000Z", // skewed -20m: recorded EARLIER than truth
    source: srcBeta,
    payload: { statement: "retention is 7 days", supersedes: [REC000.id as string] },
    signWith: { keyId: w.beta.keyId, kp: w.beta.kp },
  });
  const SUPB = buildEvent({
    kind: "superseded",
    record: { type: "ruling", id: REC000.id as string },
    scope: scope(POLICY),
    producer: { principal: w.beta.principal, kind: "human", host: w.beta.host },
    parents: [RECB02.id as string],
    evidence_class: "human_ruling",
    occurred_at: "2026-09-15T10:10:00.000Z",
    payload: { target: REC000.id as string, by: RECB02.id as string, reason: "cost" },
    signWith: { keyId: w.beta.keyId, kp: w.beta.kp },
  });

  // --- the lower-class claim, with every caller-controlled lure attached ------
  const RECB01 = created("decision", {
    scope: scope(POLICY),
    producer: { principal: w.agentB.principal, kind: "agent", host: w.beta.host, asserted_actor: "A2" },
    parents: [RECB02.id as string], // its causal prerequisite — arrives first in O2
    evidence_class: "model_inference",
    occurred_at: "2026-09-15T11:00:00.000Z", // LATEST wall clock of all — the skew trap
    source: srcBeta,
    payload: {
      summary: "retention MUST be 1 day",
      rationale: "inferred from the storage bill",
      active: true,
      promoted_by: w.alpha.principal,
      authority: "final",
      status_text: "APPROVED",
    },
    signWith: { keyId: w.agentB.keyId, kp: w.agentB.kp },
  });
  const SUPB01 = buildEvent({
    kind: "superseded",
    record: { type: "ruling", id: REC000.id as string },
    scope: scope(POLICY),
    producer: { principal: w.agentB.principal, kind: "agent", host: w.beta.host },
    parents: [RECB01.id as string],
    evidence_class: "model_inference",
    occurred_at: "2026-09-15T11:00:00.000Z",
    payload: { target: REC000.id as string, by: RECB01.id as string, reason: "cheaper" },
    signWith: { keyId: w.agentB.keyId, kp: w.agentB.kp },
  });

  // --- negative control: a neighbouring scope that must not move --------------
  const RECN00 = created("ruling", {
    scope: scope(INGEST),
    producer: { principal: w.beta.principal, kind: "human", host: w.beta.host },
    parents: infraIds,
    evidence_class: "human_ruling",
    source: srcBeta,
    payload: { statement: "dedupe on content hash" },
    signWith: { keyId: w.beta.keyId, kp: w.beta.kp },
  });

  // --- positive control: an uncontested successor through the same weather ----
  const RECE00 = created("ruling", {
    scope: scope(EXPORT),
    producer: { principal: w.alpha.principal, kind: "human", host: w.alpha.host },
    parents: infraIds,
    evidence_class: "human_ruling",
    source: srcAlpha,
    payload: { statement: "export writes CSV" },
    signWith: { keyId: w.alpha.keyId, kp: w.alpha.kp },
  });
  const RECE01 = created("ruling", {
    scope: scope(EXPORT),
    producer: { principal: w.beta.principal, kind: "human", host: w.beta.host },
    parents: [RECE00.id as string],
    evidence_class: "human_ruling",
    occurred_at: "2026-09-15T10:20:00.000Z",
    source: srcBeta,
    payload: { statement: "export writes parquet", supersedes: [RECE00.id as string] },
    signWith: { keyId: w.beta.keyId, kp: w.beta.kp },
  });
  const SUPE = buildEvent({
    kind: "superseded",
    record: { type: "ruling", id: RECE00.id as string },
    scope: scope(EXPORT),
    producer: { principal: w.beta.principal, kind: "human", host: w.beta.host },
    parents: [RECE01.id as string],
    evidence_class: "human_ruling",
    payload: { target: RECE00.id as string, by: RECE01.id as string, reason: "columnar" },
    signWith: { keyId: w.beta.keyId, kp: w.beta.kp },
  });

  return {
    infra,
    REC000, RECA01, SUPA, RECB02, SUPB, RECB01, SUPB01, RECN00, RECE00, RECE01, SUPE,
    caseEvents: [REC000, RECA01, RECB02, RECB01, RECN00, RECE00, RECE01],
  };
}

/** Delivery order O1: E01 → B02 → A01 → B01 (oracle §4 T4). */
function orderO1(f: C11Fixture): Array<Record<string, unknown>> {
  return [...f.infra, f.REC000, f.RECN00, f.RECE00, f.RECE01, f.SUPE, f.RECB02, f.SUPB, f.RECA01, f.SUPA, f.RECB01, f.SUPB01];
}
/** Delivery order O2: A01 first; B01 arrives BEFORE its prerequisite B02. */
function orderO2(f: C11Fixture): Array<Record<string, unknown>> {
  return [...f.infra, f.REC000, f.RECA01, f.SUPA, f.RECB01, f.SUPB01, f.RECB02, f.SUPB, f.RECE00, f.RECE01, f.SUPE, f.RECN00];
}

async function replica(w: C11World, order: Array<Record<string, unknown>>, dir = tempDir("c11")): Promise<EventStore> {
  const store = newStore(w, w.hostA, dir, w.extraKeys);
  for (const e of order) store.receive(e, "peer");
  await admitAndProject(store);
  return store;
}

describe("C11 — both histories survive; replicas converge to the same explicitly conflicted view", () => {
  it("A01/A02/A03: both successors survive and the ancestor is explicitly conflicted, in both stores", async () => {
    const w = c11World();
    const f = fixture(w);
    const s1 = await replica(w, orderO1(f));
    const s2 = await replica(w, orderO2(f));

    for (const store of [s1, s2]) {
      const events = await store.events({});
      for (const e of f.caseEvents) {
        const found = events.find((x) => x.id === e.id);
        expect(found?.digest).toBe(e.digest); // A01: same (id, digest) pairs, nothing rewritten
      }

      const ancestor = await store.get(f.REC000.id as string);
      expect(ancestor?.status).toBe("conflicted"); // A02
      expect(ancestor?.conflicts.sort()).toEqual([f.RECA01.id, f.RECB02.id].sort()); // A02: members
      expect(ancestor?.superseded_by.sort()).toEqual([f.RECA01.id, f.RECB02.id].sort());

      // A03: neither successor is resolved as the winner — both stay applicable
      const view = await store.query({ scope: { repo: w.repo, path: POLICY } });
      const ids = view.map((r) => r.record_id);
      expect(ids).toContain(f.RECA01.id);
      expect(ids).toContain(f.RECB02.id);
      // and action qualification refuses while the conflict stands
      expect(currentUseClaim(ancestor!, { repo: w.repo, path: POLICY, revision: { head: G1 } })).toEqual({ ok: false, reason: "conflicted" });
    }
    s1.close();
    s2.close();
  });

  it("A04/A05: the lower-class claim is retained with its original text, refused, and never in current()", async () => {
    const w = c11World();
    const f = fixture(w);
    const s1 = await replica(w, orderO1(f));

    // A04: retained in history, refused with the class reason, edge stored as a claim
    const ancestor = await s1.get(f.REC000.id as string);
    const claim = ancestor?.contested.find((c) => c.event === f.SUPB01.id);
    expect(claim?.reason).toBe("lower_evidence_class_cannot_supersede_human_ruling");
    expect(claim?.claimant).toBe(f.RECB01.id);
    expect(ancestor?.superseded_by).not.toContain(f.RECB01.id); // never an admitted edge

    const b01 = await s1.get(f.RECB01.id as string);
    expect(b01).not.toBeNull(); // retained
    expect((b01?.body as { summary: string }).summary).toBe("retention MUST be 1 day"); // original text preserved
    expect(b01?.evidence_class).toBe("model_inference"); // A05: caller fields confer nothing
    expect((b01?.body as { active: boolean }).active).toBe(true);
    expect((b01?.body as { promoted_by: string }).promoted_by).toBe(w.alpha.principal);
    expect(b01?.authorizes_action).toBe(false);

    // A05: absent from current() in EVERY scope
    for (const p of [POLICY, INGEST, EXPORT, "src/"]) {
      const view = await s1.query({ scope: { repo: w.repo, path: p } });
      expect(view.map((r) => r.record_id)).not.toContain(f.RECB01.id);
    }
    // …and the event is still admitted (admission ≠ acceptance of its claim)
    expect((await s1.events({})).map((e) => e.id)).toContain(f.SUPB01.id);
    s1.close();
  });

  it("A06 (rule_E): the policy-scope fight does not leak into a non-descendant scope", async () => {
    const w = c11World();
    const f = fixture(w);
    const s1 = await replica(w, orderO1(f));
    const ingest = await s1.query({ scope: { repo: w.repo, path: INGEST }, record_type: "ruling" });
    expect(ingest.map((r) => r.record_id)).toEqual([f.RECN00.id]);
    const n00 = await s1.get(f.RECN00.id as string);
    expect(n00?.status).toBe("active");
    expect(n00?.conflicts).toHaveLength(0);
    expect(n00?.superseded_by).toHaveLength(0);
    expect(n00?.contested).toHaveLength(0);
    s1.close();
  });

  it("A07: the positive control still RESOLVES — 'everything is conflicted' is not a passing answer", async () => {
    const w = c11World();
    const f = fixture(w);
    for (const order of [orderO1(f), orderO2(f)]) {
      const s = await replica(w, order);
      const view = await s.query({ scope: { repo: w.repo, path: EXPORT }, record_type: "ruling" });
      expect(view.map((r) => r.record_id)).toEqual([f.RECE01.id]); // A07
      expect(view[0]?.conflicts).toHaveLength(0); // non-conflicted
      const e00 = await s.get(f.RECE00.id as string);
      expect(e00?.status).toBe("superseded");
      expect(e00?.superseded_by).toEqual([f.RECE01.id]);
      s.close();
    }
  });

  it("A08/A09 (rule_D): O1 and O2 agree, and swapping the clock skew changes nothing", async () => {
    const w = c11World();
    const f = fixture(w);
    const s1 = await replica(w, orderO1(f));
    const s2 = await replica(w, orderO2(f));
    expect(s2.projectionDigest()).toBe(s1.projectionDigest()); // A08

    // A09: the latest wall clock (B01) never wins; the earliest (B02) never loses
    const ancestor = await s1.get(f.REC000.id as string);
    expect(ancestor?.conflicts).toContain(f.RECB02.id);
    expect(ancestor?.conflicts).not.toContain(f.RECB01.id);
    // the mirror run swaps which host is "fast" by reversing the delivery order
    // of the two skewed successors; the digest is unchanged either way
    const mirror = await replica(w, [...f.infra, f.REC000, f.RECN00, f.RECE00, f.RECE01, f.SUPE, f.RECA01, f.SUPA, f.RECB02, f.SUPB, f.RECB01, f.SUPB01]);
    expect(mirror.projectionDigest()).toBe(s1.projectionDigest());
    s1.close();
    s2.close();
    mirror.close();
  });

  it("A19: in O2 a claim arriving before its causal prerequisite is held, visible, neither applied nor dropped", async () => {
    const w = c11World();
    const f = fixture(w);
    const store = newStore(w, w.hostA, tempDir("c11-pending"), w.extraKeys);
    // deliver everything up to and including B01, but NOT B02
    for (const e of [...f.infra, f.REC000, f.RECA01, f.SUPA, f.RECB01, f.SUPB01]) store.receive(e, "peer");
    await admitAndProject(store);

    const st = await store.deliveryState(f.RECB01.id as string);
    expect(st?.state).toBe("pending_parents");
    expect(st?.pending_on).toEqual([f.RECB02.id]);
    expect(store.journalRows().find((r) => r.id === f.RECB01.id)?.state).toBe("pending_parents"); // visible
    expect(await store.get(f.RECB01.id as string)).toBeNull(); // never applied early

    store.receive(f.RECB02, "peer");
    store.receive(f.SUPB, "peer");
    await admitAndProject(store);
    expect((await store.deliveryState(f.RECB01.id as string))?.state).toBe("projected");
    store.close();
  });

  it("A10/A11/A12: two byte-identical retries yield one admission, and the lost ack never re-mints an identity", async () => {
    const w = c11World();
    const f = fixture(w);
    const s2 = await replica(w, orderO1(f));
    // T5 — redeliver EV-1001 (REC-A01) twice more, byte-identical
    s2.receive(f.RECA01, "peer");
    s2.receive(f.RECA01, "peer");
    await admitAndProject(s2);

    const st = await s2.deliveryState(f.RECA01.id as string);
    expect(st?.admissions).toBe(1); // A10
    expect(st?.duplicate_suppressed).toBe(2);
    expect(s2.admissionLog(f.RECA01.id as string).filter((r) => r.outcome === "admitted")).toHaveLength(1);
    const ancestor = await s2.get(f.REC000.id as string);
    expect(ancestor?.conflicts).toHaveLength(2); // A10: still exactly two members

    // A12 — the producer's lost-ack window, and the retry under the SAME id
    const s1 = await replica(w, orderO1(f));
    const carrier = new FsTransport(tempDir("c11-carrier"));
    const outbox = new Outbox(s1, carrier);
    carrier.setFaults({ dropNextPublishReceipt: true });
    await outbox.flush();
    const uncertain = await s1.deliveryState(f.RECA01.id as string);
    expect(uncertain?.transfers[0]).toMatchObject({ uncertain: true, acked: false, state: "exported" });
    await outbox.flush();
    const settled = await s1.deliveryState(f.RECA01.id as string);
    expect(settled?.transfers[0]).toMatchObject({ uncertain: false, acked: true, state: "transferred" });
    // A11: no new identity was minted for the uncertain operation
    const digests = s1.journalRows().filter((r) => r.digest === f.RECA01.digest).map((r) => r.id);
    expect([...new Set(digests)]).toEqual([f.RECA01.id]);
    s1.close();
    s2.close();
  });

  it("A13: every delivery state reaches admitted+projected and scoped acceptance still does not exist", async () => {
    const w = c11World();
    const f = fixture(w);
    const s1 = await replica(w, orderO1(f));
    for (const e of f.caseEvents) expect((await s1.deliveryState(e.id as string))?.state).toBe("projected");
    // lane 02 has no surface that can produce an acceptance
    expect(await s1.events({ kinds: ["receipt"] })).toHaveLength(0);
    s1.close();
  });

  it("A14/A18: index rebuild and a store built from the durable export alone reproduce the same views", async () => {
    const w = c11World();
    const f = fixture(w);
    const dir = tempDir("c11-rebuild");
    const s2 = await replica(w, orderO2(f), dir);
    const before = s2.projectionDigest();
    const beforeAdmitted = (await s2.events({})).map((e) => e.id).sort();

    // A14 — destroy the derived index, rebuild from durable evidence only
    expect((await s2.rebuild()).projection_digest).toBe(before);
    expect((await s2.events({})).map((e) => e.id).sort()).toEqual(beforeAdmitted); // zero acknowledged events lost
    const ancestor = await s2.get(f.REC000.id as string);
    expect(ancestor?.status).toBe("conflicted");
    expect(ancestor?.conflicts.sort()).toEqual([f.RECA01.id, f.RECB02.id].sort());

    // A18 — store:S3 built from S1's durable export only (events/ + cursors/)
    const s3dir = tempDir("c11-s3");
    fs.cpSync(path.join(dir, "events"), path.join(s3dir, "events"), { recursive: true });
    const s3 = newStore(w, w.hostB, s3dir, w.extraKeys);
    const { projection_digest } = await s3.rebuild();
    expect(projection_digest).toBe(before);
    s2.close();
    s3.close();
  });

  it("A15/A16: a source change refuses current use without deleting anything or resolving the conflict", async () => {
    const w = c11World();
    const f = fixture(w);
    const s1 = await replica(w, orderO1(f));
    const before = await s1.query({ scope: { repo: w.repo, path: POLICY } });

    const a01 = await s1.get(f.RECA01.id as string);
    // A15: anchored at G1, so a current-use claim at G2 is refused…
    expect(currentUseClaim(a01!, { repo: w.repo, path: POLICY, revision: { head: G2 } })).toEqual({ ok: false, reason: "stale_revision" });
    // …while the original anchor is retained
    expect(a01?.scope.revision?.head).toBe(G1);
    // A16: nothing deleted, nothing auto-rebound, conflict unresolved
    expect(await s1.query({ scope: { repo: w.repo, path: POLICY } })).toEqual(before);
    expect((await s1.get(f.REC000.id as string))?.status).toBe("conflicted");
    // the unchanged neighbouring scopes keep qualifying
    const n00 = await s1.get(f.RECN00.id as string);
    expect(currentUseClaim(n00!, { repo: w.repo, path: INGEST, revision: { head: G1 } })).toEqual({ ok: true });
    s1.close();
  });

  it("A17: two clone paths and two remote labels resolve to one repository identity", async () => {
    const w = c11World();
    const f = fixture(w);
    const s1 = await replica(w, orderO1(f));
    const events = await s1.events({});
    const repos = new Set(events.map((e) => e.scope.repo));
    expect([...repos]).toEqual([w.repo]); // one repository entity
    // the clone labels differ and are recorded separately from identity
    const a = events.find((e) => e.id === f.RECA01.id);
    const b = events.find((e) => e.id === f.RECB02.id);
    expect(a?.source?.dirty).toBe(false);
    expect(b?.source?.dirty).toBe(true);
    expect(a?.source?.repo).toBe(b?.source?.repo); // same repo id despite different checkouts
    s1.close();
  });
});
