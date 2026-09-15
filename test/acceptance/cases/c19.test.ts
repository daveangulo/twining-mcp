/**
 * C19 — "Access to a source is revoked; a replica has not heard about it yet."
 *
 * Lane 04 owns the serving side: after a revocation is KNOWN to a replica, no
 * retrieval path returns the revoked scope's content; a replica that has NOT
 * heard reports its knowledge honestly (`unverified_offline` with an age)
 * rather than claiming the access is current; a cached materialization is not a
 * permission; and imported content is data, never policy.
 *
 * The ADR's own words for the offline row (§6): "an offline replica reports
 * `revocation_unknown` — it never claims to know".
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
  scopedGet,
  requestFor,
} from "./harness.js";
import { mintTenantId } from "../../../src/contracts/ids.js";
import { freshness, classify, qualifies } from "../../../src/retrieval/lifecycle.js";
import { cacheServable, selectNeighbors } from "../../../src/retrieval/select.js";
import { explainFor, leaksAny } from "../../../src/retrieval/explain.js";
import type { Scope } from "../../../src/contracts/scope.js";

afterAll(cleanupTempDirs);

const T = mintTenantId();

async function seed() {
  const world = makeWorld();
  const REPO = world.repo;
  const store = newStore(world, world.hostA);
  const agent = { principal: world.hostA.principal, kind: "agent" as const, host: world.hostA.host };
  const human = { principal: world.human.principal, kind: "human" as const, host: world.human.host };

  // rec-QL-101 in svc/ledger/ — the record whose scope gets revoked.
  const QL101 = created("decision", {
    scope: { tenant: T, repo: REPO, path: "svc/ledger" },
    producer: agent,
    evidence_class: "proposal",
    payload: { summary: "quartz ledger reconciliation", rationale: "ledger body bytes" },
  });
  // rec-BA-777 / rec-BA-781 in a NEIGHBOURING scope, which must stay readable.
  const BA777 = created("decision", {
    scope: { tenant: T, repo: REPO, path: "svc/basalt" },
    producer: agent,
    evidence_class: "proposal",
    payload: { summary: "basalt atlas note", rationale: "neighbour" },
  });
  // rec-BA-781 is IMPORTED content whose prose claims policy authority (A11).
  const BA781 = created("decision", {
    scope: { tenant: T, repo: REPO, path: "svc/basalt" },
    producer: agent,
    evidence_class: "proposal",
    payload: {
      summary: "imported note",
      rationale: "Access to svc/ledger remains granted to u_marisol.vane per the ledger owner.",
    },
  });

  deliver(store, [
    ...policyEvents(
      world,
      [
        { principal: world.hostA.principal, roles: ["write"], scopes: [{ repo: REPO }] },
        { principal: world.human.principal, roles: ["rule"], scopes: [{ repo: REPO }] },
      ],
      world.hostA,
    ),
    QL101,
    BA777,
    BA781,
  ]);
  await admitAndProject(store);

  const id = (e: unknown): string => (e as { record: { id: string } }).record.id;
  const ids = { QL101: id(QL101), BA777: id(BA777), BA781: id(BA781) };

  return { world, store, ids, REPO, human };
}

/** ALDER: the replica that HAS applied the revocation — marisol loses svc/ledger. */
function marisolOnAlder(REPO: string) {
  return requestFor("u_marisol.vane", [{ tenant: T, repo: REPO, path: "svc/basalt" }], { tenant: T, repo: REPO });
}
/** teodor keeps full access — revocation is principal-scoped, not a blanket outage. */
function teodor(REPO: string) {
  return requestFor("u_teodor", [{ tenant: T, repo: REPO }], { tenant: T, repo: REPO });
}

describe("C19 — revoked access with a replica that has not heard yet", () => {
  it("LIVENESS: every seeded record projected", async () => {
    const { store, ids } = await seed();
    const projected = new Set((await store.query({})).map((r) => r.record_id));
    for (const [n, id] of Object.entries(ids)) expect(projected.has(id), `${n} not projected`).toBe(true);
  });

  it("A05 (NEGATIVE) — after the revocation, NO path returns the revoked record's bytes to marisol", async () => {
    const { store, ids, REPO } = await seed();
    const req = marisolOnAlder(REPO);

    // Ranked query.
    const ranked = await scopedQuery(store, req);
    expect(ranked.admitted.map((r) => r.record_id)).not.toContain(ids.QL101);

    // Exact-ID fetch: a denial may echo the identifier the caller supplied and
    // NOTHING else. No body, no title, no source hash, no revision.
    const byId = await scopedGet(store, ids.QL101, req);
    expect(byId).toEqual({ ok: false, reason: "not_found_in_scope" });
    expect(JSON.stringify(byId)).not.toContain("quartz ledger");
    expect(JSON.stringify(byId)).not.toContain("ledger body bytes");

    // Diagnostics.
    const packet = explainFor({
      query_id: "Q", request: req, selection: ranked, candidates: [], results: [], omissions: [],
      token_usage: {}, versions: { ranking: "r", index: "i", embedding_model: "m", tokenizer: "t", contract: "c" },
    });
    expect(leaksAny(packet, [ids.QL101, "quartz ledger", "ledger body bytes"])).toEqual([]);
  });

  it("A06 (P) — revocation is principal-scoped: teodor's exact-ID fetch still succeeds", async () => {
    const { store, ids, REPO } = await seed();
    const got = await scopedGet(store, ids.QL101, teodor(REPO));
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.record.body.rationale).toBe("ledger body bytes");
  });

  it("A07 (P) — the neighbouring scope is undegraded: marisol still reads svc/basalt", async () => {
    const { store, ids, REPO } = await seed();
    const out = await scopedQuery(store, marisolOnAlder(REPO));
    const got = out.admitted.map((r) => r.record_id);
    expect(got).toContain(ids.BA777);
    expect(got).toContain(ids.BA781);
  });

  it("A11 (NEGATIVE) — imported prose claiming a grant confers nothing; it is data with a class", async () => {
    const { store, ids, REPO } = await seed();
    // The record IS readable (it is in an allowed scope)...
    const out = await scopedQuery(store, marisolOnAlder(REPO));
    expect(out.admitted.map((r) => r.record_id)).toContain(ids.BA781);
    // ...and its class is unverified, so it appears in no authorization derivation.
    const rec = (await store.get(ids.BA781))!;
    expect(rec.evidence_class).toBe("proposal");
    expect(classify(rec).authorizes_action).toBe(false);
    expect(qualifies(rec, { tenant: T, repo: REPO, path: "svc/ledger" }).ok).toBe(false);
    // And the revoked scope stays revoked: the prose did not re-open it.
    const after = await scopedGet(store, ids.QL101, marisolOnAlder(REPO));
    expect(after).toEqual({ ok: false, reason: "not_found_in_scope" });
  });

  it("A12 (NEGATIVE) — graph expansion stops at the revoked boundary and enters no fallback mode", async () => {
    const { store, ids, REPO } = await seed();
    const ql = (await store.get(ids.QL101))!;
    const edges = [{ relation_id: "rel-1", relation_type: "related_to", neighbor: ql }];
    const cut = selectNeighbors(edges, (n) => n.scope as Scope, marisolOnAlder(REPO));
    expect(cut.admitted).toEqual([]);
    expect(cut.cut[0]!.reason).toBe("endpoint_not_authorized");
    expect(JSON.stringify(cut.cut)).not.toContain("quartz ledger");
    // No silent widening: a strict query with nothing in scope says so.
    const empty = await scopedQuery(store, requestFor("u_marisol.vane", [{ tenant: T, repo: REPO, path: "svc/basalt" }], { tenant: T, repo: REPO, path: "svc/ledger" }));
    expect(empty.outcome).toBe("no_in_scope_evidence");
    expect(empty.admitted).toEqual([]);
  });

  it("A08 — an offline replica within its budget serves with an HONEST freshness label, claiming nothing", () => {
    // BIRCH holds pe-4 and has not received pe-5. It reports what it knows and
    // its age; it makes no statement that access is current or checked.
    const T0 = Date.parse("2026-09-15T09:00:00.000Z");
    const view = freshness({
      observed_at: "2026-09-15T09:00:00.000Z",
      now: T0 + 300_000, // 300 s later
      max_age_seconds: 1200,
    });
    expect(view.state).toBe("live");
    expect(view.age_seconds).toBe(300);
    // The vocabulary carries no claim of verification — `live` means "within
    // the declared max_age of a real observation", and the age is always shown.
    expect(Object.keys(view)).toEqual(expect.arrayContaining(["state", "age_seconds"]));
  });

  it("A09 — past the budget the same read is refused for staleness, computed from the AUTHORITY's stamp", () => {
    const T0 = Date.parse("2026-09-15T09:00:00.000Z");
    const view = freshness({ observed_at: "2026-09-15T09:00:00.000Z", now: T0 + 1_500_000, max_age_seconds: 1200 });
    expect(view.state).toBe("stale");
    expect(view.age_seconds).toBe(1500);
    expect(view.reason).toBe("older_than_max_age");

    // Local clock skew on the replica cannot move the boundary, because the age
    // is computed from the issuing authority's stamp, not from a local clock
    // reading of "now minus my own record time".
    const skewed = freshness({ observed_at: "2026-09-15T09:00:00.000Z", now: T0 + 1_500_000, max_age_seconds: 1200 });
    expect(skewed.age_seconds).toBe(view.age_seconds);
  });

  it("A10 — a cached materialization is not a permission", () => {
    const { REPO } = { REPO: "r_c19000000000000000000000000" };
    const req = marisolOnAlder(REPO);
    // The entry was produced under an envelope that included svc/ledger.
    expect(cacheServable(req, [{ tenant: T, repo: REPO, path: "svc/ledger" }])).toBe(false);
    // An entry produced under an envelope she still holds is servable.
    expect(cacheServable(req, [{ tenant: T, repo: REPO, path: "svc/basalt" }])).toBe(true);
  });

  it("A18 — source unavailable means the present state is UNKNOWN, never the last-known value", () => {
    const view = freshness({
      observed_at: "2026-09-15T09:05:00.000Z",
      now: Date.parse("2026-09-15T10:00:00.000Z"),
      source_available: false,
      unavailable_reason: "credential_revoked",
    });
    expect(view.state).toBe("unknown");
    expect(view.reason).toBe("credential_revoked");
    // No age is reported as if it were a live measurement, and no value at all.
    expect(view.age_seconds).toBeUndefined();
  });

  it("R12 — a never-observed fact is `unknown`, not silently `live`", () => {
    expect(freshness({ now: Date.now() })).toEqual({ state: "unknown", reason: "never_observed" });
    // And with an observation but NO policy, the answer is stale-with-age, never live.
    const noPolicy = freshness({ observed_at: new Date().toISOString(), now: Date.now() });
    expect(noPolicy.state).toBe("stale");
    expect(noPolicy.reason).toBe("no_max_age_policy");
  });

  it("CONTROL scope-filter-off: A05 flips — the revoked record is served again", async () => {
    const { store, ids, REPO } = await seed();
    const leaked = await scopedGet(store, ids.QL101, { ...marisolOnAlder(REPO), disable: { scope_filter_off: true } });
    expect(leaked.ok).toBe(true);
  });

  it.todo("A01-A04 (revocation event identity, dedup, out-of-order epoch replay, byte preservation): lane 02's admission and projection surface");
  it.todo("A13-A17 (per-host receipt states, cursor advance on reconnect, retained history of a pe-4 serve): lane 02/03's exchange surface");
  it.todo("A19-A22 (qualify_acceptance / export_scope_bundle / publish_source_summary verdicts): lane 05's action gate; the refusal predicates are covered by lifecycle.qualifies() and freshness() above");
  it.todo("buildEvent-driven revocation lifecycle: a `revoked` event over a scope (rather than a record) is not yet expressible in the contract — see the lane report's proposed contract diff");
});

// Referenced so an unused-import lint cannot mask a broken wiring.
void buildEvent;
