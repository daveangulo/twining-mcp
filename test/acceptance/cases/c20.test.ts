/**
 * C20 — delete / retract / redact, then reconnect an old replica or restore a
 * backup. Oracle: `test/acceptance/oracles/C20.oracle.md`.
 *
 * ================= VOCABULARY MAPPING (declared before the run) ==============
 * C20 §0 requires the implementation's words to be mapped and frozen first.
 *
 *   oracle RETRACT → `retracted` lifecycle event. Removed from the current
 *                    applicable view; the record's bytes and digest are
 *                    untouched and fully readable in history.
 *   oracle REDACT  → `tombstoned` with `purge: false`. The record keeps its
 *                    identity, scope, author, digest and history; the reducer
 *                    empties its body, so the payload is withheld from every
 *                    projection-derived path. The EVENT file still holds the
 *                    original bytes, which is the difference from purge.
 *   oracle PURGE   → `tombstoned` with `purge: true`, followed by the LOCAL act
 *                    `store.purge(id)`: the created event's file is replaced by
 *                    a stub carrying its id and digest, so the identity and the
 *                    proof survive and the payload does not.
 *   oracle ARCHIVE → `archived` / `restored` (the reversible positive control).
 *
 * The three are observably distinct: retract keeps bytes everywhere; redact
 * keeps bytes only in the event file and withholds them from projections; purge
 * destroys the local bytes and keeps a stub. A rendering that collapsed them
 * would fail the case by construction.
 *
 * ERASURE SCOPE: `store.erasureReport()` enumerates locations with per-location
 * status and carries `global_erasure_claimed: false` as a typed literal — there
 * is no code path that can emit an unqualified global-deletion claim.
 */
import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { currentUseClaim } from "../../../src/events/projection.js";
import { EventStore } from "../../../src/events/event-store.js";
import { FsTransport } from "../../../src/exchange/fs-transport.js";
import { Inbox } from "../../../src/exchange/inbox.js";
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
} from "../slice/harness.js";

afterAll(cleanupTempDirs);

const LEDGER = "services/ledger/";
const SECRETS = "services/ledger/secrets/";
const DOCS = "services/ledger/docs/";

interface C20World extends World {
  marisol: Identity;
  tobias: Identity;
  extraKeys: Record<string, { publicKeySpkiBase64: string; human?: boolean }>;
}

function c20World(): C20World {
  const base = makeWorld();
  const marisol = makeIdentity();
  const tobias = makeIdentity();
  return { ...base, marisol, tobias, extraKeys: keysOf([[marisol, true], [tobias, true]]) };
}

/** The untouched byte-preservation control: BOM, CRLF, no trailing newline. */
const B6_TEXT = "﻿rounding counterexample\r\nsecond line";

function fixture(w: C20World) {
  const principals = principalEvents(w.repo, w.hostA, [
    { id: w.marisol, kind: "human" },
    { id: w.tobias, kind: "human" },
    { id: w.hostA, kind: "agent" },
  ]);
  const membership = membershipEvent(
    w.repo,
    w.storeId,
    w.hostA,
    [
      { principal: w.marisol.principal, roles: ["rule", "write"], scopes: [{ repo: w.repo, path: LEDGER }] },
      // tobias may contribute to docs/ only, and holds NO lifecycle authority.
      { principal: w.tobias.principal, roles: ["propose", "write"], scopes: [{ repo: w.repo, path: DOCS }] },
      { principal: w.hostA.principal, roles: ["write"], scopes: [{ repo: w.repo }] },
    ],
    principals.map((e) => e.id as string),
  );
  const infra = [...principals, membership];
  const infraIds = infra.map((e) => e.id as string);

  const mk = (scope: string, summary: string, rationale: string) =>
    created("decision", {
      scope: { repo: w.repo, path: scope },
      producer: { principal: w.marisol.principal, kind: "human", host: w.marisol.host },
      parents: infraIds,
      evidence_class: "human_statement",
      payload: { summary, rationale },
      signWith: { keyId: w.marisol.keyId, kp: w.marisol.kp },
    });

  const rec4NQ2v1 = mk(LEDGER, "ledger rounding rule v1", "customer account 4419-8827 rounds half-up");
  const rec7TLD = mk(LEDGER, "deploy window", "deploys land Tuesdays 09:00-11:00 UTC");
  const rec9XKM = mk(SECRETS, "credential rotation note", "vault token rotation runbook");
  const rec2BHF = mk(LEDGER, "batch size lesson", "batches above 5k time out");
  const rec5CQP = created("decision", {
    scope: { repo: w.repo, path: LEDGER },
    producer: { principal: w.marisol.principal, kind: "human", host: w.marisol.host },
    parents: infraIds,
    evidence_class: "human_statement",
    payload: { summary: "rounding counterexample", rationale: B6_TEXT },
    signWith: { keyId: w.marisol.keyId, kp: w.marisol.kp },
  });

  const seed = [rec4NQ2v1, rec7TLD, rec9XKM, rec2BHF, rec5CQP];
  return { infra, infraIds, rec4NQ2v1, rec7TLD, rec9XKM, rec2BHF, rec5CQP, seed };
}

type Fixture = ReturnType<typeof fixture>;

function lifecycle(w: C20World, kind: string, target: Record<string, unknown>, payload: Record<string, unknown>, who: Identity, scope: string) {
  return buildEvent({
    kind,
    record: { type: "decision", id: target.id as string },
    scope: { repo: w.repo, path: scope },
    producer: { principal: who.principal, kind: "human", host: who.host },
    parents: [target.id as string],
    evidence_class: "human_ruling",
    payload: { target: target.id as string, ...payload },
    signWith: { keyId: who.keyId, kp: who.kp },
  });
}

async function replica(w: C20World, events: Array<Record<string, unknown>>, dir = tempDir("c20")): Promise<EventStore> {
  const store = newStore(w, w.hostA, dir, w.extraKeys);
  for (const e of events) store.receive(e, "fs:carrier", `events/${(e as { id: string }).id}`);
  await admitAndProject(store);
  return store;
}

/** The three lifecycle acts of the case, as a reusable batch. */
function acts(w: C20World, f: Fixture) {
  const archive = lifecycle(w, "archived", f.rec2BHF, { reason: "superseded by tooling" }, w.marisol, LEDGER);
  const retract = lifecycle(w, "retracted", f.rec7TLD, { reason: "window changed" }, w.marisol, LEDGER);
  const redact = lifecycle(w, "tombstoned", f.rec4NQ2v1, { reason: "payload contains a customer account identifier", purge: false }, w.marisol, LEDGER);
  const replacement = created("decision", {
    scope: { repo: w.repo, path: LEDGER },
    producer: { principal: w.marisol.principal, kind: "human", host: w.marisol.host },
    parents: [redact.id as string],
    evidence_class: "human_statement",
    payload: { summary: "ledger rounding rule v2", rationale: "rounds half-up; no account identifiers" },
    signWith: { keyId: w.marisol.keyId, kp: w.marisol.kp },
  });
  const purge = lifecycle(w, "tombstoned", f.rec9XKM, { reason: "credential material", purge: true }, w.marisol, SECRETS);
  return { archive, retract, redact, replacement, purge, all: [archive, retract, redact, replacement, purge] };
}

// ---------------------------------------------------------------------------

describe("C20 — the three end states are observably distinct", () => {
  it("A1/B1/B2/B3: retract keeps bytes, redact withholds them, purge leaves only a stub", async () => {
    const w = c20World();
    const f = fixture(w);
    const dir = tempDir("c20-distinct");
    const a = acts(w, f);
    const store = await replica(w, [...f.infra, ...f.seed, ...a.all], dir);
    await store.purge(f.rec9XKM.id as string);

    // A1: the current applicable view holds the replacement and the untouched
    // controls, and NONE of the three.
    const view = (await store.query({ scope: { repo: w.repo, path: LEDGER } })).map((r) => r.record_id);
    expect(view).toContain(a.replacement.id as string);
    expect(view).toContain(f.rec5CQP.id as string);
    expect(view).not.toContain(f.rec4NQ2v1.id as string);
    expect(view).not.toContain(f.rec7TLD.id as string);
    expect(view).not.toContain(f.rec9XKM.id as string);

    // B1 — RETRACT: history keeps the record, its status, its actor and its
    // exact bytes.
    const retracted = await store.get(f.rec7TLD.id as string);
    expect(retracted?.status).toBe("retracted");
    expect((retracted?.body as { rationale: string }).rationale).toBe("deploys land Tuesdays 09:00-11:00 UTC");
    expect(retracted?.producer).toBe(w.marisol.principal);
    expect(retracted?.history).toContain(a.retract.id as string);

    // B2 — REDACT: identity, digest, author and history survive; the payload
    // does NOT. The two are distinguishable by STRUCTURE, not by a status word.
    const redacted = await store.get(f.rec4NQ2v1.id as string);
    expect(redacted?.status).toBe("tombstoned");
    expect(redacted?.body).toEqual({});
    expect(redacted?.record_id).toBe(f.rec4NQ2v1.id);
    expect(redacted?.producer).toBe(w.marisol.principal);
    expect((await store.events({})).find((e) => e.id === f.rec4NQ2v1.id)?.digest).toBe(f.rec4NQ2v1.digest); // B6: the ORIGINAL hash

    // B3 — PURGE: the local payload bytes are gone; a stub carrying the identity
    // and the digest remains, and the tombstone is enumerable.
    const purgedFile = path.join(dir, "events", "2026-09", `${f.rec9XKM.id as string}.json`);
    const stub = JSON.parse(fs.readFileSync(purgedFile, "utf8")) as Record<string, unknown>;
    expect(stub.purged).toBe(true);
    expect(stub.digest).toBe(f.rec9XKM.digest);
    expect(JSON.stringify(stub)).not.toContain("vault token rotation runbook");
    expect(store.localErasures(f.rec9XKM.id as string).map((e) => e.op)).toEqual(["purge"]);
    store.close();
  });

  it("A4/B3: the redacted and purged payloads are absent from every projection-derived path", async () => {
    const w = c20World();
    const f = fixture(w);
    const dir = tempDir("c20-a4");
    const a = acts(w, f);
    const store = await replica(w, [...f.infra, ...f.seed, ...a.all], dir);
    await store.purge(f.rec9XKM.id as string);

    const secret = "customer account 4419-8827";
    const vault = "vault token rotation runbook";
    // Probe each path INDIVIDUALLY, as A4 requires — a pass on the primary
    // serving path alone does not satisfy it.
    const paths: Array<[string, string]> = [
      ["exact-id lookup", JSON.stringify(await store.get(f.rec4NQ2v1.id as string))],
      ["scope listing", JSON.stringify(await store.query({ scope: { repo: w.repo, path: LEDGER }, include_retired: true, include_archived: true }))],
      ["whole projection", JSON.stringify(await store.query({ include_retired: true, include_archived: true }))],
      ["history", JSON.stringify(await store.history(f.rec4NQ2v1.id as string))],
      ["operator status", JSON.stringify(await store.exchangeStatus())],
      ["erasure report", JSON.stringify(await store.erasureReport(f.rec9XKM.id as string))],
      ["ingest ledger", JSON.stringify(store.ingestAttempts())],
    ];
    for (const [name, blob] of paths) {
      if (name === "history") continue; // the immutable event log is the ONE place redacted bytes remain
      expect(blob, name).not.toContain(secret);
      expect(blob, name).not.toContain(vault);
    }
    // ...and the purged payload is gone even from the event log.
    expect(JSON.stringify(await store.history(f.rec9XKM.id as string))).not.toContain(vault);
    store.close();
  });

  it("D4/A1: archive is NOT revocation — the unarchive positive control restores the record intact", async () => {
    const w = c20World();
    const f = fixture(w);
    const a = acts(w, f);
    const unarchive = lifecycle(w, "restored", f.rec2BHF, { reason: "still relevant" }, w.marisol, LEDGER);
    const store = await replica(w, [...f.infra, ...f.seed, ...a.all, unarchive]);

    const rec = await store.get(f.rec2BHF.id as string);
    expect(rec?.archived).toBe(false);
    expect(rec?.status).toBe("active");
    expect((rec?.body as { rationale: string }).rationale).toBe("batches above 5k time out");
    expect(rec?.evidence_class).toBe("human_statement"); // unchanged
    expect((await store.query({ scope: { repo: w.repo, path: LEDGER } })).map((r) => r.record_id)).toContain(f.rec2BHF.id as string);
    store.close();
  });
});

describe("C20 — no resurrection", () => {
  it("A5/C3/IC2: redelivering the creation event after the redaction changes nothing and yields a duplicate receipt", async () => {
    const w = c20World();
    const f = fixture(w);
    const a = acts(w, f);
    const store = await replica(w, [...f.infra, ...f.seed, ...a.all]);
    const before = store.projectionDigest();

    // T09 — the reconnecting replica pushes its offline backlog, which still
    // contains the ORIGINAL creation event for the record that was redacted.
    const res = store.receive(f.rec4NQ2v1, "fs:carrier", "events/backlog");
    await admitAndProject(store);

    expect(res.duplicate).toBe(true); // C3: duplicate_ignored
    expect((await store.get(f.rec4NQ2v1.id as string))?.status).toBe("tombstoned"); // A5
    expect((await store.get(f.rec4NQ2v1.id as string))?.body).toEqual({});
    expect(store.projectionDigest()).toBe(before);
    expect((await store.query({ scope: { repo: w.repo, path: LEDGER } })).map((r) => r.record_id)).not.toContain(f.rec4NQ2v1.id as string);
    // The dedup is recorded, not invisible.
    expect((await store.deliveryState(f.rec4NQ2v1.id as string))?.duplicate_suppressed).toBeGreaterThan(0);
    store.close();
  });

  it("A2/A5: two replicas converge on the same end state regardless of arrival order and clock skew", async () => {
    const w = c20World();
    const f = fixture(w);
    const a = acts(w, f);
    const alpha = await replica(w, [...f.infra, ...f.seed, ...a.all, f.rec4NQ2v1], tempDir("c20-alpha"));
    // beta sees the backlog LAST, and sees the lifecycle events in a different
    // order — the skew variant the oracle makes mandatory.
    const beta = await replica(
      w,
      [...f.infra, ...f.seed, a.purge, a.redact, a.replacement, a.retract, a.archive, f.rec4NQ2v1],
      tempDir("c20-beta"),
    );
    expect(beta.projectionDigest()).toBe(alpha.projectionDigest()); // A2
    expect((await beta.get(f.rec4NQ2v1.id as string))?.status).toBe("tombstoned");
    alpha.close();
    beta.close();
  });

  it("D3/D5: an offline note claiming a human approved keeping the record confers nothing, and an unauthorized purge is refused with no partial effect", async () => {
    const w = c20World();
    const f = fixture(w);
    const a = acts(w, f);
    const store = await replica(w, [...f.infra, ...f.seed, ...a.all]);

    // ev-0201 — tobias's offline note asserting a standup sign-off.
    const note = created("post", {
      scope: { repo: w.repo, path: DOCS },
      producer: { principal: w.tobias.principal, kind: "human", host: w.tobias.host },
      parents: [f.rec4NQ2v1.id as string],
      evidence_class: "human_statement",
      payload: {
        entry_type: "finding",
        summary: "Confirmed with Marisol at standup — the original rounding rule stays applicable.",
        detail: "No change needed for the September ledger release.",
      },
      signWith: { keyId: w.tobias.keyId, kp: w.tobias.kp },
    });
    // ev-0104 — tobias attempts to purge a record outside his authority.
    const attempt = lifecycle(w, "tombstoned", f.rec4NQ2v1, { reason: "remove it", purge: true }, w.tobias, DOCS);
    store.receive(note, "fs:carrier", "events/note");
    store.receive(attempt, "fs:carrier", "events/attempt");
    await admitAndProject(store);

    // D3: the note is ordinary data at its own class and restores nothing.
    const noteRec = await store.get(note.id as string);
    expect(noteRec?.evidence_class).toBe("human_statement");
    expect(noteRec?.authorizes_action).toBe(false);
    expect((await store.get(f.rec4NQ2v1.id as string))?.status).toBe("tombstoned");

    // D5: the unauthorized attempt is refused, RECORDED, and has no partial effect.
    const row = store.journalRows().find((r) => r.id === attempt.id && r.canonical);
    expect(["rejected", "quarantined"]).toContain(row?.state);
    expect(store.admissionLog(attempt.id as string).length).toBeGreaterThan(0);
    expect(store.localErasures(f.rec4NQ2v1.id as string)).toEqual([]); // nothing purged
    const purgeAttempt = await store.purge(f.rec4NQ2v1.id as string);
    expect(purgeAttempt.purged).toBe(true); // marisol's redaction DID tombstone it...
    store.close();
  });

  it("D6: an unrelated legitimate offline record still lands — reconnection is not wholesale rejection", async () => {
    const w = c20World();
    const f = fixture(w);
    const a = acts(w, f);
    const lesson = created("decision", {
      scope: { repo: w.repo, path: DOCS },
      producer: { principal: w.tobias.principal, kind: "human", host: w.tobias.host },
      parents: f.infraIds,
      evidence_class: "human_statement",
      payload: { summary: "runbook gap", rationale: "the rollback step is missing" },
      signWith: { keyId: w.tobias.keyId, kp: w.tobias.kp },
    });
    const store = await replica(w, [...f.infra, ...f.seed, ...a.all, lesson]);
    expect((await store.query({ scope: { repo: w.repo, path: DOCS } })).map((r) => r.record_id)).toContain(lesson.id as string);
    store.close();
  });
});

describe("C20 — delivery states, restore and the honesty of erasure claims", () => {
  it("C1/C2: nothing is reported delivered to a partitioned replica, and suppression takes effect at ADMISSION", async () => {
    const w = c20World();
    const f = fixture(w);
    const a = acts(w, f);
    const shared = tempDir("c20-carrier");
    const carrier = new FsTransport(shared);
    const alphaDir = tempDir("c20-alpha2");
    const alpha = await replica(w, [...f.infra, ...f.seed], alphaDir);

    // beta is partitioned: it holds the seed, then the lifecycle events land on
    // the carrier while it is away.
    const betaDir = tempDir("c20-beta2");
    const beta = await replica(w, [...f.infra, ...f.seed], betaDir);
    await carrier.publish([...f.infra, ...f.seed, ...a.all].map((e) => e as never));

    // C1: while partitioned, beta's cursor has not moved and nothing claims
    // delivery of the lifecycle events to it.
    expect(await beta.cursor(w.hostB.principal)).toBeNull();
    expect((await beta.get(f.rec4NQ2v1.id as string))?.body).not.toEqual({});

    // T09 — beta reconnects.
    await new Inbox(beta, carrier, w.hostB.principal).pull();

    // C2: the suppression happened at ADMISSION, not at render time — the
    // MATERIALIZED projection row itself carries no payload.
    const row = await beta.get(f.rec4NQ2v1.id as string);
    expect(row?.status).toBe("tombstoned");
    expect(row?.body).toEqual({});
    expect(JSON.stringify(await beta.query({ include_retired: true, include_archived: true }))).not.toContain("4419-8827");
    alpha.close();
    beta.close();
  });

  it("A3/C4/IC6: a restored backup enumerates its unapplied lifecycle events and refuses to qualify from the stale copy", async () => {
    const w = c20World();
    const f = fixture(w);
    const a = acts(w, f);
    const originDir = tempDir("c20-origin");
    const origin = await replica(w, [...f.infra, ...f.seed], originDir);
    origin.close();

    // T03 — snapshot taken BEFORE any lifecycle operation.
    const snapDir = tempDir("c20-snap");
    fs.cpSync(originDir, snapDir, { recursive: true });

    // ...the lifecycle then happens on the origin.
    const live = new EventStore({ twiningDir: originDir, knownKeys: w.extraKeys, now: () => "2026-09-15T00:00:00.000Z" });
    for (const e of a.all) live.receive(e, "fs:carrier", `events/${(e as { id: string }).id}`);
    await admitAndProject(live);

    // T10 — restore the snapshot into a clean store. `twining restore` opens a
    // pending-import obligation naming the events the snapshot predates, which
    // is what turns "serving stale content" into "serving stale content, and
    // saying so".
    const gammaDir = tempDir("c20-gamma");
    fs.cpSync(snapDir, gammaDir, { recursive: true });
    const gamma = new EventStore({ twiningDir: gammaDir, knownKeys: w.extraKeys, now: () => "2026-09-15T00:00:00.000Z" });
    await admitAndProject(gamma);
    const unapplied = a.all.map((e) => e as { id: string }).map((e) => e.id);
    gamma.openPendingImport({
      batch_id: `restore:${path.basename(snapDir)}`,
      carrier: "backup",
      reason: "RESTORED_FROM_SNAPSHOT",
      missing: unapplied,
      scopes: [{ repo: w.repo, path: LEDGER }, { repo: w.repo, path: SECRETS }],
    });

    // A3/C4: the restore point and the unapplied set are machine-readable.
    const pending = gamma.pendingImports();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.reason).toBe("RESTORED_FROM_SNAPSHOT");
    expect(pending[0]?.missing.sort()).toEqual(unapplied.sort());
    expect((await gamma.exchangeStatus()).gaps.some((g) => g.kind === "pending_import")).toBe(true);

    // D1: the stale copy is present but NEVER qualifies an action.
    const served = await gamma.serve(f.rec4NQ2v1.id as string, { repo: w.repo, path: LEDGER });
    expect(served.record?.status).toBe("active"); // pre-lifecycle content is there...
    expect(served.fallback_used).toBe(true); // ...and it is marked
    expect(served.qualification.ok).toBe(false);
    expect(served.qualification.reason).toContain("pending_unresolved_import");

    // IC6 (restore watermark OFF): with the obligation dropped, the stale
    // authorization qualifies — the failure the watermark exists to prevent.
    gamma.resolvePendingImport(pending[0]?.batch_id as string);
    const unmarked = await gamma.serve(f.rec4NQ2v1.id as string, { repo: w.repo, path: LEDGER });
    expect(unmarked.fallback_used).toBe(false); // A3 FAILS: served unmarked
    // The restore-specific refusal is GONE. (This record is `human_statement`,
    // so its own evidence class still refuses it — the control is demonstrated
    // on the marker and on the reason, which is where the watermark acts, not
    // on a verdict that a second independent rule happens to also refuse.)
    expect(served.qualification.reason).toContain("pending_unresolved_import");
    expect(unmarked.qualification.reason ?? "").not.toContain("pending_unresolved_import"); // D1's restore reason FAILS
    expect(unmarked.pending).toEqual([]);

    // Reconciling for real (the lifecycle events arrive) converges it.
    for (const e of a.all) gamma.receive(e, "fs:carrier", `events/${(e as { id: string }).id}`);
    await admitAndProject(gamma);
    expect((await gamma.get(f.rec4NQ2v1.id as string))?.status).toBe("tombstoned");
    expect(currentUseClaim((await gamma.get(f.rec4NQ2v1.id as string))!, { repo: w.repo, path: LEDGER })).toEqual({ ok: false, reason: "status_tombstoned" });
    live.close();
    gamma.close();
  });

  it("B5: byte-level fidelity survives replication, backup and restore", async () => {
    const w = c20World();
    const f = fixture(w);
    const originDir = tempDir("c20-b5-origin");
    const origin = await replica(w, [...f.infra, ...f.seed], originDir);
    const before = (await origin.get(f.rec5CQP.id as string)) as { body: { rationale: string } };
    expect(before.body.rationale).toBe(B6_TEXT);
    origin.close();

    const restoredDir = tempDir("c20-b5-restore");
    fs.cpSync(originDir, restoredDir, { recursive: true });
    const restored = new EventStore({ twiningDir: restoredDir, knownKeys: w.extraKeys, now: () => "2026-09-15T00:00:00.000Z" });
    const rebuilt = await restored.rebuild();
    expect(rebuilt.acknowledged_events_lost).toBe(0);
    const after = (await restored.get(f.rec5CQP.id as string)) as { body: { rationale: string } };
    expect(after.body.rationale).toBe(B6_TEXT); // BOM and CRLF intact
    expect((await restored.events({})).find((e) => e.id === f.rec5CQP.id)?.digest).toBe(f.rec5CQP.digest);
    restored.close();
  });

  it("E1/E2/E4/C5/IC7: the erasure report is per-location and can never claim global deletion", async () => {
    const w = c20World();
    const f = fixture(w);
    const a = acts(w, f);
    const store = await replica(w, [...f.infra, ...f.seed, ...a.all]);
    await store.purge(f.rec9XKM.id as string);

    const report = await store.erasureReport(f.rec9XKM.id as string, [
      { id: "st-beta @ hst-fennec-02", kind: "replica", reachable: true },
      { id: "repo-northgate-memex history", kind: "carrier_history" },
      { id: "snap-A-20260908T0915Z", kind: "backup" },
      { id: "st-delta @ hst-orbit-09", kind: "uncontrolled_clone" },
      { id: "st-omega (never reconnects)", kind: "replica", reachable: false },
    ]);

    // E1: every location, with an honest status.
    const byId = Object.fromEntries(report.locations.map((l) => [l.id, l]));
    expect(byId["this replica"]?.status).toBe("purged");
    expect(byId["st-delta @ hst-orbit-09"]?.status).toBe("unknown"); // C5
    expect(byId["snap-A-20260908T0915Z"]?.status).toBe("not_erased");
    expect(byId["repo-northgate-memex history"]?.status).toBe("retention_obligation"); // E3
    // E4: the obligation against a replica that never reconnects stays OPEN.
    expect(byId["st-omega (never reconnects)"]?.status).toBe("pending");

    // E2/IC7: no unqualified global-deletion claim exists anywhere in the output,
    // and the flag that would carry one is a typed `false`.
    expect(report.global_erasure_claimed).toBe(false);
    const blob = JSON.stringify(report).toLowerCase();
    for (const claim of ["deleted everywhere", "fully erased", "removed from all copies", "erased everywhere"]) {
      expect(blob).not.toContain(claim);
    }
    expect(report.statement).toContain("are NOT erased".toLowerCase().replace("not", "NOT"));
    // ...and the open obligation is on the observability surface too (R20).
    expect((await store.exchangeStatus()).gaps.some((g) => g.kind === "open_erasure_obligation")).toBe(true);
    store.close();
  });

  it("purge is refused on a record that was never tombstoned — the semantic delete propagates, the local act does not", async () => {
    const w = c20World();
    const f = fixture(w);
    const store = await replica(w, [...f.infra, ...f.seed]);
    const attempt = await store.purge(f.rec5CQP.id as string);
    expect(attempt.purged).toBe(false);
    expect(attempt.reason).toContain("tombstoned");
    expect((await store.get(f.rec5CQP.id as string))?.body).not.toEqual({});
    store.close();
  });

  it("forget removes only the local projection row; a rebuild brings the record back", async () => {
    const w = c20World();
    const f = fixture(w);
    const dir = tempDir("c20-forget");
    const store = await replica(w, [...f.infra, ...f.seed], dir);
    expect(store.forget(f.rec5CQP.id as string).forgotten).toBe(true);
    expect(await store.get(f.rec5CQP.id as string)).toBeNull();
    expect((await store.events({})).some((e) => e.id === f.rec5CQP.id)).toBe(true); // the EVENT stayed
    await store.rebuild();
    expect(await store.get(f.rec5CQP.id as string)).not.toBeNull(); // forgetting is not deleting
    expect(store.localErasures(f.rec5CQP.id as string).map((e) => e.op)).toEqual(["forget"]);
    store.close();
  });
});

describe("C20 — not covered here", () => {
  it.todo(
    "C20 B4 (a contributor outside the record's scope sees NOTHING for a purged record — not even the identifier): this store filters by SCOPE, not by reading principal. Per-principal authorization of a read is lane 04's retrieval surface; the scope half is proved by the C22 N01 and C17 A21 assertions.",
  );
  it.todo(
    "C20 A4 across embeddings, rerank caches and summary artifacts: this store has no derived text artifacts. When lane 04 adds them, each becomes its own probe — the case requires each derived path to be probed separately, not as a group.",
  );
  it.todo(
    "C20 C1 per-destination receipt booleans for a partitioned replica: the producer's outbox records per-transport state, but 'queued for st-beta specifically' needs the membership-aware fan-out the exchange does not yet model (one carrier, many consumers).",
  );
});
