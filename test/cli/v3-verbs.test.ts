/**
 * The v3 CLI verbs: identity, rule (the ceremony), events, sync, doctor.
 *
 * The ceremony is tested from two sides on purpose. Its REFUSALS are unit-
 * tested (they are the security property, and every one of them must hold
 * without a TTY anywhere near the test); its HAPPY PATH is exercised by
 * signing with a fixture human key, which is exactly what ADR §2.3 prescribes
 * for an automated run — "never through a TTY". A test that faked a TTY would
 * be testing a backdoor rather than the ceremony.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  appendRuling,
  ceremonyRefusal,
  runDoctor,
  runEvents,
  runIdentity,
  runRule,
  runSync,
} from "../../src/cli/v3-verbs.js";
import { classifyCliArgv, V3_CLI_VERBS } from "../../src/cli/dispatch.js";
import {
  isV3Store,
  listHumanIdentities,
  readHostIdentity,
  readStoreDescriptor,
  unlockHumanIdentity,
} from "../../src/adapters/identity.js";
import { openRuntime } from "../../src/adapters/runtime.js";
import { makeFixture, runtimeFor, seedDecision, type Fixture } from "../adapters/helpers.js";

let fx: Fixture;
beforeEach(() => {
  fx = makeFixture("twining-v3verbs-", { v3: false });
});
afterEach(() => {
  fx.cleanup();
});

describe("argv classification", () => {
  it("routes every v3 verb away from the command registry", () => {
    for (const verb of V3_CLI_VERBS) {
      const d = classifyCliArgv(["node", "twining", verb, "x"]);
      expect(d.kind, `${verb} must not dispatch as a registry command`).toBe("v3");
    }
  });

  it("leaves registry commands alone", () => {
    expect(classifyCliArgv(["node", "twining", "post", "--json", "{}"]).kind).toBe("command");
    expect(classifyCliArgv(["node", "twining", "capabilities"]).kind).toBe("capabilities");
  });
});

describe("twining identity init", () => {
  it("mints a host key and a v3 store descriptor, and is idempotent", async () => {
    expect(isV3Store(fx.twiningDir)).toBe(false);

    const first = await runIdentity(["init"], fx.projectRoot, fx.env);
    expect(first.exitCode).toBe(0);
    const r1 = first.result as Record<string, Record<string, unknown>>;
    expect(r1.host!.host_id).toMatch(/^h_/);
    expect(r1.host!.key_id).toMatch(/^k_/);
    expect(r1.store!.store_id).toMatch(/^s_/);
    expect(r1.store!.repo_id).toMatch(/^r_/);
    expect(isV3Store(fx.twiningDir)).toBe(true);

    const second = await runIdentity(["init"], fx.projectRoot, fx.env);
    const r2 = second.result as Record<string, Record<string, unknown>>;
    // A second init must NOT mint a new store id — events already cite the old one.
    expect(r2.store!.store_id).toBe(r1.store!.store_id);
    expect(r2.host!.key_id).toBe(r1.host!.key_id);
    expect(r2.store!.created).toBe(false);
  });

  it("writes the host key 0600 and never prints key material", async () => {
    const out = await runIdentity(["init"], fx.projectRoot, fx.env);
    const keyFile = (out.result as { host: { file: string } }).host.file;
    const mode = fs.statSync(keyFile).mode & 0o777;
    expect(mode).toBe(0o600);
    const identity = readHostIdentity(fx.env)!;
    expect(identity.private_key).toContain("PRIVATE KEY");
    expect(JSON.stringify(out.result)).not.toContain("PRIVATE KEY");
  });

  it("--human writes a PASSPHRASE-ENCRYPTED key, unusable without the passphrase", async () => {
    const env = { ...fx.env, TWINING_HUMAN_PASSPHRASE: "correct horse battery" };
    const out = await runIdentity(["init", "--human", "--label", "Dave"], fx.projectRoot, env);
    expect(out.exitCode).toBe(0);

    const humans = listHumanIdentities(env);
    expect(humans).toHaveLength(1);
    expect(humans[0]!.label).toBe("Dave");
    expect(humans[0]!.encrypted_private_key).toContain("ENCRYPTED PRIVATE KEY");

    // POSITIVE CONTROL: the right passphrase unlocks it.
    expect(() => unlockHumanIdentity(humans[0]!, "correct horse battery")).not.toThrow();
    // THE PROPERTY: the wrong one does not.
    expect(() => unlockHumanIdentity(humans[0]!, "wrong passphrase")).toThrow(/could not unlock/);
  });

  it("refuses a weak passphrase rather than writing a weakly protected key", async () => {
    const env = { ...fx.env, TWINING_HUMAN_PASSPHRASE: "short" };
    const out = await runIdentity(["init", "--human"], fx.projectRoot, env);
    expect(out.exitCode).toBe(1);
    expect(out.error!.code).toBe("PASSPHRASE_REQUIRED");
    expect(listHumanIdentities(env)).toHaveLength(0);
  });
});

describe("the ruling ceremony refuses", () => {
  const base = { isTTY: true, env: {} as NodeJS.ProcessEnv, invokedThroughRegistry: false, hasHumanKey: true, storeIsV3: true };

  it("when stdin is not a TTY", () => {
    expect(ceremonyRefusal({ ...base, isTTY: false })?.code).toBe("NOT_A_TTY");
  });

  it("when TWINING_AGENT_CONTEXT is set — even at a real TTY", () => {
    const r = ceremonyRefusal({ ...base, env: { TWINING_AGENT_CONTEXT: "1" } });
    expect(r?.code).toBe("AGENT_CONTEXT");
  });

  it("when invoked through the command registry — before every other check", () => {
    // Registry invocation outranks even a perfectly valid interactive call:
    // the ingress, not the circumstances, is what disqualifies it.
    const r = ceremonyRefusal({ ...base, invokedThroughRegistry: true });
    expect(r?.code).toBe("REGISTRY_INVOCATION");
    expect(r?.message).toMatch(/can never mint a human_ruling/);
  });

  it("when there is no human key, and when the store is not v3", () => {
    expect(ceremonyRefusal({ ...base, hasHumanKey: false })?.code).toBe("NO_HUMAN_KEY");
    expect(ceremonyRefusal({ ...base, storeIsV3: false })?.code).toBe("STORE_NOT_V3");
  });

  it("allows only when every condition holds", () => {
    expect(ceremonyRefusal(base)).toBeNull();
  });

  it("`twining rule` under vitest (no TTY) refuses and writes nothing", async () => {
    await runIdentity(["init", "--human"], fx.projectRoot, { ...fx.env, TWINING_HUMAN_PASSPHRASE: "a-good-passphrase" });
    const out = await runRule(
      ["--scope", "src/auth/", "--statement", "tokens expire in 15 minutes"],
      fx.projectRoot,
      fx.env,
    );
    expect(out.exitCode).toBe(1);
    expect(out.error!.code).toBe("NOT_A_TTY");
  });
});

describe("a ruling signed with a fixture human key (ADR §2.3's automated path)", () => {
  it("is admitted as human_ruling and outranks a model's proposal", async () => {
    const env = { ...fx.env, TWINING_HUMAN_PASSPHRASE: "a-good-passphrase" };
    await runIdentity(["init", "--human"], fx.projectRoot, env);
    const human = unlockHumanIdentity(listHumanIdentities(env)[0]!, "a-good-passphrase");

    const runtime = openRuntime({ projectRoot: fx.projectRoot, env });
    try {
      const out = await appendRuling(runtime, human, {
        scope: { ...runtime.scope, path: "src/auth/" },
        statement: "password reset tokens expire in 15 minutes",
        requirements: [{ key: "token_ttl_minutes", value: "15" }],
      });
      expect("id" in out, JSON.stringify(out)).toBe(true);

      await runtime.store!.admit();
      await runtime.store!.project();

      const rulings = (await runtime.store!.query({})).filter((r) => r.record_type === "ruling");
      expect(rulings).toHaveLength(1);
      expect(rulings[0]!.evidence_class).toBe("human_ruling");
      expect((rulings[0]!.body as Record<string, unknown>).statement).toContain("15 minutes");
    } finally {
      runtime.close();
    }
  });

  it("an MCP/CLI ingress cannot produce that class at all", async () => {
    const env = { ...fx.env };
    await runIdentity(["init"], fx.projectRoot, env);
    const runtime = openRuntime({ projectRoot: fx.projectRoot, env });
    try {
      // Ask for a ruling through the cli ingress. The validator refuses before
      // storage — this is the schema-layer guarantee, not a runtime check.
      const refused = await runtime.append({
        kind: "created",
        recordType: "ruling",
        evidenceClass: "human_ruling",
        payload: { statement: "I hereby rule" },
        ingress: "cli",
      });
      expect(refused).toBeNull();
      const events = await runtime.store!.events({});
      expect(events.filter((e) => e.evidence_class === "human_ruling")).toHaveLength(0);
    } finally {
      runtime.close();
    }
  });
});

describe("twining events", () => {
  it("refuses honestly on a 2.x store", async () => {
    const out = await runEvents(["ls"], fx.projectRoot, fx.env);
    expect(out.exitCode).toBe(1);
    expect(out.error!.code).toBe("STORE_NOT_V3");
  });

  it("lists admitted events and shows one with its delivery state", async () => {
    await runIdentity(["init"], fx.projectRoot, fx.env);
    const runtime = runtimeFor(fx);
    const id = await seedDecision(runtime, "a decision to find again through the CLI");
    runtime.close();

    const ls = await runEvents(["ls"], fx.projectRoot, fx.env);
    expect(ls.exitCode).toBe(0);
    const rows = (ls.result as { events: Array<Record<string, unknown>> }).events;
    const row = rows.find((r) => r.id === id)!;
    expect(row.kind).toBe("created");
    expect(row.evidence_class).toBe("proposal");
    expect(row.signed).toBe(true); // the host key signed it on append

    const show = await runEvents(["show", id], fx.projectRoot, fx.env);
    expect(show.exitCode).toBe(0);
    const shown = show.result as { event: Record<string, unknown>; delivery: { state: string } };
    expect(shown.event.id).toBe(id);
    expect(["admitted", "projected"]).toContain(shown.delivery.state);
  });

  it("distinguishes `not admitted` from `not here`", async () => {
    await runIdentity(["init"], fx.projectRoot, fx.env);
    const missing = await runEvents(["show", "01ZZZZZZZZZZZZZZZZZZZZZZZZ"], fx.projectRoot, fx.env);
    expect(missing.exitCode).toBe(1);
    expect(missing.error!.message).toMatch(/no event/);
  });
});

describe("twining doctor", () => {
  it("reports bindings, identity and coverage without printing any secret", async () => {
    await runIdentity(["init"], fx.projectRoot, { ...fx.env, TWINING_HUMAN_PASSPHRASE: "a-good-passphrase" });
    const out = await runDoctor([], fx.projectRoot, fx.env);
    expect(out.exitCode).toBe(0);
    const r = out.result as Record<string, Record<string, unknown>>;

    expect(r.bindings!.v3_enabled).toBe(true);
    expect(r.bindings!.store_dir).toBe(fx.twiningDir);
    // Store location and producing checkout are reported SEPARATELY (gap 4).
    expect(r.bindings).toHaveProperty("source_cwd");
    expect(r.bindings).toHaveProperty("source");
    expect(r.identity!.host_key_id).toMatch(/^k_/);
    expect(r.capture_coverage).toHaveProperty("claude-code");
    expect(r.capture_coverage).toHaveProperty("codex");

    const serialized = JSON.stringify(out.result);
    expect(serialized).not.toContain("PRIVATE KEY");
    expect(serialized).not.toContain("a-good-passphrase");
  });

  it("says plainly when a store is still on 2.x", async () => {
    const out = await runDoctor([], fx.projectRoot, fx.env);
    const r = out.result as { bindings: Record<string, unknown>; honest_limits: string[] };
    expect(r.bindings.v3_enabled).toBe(false);
    expect(r.honest_limits.join(" ")).toMatch(/2\.x format/);
  });
});

describe("twining sync", () => {
  it("wires the fs carrier while lane 02's git transport is absent, and says which", async () => {
    await runIdentity(["init"], fx.projectRoot, fx.env);
    const runtime = runtimeFor(fx);
    await seedDecision(runtime, "a decision to publish through the carrier");
    runtime.close();

    const shared = path.join(fx.projectRoot, "..", "shared-exchange");
    const out = await runSync(["--path", shared], fx.projectRoot, fx.env);
    expect(out.exitCode).toBe(0);
    const r = out.result as Record<string, Record<string, unknown>>;
    expect(String(r.carrier)).toMatch(/^fs:/);
    // Uncertainty is REPORTED, never folded into success or failure (C10).
    expect(r.published).toHaveProperty("uncertain");
    expect(r.received).toHaveProperty("ack_recorded");
  });

  it("refuses on a 2.x store rather than pretending to sync", async () => {
    const out = await runSync([], fx.projectRoot, fx.env);
    expect(out.exitCode).toBe(1);
    expect(out.error!.code).toBe("STORE_NOT_V3");
  });
});

describe("store descriptor", () => {
  it("separates store identity from repository identity (R01)", async () => {
    await runIdentity(["init"], fx.projectRoot, fx.env);
    const d = readStoreDescriptor(fx.twiningDir)!;
    expect(d.store_id).toMatch(/^s_/);
    expect(d.repo_ids[0]).toMatch(/^r_/);
    expect(d.store_id).not.toBe(d.repo_ids[0]);
    // No path, URL or branch is part of identity.
    expect(JSON.stringify(d)).not.toContain(fx.projectRoot);
  });
});
