/**
 * The v3 write path for existing commands (lane 03, brief step 2).
 *
 * Every 2.x write verb — post, record, decide, resolve, promote, override, … —
 * ALSO appends the corresponding v3 event when the store is v3-enabled. On a
 * 2.x store this module does nothing at all, which is how "keep 2.x behavior
 * otherwise" is a structural property rather than a promise.
 *
 * Three rules, all of them the same rule seen from different sides:
 *
 *  1. **Evidence class comes from the ingress.** `mcp` and `cli` may produce
 *     `proposal`, `model_inference` and `question` — nothing else. A caller
 *     that puts `evidence_class: "human_ruling"` in its input gets a proposal,
 *     because the input is never consulted.
 *  2. **The producer is the host key**, with the caller's `agent_id` recorded
 *     as `asserted_actor` — displayed, never authoritative.
 *  3. **A mirror failure never fails the command.** The 2.x write already
 *     happened and is the user's data; a refused v3 event is a diagnostic on
 *     stderr. The alternative — failing a `twining_post` because an event
 *     could not be signed — trades a working feature for a bookkeeping one.
 */
import type { EventKind, Ingress, RecordType, Scope } from "../contracts/index.js";
import type { V3Runtime } from "./runtime.js";
import { classFor } from "./event-factory.js";

export interface MirrorSpec {
  kind: EventKind;
  recordType?: RecordType;
  /** For lifecycle kinds: the record being acted on. */
  recordId?: string;
  payload: Record<string, unknown>;
  /** Scope path from the command's own `scope` string ("src/auth/"). */
  scopePath?: string;
  /** The caller's agent_id. */
  assertedActor?: string;
}

/** Ingress for this process. The CLI sets TWINING_INGRESS=cli; the server does not. */
export function currentIngress(env: NodeJS.ProcessEnv = process.env): Extract<Ingress, "mcp" | "cli"> {
  return env.TWINING_INGRESS === "cli" ? "cli" : "mcp";
}

/**
 * Which v3 event a 2.x command produces. Commands not listed here write no
 * event — a read is not an event, and inventing one would make the log lie
 * about what happened.
 */
export const COMMAND_EVENT_MAP: Record<string, { kind: EventKind; recordType?: RecordType }> = {
  twining_post: { kind: "created", recordType: "post" },
  twining_decide: { kind: "created", recordType: "decision" },
  twining_record: { kind: "created", recordType: "decision" },
  twining_add_entity: { kind: "created", recordType: "entity" },
  twining_add_relation: { kind: "created", recordType: "relation" },
  twining_handoff: { kind: "created", recordType: "handoff" },
  twining_resolve: { kind: "resolved" },
  twining_promote: { kind: "promoted" },
  twining_reconsider: { kind: "reconsidered" },
  twining_override: { kind: "overridden" },
  twining_archive: { kind: "archived" },
  twining_unarchive: { kind: "restored" },
  twining_archive_stale: { kind: "archived" },
  twining_amend: { kind: "amended" },
  twining_link_commit: { kind: "commit_linked" },
  twining_acknowledge: { kind: "acknowledged" },
};

export function isMirroredCommand(name: string): boolean {
  return name in COMMAND_EVENT_MAP;
}

/**
 * Append the v3 twin of a command that just succeeded.
 *
 * Returns the event id, or null when nothing was written (2.x store, unmapped
 * command, or a refusal that has already been reported on stderr).
 */
export async function mirrorCommandWrite(
  runtime: V3Runtime,
  commandName: string,
  spec: MirrorSpec,
  ingress: Extract<Ingress, "mcp" | "cli"> = currentIngress(),
): Promise<string | null> {
  if (!runtime.enabled) return null;
  const mapping = COMMAND_EVENT_MAP[commandName];
  if (!mapping) return null;

  const scope: Scope = { ...runtime.scope };
  if (spec.scopePath && spec.scopePath !== "project") scope.path = normaliseScopePath(spec.scopePath);

  try {
    const event = await runtime.append({
      kind: mapping.kind,
      ...(mapping.recordType ? { recordType: mapping.recordType } : {}),
      ...(spec.recordId ? { recordId: spec.recordId } : {}),
      // The caller's agent_id reaches producer.asserted_actor. It was being
      // collected and then dropped, which made every mirrored event look like
      // it came from an anonymous host.
      ...(spec.assertedActor ? { assertedActor: spec.assertedActor } : {}),
      scope,
      // The ONLY place the class is chosen, and it never reads spec.payload.
      evidenceClass: classFor(ingress, "default"),
      payload: spec.payload,
      ingress,
    });
    return event?.id ?? null;
  } catch (e) {
    process.stderr.write(
      `[twining] v3 mirror for ${commandName} failed (non-fatal, the 2.x write stands): ` +
        `${e instanceof Error ? e.message : String(e)}\n`,
    );
    return null;
  }
}

/**
 * 2.x scopes are free-form strings ("src/auth/", "project", a module name).
 * v3 scope paths are repo-relative with no leading slash and no "..". Anything
 * that cannot be a path is dropped rather than coerced: a scope that does not
 * mean what it says is worse than an absent one.
 */
export function normaliseScopePath(scope: string): string | undefined {
  const trimmed = scope.trim().replace(/^\.\//, "").replace(/\/+$/, "");
  if (trimmed.length === 0) return undefined;
  if (trimmed.startsWith("/") || trimmed.includes("..")) return undefined;
  return trimmed;
}
