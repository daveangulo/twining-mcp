/**
 * The v3 CLI verbs (lane 03, brief step 1): `identity`, `rule`, `events`,
 * `sync`, `doctor`, `hook`.
 *
 * These are CLI-NATIVE, not command-registry commands, and that is a design
 * decision rather than an implementation shortcut:
 *
 *   - `rule` MUST be unreachable from the registry. The ceremony is the only
 *     producer of a `human_ruling` (ADR §2.3), so it must not be a thing an
 *     MCP peer or a command dispatcher can call at all. Making it a registry
 *     command and then refusing at runtime would leave the capability one
 *     forgotten guard away from being real.
 *   - `identity`, `sync` and `doctor` are operator verbs about the machine and
 *     the store, not about the project's records. Registering them as MCP
 *     tools would put key management on an LLM's tool list for no benefit.
 *   - `events` is a raw-log reader; lane 04 owns the retrieval surface.
 *
 * Every verb prints the same envelope shape as the command front end.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

import {
  buildEvent,
  type BuildEventSpec,
} from "../adapters/event-factory.js";
import {
  createHumanIdentity,
  ensureHostIdentity,
  ensureStoreDescriptor,
  hostIdentityPath,
  identityHome,
  isV3Store,
  listHumanIdentities,
  readStoreDescriptor,
  unlockHumanIdentity,
  type HumanIdentityFile,
} from "../adapters/identity.js";
import { openRuntime, type V3Runtime } from "../adapters/runtime.js";
import { captureSource } from "../adapters/source.js";
import { CLAUDE_CODE_MATRIX, claudeCodeCoverage } from "../adapters/claude-code.js";
import { CODEX_MATRIX, codexCoverage } from "../adapters/codex.js";
import { EventStore } from "../events/event-store.js";
import { STORE_FORMAT_VERSION, type Scope } from "../contracts/index.js";

export const V3_VERBS = ["identity", "rule", "events", "sync", "doctor", "hook"] as const;
export type V3Verb = (typeof V3_VERBS)[number];

export function isV3Verb(word: string): word is V3Verb {
  return (V3_VERBS as readonly string[]).includes(word);
}

export interface VerbOutcome {
  /** 0 ok, 1 command error, 2 usage. */
  exitCode: number;
  /** Result object for the success envelope. */
  result?: unknown;
  error?: { code: string; message: string };
  /** Raw stdout that bypasses the envelope (hook responses only). */
  raw?: string;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  return args[i + 1];
}
function has(args: string[], name: string): boolean {
  return args.includes(name);
}
function list(args: string[], name: string): string[] {
  const v = flag(args, name);
  if (!v) return [];
  return v
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// -------------------------------------------------------------- identity init

export async function runIdentity(args: string[], projectRoot: string, env: NodeJS.ProcessEnv): Promise<VerbOutcome> {
  const sub = args[0];
  if (sub !== "init") {
    return { exitCode: 2, error: { code: "USAGE", message: "usage: twining identity init [--human] [--label <name>]" } };
  }
  const rest = args.slice(1);
  const host = ensureHostIdentity(env);
  const twiningDir = path.join(projectRoot, ".twining");
  const { descriptor, created, repoId } = ensureStoreDescriptor(twiningDir, {
    format: STORE_FORMAT_VERSION,
  });

  const result: Record<string, unknown> = {
    identity_home: identityHome(env),
    host: {
      host_id: host.host_id,
      principal_id: host.principal_id,
      key_id: host.key_id,
      file: hostIdentityPath(env),
    },
    store: {
      store_id: descriptor.store_id,
      repo_id: repoId,
      format: descriptor.format,
      created: created,
      file: path.join(twiningDir, "store.json"),
    },
    humans: listHumanIdentities(env).map((h) => ({ principal_id: h.principal_id, key_id: h.key_id, label: h.label })),
  };

  if (!has(rest, "--human")) return { exitCode: 0, result };

  // A human key is passphrase-protected, always. The passphrase comes from the
  // TTY, or — for automated qualification runs that legitimately need a
  // fixture human key — from an explicit env var that a host adapter never
  // sets. There is no unprotected form.
  const fromEnv = env.TWINING_HUMAN_PASSPHRASE;
  const passphrase = fromEnv ?? (await promptSecret("passphrase for the new human key: "));
  if (!passphrase || passphrase.length < 8) {
    return {
      exitCode: 1,
      error: { code: "PASSPHRASE_REQUIRED", message: "a human key needs a passphrase of at least 8 characters" },
    };
  }
  const human = createHumanIdentity(passphrase, {
    ...(flag(rest, "--label") ? { label: flag(rest, "--label") as string } : {}),
    env,
  });
  result.human = {
    principal_id: human.principal_id,
    key_id: human.key_id,
    label: human.label ?? null,
    file: path.join(identityHome(env), `human-${human.principal_id}`, "key.json"),
    note:
      "this key is the root of trust for rulings on this machine. It is passphrase-protected; " +
      "back it up out of band, and remember that an agent with your filesystem can copy the file " +
      "but cannot use it without the passphrase.",
  };
  return { exitCode: 0, result };
}

async function promptSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) return "";
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  return new Promise<string>((resolve) => {
    const onData = (): void => {
      // Best-effort echo suppression; readline in terminal mode still echoes on
      // some platforms, which is why the prompt says so rather than pretending.
    };
    process.stdin.on("data", onData);
    rl.question(prompt, (answer) => {
      process.stdin.off("data", onData);
      rl.close();
      resolve(answer);
    });
  });
}

// ---------------------------------------------------------------- the ceremony

export interface CeremonyRefusal {
  code: "NOT_A_TTY" | "AGENT_CONTEXT" | "REGISTRY_INVOCATION" | "NO_HUMAN_KEY" | "STORE_NOT_V3";
  message: string;
}

/**
 * Every reason the ceremony refuses, in one pure function so the refusals are
 * testable without a TTY and cannot drift from the verb.
 *
 * `invokedThroughRegistry` is passed by the caller: the CLI passes false (it
 * dispatches the verb natively), and any future registry adapter must pass
 * true. The check exists so that wiring `rule` into a dispatcher later fails
 * loudly instead of silently minting authority.
 */
export function ceremonyRefusal(opts: {
  isTTY: boolean;
  env: NodeJS.ProcessEnv;
  invokedThroughRegistry: boolean;
  hasHumanKey: boolean;
  storeIsV3: boolean;
}): CeremonyRefusal | null {
  if (opts.invokedThroughRegistry) {
    return {
      code: "REGISTRY_INVOCATION",
      message:
        "the ruling ceremony cannot be invoked through the command registry — " +
        "MCP and CLI ingress can never mint a human_ruling (ADR §2.3)",
    };
  }
  if (opts.env.TWINING_AGENT_CONTEXT) {
    return {
      code: "AGENT_CONTEXT",
      message:
        "TWINING_AGENT_CONTEXT is set: this process is running inside an agent host, " +
        "so it is not a human at a terminal and cannot perform the ceremony",
    };
  }
  if (!opts.isTTY) {
    return {
      code: "NOT_A_TTY",
      message: "stdin is not a TTY — the ruling ceremony runs only at an interactive terminal",
    };
  }
  if (!opts.storeIsV3) {
    return {
      code: "STORE_NOT_V3",
      message: "this store is not on the v3 format — run `twining identity init` first",
    };
  }
  if (!opts.hasHumanKey) {
    return {
      code: "NO_HUMAN_KEY",
      message: "no human key on this machine — run `twining identity init --human` first",
    };
  }
  return null;
}

export interface RulingSpec {
  scope: Scope;
  statement: string;
  cites?: string[];
  grants?: Array<{ principal: string; roles: string[]; scope: Scope }>;
  requirements?: Array<{ key: string; value: unknown }>;
}

/**
 * Sign and append a ruling with a human key.
 *
 * Exported separately from the verb because an automated qualification run
 * legitimately needs to produce rulings — by signing with a fixture human key,
 * never by faking a TTY (ADR §2.3). Ingress is `ceremony`, which is the only
 * ingress whose allowed-class set contains `human_ruling`; the store's
 * validator re-checks that and also demands the signature verify under a key
 * a human `principal` record declares.
 */
/**
 * The out-of-band bootstrap (ADR §7): make this human key the store's root of
 * trust by writing the first `membership`.
 *
 * This is NOT a convenience. Admission default-denies every authority-changing
 * kind until a membership exists, so a ruling signed by a perfectly good human
 * key is quarantined `unauthorized_principal` on a store that has no policy —
 * which is right, and which is exactly why the policy has to be established
 * deliberately, once, at the moment a human key is introduced to the store.
 * The first membership is the one event admission lets through without a
 * policy, and after it exists nothing else can grant `rule` except a ruling.
 *
 * Idempotent: a store that already has a membership is left alone. Silently
 * re-granting `rule` on every ceremony would turn "the bootstrap key is the
 * root of trust" into "whoever runs the ceremony becomes the root of trust".
 */
export async function bootstrapHumanMembership(
  runtime: V3Runtime,
  humanPrincipalId: string,
): Promise<{ created: boolean; reason?: string }> {
  if (!runtime.store) return { created: false, reason: "store is not v3-enabled" };
  if (!runtime.storeId) return { created: false, reason: "store has no store_id" };

  await runtime.store.admit();
  await runtime.store.project();
  const existing = (await runtime.store.query({})).filter((r) => r.record_type === "membership");
  if (existing.length > 0) return { created: false, reason: "a membership policy already exists" };

  const ev = await runtime.append({
    kind: "created",
    recordType: "membership",
    evidenceClass: "proposal",
    payload: {
      store_id: runtime.storeId,
      members: [
        {
          principal: humanPrincipalId,
          roles: ["read", "propose", "write", "rule"],
          scopes: [runtime.scope],
        },
        {
          // The host principal writes proposals and lifecycle transitions on
          // behalf of agents; it never gets `rule`, which is the whole point
          // of separating a host key from a human key.
          principal: runtime.identity.principal_id,
          roles: ["read", "propose", "write"],
          scopes: [runtime.scope],
        },
      ],
    },
    ingress: "adapter",
  });
  if (!ev) return { created: false, reason: "the store refused the bootstrap membership" };
  await runtime.store.admit();
  await runtime.store.project();
  return { created: true };
}

export async function appendRuling(
  runtime: V3Runtime,
  human: { privateKeyPkcs8Pem: string; publicKeySpkiBase64: string; keyId: string; principalId: string },
  spec: RulingSpec,
): Promise<{ id: string } | { error: string }> {
  if (!runtime.store) return { error: "store is not v3-enabled" };

  // The human principal must exist as a record before its signature can be
  // trusted on admission (a key introduces itself out of band exactly once).
  const principalEvent = buildEvent({
    kind: "created",
    recordType: "principal",
    scope: runtime.scope,
    producer: { ...runtime.producer, principal: human.principalId, kind: "human" },
    source: runtime.source,
    evidenceClass: "proposal",
    payload: {
      principal_id: human.principalId,
      kind: "human",
      public_key: human.publicKeySpkiBase64,
      key_id: human.keyId,
    },
  } as BuildEventSpec);
  await runtime.appendRaw(principalEvent, "adapter");
  // First ceremony on a policy-less store establishes the policy; later ones
  // find it already there and change nothing.
  await bootstrapHumanMembership(runtime, human.principalId);

  const payload: Record<string, unknown> = { statement: spec.statement };
  if (spec.cites && spec.cites.length > 0) payload.cites = spec.cites;
  if (spec.grants && spec.grants.length > 0) payload.grants = spec.grants;
  if (spec.requirements && spec.requirements.length > 0) payload.requirements = spec.requirements;

  const unsigned = buildEvent({
    kind: "created",
    recordType: "ruling",
    scope: spec.scope,
    producer: { ...runtime.producer, principal: human.principalId, kind: "human" },
    source: runtime.source,
    evidenceClass: "human_ruling",
    payload,
  } as BuildEventSpec);

  // Sign with the HUMAN key, not the host key: the store signs unsigned events
  // with the host key, and a host-signed ruling is exactly what §2.3 forbids.
  const { signEvent } = await import("../contracts/signing.js");
  const signed = {
    ...(unsigned as unknown as Record<string, unknown>),
    sig: { alg: "ed25519", key: human.keyId, value: signEvent(unsigned as unknown as Record<string, unknown>, human.privateKeyPkcs8Pem) },
  };
  const appended = await runtime.appendRaw(signed as never, "ceremony");
  if (!appended) return { error: "the store refused the ruling — see stderr" };
  return { id: appended.id };
}

export async function runRule(args: string[], projectRoot: string, env: NodeJS.ProcessEnv): Promise<VerbOutcome> {
  const scopePath = flag(args, "--scope");
  const statement = flag(args, "--statement");
  if (!scopePath || !statement) {
    return {
      exitCode: 2,
      error: {
        code: "USAGE",
        message:
          "usage: twining rule --scope <path> --statement <text> [--cites <ids>] " +
          "[--grants <principal:role>] [--requirements <key=value>]",
      },
    };
  }

  const twiningDir = path.join(projectRoot, ".twining");
  const humans = listHumanIdentities(env);
  const refusal = ceremonyRefusal({
    isTTY: Boolean(process.stdin.isTTY),
    env,
    invokedThroughRegistry: false,
    hasHumanKey: humans.length > 0,
    storeIsV3: isV3Store(twiningDir),
  });
  if (refusal) return { exitCode: 1, error: { code: refusal.code, message: refusal.message } };

  const human = humans[0] as HumanIdentityFile;
  const passphrase = env.TWINING_HUMAN_PASSPHRASE ?? (await promptSecret(`passphrase for ${human.principal_id}: `));
  let unlocked;
  try {
    unlocked = unlockHumanIdentity(human, passphrase);
  } catch (e) {
    return { exitCode: 1, error: { code: "UNLOCK_FAILED", message: e instanceof Error ? e.message : String(e) } };
  }

  const runtime = openRuntime({ projectRoot, env, sourceCwd: process.cwd() });
  try {
    const scope: Scope = { ...runtime.scope, path: scopePath };
    const spec: RulingSpec = {
      scope,
      statement,
      ...(list(args, "--cites").length > 0 ? { cites: list(args, "--cites") } : {}),
      ...(list(args, "--grants").length > 0
        ? {
            grants: list(args, "--grants").map((g) => {
              const [principal, roles] = g.split(":");
              return {
                principal: principal ?? "",
                roles: (roles ?? "read").split("+"),
                scope,
              };
            }),
          }
        : {}),
      ...(list(args, "--requirements").length > 0
        ? {
            requirements: list(args, "--requirements").map((r) => {
              const idx = r.indexOf("=");
              return idx === -1 ? { key: r, value: true } : { key: r.slice(0, idx), value: r.slice(idx + 1) };
            }),
          }
        : {}),
    };
    const out = await appendRuling(runtime, unlocked, spec);
    if ("error" in out) return { exitCode: 1, error: { code: "RULING_REFUSED", message: out.error } };
    await runtime.store?.admit();
    await runtime.store?.project();
    return {
      exitCode: 0,
      result: { ruling: out.id, scope, statement, signed_by: unlocked.principalId, key: unlocked.keyId },
    };
  } finally {
    runtime.close();
  }
}

// ------------------------------------------------------------------ events ls

export async function runEvents(args: string[], projectRoot: string, env: NodeJS.ProcessEnv): Promise<VerbOutcome> {
  const sub = args[0];
  const twiningDir = path.join(projectRoot, ".twining");
  if (!isV3Store(twiningDir)) {
    return {
      exitCode: 1,
      error: { code: "STORE_NOT_V3", message: "this store has no event log — run `twining identity init` to create one" },
    };
  }
  const runtime = openRuntime({ projectRoot, env });
  const store = runtime.store ?? new EventStore({ twiningDir });
  try {
    if (sub === "ls" || sub === undefined) {
      const rest = args.slice(sub ? 1 : 0);
      const limit = Number(flag(rest, "--limit") ?? "50");
      const kinds = list(rest, "--kind");
      const events = await store.events({
        ...(kinds.length > 0 ? { kinds } : {}),
        ...(flag(rest, "--record") ? { record_id: flag(rest, "--record") as string } : {}),
      });
      const rows = events.slice(-Math.max(1, limit)).map((e) => ({
        id: e.id,
        kind: e.kind,
        record: e.record ?? null,
        evidence_class: e.evidence_class,
        occurred_at: e.occurred_at,
        producer: e.producer.principal,
        scope: e.scope,
        digest: e.digest,
        signed: Boolean(e.sig),
      }));
      return { exitCode: 0, result: { total: events.length, shown: rows.length, events: rows } };
    }
    if (sub === "show") {
      const id = args[1];
      if (!id) return { exitCode: 2, error: { code: "USAGE", message: "usage: twining events show <event-id>" } };
      const all = await store.events({});
      const found = all.find((e) => e.id === id);
      if (!found) {
        // An unadmitted event is still on disk — say that rather than "not found".
        const state = await store.deliveryState(id);
        return {
          exitCode: 1,
          error: {
            code: "NOT_ADMITTED",
            message: state
              ? `event ${id} exists in state "${state.state}"${state.reason ? ` (${state.reason})` : ""} but is not admitted`
              : `no event ${id} in this store`,
          },
        };
      }
      const state = await store.deliveryState(id);
      return { exitCode: 0, result: { event: found, delivery: state, admission_log: store.admissionLog(id) } };
    }
    return { exitCode: 2, error: { code: "USAGE", message: "usage: twining events ls|show" } };
  } finally {
    runtime.close();
  }
}

// ----------------------------------------------------------------------- sync

export async function runSync(args: string[], projectRoot: string, env: NodeJS.ProcessEnv): Promise<VerbOutcome> {
  const twiningDir = path.join(projectRoot, ".twining");
  if (!isV3Store(twiningDir)) {
    return { exitCode: 1, error: { code: "STORE_NOT_V3", message: "nothing to sync: this store has no event log" } };
  }
  const runtime = openRuntime({ projectRoot, env });
  const store = runtime.store;
  if (!store) return { exitCode: 1, error: { code: "STORE_UNAVAILABLE", message: "could not open the event store" } };

  try {
    // TODO(lane 02): prefer src/exchange/git-transport.ts — the dedicated
    // exchange ref (refs/heads/twining/exchange in a worktree at
    // .twining/exchange/) — as soon as lane 02 lands it. Until then the fs
    // carrier is wired, which is the same Transport interface and the same
    // outbox/inbox state machine; only the carrier differs.
    let transport;
    let carrier: string;
    try {
      // Computed specifier on purpose: lane 02 has not landed this module
      // yet, and a literal specifier would be a compile error until it does.
      const gitTransportModule = "../exchange/git-transport.js";
      const mod = (await import(gitTransportModule)) as {
        GitTransport?: new (projectRoot: string, remote?: string) => never;
      };
      if (mod.GitTransport) {
        transport = new mod.GitTransport(projectRoot, flag(args, "--remote") ?? "origin");
        carrier = "git";
      } else {
        throw new Error("no GitTransport export");
      }
    } catch {
      const shared = flag(args, "--path") ?? env.TWINING_EXCHANGE_DIR ?? path.join(twiningDir, "exchange-fs");
      const { FsTransport } = await import("../exchange/fs-transport.js");
      fs.mkdirSync(shared, { recursive: true });
      transport = new FsTransport(shared) as never;
      carrier = `fs:${shared}`;
    }

    const { Outbox } = await import("../exchange/outbox.js");
    const { Inbox } = await import("../exchange/inbox.js");
    const flushed = await new Outbox(store, transport as never).flush();
    const pulled = await new Inbox(store, transport as never, runtime.identity.principal_id).pull();
    await store.project();

    return {
      exitCode: 0,
      result: {
        carrier,
        transport: (transport as unknown as { id(): string }).id(),
        published: {
          attempted: flushed.attempted.length,
          transferred: flushed.transferred.length,
          // Uncertain is reported, never folded into either success or failure:
          // "we do not know whether these landed" is the honest state (C10).
          uncertain: flushed.uncertain,
        },
        received: {
          polled: pulled.polled,
          admitted: pulled.admitted.length,
          duplicates: pulled.duplicates.length,
          conflicts: pulled.conflicts,
          pending_parents: pulled.pending_parents,
          quarantined: pulled.quarantined,
          rejected: pulled.rejected,
          ack_recorded: pulled.acked,
        },
        checkout: store.checkoutStatus(),
      },
    };
  } catch (e) {
    return { exitCode: 1, error: { code: "SYNC_FAILED", message: e instanceof Error ? e.message : String(e) } };
  } finally {
    runtime.close();
  }
}

// --------------------------------------------------------------------- doctor

/**
 * `twining doctor` — what is bound, where, and what is covered. Deliberately
 * secret-free: it prints key IDs and file paths, never key material, and never
 * a passphrase prompt.
 */
export async function runDoctor(args: string[], projectRoot: string, env: NodeJS.ProcessEnv): Promise<VerbOutcome> {
  const twiningDir = path.join(projectRoot, ".twining");
  const v3 = isV3Store(twiningDir);
  const descriptor = readStoreDescriptor(twiningDir);
  const host = ensureHostIdentity(env);
  const humans = listHumanIdentities(env);
  const source = captureSource(process.cwd(), descriptor?.repo_ids[0]);

  const hooksInstalled = installedHookProvenance(env);

  let events: { total: number; admitted: number; quarantined: number; rejected: number } | null = null;
  if (v3) {
    const runtime = openRuntime({ projectRoot, env });
    try {
      const store = runtime.store;
      if (store) {
        const rows = store.journalRows();
        events = {
          total: rows.length,
          admitted: rows.filter((r) => r.state === "admitted" || r.state === "projected").length,
          quarantined: rows.filter((r) => r.state === "quarantined").length,
          rejected: rows.filter((r) => r.state === "rejected").length,
        };
      }
    } finally {
      runtime.close();
    }
  }

  return {
    exitCode: 0,
    result: {
      bindings: {
        project_root: projectRoot,
        store_dir: twiningDir,
        // Store location and producing checkout are reported SEPARATELY and
        // are never inferred from one another (gap 4).
        source_cwd: process.cwd(),
        source,
        store_format: descriptor?.format ?? "2 (no store.json)",
        store_id: descriptor?.store_id ?? null,
        repo_ids: descriptor?.repo_ids ?? [],
        v3_enabled: v3,
      },
      identity: {
        identity_home: identityHome(env),
        host_id: host.host_id,
        host_principal: host.principal_id,
        host_key_id: host.key_id,
        human_principals: humans.map((h) => ({ principal_id: h.principal_id, key_id: h.key_id, label: h.label ?? null })),
        note: "key ids only — no key material is ever printed by this command",
      },
      capture_coverage: {
        "claude-code": claudeCodeCoverage(),
        codex: codexCoverage(),
      },
      hooks: hooksInstalled,
      events,
      honest_limits: [
        "coverage above describes what the ADAPTER captures, not that a host is currently installed",
        "an unsupported host event is reported as a gap and is never covered by another host's evidence",
        v3 ? null : "this store is on the 2.x format: no events are being written; 2.x behavior is unchanged",
      ].filter(Boolean),
    },
  };
}

/**
 * Which Twining hooks this machine has installed, and from where. Provenance
 * matters because a stale plugin scope silently shadowing a newer one has
 * already caused a field outage.
 */
function installedHookProvenance(env: NodeJS.ProcessEnv): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const home = env.HOME ?? "";
  const candidates = [
    { scope: "plugin", file: path.join(home, ".claude", "plugins", "twining", "hooks", "hooks.json") },
    { scope: "project", file: path.join(process.cwd(), ".claude", "settings.json") },
    { scope: "user", file: path.join(home, ".claude", "settings.json") },
    { scope: "codex-repo", file: path.join(process.cwd(), ".codex", "hooks.json") },
    { scope: "codex-user", file: path.join(home, ".codex", "hooks.json") },
  ];
  for (const c of candidates) {
    try {
      const stat = fs.statSync(c.file);
      const raw = fs.readFileSync(c.file, "utf-8");
      out.push({
        scope: c.scope,
        file: c.file,
        modified: stat.mtime.toISOString(),
        mentions_twining: raw.includes("twining"),
      });
    } catch {
      /* absent is the normal case and is not an error */
    }
  }
  return out;
}

export { CLAUDE_CODE_MATRIX, CODEX_MATRIX };
