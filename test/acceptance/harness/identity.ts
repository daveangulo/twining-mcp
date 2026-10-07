/**
 * Synthetic identity factory for the acceptance harness (lane 05).
 *
 * The oracles name their principals, hosts, stores, repos and revisions in
 * their own vocabulary (`u.rowan.mbele`, `host-anvil-01`, `store-basalt-local`,
 * `repo-quarry-service`, `r-c40d`). None of those are valid v3 ids. This module
 * is the ONLY place that maps an oracle label onto a well-formed synthetic
 * identity, and it does so deterministically per `World` so a test can say
 * `w.principal("u.rowan.mbele")` twice and get the same principal.
 *
 * R01: repository/host/store/session identity is independent of remote URLs,
 * local paths and branch names. Labels here are labels; the identity is the
 * minted id, and renaming a label must never change a decision.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  generateKeypair,
  mintEventId,
  mintHostId,
  mintKeyId,
  mintPrincipalId,
  mintRepoId,
  mintStoreId,
  type Keypair,
} from "../../../src/contracts/index.js";
import { EventStore, type KnownKey } from "../../../src/events/event-store.js";

export interface Actor {
  /** The oracle's own label, retained for report legibility. */
  label: string;
  principal: string;
  host: string;
  keyId: string;
  kp: Keypair;
  /** Human principals may author `human_ruling`; agents may not. */
  human: boolean;
}

export interface RepoRef {
  label: string;
  repo: string;
  /** Oracle revision label -> 40-hex synthetic sha. */
  revision(label: string): string;
}

const tmpRoots: string[] = [];

export function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `twining-acc-${prefix}-`));
  tmpRoots.push(dir);
  return dir;
}

export function cleanupTempDirs(): void {
  while (tmpRoots.length) {
    const dir = tmpRoots.pop();
    if (!dir) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

/** Deterministic 40-hex from a label — a synthetic commit sha with no collisions in practice. */
export function syntheticSha(label: string): string {
  return crypto.createHash("sha1").update(label).digest("hex");
}

/**
 * A world is one acceptance run's identity space: named actors, named repos,
 * one store id, and the key ring every replica in the run trusts.
 */
export class World {
  readonly storeId = mintStoreId();
  private readonly actors = new Map<string, Actor>();
  private readonly repos = new Map<string, RepoRef>();

  /** Mint (or return) the actor behind an oracle label. */
  actor(label: string, opts: { human?: boolean } = {}): Actor {
    const existing = this.actors.get(label);
    if (existing) return existing;
    const a: Actor = {
      label,
      principal: mintPrincipalId(),
      host: mintHostId(),
      keyId: mintKeyId(),
      kp: generateKeypair(),
      human: opts.human ?? false,
    };
    this.actors.set(label, a);
    return a;
  }

  /** Mint (or return) the repo behind an oracle label. */
  repoRef(label: string): RepoRef {
    const existing = this.repos.get(label);
    if (existing) return existing;
    const repo = mintRepoId();
    const r: RepoRef = { label, repo, revision: (rev: string) => syntheticSha(`${label}:${rev}`) };
    this.repos.set(label, r);
    return r;
  }

  /** Shorthand: the v3 repo id for an oracle repo label. */
  repo(label: string): string {
    return this.repoRef(label).repo;
  }

  everyActor(): Actor[] {
    return [...this.actors.values()];
  }

  /**
   * The out-of-band trusted key ring (ADR §2.4 bootstrap). A human key becomes
   * trusted only here or via a principal event signed by an already-trusted
   * human key — never by a caller-supplied field.
   */
  knownKeys(only?: string[]): Record<string, KnownKey> {
    const out: Record<string, KnownKey> = {};
    for (const a of this.actors.values()) {
      if (only && !only.includes(a.label)) continue;
      out[a.keyId] = { publicKeySpkiBase64: a.kp.publicKeySpkiBase64, ...(a.human ? { human: true } : {}) };
    }
    return out;
  }
}

export interface ReplicaOptions {
  /** Directory the store owns. Defaults to a fresh temp dir (disconnected by construction). */
  dir?: string;
  /** Restrict the key ring this replica trusts — credential separation. */
  trusts?: string[];
  /** Injected clock. Default is a fixed instant so digests are reproducible. */
  now?: () => string;
}

export const FIXED_NOW = "2026-09-15T00:00:00.000Z";

/**
 * One replica = one independent store directory + one host key. Two replicas
 * built from the same World share nothing but the key ring they were told to
 * trust; there is no shared database, cache or process state between them.
 */
export class Replica {
  readonly dir: string;
  private currentStore: EventStore;

  constructor(
    readonly name: string,
    readonly world: World,
    readonly identity: Actor,
    readonly options: ReplicaOptions = {},
  ) {
    this.dir = options.dir ?? tempDir(`replica-${name}`);
    this.currentStore = this.open();
  }

  private open(): EventStore {
    return new EventStore({
      twiningDir: this.dir,
      hostKey: {
        keyId: this.identity.keyId,
        privateKeyPkcs8Pem: this.identity.kp.privateKeyPkcs8Pem,
        publicKeySpkiBase64: this.identity.kp.publicKeySpkiBase64,
      },
      knownKeys: this.world.knownKeys(this.options.trusts),
      now: this.options.now ?? (() => FIXED_NOW),
    });
  }

  get store(): EventStore {
    return this.currentStore;
  }

  /**
   * Cold restart: drop every process-resident handle and reopen against the
   * same on-disk store. This is the in-process stand-in for SIGKILL + restart.
   * It is NOT a kill: it cannot lose data an implementation buffered in memory
   * behind a graceful close. C18's kill scenarios require a real process kill,
   * which `scripts/qualify/c28-remote/` performs out of process.
   */
  restart(): EventStore {
    this.currentStore.close();
    this.currentStore = this.open();
    return this.currentStore;
  }

  close(): void {
    this.currentStore.close();
  }
}

/** A fresh, unused event id — for tests that need an id the store has never seen. */
export const freshEventId = mintEventId;
