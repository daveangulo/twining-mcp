/**
 * The one place every existing write command gains a v3 event (lane 03).
 *
 * `withV3Mirror` decorates a CommandDef: the 2.x handler runs first and its
 * result is returned unchanged, then — and only when the store is v3-enabled —
 * the corresponding event is appended. Wrapping the REGISTRY rather than
 * editing 39 handlers was chosen deliberately:
 *
 *   - it covers both front ends at once (the MCP server and the CLI dispatch
 *     the same registry), so the two cannot drift;
 *   - it is one reviewable diff instead of thirty-nine;
 *   - and the decoration is provably behavior-neutral on a 2.x store, because
 *     `mirrorCommandWrite` returns immediately when `runtime.enabled` is false
 *     and the handler's result object is never touched.
 *
 * The cost, stated plainly: the wrapper has to infer the record id and scope
 * from each command's input/result shape rather than being handed them. Where
 * it cannot (an unrecognised result shape), it writes nothing and says so on
 * stderr — it never guesses an id, because a lifecycle event pointing at the
 * wrong record is worse than a missing one.
 */
import path from "node:path";

import type { CommandDef } from "../command-def.js";
import {
  COMMAND_EVENT_MAP,
  currentIngress,
  isMirroredCommand,
  mirrorCommandWrite,
  normaliseScopePath,
} from "../../adapters/v3-mirror.js";
import { isV3Store } from "../../adapters/identity.js";
import { openRuntime, type V3Runtime } from "../../adapters/runtime.js";

/**
 * The two fields the mirror needs from a command context. Declared optional
 * because each command module declares its own NARROW context slice, and most
 * of those slices do not name these fields even though TwiningContext always
 * carries them — so the wrapper duck-types at runtime instead of forcing every
 * module to widen its declared context.
 */
interface MirrorCtx {
  projectRoot?: string;
  twiningDir?: string;
}

/**
 * One runtime per store per process. Opening an EventStore takes a sqlite
 * handle, and a per-call open would cost more than the write it is mirroring.
 */
const runtimes = new Map<string, V3Runtime>();

function runtimeFor(ctx: MirrorCtx): V3Runtime | null {
  const { projectRoot, twiningDir } = ctx;
  if (!projectRoot || !twiningDir) return null;
  if (!isV3Store(twiningDir)) return null;
  const key = path.resolve(twiningDir);
  let rt = runtimes.get(key);
  if (!rt) {
    rt = openRuntime({ projectRoot, sourceCwd: process.cwd() });
    runtimes.set(key, rt);
  }
  return rt.enabled ? rt : null;
}

/** Close every cached runtime — used by tests and by CLI teardown. */
export function closeMirrorRuntimes(): void {
  for (const rt of runtimes.values()) rt.close();
  runtimes.clear();
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** The record a lifecycle event acts on, taken from input or result. */
function targetId(input: Record<string, unknown>, result: Record<string, unknown>): string | undefined {
  const candidates = [
    result.id,
    result.decision_id,
    result.entry_id,
    result.entity_id,
    result.relation_id,
    result.handoff_id,
    input.id,
    input.decision_id,
    input.entry_id,
    input.target_id,
    input.handoff_id,
  ];
  for (const c of candidates) {
    const s = str(c);
    // v3 record ids are ULIDs; a 2.x id that is not one cannot address a v3
    // record, so it is dropped rather than coerced.
    if (s && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(s)) return s;
  }
  return undefined;
}

/**
 * Build the v3 payload for a command. Returns null when the command's data
 * cannot make a valid record body — the schema is the contract, and a body
 * that would be rejected at ingress is not worth constructing.
 */
export function buildMirrorPayload(
  commandName: string,
  input: Record<string, unknown>,
  result: Record<string, unknown>,
): { payload: Record<string, unknown>; recordId?: string } | null {
  const mapping = COMMAND_EVENT_MAP[commandName];
  if (!mapping) return null;
  const id = targetId(input, result);

  if (mapping.kind !== "created") {
    if (!id) return null;
    // Lifecycle payloads are strict: `target` plus the kind's own fields.
    const base: Record<string, unknown> = { target: id };
    switch (mapping.kind) {
      case "resolved":
        if (str(input.resolution)) base.note = str(input.resolution);
        return { payload: base, recordId: id };
      case "overridden":
        base.reason = str(input.reason) ?? "overridden";
        return { payload: base, recordId: id };
      case "reconsidered":
      case "archived":
      case "restored":
        if (str(input.reason)) base.reason = str(input.reason);
        return { payload: base, recordId: id };
      case "amended":
        base.reason = str(input.reason) ?? "amended";
        base.add_affected_files = Array.isArray(input.add_affected_files) ? input.add_affected_files : [];
        base.add_affected_symbols = Array.isArray(input.add_affected_symbols) ? input.add_affected_symbols : [];
        return { payload: base, recordId: id };
      case "commit_linked": {
        const commit = str(input.commit_hash) ?? str(input.commit);
        if (!commit || !/^[0-9a-f]{40}$/.test(commit)) return null; // v3 wants a full sha
        base.commit = commit;
        return { payload: base, recordId: id };
      }
      default:
        return { payload: base, recordId: id };
    }
  }

  switch (mapping.recordType) {
    case "post": {
      const summary = str(input.summary);
      if (!summary) return null;
      return {
        payload: {
          entry_type: str(input.entry_type) ?? "status",
          summary: summary.slice(0, 200),
          ...(str(input.detail) ? { detail: str(input.detail) } : {}),
          ...(Array.isArray(input.tags) ? { tags: input.tags } : {}),
        },
      };
    }
    case "decision": {
      const summary = str(input.summary) ?? str(result.summary);
      const rationale =
        str(input.rationale) ??
        str((Array.isArray(input.decisions) ? input.decisions[0] : undefined) as string) ??
        summary;
      if (!summary || !rationale) return null;
      return {
        payload: {
          summary,
          rationale,
          ...(str(input.context) ? { context: str(input.context) } : {}),
          ...(Array.isArray(input.affected_files) ? { affected_files: input.affected_files } : {}),
          ...(str(input.confidence) ? { confidence: str(input.confidence) } : {}),
        },
      };
    }
    case "entity": {
      const name = str(input.name);
      const type = str(input.type) ?? str(input.entity_type);
      if (!name || !type) return null;
      return { payload: { name, type } };
    }
    case "relation": {
      const source = str(input.source) ?? str(input.from);
      const target = str(input.target) ?? str(input.to);
      const type = str(input.type) ?? str(input.relation_type);
      if (!source || !target || !type) return null;
      return { payload: { source, target, type } };
    }
    case "handoff": {
      const summary = str(input.summary);
      const sourceAgent = str(input.source_agent) ?? str(input.agent_id) ?? str(input.from_agent);
      if (!summary || !sourceAgent) return null;
      return {
        payload: {
          summary,
          source_agent: sourceAgent,
          ...(str(input.target_agent) ? { target_agent: str(input.target_agent) } : {}),
        },
      };
    }
    default:
      return null;
  }
}

/**
 * Decorate one command. Commands with no v3 twin are returned untouched — the
 * wrapper adds neither a closure nor a branch to a read path.
 */
export function withV3Mirror<C>(def: CommandDef<C>): CommandDef<C> {
  if (!isMirroredCommand(def.name)) return def;
  const inner = def.handler.bind(def);
  return {
    ...def,
    async handler(ctx: C, input: never): Promise<unknown> {
      const result = await inner(ctx, input);
      try {
        const runtime = runtimeFor(ctx as unknown as MirrorCtx);
        if (!runtime) return result;
        const built = buildMirrorPayload(
          def.name,
          (input ?? {}) as Record<string, unknown>,
          (result ?? {}) as Record<string, unknown>,
        );
        if (!built) {
          process.stderr.write(
            `[twining] v3 mirror skipped for ${def.name}: no valid v3 body could be built from this call\n`,
          );
          return result;
        }
        const scopeInput = (input ?? {}) as Record<string, unknown>;
        await mirrorCommandWrite(
          runtime,
          def.name,
          {
            kind: COMMAND_EVENT_MAP[def.name]!.kind,
            ...(built.recordId ? { recordId: built.recordId } : {}),
            payload: built.payload,
            ...(str(scopeInput.scope) ? { scopePath: normaliseScopePath(str(scopeInput.scope) as string) } : {}),
            ...(str(scopeInput.agent_id) ? { assertedActor: str(scopeInput.agent_id) } : {}),
          },
          currentIngress(),
        );
      } catch (e) {
        // The 2.x write already succeeded and is the user's data. A mirror
        // failure is a diagnostic, never a command failure.
        process.stderr.write(
          `[twining] v3 mirror for ${def.name} failed (non-fatal): ${e instanceof Error ? e.message : String(e)}\n`,
        );
      }
      return result;
    },
  };
}

export function mirrorAll<D extends { name: string }>(defs: ReadonlyArray<D>): ReadonlyArray<D> {
  return defs.map((d) => withV3Mirror(d as unknown as CommandDef<unknown>) as unknown as D);
}
