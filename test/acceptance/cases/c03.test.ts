/**
 * C03 — "Three consumers, three different prerequisites."
 *
 * "Recover each consumer's own prerequisite and evidence. No one global rule;
 * a missing acceptance remains missing."
 *
 * This is the case the `consumer` scope component exists for. Lane 04's half:
 * a query for one consumer must recover THAT consumer's prerequisite and not
 * another's, a prerequisite that has no satisfying evidence stays visibly
 * unsatisfied rather than being filled in from a neighbour, and no global rule
 * is synthesised from the three.
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
import { qualifies } from "../../../src/retrieval/lifecycle.js";
import { buildPacket, type PacketItem } from "../../../src/retrieval/packet.js";
import { classify } from "../../../src/retrieval/lifecycle.js";
import type { SliceProjectedRecord } from "../../../src/events/projection.js";

afterAll(cleanupTempDirs);

const T = mintTenantId();
const C_REVIEW = "consumer-catalog-output-review";
const C_CATALOG = "consumer-catalog-only-acceptance";
const C_FULL = "consumer-full-story-acceptance";

async function seed() {
  const world = makeWorld();
  const REPO = world.repo;
  const store = newStore(world, world.hostA);
  const human = { principal: world.human.principal, kind: "human" as const, host: world.human.host };
  const agent = { principal: world.hostA.principal, kind: "agent" as const, host: world.hostA.host };

  const prereq = (consumer: string, key: string) =>
    created("ruling", {
      scope: { tenant: T, repo: REPO, path: "svc/pipeline", consumer },
      producer: human,
      evidence_class: "human_ruling",
      signWith: { keyId: world.human.keyId, kp: world.human.kp },
      payload: { statement: `${consumer} requires ${key}`, requirements: [{ key, value: "required" }] },
    });

  const P_REVIEW = prereq(C_REVIEW, "catalog_output_review");
  const P_CATALOG = prereq(C_CATALOG, "catalog_only_acceptance");
  const P_FULL = prereq(C_FULL, "full_story_acceptance");

  // Evidence satisfying TWO of the three. The third stays missing on purpose.
  const E_REVIEW = created("observation", {
    scope: { tenant: T, repo: REPO, path: "svc/pipeline", consumer: C_REVIEW },
    producer: agent,
    evidence_class: "verified_observation",
    // `observationBodySchema` is STRICT and names its own fields: the check
    // method and its result are `check_method` / `result`, not free-form keys.
    payload: {
      source_kind: "cli_render",
      check_method: "catalog-output-review",
      result: { outcome: "passed" },
      observed_at: "2026-09-15T09:00:00.000Z",
      volatile: false,
    },
  });
  const E_CATALOG = created("observation", {
    scope: { tenant: T, repo: REPO, path: "svc/pipeline", consumer: C_CATALOG },
    producer: agent,
    evidence_class: "verified_observation",
    payload: {
      source_kind: "cli_render",
      check_method: "catalog-only-acceptance",
      result: { outcome: "accepted" },
      observed_at: "2026-09-15T09:05:00.000Z",
      volatile: false,
    },
  });
  // NO evidence for C_FULL.

  const POLICY = policyEvents(
      world,
      [
        { principal: world.human.principal, roles: ["rule"], scopes: [{ repo: REPO }] },
        { principal: world.hostA.principal, roles: ["write"], scopes: [{ repo: REPO }] },
      ],
      world.hostA,
    );
  deliverUnderPolicy(store, world, POLICY, [
    P_REVIEW,
    P_CATALOG,
    P_FULL,
    E_REVIEW,
    E_CATALOG,
  ]);
  await admitAndProject(store);

  const id = (e: unknown): string => (e as { record: { id: string } }).record.id;
  return {
    store,
    REPO,
    ids: {
      P_REVIEW: id(P_REVIEW),
      P_CATALOG: id(P_CATALOG),
      P_FULL: id(P_FULL),
      E_REVIEW: id(E_REVIEW),
      E_CATALOG: id(E_CATALOG),
    },
  };
}

function forConsumer(REPO: string, consumer: string) {
  return requestFor(
    consumer,
    [{ tenant: T, repo: REPO }],
    { tenant: T, repo: REPO, path: "svc/pipeline", consumer },
  );
}

function asItem(r: SliceProjectedRecord, role: PacketItem["role"]): PacketItem {
  return {
    record: {
      id: r.record_id,
      version: r.version,
      version_digest: r.version_digest,
      title: String(r.body.statement ?? r.body.check_method ?? ""),
      body: JSON.stringify(r.body),
      scope_label: `${r.scope.path}@${r.scope.consumer ?? "-"}`,
      evidence_class: r.evidence_class,
      lifecycle: classify(r),
    },
    tier: "governing",
    role,
  };
}

describe("C03 — three consumers, three different prerequisites", () => {
  it("LIVENESS: all five records projected", async () => {
    const { store, ids } = await seed();
    const projected = new Set((await store.query({})).map((r) => r.record_id));
    for (const [n, id] of Object.entries(ids)) expect(projected.has(id), `${n} not projected`).toBe(true);
  });

  it("each consumer recovers its OWN prerequisite and not another's", async () => {
    const { store, ids, REPO } = await seed();

    const review = (await scopedQuery(store, forConsumer(REPO, C_REVIEW))).admitted.map((r) => r.record_id);
    expect(review).toContain(ids.P_REVIEW);
    expect(review).not.toContain(ids.P_CATALOG);
    expect(review).not.toContain(ids.P_FULL);

    const catalog = (await scopedQuery(store, forConsumer(REPO, C_CATALOG))).admitted.map((r) => r.record_id);
    expect(catalog).toContain(ids.P_CATALOG);
    expect(catalog).not.toContain(ids.P_REVIEW);

    const full = (await scopedQuery(store, forConsumer(REPO, C_FULL))).admitted.map((r) => r.record_id);
    expect(full).toContain(ids.P_FULL);
    expect(full).not.toContain(ids.P_CATALOG);
  });

  it("each consumer recovers its OWN evidence, never a neighbour's", async () => {
    const { store, ids, REPO } = await seed();
    const review = (await scopedQuery(store, forConsumer(REPO, C_REVIEW))).admitted.map((r) => r.record_id);
    expect(review).toContain(ids.E_REVIEW);
    expect(review).not.toContain(ids.E_CATALOG);
  });

  it("NEGATIVE — a missing acceptance REMAINS missing: nothing is borrowed from the satisfied consumers", async () => {
    const { store, ids, REPO } = await seed();
    const full = await scopedQuery(store, forConsumer(REPO, C_FULL));
    const got = full.admitted.map((r) => r.record_id);
    // The prerequisite is there...
    expect(got).toContain(ids.P_FULL);
    // ...and no evidence at all is, because none exists for this consumer.
    expect(got).not.toContain(ids.E_REVIEW);
    expect(got).not.toContain(ids.E_CATALOG);
    expect(got.filter((id) => id === ids.E_REVIEW || id === ids.E_CATALOG)).toEqual([]);
  });

  it("the missing prerequisite is VISIBLE in the packet and blocks qualification", async () => {
    const { store, ids, REPO } = await seed();
    const full = await scopedQuery(store, forConsumer(REPO, C_FULL));
    const prereq = full.admitted.find((r) => r.record_id === ids.P_FULL)!;
    const packet = buildPacket([asItem(prereq, "optional")], {
      budget_tokens: 100000,
      // The satisfying evidence does not exist on this replica at all.
      unavailable_required: [{ id: "evidence:full_story_acceptance", reason: "no_such_record" }],
    });
    expect(packet.incomplete).toBe(true);
    expect(packet.qualifies_action).toBe(false);
    expect(packet.missing_required).toContain("evidence:full_story_acceptance");
    expect(packet.text).toContain("INCOMPLETE PACKET");
    expect(packet.text).toContain("evidence:full_story_acceptance");
  });

  it("POSITIVE CONTROL — a satisfied consumer's packet IS complete and qualifies", async () => {
    const { store, ids, REPO } = await seed();
    const out = await scopedQuery(store, forConsumer(REPO, C_REVIEW));
    const prereq = out.admitted.find((r) => r.record_id === ids.P_REVIEW)!;
    const evidence = out.admitted.find((r) => r.record_id === ids.E_REVIEW)!;
    const packet = buildPacket([asItem(prereq, "required"), asItem(evidence, "required")], { budget_tokens: 100000 });
    expect(packet.incomplete).toBe(false);
    expect(packet.qualifies_action).toBe(true);
    // ...and the evidence is a verified_observation, which CAN qualify.
    expect(evidence.evidence_class).toBe("verified_observation");
    expect(qualifies(evidence, { tenant: T, repo: REPO, path: "svc/pipeline", consumer: C_REVIEW }).ok).toBe(true);
  });

  it("NEGATIVE — no global rule is synthesised: one consumer's prerequisite governs only its own consumer", async () => {
    const { store, ids, REPO } = await seed();
    const p = (await store.get(ids.P_REVIEW))!;
    // Its own consumer: yes.
    expect(qualifies(p, { tenant: T, repo: REPO, path: "svc/pipeline", consumer: C_REVIEW }).ok).toBe(true);
    // Another consumer: no.
    expect(qualifies(p, { tenant: T, repo: REPO, path: "svc/pipeline", consumer: C_CATALOG }).ok).toBe(false);
    // Consumer-free (i.e. "everyone"): no — a consumer-bound rule never widens.
    expect(qualifies(p, { tenant: T, repo: REPO, path: "svc/pipeline" }).ok).toBe(false);
  });

  it("CONTROL consumer-scope-off: the isolation assertions flip when `consumer` is dropped", async () => {
    const { store, ids, REPO } = await seed();
    // A query that names no consumer sees every consumer's prerequisite —
    // which is the shape of an implementation that ignores the component.
    const all = await scopedQuery(store, requestFor("anyone", [{ tenant: T, repo: REPO }], { tenant: T, repo: REPO, path: "svc/pipeline" }));
    const got = all.admitted.map((r) => r.record_id);
    expect(got).toEqual(expect.arrayContaining([ids.P_REVIEW, ids.P_CATALOG, ids.P_FULL]));
  });

  it.todo("per-consumer acceptance-state transitions and the refused-attempt record: lane 05's action gate");
  it.todo("catalog output byte identity across consumers: lane 02's admission surface");
});
