/**
 * MERGE-TIME REGRESSION (lanes 02b + 02c): admission is monotonic.
 *
 * `rule`/`write` capability is judged against the membership projected from an
 * event's causal ANCESTORS, and when an event has no policy ancestor the check
 * falls back to a question about the REPLICA ("do I hold a policy at all?") so
 * that a bootstrapping store can acquire its first membership. That fallback
 * reads present state, not the event's ancestry, so without care its answer
 * changes the moment a policy arrives — and the next rebuild re-answers the
 * question the other way for every event already admitted under the
 * policy-free regime.
 *
 * That is how merging lane 02c onto lane 02b wiped a migrated store: 45
 * admitted legacy events became `no_policy_yet` / `pending_parents` on rebuild
 * and the projection digest stopped reproducing, against ADR §12 step 6.
 * C21 A-REC-10 catches it end to end; this pins the mechanism directly.
 */
import { afterAll, describe, expect, it } from "vitest";

import { admitAndProject, cleanupTempDirs, created, makeWorld, newStore, policyEvents } from "./harness.js";

afterAll(cleanupTempDirs);

const SCOPE = "src/catalog/";

describe("admission is monotonic for what this replica already admitted", () => {
  it("a policy admitted LATER does not retroactively quarantine earlier events on rebuild", async () => {
    const world = makeWorld();
    const store = newStore(world, world.hostA);
    try {
      // 1. A policy-free store admits ordinary writes (the bootstrap regime).
      const early = [1, 2, 3].map((n) =>
        created("decision", {
          scope: { repo: world.repo, path: SCOPE },
          producer: { principal: world.hostA.principal, kind: "agent", host: world.hostA.host },
          evidence_class: "proposal",
          payload: { summary: `pre-policy decision ${n}`, rationale: "written before this store had a policy" },
          signWith: { keyId: world.hostA.keyId, kp: world.hostA.kp },
        }),
      );
      for (const e of early) store.receive(e, "direct");
      await admitAndProject(store);

      const admittedEarly = (await store.events({})).map((e) => e.id);
      for (const e of early) expect(admittedEarly, `${e.id as string} admitted before any policy`).toContain(e.id);
      const digestBefore = store.projectionDigest();

      // 2. The store LATER acquires its first membership policy. The earlier
      //    events do not descend from it and never can — they are already
      //    written, and `parents` is part of their digest.
      const policy = policyEvents(
        world,
        [{ principal: world.hostA.principal, roles: ["read", "propose", "write"], scopes: [{ repo: world.repo }] }],
        world.hostA,
      );
      for (const e of policy) store.receive(e, "direct");
      await admitAndProject(store);

      // The live view still holds everything it acknowledged.
      const afterPolicy = (await store.events({})).map((e) => e.id);
      for (const e of early) expect(afterPolicy, `${e.id as string} survives the policy's arrival`).toContain(e.id);

      // 3. THE PROPERTY: a rebuild reproduces the same projection. It must not
      //    re-answer the bootstrap question against the events it already
      //    admitted (C14 N1/N2/N3 — never silently revoke what was admitted).
      const rebuilt = await store.rebuild();
      expect(rebuilt.acknowledged_events_lost, `lost: ${JSON.stringify(rebuilt.lost)}`).toBe(0);
      expect(rebuilt.lost).toEqual([]);

      const afterRebuild = (await store.events({})).map((e) => e.id);
      for (const e of early) expect(afterRebuild, `${e.id as string} survives rebuild`).toContain(e.id);
      for (const id of admittedEarly) expect(afterRebuild).toContain(id);

      // The projection over the pre-policy records is unchanged by the rebuild.
      expect(store.projectionDigest()).toBe((await store.rebuild()).projection_digest);
      expect(digestBefore).not.toBe(""); // the fixture actually projected something
    } finally {
      store.close();
    }
  });

  it("still quarantines no_policy_yet for an event this replica has never admitted", async () => {
    const world = makeWorld();
    const store = newStore(world, world.hostA);
    try {
      const policy = policyEvents(
        world,
        [{ principal: world.hostA.principal, roles: ["read", "propose", "write"], scopes: [{ repo: world.repo }] }],
        world.hostA,
      );
      for (const e of policy) store.receive(e, "direct");
      await admitAndProject(store);

      // A brand-new event citing no policy, on a store that holds one: this is
      // the case the ancestry rule exists for, and nothing above may relax it.
      // Same producer the policy grants, so the ONLY question left is ancestry.
      const stranger = created("decision", {
        scope: { repo: world.repo, path: SCOPE },
        producer: { principal: world.hostA.principal, kind: "agent", host: world.hostA.host },
        evidence_class: "proposal",
        payload: { summary: "cites no policy", rationale: "arrives after the policy exists" },
        signWith: { keyId: world.hostA.keyId, kp: world.hostA.kp },
      });
      store.receive(stranger, "direct");
      await admitAndProject(store);

      const state = await store.deliveryState(stranger.id as string);
      expect(state!.state).toBe("quarantined");
      expect(state!.reason).toBe("no_policy_yet");
    } finally {
      store.close();
    }
  });
});
