/**
 * The C18 fault worker — a REAL producer or consumer process that can be killed
 * between any two durable steps.
 *
 * The oracle is explicit (§2): "Closing the transport connection, cancelling an
 * RPC or calling a shutdown hook does not count as a kill." So the kill here is
 * `process.kill(process.pid, "SIGKILL")` from inside the named step: an
 * untrappable signal, no unwinding, no `finally`, no flush, no database close.
 * The parent then starts a NEW process against the same on-disk store, which is
 * the restart the case demands.
 *
 * Invoked as: node <bundle> <config.json>
 * Prints exactly one JSON line on stdout when it survives to the end.
 */
import fs from "node:fs";

import { EventStore, type HostKey, type KnownKey } from "../../src/events/event-store.js";
import { FsTransport } from "../../src/exchange/fs-transport.js";
import { GitTransport } from "../../src/exchange/git-transport.js";
import { Inbox } from "../../src/exchange/inbox.js";
import { Outbox } from "../../src/exchange/outbox.js";
import type { Transport } from "../../src/contracts/store-api.js";
import type { EventEnvelope } from "../../src/contracts/index.js";

export interface FaultWorkerConfig {
  /** `inspect` opens the store and reports WITHOUT advancing anything — the
   *  post-restart observation the oracle wants before reconciliation runs. */
  role: "producer" | "consumer" | "inspect";
  carrier: "fs" | "git";
  storeDir: string;
  /** Named durable step to die at, or null to run to completion. */
  killAt: string | null;
  /** How the process ends when it reaches killAt: a real signal, or a clean
   *  transport failure that leaves the process alive (the KS-3c discriminator). */
  killMode?: "sigkill" | "connection_close";
  events?: EventEnvelope[];
  principal?: string;
  hostKey?: HostKey;
  knownKeys?: Record<string, KnownKey>;
  /** fs carrier */
  sharedDir?: string;
  /** git carrier */
  repoDir?: string;
  remote?: string;
  /** Poll/flush only (recovery run). */
  flushOnly?: boolean;
  /** Consumer: rewind the carrier cursor to this position before pulling, so
   *  the SAME bytes are delivered again into a live consumer (oracle Phase 2). */
  rewindTo?: string;
}

class ConnectionClosed extends Error {
  constructor(step: string) {
    super(`transport connection closed at ${step}`);
    this.name = "ConnectionClosed";
  }
}

function makeHook(cfg: FaultWorkerConfig): ((step: string) => void) | undefined {
  if (cfg.killAt === null) return undefined;
  let fired = false;
  return (step: string) => {
    if (fired || step !== cfg.killAt) return;
    fired = true;
    if ((cfg.killMode ?? "sigkill") === "connection_close") throw new ConnectionClosed(step);
    // Untrappable. No unwinding, no fsync, no db close — the point of the case.
    process.kill(process.pid, "SIGKILL");
    // Unreachable; kept so the type is void and the step never "returns normally".
    throw new Error("unreachable");
  };
}

async function main(): Promise<void> {
  const cfg = JSON.parse(fs.readFileSync(process.argv[2] as string, "utf8")) as FaultWorkerConfig;
  const hook = makeHook(cfg);

  const store = new EventStore({
    twiningDir: cfg.storeDir,
    ...(cfg.hostKey ? { hostKey: cfg.hostKey } : {}),
    ...(cfg.knownKeys ? { knownKeys: cfg.knownKeys } : {}),
    ...(hook ? { faultHook: hook } : {}),
  });

  let transport: Transport;
  if (cfg.carrier === "fs") {
    const t = new FsTransport(cfg.sharedDir as string);
    if (hook) t.faultHook = hook;
    transport = t;
  } else {
    const g = new GitTransport({
      twiningDir: cfg.storeDir,
      repoDir: cfg.repoDir as string,
      ...(cfg.remote ? { remote: cfg.remote } : {}),
    });
    if (hook) g.faultHook = hook;
    transport = g;
  }

  const out: Record<string, unknown> = { role: cfg.role, carrier: cfg.carrier, killAt: cfg.killAt };
  try {
    if (cfg.role === "inspect") {
      // Deliberately advances nothing: this is the "at the instant after
      // restart and before reconciliation completes" observation (A5).
      out.inspected = true;
    } else if (cfg.role === "producer") {
      const appended: Array<{ id: string; duplicate: boolean; ok: boolean }> = [];
      if (!cfg.flushOnly) {
        for (const ev of cfg.events ?? []) {
          const r = await store.append(ev, "import");
          appended.push("ok" in r && r.ok === false ? { id: ev.id, duplicate: false, ok: false } : { id: ev.id, duplicate: (r as { duplicate: boolean }).duplicate, ok: true });
        }
      }
      out.appended = appended;
      out.flush = await new Outbox(store, transport).flush();
    } else {
      const inbox = new Inbox(store, transport, cfg.principal as string);
      if (cfg.rewindTo !== undefined) await inbox.rewind(cfg.rewindTo);
      out.pull = await inbox.pull();
    }
    out.status = await store.exchangeStatus();
    out.journal = store.journalRows().map((r) => ({ id: r.id, state: r.state, reason: r.reason, attempts: r.attempts }));
    out.outbox = store.outboxRows();
    out.exit = "clean";
  } catch (err) {
    out.exit = err instanceof ConnectionClosed ? "connection_closed" : "error";
    out.error = (err as Error).message;
    out.journal = store.journalRows().map((r) => ({ id: r.id, state: r.state, reason: r.reason, attempts: r.attempts }));
    out.outbox = store.outboxRows();
  } finally {
    store.close();
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

void main().catch((err: unknown) => {
  process.stderr.write(`fault-worker: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(3);
});
