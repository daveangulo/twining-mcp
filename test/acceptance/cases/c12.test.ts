/**
 * C12 — "A valid credential is used outside its authorization."
 *
 * Almost all of C12 is lane 02's admission surface (four independently
 * diagnosable denial codes, attempt records, byte preservation of refused
 * payloads). Lane 04 owns exactly two things, and they are the ones that make
 * a denial MEAN something:
 *
 *  - **A13**: a denied record must be invisible in EVERY query mode, including
 *    exact-ID lookup. "Invisible in the ranked view but retrievable by exact ID
 *    fails A13" is the oracle's own wording, and it is precisely the hole a
 *    ranking-layer filter leaves.
 *  - **A14/A15/A19**: a scope or tenant that was never authorized returns
 *    nothing, and nothing from it reaches a context packet.
 *
 * Plus A29: a genuine human ruling must not leak outside its own repository —
 * authority does not travel with the reader.
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
  scopedGet,
  requestFor,
} from "./harness.js";
import { mintRepoId, mintTenantId } from "../../../src/contracts/ids.js";
import { qualifies } from "../../../src/retrieval/lifecycle.js";
import { buildPacket } from "../../../src/retrieval/packet.js";
import { classifyLegacy } from "../../../src/retrieval/lifecycle.js";

afterAll(cleanupTempDirs);

const TNT = mintTenantId(); // tnt-northgate

async function seed() {
  const world = makeWorld();
  const RID_7F2A = world.repo;
  const RID_9C31 = mintRepoId(); // a repository the credential is not authorized for
  const TNT_OTHER = mintTenantId();
  const store = newStore(world, world.hostA);
  const agent = { principal: world.hostA.principal, kind: "agent" as const, host: world.hostA.host };
  const human = { principal: world.human.principal, kind: "human" as const, host: world.human.host };

  // ev-quill-0001 / 0006: legitimately admitted records in services/ledger/.
  const SEED = created("decision", {
    scope: { tenant: TNT, repo: RID_7F2A, path: "services/ledger" },
    producer: agent,
    evidence_class: "proposal",
    payload: { summary: "seed record", rationale: "admitted before the run" },
  });
  const OK = created("decision", {
    scope: { tenant: TNT, repo: RID_7F2A, path: "services/ledger" },
    producer: agent,
    evidence_class: "reported_result",
    payload: { summary: "worker result", rationale: "legitimate" },
  });
  // ev-mira-0001: the genuine human ruling, scoped to services/ledger/ only.
  const MIRA = created("ruling", {
    scope: { tenant: TNT, repo: RID_7F2A, path: "services/ledger" },
    producer: human,
    evidence_class: "human_ruling",
    signWith: { keyId: world.human.keyId, kp: world.human.kp },
    payload: { statement: "publish_to_mainline is permitted in services/ledger" },
  });
  // A record in services/payments/ — a scope the credential never held.
  const PAY = created("decision", {
    scope: { tenant: TNT, repo: RID_7F2A, path: "services/payments" },
    producer: agent,
    evidence_class: "proposal",
    payload: { summary: "payments record", rationale: "different scope" },
  });

  const POLICY = policyEvents(
      world,
      [
        { principal: world.hostA.principal, roles: ["write"], scopes: [{ repo: RID_7F2A }] },
        { principal: world.human.principal, roles: ["rule"], scopes: [{ repo: RID_7F2A }] },
      ],
      world.hostA,
    );
  deliverUnderPolicy(store, world, POLICY, [
    SEED,
    OK,
    MIRA,
    PAY,
  ]);
  await admitAndProject(store);

  const id = (e: unknown): string => (e as { record: { id: string } }).record.id;
  const ids = { SEED: id(SEED), OK: id(OK), MIRA: id(MIRA), PAY: id(PAY) };

  /** The credential's real authorization: rid-7f2a, services/ledger/ only. */
  const QUILL = requestFor(
    "svc-agent-quill",
    [{ tenant: TNT, repo: RID_7F2A, path: "services/ledger" }],
    { tenant: TNT, repo: RID_7F2A, path: "services/ledger" },
  );
  return { store, ids, QUILL, RID_7F2A, RID_9C31, TNT_OTHER };
}

describe("C12 — a valid credential used outside its authorization", () => {
  it("LIVENESS: every seeded record projected, including the ones outside the credential's scope", async () => {
    const { store, ids } = await seed();
    const projected = new Set((await store.query({})).map((r) => r.record_id));
    for (const [n, id] of Object.entries(ids)) expect(projected.has(id), `${n} not projected`).toBe(true);
  });

  it("A12 — the current applicable view for the authorized coordinate is exactly the authorized records", async () => {
    const { store, ids, QUILL } = await seed();
    const out = await scopedQuery(store, QUILL);
    const got = out.admitted.map((r) => r.record_id).sort();
    expect(got).toEqual([ids.SEED, ids.OK, ids.MIRA].sort());
  });

  it("A13 (NEGATIVE) — an unauthorized record is invisible in EVERY mode, exact-ID included", async () => {
    const { store, ids, QUILL } = await seed();

    // Ranked / lexical / semantic: the caller never sees it.
    const ranked = await scopedQuery(store, QUILL);
    expect(ranked.admitted.map((r) => r.record_id)).not.toContain(ids.PAY);

    // Exact ID — the hole a ranking-layer filter leaves open.
    expect(await scopedGet(store, ids.PAY, QUILL)).toEqual({ ok: false, reason: "not_found_in_scope" });

    // Including retired and archived records does not open a back door.
    const withRetired = await scopedQuery(store, QUILL, { include_retired: true, include_archived: true });
    expect(withRetired.admitted.map((r) => r.record_id)).not.toContain(ids.PAY);
  });

  it("A14 (NEGATIVE) — an unauthorized scope and an unauthorized repository both return zero", async () => {
    const { store, QUILL, RID_7F2A, RID_9C31, TNT_OTHER } = await seed();
    const payments = await scopedQuery(store, { ...QUILL, query: { tenant: TNT, repo: RID_7F2A, path: "services/payments" } });
    expect(payments.admitted).toEqual([]);
    expect(payments.outcome).toBe("no_in_scope_evidence");

    const otherRepo = await scopedQuery(store, { ...QUILL, query: { tenant: TNT, repo: RID_9C31 } });
    expect(otherRepo.admitted).toEqual([]);

    const otherTenant = await scopedQuery(store, { ...QUILL, query: { tenant: TNT_OTHER, repo: RID_7F2A } });
    expect(otherTenant.admitted).toEqual([]);
  });

  it("A19 (NEGATIVE) — unauthorized payload bytes reach no context packet", async () => {
    const { store, ids, QUILL } = await seed();
    const out = await scopedQuery(store, QUILL);
    const packet = buildPacket(
      out.admitted.map((r) => ({
        record: {
          id: r.record_id,
          version: r.version,
          version_digest: r.version_digest,
          title: String(r.body.summary ?? r.body.statement ?? ""),
          body: String(r.body.rationale ?? r.body.statement ?? ""),
          scope_label: String(r.scope.path ?? ""),
          evidence_class: r.evidence_class,
          lifecycle: classifyLegacy("active"),
        },
        tier: "governing" as const,
        role: "optional" as const,
      })),
      { budget_tokens: 100000 },
    );
    expect(packet.text).not.toContain("payments record");
    expect(packet.text).not.toContain("different scope");
    expect(packet.selected).not.toContain(ids.PAY);
  });

  it("A24/A28 (P) — the genuine ruling DOES qualify inside its own scope", async () => {
    const { store, ids, RID_7F2A } = await seed();
    const mira = (await store.get(ids.MIRA))!;
    expect(mira.evidence_class).toBe("human_ruling");
    expect(qualifies(mira, { tenant: TNT, repo: RID_7F2A, path: "services/ledger" })).toEqual({ ok: true });
    // ...and deeper inside it, since a broad statement covers narrower scopes.
    expect(qualifies(mira, { tenant: TNT, repo: RID_7F2A, path: "services/ledger/posting" }).ok).toBe(true);
  });

  it("A29 (NEGATIVE) — the genuine ruling does NOT travel outside its own repository or scope", async () => {
    const { store, ids, RID_7F2A, RID_9C31 } = await seed();
    const mira = (await store.get(ids.MIRA))!;
    // Another repository.
    const crossRepo = qualifies(mira, { tenant: TNT, repo: RID_9C31, path: "services/ledger" });
    expect(crossRepo.ok).toBe(false);
    expect(crossRepo.reason).toBe("out_of_scope");
    // A sibling scope in the same repository.
    const sibling = qualifies(mira, { tenant: TNT, repo: RID_7F2A, path: "services/payments" });
    expect(sibling.ok).toBe(false);
    expect(sibling.reason).toBe("out_of_scope");
    // A similarly-named scope: services/ledger must not cover services/ledgerx.
    expect(qualifies(mira, { tenant: TNT, repo: RID_7F2A, path: "services/ledgerx" }).ok).toBe(false);
  });

  it("A15 (NEGATIVE, cross-tenant) — a query naming another tenant yields nothing from this one", async () => {
    const { store, QUILL, RID_7F2A } = await seed();
    const other = mintTenantId();
    const out = await scopedQuery(store, {
      ...QUILL,
      authorized: [{ tenant: other, repo: RID_7F2A }],
      query: { tenant: other, repo: RID_7F2A },
    });
    expect(out.admitted).toEqual([]);
  });

  it("A31 — order independence: the same reads over a second store give the same membership", async () => {
    const a = await seed();
    const b = await seed();
    const ra = (await scopedQuery(a.store, a.QUILL)).admitted.length;
    const rb = (await scopedQuery(b.store, b.QUILL)).admitted.length;
    expect(ra).toBe(rb);
  });

  it("CONTROL scope-filter-off: A13 flips — the unauthorized record becomes retrievable by exact ID", async () => {
    const { store, ids, QUILL } = await seed();
    const leaked = await scopedGet(store, ids.PAY, { ...QUILL, disable: { scope_filter_off: true } });
    expect(leaked.ok).toBe(true);
  });

  it.todo("A1-A11 (four independently diagnosable denial codes, admitted-vs-denied dispositions, duplicate reconciliation, event-id/bytes conflict): lane 02's admission surface");
  it.todo("A17/A18/A20/A21 (rejection receipts, five independently observable delivery states, retained attempt records with byte-identical payloads): lane 02/03's surfaces");
  it.todo("A23/A25-A27/A30 (action-qualification verdicts per denial axis, no privilege accretion): lane 05's action gate");
});
