/**
 * Scope-first candidate selection — the gate every retrieval path runs before
 * ranking (R13, R14; oracle C25).
 *
 * Each instrument-can-fail control from C25 is exercised as a test that
 * disables exactly one switch and asserts the corresponding negative assertion
 * FLIPS TO FAIL. A control that cannot break its assertion means the assertion
 * was never measuring the property.
 */
import { describe, it, expect } from "vitest";
import {
  selectCandidates,
  selectNeighbors,
  readByIdInScope,
  scopeAuthorizes,
  authorizes,
  authorizedDigest,
  cacheKey,
  cacheServable,
  legacyScope,
  legacyEnvelope,
  isUnrepresentableScope,
  type SelectionRequest,
} from "../../src/retrieval/select.js";
import type { Scope } from "../../src/contracts/scope.js";

/* C25 §2–3: Ana is authorized on R-GW only. The bait lives elsewhere. */
const T1 = "tenant-northwind";
const T2 = "tenant-valeport";
const R_GW = "r_gw000000000000000000000000";
const R_LED = "r_led00000000000000000000000";
const R_BILL = "r_bill0000000000000000000000";

interface Rec {
  id: string;
  scope: Scope;
  title: string;
  cosine: number;
}

const REC_D1: Rec = { id: "REC-D1", scope: { tenant: T1, repo: R_LED, path: "ledger/retry" }, title: "retry backoff duplicate charge", cosine: 0.98 };
const REC_L1: Rec = { id: "REC-L1", scope: { tenant: T2, repo: R_BILL, path: "billing" }, title: "backoff-duplicate-charge", cosine: 0.4 };
const REC_G1: Rec = { id: "REC-G1", scope: { tenant: T1, repo: R_LED, path: "ledger/policy" }, title: "graph neighbour", cosine: 0.2 };
/* Parent doc lives at gateway/retry/runbook-7; chunk 4 alone is scoped to another repo. */
const CHUNK_C4: Rec = { id: "DOC-RUNBOOK-7#c4", scope: { tenant: T1, repo: R_BILL, path: "gateway/retry/runbook-7" }, title: "chunk 4", cosine: 0.6 };
const CHUNK_C1: Rec = { id: "DOC-RUNBOOK-7#c1", scope: { tenant: T1, repo: R_GW, path: "gateway/retry/runbook-7" }, title: "chunk 1", cosine: 0.3 };
const REC_P1: Rec = { id: "REC-P1", scope: { tenant: T1, repo: R_GW, path: "gateway/retry" }, title: "in-scope true positive", cosine: 0.71 };

/** Ranked as a ranking-then-filter implementation would rank them. */
const POOL: Rec[] = [REC_D1, CHUNK_C4, REC_P1, REC_L1, CHUNK_C1, REC_G1].sort((a, b) => b.cosine - a.cosine);

const ANA: SelectionRequest = {
  principal: "u-ana-koval",
  authorized: [{ tenant: T1, repo: R_GW }],
  query: { tenant: T1, repo: R_GW, path: "gateway/retry" },
  mode: "strict",
};
const BRAM: SelectionRequest = {
  principal: "u-bram-olesen",
  authorized: [
    { tenant: T1, repo: R_GW },
    { tenant: T1, repo: R_LED },
  ],
  query: { tenant: T1, repo: R_LED, path: "ledger/retry" },
  mode: "strict",
  lessons_entitled: true,
};
const CYRUS: SelectionRequest = {
  principal: "u-cyrus-mbeki",
  authorized: [{ tenant: T2, repo: R_BILL }],
  query: { tenant: T2, repo: R_BILL, path: "billing" },
  mode: "strict",
};

const run = (req: SelectionRequest, pool: Rec[] = POOL) =>
  selectCandidates(pool, (r) => r.scope, (r) => r.id, req);

describe("scopeAuthorizes — read visibility is a third scope operation", () => {
  it("covers narrower paths and never the reverse", () => {
    expect(scopeAuthorizes({ repo: R_GW, path: "src" }, { repo: R_GW, path: "src/auth" })).toBe(true);
    expect(scopeAuthorizes({ repo: R_GW, path: "src/auth" }, { repo: R_GW, path: "src" })).toBe(false);
  });

  it("matches on segment boundaries, so src/auth never covers src/authz", () => {
    expect(scopeAuthorizes({ repo: R_GW, path: "src/auth" }, { repo: R_GW, path: "src/authz" })).toBe(false);
  });

  it("never crosses repo or tenant even with an identical relative path (C05 A11)", () => {
    expect(scopeAuthorizes({ tenant: T1, repo: R_GW, path: "svc/dispatch" }, { tenant: T1, repo: R_LED, path: "svc/dispatch" })).toBe(false);
    expect(scopeAuthorizes({ tenant: T1, repo: R_GW }, { tenant: T2, repo: R_GW })).toBe(false);
  });

  it("denies by default: an envelope silent on repo must declare global", () => {
    expect(scopeAuthorizes({ tenant: T1 } as Scope, { tenant: T1, repo: R_GW })).toBe(false);
    expect(scopeAuthorizes({ tenant: T1, global: true } as Scope, { tenant: T1, repo: R_GW })).toBe(true);
  });

  it("is NOT revision-bound: a read entitlement survives a head move", () => {
    const env: Scope = { repo: R_GW, revision: { head: "a".repeat(40) } };
    expect(scopeAuthorizes(env, { repo: R_GW, revision: { head: "b".repeat(40) } })).toBe(true);
  });

  it("an empty envelope set authorizes nothing", () => {
    expect(authorizes([], { repo: R_GW })).toBe(false);
    expect(run({ ...ANA, authorized: [] }).admitted).toHaveLength(0);
  });
});

describe("C25 A13 (L) — instrument liveness: the bait is real and reachable", () => {
  it("Bram scoped to R-LED retrieves REC-D1 at rank 1", () => {
    const out = run(BRAM);
    expect(out.admitted[0]?.id).toBe("REC-D1");
  });

  it("Cyrus scoped to R-BILL retrieves REC-L1 at rank 1", () => {
    const out = run(CYRUS);
    expect(out.admitted.map((r) => r.id)).toContain("REC-L1");
    expect(out.admitted[0]?.id).toBe("REC-L1");
  });

  it("a principal scoped to both GW and LED traverses to REC-G1", () => {
    const edges = [{ relation_id: "rel-1", relation_type: "derived_from", neighbor: REC_G1 }];
    const both: SelectionRequest = { ...BRAM, query: { tenant: T1, repo: R_LED } };
    expect(selectNeighbors(edges, (n) => n.scope, both).admitted).toHaveLength(1);
  });
});

describe("C25 A1/A2 — dense and lexical paths obey authorization before ranking", () => {
  it("the highest-cosine candidate in the whole index is cut when out of scope", () => {
    const out = run(ANA);
    expect(POOL[0]!.id).toBe("REC-D1"); // it really is rank 1 by relevance
    expect(out.admitted.map((r) => r.id)).not.toContain("REC-D1");
    expect(out.admitted.map((r) => r.id)).not.toContain("REC-L1");
  });

  it("A7 (P) — the lower-scoring in-scope record is returned at rank 1", () => {
    const out = run(ANA);
    expect(out.admitted[0]?.id).toBe("REC-P1");
  });

  it("CONTROL scope-filter-off: A1 flips to fail — REC-D1 returns at rank 1", () => {
    const out = run({ ...ANA, disable: { scope_filter_off: true } });
    // The relevance ranking is untouched; only the gate is gone. So the leak is
    // exactly the top-cosine bait, which is what the assertion measures.
    const leaked = out.admitted.map((r) => r.id);
    expect(leaked).toContain("REC-D1");
    expect(leaked[0]).toBe("REC-D1");
  });
});

describe("C25 A4 — chunk scope is the chunk's own, never inherited from the parent", () => {
  it("an out-of-scope chunk inside an in-scope parent is cut; sibling chunks stay", () => {
    const out = run(ANA);
    const ids = out.admitted.map((r) => r.id);
    expect(ids).not.toContain("DOC-RUNBOOK-7#c4");
    expect(ids).toContain("DOC-RUNBOOK-7#c1");
  });

  it("CONTROL chunk-scope-inheritance-on: A4 flips to fail, chunks 1-3 still returned", () => {
    // The control is modelled where it lives: the caller supplies the PARENT's
    // scope for every chunk instead of the chunk's own.
    const parentScope: Scope = { tenant: T1, repo: R_GW, path: "gateway/retry/runbook-7" };
    const out = selectCandidates(
      POOL,
      (r) => (r.id.includes("#") ? parentScope : r.scope),
      (r) => r.id,
      ANA,
    );
    const ids = out.admitted.map((r) => r.id);
    expect(ids).toContain("DOC-RUNBOOK-7#c4"); // A4 fails
    expect(ids).toContain("DOC-RUNBOOK-7#c1"); // and the sibling still passes
  });
});

describe("C25 A3 — graph neighbours outside scope are cut, not ranked", () => {
  const edges = [
    { relation_id: "rel-g1", relation_type: "derived_from", neighbor: REC_G1 },
    { relation_id: "rel-p1", relation_type: "affects", neighbor: REC_P1 },
  ];

  it("the unauthorized endpoint yields a relation report with no neighbour data", () => {
    const out = selectNeighbors(edges, (n) => n.scope, ANA);
    expect(out.admitted.map((e) => e.neighbor.id)).toEqual(["REC-P1"]);
    expect(out.cut).toEqual([{ relation_id: "rel-g1", relation_type: "derived_from", reason: "endpoint_not_authorized" }]);
    // No title, body, score or id of the neighbour appears anywhere.
    expect(JSON.stringify(out.cut)).not.toContain("REC-G1");
    expect(JSON.stringify(out.cut)).not.toContain("graph neighbour");
  });

  it("CONTROL graph-expansion-scope-off: A3 flips while A1/A2 stay passing", () => {
    const req = { ...ANA, disable: { graph_expansion_scope_off: true } };
    const neighbors = selectNeighbors(edges, (n) => n.scope, req);
    expect(neighbors.admitted.map((e) => e.neighbor.id)).toContain("REC-G1"); // A3 fails
    // Path isolation: the dense/lexical gate is untouched by this switch.
    const dense = run(req);
    expect(dense.admitted.map((r) => r.id)).not.toContain("REC-D1"); // A1 still passes
    expect(dense.admitted.map((r) => r.id)).not.toContain("REC-L1"); // A2 still passes
  });
});

describe("C25 A5 — the cache key carries the principal and the authorized set", () => {
  it("Ana's key differs from Bram's for identical query text", () => {
    expect(cacheKey(ANA, "QTEXT")).not.toBe(cacheKey(BRAM, "QTEXT"));
  });

  it("an entry produced under a wider envelope is not servable to a narrower principal", () => {
    expect(cacheServable(ANA, [{ tenant: T1, repo: R_LED }])).toBe(false);
    expect(cacheServable(BRAM, [{ tenant: T1, repo: R_LED }])).toBe(true);
  });

  it("two principals with identical entitlements share a partition", () => {
    const twin: SelectionRequest = { ...ANA, principal: "u-ana-koval" };
    expect(authorizedDigest(twin.authorized)).toBe(authorizedDigest(ANA.authorized));
  });

  it("CONTROL cache-key-principal-off: A5 flips — Ana gets Bram's entry", () => {
    const off = { ...ANA, disable: { cache_key_principal_off: true } };
    expect(cacheKey(off, "QTEXT")).toBe(cacheKey({ ...BRAM, disable: { cache_key_principal_off: true } }, "QTEXT"));
    expect(cacheServable(off, [{ tenant: T1, repo: R_LED }])).toBe(true);
  });
});

describe("C25 A9 — lessons mode is entitlement-gated and never degrades to strict", () => {
  it("an unentitled principal gets scope_mode_denied, zero records, and a named entitlement", () => {
    const out = run({ ...ANA, mode: "lessons", query: { tenant: T1, repo: R_GW } });
    expect(out.outcome).toBe("scope_mode_denied");
    expect(out.admitted).toHaveLength(0);
    expect(out.missing_entitlement).toContain("cross_scope_lessons:read");
  });

  it("the denial is distinguishable from an empty channel", () => {
    const denied = run({ ...ANA, mode: "lessons", query: { tenant: T1, repo: R_GW } });
    const empty = selectCandidates([], (r: Rec) => r.scope, (r) => r.id, { ...BRAM, mode: "lessons" });
    expect(denied.outcome).toBe("scope_mode_denied");
    expect(empty.outcome).toBe("ok");
  });

  it("the denial does not alter a strict query's result set", () => {
    const before = run(ANA).admitted.map((r) => r.id);
    run({ ...ANA, mode: "lessons", query: { tenant: T1, repo: R_GW } });
    expect(run(ANA).admitted.map((r) => r.id)).toEqual(before);
  });

  it("CONTROL entitlement-check-off: A9 flips while the entitled path A8 still passes", () => {
    const out = run({ ...ANA, mode: "lessons", query: { tenant: T1, repo: R_GW }, disable: { entitlement_check_off: true } });
    expect(out.outcome).not.toBe("scope_mode_denied"); // A9 fails
    const entitled = run({ ...BRAM, mode: "lessons", query: { tenant: T1, repo: R_LED } });
    expect(entitled.outcome).toBe("ok"); // A8 unaffected
  });
});

describe("C25 A8 (P) — lessons mode is a narrow authorized channel, not a widening", () => {
  it("drops the query path but keeps the identity components and the auth gate", () => {
    const lesson: Rec = { id: "LES-X1", scope: { tenant: T1, repo: R_LED, path: "lessons" }, title: "lesson", cosine: 0.1 };
    const out = selectCandidates([lesson, REC_L1, REC_P1], (r) => r.scope, (r) => r.id, {
      ...BRAM,
      mode: "lessons",
      query: { tenant: T1, repo: R_LED, path: "ledger/retry" },
    });
    expect(out.admitted.map((r) => r.id)).toEqual(["LES-X1"]);
    // REC-L1 is a different tenant: the lesson channel does not reach it.
    expect(out.admitted.map((r) => r.id)).not.toContain("REC-L1");
  });
});

describe("C25 A10 — strict mode never broadens", () => {
  it("a query with no in-scope match returns zero records and no_in_scope_evidence", () => {
    const out = run({ ...ANA, query: { tenant: T1, repo: R_GW, path: "unrelated/area" } }, [REC_D1, REC_L1]);
    expect(out.admitted).toHaveLength(0);
    expect(out.outcome).toBe("no_in_scope_evidence");
    expect(out.suppressed.scope_denied).toBeGreaterThanOrEqual(1);
  });

  it("CONTROL strict-fallback-on: A10 flips — bait is returned and the code changes", () => {
    const out = selectCandidates(
      [REC_D1, REC_P1],
      (r) => r.scope,
      (r) => r.id,
      { ...ANA, query: { tenant: T1, repo: R_GW, path: "unrelated/area" }, disable: { strict_fallback_on: true } },
    );
    expect(out.outcome).not.toBe("no_in_scope_evidence");
    expect(out.admitted.map((r) => r.id)).toContain("REC-P1");
  });
});

describe("read-by-id returns not_found_in_scope, never the record (C12 A13, C19 A05)", () => {
  it("an out-of-scope id is indistinguishable from an absent one", () => {
    const denied = readByIdInScope(REC_D1, (r) => r.scope, ANA);
    const absent = readByIdInScope(null as Rec | null, (r) => r.scope, ANA);
    expect(denied).toEqual({ ok: false, reason: "not_found_in_scope" });
    expect(absent).toEqual(denied);
  });

  it("an in-scope id is returned", () => {
    expect(readByIdInScope(REC_P1, (r) => r.scope, ANA)).toEqual({ ok: true, record: REC_P1 });
  });

  it("CONTROL scope-filter-off: exact-id lookup leaks the record", () => {
    const out = readByIdInScope(REC_D1, (r) => r.scope, { ...ANA, disable: { scope_filter_off: true } });
    expect(out.ok).toBe(true);
  });
});

describe("suppression reporting distinguishes opaque from reportable reasons", () => {
  it("scope denials are counted but never named", () => {
    const out = run(ANA);
    expect(out.suppressed.scope_denied).toBeGreaterThan(0);
    expect(out.suppressed_visible.map((s) => s.id)).not.toContain("REC-D1");
    expect(JSON.stringify(out.suppressed_visible)).not.toContain("REC-L1");
  });

  it("an authorized-but-irrelevant record is reportable in full", () => {
    const otherPath: Rec = { id: "REC-OTHER", scope: { tenant: T1, repo: R_GW, path: "billing/ui" }, title: "x", cosine: 0.9 };
    const out = run({ ...ANA }, [REC_P1, otherPath]);
    expect(out.suppressed_visible).toContainEqual({ id: "REC-OTHER", reason: "out_of_query_scope" });
  });
});

describe("C25 A14 — enforcement is not host-local or replica-local", () => {
  it("the same request against a second candidate ordering yields the same sets", () => {
    const primary = run(ANA);
    const replica = run(ANA, [...POOL].reverse());
    expect(new Set(replica.admitted.map((r) => r.id))).toEqual(new Set(primary.admitted.map((r) => r.id)));
    expect(replica.suppressed).toEqual(primary.suppressed);
  });
});

describe("2.x compatibility", () => {
  const REPO = "r_legacy00000000000000000000";

  it('"project" becomes a repo-wide scope, not a directory named project', () => {
    expect(legacyScope("project", REPO)).toEqual({ repo: REPO });
    expect(legacyScope("", REPO)).toEqual({ repo: REPO });
    expect(legacyScope(undefined, REPO)).toEqual({ repo: REPO });
  });

  it("a path scope keeps its path and gains the store's repo identity", () => {
    expect(legacyScope("src/auth/", REPO)).toEqual({ repo: REPO, path: "src/auth" });
  });

  it("a scope the contract would reject as a path FAILS CLOSED, matching nothing", () => {
    // It used to return a bare { repo }. An absent path is the WILDCARD in
    // pathCovers, so `docs/../secrets` matched every query in the store rather
    // than none — universally visible, not universally invisible. Widening is
    // only safe when the derived scope is used for authorization alone, and
    // here it is also the relevance key.
    for (const bad of ["../elsewhere", "/abs/path", "docs/../secrets"]) {
      const sc = legacyScope(bad, REPO);
      expect(isUnrepresentableScope(sc)).toBe(true);
      expect(sc.path).toBeDefined();
      // Matches no ordinary query, in either direction.
      for (const q of ["src/auth/", "docs/", "project"]) {
        expect(
          selectCandidates([{ id: "x", scope: sc, title: "", cosine: 1 }], (r) => r.scope, (r) => r.id, {
            principal: "p",
            authorized: legacyEnvelope(REPO),
            query: legacyScope(q, REPO),
          }).admitted,
        ).toHaveLength(0);
      }
    }
  });

  it("the sentinel is stable and distinct per input, so the cut is inspectable", () => {
    expect(legacyScope("../a", REPO).path).toBe(legacyScope("../a", REPO).path);
    expect(legacyScope("../a", REPO).path).not.toBe(legacyScope("../b", REPO).path);
  });

  it("the legacy envelope gives one repo, so two stores can never see each other", () => {
    const a = legacyEnvelope(REPO);
    expect(authorizes(a, legacyScope("src/auth/", REPO))).toBe(true);
    expect(authorizes(a, legacyScope("src/auth/", "r_other000000000000000000000"))).toBe(false);
  });

  it("gap 3's bait: vendor-repo/billing/ is cut for an src/auth/ query", () => {
    const inScope = { id: "in", scope: legacyScope("src/auth/", REPO), title: "", cosine: 0.1 };
    const bait = { id: "bait", scope: legacyScope("vendor-repo/billing/", REPO), title: "", cosine: 0.99 };
    const out = selectCandidates([bait, inScope], (r) => r.scope, (r) => r.id, {
      principal: "main",
      authorized: legacyEnvelope(REPO),
      query: legacyScope("src/auth/", REPO),
    });
    expect(out.admitted.map((r) => r.id)).toEqual(["in"]);
    expect(out.suppressed_visible).toContainEqual({ id: "bait", reason: "out_of_query_scope" });
  });
});
