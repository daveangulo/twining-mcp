/**
 * Proof that the acceptance instruments can fail (lane 05).
 *
 * The oracles' "Instrument-can-fail controls" sections require that disabling
 * a named control make a named negative assertion FAIL. This file runs each
 * negative assertion TWICE against the same scenario: once with every switch
 * off (it must hold) and once with exactly one switch on (it must break). A
 * control that cannot break its assertion is reported as a DEFECT of the
 * instrument, not as a pass — the `it()` fails and names the control.
 *
 * Read `switchboard.ts` for the input/observe injection-mode distinction
 * before quoting any result from this file.
 */
import { afterAll, describe, expect, it } from "vitest";

import {
  CONTROLS,
  CONTROL_SPECS,
  Instrument,
  NO_SWITCHES,
  cleanupTempDirs,
  injectInput,
  only,
  build,
  createdRecord,
  settle,
  type Control,
  type Switches,
} from "./index.js";
import { BYTES_LEN, BYTES_TEXT, MESA, PAY, buildFixture, type Fixture } from "./scenario-fixture.js";

afterAll(cleanupTempDirs);

/** A negative assertion: resolves when the guarantee holds, throws when it is violated. */
type NegativeAssertion = (fx: Fixture, switches: Switches) => Promise<void>;

class ControlFailure extends Error {}

function must(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ControlFailure(message);
}

// --------------------------------------------------------------- assertions

/** N-SCOPE: an out-of-scope record never enters the consumer's applicable view. */
const assertScopeIsolation: NegativeAssertion = async (fx, switches) => {
  const inst = new Instrument(fx.B.store, switches);
  const view = await inst.view({ repo: fx.repo, path: PAY });
  must(
    !view.some((r) => r.record_id === fx.ids.outOfScope),
    `N-SCOPE violated: the ${MESA} record ${fx.ids.outOfScope} is visible in the ${PAY} view`,
  );
};

/** N-RANK: a lower-class successor is recorded as contested, never applied. */
const assertClassRankEnforced: NegativeAssertion = async (fx, switches) => {
  const inst = new Instrument(fx.B.store, switches);
  const rec = await inst.record(fx.ids.modelClaim);
  must(rec, "N-RANK precondition: the model-claim target is missing from the consumer");
  must(rec.status !== "superseded", `N-RANK violated: a model_inference claim superseded a verified_observation record (status=${rec.status})`);
  must(rec.contested.length > 0, "N-RANK violated: the refused lower-class claim left no contested annotation");
};

/** N-CONFLICT: concurrent equal-class successors produce a recorded conflict, not a silent winner. */
const assertConflictRecorded: NegativeAssertion = async (fx, switches) => {
  const inst = new Instrument(fx.B.store, switches);
  const rec = await inst.record(fx.ids.inScope);
  must(rec, "N-CONFLICT precondition: the contested record is missing from the consumer");
  must(rec.status === "conflicted", `N-CONFLICT violated: two concurrent equal-class successors produced status=${rec.status}, not 'conflicted'`);
  must(
    rec.conflicts.includes(fx.ids.rivalOne) && rec.conflicts.includes(fx.ids.rivalTwo),
    `N-CONFLICT violated: conflicts=${JSON.stringify(rec.conflicts)} does not name both rivals`,
  );
};

/**
 * N-TRUST: a model-authored lifecycle claim changes no status.
 * Input mode — the claim is re-authored under the switch and run through the
 * real pipeline on the producer replica.
 */
const assertModelClaimInert: NegativeAssertion = async (fx, switches) => {
  const target = createdRecord("decision", {
    scope: { repo: fx.repo, path: PAY },
    by: fx.agentA,
    parents: fx.policyIds,
    evidence_class: "verified_observation",
    payload: { summary: "trust probe target", rationale: "observed", status: "active" },
  });
  const successor = createdRecord("decision", {
    scope: { repo: fx.repo, path: PAY },
    by: fx.agentA,
    parents: fx.policyIds,
    evidence_class: "model_inference",
    payload: { summary: "trust probe successor", rationale: "inferred", status: "active" },
  });
  const claim = build({
    kind: "superseded",
    record: { type: "decision", id: target.id as string },
    scope: { repo: fx.repo, path: PAY },
    by: fx.human,
    producerKind: "human",
    parents: [target.id as string, successor.id as string],
    evidence_class: "model_inference",
    payload: { target: target.id, by: successor.id, reason: "the model believes it read a newer value" },
  });

  await fx.A.store.append(target, "import");
  await fx.A.store.append(successor, "import");
  await fx.A.store.append(injectInput(claim, switches, { human: fx.human }), "import");
  await settle(fx.A.store);

  const rec = await fx.A.store.get(target.id as string);
  must(rec, "N-TRUST precondition: the probe target was not projected");
  must(
    rec.status !== "superseded",
    `N-TRUST violated: model-authored text set a lifecycle state (status=${rec.status}); evidence class came from the payload, not the ingress`,
  );
};

/**
 * N-DEDUP: a retried write has exactly one semantic effect, and the
 * suppression is recorded rather than invisible (R20).
 * Input mode — the retry is re-submitted under the switch.
 */
const assertSingleEffectOnRetry: NegativeAssertion = async (fx, switches) => {
  const summary = `idempotency probe ${switches.dedup_off ? "off" : "on"}`;
  const first = createdRecord("decision", {
    scope: { repo: fx.repo, path: PAY },
    by: fx.agentA,
    parents: fx.policyIds,
    evidence_class: "verified_observation",
    payload: { summary, rationale: "submitted twice", status: "active" },
  });
  await fx.A.store.append(first, "import");
  // The retry: byte-identical content, resubmitted after a lost acknowledgement.
  await fx.A.store.append(injectInput({ ...first }, switches, {}), "import");
  await settle(fx.A.store);

  const hits = (await fx.A.store.query({ scope: { repo: fx.repo, path: PAY } })).filter(
    (r) => (r.body as { summary?: string }).summary === summary,
  );
  must(hits.length === 1, `N-DEDUP violated: a retried write produced ${hits.length} applicable records, not 1`);

  const inst = new Instrument(fx.A.store, switches);
  must(
    inst.suppressedDuplicates(first.id as string) >= 1,
    "N-DEDUP violated: the duplicate was suppressed with no trace in the admission log (R20)",
  );
};

/** N-BYTES: the stored payload is byte-identical to the authored payload. */
const assertBytesPreserved: NegativeAssertion = async (fx, switches) => {
  const ev = createdRecord("decision", {
    scope: { repo: fx.repo, path: PAY },
    by: fx.agentA,
    parents: fx.policyIds,
    evidence_class: "verified_observation",
    payload: { summary: "byte fidelity probe", rationale: "exact bytes matter", body_text: BYTES_TEXT, status: "active" },
  });
  const injected = injectInput(ev, switches, { textFields: ["body_text"] });
  const res = await fx.A.store.append(injected, "import");
  must("event" in res, "N-BYTES precondition: the probe event was refused by the store");
  await settle(fx.A.store);

  const rec = await fx.A.store.get((injected.record as { id: string }).id);
  must(rec, "N-BYTES precondition: the probe record was not projected");
  const stored = (rec.body as { body_text?: string }).body_text ?? "";
  must(
    Buffer.byteLength(stored, "utf8") === BYTES_LEN,
    `N-BYTES violated: stored byte_len=${Buffer.byteLength(stored, "utf8")}, authored byte_len=${BYTES_LEN}`,
  );
  must(stored === BYTES_TEXT, "N-BYTES violated: the BOM or the CRLF terminators were normalized away");
};

// -------------------------------------------------- control -> assertion map

interface Binding {
  control: Control;
  /** The assertion the oracles say this control must break. */
  assertionId: string;
  assertion: NegativeAssertion;
}

const BINDINGS: Binding[] = [
  { control: "scope_filter_off", assertionId: "N-SCOPE", assertion: assertScopeIsolation },
  { control: "trust_check_off", assertionId: "N-TRUST", assertion: assertModelClaimInert },
  { control: "dedup_off", assertionId: "N-DEDUP", assertion: assertSingleEffectOnRetry },
  { control: "byte_preservation_off", assertionId: "N-BYTES", assertion: assertBytesPreserved },
  { control: "class_rank_off", assertionId: "N-RANK", assertion: assertClassRankEnforced },
  { control: "conflict_detection_off", assertionId: "N-CONFLICT", assertion: assertConflictRecorded },
];

describe("instrument-can-fail switchboard", () => {
  it("every control in CONTROLS is bound to a negative assertion", () => {
    expect(BINDINGS.map((b) => b.control).sort()).toEqual([...CONTROLS].sort());
  });

  for (const { control, assertionId, assertion } of BINDINGS) {
    const spec = CONTROL_SPECS[control];

    it(`${control} (${spec.mode}) — ${assertionId} holds with the control ON`, async () => {
      const fx = await buildFixture();
      await expect(assertion(fx, NO_SWITCHES)).resolves.toBeUndefined();
    });

    it(`${control} (${spec.mode}) — ${assertionId} FAILS with the control OFF`, async () => {
      const fx = await buildFixture();
      // A control that cannot break its assertion is a DEFECT of the
      // instrument: the assertion is passing for the wrong reason.
      await expect(
        assertion(fx, only(control)),
        `CONTROL DEFECT: disabling ${control} did not break ${assertionId}. ` +
          `Defect model: ${spec.defect} Fidelity: ${spec.fidelity}`,
      ).rejects.toThrow(/violated/);
    });
  }
});
