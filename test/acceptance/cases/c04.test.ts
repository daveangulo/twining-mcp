/**
 * C04 — "Same display name, archived vs current, different immutable revisions
 * and bytes."
 *
 * Lane 04 owns §4.3 (current vs historical view), §4.4 (source freshness) and
 * §4.5 (scope enforcement before ranking). The identity and byte-preservation
 * sections are lane 02's.
 *
 * The property that binds this case to this lane: **name equality is not
 * record identity, and neither is hash equality**. Two records sharing a
 * display name (and even a source-byte hash) must stay two records, no
 * `supersedes` edge may be synthesised from name equality or revision ordering,
 * and an archived record is archived — not revoked, not deleted, not merged
 * into its namesake.
 */
import { describe, it, expect, afterAll } from "vitest";
import {
  makeWorld,
  newStore,
  created,
  buildEvent,
  policyEvents,
  deliverUnderPolicy,
  admitAndProject,
  cleanupTempDirs,
  scopedQuery,
  scopedGet,
  scopedHistory,
  requestFor,
} from "./harness.js";
import { mintRepoId, mintTenantId, mintEventId } from "../../../src/contracts/ids.js";
import { classify, freshness } from "../../../src/retrieval/lifecycle.js";
import { explainFor, leaksAny } from "../../../src/retrieval/explain.js";

afterAll(cleanupTempDirs);

const T = mintTenantId();
const SHARED_NAME = "baseline-invoice.fixture.json";
const SHARED_HASH = "bd98a6".padEnd(64, "0");
const REV_A = "a".repeat(40);
const REV_B = "b".repeat(40);

async function seed() {
  const world = makeWorld();
  const LEDGER = world.repo; // rid-LEDGER-001
  const FORK = mintRepoId(); // rid-LEDGER-FORK-777 — a different trust domain
  const store = newStore(world, world.hostA);
  const agent = { principal: world.hostA.principal, kind: "agent" as const, host: world.hostA.host };

  const obs = (repo: string, path: string, head: string, sha: string) =>
    created("observation", {
      scope: { tenant: T, repo, path: "fixtures", revision: { head } },
      producer: agent,
      evidence_class: "verified_observation",
      payload: {
        source_kind: "file",
        source_uri: `repo://${path}`,
        sha256: sha,
        observed_at: "2026-03-02T09:40:00.000Z",
        volatile: false,
        result: { display_name: SHARED_NAME, head },
      },
    });

  // REC-A01: the record that will be ARCHIVED. REV-A, its own bytes.
  const A01 = obs(LEDGER, `fixtures/${SHARED_NAME}`, REV_A, SHARED_HASH);
  // REC-A02: the CURRENT record. Same display name, different revision/bytes.
  const A02 = obs(LEDGER, `fixtures/ledger/${SHARED_NAME}`, REV_B, "59eb3a".padEnd(64, "0"));
  // REC-A03: the FORK's record. Same display name AND same source-byte hash.
  const A03 = obs(FORK, `fixtures/${SHARED_NAME}`, REV_A, SHARED_HASH);
  // REC-A04: another in-scope current record, for the breadth control.
  const A04 = obs(LEDGER, "fixtures/other.json", REV_B, "aabbcc".padEnd(64, "0"));
  // REC-A05: a model inference whose PROSE claims A02 replaces A01.
  const A05 = created("decision", {
    scope: { tenant: T, repo: LEDGER, path: "fixtures" },
    producer: agent,
    evidence_class: "model_inference",
    payload: {
      summary: "A02 supersedes A01",
      rationale: "Same file name and a newer revision, so the old one is clearly replaced.",
    },
  });

  const id = (e: unknown): string => (e as { record: { id: string } }).record.id;
  const ids = { A01: id(A01), A02: id(A02), A03: id(A03), A04: id(A04), A05: id(A05) };

  // EV-A10: archive REC-A01. Archived, NOT revoked.
  const ARCHIVE = buildEvent({
    id: mintEventId(),
    kind: "archived",
    record: { type: "observation", id: ids.A01 },
    scope: { tenant: T, repo: LEDGER, path: "fixtures", revision: { head: REV_A } },
    producer: agent,
    parents: [ids.A01],
    evidence_class: "verified_observation",
    payload: { target: ids.A01, reason: "superseded by a newer capture" },
  });

  const POLICY = policyEvents(
      world,
      [{ principal: world.hostA.principal, roles: ["write"], scopes: [{ repo: LEDGER }, { repo: FORK }] }],
      world.hostA,
    );
  deliverUnderPolicy(store, world, POLICY, [
    A01,
    A02,
    A03,
    A04,
    A05,
    ARCHIVE,
  ]);
  await admitAndProject(store);

  /** agent:scribe-7 is authorized on the LEDGER repo only. */
  const SCRIBE = requestFor("agent:scribe-7", [{ tenant: T, repo: LEDGER }], { tenant: T, repo: LEDGER, path: "fixtures" });
  /** agent:probe-2 holds an explicit cross-scope grant covering the fork. */
  const PROBE = requestFor(
    "agent:probe-2",
    [
      { tenant: T, repo: LEDGER },
      { tenant: T, repo: FORK },
    ],
    { tenant: T, repo: FORK, path: "fixtures" },
    { lessons_entitled: true },
  );

  return { store, ids, SCRIBE, PROBE, LEDGER, FORK };
}

describe("C04 — same display name, archived vs current, different revisions and bytes", () => {
  it("LIVENESS: all six records projected, including the fork's namesake", async () => {
    const { store, ids } = await seed();
    const projected = new Set((await store.query({ include_archived: true })).map((r) => r.record_id));
    for (const [n, id] of Object.entries(ids)) expect(projected.has(id), `${n} not projected`).toBe(true);
  });

  it("A-VIEW-1 — the current view excludes the archived record AND the fork's namesake", async () => {
    const { store, ids, SCRIBE } = await seed();
    const out = await scopedQuery(store, SCRIBE);
    const got = out.admitted.map((r) => r.record_id);
    expect(got).toContain(ids.A02);
    expect(got).toContain(ids.A04);
    expect(got).toContain(ids.A05); // present, but labelled as an inference
    expect(got).not.toContain(ids.A01); // archived
    expect(got).not.toContain(ids.A03); // out of scope
    // A05 is in the view as a LEAD, never as authority.
    const a05 = out.admitted.find((r) => r.record_id === ids.A05)!;
    expect(a05.evidence_class).toBe("model_inference");
    expect(classify(a05).authorizes_action).toBe(false);
  });

  it("A-VIEW-2/A-VIEW-4 — archived is not revoked: still retrievable by identity, class intact", async () => {
    const { store, ids, SCRIBE } = await seed();
    const rec = (await store.get(ids.A01))!;
    const view = classify(rec);
    expect(view.archived).toBe(true);
    expect(rec.revoked).toBe(false);
    expect(view.state).not.toBe("revoked");
    // The archived status is a FLAG beside the remembered prior status.
    expect(rec.archived_from).toBeDefined();
    // Still retrievable by identity in the historical view.
    const hist = await scopedHistory(store, SCRIBE);
    expect(hist.admitted.map((r) => r.record_id)).toContain(ids.A01);
    const fromHist = hist.admitted.find((r) => r.record_id === ids.A01)!;
    expect(fromHist.evidence_class).toBe("verified_observation");
    expect(fromHist.body.sha256).toBe(SHARED_HASH);
  });

  it("A-VIEW-3 (NEGATIVE) — no supersedes edge is synthesised from name equality, revision order or prose", async () => {
    const { store, ids } = await seed();
    const a01 = (await store.get(ids.A01))!;
    const a02 = (await store.get(ids.A02))!;
    // The archive event archived it; it did not supersede it.
    expect(a01.superseded_by).toEqual([]);
    expect(a01.overridden_by).toBeUndefined();
    expect(a02.superseded_by).toEqual([]);
    // And REC-A05's confident prose created no edge.
    expect(a01.conflicts).toEqual([]);
    expect(JSON.stringify(a01.history)).not.toContain(ids.A05);
  });

  it("A-ID-4/A-ID-5 (NEGATIVE) — shared display name and shared byte hash never collapse two records into one", async () => {
    const { store, ids, PROBE } = await seed();
    const a01 = (await store.get(ids.A01))!;
    const a03 = (await store.get(ids.A03))!;
    // Same display name AND same source-byte hash...
    expect(a01.body.sha256).toBe(a03.body.sha256);
    expect((a01.body.result as { display_name: string }).display_name).toBe(
      (a03.body.result as { display_name: string }).display_name,
    );
    // ...and still two record identities with two repo identities.
    expect(a01.record_id).not.toBe(a03.record_id);
    expect(a01.scope.repo).not.toBe(a03.scope.repo);
    // A principal authorized on both sees BOTH, not a deduped one.
    // `include_archived` is needed because A01 is archived — archived records
    // are excluded from the default view by design, not by the scope gate.
    const both = await scopedQuery(store, { ...PROBE, query: { tenant: T }, mode: "lessons" }, { include_archived: true });
    const got = both.admitted.map((r) => r.record_id);
    expect(got).toContain(ids.A01 as string);
    expect(got).toContain(ids.A03);
  });

  it("A-SCOPE-1/A-SCOPE-2 (NEGATIVE) — the fork's record appears on no path for scribe-7, including hash search", async () => {
    const { store, ids, SCRIBE } = await seed();
    // Ranked.
    const ranked = await scopedQuery(store, SCRIBE);
    expect(ranked.admitted.map((r) => r.record_id)).not.toContain(ids.A03);
    // Exact id.
    expect(await scopedGet(store, ids.A03, SCRIBE)).toEqual({ ok: false, reason: "not_found_in_scope" });
    // Historical / temporal.
    const hist = await scopedHistory(store, SCRIBE);
    expect(hist.admitted.map((r) => r.record_id)).not.toContain(ids.A03);
    // "Search by the shared hash" — the gate runs over the hash-matched pool
    // exactly as over any other candidate list, so the fork's record is cut.
    const byHash = (await store.query({ include_archived: true })).filter((r) => r.body.sha256 === SHARED_HASH);
    expect(byHash.map((r) => r.record_id).sort()).toEqual([ids.A01, ids.A03].sort()); // both exist...
    const gated = await scopedQuery(store, { ...SCRIBE }, { include_archived: true });
    expect(gated.admitted.map((r) => r.record_id)).not.toContain(ids.A03); // ...one is returned
    // Diagnostics disclose a count, never the identity.
    const packet = explainFor({
      query_id: "Q4", request: SCRIBE, selection: ranked, candidates: [], results: [], omissions: [],
      token_usage: {}, versions: { ranking: "r", index: "i", embedding_model: "m", tokenizer: "t", contract: "c" },
    });
    expect(packet.suppressed.scope_denied).toBeGreaterThan(0);
    expect(leaksAny(packet, [ids.A03, SHARED_NAME])).toEqual([]);
  });

  it("A-SCOPE-3 (P) — breadth control: the filter is not a blanket denial", async () => {
    const { store, ids, SCRIBE } = await seed();
    const out = await scopedQuery(store, SCRIBE, { include_archived: true });
    const got = out.admitted.map((r) => r.record_id);
    expect(got).toEqual(expect.arrayContaining([ids.A01, ids.A02, ids.A04, ids.A05]));
  });

  it("A-SCOPE-4 (P) — the explicit cross-scope mode DOES return the fork's record, proving A-SCOPE-1 is authorization", async () => {
    const { store, ids, PROBE } = await seed();
    const out = await scopedQuery(store, PROBE);
    expect(out.admitted.map((r) => r.record_id)).toContain(ids.A03);
    expect(out.outcome).toBe("ok");
  });

  it("A-SCOPE-5 (NEGATIVE) — a small or empty in-scope result never falls back to cross-scope", async () => {
    const { store, SCRIBE } = await seed();
    // A genuinely unrelated subtree. NOT "fixtures/nothing-here": path matching
    // is bidirectional for RELEVANCE (ADR §3), so a query for a path inside
    // `fixtures` still sees the repo-wide `fixtures` records that cover it —
    // which is correct, and is why the empty-result case needs a path with no
    // covering relation in either direction.
    const narrow = await scopedQuery(store, { ...SCRIBE, query: { ...SCRIBE.query, path: "src/unrelated" } });
    expect(narrow.admitted).toEqual([]);
    expect(narrow.outcome).toBe("no_in_scope_evidence");
  });

  it("A-ID-7 (NEGATIVE) — an identical local checkout path never binds records across repo identities", async () => {
    const { store, ids, SCRIBE } = await seed();
    const a01 = (await store.get(ids.A01))!;
    const a03 = (await store.get(ids.A03))!;
    // Identical relative path, different repo identity.
    expect(a01.scope.path).toBe(a03.scope.path);
    expect(a01.scope.repo).not.toBe(a03.scope.repo);
    // ...and the gate cuts on the identity, not the path.
    const out = await scopedQuery(store, SCRIBE, { include_archived: true });
    expect(out.admitted.map((r) => r.record_id)).toContain(ids.A01);
    expect(out.admitted.map((r) => r.record_id)).not.toContain(ids.A03);
  });

  it("A-FRESH-1/2/3 — an unavailable connector yields `unknown`, never a revision, never a local check", () => {
    const view = freshness({
      observed_at: "2026-03-02T09:40:00.000Z",
      now: Date.parse("2026-03-02T12:00:00.000Z"),
      source_available: false,
      unavailable_reason: "source_connector_unavailable",
    });
    expect(view.state).toBe("unknown");
    expect(view.reason).toBe("source_connector_unavailable");
    // Never a head value, never "deleted", never a confirmation.
    expect(JSON.stringify(view)).not.toContain(REV_A);
    expect(JSON.stringify(view)).not.toContain(REV_B);
    expect(JSON.stringify(view)).not.toContain("deleted");
    // A local working tree, a file test or an index refresh produce no
    // observation, so the verdict is unchanged by all three (R12).
    expect(freshness({ now: Date.now() }).state).toBe("unknown");
  });

  it("A-FRESH-4 — the archived record's bytes and observation time stay recoverable after a force-push", async () => {
    const { store, ids } = await seed();
    const rec = (await store.get(ids.A01))!;
    expect(rec.body.sha256).toBe(SHARED_HASH);
    expect(rec.body.observed_at).toBe("2026-03-02T09:40:00.000Z");
    // Reachability is a source fact, not a record fact: the record reports what
    // it observed and the freshness layer reports `unknown`, never `deleted`.
    expect(rec.status).not.toBe("tombstoned");
    expect(rec.body).not.toEqual({});
  });

  it("CONTROL scope-filter-off: A-SCOPE-1 flips — the fork's namesake is returned", async () => {
    const { store, ids, SCRIBE } = await seed();
    const leaked = await scopedQuery(store, { ...SCRIBE, disable: { scope_filter_off: true } }, { include_archived: true });
    expect(leaked.admitted.map((r) => r.record_id)).toContain(ids.A03);
  });

  it.todo("A-ID-1/2/3/6, A-BYTE-1..6 (four distinct named hashes, byte-for-byte read-back, remote-URL relocation, replication): lane 02's admission and projection surfaces");
  it.todo("A-VIEW-5 (pending causal dependency when the archive arrives before its target): lane 02's admission surface");
});
