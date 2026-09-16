/**
 * The working set must DELIVER FACTS, not name them (DN-2 / DP-0, D51).
 *
 * Before this renderer a `verified_observation` — whose body is `.strict()`
 * and has no `summary` — rendered as `- [verified observation] <record_id>`,
 * so the one class of record that carries checked facts (head moved, ancestry
 * flag, connector unavailable, config value) reached the model as an opaque
 * id. And no record rendered its `scope.revision`, so a ruling bound to a
 * head could not be told apart from an unbound one.
 *
 * Every test here fails against the old renderer. The budget test is the
 * guard that the fix changed only WHAT a record says, not how the budget,
 * ordering or omission reporting behave.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleClaudeCodeHook } from "../../src/adapters/claude-code.js";
import type { V3Runtime } from "../../src/adapters/runtime.js";
import { buildWorkingSet, renderRecord } from "../../src/adapters/working-set.js";
import type { Scope } from "../../src/contracts/index.js";
import type { SliceProjectedRecord } from "../../src/events/projection.js";
import { makeFixture, runtimeFor, seedDecision, type Fixture } from "./helpers.js";

const BASE = "a1b2c3d4" + "0".repeat(32);
const HEAD = "e5f6a7b8" + "1".repeat(32);
const REPO = "r_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OBSERVED_AT = "2026-09-16T10:00:00.000Z";

type Seed = Pick<SliceProjectedRecord, "record_id" | "record_type" | "evidence_class" | "body" | "scope"> &
  Partial<SliceProjectedRecord>;

/** A projected record with every lifecycle field at its uninteresting value. */
function projected(seed: Seed): SliceProjectedRecord {
  return {
    status: "active",
    version: seed.record_id,
    version_digest: "sha256:0",
    conflicts: [],
    history: [],
    producer: "p_test",
    created_at: OBSERVED_AT,
    archived: false,
    revoked: false,
    applicable: true,
    authorizes_action: true,
    superseded_by: [],
    corrections: [],
    contested: [],
    commits: [],
    ...seed,
  };
}

function observation(result: Record<string, unknown>, over: Partial<Seed> = {}): SliceProjectedRecord {
  return projected({
    record_id: "01OBS000000000000000000000",
    record_type: "observation",
    evidence_class: "verified_observation",
    scope: { repo: REPO, path: "svc/pr" },
    body: {
      source_kind: "commit",
      check_method: "git rev-parse HEAD",
      base: BASE,
      head: HEAD,
      observed_at: OBSERVED_AT,
      volatile: false,
      result,
    },
    ...over,
  });
}

describe("renderRecord — observations deliver their substance", () => {
  it("renders source_kind, check_method, base..head, observed_at, volatile and the result's scalar fields", () => {
    const rec = observation({ kind: "head_moved", to: "B", ancestor: true, count: 3, nested: { x: 1 }, list: [1] });
    const text = renderRecord(rec);

    expect(text).toMatch(/^- \[verified observation\] /);
    // The fact, not the id.
    expect(text).toContain("ancestor=true");
    expect(text).toContain("count=3");
    expect(text).toContain("kind=head_moved");
    expect(text).toContain("to=B");
    expect(text).not.toContain(rec.record_id);
    // Nested values are not flattened into the line.
    expect(text).not.toContain("nested");
    expect(text).not.toContain("list");
    // How it was checked, and at what.
    expect(text).toContain("observed: commit via git rev-parse HEAD");
    expect(text).toContain(`at ${OBSERVED_AT}`);
    expect(text).toContain("volatile: no");
    expect(text).toContain("a1b2c3d4..e5f6a7b8");
    // The 40-hex shas themselves are not spent on the budget.
    expect(text).not.toContain(HEAD);
  });

  it("result.summary, when present, is the head line and the key=value rendering is not used", () => {
    const text = renderRecord(observation({ summary: "HEAD moved from A to B; B is not a descendant of A", kind: "head_moved" }));
    expect(text).toContain("- [verified observation] HEAD moved from A to B; B is not a descendant of A");
    expect(text).not.toContain("kind=head_moved");
  });

  it("a volatile observation says so, and source_uri rides with source_kind", () => {
    const text = renderRecord(
      observation(
        { available: false },
        {
          body: {
            source_kind: "other",
            source_uri: "connector:github",
            observed_at: OBSERVED_AT,
            volatile: true,
            result: { available: false },
          },
        },
      ),
    );
    expect(text).toContain("available=false");
    expect(text).toContain("observed: other connector:github");
    expect(text).toContain("volatile: yes");
    // No base/head in the body → no range on the observed line, and none invented.
    expect(text).not.toMatch(/\.\./);
  });

  it("the compact result rendering is bounded, deterministic and single-line", () => {
    const long = "x".repeat(600);
    const bounded = renderRecord(observation({ detail: long, kind: "k" }));
    const headLine = bounded.split("\n")[0]!;
    expect(headLine.length).toBeLessThan(300);
    expect(headLine.endsWith("…")).toBe(true);

    // Insertion order is not a rendering input.
    const a = renderRecord(observation({ kind: "k", host: "h", n: 1 }));
    const b = renderRecord(observation({ n: 1, host: "h", kind: "k" }));
    expect(a).toBe(b);
    expect(a).toContain("host=h kind=k n=1");

    // A value with newlines does not break the line-per-field layout.
    const multi = renderRecord(observation({ note: "first\nsecond\n\tthird" }));
    expect(multi.split("\n")[0]).toContain("note=first second third");
  });

  it("an observation with an empty result and no summary still falls back to its id", () => {
    const rec = observation({});
    expect(renderRecord(rec)).toContain(`- [verified observation] ${rec.record_id}`);
  });
});

describe("renderRecord — scope.revision renders on the scope line", () => {
  const ruling = (scope: Scope): SliceProjectedRecord =>
    projected({
      record_id: "01RUL000000000000000000000",
      record_type: "ruling",
      evidence_class: "human_ruling",
      scope,
      body: { statement: "Ship svc/pr only from head B" },
    });

  it("a revision-bound ruling renders base..head with 8-hex prefixes", () => {
    const text = renderRecord(ruling({ repo: REPO, path: "svc/pr", revision: { base: BASE, head: HEAD } }));
    expect(text).toContain("- [RULING (human)] Ship svc/pr only from head B");
    expect(text).toContain("  scope: svc/pr · revision a1b2c3d4..e5f6a7b8");
    expect(text).not.toContain(HEAD);
  });

  it("a head-only revision renders `..head`; a revision with no path still gets a scope line", () => {
    expect(renderRecord(ruling({ repo: REPO, path: "svc/pr", revision: { head: HEAD } }))).toContain(
      "  scope: svc/pr · revision ..e5f6a7b8",
    );
    expect(renderRecord(ruling({ repo: REPO, revision: { base: BASE, head: HEAD } }))).toContain(
      "  scope: revision a1b2c3d4..e5f6a7b8",
    );
  });

  it("a record without revision renders no range", () => {
    const text = renderRecord(
      projected({
        record_id: "01DEC000000000000000000000",
        record_type: "decision",
        evidence_class: "proposal",
        scope: { repo: REPO, path: "svc/pr", task: "session:s1" },
        body: { summary: "Chose X over Y", rationale: "because" },
        authorizes_action: false, // a proposal never does
      }),
    );
    expect(text).toContain("  scope: svc/pr · session:s1\n");
    expect(text).not.toMatch(/revision/);
    expect(text).not.toMatch(/\.\./);
    // The decision rendering itself is untouched.
    expect(text).toBe(
      "- [proposal] Chose X over Y\n  scope: svc/pr · session:s1\n  why: because\n  (does not authorize action on its own)",
    );
  });
});

// ------------------------------------------------------------ through the store

let fx: Fixture;
beforeEach(() => {
  fx = makeFixture("twining-ws-render-");
});
afterEach(() => {
  fx.cleanup();
});

const deps = (runtime: V3Runtime) => ({ runtime, ingress: "adapter" as const });

async function seedObservation(
  runtime: V3Runtime,
  result: Record<string, unknown>,
  scope: Scope,
  body: Record<string, unknown> = {},
): Promise<string> {
  const ev = await runtime.append({
    kind: "created",
    recordType: "observation",
    evidenceClass: "verified_observation",
    scope,
    payload: {
      source_kind: "commit",
      check_method: "git merge-base --is-ancestor",
      observed_at: OBSERVED_AT,
      volatile: false,
      result,
      ...body,
    },
    ingress: "adapter",
  });
  if (!ev) throw new Error("fixture could not append an observation");
  await runtime.store?.admit();
  await runtime.store?.project();
  return ev.id;
}

describe("SessionStart delivers observation facts and revision ranges", () => {
  it("an observation seeded through the runtime reaches the injected payload with its result and range", async () => {
    const seed = runtimeFor(fx);
    const scope: Scope = { ...seed.scope, path: "svc/pr", revision: { base: BASE, head: HEAD } };
    const obsId = await seedObservation(seed, { kind: "head_moved", ancestor: false, to: "B" }, scope, { base: BASE, head: HEAD });
    seed.close();

    const runtime = runtimeFor(fx);
    const out = await handleClaudeCodeHook(
      "SessionStart",
      { hook_event_name: "SessionStart", session_id: "sess-r", source: "startup", cwd: fx.projectRoot },
      deps(runtime),
    );
    const delivered: string = JSON.parse(out.stdout).hookSpecificOutput.additionalContext;
    expect(out.injected!.emitted).toContain(obsId);
    expect(delivered).toContain("ancestor=false kind=head_moved to=B");
    expect(delivered).toContain("observed: commit via git merge-base --is-ancestor");
    expect(delivered).toContain("scope: svc/pr · revision a1b2c3d4..e5f6a7b8");
    // The receipt still names the record, and hashes exactly the longer bytes.
    const rp = out.events.find((e) => e.kind === "receipt")!.payload as Record<string, unknown>;
    expect(rp.events).toContain(obsId);
    expect(out.injected!.text).toBe(delivered);
    runtime.close();
  });

  it("budget truncation still reports every omitted id, and the longer renderings are what the budget counts", async () => {
    const seed = runtimeFor(fx);
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      ids.push(
        await seedObservation(
          seed,
          { kind: "check", index: i, detail: `observation ${i} with a result long enough to matter` },
          { ...seed.scope, path: `svc/${i}` },
        ),
      );
    }
    for (let i = 0; i < 4; i++) {
      ids.push(await seedDecision(seed, `decision ${i} padded out so a tiny budget must drop some of them`));
    }
    seed.close();

    const runtime = runtimeFor(fx);
    const tiny = await buildWorkingSet(runtime.store!, { scope: runtime.scope, budget: 400 });
    expect(tiny.omitted.length, "the fixture must force an omission").toBeGreaterThan(0);
    expect(tiny.included.length, "something must still fit").toBeGreaterThan(0);
    // Every seeded record is accounted for exactly once, and the cursor holds.
    expect([...tiny.included, ...tiny.omitted].sort()).toEqual([...ids].sort());
    expect(tiny.cursor).toBeUndefined();
    // The omission is stated in the payload, by id.
    expect(tiny.text).toMatch(new RegExp(`\\(${tiny.omitted.length} further record\\(s\\) matched but did not fit the budget: `));
    for (const id of tiny.omitted) expect(tiny.text).toContain(id);
    // Observations sort ahead of proposals, so what fitted is an observation, rendered as a fact.
    expect(tiny.text).toContain("kind=check");
    // Rendered chunks stay inside the budget: the budget counts the bytes actually emitted.
    const body = tiny.text.split("\n\n")[1]!;
    expect(body.length).toBeLessThanOrEqual(400);

    // ...and through the hook, the receipt/omission arithmetic is unchanged.
    const out = await handleClaudeCodeHook(
      "SessionStart",
      { hook_event_name: "SessionStart", session_id: "s", source: "startup", cwd: fx.projectRoot },
      { runtime, ingress: "adapter", budget: 400 },
    );
    const inj = out.injected!;
    expect(inj.omitted.length).toBe(inj.selected - inj.emitted.length);
    expect(inj.omitted.length).toBeGreaterThan(0);
    for (const id of inj.omitted) expect(inj.text).toContain(id);
    runtime.close();
  });
});
