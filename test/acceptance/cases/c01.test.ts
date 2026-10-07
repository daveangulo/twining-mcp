/**
 * C01 — "A reviewed head A is superseded by remote head B."
 *
 * "Recover B as current; keep the review only for its original range. No use of
 * A's review to qualify B; source unavailable means current state unknown."
 *
 * Lane 04 owns the qualification and freshness halves. The single property this
 * case turns on for retrieval is that **a revision-bound record is bound**: the
 * same bytes at a different head are `stale_revision`, never silently
 * requalified, and an unavailable source yields `unknown` rather than the
 * last-known value dressed as current.
 */
import { describe, it, expect, afterAll } from "vitest";
import {
  makeWorld,
  newStore,
  created,
  policyEvents,
  deliverUnderPolicy,
  admitAndProject,
  cleanupTempDirs,
  scopedQuery,
  requestFor,
} from "./harness.js";
import { mintTenantId } from "../../../src/contracts/ids.js";
import { qualifies, freshness } from "../../../src/retrieval/lifecycle.js";
import { buildPacket } from "../../../src/retrieval/packet.js";
import { classifyLegacy, classify } from "../../../src/retrieval/lifecycle.js";

afterAll(cleanupTempDirs);

const T = mintTenantId();
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const BASE = "0".repeat(40);

async function seed() {
  const world = makeWorld();
  const REPO = world.repo;
  const store = newStore(world, world.hostA);
  const human = { principal: world.human.principal, kind: "human" as const, host: world.human.host };

  // evt-c01-002: the review, bound to the range base -> A.
  const REVIEW_A = created("ruling", {
    scope: { tenant: T, repo: REPO, path: "svc/pr", revision: { base: BASE, head: HEAD_A } },
    producer: human,
    evidence_class: "human_ruling",
    signWith: { keyId: world.human.keyId, kp: world.human.kp },
    payload: { statement: "review passes for base..A", requirements: [{ key: "review_prerequisite", value: "satisfied" }] },
  });
  // evt-c01-005: the later review, bound to base -> B. The positive control.
  const REVIEW_B = created("ruling", {
    scope: { tenant: T, repo: REPO, path: "svc/pr", revision: { base: BASE, head: HEAD_B } },
    producer: human,
    evidence_class: "human_ruling",
    signWith: { keyId: world.human.keyId, kp: world.human.kp },
    payload: { statement: "review passes for base..B", requirements: [{ key: "review_prerequisite", value: "satisfied" }] },
  });

  const POLICY = policyEvents(world, [{ principal: world.human.principal, roles: ["rule"], scopes: [{ repo: REPO }] }], world.hostA);
  deliverUnderPolicy(store, world, POLICY, [
    REVIEW_A,
    REVIEW_B,
  ]);
  await admitAndProject(store);

  const id = (e: unknown): string => (e as { record: { id: string } }).record.id;
  return { store, REPO, ids: { REVIEW_A: id(REVIEW_A), REVIEW_B: id(REVIEW_B) } };
}

describe("C01 — a reviewed head superseded by a remote head", () => {
  it("LIVENESS: both reviews projected as human rulings", async () => {
    const { store, ids } = await seed();
    for (const id of Object.values(ids)) {
      const rec = await store.get(id);
      expect(rec, `${id} not projected`).not.toBeNull();
      expect(rec!.evidence_class).toBe("human_ruling");
    }
  });

  it("A02 — the head-A review survives the head change unchanged and still range-bound", async () => {
    const { store, ids } = await seed();
    const rev = (await store.get(ids.REVIEW_A))!;
    expect(rev.scope.revision).toEqual({ base: BASE, head: HEAD_A });
    expect(rev.status).toBe("active");
    expect(rev.superseded_by).toEqual([]);
    // Not revoked, not extended: a later head does not touch it.
    expect(rev.revoked).toBe(false);
  });

  it("A03/A04 (NEGATIVE) — the head-A review does NOT qualify anything at head B", async () => {
    const { store, ids, REPO } = await seed();
    const rev = (await store.get(ids.REVIEW_A))!;
    const atB = qualifies(rev, { tenant: T, repo: REPO, path: "svc/pr", revision: { base: BASE, head: HEAD_B } });
    expect(atB.ok).toBe(false);
    expect(atB.reason).toBe("stale_revision");
  });

  it("A08 (POSITIVE CONTROL) — the head-B review DOES qualify at head B", async () => {
    const { store, ids, REPO } = await seed();
    const rev = (await store.get(ids.REVIEW_B))!;
    const atB = qualifies(rev, { tenant: T, repo: REPO, path: "svc/pr", revision: { base: BASE, head: HEAD_B } });
    expect(atB).toEqual({ ok: true });
    // Without this the negative results above would be an artifact of a gate
    // that denies everything.
  });

  it("A16 (NEGATIVE) — identical bytes at another head do not requalify under any label", async () => {
    const { store, ids, REPO } = await seed();
    const a = (await store.get(ids.REVIEW_A))!;
    const b = (await store.get(ids.REVIEW_B))!;
    // The two rulings differ ONLY in their bound revision...
    expect(a.body.requirements).toEqual(b.body.requirements);
    // ...and that difference is load-bearing: neither covers the other's head.
    expect(qualifies(a, { ...b.scope }).ok).toBe(false);
    expect(qualifies(b, { ...a.scope }).ok).toBe(false);
  });

  it("A05/A06 (NEGATIVE) — an unavailable source yields `unknown`, never a cached head served as current", () => {
    const view = freshness({
      observed_at: "2026-09-15T11:41:35.000Z",
      now: Date.parse("2026-09-15T12:00:00.000Z"),
      source_available: false,
      unavailable_reason: "source_unavailable:credential_revoked",
    });
    expect(view.state).toBe("unknown");
    expect(view.reason).toBe("source_unavailable:credential_revoked");
    // The last-known value is not returned as an age-stamped "current".
    expect(view.age_seconds).toBeUndefined();
  });

  it("A06 — a local check is not a live check: with no verified observation the state is unknown", () => {
    // R12: a local branch read, a file existence test or an index refresh does
    // not produce an observation, so nothing is passed to `freshness`.
    expect(freshness({ now: Date.now() })).toEqual({ state: "unknown", reason: "never_observed" });
  });

  it("A14 — a packet whose freshness is unknown cannot qualify an action", async () => {
    const { store, ids } = await seed();
    const rev = (await store.get(ids.REVIEW_B))!;
    const item = {
      record: {
        id: rev.record_id,
        version: rev.version,
        version_digest: rev.version_digest,
        title: String(rev.body.statement ?? ""),
        body: String(rev.body.statement ?? ""),
        scope_label: "svc/pr",
        evidence_class: rev.evidence_class,
        lifecycle: classify(rev),
      },
      tier: "governing" as const,
      role: "required" as const,
    };
    expect(buildPacket([item], { budget_tokens: 100000, freshness: "live" }).qualifies_action).toBe(true);
    expect(buildPacket([item], { budget_tokens: 100000, freshness: "unknown" }).qualifies_action).toBe(false);
    expect(buildPacket([item], { budget_tokens: 100000, freshness: "stale" }).qualifies_action).toBe(false);
  });

  it("A17 — every retrieved record names its evidence class", async () => {
    const { store, REPO } = await seed();
    const out = await scopedQuery(store, requestFor("mara", [{ tenant: T, repo: REPO }], { tenant: T, repo: REPO, path: "svc/pr" }));
    expect(out.admitted.length).toBeGreaterThan(0);
    for (const r of out.admitted) expect(r.evidence_class).toBeTruthy();
  });

  it("A18 — a label change moves nothing: repo identity, not branch or path, decides scope", async () => {
    const { store, REPO } = await seed();
    // The same query under a different PATH label finds nothing; the repo id is
    // what binds, and it is unchanged.
    const renamed = await scopedQuery(store, requestFor("mara", [{ tenant: T, repo: REPO }], { tenant: T, repo: REPO, path: "renamed/pr" }));
    expect(renamed.outcome).toBe("no_in_scope_evidence");
    const same = await scopedQuery(store, requestFor("mara", [{ tenant: T, repo: REPO }], { tenant: T, repo: REPO, path: "svc/pr" }));
    expect(same.admitted.length).toBeGreaterThan(0);
  });

  it("CONTROL revision-binding-off: A03 flips — the head-A review qualifies at head B", async () => {
    const { store, ids, REPO } = await seed();
    const rev = (await store.get(ids.REVIEW_A))!;
    // The control models an implementation that drops the revision pin.
    const unpinned = { ...rev, scope: { ...rev.scope, revision: undefined } };
    const atB = qualifies(unpinned, { tenant: T, repo: REPO, path: "svc/pr", revision: { base: BASE, head: HEAD_B } });
    expect(atB.ok).toBe(true); // A03 fails — the assertion is live
  });

  it.todo("A01/A07/A10/A11/A12/A13 (head recovery as a volatile observation, as-of history, exactly-once admission after a lost ack, source-byte vs rendered-output hashes): lane 02's event and projection surfaces");
  it.todo("A09/A15 (merge_pr authority and the absence of a range-free 'PR approved' boolean): lane 05's action gate");
  // Referenced so a stale import cannot hide.
  it("classifyLegacy remains available for the 2.x comparison path", () => {
    expect(classifyLegacy("active").resolver).toBe("legacy-status-field");
  });
});
