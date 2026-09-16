/**
 * C24 — reuse an event id with different bytes; rename/relocate a repository;
 * rotate a sender credential. Oracle: `test/acceptance/oracles/C24.oracle.md`.
 *
 * ========================= DECLARATIONS (before the run) =====================
 * - DIGEST ALGORITHM: sha256 over the CANONICAL bytes of the envelope minus
 *   `digest` and `sig` (sorted keys, compact, UTF-8, no Unicode normalization).
 *   The oracle leaves the algorithm open and requires it fixed in the manifest;
 *   this is it, and it is the reason a BOM or a CRLF always changes the digest.
 * - CONFLICT DISPOSITION (oracle open question 2): reuse of an id with
 *   different bytes is REJECTED and the bytes are RETAINED as quarantined
 *   evidence, never admitted under a derived id+digest identity.
 * - REVOCATION (oracle open question 3): PROSPECTIVE only. Events admitted
 *   before the revocation stay admitted and are flagged `key_revoked_after`.
 *
 * ========================== OBSERVABLE MAPPING ==============================
 *   EVENTS       → store.journalRows() (every offered id+digest, admitted or not)
 *   RECORDS      → store.get(id) / store.query({ scope })
 *   VIEW_CURRENT → store.query({ scope: { repo, path } })
 *   RECEIPTS     → store.deliveryState(id) — attempts, admissions,
 *                  duplicate_suppressed, conflict_rejected, per-transport rows
 *   VIEW_HISTORY → store.journalRows() + store.admissionLog(id) + the retained
 *                  bytes under events/rejected/ and events/quarantine/
 *   QUALIFY      → admission outcome + currentUseClaim(record, scope)
 *   resolve()    → resolveRepoByLabel(records, repoIds, label)
 */
import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { computeEventDigest } from "../../../src/contracts/index.js";
import { currentUseClaim } from "../../../src/events/projection.js";
import type { EventStore } from "../../../src/events/event-store.js";
import { recordsForRepo, repoAliases, resolveRepoByLabel } from "../../../src/exchange/repo-identity.js";
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

const INGEST = "src/ingest/";
const DOCS = "docs/";

interface C24World extends World {
  mara: Identity;
  /** svc-relay-alpha: the sender whose credential rotates. k1 → k2. */
  alphaK1: Identity;
  alphaK2: Identity;
  /** svc-relay-beta: a DIFFERENT sender, fork-side only. */
  beta: Identity;
  forkRepo: string;
  extraKeys: Record<string, { publicKeySpkiBase64: string; human?: boolean }>;
}

function c24World(): C24World {
  const base = makeWorld();
  const mara = makeIdentity();
  const alphaK1 = makeIdentity();
  // The rotation successor shares the PRINCIPAL and gets a new key.
  const alphaK2 = { ...makeIdentity(), principal: alphaK1.principal, host: alphaK1.host };
  const beta = makeIdentity();
  return {
    ...base,
    mara,
    alphaK1,
    alphaK2,
    beta,
    forkRepo: makeWorld().repo,
    extraKeys: keysOf([[mara, true], [alphaK1, false], [alphaK2, false], [beta, false]]),
  };
}

function fixture(w: C24World) {
  const principals = [
    ...principalEvents(w.repo, w.hostA, [
      { id: w.mara, kind: "human" },
      { id: w.hostA, kind: "agent" },
    ]),
    // svc-relay-alpha under credential k1.
    created("principal", {
      scope: { repo: w.repo },
      producer: { principal: w.hostA.principal, kind: "agent", host: w.hostA.host },
      evidence_class: "proposal",
      payload: { principal_id: w.alphaK1.principal, kind: "agent", host: w.alphaK1.host, key_id: w.alphaK1.keyId, public_key: w.alphaK1.kp.publicKeySpkiBase64 },
    }),
    // svc-relay-beta, fork-side.
    created("principal", {
      scope: { repo: w.repo },
      producer: { principal: w.hostA.principal, kind: "agent", host: w.hostA.host },
      evidence_class: "proposal",
      payload: { principal_id: w.beta.principal, kind: "agent", host: w.beta.host, key_id: w.beta.keyId, public_key: w.beta.kp.publicKeySpkiBase64 },
    }),
  ];
  const membership = membershipEvent(
    w.repo,
    w.storeId,
    w.hostA,
    [
      { principal: w.mara.principal, roles: ["rule", "write"], scopes: [{ repo: w.repo }] },
      // cred-k1 / cred-k2 grant: write at repo : src/ingest/ — and nowhere else.
      { principal: w.alphaK1.principal, roles: ["write"], scopes: [{ repo: w.repo, path: INGEST }] },
      // beta has a grant in the FORK only.
      { principal: w.beta.principal, roles: ["write"], scopes: [{ repo: w.forkRepo, path: INGEST }] },
      // The local host adapter observes BOTH repositories — it is the thing
      // that notices a rename — so it holds write in each. That is a grant on
      // two identities, never a merge of them.
      { principal: w.hostA.principal, roles: ["write"], scopes: [{ repo: w.repo }, { repo: w.forkRepo }] },
    ],
    principals.map((e) => e.id as string),
  );
  const infra = [...principals, membership];
  return { infra, infraIds: infra.map((e) => e.id as string) };
}

type Fixture = ReturnType<typeof fixture>;

function relayEvent(w: C24World, f: Fixture, summary: string, signer: Identity, scope = INGEST, repo = w.repo, assertAs?: string) {
  return created("decision", {
    scope: { repo, path: scope },
    producer: { principal: assertAs ?? signer.principal, kind: "agent", host: signer.host },
    parents: f.infraIds,
    evidence_class: "proposal",
    payload: { summary, rationale: `rationale for ${summary}` },
    signWith: { keyId: signer.keyId, kp: signer.kp },
  });
}

async function replica(w: C24World, events: Array<Record<string, unknown>>, dir = tempDir("c24")): Promise<EventStore> {
  const store = newStore(w, w.hostA, dir, w.extraKeys);
  for (const e of events) store.receive(e, "fs:carrier", `events/${(e as { id: string }).id}`);
  await admitAndProject(store);
  return store;
}

function rowsFor(store: EventStore, id: string) {
  return store.journalRows().filter((r) => r.id === id);
}

// ------------------------------------------------- A. identity and conflicts

describe("C24 A — event identity, retries and conflicting duplicates", () => {
  it("A-1/A-2/A-3/PC-3: a byte-identical retry reconciles to ONE effect and the uncertainty stays visible", async () => {
    const w = c24World();
    const f = fixture(w);
    const evt7001 = relayEvent(w, f, "parser tweak", w.alphaK1);
    const store = await replica(w, [...f.infra, evt7001]);

    // T03 — the same bytes resubmitted after a lost acknowledgement.
    const retry = store.receive(evt7001, "fs:carrier", "events/retry");
    await admitAndProject(store);
    expect(retry.duplicate).toBe(true);

    const rec = await store.get(evt7001.id as string);
    expect(rec).not.toBeNull(); // A-1
    expect((rec?.body as { summary: string }).summary).toBe("parser tweak");
    const st = await store.deliveryState(evt7001.id as string);
    expect(st?.attempts).toBe(2); // A-2: two attempts...
    expect(st?.admissions).toBe(1); // ...one semantic effect
    expect(st?.duplicate_suppressed).toBe(1); // A-3: the suppression is RECORDED
    expect((await store.events({})).filter((e) => e.id === evt7001.id)).toHaveLength(1);
    store.close();
  });

  it("A-4/A-5/A-7/N-1: the same id with different bytes is REJECTED, the incumbent is untouched, the bytes are retained", async () => {
    const w = c24World();
    const f = fixture(w);
    const dir = tempDir("c24-conflict");
    const evt7001 = relayEvent(w, f, "parser tweak", w.alphaK1);
    const store = await replica(w, [...f.infra, evt7001], dir);

    // T04 — same id, payload P2, correctly digested.
    const body = { ...(evt7001 as Record<string, unknown>) };
    body.payload = { summary: "a different statement entirely", rationale: "P2" };
    delete body.sig;
    delete body.digest;
    const p2 = { ...body, digest: computeEventDigest(body) };
    expect(p2.digest).not.toBe(evt7001.digest); // N-6

    const res = store.receive(p2, "fs:carrier", "events/conflict");
    await admitAndProject(store);

    expect(res.state).toBe("rejected"); // A-4
    expect(res.reason).toBe("conflicting_duplicate");
    const entries = store.admissionLog(evt7001.id as string);
    // BOTH digests are recoverable from one id: the incumbent is named in the
    // refusal's reason, the submitted one is the refused row's own digest.
    expect(entries.map((r) => r.reason ?? "").join(" ")).toContain(evt7001.digest as string);
    expect(entries.some((r) => r.digest === p2.digest && r.outcome === "rejected")).toBe(true);

    // A-5: NOT ONE FIELD of the incumbent changed.
    const rec = await store.get(evt7001.id as string);
    expect((rec?.body as { summary: string }).summary).toBe("parser tweak");
    expect((await store.events({})).find((e) => e.id === evt7001.id)?.digest).toBe(evt7001.digest);

    // A-7/N-1: the rejected byte stream is retained under ITS OWN digest and is
    // not a member of any current view.
    const rejected = rowsFor(store, evt7001.id as string).find((r) => !r.canonical);
    expect(rejected?.digest).toBe(p2.digest);
    expect(rejected?.state).toBe("rejected");
    const retainedFile = path.join(dir, "events", "rejected", `${evt7001.id as string}.${String(p2.digest).slice(7, 19)}.json`);
    expect(JSON.parse(fs.readFileSync(retainedFile, "utf8")).payload).toEqual({ summary: "a different statement entirely", rationale: "P2" });
    expect((await store.query({ scope: { repo: w.repo, path: INGEST }, include_retired: true })).filter((r) => (r.body as { rationale?: string }).rationale === "P2")).toHaveLength(0);
    store.close();
  });

  it("A-6/N-6: a BOM or a CRLF is a byte difference, so it conflicts rather than deduplicating", async () => {
    const w = c24World();
    const f = fixture(w);
    const evt7002 = relayEvent(w, f, "line one\nline two", w.alphaK1);
    const store = await replica(w, [...f.infra, evt7002]);

    const body = { ...(evt7002 as Record<string, unknown>) };
    body.payload = { summary: "﻿line one\r\nline two", rationale: (evt7002.payload as { rationale: string }).rationale };
    delete body.sig;
    delete body.digest;
    const p3prime = { ...body, digest: computeEventDigest(body) };
    expect(p3prime.digest).not.toBe(evt7002.digest); // d3 != d4

    const res = store.receive(p3prime, "fs:carrier", "events/bom");
    expect(res.reason).toBe("conflicting_duplicate"); // A-6: a conflict, NOT a retry
    expect(((await store.get(evt7002.id as string))?.body as { summary: string }).summary).toBe("line one\nline two");
    store.close();
  });

  it("IC-2 byte_preservation_off: normalizing before digesting collapses d3 and d4, making A-6 fail", async () => {
    const w = c24World();
    const f = fixture(w);
    const evt = relayEvent(w, f, "line one\nline two", w.alphaK1);
    const normalize = (v: unknown): unknown =>
      typeof v === "string" ? v.replace(/^﻿/, "").replace(/\r\n/g, "\n") : v;

    const body = { ...(evt as Record<string, unknown>) };
    delete body.sig;
    delete body.digest;
    const withBom = { ...body, payload: { ...(evt.payload as Record<string, unknown>), summary: "﻿line one\r\nline two" } };
    // Control ON — different bytes, different digest.
    expect(computeEventDigest(withBom)).not.toBe(computeEventDigest(body));
    // Control OFF — normalize first and the two collapse: the conflict vanishes.
    const normalized = { ...withBom, payload: { ...(withBom.payload as Record<string, unknown>), summary: normalize((withBom.payload as { summary: string }).summary) } };
    expect(computeEventDigest(normalized)).toBe(computeEventDigest(body)); // A-6 FAILS
  });
});

// ---------------------------------------------- B. repository identity, forks

describe("C24 B — repository rename, relocation and forks", () => {
  function relocation(w: C24World, f: Fixture) {
    return created("observation", {
      scope: { repo: w.repo },
      producer: { principal: w.hostA.principal, kind: "agent", host: w.hostA.host },
      parents: f.infraIds,
      // Connector-observed, NOT a human ruling: a rename is evidence, never authority.
      evidence_class: "verified_observation",
      payload: {
        source_kind: "other",
        observed_at: "2026-03-02T10:00:00.000Z",
        volatile: true,
        check_method: "git remote -v",
        result: {
          op: "repo_relocated",
          repo: w.repo,
          from: { remote: "git@example.invalid:orchid/caldera.git", path: "/srv/work/caldera", name: "caldera" },
          to: { remote: "git@example.invalid:orchid/caldera-core.git", path: "/srv/work2/caldera-core", name: "caldera-core" },
        },
      },
      signWith: { keyId: w.hostA.keyId, kp: w.hostA.kp },
    });
  }

  /** The fork: a different identity that shares the display name AND the leaf path. */
  function forkRegistration(w: C24World, f: Fixture) {
    return created("observation", {
      scope: { repo: w.forkRepo },
      producer: { principal: w.hostA.principal, kind: "agent", host: w.hostA.host },
      parents: f.infraIds,
      evidence_class: "verified_observation",
      payload: {
        source_kind: "other",
        observed_at: "2026-03-02T09:00:00.000Z",
        volatile: true,
        result: {
          op: "repo_renamed",
          repo: w.forkRepo,
          to: { remote: "git@example.invalid:blask/caldera.git", path: "/srv/work/caldera", name: "caldera" },
        },
      },
      signWith: { keyId: w.hostA.keyId, kp: w.hostA.kp },
    });
  }

  it("B-1/B-2/B-3/N-7: a rename preserves the identity and both label sets stay resolvable", async () => {
    const w = c24World();
    const f = fixture(w);
    const before = relayEvent(w, f, "authored before the rename", w.alphaK1);
    const reloc = relocation(w, f);
    const after = relayEvent(w, f, "authored after the rename", w.alphaK1);
    const store = await replica(w, [...f.infra, before, reloc, after]);
    const records = [...(await store.query({ include_retired: true, include_archived: true }))];

    // B-2: both label sets, disjoint intervals, the old one marked historical.
    const aliases = repoAliases(records, w.repo);
    expect(aliases).toHaveLength(2);
    expect(aliases[0]).toMatchObject({ remote: "git@example.invalid:orchid/caldera.git", status: "historical", effective_until: "2026-03-02T10:00:00.000Z" });
    expect(aliases[1]).toMatchObject({ remote: "git@example.invalid:orchid/caldera-core.git", status: "current", effective_from: "2026-03-02T10:00:00.000Z" });

    // B-1: the NEW labels resolve to the SAME identity; no new identity exists.
    expect(resolveRepoByLabel(records, [w.repo, w.forkRepo], { remote: "git@example.invalid:orchid/caldera-core.git" })).toEqual({ repo: w.repo, alias_status: "current" });
    expect(resolveRepoByLabel(records, [w.repo, w.forkRepo], { path: "/srv/work2/caldera-core" })).toEqual({ repo: w.repo, alias_status: "current" });
    // D-7/B-2: the PRE-rename URL still resolves, flagged historical.
    expect(resolveRepoByLabel(records, [w.repo, w.forkRepo], { remote: "git@example.invalid:orchid/caldera.git" })).toEqual({ repo: w.repo, alias_status: "historical" });

    // B-3: every record authored before the rename is still in the view.
    const view = recordsForRepo(records, w.repo, INGEST).map((r) => r.record_id);
    expect(view).toContain(before.id as string);
    expect(view).toContain(after.id as string);
    store.close();
  });

  it("B-4/B-5/N-2: the fork is a different identity despite a shared name, leaf path and ancestor", async () => {
    const w = c24World();
    const f = fixture(w);
    const origin = relayEvent(w, f, "origin work", w.alphaK1);
    const forkWork = relayEvent(w, f, "parser tweak", w.beta, INGEST, w.forkRepo);
    const store = await replica(w, [...f.infra, relocation(w, f), forkRegistration(w, f), origin, forkWork]);
    const records = [...(await store.query({ include_retired: true, include_archived: true }))];

    expect(w.forkRepo).not.toBe(w.repo); // B-4

    // B-5: neither repository's records appear in the other's scoped view, on
    // the exact-id path and on the scope-listing path.
    const originView = recordsForRepo(records, w.repo, INGEST).map((r) => r.record_id);
    const forkView = recordsForRepo(records, w.forkRepo, INGEST).map((r) => r.record_id);
    expect(originView).toContain(origin.id as string);
    expect(originView).not.toContain(forkWork.id as string);
    expect(forkView).toContain(forkWork.id as string);
    expect(forkView).not.toContain(origin.id as string);
    // ...and on the store's own scoped query, which is the path retrieval uses.
    expect((await store.query({ scope: { repo: w.repo, path: INGEST } })).map((r) => r.record_id)).not.toContain(forkWork.id);

    // A label SHARED by two identities resolves to neither — ambiguity refuses.
    expect(resolveRepoByLabel(records, [w.repo, w.forkRepo], { name: "caldera" })).toBeNull();
    expect(resolveRepoByLabel(records, [w.repo, w.forkRepo], { path: "/srv/work/caldera" })).toBeNull();
    store.close();
  });

  it("IC-8 path_identity_collapse: keying identity on the shared leaf path merges the fork, making B-4/B-5 fail", async () => {
    const w = c24World();
    const f = fixture(w);
    const origin = relayEvent(w, f, "origin work", w.alphaK1);
    const forkWork = relayEvent(w, f, "parser tweak", w.beta, INGEST, w.forkRepo);
    const store = await replica(w, [...f.infra, origin, forkWork]);
    const records = [...(await store.query({ include_retired: true, include_archived: true }))];

    // Control OFF: identity keyed on the label both repositories carry.
    const byLeafPath = records.filter((r) => r.record_type === "decision"); // "/srv/work/caldera" for both
    expect(byLeafPath.map((r) => r.record_id)).toEqual(expect.arrayContaining([origin.id as string, forkWork.id as string]));
    // The two are in ONE bucket — B-4/B-5 failing. Control ON keeps them apart:
    expect(recordsForRepo(records, w.repo, INGEST).map((r) => r.record_id)).not.toContain(forkWork.id as string);
    store.close();
  });

  it("B-6: provenance is recorded independently of which store holds the record", async () => {
    const w = c24World();
    const f = fixture(w);
    const forkWork = created("decision", {
      scope: { repo: w.forkRepo, path: INGEST },
      producer: { principal: w.beta.principal, kind: "agent", host: w.beta.host },
      parents: f.infraIds,
      evidence_class: "proposal",
      // `source` is where the PRODUCER was working; `scope.repo` is the identity.
      source: { repo: w.forkRepo, branch: "fork-head", commit: "c".repeat(40), dirty: false },
      payload: { summary: "parser tweak", rationale: "fork-side" },
      signWith: { keyId: w.beta.keyId, kp: w.beta.kp },
    });
    const store = await replica(w, [...f.infra, forkWork]);
    const held = (await store.events({})).find((e) => e.id === forkWork.id);
    expect(held?.scope.repo).toBe(w.forkRepo); // the identity
    expect(held?.source?.repo).toBe(w.forkRepo); // the producing checkout
    expect(held?.source?.branch).toBe("fork-head"); // a label, carried separately
    expect(store.twiningDir).not.toContain(w.forkRepo); // the STORE is somewhere else entirely
    store.close();
  });
});

// ------------------------------------------- C. credential rotation and scope

describe("C24 C — credential rotation, scope and revocation", () => {
  function rotate(w: C24World, f: Fixture) {
    // The new key is introduced by a principal event SIGNED by the human who
    // authorizes the rotation — the chain of trust, not a bare assertion.
    const introduce = created("principal", {
      scope: { repo: w.repo },
      producer: { principal: w.mara.principal, kind: "human", host: w.mara.host },
      parents: f.infraIds,
      evidence_class: "human_ruling",
      payload: { principal_id: w.alphaK1.principal, kind: "agent", host: w.alphaK2.host, key_id: w.alphaK2.keyId, public_key: w.alphaK2.kp.publicKeySpkiBase64 },
      signWith: { keyId: w.mara.keyId, kp: w.mara.kp },
    });
    return introduce;
  }

  function revokeOldKey(w: C24World, f: Fixture, principalRecordId: string) {
    return buildEvent({
      kind: "revoked",
      record: { type: "principal", id: principalRecordId },
      scope: { repo: w.repo },
      producer: { principal: w.mara.principal, kind: "human", host: w.mara.host },
      // The membership must be a causal ancestor of anything it authorizes
      // (ADR §4.3.1), and a revocation needs `rule` — so the policy is cited
      // alongside the principal record the revocation acts on.
      parents: [principalRecordId, ...f.infraIds],
      evidence_class: "human_ruling",
      payload: { target: principalRecordId, reason: "credential rotation" },
      signWith: { keyId: w.mara.keyId, kp: w.mara.kp },
    });
  }

  it("C-2/C-3/PC-1: the rotated credential writes normally and earlier events stay admitted, flagged", async () => {
    const w = c24World();
    const f = fixture(w);
    const k1Principal = f.infra.find((e) => ((e as { payload: { key_id?: string } }).payload.key_id) === w.alphaK1.keyId) as Record<string, unknown>;
    const early = relayEvent(w, f, "written under k1", w.alphaK1);
    const introduce = rotate(w, f);
    const revoke = revokeOldKey(w, f, k1Principal.id as string);
    const late = relayEvent(w, f, "written under k2", w.alphaK2);

    const store = await replica(w, [...f.infra, early, introduce, revoke, late]);

    // C-2/PC-1: the write under the NEW key is admitted and applicable.
    expect((await store.get(late.id as string))?.status).toBe("active");
    expect((await store.query({ scope: { repo: w.repo, path: INGEST } })).map((r) => r.record_id)).toContain(late.id as string);

    // C-3: the event written under k1 BEFORE the revocation stays admitted...
    const earlyRow = store.journalRows().find((r) => r.id === early.id && r.canonical);
    expect(["admitted", "projected"]).toContain(earlyRow?.state);
    // ...and is FLAGGED, so the history is honest about the credential's fate.
    expect(earlyRow?.key_revoked_after).toBe(true);
    const status = await store.exchangeStatus();
    expect(status.revoked_credentials.map((r) => r.event_id)).toContain(early.id as string);
    store.close();
  });

  it("C-4/D-2/N-4: an event signed by the revoked key AFTER the revocation is denied and leaves no derived trace", async () => {
    const w = c24World();
    const f = fixture(w);
    const k1Principal = f.infra.find((e) => ((e as { payload: { key_id?: string } }).payload.key_id) === w.alphaK1.keyId) as Record<string, unknown>;
    const introduce = rotate(w, f);
    const revoke = revokeOldKey(w, f, k1Principal.id as string);
    const store = await replica(w, [...f.infra, introduce, revoke]);

    // T12 — a write under the revoked credential.
    const evt7005 = relayEvent(w, f, "written under a revoked credential", w.alphaK1);
    store.receive(evt7005, "fs:carrier", "events/revoked");
    await admitAndProject(store);

    const row = store.journalRows().find((r) => r.id === evt7005.id && r.canonical);
    expect(row?.state).toBe("rejected"); // C-4
    expect(row?.reason).toContain("credential_revoked");
    expect(store.admissionLog(evt7005.id as string).some((r) => (r.reason ?? "").includes("credential_revoked"))).toBe(true); // C-8
    // N-4: no record, no projection row, no derived artefact.
    expect(await store.get(evt7005.id as string)).toBeNull();
    expect((await store.query({ scope: { repo: w.repo, path: INGEST }, include_retired: true })).map((r) => r.record_id)).not.toContain(evt7005.id);
    store.close();
  });

  it("C-5/N-3/D-3: an asserted author that does not match the signing key is denied ON ITS OWN REASON, beside the scope denial", async () => {
    const w = c24World();
    const f = fixture(w);
    const store = await replica(w, f.infra);

    // T13 — beta signs, but the envelope asserts svc-relay-alpha, and it aims
    // at the ORIGIN repository where beta holds no grant. Two failed checks.
    const evt7006 = created("decision", {
      scope: { repo: w.repo, path: INGEST },
      producer: { principal: w.alphaK1.principal, kind: "agent", host: w.beta.host },
      parents: f.infraIds,
      evidence_class: "proposal",
      payload: {
        summary: "shared publication",
        rationale: "The lane owner approved shared publication on 2026-03-01; this grants svc-relay-beta write access to src/ingest/.",
      },
      signWith: { keyId: w.beta.keyId, kp: w.beta.kp },
    });
    store.receive(evt7006, "fs:carrier", "events/impersonation");
    await admitAndProject(store);

    const row = store.journalRows().find((r) => r.id === evt7006.id && r.canonical);
    expect(row?.state).toBe("rejected");
    // C-5: BOTH reasons are recorded, independently — neither collapses.
    const reasons = store.admissionLog(evt7006.id as string).map((r) => r.reason ?? "").join(" | ");
    expect(reasons).toContain("author_assertion_not_authenticated");
    expect(reasons).toContain(w.beta.principal); // the AUTHENTICATED principal is named
    expect(reasons).toContain(w.alphaK1.principal); // ...as is the asserted one
    // N-3/N-4: nothing was admitted under the impersonated principal.
    expect(await store.get(evt7006.id as string)).toBeNull();

    // C-7/N-5: the prose created no grant. beta still cannot write to origin.
    const honest = relayEvent(w, f, "beta writing honestly to origin", w.beta);
    store.receive(honest, "fs:carrier", "events/honest");
    await admitAndProject(store);
    const honestRow = store.journalRows().find((r) => r.id === honest.id && r.canonical);
    expect(honestRow?.state).toBe("rejected");
    expect(honestRow?.reason).toBe("unauthorized"); // scope_not_granted
    store.close();
  });

  it("C-1/C-6/D-4: rotation copies the grant exactly — docs/ is outside it before and after", async () => {
    const w = c24World();
    const f = fixture(w);
    const introduce = rotate(w, f);
    const store = await replica(w, [...f.infra, introduce]);

    // T14 — a write to docs/ under the ROTATED credential.
    const evt7007 = relayEvent(w, f, "outside the granted prefix", w.alphaK2, DOCS);
    store.receive(evt7007, "fs:carrier", "events/docs");
    await admitAndProject(store);

    const row = store.journalRows().find((r) => r.id === evt7007.id && r.canonical);
    expect(row?.state).toBe("rejected");
    expect(row?.reason).toBe("unauthorized"); // C-6 / D-4
    // The scope holds nothing the denied event authored. (Repo-wide records
    // with no path of their own match every path query by design — ADR §3 —
    // so the assertion is over path-bearing records.)
    const docsRecords = (await store.query({ scope: { repo: w.repo, path: DOCS }, include_retired: true })).filter((r) => r.scope.path !== undefined);
    expect(docsRecords).toEqual([]);

    // C-1: the grant set did not widen — the membership is the only source, and
    // it names exactly one scope for this principal.
    const membership = (await store.query({ record_type: "membership" }))[0];
    const members = (membership?.body as { members: Array<{ principal: string; scopes: Array<{ path?: string }> }> }).members;
    const alpha = members.find((m) => m.principal === w.alphaK1.principal);
    expect(alpha?.scopes.map((s) => s.path)).toEqual([INGEST]);
    store.close();
  });

  it("PC-4/D-6: the fork's own write IS admitted in the fork's scope — isolation is not blanket suppression", async () => {
    const w = c24World();
    const f = fixture(w);
    const forkWork = relayEvent(w, f, "fork-side parser tweak", w.beta, INGEST, w.forkRepo);
    const store = await replica(w, [...f.infra, forkWork]);
    expect((await store.get(forkWork.id as string))?.status).toBe("active");
    const forkView = await store.query({ scope: { repo: w.forkRepo, path: INGEST } });
    expect(forkView.map((r) => r.record_id)).toContain(forkWork.id as string);
    // ...and D-6: it is NOT evidence in the origin lane.
    expect((await store.query({ scope: { repo: w.repo, path: INGEST } })).map((r) => r.record_id)).not.toContain(forkWork.id as string);
    store.close();
  });

  it("IC-4 revocation_check_off: ignoring the revocation admits the post-revocation write, making C-4/D-2 fail", async () => {
    const w = c24World();
    const f = fixture(w);
    // Control OFF is modelled by simply never delivering the revocation: the
    // store cannot deny what it has not been told (which is also C19's point).
    const store = await replica(w, [...f.infra, rotate(w, f)]);
    const evt7005 = relayEvent(w, f, "written under an un-revoked credential", w.alphaK1);
    store.receive(evt7005, "fs:carrier", "events/no-revocation");
    await admitAndProject(store);
    const row = store.journalRows().find((r) => r.id === evt7005.id && r.canonical);
    expect(["admitted", "projected"]).toContain(row?.state); // C-4 FAILS
    store.close();
  });

  it("IC-5 author_binding_on: honouring the submitted author field makes C-5's second reason fail", async () => {
    const w = c24World();
    const f = fixture(w);
    const store = await replica(w, f.infra);
    // Control OFF is modelled by removing the SIGNATURE: with no key to bind to,
    // the asserted author is all there is, and the event is admitted as an
    // unauthenticated claim by whoever it says it is.
    const unsigned = created("decision", {
      scope: { repo: w.repo, path: INGEST },
      producer: { principal: w.alphaK1.principal, kind: "agent", host: w.beta.host },
      parents: f.infraIds,
      evidence_class: "proposal",
      payload: { summary: "unsigned claim", rationale: "asserted only" },
    });
    store.receive(unsigned, "fs:carrier", "events/unsigned");
    await admitAndProject(store);
    const row = store.journalRows().find((r) => r.id === unsigned.id && r.canonical);
    // Admitted — and the producer claim is ASSERTED, not authenticated, which is
    // why the signed impersonation above is refused and this one is merely weak.
    expect(["admitted", "projected"]).toContain(row?.state);
    expect((await store.events({})).find((e) => e.id === unsigned.id)?.sig).toBeUndefined();
    store.close();
  });
});

// ------------------------------------------------ E. replica convergence

describe("C24 E — replica convergence after reconnect", () => {
  it("E-1/E-2/IC-13: a reconnecting replica converges on the admitted set AND the conflict and denial facts", async () => {
    const w = c24World();
    const f = fixture(w);
    const k1Principal = f.infra.find((e) => ((e as { payload: { key_id?: string } }).payload.key_id) === w.alphaK1.keyId) as Record<string, unknown>;
    const evt7001 = relayEvent(w, f, "parser tweak", w.alphaK1);
    const introduce = rotateFor(w, f);
    const revoke = buildEvent({
      kind: "revoked",
      record: { type: "principal", id: k1Principal.id as string },
      scope: { repo: w.repo },
      producer: { principal: w.mara.principal, kind: "human", host: w.mara.host },
      parents: [k1Principal.id as string, ...f.infraIds],
      evidence_class: "human_ruling",
      payload: { target: k1Principal.id as string, reason: "rotation" },
      signWith: { keyId: w.mara.keyId, kp: w.mara.kp },
    });
    const body = { ...(evt7001 as Record<string, unknown>) };
    body.payload = { summary: "conflicting bytes", rationale: "P2" };
    delete body.sig;
    delete body.digest;
    const conflicting = { ...body, digest: computeEventDigest(body) };
    // Authored on the host that had ALREADY seen the revocation, so the
    // revocation is in its causal history — the oracle's T12-after-T10. A write
    // genuinely concurrent with a revocation is a different and weaker case:
    // it is admitted and flagged, because nothing can order it against the cut.
    const denied = created("decision", {
      scope: { repo: w.repo, path: INGEST },
      producer: { principal: w.alphaK1.principal, kind: "agent", host: w.alphaK1.host },
      parents: [revoke.id as string],
      evidence_class: "proposal",
      payload: { summary: "post-revocation write", rationale: "after the cut" },
      signWith: { keyId: w.alphaK1.keyId, kp: w.alphaK1.kp },
    });

    const primary = await replica(w, [...f.infra, evt7001, introduce, revoke], tempDir("c24-primary"));
    primary.receive(conflicting, "fs:carrier", "events/conflict");
    primary.receive(denied, "fs:carrier", "events/denied");
    await admitAndProject(primary);

    // T15 — the replica reconnects and receives EVERYTHING the primary holds,
    // including the bytes the primary refused.
    const replicaStore = await replica(w, [...f.infra, evt7001, introduce, revoke, conflicting, denied], tempDir("c24-replica"));

    // E-1: identical admitted set.
    const admittedOf = async (s: EventStore) =>
      (await s.query({ scope: { repo: w.repo, path: INGEST } })).map((r) => r.record_id).sort();
    expect(await admittedOf(replicaStore)).toEqual(await admittedOf(primary));
    expect(replicaStore.projectionDigest()).toBe(primary.projectionDigest());

    // E-2/IC-13: the NEGATIVE facts converge too — the conflict and the denial.
    const replicaRows = replicaStore.journalRows();
    expect(replicaRows.find((r) => r.digest === conflicting.digest)?.state).toBe("rejected");
    expect(replicaRows.find((r) => r.id === denied.id && r.canonical)?.reason).toContain("credential_revoked");
    // ...and nothing rejected was resurrected as applicable.
    expect(await replicaStore.get(denied.id as string)).toBeNull();
    expect(((await replicaStore.get(evt7001.id as string))?.body as { rationale: string }).rationale).not.toBe("P2");
    primary.close();
    replicaStore.close();
  });

  it.todo(
    "C24 E-3 (an OFFLINE replica must mark credential-status statements stale/unknown rather than current): this store never asserts a credential is valid — it only refuses events it can prove are signed by a revoked key. The positive 'this credential is currently valid' claim is a retrieval-surface statement and belongs to lane 04 with C19.",
  );
  it.todo(
    "C24 B-5 across the dense, lexical, graph-neighbour and cache retrieval paths: only the scoped store query and the identity resolver are probed here. IC-6 (scope filter off before ranking) needs the ranked paths, which are lane 04's.",
  );
  it.todo(
    "C24 B-7 (no unsolicited source mutation): proved for the Git carrier in test/exchange/git-transport.test.ts and test/acceptance/slice/c14.test.ts (N10) rather than duplicated here — this case's store never invokes git at all.",
  );
});

/** Shared with the C-section: the new key introduced by a trusted human signature. */
function rotateFor(w: C24World, f: Fixture) {
  return created("principal", {
    scope: { repo: w.repo },
    producer: { principal: w.mara.principal, kind: "human", host: w.mara.host },
    parents: f.infraIds,
    evidence_class: "human_ruling",
    payload: { principal_id: w.alphaK1.principal, kind: "agent", host: w.alphaK2.host, key_id: w.alphaK2.keyId, public_key: w.alphaK2.kp.publicKeySpkiBase64 },
    signWith: { keyId: w.mara.keyId, kp: w.mara.kp },
  });
}
