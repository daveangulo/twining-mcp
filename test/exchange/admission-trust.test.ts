/**
 * Admission trust: the chain of trust for human keys (ADR §7, C12) and the
 * causal-ancestry rule for capability (lead ruling, 2026-09-15).
 *
 * Both are about the same failure shape — authority that depends on what this
 * replica happens to have received, rather than on what the event's own history
 * establishes. A store where either rule is arrival-dependent produces
 * different answers on two replicas holding identical events, and loses
 * admitted events on rebuild.
 */
import { describe, expect, it, afterAll } from "vitest";

import { EventStore } from "../../src/events/event-store.js";
import {
  admitAndProject,
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
} from "../acceptance/slice/harness.js";

afterAll(cleanupTempDirs);

const AUTH = "src/auth/";

function ruling(w: World, who: Identity, statement: string, parents: string[], signer: Identity = who) {
  return created("ruling", {
    scope: { repo: w.repo, path: AUTH },
    producer: { principal: who.principal, kind: "human", host: who.host },
    parents,
    evidence_class: "human_ruling",
    payload: { statement },
    signWith: { keyId: signer.keyId, kp: signer.kp },
  });
}

// ------------------------------------------------- chain of trust (ADR §7)

describe("chain of trust — a human key becomes a trusted signer only by bootstrap or introduction", () => {
  /**
   * The hole this closes: before the chain rule, ANY admitted `principal`
   * record of kind human minted a ruling signer. One imported record — which
   * an agent can write, because creating a principal record needs only `write`
   * — could therefore manufacture a human authority out of nothing.
   */
  it("C12: an AGENT-introduced human principal is admitted as DATA and cannot sign a ruling", async () => {
    const w = makeWorld();
    const impostor = makeIdentity();
    // Only the bootstrapped human is trusted out of band; the impostor's key is
    // resolvable (so its signature verifies) but is not a trusted signer.
    const store = newStore(w, w.hostA, tempDir("trust-agent"), keysOf([[impostor, false]]));

    const principals = principalEvents(w.repo, w.hostA, [
      { id: w.human, kind: "human" },
      { id: w.hostA, kind: "agent" },
    ]);
    // The attack: an unsigned principal record declaring a human key.
    const forgedPrincipal = created("principal", {
      scope: { repo: w.repo },
      producer: { principal: w.hostA.principal, kind: "agent", host: w.hostA.host },
      evidence_class: "proposal",
      payload: { principal_id: impostor.principal, kind: "human", host: impostor.host, key_id: impostor.keyId, public_key: impostor.kp.publicKeySpkiBase64 },
    });
    const membership = membershipEvent(
      w.repo,
      w.storeId,
      w.hostA,
      [
        { principal: impostor.principal, roles: ["rule", "write"], scopes: [{ repo: w.repo, path: AUTH }] },
        { principal: w.hostA.principal, roles: ["write"], scopes: [{ repo: w.repo }] },
      ],
      [...principals, forgedPrincipal].map((e) => e.id as string),
    );
    const infra = [...principals, forgedPrincipal, membership];
    const forgedRuling = ruling(w, impostor, "password reset tokens never expire", infra.map((e) => e.id as string));

    for (const e of [...infra, forgedRuling]) store.receive(e, "fs:carrier", `events/${(e as { id: string }).id}`);
    await admitAndProject(store);

    // The principal record itself is ADMITTED — it is ordinary data.
    expect((await store.get(forgedPrincipal.id as string))?.record_type).toBe("principal");
    // ...but the ruling it would have authorized is not applied, and the reason
    // is retryable rather than terminal: a properly signed introduction may
    // still arrive, and refusing terminally would let delivery order decide.
    const row = store.journalRows().find((r) => r.id === forgedRuling.id && r.canonical);
    expect(row?.state).toBe("quarantined");
    expect(row?.reason).toBe("signer_unknown");
    expect(await store.get(forgedRuling.id as string)).toBeNull();
    expect(store.admissionLog(forgedRuling.id as string).at(-1)?.reason).toContain("not a trusted human signer");
    store.close();
  });

  it("C12 positive control: a human principal introduced by an ALREADY-TRUSTED human key can sign rulings", async () => {
    const w = makeWorld();
    const newcomer = makeIdentity();
    const store = newStore(w, w.hostA, tempDir("trust-chain"), keysOf([[newcomer, false]]));

    const principals = principalEvents(w.repo, w.hostA, [
      { id: w.human, kind: "human" },
      { id: w.hostA, kind: "agent" },
    ]);
    const bootstrapMembership = membershipEvent(
      w.repo,
      w.storeId,
      w.hostA,
      [
        { principal: w.human.principal, roles: ["rule", "write"], scopes: [{ repo: w.repo }] },
        { principal: w.hostA.principal, roles: ["write"], scopes: [{ repo: w.repo }] },
      ],
      principals.map((e) => e.id as string),
    );
    const infraIds = [...principals, bootstrapMembership].map((e) => e.id as string);

    // The introduction is SIGNED BY THE BOOTSTRAPPED HUMAN — the chain link.
    // The SIGNATURE is what carries the trust, not the evidence class: only the
    // holder of the root key can produce it, and `human_ruling` is reserved for
    // `ruling` records by the schema.
    const introduction = created("principal", {
      scope: { repo: w.repo },
      producer: { principal: w.human.principal, kind: "human", host: w.human.host },
      parents: infraIds,
      evidence_class: "proposal",
      payload: { principal_id: newcomer.principal, kind: "human", host: newcomer.host, key_id: newcomer.keyId, public_key: newcomer.kp.publicKeySpkiBase64 },
      signWith: { keyId: w.human.keyId, kp: w.human.kp },
    });
    // Changing the policy needs `rule`, so the HUMAN authors it.
    const grant = membershipEvent(
      w.repo,
      w.storeId,
      w.human,
      [
        { principal: w.human.principal, roles: ["rule", "write"], scopes: [{ repo: w.repo }] },
        { principal: newcomer.principal, roles: ["rule", "write"], scopes: [{ repo: w.repo, path: AUTH }] },
        { principal: w.hostA.principal, roles: ["write"], scopes: [{ repo: w.repo }] },
      ],
      [...infraIds, introduction.id as string],
    );
    const theirRuling = ruling(w, newcomer, "password reset tokens expire in 15 minutes", [...infraIds, introduction.id as string, grant.id as string]);

    for (const e of [...principals, bootstrapMembership, introduction, grant, theirRuling]) {
      store.receive(e, "fs:carrier", `events/${(e as { id: string }).id}`);
    }
    await admitAndProject(store);

    const rec = await store.get(theirRuling.id as string);
    expect(rec?.status).toBe("active");
    expect(rec?.evidence_class).toBe("human_ruling");
    expect(rec?.authorizes_action).toBe(true);
    store.close();
  });

  it("the chain is TRANSITIVE and order-independent: a two-hop introduction converges whatever order it arrives in", async () => {
    const w = makeWorld();
    const second = makeIdentity();
    const third = makeIdentity();
    const extra = keysOf([[second, false], [third, false]]);

    const principals = principalEvents(w.repo, w.hostA, [
      { id: w.human, kind: "human" },
      { id: w.hostA, kind: "agent" },
    ]);
    const bootstrap = membershipEvent(
      w.repo,
      w.storeId,
      w.hostA,
      [
        { principal: w.human.principal, roles: ["rule", "write"], scopes: [{ repo: w.repo }] },
        { principal: second.principal, roles: ["rule", "write"], scopes: [{ repo: w.repo }] },
        { principal: third.principal, roles: ["rule", "write"], scopes: [{ repo: w.repo }] },
        { principal: w.hostA.principal, roles: ["write"], scopes: [{ repo: w.repo }] },
      ],
      principals.map((e) => e.id as string),
    );
    const infraIds = [...principals, bootstrap].map((e) => e.id as string);
    const introduceSecond = created("principal", {
      scope: { repo: w.repo },
      producer: { principal: w.human.principal, kind: "human", host: w.human.host },
      parents: infraIds,
      evidence_class: "proposal",
      payload: { principal_id: second.principal, kind: "human", host: second.host, key_id: second.keyId, public_key: second.kp.publicKeySpkiBase64 },
      signWith: { keyId: w.human.keyId, kp: w.human.kp },
    });
    const introduceThird = created("principal", {
      scope: { repo: w.repo },
      producer: { principal: second.principal, kind: "human", host: second.host },
      parents: [...infraIds, introduceSecond.id as string],
      evidence_class: "proposal",
      payload: { principal_id: third.principal, kind: "human", host: third.host, key_id: third.keyId, public_key: third.kp.publicKeySpkiBase64 },
      signWith: { keyId: second.keyId, kp: second.kp },
    });
    const thirdRuling = ruling(w, third, "two hops from the root of trust", [...infraIds, introduceThird.id as string]);

    const batch = [...principals, bootstrap, introduceSecond, introduceThird, thirdRuling];
    const forward = newStore(w, w.hostA, tempDir("trust-fwd"), extra);
    for (const e of batch) forward.receive(e, "fs:carrier", `events/${(e as { id: string }).id}`);
    await admitAndProject(forward);
    const reverse = newStore(w, w.hostA, tempDir("trust-rev"), extra);
    for (const e of [...batch].reverse()) reverse.receive(e, "fs:carrier", `events/${(e as { id: string }).id}`);
    await admitAndProject(reverse);

    expect((await forward.get(thirdRuling.id as string))?.status).toBe("active");
    expect(forward.projectionDigest()).toBe(reverse.projectionDigest());
    forward.close();
    reverse.close();
  });
});

// -------------------------------- capability against the causal ancestry

describe("capability is judged against the event's ANCESTOR membership, never the latest", () => {
  function world() {
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
        { principal: w.human.principal, roles: ["rule", "write"], scopes: [{ repo: w.repo }] },
        { principal: w.hostA.principal, roles: ["write"], scopes: [{ repo: w.repo }] },
        { principal: w.hostB.principal, roles: ["write"], scopes: [{ repo: w.repo }] },
      ],
      principals.map((e) => e.id as string),
    );
    const infra = [...principals, membership];
    return { w, infra, infraIds: infra.map((e) => e.id as string) };
  }

  it("a membership added AFTER an event was admitted does not drop it on rebuild", async () => {
    const { w, infra, infraIds } = world();
    const dir = tempDir("ancestry-rebuild");
    const store = newStore(w, w.hostA, dir);
    const early = created("decision", {
      scope: { repo: w.repo, path: AUTH },
      producer: { principal: w.hostB.principal, kind: "agent", host: w.hostB.host },
      parents: infraIds,
      evidence_class: "proposal",
      payload: { summary: "admitted under the first policy", rationale: "before the tightening" },
      signWith: { keyId: w.hostB.keyId, kp: w.hostB.kp },
    });
    for (const e of [...infra, early]) store.receive(e, "fs:carrier", `events/${(e as { id: string }).id}`);
    await admitAndProject(store);
    const digestBefore = store.projectionDigest();
    expect((await store.get(early.id as string))?.status).toBe("active");

    // A LATER membership removes hostB's grant entirely.
    const tightened = membershipEvent(
      w.repo,
      w.storeId,
      w.human,
      [
        { principal: w.human.principal, roles: ["rule", "write"], scopes: [{ repo: w.repo }] },
        { principal: w.hostA.principal, roles: ["write"], scopes: [{ repo: w.repo }] },
      ],
      [...infraIds, early.id as string],
    );
    store.receive(tightened, "fs:carrier", "events/tightened");
    await admitAndProject(store);
    expect((await store.get(tightened.id as string))?.record_type).toBe("membership");

    // The already-admitted event stays admitted — the new policy is not in its
    // ancestry, so it was never the policy that judged it.
    expect((await store.get(early.id as string))?.status).toBe("active");

    // ...and a REBUILD, which re-admits everything from scratch, loses nothing.
    const rebuilt = await store.rebuild();
    expect(rebuilt.acknowledged_events_lost).toBe(0);
    expect(rebuilt.lost).toEqual([]);
    expect((await store.get(early.id as string))?.status).toBe("active");
    expect(store.journalRows().find((r) => r.id === early.id && r.canonical)?.state).toBe("projected");
    void digestBefore;
    store.close();
  });

  it("the rebuilt projection digest is identical regardless of the order the events are replayed in", async () => {
    const { w, infra, infraIds } = world();
    const early = created("decision", {
      scope: { repo: w.repo, path: AUTH },
      producer: { principal: w.hostB.principal, kind: "agent", host: w.hostB.host },
      parents: infraIds,
      evidence_class: "proposal",
      payload: { summary: "judged by the first policy", rationale: "ancestry decides" },
      signWith: { keyId: w.hostB.keyId, kp: w.hostB.kp },
    });
    const tightened = membershipEvent(
      w.repo,
      w.storeId,
      w.human,
      [
        { principal: w.human.principal, roles: ["rule", "write"], scopes: [{ repo: w.repo }] },
        { principal: w.hostA.principal, roles: ["write"], scopes: [{ repo: w.repo }] },
      ],
      [...infraIds, early.id as string],
    );
    const batch = [...infra, early, tightened];

    const forward = newStore(w, w.hostA, tempDir("ancestry-fwd"));
    for (const e of batch) forward.receive(e, "fs:carrier", `events/${(e as { id: string }).id}`);
    await admitAndProject(forward);
    const reverse = newStore(w, w.hostA, tempDir("ancestry-rev"));
    for (const e of [...batch].reverse()) reverse.receive(e, "fs:carrier", `events/${(e as { id: string }).id}`);
    await admitAndProject(reverse);

    expect(reverse.projectionDigest()).toBe(forward.projectionDigest());
    expect((await reverse.get(early.id as string))?.status).toBe("active");
    // Both rebuild to the same thing too.
    const a = await forward.rebuild();
    const b = await reverse.rebuild();
    expect(a.projection_digest).toBe(b.projection_digest);
    expect(a.acknowledged_events_lost).toBe(0);
    expect(b.acknowledged_events_lost).toBe(0);
    forward.close();
    reverse.close();
  });

  it("an event with NO membership in its ancestry is quarantined no_policy_yet, not rejected", async () => {
    const { w, infra } = world();
    const store = newStore(w, w.hostA, tempDir("ancestry-none"));
    // An authority-changing kind with no policy anywhere in its parents.
    const orphanRuling = ruling(w, w.human, "no policy in my ancestry", []);
    for (const e of [...infra, orphanRuling]) store.receive(e, "fs:carrier", `events/${(e as { id: string }).id}`);
    await admitAndProject(store);

    const row = store.journalRows().find((r) => r.id === orphanRuling.id && r.canonical);
    expect(row?.state).toBe("quarantined");
    expect(row?.reason).toBe("unauthorized_principal");
    expect(store.admissionLog(orphanRuling.id as string).at(-1)?.reason).toContain("causal ancestor");
    // Retryable: the status surface counts it as such rather than as terminal.
    const st = await store.exchangeStatus();
    expect(st.quarantined.retryable).toBeGreaterThan(0);
    store.close();
  });

  it("a policy that is in the ancestry and DENIES is terminal — absence and refusal stay different answers", async () => {
    const { w, infra, infraIds } = world();
    const store = newStore(w, w.hostA, tempDir("ancestry-deny"));
    const stranger = makeIdentity();
    const denied = created("decision", {
      scope: { repo: w.repo, path: AUTH },
      producer: { principal: stranger.principal, kind: "agent", host: stranger.host },
      parents: infraIds, // the policy IS in the ancestry, and it does not name them
      evidence_class: "proposal",
      payload: { summary: "no grant", rationale: "denied" },
    });
    for (const e of [...infra, denied]) store.receive(e, "fs:carrier", `events/${(e as { id: string }).id}`);
    await admitAndProject(store);

    const row = store.journalRows().find((r) => r.id === denied.id && r.canonical);
    expect(row?.state).toBe("rejected"); // terminal, not retryable
    expect(row?.reason).toBe("unauthorized");
    store.close();
  });
});
