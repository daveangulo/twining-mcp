/**
 * Shared fixtures for the Stage 0 vertical slice (ADR §12).
 *
 * The oracles are implementation-neutral and use their own vocabularies, so
 * each test file declares its mapping from the oracle's abstract observables
 * onto this store's surface — that declaration is part of the evidence, not a
 * convenience. This file only builds well-formed v3 envelopes and stores.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  computeEventDigest,
  generateKeypair,
  mintEventId,
  mintHostId,
  mintKeyId,
  mintPrincipalId,
  mintRepoId,
  mintStoreId,
  signEvent,
  ENVELOPE_V,
  type Keypair,
} from "../../../src/contracts/index.js";
import { EventStore, type KnownKey } from "../../../src/events/event-store.js";

export interface Identity {
  principal: string;
  host: string;
  keyId: string;
  kp: Keypair;
}

export interface World {
  repo: string;
  storeId: string;
  human: Identity;
  hostA: Identity;
  hostB: Identity;
  knownKeys: Record<string, KnownKey>;
}

let tmpRoots: string[] = [];

/** A fresh principal + host + Ed25519 keypair. */
export function makeIdentity(): Identity {
  return { principal: mintPrincipalId(), host: mintHostId(), keyId: mintKeyId(), kp: generateKeypair() };
}

export function makeWorld(): World {
  const human = makeIdentity();
  const hostA = makeIdentity();
  const hostB = makeIdentity();
  return {
    repo: mintRepoId(),
    storeId: mintStoreId(),
    human,
    hostA,
    hostB,
    knownKeys: {
      [human.keyId]: { publicKeySpkiBase64: human.kp.publicKeySpkiBase64, human: true },
      [hostA.keyId]: { publicKeySpkiBase64: hostA.kp.publicKeySpkiBase64 },
      [hostB.keyId]: { publicKeySpkiBase64: hostB.kp.publicKeySpkiBase64 },
    },
  };
}

export function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `twining-slice-${prefix}-`));
  tmpRoots.push(dir);
  return dir;
}

export function cleanupTempDirs(): void {
  for (const dir of tmpRoots) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  tmpRoots = [];
}

export function newStore(world: World, identity: Identity, dir = tempDir("store"), extraKeys: Record<string, KnownKey> = {}): EventStore {
  return new EventStore({
    twiningDir: dir,
    hostKey: { keyId: identity.keyId, privateKeyPkcs8Pem: identity.kp.privateKeyPkcs8Pem, publicKeySpkiBase64: identity.kp.publicKeySpkiBase64 },
    knownKeys: { ...world.knownKeys, ...extraKeys },
    now: () => "2026-09-15T00:00:00.000Z",
  });
}

/** Trust a fixture identity's key out of band (the constructor bootstrap of ADR §2.4). */
export function keysOf(identities: Array<[Identity, boolean]>): Record<string, KnownKey> {
  return Object.fromEntries(identities.map(([id, human]) => [id.keyId, { publicKeySpkiBase64: id.kp.publicKeySpkiBase64, ...(human ? { human: true } : {}) }]));
}

export interface EventSpec {
  id?: string;
  kind?: string;
  record?: { type: string; id: string };
  scope: Record<string, unknown>;
  producer: { principal: string; kind: "human" | "agent" | "host"; host: string; asserted_actor?: string };
  parents?: string[];
  evidence_class: string;
  occurred_at?: string;
  payload: Record<string, unknown>;
  /** The PRODUCING checkout — labels only; never identity (R01). */
  source?: { repo?: string; worktree?: string; branch?: string; commit?: string; dirty?: boolean };
  signWith?: { keyId: string; kp: Keypair };
}

/** Build a complete, digested (and optionally signed) envelope. */
export function buildEvent(spec: EventSpec): Record<string, unknown> {
  const id = spec.id ?? mintEventId();
  const ev: Record<string, unknown> = {
    v: ENVELOPE_V,
    id,
    kind: spec.kind ?? "created",
    ...(spec.record === undefined && (spec.kind ?? "created") !== "receipt" ? { record: { type: "decision", id } } : {}),
    ...(spec.record ? { record: spec.record } : {}),
    scope: spec.scope,
    producer: spec.producer,
    ...(spec.source ? { source: spec.source } : {}),
    parents: spec.parents ?? [],
    evidence_class: spec.evidence_class,
    occurred_at: spec.occurred_at ?? "2026-09-15T12:00:00.000Z",
    payload: spec.payload,
  };
  ev.digest = computeEventDigest(ev);
  if (spec.signWith) ev.sig = { alg: "ed25519", key: spec.signWith.keyId, value: signEvent(ev, spec.signWith.kp.privateKeyPkcs8Pem) };
  return ev;
}

/** `created` helper: the record id is the event id, as the contract requires. */
export function created(type: string, spec: Omit<EventSpec, "record" | "kind">): Record<string, unknown> {
  const id = spec.id ?? mintEventId();
  return buildEvent({ ...spec, id, kind: "created", record: { type, id } });
}

/** Principal records for a set of fixture identities (needed so keys resolve after import). */
export function principalEvents(
  repo: string,
  producer: Identity,
  people: Array<{ id: Identity; kind: "human" | "agent" }>,
): Array<Record<string, unknown>> {
  return people.map((p) =>
    created("principal", {
      scope: { repo },
      producer: { principal: producer.principal, kind: "agent", host: producer.host },
      evidence_class: "proposal",
      payload: { principal_id: p.id.principal, kind: p.kind, host: p.id.host, key_id: p.id.keyId, public_key: p.id.kp.publicKeySpkiBase64 },
    }),
  );
}

/** A membership policy record (must be a causal ancestor of anything it authorizes). */
export function membershipEvent(
  repo: string,
  storeId: string,
  producer: Identity,
  members: Array<{ principal: string; roles: string[]; scopes: Array<Record<string, unknown>> }>,
  parents: string[] = [],
): Record<string, unknown> {
  return created("membership", {
    scope: { repo },
    producer: { principal: producer.principal, kind: "agent", host: producer.host },
    parents,
    evidence_class: "proposal",
    payload: { store_id: storeId, members },
  });
}

/** Deliver raw envelopes straight into a store's inbox path (no carrier). */
export function deliver(store: EventStore, envelopes: Array<Record<string, unknown>>): void {
  for (const e of envelopes) store.receive(e, "direct");
}

/**
 * Re-stamp an already-built envelope so it cites `extra` among its parents,
 * recomputing the digest and re-signing with whichever fixture key signed it.
 *
 * ADR §4.3.1 requires a membership to be a causal ancestor of anything it
 * authorizes, so a fixture that delivers a policy alongside the events it
 * grants must LINK them or every one of those events is quarantined
 * `no_policy_yet`. `created()` fixes the record id up front and `parents` feeds
 * only the digest and signature, so re-parenting preserves every id a test
 * already captured.
 */
export function citeParents(world: World, envelope: Record<string, unknown>, extra: string[]): Record<string, unknown> {
  const parents = [...new Set([...((envelope.parents as string[] | undefined) ?? []), ...extra])];
  const { digest: _d, sig, ...rest } = envelope;
  const next: Record<string, unknown> = { ...rest, parents };
  next.digest = computeEventDigest(next);
  if (sig) {
    const keyId = (sig as { key: string }).key;
    const signer = [world.human, world.hostA, world.hostB].find((i) => i.keyId === keyId);
    if (!signer) throw new Error(`citeParents: no fixture identity holds key ${keyId}`);
    next.sig = { alg: "ed25519", key: keyId, value: signEvent(next, signer.kp.privateKeyPkcs8Pem) };
  }
  return next;
}

/**
 * Deliver a policy and the events it authorizes, with the membership cited as
 * their causal ancestor. The policy events go in untouched (a membership and
 * the principals it names legitimately precede any policy); everything else is
 * re-parented onto the whole infrastructure set.
 */
export function deliverUnderPolicy(
  store: EventStore,
  world: World,
  policy: Array<Record<string, unknown>>,
  authorized: Array<Record<string, unknown>>,
): void {
  const infraIds = policy.map((e) => e.id as string);
  deliver(store, [...policy, ...authorized.map((e) => citeParents(world, e, infraIds))]);
}

export async function admitAndProject(store: EventStore): Promise<void> {
  await store.admit();
  await store.project();
}

export function readEventFile(store: EventStore, eventId: string, occurredAt = "2026-09-15T12:00:00.000Z"): Record<string, unknown> {
  const file = path.join(store.eventsDir, occurredAt.slice(0, 7), `${eventId}.json`);
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

/**
 * Bootstrap a store policy: principal records for everyone, then one
 * membership. The first membership is creatable without a policy (otherwise a
 * store could never acquire one); after that, changing it needs `rule`.
 */
export function policyEvents(
  world: World,
  grants: Array<{ principal: string; roles: string[]; scopes: Array<Record<string, unknown>> }>,
  producer: Identity,
): Array<Record<string, unknown>> {
  const principalRecords = [
    { id: world.human, kind: "human" as const },
    { id: world.hostA, kind: "agent" as const },
    { id: world.hostB, kind: "agent" as const },
  ].map((p) =>
    created("principal", {
      scope: { repo: world.repo },
      producer: { principal: producer.principal, kind: "agent", host: producer.host },
      evidence_class: "proposal",
      payload: {
        principal_id: p.id.principal,
        kind: p.kind,
        host: p.id.host,
        key_id: p.id.keyId,
        public_key: p.id.kp.publicKeySpkiBase64,
      },
    }),
  );
  const membership = created("membership", {
    scope: { repo: world.repo },
    producer: { principal: producer.principal, kind: "agent", host: producer.host },
    evidence_class: "proposal",
    payload: { store_id: world.storeId, members: grants },
  });
  return [...principalRecords, membership];
}
