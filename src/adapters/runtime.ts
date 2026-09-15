/**
 * The runtime seam between a host adapter (or the CLI) and lane 02's
 * EventStore.
 *
 * Everything here is conditional on the store being v3-enabled
 * (`.twining/store.json` with `format: 3`). On a 2.x store every function is a
 * no-op that reports `enabled: false` — which is how "keep 2.x behavior
 * otherwise" is enforced structurally rather than remembered.
 */
import fs from "node:fs";
import path from "node:path";

import { EventStore } from "../events/event-store.js";
import {
  sha256Hex,
  type EventEnvelope,
  type Ingress,
  type Scope,
} from "../contracts/index.js";
import {
  ensureHostIdentity,
  isV3Store,
  listHumanIdentities,
  readStoreDescriptor,
  repoIdFor,
  type HostIdentity,
  type IdentityEnv,
} from "./identity.js";
import { buildEvent, buildReceipt, type BuildEventSpec, type ProducerInfo } from "./event-factory.js";
import { captureSource, type SourceInfo } from "./source.js";

export interface RuntimeOptions {
  projectRoot: string;
  /** The producing checkout — a hook's cwd, NOT the resolved store root. */
  sourceCwd?: string;
  env?: IdentityEnv;
  /** agent_id / subagent label, recorded as producer.asserted_actor. */
  assertedActor?: string;
}

export interface V3Runtime {
  enabled: boolean;
  twiningDir: string;
  store: EventStore | null;
  identity: HostIdentity;
  scope: Scope;
  producer: ProducerInfo;
  source: SourceInfo;
  storeId: string | null;
  append(
    spec: Omit<BuildEventSpec, "producer" | "source" | "scope"> & { scope?: Scope; ingress?: Ingress },
  ): Promise<EventEnvelope | null>;
  appendRaw(event: EventEnvelope, ingress: Ingress): Promise<EventEnvelope | null>;
  receipt(args: {
    stage: "received" | "admitted" | "projected" | "injected" | "task_acked";
    events?: string[];
    payloadHash?: string;
    session?: string;
    turn?: string;
    ingress: Ingress;
  }): Promise<EventEnvelope | null>;
  close(): void;
}

/** sha256 over the exact bytes a host was handed (`sha256:<hex>`). */
export function payloadHash(text: string): string {
  return `sha256:${sha256Hex(Buffer.from(text, "utf-8"))}`;
}

/**
 * Session and turn come from the ADAPTER, never from the model: the host
 * gives them to the hook, the hook forwards them as env, and the CLI reads
 * them here. A model that sets TWINING_SESSION_ID itself changes only the
 * label on its own events; it cannot change `producer.principal`, which is
 * the host key.
 */
export function sessionTurnFromEnv(env: IdentityEnv = process.env): { session?: string; turn?: string } {
  const out: { session?: string; turn?: string } = {};
  if (env.TWINING_SESSION_ID) out.session = env.TWINING_SESSION_ID;
  if (env.TWINING_TURN_ID) out.turn = env.TWINING_TURN_ID;
  return out;
}

/**
 * A position string for a cursor-shaped receipt: the highest journalled event
 * id on this replica, or "0" on an empty store. Informational — nothing orders
 * by it (R05); it exists so a flush receipt can say what it covered.
 */
function latestPosition(store: EventStore): string {
  try {
    const rows = store.journalRows();
    let max = "0";
    for (const r of rows) if (r.id > max) max = r.id;
    return max;
  } catch {
    return "0";
  }
}

export function openRuntime(opts: RuntimeOptions): V3Runtime {
  const env = opts.env ?? process.env;
  const twiningDir = path.join(opts.projectRoot, ".twining");
  const enabled = isV3Store(twiningDir);
  const identity = ensureHostIdentity(env);
  const repoId = enabled ? repoIdFor(twiningDir) : null;
  const sourceCwd = opts.sourceCwd ?? opts.projectRoot;
  const source = captureSource(sourceCwd, repoId ?? undefined);
  const { session, turn } = sessionTurnFromEnv(env);

  const producer: ProducerInfo = {
    principal: identity.principal_id,
    kind: "agent",
    host: identity.host_id,
    ...(session ? { session } : {}),
    ...(turn ? { turn } : {}),
    ...(opts.assertedActor ? { asserted_actor: opts.assertedActor } : {}),
  };

  // An event needs a repo or `global: true`. A v3 store always has a repo id;
  // the non-v3 path never builds events at all.
  const scope: Scope = repoId ? { repo: repoId } : { global: true };

  /**
   * The store is opened EAGERLY when the format is v3, not on first write.
   *
   * It was lazy at first, and that was a real defect: `runtime.store` is the
   * handle every reading handler guards on, so before the first append it was
   * null and each of them silently took the "no store" branch — capture and
   * injection both went quiet on a store that was fully enabled. A handle that
   * only exists after you have written something is not a handle you can read
   * through.
   */
  let store: EventStore | null = null;
  if (enabled) {
    const known: Record<string, { publicKeySpkiBase64: string; human?: boolean }> = {
      [identity.key_id]: { publicKeySpkiBase64: identity.public_key },
    };
    for (const human of listHumanIdentities(env)) {
      known[human.key_id] = { publicKeySpkiBase64: human.public_key, human: true };
    }
    store = new EventStore({
      twiningDir,
      hostKey: {
        keyId: identity.key_id,
        privateKeyPkcs8Pem: identity.private_key,
        publicKeySpkiBase64: identity.public_key,
      },
      knownKeys: known,
    });
  }
  const ensureStore = (): EventStore | null => store;

  const runtime: V3Runtime = {
    enabled,
    twiningDir,
    get store() {
      return store;
    },
    identity,
    scope,
    producer,
    source,
    storeId: enabled ? (readStoreDescriptor(twiningDir)?.store_id ?? null) : null,

    async append(spec) {
      const s = ensureStore();
      if (!s) return null;
      const event = buildEvent({
        ...spec,
        scope: spec.scope ?? scope,
        producer,
        source,
      } as BuildEventSpec);
      return runtime.appendRaw(event, (spec as { ingress?: Ingress }).ingress ?? "adapter");
    },

    async appendRaw(event, ingress) {
      const s = ensureStore();
      if (!s) return null;
      const result = await s.append(event as unknown as Record<string, unknown>, ingress);
      if ("ok" in result && result.ok === false) {
        // Never throw into a hook: a refused event is a diagnostic, not a
        // reason to break the host's turn.
        process.stderr.write(
          `[twining] v3 append refused (${result.validation.ok ? "?" : result.validation.code}): ` +
            `${result.validation.ok ? "" : result.validation.message}\n`,
        );
        return null;
      }
      return (result as { event: EventEnvelope }).event;
    },

    async receipt(args) {
      const s = ensureStore();
      if (!s) return null;
      // A receipt names events OR a cursor — never neither. A flush receipt
      // covers "everything up to here" and therefore carries the cursor form;
      // an injection receipt names the exact records it delivered.
      const named = args.events && args.events.length > 0 ? args.events : undefined;
      const event = buildReceipt({
        stage: args.stage,
        consumer: identity.principal_id,
        ...(named ? { events: named } : { cursor: { transport: "local", position: latestPosition(s) } }),
        host: identity.host_id,
        ...(args.session ?? session ? { session: args.session ?? session } : {}),
        ...(args.turn ?? turn ? { turn: args.turn ?? turn } : {}),
        ...(args.payloadHash ? { payloadHash: args.payloadHash } : {}),
        scope,
        producer,
        source,
        ingress: args.ingress,
      });
      return runtime.appendRaw(event, args.ingress);
    },

    close() {
      try {
        store?.close();
      } catch {
        /* already closed */
      }
      store = null;
    },
  };
  return runtime;
}

/** Where a host adapter parks its last-injected cursor, per session. */
export function receiptCursorPath(twiningDir: string, sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9_.-]/g, "_").replace(/^\.+/, "") || "session";
  return path.join(twiningDir, "adapters", "sessions", `${safe}.json`);
}

export interface SessionCursor {
  session_id: string;
  last_injected_event?: string;
  last_receipt_id?: string;
  last_payload_hash?: string;
  updated_at: string;
  turns: number;
}

export function readSessionCursor(twiningDir: string, sessionId: string): SessionCursor | null {
  try {
    return JSON.parse(fs.readFileSync(receiptCursorPath(twiningDir, sessionId), "utf-8")) as SessionCursor;
  } catch {
    return null;
  }
}

export function writeSessionCursor(twiningDir: string, cursor: SessionCursor): void {
  const file = receiptCursorPath(twiningDir, cursor.session_id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cursor, null, 2) + "\n");
}
