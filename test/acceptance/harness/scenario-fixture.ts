/**
 * The one small, real scenario every instrument-can-fail control is exercised
 * against. Kept separate from the test so other case tests can reuse it.
 *
 * Topology: two replicas (producer A, consumer B) in separate temp dirs with
 * no shared state, exchanging over a disposable `fs:` carrier. Two scopes:
 * `src/pay/` (the consumer is authorized) and `src/mesa/` (it is not).
 *
 * Substitution notice (R-topology): two in-process stores on ONE computer are
 * a substitution for the two-computer topology C18/C28 require. Every result
 * from this fixture must be reported as such.
 */
import {
  World,
  Replica,
  carrier,
  createdRecord,
  build,
  deliver,
  deliverAndSettle,
  exchange,
  policyEvents,
  settle,
  type Carrier,
  type Actor,
} from "./index.js";

export const PAY = "src/pay/";
export const MESA = "src/mesa/";

/** A payload whose exact bytes matter: BOM + CRLF + trailing newline. */
export const BYTES_TEXT = "﻿line one\r\nline two\r\n";
export const BYTES_LEN = Buffer.byteLength(BYTES_TEXT, "utf8");

export interface Fixture {
  world: World;
  A: Replica;
  B: Replica;
  car: Carrier;
  human: Actor;
  agentA: Actor;
  agentB: Actor;
  repo: string;
  /** Bootstrap policy envelopes and their ids, so a test can parent new events. */
  policy: Array<Record<string, unknown>>;
  policyIds: string[];
  /** Record ids the assertions name. */
  ids: {
    inScope: string;
    outOfScope: string;
    bytes: string;
    rivalOne: string;
    rivalTwo: string;
    /** The model-authored supersession claim over `inScope`. */
    modelClaim: string;
    /** The retried write (same content, submitted twice). */
    retry: string;
  };
  /** Raw envelopes, so a test can re-deliver or re-inject them. */
  envelopes: Record<string, Record<string, unknown>>;
}

export async function buildFixture(): Promise<Fixture> {
  const world = new World();
  const human = world.actor("u.rowan.mbele", { human: true });
  const agentA = world.actor("svc.forge-writer@anvil");
  const agentB = world.actor("svc.ledger-reader@basalt");
  const repo = world.repo("repo-quarry-service");

  const A = new Replica("A", world, agentA);
  const B = new Replica("B", world, agentB);
  const car = carrier("fs");

  // Policy: agentA writes and rules in src/, the human rules in src/.
  const policy = policyEvents(world, repo, agentA, [human, agentA, agentB], [
    { principal: agentA.principal, roles: ["write", "rule"], scopes: [{ repo, path: "src/" }] },
    { principal: agentB.principal, roles: ["write", "rule"], scopes: [{ repo, path: "src/" }] },
    { principal: human.principal, roles: ["write", "rule"], scopes: [{ repo, path: "src/" }] },
  ]);
  const policyIds = policy.map((e) => e.id as string);

  const inScope = createdRecord("decision", {
    scope: { repo, path: PAY },
    by: agentA,
    parents: policyIds,
    evidence_class: "verified_observation",
    payload: { summary: "settlement retries capped at 3", rationale: "observed gateway behaviour", status: "active" },
  });

  const outOfScope = createdRecord("decision", {
    scope: { repo, path: MESA },
    by: agentA,
    parents: policyIds,
    evidence_class: "verified_observation",
    payload: { summary: "rating table rebuilt nightly", rationale: "observed cron", status: "active" },
  });

  const bytes = createdRecord("decision", {
    scope: { repo, path: PAY },
    by: agentA,
    parents: policyIds,
    evidence_class: "verified_observation",
    payload: { summary: "byte fidelity probe", rationale: "exact bytes matter", body_text: BYTES_TEXT, status: "active" },
  });

  const retry = createdRecord("decision", {
    scope: { repo, path: PAY },
    by: agentA,
    parents: policyIds,
    evidence_class: "verified_observation",
    payload: { summary: "idempotency probe", rationale: "submitted twice", status: "active" },
  });

  // Two equal-class rivals, each superseding `inScope`, with no causal path
  // between them — the §4.3.3 concurrent-conflict shape.
  const rivalOne = createdRecord("decision", {
    scope: { repo, path: PAY },
    by: agentA,
    parents: policyIds,
    evidence_class: "verified_observation",
    payload: { summary: "cap raised to 5", rationale: "rival one", status: "active" },
  });
  // SIGNED BY agentB, not left for A's store to host-sign: the host key binds
  // to agentA, and an event that claims agentB while carrying agentA's
  // signature is `author_assertion_not_authenticated` (R03/R17). The rivals
  // are supposed to be two different authors, so they must authenticate as two.
  const rivalTwo = createdRecord("decision", {
    scope: { repo, path: PAY },
    by: agentB,
    signBy: agentB,
    parents: policyIds,
    evidence_class: "verified_observation",
    payload: { summary: "cap lowered to 2", rationale: "rival two", status: "active" },
  });

  const supersedeOne = build({
    kind: "superseded",
    record: { type: "decision", id: inScope.id as string },
    scope: { repo, path: PAY },
    by: agentA,
    parents: [inScope.id as string, rivalOne.id as string],
    evidence_class: "verified_observation",
    payload: { target: inScope.id, by: rivalOne.id, reason: "rival one wins" },
  });
  const supersedeTwo = build({
    kind: "superseded",
    record: { type: "decision", id: inScope.id as string },
    scope: { repo, path: PAY },
    by: agentB,
    signBy: agentB,
    parents: [inScope.id as string, rivalTwo.id as string],
    evidence_class: "verified_observation",
    payload: { target: inScope.id, by: rivalTwo.id, reason: "rival two wins" },
  });

  // A model-authored supersession claim over a verified_observation record:
  // strictly lower class, so the reducer must record it as contested.
  const modelTarget = createdRecord("decision", {
    scope: { repo, path: PAY },
    by: agentA,
    parents: policyIds,
    evidence_class: "verified_observation",
    payload: { summary: "gateway timeout is 30s", rationale: "observed", status: "active" },
  });
  const modelSuccessor = createdRecord("decision", {
    scope: { repo, path: PAY },
    by: agentA,
    parents: policyIds,
    evidence_class: "model_inference",
    payload: { summary: "gateway timeout is probably 10s", rationale: "inferred from a log line", status: "active" },
  });
  const modelClaim = build({
    kind: "superseded",
    record: { type: "decision", id: modelTarget.id as string },
    scope: { repo, path: PAY },
    by: agentA,
    parents: [modelTarget.id as string, modelSuccessor.id as string],
    evidence_class: "model_inference",
    payload: { target: modelTarget.id, by: modelSuccessor.id, reason: "the model believes it read a newer value" },
  });

  const envelopes: Record<string, Record<string, unknown>> = {
    inScope,
    outOfScope,
    bytes,
    retry,
    rivalOne,
    rivalTwo,
    supersedeOne,
    supersedeTwo,
    modelTarget,
    modelSuccessor,
    modelClaim,
  };

  // Producer side: append through the real ingress so the store signs and journals.
  for (const e of policy) await A.store.append(e, "import");
  for (const key of Object.keys(envelopes)) await A.store.append(envelopes[key], "import");
  await settle(A.store);

  // Consumer side: everything crosses the carrier, out-of-scope record included
  // (it must ARRIVE for the scope assertion to be non-vacuous).
  deliver(B.store, policy, "bootstrap");
  await settle(B.store);
  await exchange(A, B, car);

  return {
    world,
    A,
    B,
    car,
    human,
    agentA,
    agentB,
    repo,
    policy,
    policyIds,
    ids: {
      inScope: inScope.id as string,
      outOfScope: outOfScope.id as string,
      bytes: bytes.id as string,
      rivalOne: rivalOne.id as string,
      rivalTwo: rivalTwo.id as string,
      modelClaim: modelTarget.id as string,
      retry: retry.id as string,
    },
    envelopes,
  };
}

export { deliverAndSettle };
