/**
 * `exchangeStatus()` and the `twining_exchange_status` command (R20).
 *
 * The property under test is not "the numbers are right" but "the replica can
 * say what it does not know". Every assertion here is about an uncertainty
 * being ENUMERATED: a checkout behind its journal, an unresolved import, a
 * transfer whose receipt never came back, an open erasure obligation, a forked
 * cursor. A status surface that cannot express those is the one C18 A9 and
 * C20 E4 are written against.
 */
import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { EventStore } from "../../src/events/event-store.js";
import { FsTransport } from "../../src/exchange/fs-transport.js";
import { Outbox } from "../../src/exchange/outbox.js";
import { exchangeCommands } from "../../src/core/commands/exchange.js";
import { commandRegistry } from "../../src/core/commands.js";
import { mapCommandError } from "../../src/core/command-def.js";
import {
  admitAndProject,
  cleanupTempDirs,
  created,
  makeWorld,
  membershipEvent,
  newStore,
  principalEvents,
  tempDir,
  type World,
} from "../acceptance/slice/harness.js";
import type { EventEnvelope } from "../../src/contracts/index.js";
import type { ExchangeStatus } from "../../src/exchange/status.js";

afterAll(cleanupTempDirs);

function bed(w: World) {
  const principals = principalEvents(w.repo, w.hostA, [
    { id: w.human, kind: "human" },
    { id: w.hostA, kind: "agent" },
  ]);
  const membership = membershipEvent(
    w.repo,
    w.storeId,
    w.hostA,
    [{ principal: w.hostA.principal, roles: ["write"], scopes: [{ repo: w.repo }] }],
    principals.map((e) => e.id as string),
  );
  const infra = [...principals, membership];
  return { infra, infraIds: infra.map((e) => e.id as string) };
}

function decision(w: World, summary: string, parents: string[], path = "src/pay/") {
  return created("decision", {
    scope: { repo: w.repo, path },
    producer: { principal: w.hostA.principal, kind: "agent", host: w.hostA.host },
    parents,
    evidence_class: "proposal",
    payload: { summary, rationale: `because ${summary}` },
    signWith: { keyId: w.hostA.keyId, kp: w.hostA.kp },
  });
}

describe("exchangeStatus — the two ladders stay apart", () => {
  it("reports the admission ladder and the per-transport transfer ladder separately (R08)", async () => {
    const w = makeWorld();
    const f = bed(w);
    const dir = tempDir("status");
    const store = newStore(w, w.hostA, dir);
    const e = decision(w, "one", f.infraIds);
    for (const ev of [...f.infra, e]) store.receive(ev, "fs:carrier", `events/${(ev as { id: string }).id}`);
    await admitAndProject(store);

    const shared = tempDir("status-carrier");
    const carrier = new FsTransport(shared);
    await new Outbox(store, carrier).flush();

    const st = await store.exchangeStatus({ transports: [carrier] });
    expect(st.store.admitted).toBeGreaterThan(0);
    expect(st.store.checkout).toBe("ok");
    // The transfer ladder is per transport and is NOT folded into the state.
    expect(st.outbox.by_transport).toHaveLength(1);
    expect(st.outbox.by_transport[0]?.transport).toBe(carrier.id());
    expect(st.outbox.by_transport[0]?.transferred).toBeGreaterThan(0);
    expect(st.outbox.depth).toBe(0);
    expect(st.transports[0]).toMatchObject({ id: carrier.id(), reachable: true });
    expect(st.migration.state).toBe("unknown"); // declared placeholder, never "complete"
    store.close();
  });

  it("names the oldest pending event and its age when nothing has been transferred", async () => {
    const w = makeWorld();
    const f = bed(w);
    const store = newStore(w, w.hostA, tempDir("status-pending"));
    for (const ev of [...f.infra, decision(w, "waiting", f.infraIds)]) store.receive(ev, "fs:carrier", `events/${(ev as { id: string }).id}`);
    await admitAndProject(store);

    // The harness clock is fixed at 2026-09-15T00:00Z; age is measured against
    // an injected "now" so the assertion is arithmetic, not wall-clock luck.
    const st = await store.exchangeStatus({ now: () => Date.parse("2026-09-15T00:05:00.000Z") });
    expect(st.outbox.depth).toBe(f.infra.length + 1);
    expect(st.outbox.oldest_pending_id).toBeTruthy();
    expect(st.outbox.oldest_pending_age_ms).toBe(5 * 60 * 1000);
    store.close();
  });
});

describe("exchangeStatus — uncertainty is enumerated", () => {
  it("reports a checkout behind its journal, with the ids and a reason that says nothing was revoked", async () => {
    const w = makeWorld();
    const f = bed(w);
    const dir = tempDir("status-behind");
    const store = newStore(w, w.hostA, dir);
    const e = decision(w, "removed from the checkout", f.infraIds);
    for (const ev of [...f.infra, e]) store.receive(ev, "fs:carrier", `events/${(ev as { id: string }).id}`);
    await admitAndProject(store);

    fs.rmSync(path.join(dir, "events", "2026-09", `${e.id as string}.json`), { force: true });
    const st = await store.exchangeStatus();
    expect(st.store.checkout).toBe("checkout_behind_journal");
    const gap = st.gaps.find((g) => g.kind === "checkout_behind_journal");
    expect(gap?.ids).toEqual([e.id]);
    expect(gap?.detail).toContain("nothing was revoked");
    store.close();
  });

  it("reports an uncertain transfer after a lost receipt, and keeps the same id on retry", async () => {
    const w = makeWorld();
    const f = bed(w);
    const store = newStore(w, w.hostA, tempDir("status-uncertain"));
    const e = decision(w, "receipt lost", f.infraIds);
    for (const ev of [...f.infra, e]) store.receive(ev, "fs:carrier", `events/${(ev as { id: string }).id}`);
    await admitAndProject(store);

    const carrier = new FsTransport(tempDir("status-uncertain-carrier"));
    carrier.setFaults({ dropNextPublishReceipt: true });
    const outbox = new Outbox(store, carrier);
    const first = await outbox.flush();
    expect(first.uncertain.length).toBeGreaterThan(0);

    const st = await store.exchangeStatus();
    expect(st.outbox.uncertain).toContain(e.id as string);
    const gap = st.gaps.find((g) => g.kind === "uncertain_transfer");
    expect(gap?.ids).toContain(e.id as string);
    expect(gap?.detail).toContain("The same id is retried, never a new one");

    // The retry closes it — and the attempt count records that it happened.
    await outbox.flush();
    const after = await store.exchangeStatus();
    expect(after.outbox.uncertain).toEqual([]);
    expect(after.outbox.retries).toBeGreaterThan(0);
    store.close();
  });

  it("reports pending prerequisites, rejected and quarantined counts with their reasons", async () => {
    const w = makeWorld();
    const f = bed(w);
    const store = newStore(w, w.hostA, tempDir("status-reasons"));
    const orphanParent = decision(w, "never delivered", f.infraIds);
    const waiting = decision(w, "waits", [orphanParent.id as string]);
    const outOfScope = created("decision", {
      scope: { repo: w.repo, path: "src/pay/" },
      producer: { principal: w.human.principal, kind: "human", host: w.human.host },
      parents: f.infraIds,
      evidence_class: "proposal",
      payload: { summary: "no grant", rationale: "unauthorized" },
      signWith: { keyId: w.human.keyId, kp: w.human.kp },
    });
    for (const ev of [...f.infra, waiting, outOfScope]) store.receive(ev, "fs:carrier", `events/${(ev as { id: string }).id}`);
    await admitAndProject(store);

    const st = await store.exchangeStatus();
    expect(st.inbound.pending_parents.map((p) => p.id)).toContain(waiting.id as string);
    expect(st.inbound.pending_parents[0]?.waiting_on).toContain(orphanParent.id as string);
    expect(st.gaps.some((g) => g.kind === "pending_parents")).toBe(true);
    expect(st.rejected.count + st.quarantined.count).toBeGreaterThan(0);
    // Reasons are tallied, not just counted.
    const reasons = { ...st.rejected.by_reason, ...st.quarantined.by_reason };
    expect(Object.keys(reasons).length).toBeGreaterThan(0);
    store.close();
  });

  it("carries the store's own cursors and any fork between them", async () => {
    const w = makeWorld();
    const f = bed(w);
    const dir = tempDir("status-cursors");
    const store = newStore(w, w.hostA, dir);
    for (const ev of f.infra) store.receive(ev, "fs:carrier", `events/${(ev as { id: string }).id}`);
    await admitAndProject(store);
    await store.setCursor(w.hostB.principal, { transport: "fs:carrier", position: "7", last_admitted: "01AAAAAAAAAAAAAAAAAAAAAAAA" });

    const st = await store.exchangeStatus();
    expect(st.cursors).toEqual([{ principal: w.hostB.principal, transport: "fs:carrier", position: "7", last_admitted: "01AAAAAAAAAAAAAAAAAAAAAAAA" }]);
    expect(st.cursor_forks).toEqual([]);

    // A second writer for the same principal (two clones) forks the cursor.
    fs.writeFileSync(
      path.join(dir, "cursors", `${w.hostB.principal}.json`),
      JSON.stringify({ transport: "fs:carrier", position: "3" }, null, 2),
    );
    const forked = await store.exchangeStatus();
    expect(forked.cursor_forks[0]?.principal).toBe(w.hostB.principal);
    expect(forked.gaps.some((g) => g.kind === "cursor_fork")).toBe(true);
    store.close();
  });

  it("survives a transport that throws, reporting it unreachable rather than failing the call", async () => {
    const w = makeWorld();
    const store = newStore(w, w.hostA, tempDir("status-throws"));
    const broken = {
      id: () => "relay:broken",
      health: async () => {
        throw new Error("connection refused");
      },
    };
    const st = await store.exchangeStatus({ transports: [broken] });
    expect(st.transports[0]).toMatchObject({ id: "relay:broken", reachable: false, credential_state: "unknown" });
    expect(st.transports[0]?.last_error).toContain("connection refused");
    store.close();
  });
});

describe("twining_exchange_status — the command", () => {
  it("is registered on the default surface, under one name, in the shared registry", () => {
    expect(exchangeCommands).toHaveLength(1);
    expect(exchangeCommands[0]?.name).toBe("twining_exchange_status");
    expect(exchangeCommands[0]?.surface).toBe("default");
    expect(commandRegistry.has("twining_exchange_status")).toBe(true);
    // Both front ends reach the same definition — that is the point of the core.
    expect(commandRegistry.get("twining_exchange_status")).toBe(exchangeCommands[0]);
  });

  it("returns the status for a v3 store and refuses a project that has none", async () => {
    const w = makeWorld();
    const f = bed(w);
    const dir = tempDir("status-cmd");
    const store = newStore(w, w.hostA, dir);
    for (const ev of f.infra) store.receive(ev, "fs:carrier", `events/${(ev as { id: string }).id}`);
    await admitAndProject(store);
    store.close();

    const def = exchangeCommands[0]!;
    const result = (await def.handler({ twiningDir: dir } as never, {} as never)) as ExchangeStatus;
    expect(result.store.twining_dir).toBe(dir);
    expect(result.store.admitted).toBe(f.infra.length);
    expect(result.migration.note).toContain("rather than claiming a state it does not track");

    // A project with no event store is refused with a code, not an empty report.
    const empty = tempDir("status-cmd-empty");
    await expect(def.handler({ twiningDir: empty } as never, {} as never)).rejects.toThrow(/no v3 event store/);
    try {
      await def.handler({ twiningDir: empty } as never, {} as never);
    } catch (e) {
      expect(mapCommandError(e).code).toBe("NO_EVENT_STORE");
    }
  });

  it("include_ids:false collapses the id lists to counts without losing the gap kinds", async () => {
    const w = makeWorld();
    const f = bed(w);
    const dir = tempDir("status-cmd-ids");
    const store = newStore(w, w.hostA, dir);
    const e = decision(w, "vanishes", f.infraIds);
    for (const ev of [...f.infra, e]) store.receive(ev, "fs:carrier", `events/${(ev as { id: string }).id}`);
    await admitAndProject(store);
    fs.rmSync(path.join(dir, "events", "2026-09", `${e.id as string}.json`), { force: true });
    store.close();

    const def = exchangeCommands[0]!;
    const full = (await def.handler({ twiningDir: dir } as never, { include_ids: true } as never)) as ExchangeStatus;
    expect(full.gaps[0]?.ids).toEqual([e.id]);
    const terse = (await def.handler({ twiningDir: dir } as never, { include_ids: false } as never)) as {
      gaps: Array<{ kind: string; count: number }>;
    };
    expect(terse.gaps[0]).toEqual({ kind: "checkout_behind_journal", detail: expect.any(String), count: 1 });
  });

  it("never runs git: a status call on a non-git directory works, and the source checkout is irrelevant", async () => {
    const w = makeWorld();
    const f = bed(w);
    const dir = tempDir("status-nogit");
    const store = newStore(w, w.hostA, dir);
    for (const ev of f.infra) store.receive(ev, "fs:carrier", `events/${(ev as { id: string }).id}`);
    await admitAndProject(store);
    store.close();
    expect(fs.existsSync(path.join(dir, ".git"))).toBe(false);
    const def = exchangeCommands[0]!;
    const result = (await def.handler({ twiningDir: dir } as never, {} as never)) as ExchangeStatus;
    expect(result.transports).toEqual([]); // nothing was probed, nothing was spawned
  });
});

/** A typed no-op so the unused-import guard keeps the envelope type honest. */
export type _EnvelopeCheck = EventEnvelope;
