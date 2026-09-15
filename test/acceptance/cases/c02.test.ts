/**
 * C02 — "A broad publication grant replaces a narrower publication hold."
 *
 * "Recover the applicable grant and historical hold; allow only the granted
 * publication scope. No inferred merge or acceptance authority."
 *
 * Lane 04's half: retrieval must return BOTH the current grant and the
 * historical hold — the hold is not deleted by being superseded — and the grant
 * must not be read as conferring anything it does not say. A publication grant
 * is not merge authority; retrieval does not infer adjacent permissions from
 * an authority-shaped record.
 */
import { describe, it, expect, afterAll } from "vitest";
import {
  makeWorld,
  newStore,
  created,
  buildEvent,
  policyEvents,
  deliver,
  admitAndProject,
  cleanupTempDirs,
  scopedQuery,
  scopedHistory,
  requestFor,
} from "./harness.js";
import { mintTenantId, mintEventId } from "../../../src/contracts/ids.js";
import { classify, qualifies } from "../../../src/retrieval/lifecycle.js";

afterAll(cleanupTempDirs);

const T = mintTenantId();

async function seed() {
  const world = makeWorld();
  const REPO = world.repo;
  const store = newStore(world, world.hostA);
  const human = { principal: world.human.principal, kind: "human" as const, host: world.human.host };

  // The narrow HOLD, in force first.
  const HOLD = created("ruling", {
    scope: { tenant: T, repo: REPO, path: "docs/catalog" },
    producer: human,
    evidence_class: "human_ruling",
    signWith: { keyId: world.human.keyId, kp: world.human.kp },
    payload: {
      statement: "publication of docs/catalog is held pending review",
      requirements: [{ key: "publication", value: "held" }],
    },
  });
  // The broad GRANT that replaces it, scoped to docs/ — and to publication only.
  const GRANT = created("ruling", {
    scope: { tenant: T, repo: REPO, path: "docs" },
    producer: human,
    evidence_class: "human_ruling",
    signWith: { keyId: world.human.keyId, kp: world.human.kp },
    payload: {
      statement: "publication of docs/ is granted",
      requirements: [{ key: "publication", value: "granted" }],
    },
  });
  const holdId = (HOLD as unknown as { record: { id: string } }).record.id;
  const grantId = (GRANT as unknown as { record: { id: string } }).record.id;

  const SUPERSEDE = buildEvent({
    id: mintEventId(),
    kind: "superseded",
    record: { type: "ruling", id: holdId },
    scope: { tenant: T, repo: REPO, path: "docs/catalog" },
    producer: human,
    parents: [holdId, grantId],
    evidence_class: "human_ruling",
    signWith: { keyId: world.human.keyId, kp: world.human.kp },
    payload: { target: holdId, by: grantId, reason: "broad grant replaces the narrower hold" },
  });

  deliver(store, [
    ...policyEvents(world, [{ principal: world.human.principal, roles: ["rule"], scopes: [{ repo: REPO }] }], world.hostA),
    HOLD,
    GRANT,
    SUPERSEDE,
  ]);
  await admitAndProject(store);

  const READER = requestFor("reader", [{ tenant: T, repo: REPO }], { tenant: T, repo: REPO, path: "docs/catalog" });
  return { store, REPO, ids: { HOLD: holdId, GRANT: grantId }, READER };
}

describe("C02 — a broad grant replaces a narrower hold", () => {
  it("LIVENESS: both rulings projected and the supersession applied by the resolver", async () => {
    const { store, ids } = await seed();
    const hold = (await store.get(ids.HOLD))!;
    const grant = (await store.get(ids.GRANT))!;
    expect(hold).not.toBeNull();
    expect(grant).not.toBeNull();
    expect(hold.status).toBe("superseded");
    expect(hold.superseded_by).toEqual([ids.GRANT]);
  });

  it("recovers the APPLICABLE grant in the current view, and not the retired hold", async () => {
    const { store, ids, READER } = await seed();
    const current = await scopedQuery(store, READER);
    const got = current.admitted.map((r) => r.record_id);
    expect(got).toContain(ids.GRANT);
    expect(got).not.toContain(ids.HOLD);
  });

  it("recovers the HISTORICAL hold with its bytes retained — supersession is not deletion", async () => {
    const { store, ids, READER } = await seed();
    const hist = await scopedHistory(store, READER);
    const hold = hist.admitted.find((r) => r.record_id === ids.HOLD);
    expect(hold).toBeDefined();
    expect(hold!.body.statement).toBe("publication of docs/catalog is held pending review");
    expect(hold!.body.requirements).toEqual([{ key: "publication", value: "held" }]);
    expect(classify(hold!).state).toBe("superseded");
    expect(classify(hold!).applicable).toBe(false);
  });

  it("the lifecycle state comes from the resolver, not from a retrieval-local last-write-wins", async () => {
    const { store, ids } = await seed();
    const hold = (await store.get(ids.HOLD))!;
    expect(classify(hold).resolver).toBe("event-projection");
    // The projection recorded the supersession in the record's history rather
    // than retrieval inferring it from timestamps.
    expect(hold.history.length).toBeGreaterThan(1);
  });

  it("allows only the granted publication scope: the grant covers docs/ and nothing above it", async () => {
    const { store, ids, REPO } = await seed();
    const grant = (await store.get(ids.GRANT))!;
    expect(qualifies(grant, { tenant: T, repo: REPO, path: "docs/catalog" }).ok).toBe(true);
    expect(qualifies(grant, { tenant: T, repo: REPO, path: "docs" }).ok).toBe(true);
    // Not a sibling tree...
    expect(qualifies(grant, { tenant: T, repo: REPO, path: "src" }).ok).toBe(false);
    // ...not a similarly-named one...
    expect(qualifies(grant, { tenant: T, repo: REPO, path: "docsite" }).ok).toBe(false);
    // ...and not the whole repository.
    expect(qualifies(grant, { tenant: T, repo: REPO }).ok).toBe(false);
  });

  it("NEGATIVE — no inferred merge or acceptance authority is derived from a publication grant", async () => {
    const { store, ids } = await seed();
    const grant = (await store.get(ids.GRANT))!;
    // Retrieval returns the ruling's own machine-checkable requirements and
    // invents none. `publication` is the only key it establishes.
    const keys = (grant.body.requirements as Array<{ key: string }>).map((r) => r.key);
    expect(keys).toEqual(["publication"]);
    expect(keys).not.toContain("merge");
    expect(keys).not.toContain("acceptance");
    // And nothing in the projected record asserts a grant it did not make.
    expect(JSON.stringify(grant.body)).not.toContain("merge");
    expect(JSON.stringify(grant.body)).not.toContain("acceptance");
  });

  it("POSITIVE CONTROL — the instrument can say yes: the grant qualifies at its own coordinate", async () => {
    const { store, ids, REPO } = await seed();
    const grant = (await store.get(ids.GRANT))!;
    expect(qualifies(grant, { tenant: T, repo: REPO, path: "docs/catalog" })).toEqual({ ok: true });
  });

  it("NEGATIVE — the superseded hold can no longer qualify anything", async () => {
    const { store, ids, REPO } = await seed();
    const hold = (await store.get(ids.HOLD))!;
    const v = qualifies(hold, { tenant: T, repo: REPO, path: "docs/catalog" });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("status_superseded");
  });

  it.todo("attempted publication OUTSIDE the granted scope is recorded as a refused attempt: lane 05's action gate");
  it.todo("grant/hold signature and ceremony-ingress requirements: lane 02's admission surface");
});
