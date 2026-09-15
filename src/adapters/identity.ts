/**
 * Principal identity for host adapters and the CLI (ADR §2.1, lane 03).
 *
 * Three identities, three files, three lifetimes:
 *   - HOST key      `<identityHome>/host/host.json`      — minted on first run
 *                   on a machine; signs everything an adapter or the CLI
 *                   appends. Never passphrase-protected: a hook must be able
 *                   to sign unattended.
 *   - AGENT/service principal — has no key of its own; it acts THROUGH the
 *                   host key and is carried in `producer.asserted_actor`
 *                   (today's agent_id), which is recorded and never
 *                   authoritative.
 *   - HUMAN key     `<identityHome>/human-<p_…>/key.json` — passphrase
 *                   protected (PKCS8 + aes-256-cbc), only ever unlocked by
 *                   the TTY ceremony (`twining rule`). The ONLY key whose
 *                   signature may carry `human_ruling`.
 *
 * `<identityHome>` is `$TWINING_IDENTITY_HOME`, else `$HOME/.twining/identity`.
 * Both are honoured so tests can point HOME (or the more explicit override)
 * at a temp dir and never touch the developer's real key.
 *
 * The store side is `.twining/store.json` — `store_id` says where the bytes
 * live, `repo_ids` which repositories they cover, `format` which envelope
 * generation the store is on. A store is "v3-enabled" iff that file exists
 * with `format: 3`; every v3 write path checks that and otherwise leaves 2.x
 * behavior exactly as it was.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPrivateKey } from "node:crypto";

import {
  generateKeypair,
  mintHostId,
  mintKeyId,
  mintPrincipalId,
  mintRepoId,
  mintStoreId,
  sha256Hex,
  STORE_FORMAT_VERSION,
} from "../contracts/index.js";

export interface HostIdentity {
  host_id: string;
  principal_id: string;
  key_id: string;
  public_key: string;
  /** Unencrypted PKCS8 PEM — host keys sign unattended. */
  private_key: string;
  created_at: string;
}

export interface HumanIdentityFile {
  principal_id: string;
  key_id: string;
  public_key: string;
  /** PKCS8 PEM encrypted with aes-256-cbc under the passphrase. */
  encrypted_private_key: string;
  label?: string;
  created_at: string;
}

export interface StoreDescriptor {
  store_id: string;
  repo_ids: string[];
  format: number;
  created_at: string;
}

export interface IdentityEnv {
  TWINING_IDENTITY_HOME?: string;
  HOME?: string;
  [k: string]: string | undefined;
}

/** Where identity files live for this process (test-overridable). */
export function identityHome(env: IdentityEnv = process.env): string {
  if (env.TWINING_IDENTITY_HOME && env.TWINING_IDENTITY_HOME.trim().length > 0) {
    return env.TWINING_IDENTITY_HOME;
  }
  const home = env.HOME && env.HOME.trim().length > 0 ? env.HOME : os.homedir();
  return path.join(home, ".twining", "identity");
}

function writePrivate(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, content, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort on filesystems without POSIX modes */
  }
}

export function hostIdentityPath(env: IdentityEnv = process.env): string {
  return path.join(identityHome(env), "host", "host.json");
}

/** Read the host identity, or null when this machine has none yet. */
export function readHostIdentity(env: IdentityEnv = process.env): HostIdentity | null {
  const file = hostIdentityPath(env);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as HostIdentity;
    if (!parsed.host_id || !parsed.key_id || !parsed.private_key) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Mint the host identity if absent, else return the existing one. Idempotent:
 * two concurrent first runs can race, and the loser simply re-reads the
 * winner's file rather than overwriting a key that events may already be
 * signed with.
 */
export function ensureHostIdentity(env: IdentityEnv = process.env): HostIdentity {
  const existing = readHostIdentity(env);
  if (existing) return existing;

  const kp = generateKeypair();
  const identity: HostIdentity = {
    host_id: mintHostId(),
    principal_id: mintPrincipalId(),
    key_id: mintKeyId(),
    public_key: kp.publicKeySpkiBase64,
    private_key: kp.privateKeyPkcs8Pem,
    created_at: new Date().toISOString(),
  };
  const file = hostIdentityPath(env);
  writePrivate(file, JSON.stringify(identity, null, 2) + "\n");
  // Re-read: if another process won the race its bytes are authoritative.
  return readHostIdentity(env) ?? identity;
}

export function humanIdentityDir(principalId: string, env: IdentityEnv = process.env): string {
  return path.join(identityHome(env), `human-${principalId}`);
}

/** List the human principals whose keys this machine holds. */
export function listHumanIdentities(env: IdentityEnv = process.env): HumanIdentityFile[] {
  const home = identityHome(env);
  let entries: string[];
  try {
    entries = fs.readdirSync(home);
  } catch {
    return [];
  }
  const out: HumanIdentityFile[] = [];
  for (const entry of entries) {
    if (!entry.startsWith("human-")) continue;
    try {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(home, entry, "key.json"), "utf-8"),
      ) as HumanIdentityFile;
      if (parsed.principal_id && parsed.key_id) out.push(parsed);
    } catch {
      /* an unreadable identity dir is reported by `twining doctor`, not thrown here */
    }
  }
  return out;
}

/**
 * Mint a human principal. The private key is written PASSPHRASE-ENCRYPTED —
 * a key that unlocks without a secret is not a ceremony, it is a file an
 * agent can read.
 */
export function createHumanIdentity(
  passphrase: string,
  opts: { label?: string; env?: IdentityEnv } = {},
): HumanIdentityFile {
  if (passphrase.length < 8) {
    throw new Error("a human key passphrase must be at least 8 characters");
  }
  const env = opts.env ?? process.env;
  const kp = generateKeypair();
  const encrypted = createPrivateKey(kp.privateKeyPkcs8Pem).export({
    type: "pkcs8",
    format: "pem",
    cipher: "aes-256-cbc",
    passphrase,
  }) as string;

  const file: HumanIdentityFile = {
    principal_id: mintPrincipalId(),
    key_id: mintKeyId(),
    public_key: kp.publicKeySpkiBase64,
    encrypted_private_key: encrypted,
    ...(opts.label ? { label: opts.label } : {}),
    created_at: new Date().toISOString(),
  };
  writePrivate(
    path.join(humanIdentityDir(file.principal_id, env), "key.json"),
    JSON.stringify(file, null, 2) + "\n",
  );
  return file;
}

/** Decrypt a human key. Throws on a wrong passphrase — never returns a partial. */
export function unlockHumanIdentity(
  file: HumanIdentityFile,
  passphrase: string,
): { privateKeyPkcs8Pem: string; publicKeySpkiBase64: string; keyId: string; principalId: string } {
  let key;
  try {
    key = createPrivateKey({ key: file.encrypted_private_key, format: "pem", passphrase });
  } catch {
    throw new Error("could not unlock the human key — wrong passphrase?");
  }
  return {
    privateKeyPkcs8Pem: key.export({ type: "pkcs8", format: "pem" }) as string,
    publicKeySpkiBase64: file.public_key,
    keyId: file.key_id,
    principalId: file.principal_id,
  };
}

// ------------------------------------------------------------------ the store

export function storeDescriptorPath(twiningDir: string): string {
  return path.join(twiningDir, "store.json");
}

export function readStoreDescriptor(twiningDir: string): StoreDescriptor | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(storeDescriptorPath(twiningDir), "utf-8"),
    ) as StoreDescriptor;
    if (typeof parsed.store_id !== "string" || typeof parsed.format !== "number") return null;
    if (!Array.isArray(parsed.repo_ids)) parsed.repo_ids = [];
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Is this store on the v3 contract? Every v3 write path asks this and takes
 * the 2.x path when the answer is no — that is the whole compatibility story
 * for an un-migrated field checkout.
 */
export function isV3Store(twiningDir: string): boolean {
  const d = readStoreDescriptor(twiningDir);
  return d !== null && d.format === STORE_FORMAT_VERSION;
}

/**
 * Create or extend `.twining/store.json`. Idempotent: an existing descriptor
 * keeps its `store_id` (events already cite it) and simply gains the repo id
 * if this repository is new to a shared store.
 */
export function ensureStoreDescriptor(
  twiningDir: string,
  opts: { format?: number; repoId?: string } = {},
): { descriptor: StoreDescriptor; created: boolean; repoId: string } {
  const existing = readStoreDescriptor(twiningDir);
  if (existing) {
    const repoId = opts.repoId ?? existing.repo_ids[0] ?? mintRepoId();
    let changed = false;
    if (!existing.repo_ids.includes(repoId)) {
      existing.repo_ids.push(repoId);
      changed = true;
    }
    if (opts.format !== undefined && existing.format !== opts.format) {
      existing.format = opts.format;
      changed = true;
    }
    if (changed) {
      fs.mkdirSync(twiningDir, { recursive: true });
      fs.writeFileSync(storeDescriptorPath(twiningDir), JSON.stringify(existing, null, 2) + "\n");
    }
    return { descriptor: existing, created: false, repoId };
  }

  const repoId = opts.repoId ?? mintRepoId();
  const descriptor: StoreDescriptor = {
    store_id: mintStoreId(),
    repo_ids: [repoId],
    format: opts.format ?? STORE_FORMAT_VERSION,
    created_at: new Date().toISOString(),
  };
  fs.mkdirSync(twiningDir, { recursive: true });
  fs.writeFileSync(storeDescriptorPath(twiningDir), JSON.stringify(descriptor, null, 2) + "\n");
  return { descriptor, created: true, repoId };
}

/** The repo id this store uses for `scope.repo` (first declared wins). */
export function repoIdFor(twiningDir: string): string | null {
  const d = readStoreDescriptor(twiningDir);
  return d?.repo_ids[0] ?? null;
}

/**
 * Stable per-worktree token. A path is a LABEL (R01), so the token is a hash
 * of the realpath rather than the path itself: it survives being rendered in
 * an event without pinning the producer's directory layout into the record.
 */
export function worktreeToken(dir: string): string {
  let real = dir;
  try {
    real = fs.realpathSync(dir);
  } catch {
    /* a not-yet-created dir hashes by its logical path */
  }
  return `wt_${sha256Hex(real).slice(0, 16)}`;
}
