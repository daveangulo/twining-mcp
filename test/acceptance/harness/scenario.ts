/**
 * Scenario driver for the acceptance harness (lane 05).
 *
 * Builds well-formed v3 envelopes over a `World`, drives two or more replicas,
 * and carries events between them over a real transport with injectable
 * faults. It knows nothing about any oracle's expectations: a test declares
 * its own mapping from the oracle's abstract observables onto these calls, and
 * that declaration is part of the evidence.
 */
import fs from "node:fs";
import path from "node:path";

import {
  computeEventDigest,
  signEvent,
  mintEventId,
  ENVELOPE_V,
  type EventEnvelope,
} from "../../../src/contracts/index.js";
import type { EventStore } from "../../../src/events/event-store.js";
import type { Cursor } from "../../../src/contracts/store-api.js";
import { FsTransport, LostReceiptError, type TransportFaults } from "../../../src/exchange/fs-transport.js";
import { ReferenceRelay } from "../../../src/exchange/relay.js";
import { Replica, World, tempDir, type Actor } from "./identity.js";

export const OCCURRED_AT = "2026-09-15T12:00:00.000Z";

export interface BuildSpec {
  id?: string;
  kind?: string;
  record?: { type: string; id: string };
  scope: Record<string, unknown>;
  by: Actor;
  /** Producer kind. `human` only for actors minted with `{human: true}`. */
  producerKind?: "human" | "agent" | "host";
  parents?: string[];
  evidence_class: string;
  occurred_at?: string;
  payload: Record<string, unknown>;
  source?: { repo?: string; worktree?: string; branch?: string; commit?: string; dirty?: boolean };
  /** Sign with this actor's key. Omit to leave unsigned (the store may host-sign on append). */
  signBy?: Actor;
}

/** Build a complete, digested (and optionally signed) envelope. */
export function build(spec: BuildSpec): Record<string, unknown> {
  const id = spec.id ?? mintEventId();
  const kind = spec.kind ?? "created";
  const ev: Record<string, unknown> = {
    v: ENVELOPE_V,
    id,
    kind,
    ...(spec.record === undefined && kind !== "receipt" ? { record: { type: "decision", id } } : {}),
    ...(spec.record ? { record: spec.record } : {}),
    scope: spec.scope,
    producer: {
      principal: spec.by.principal,
      kind: spec.producerKind ?? (spec.by.human ? "human" : "agent"),
      host: spec.by.host,
    },
    ...(spec.source ? { source: spec.source } : {}),
    parents: spec.parents ?? [],
    evidence_class: spec.evidence_class,
    occurred_at: spec.occurred_at ?? OCCURRED_AT,
    payload: spec.payload,
  };
  ev.digest = computeEventDigest(ev);
  if (spec.signBy) {
    ev.sig = { alg: "ed25519", key: spec.signBy.keyId, value: signEvent(ev, spec.signBy.kp.privateKeyPkcs8Pem) };
  }
  return ev;
}

/** `created` helper: the record id IS the event id, as the contract requires. */
export function createdRecord(type: string, spec: Omit<BuildSpec, "record" | "kind">): Record<string, unknown> {
  const id = spec.id ?? mintEventId();
  return build({ ...spec, id, kind: "created", record: { type, id } });
}

/** Principal records for a set of actors (so their keys resolve after import). */
export function principalEvents(repo: string, producer: Actor, people: Actor[]): Array<Record<string, unknown>> {
  return people.map((p) =>
    createdRecord("principal", {
      scope: { repo },
      by: producer,
      producerKind: "agent",
      evidence_class: "proposal",
      payload: {
        principal_id: p.principal,
        kind: p.human ? "human" : "agent",
        host: p.host,
        key_id: p.keyId,
        public_key: p.kp.publicKeySpkiBase64,
      },
    }),
  );
}

export interface Grant {
  principal: string;
  roles: string[];
  scopes: Array<Record<string, unknown>>;
}

/** The store's first membership: creatable without a prior policy, per ADR §2.4. */
export function membershipEvent(repo: string, storeId: string, producer: Actor, members: Grant[], parents: string[] = []): Record<string, unknown> {
  return createdRecord("membership", {
    scope: { repo },
    by: producer,
    producerKind: "agent",
    parents,
    evidence_class: "proposal",
    payload: { store_id: storeId, members },
  });
}

/** principals + one membership — the minimum policy a store needs. */
export function policyEvents(world: World, repo: string, producer: Actor, actors: Actor[], grants: Grant[]): Array<Record<string, unknown>> {
  return [...principalEvents(repo, producer, actors), membershipEvent(repo, world.storeId, producer, grants)];
}

// ------------------------------------------------------------------- driving

/** Deliver raw envelopes straight into a store (no carrier) and settle them. */
export function deliver(store: EventStore, envelopes: Array<Record<string, unknown>>, carrier = "direct"): void {
  for (const e of envelopes) store.receive(e, carrier);
}

export async function settle(store: EventStore): Promise<void> {
  // Admission can unblock parents in waves (pending_parents -> admitted), so
  // run to a fixed point rather than once. Bounded: a cycle is impossible
  // because parents are a DAG, but the bound is kept explicit.
  for (let i = 0; i < 8; i++) {
    const before = (await store.events({})).length;
    await store.admit();
    const after = (await store.events({})).length;
    if (after === before) break;
  }
  await store.admit();
  await store.project();
}

export async function deliverAndSettle(store: EventStore, envelopes: Array<Record<string, unknown>>, carrier = "direct"): Promise<void> {
  deliver(store, envelopes, carrier);
  await settle(store);
}

// ----------------------------------------------------------------- transport

export type CarrierKind = "fs" | "relay";

export interface Carrier {
  kind: CarrierKind;
  id(): string;
  publish(events: EventEnvelope[]): Promise<Record<string, string>>;
  poll(cursor: Cursor | null): Promise<{ events: EventEnvelope[]; cursor: Cursor }>;
  ack(consumer: string, cursor: Cursor): Promise<void>;
  setFaults(faults: TransportFaults): void;
}

/**
 * A disposable carrier between replicas. `fs` is a shared directory standing
 * in for a remote; `relay` is the in-process reference relay with credential
 * separation. Neither is a real Git remote: a Git-carrier run is what
 * `scripts/qualify/c28-remote/` exists to perform, and any result obtained
 * over these carriers must be reported as a carrier substitution.
 */
export function carrier(kind: CarrierKind, opts: { principal?: string; token?: string } = {}): Carrier {
  if (kind === "fs") {
    const t = new FsTransport(tempDir("carrier-fs"));
    return {
      kind,
      id: () => t.id(),
      publish: async (events) => (await t.publish(events)).carrier_ids,
      poll: (cursor) => t.poll(cursor),
      ack: (consumer, cursor) => t.ack(consumer, cursor),
      setFaults: (f) => t.setFaults(f),
    };
  }
  const relay = new ReferenceRelay();
  const principal = opts.principal ?? "acc-harness";
  const token = opts.token ?? "acc-token";
  relay.register(principal, token);
  const client = relay.client(principal, token);
  return {
    kind,
    id: () => client.id(),
    publish: async (events) => (await client.publish(events)).carrier_ids,
    poll: (cursor) => client.poll(cursor),
    ack: (consumer, cursor) => client.ack(consumer, cursor),
    setFaults: (f) => client.setFaults(f),
  };
}

export { LostReceiptError };

export interface ExchangeResult {
  published: Record<string, string>;
  polled: number;
  cursor: Cursor;
  /** The publish receipt was lost after the carrier durably took the bytes. */
  receiptLost: boolean;
}

/**
 * One producer -> carrier -> consumer hop, with the cursor bookkeeping the
 * delivery ladder needs. Returns enough to assert on both sides independently
 * (R08: the transfer ladder and the admission ladder are never collapsed).
 */
export async function exchange(
  from: Replica,
  to: Replica,
  car: Carrier,
  opts: { consumer?: string; cursor?: Cursor | null; ack?: boolean } = {},
): Promise<ExchangeResult> {
  const pending = from.store.outboxPending(car.id());
  let published: Record<string, string> = {};
  let receiptLost = false;
  try {
    published = await car.publish(pending);
    for (const ev of pending) {
      const carrierId = published[ev.digest];
      if (carrierId) from.store.recordPublishReceipt(car.id(), ev.id, carrierId);
    }
  } catch (err) {
    if (!(err instanceof LostReceiptError)) throw err;
    receiptLost = true;
    for (const ev of pending) from.store.recordPublishAttempt(car.id(), ev.id, ev.digest);
  }
  const consumer = opts.consumer ?? to.identity.principal;
  const start = opts.cursor === undefined ? await to.store.cursor(consumer) : opts.cursor;
  const { events, cursor } = await car.poll(start);
  for (const ev of events) to.store.receive(ev, car.id());
  await settle(to.store);
  if (opts.ack !== false) {
    await car.ack(consumer, cursor);
    await to.store.setCursor(consumer, cursor);
  }
  return { published, polled: events.length, cursor, receiptLost };
}

// -------------------------------------------------------------- fault hooks

export interface FaultHooks {
  /** Truncate an event file on disk to N bytes (torn write). */
  truncateEventFile(store: EventStore, eventId: string, bytes: number, occurredAt?: string): void;
  /** Corrupt an event file's bytes in place. */
  corruptEventFile(store: EventStore, eventId: string, mutate: (s: string) => string, occurredAt?: string): void;
  /** Delete the derived database so the next open must rebuild. */
  dropDerivedIndex(store: EventStore): void;
}

function eventFilePath(store: EventStore, eventId: string, occurredAt = OCCURRED_AT): string {
  return path.join(store.eventsDir, occurredAt.slice(0, 7), `${eventId}.json`);
}

export const faults: FaultHooks = {
  truncateEventFile(store, eventId, bytes, occurredAt) {
    const p = eventFilePath(store, eventId, occurredAt);
    const buf = fs.readFileSync(p);
    fs.writeFileSync(p, buf.subarray(0, bytes));
  },
  corruptEventFile(store, eventId, mutate, occurredAt) {
    const p = eventFilePath(store, eventId, occurredAt);
    fs.writeFileSync(p, mutate(fs.readFileSync(p, "utf8")));
  },
  dropDerivedIndex(store) {
    for (const f of ["events.db", "events.db-wal", "events.db-shm"]) {
      try {
        fs.rmSync(path.join(store.twiningDir, f), { force: true });
      } catch {
        /* best effort */
      }
    }
  },
};

export function readEventFile(store: EventStore, eventId: string, occurredAt = OCCURRED_AT): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(eventFilePath(store, eventId, occurredAt), "utf8")) as Record<string, unknown>;
}

export { eventFilePath };
