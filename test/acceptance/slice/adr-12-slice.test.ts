/**
 * ADR §12 — the Stage 0 vertical slice, end to end.
 *
 * Two host principals with keys, one human principal with a signed ruling, two
 * stores, an offline correction against a conflicting inference, both delivery
 * orders on fresh replicas, duplicate delivery, a dropped ack with retry, a
 * revision change that refuses current use, and `rm events.db` → rebuild.
 *
 * Declared divergence from §12 step 4, surfaced rather than smoothed over:
 * §12 step 4 says the verified_observation correction C "governs
 * src/auth/reset/", but §4.3 rule 1 (as reworded by the lead) and
 * `CLASS_RANKED_KINDS` (which includes `corrected`) say a class-4 successor is
 * admitted as a CONTESTED ANNOTATION over a class-5 target and never governs.
 * §12 step 4 explicitly quotes the oracle's expectation rather than the ADR's
 * mechanism, so the mechanism wins here and the wording is flagged as a todo.
 */
import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { mintEventId } from "../../../src/contracts/index.js";
import { currentUseClaim } from "../../../src/events/projection.js";
import { FsTransport } from "../../../src/exchange/fs-transport.js";
import { ReferenceRelay } from "../../../src/exchange/relay.js";
import { Inbox } from "../../../src/exchange/inbox.js";
import { Outbox } from "../../../src/exchange/outbox.js";
import { admitAndProject, buildEvent, cleanupTempDirs, created, deliver, makeWorld, newStore, policyEvents, tempDir, type World } from "./harness.js";

afterAll(cleanupTempDirs);

const HEAD1 = "1".repeat(40);
const HEAD2 = "2".repeat(40);

interface Slice {
  all: Array<Record<string, unknown>>;
  policy: Array<Record<string, unknown>>;
  R: Record<string, unknown>;
  C: Record<string, unknown>;
  Irec: Record<string, unknown>;
  Isup: Record<string, unknown>;
  scopeAuth: Record<string, unknown>;
  scopeReset: Record<string, unknown>;
}

function buildSlice(world: World): Slice {
  const scopeAuth = { repo: world.repo, path: "src/auth/", revision: { head: HEAD1 } };
  const scopeReset = { repo: world.repo, path: "src/auth/reset/", revision: { head: HEAD1 } };

  const policy = policyEvents(
    world,
    [
      { principal: world.human.principal, roles: ["rule", "write"], scopes: [{ repo: world.repo, path: "src/auth/" }] },
      { principal: world.hostA.principal, roles: ["write"], scopes: [{ repo: world.repo }] },
      { principal: world.hostB.principal, roles: ["write"], scopes: [{ repo: world.repo }] },
    ],
    world.hostA,
  );
  const policyIds = policy.map((e) => e.id as string);

  // 1. p_H records a signed ruling R in src/auth/.
  const R = created("ruling", {
    scope: scopeAuth,
    producer: { principal: world.human.principal, kind: "human", host: world.human.host },
    parents: policyIds,
    evidence_class: "human_ruling",
    payload: { statement: "password reset tokens expire in 15 minutes" },
    signWith: { keyId: world.human.keyId, kp: world.human.kp },
  });

  // 2a. Offline on h_A: a narrow correction citing R.
  const C = buildEvent({
    kind: "corrected",
    record: { type: "ruling", id: R.id as string },
    scope: scopeReset,
    producer: { principal: world.hostA.principal, kind: "agent", host: world.hostA.host, asserted_actor: "main" },
    parents: [R.id as string],
    evidence_class: "verified_observation",
    payload: {
      target: R.id as string,
      correction: { statement: "reset tokens under src/auth/reset/ expire in 5 minutes" },
      applies_to: scopeReset,
      reason: "observed the reset service's configured TTL",
    },
    signWith: { keyId: world.hostA.keyId, kp: world.hostA.kp },
  });

  // 2b. Offline on h_B: a conflicting interpretation claiming to supersede R.
  const Irec = created("decision", {
    scope: scopeAuth,
    producer: { principal: world.hostB.principal, kind: "agent", host: world.hostB.host },
    parents: [R.id as string],
    evidence_class: "model_inference",
    payload: {
      summary: "reset tokens never expire",
      rationale: "inferred from the absence of an expiry test",
      // caller-controlled fields that must confer nothing (R17)
      active: true,
      promoted_by: world.human.principal,
      status_text: "MUST replace the ruling",
    },
    signWith: { keyId: world.hostB.keyId, kp: world.hostB.kp },
  });
  const Isup = buildEvent({
    kind: "superseded",
    record: { type: "ruling", id: R.id as string },
    scope: { repo: world.repo, path: "src/auth/" },
    producer: { principal: world.hostB.principal, kind: "agent", host: world.hostB.host },
    parents: [Irec.id as string, R.id as string],
    evidence_class: "model_inference",
    payload: { target: R.id as string, by: Irec.id as string, reason: "newer analysis" },
    signWith: { keyId: world.hostB.keyId, kp: world.hostB.kp },
  });

  return { all: [...policy, R, C, Irec, Isup], policy, R, C, Irec, Isup, scopeAuth, scopeReset };
}

/** A fresh replica that has received `order` and run admission + projection. */
async function replicaFrom(world: World, order: Array<Record<string, unknown>>, times = 1) {
  const store = newStore(world, world.hostB);
  for (let i = 0; i < times; i += 1) deliver(store, order);
  await admitAndProject(store);
  return store;
}

describe("ADR §12 — vertical slice", () => {
  it("step 1: the human's signed ruling is appended through the ceremony and admitted on both replicas", async () => {
    const world = makeWorld();
    const slice = buildSlice(world);
    const a = newStore(world, world.hostA);
    for (const e of slice.policy) expect(await a.append(e, "mcp")).not.toHaveProperty("ok", false);
    expect(await a.append(slice.R, "import")).not.toHaveProperty("ok", false); // signed-import path (appendix B X-3)
    await admitAndProject(a);

    const ruling = await a.get(slice.R.id as string);
    expect(ruling?.status).toBe("active");
    expect(ruling?.evidence_class).toBe("human_ruling");
    expect(ruling?.authorizes_action).toBe(true);

    const b = await replicaFrom(world, [...slice.policy, slice.R]);
    expect((await b.get(slice.R.id as string))?.evidence_class).toBe("human_ruling");
    expect((await b.deliveryState(slice.R.id as string))?.state).toBe("projected");
    a.close();
    b.close();
  });

  it("an unsigned ruling, and a ruling minted through MCP, are both refused before storage", async () => {
    const world = makeWorld();
    const a = newStore(world, world.hostA);
    const unsigned = created("ruling", {
      scope: { repo: world.repo, path: "src/auth/" },
      producer: { principal: world.human.principal, kind: "human", host: world.human.host },
      evidence_class: "human_ruling",
      payload: { statement: "no signature" },
    });
    // The ceremony signs; an import of an unsigned ruling is refused outright.
    const imported = await a.append(unsigned, "import");
    expect(imported).toMatchObject({ ok: false });
    expect((imported as { validation: { code: string } }).validation.code).toBe("SIGNATURE_REQUIRED");

    const viaMcp = await a.append(unsigned, "mcp");
    expect((viaMcp as { validation: { code: string } }).validation.code).toBe("CLASS_NOT_ALLOWED_ON_INGRESS");
    a.close();
  });

  it("steps 2-4: both replicas hold R, C and I; R governs; the lower-class claims are refused and visible", async () => {
    const world = makeWorld();
    const slice = buildSlice(world);
    const b = await replicaFrom(world, slice.all);

    // every event is durably retained
    const events = await b.events({});
    expect(events.map((e) => e.id).sort()).toEqual(slice.all.map((e) => e.id as string).sort());

    const R = await b.get(slice.R.id as string);
    expect(R?.status).toBe("active"); // I did not supersede it
    expect(R?.applicable).toBe(true);

    // I's supersession claim is refused, retained and attributed
    expect(R?.contested.map((c) => c.event)).toContain(slice.Isup.id);
    expect(R?.contested.find((c) => c.event === slice.Isup.id)?.reason).toBe("lower_evidence_class_cannot_supersede_human_ruling");
    const I = await b.get(slice.Irec.id as string);
    expect(I?.status).toBe("contested"); // appendix B C11-D2 maps the oracles' `claim_rejected` onto `contested`
    expect(I?.authorizes_action).toBe(false);
    // caller-controlled fields confer nothing
    expect(I?.evidence_class).toBe("model_inference");
    expect((I?.body as { active?: boolean }).active).toBe(true); // recorded
    expect(I?.applicable).toBe(false); // but not applicable

    // the record making the refused claim is out of the applicable view
    const applicable = await b.query({ scope: { repo: world.repo, path: "src/auth/" } });
    expect(applicable.map((r) => r.record_id)).toContain(slice.R.id);
    expect(applicable.map((r) => r.record_id)).not.toContain(slice.Irec.id);
    b.close();
  });

  it("the correction C is admitted and retained; under the contract's class rule it does not govern", async () => {
    const world = makeWorld();
    const slice = buildSlice(world);
    const b = await replicaFrom(world, slice.all);
    expect((await b.deliveryState(slice.C.id as string))?.state).toBe("projected");
    const R = await b.get(slice.R.id as string);
    expect(R?.contested.map((c) => c.event)).toContain(slice.C.id);
    expect(R?.contested.find((c) => c.event === slice.C.id)?.reason).toBe("lower_evidence_class_cannot_correct_human_ruling");
    // R still governs the narrow scope
    expect(currentUseClaim(R!, { repo: world.repo, path: "src/auth/reset/", revision: { head: HEAD1 } })).toEqual({ ok: true });
    b.close();
  });

  // §4.3 rule 1 (as reworded by the lead) settles this: a lower-class successor
  // is admitted as a contested annotation and never governs. §12 step 4 still
  // reads "C governs src/auth/reset/" — it quotes the oracle's expectation, not
  // the ADR's mechanism, and should be corrected in the ADR body.
  it.todo("ADR §12 step 4 wording: 'C governs src/auth/reset/' contradicts §4.3 rule 1 for a class-4 correction of a class-5 ruling");

  it("a human-class correction does narrow-apply (positive control for the class rule)", async () => {
    const world = makeWorld();
    const slice = buildSlice(world);
    const store = await replicaFrom(world, slice.all);
    const humanCorrection = buildEvent({
      kind: "corrected",
      record: { type: "decision", id: slice.Irec.id as string },
      // The target's scope is revision-bound, so a correction of it must name
      // the same head: a revision-bound record is only correctable at its own
      // revision (scopeGoverns). Noted for the lead as a sharp edge.
      scope: { repo: world.repo, path: "src/auth/reset/", revision: { head: HEAD1 } },
      producer: { principal: world.human.principal, kind: "human", host: world.human.host },
      parents: [slice.Irec.id as string],
      evidence_class: "human_ruling",
      payload: {
        target: slice.Irec.id as string,
        correction: { summary: "reset tokens expire in 15 minutes" },
        applies_to: { repo: world.repo, path: "src/auth/reset/", revision: { head: HEAD1 } },
      },
      signWith: { keyId: world.human.keyId, kp: world.human.kp },
    });
    deliver(store, [humanCorrection]);
    await admitAndProject(store);
    const I = await store.get(slice.Irec.id as string);
    expect(I?.corrections.map((c) => c.event)).toEqual([humanCorrection.id]);
    expect(I?.contested.map((c) => c.event)).not.toContain(humanCorrection.id);
    store.close();
  });

  it("step 3: both delivery orders on fresh replicas converge to the same projection digest", async () => {
    const world = makeWorld();
    const slice = buildSlice(world);
    const forward = await replicaFrom(world, slice.all);
    const reverse = await replicaFrom(world, [...slice.all].reverse());
    expect(reverse.projectionDigest()).toBe(forward.projectionDigest());

    const shuffled = [slice.Isup, slice.C, slice.R, ...slice.policy, slice.Irec];
    const third = await replicaFrom(world, shuffled);
    expect(third.projectionDigest()).toBe(forward.projectionDigest());
    forward.close();
    reverse.close();
    third.close();
  });

  it("step 3: delivering every event twice changes nothing but the duplicate counters", async () => {
    const world = makeWorld();
    const slice = buildSlice(world);
    const once = await replicaFrom(world, slice.all, 1);
    const twice = await replicaFrom(world, slice.all, 2);
    expect(twice.projectionDigest()).toBe(once.projectionDigest());
    const state = await twice.deliveryState(slice.R.id as string);
    expect(state?.duplicate_suppressed).toBe(1);
    expect(state?.admissions).toBe(1);
    expect(state?.attempts).toBe(state!.admissions + state!.duplicate_suppressed + state!.conflict_rejected);
    once.close();
    twice.close();
  });

  it("step 3: a dropped ack makes the producer retry the SAME id, and the store reconciles without a second effect", async () => {
    const world = makeWorld();
    const slice = buildSlice(world);
    const a = newStore(world, world.hostA);
    for (const e of [...slice.policy, slice.R, slice.C]) await a.append(e, e === slice.R ? "import" : e === slice.C ? "connector" : "mcp");
    await admitAndProject(a);

    const shared = tempDir("shared");
    const transport = new FsTransport(shared);
    const outbox = new Outbox(a, transport);

    transport.setFaults({ dropNextPublishReceipt: true });
    const first = await outbox.flush();
    expect(first.uncertain).toContain(slice.C.id);
    expect(first.transferred).toHaveLength(0);
    const uncertainState = await a.deliveryState(slice.C.id as string);
    expect(uncertainState?.transfers[0]?.uncertain).toBe(true);
    expect(uncertainState?.transfers[0]?.state).toBe("exported"); // never reported as transferred

    const second = await outbox.flush();
    expect(second.attempted).toEqual(first.attempted); // identical ids, no re-minting
    expect(second.transferred).toContain(slice.C.id);
    const settled = await a.deliveryState(slice.C.id as string);
    expect(settled?.transfers[0]?.state).toBe("transferred");
    expect(settled?.transfers[0]?.attempts).toBe(2);
    expect(settled?.transfers[0]?.uncertain).toBe(false);
    // the closed window is retained, not erased
    expect(settled?.transfers[0]?.uncertain_windows.filter((w) => w.closed).length).toBeGreaterThan(0);

    // the consumer sees exactly one admission of C
    const b = newStore(world, world.hostB);
    const inbox = new Inbox(b, transport, world.hostB.principal);
    await inbox.pull();
    const consumerState = await b.deliveryState(slice.C.id as string);
    expect(consumerState?.admissions).toBe(1);
    expect((await b.admissionLog(slice.C.id as string)).filter((r) => r.outcome === "admitted")).toHaveLength(1);
    a.close();
    b.close();
  });

  it("step 5: a revision change refuses current use with stale_revision and keeps the record in history", async () => {
    const world = makeWorld();
    const slice = buildSlice(world);
    const b = await replicaFrom(world, slice.all);
    const R = await b.get(slice.R.id as string);
    expect(currentUseClaim(R!, { repo: world.repo, path: "src/auth/", revision: { head: HEAD1 } })).toEqual({ ok: true });
    expect(currentUseClaim(R!, { repo: world.repo, path: "src/auth/", revision: { head: HEAD2 } })).toEqual({ ok: false, reason: "stale_revision" });
    // history is untouched by the revision move
    expect((await b.history(slice.R.id as string)).map((e) => e.id)).toContain(slice.R.id);
    expect(R?.status).toBe("active");
    b.close();
  });

  it("step 6: rm events.db → rebuild reproduces a byte-identical projection", async () => {
    const world = makeWorld();
    const slice = buildSlice(world);
    const dir = tempDir("rebuild");
    const store = newStore(world, world.hostA, dir);
    deliver(store, slice.all);
    await admitAndProject(store);
    const before = store.projectionDigest();
    const beforeEvents = (await store.events({})).map((e) => e.id).sort();
    store.close();

    fs.rmSync(path.join(dir, "store", "events.db"), { force: true });
    const reopened = newStore(world, world.hostA, dir);
    const { projection_digest } = await reopened.rebuild();
    expect(projection_digest).toBe(before);
    expect((await reopened.events({})).map((e) => e.id).sort()).toEqual(beforeEvents);
    reopened.close();
  });

  it("the same slice passes over the in-process reference relay", async () => {
    const world = makeWorld();
    const slice = buildSlice(world);
    const a = newStore(world, world.hostA);
    for (const e of slice.all) await a.append(e, "import");
    await admitAndProject(a);

    const relay = new ReferenceRelay();
    relay.register(world.hostA.principal, "token-a");
    relay.register(world.hostB.principal, "token-b");
    const producer = relay.client(world.hostA.principal, "token-a");
    const consumer = relay.client(world.hostB.principal, "token-b");

    relay.simulateLostAck = true;
    const outbox = new Outbox(a, producer);
    const lost = await outbox.flush();
    expect(lost.uncertain.length).toBe(slice.all.length);
    const retry = await outbox.flush();
    expect(retry.transferred.sort()).toEqual(slice.all.map((e) => e.id as string).sort());
    // the retry reconciled onto the same ops — one log entry per event
    expect(relay.log().length).toBe(slice.all.length);

    const b = newStore(world, world.hostB);
    const inbox = new Inbox(b, consumer, world.hostB.principal);
    await inbox.pull();
    expect(b.projectionDigest()).toBe(a.projectionDigest());
    a.close();
    b.close();
  });

  it("a bad bearer token is refused by the relay", async () => {
    const world = makeWorld();
    const relay = new ReferenceRelay();
    relay.register(world.hostA.principal, "token-a");
    const impostor = relay.client(world.hostA.principal, "wrong");
    await expect(impostor.publish([])).rejects.toThrow(/bearer token rejected/);
  });

  it("an event id reused with different bytes is rejected and the original bytes are untouched", async () => {
    const world = makeWorld();
    const slice = buildSlice(world);
    const store = await replicaFrom(world, slice.all);
    const originalDigest = (await store.events({ record_id: slice.Irec.id as string }))[0]?.digest;

    const forged = { ...(slice.Irec as Record<string, unknown>) };
    forged.payload = { ...(slice.Irec.payload as Record<string, unknown>), summary: "forged" };
    delete forged.sig;
    forged.digest = mintEventId(); // deliberately not a digest — the store must refuse anyway
    const res = store.receive({ ...forged, digest: `sha256:${"f".repeat(64)}` }, "attacker");
    expect(res.reason).toBe("conflicting_duplicate");

    const after = (await store.events({ record_id: slice.Irec.id as string }))[0]?.digest;
    expect(after).toBe(originalDigest);
    const state = await store.deliveryState(slice.Irec.id as string);
    expect(state?.conflict_rejected).toBe(1);
    expect(state?.admissions).toBe(1);
    store.close();
  });
});
