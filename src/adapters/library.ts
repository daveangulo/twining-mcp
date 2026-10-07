/**
 * Library adapter (lane 03, brief step 5) — for API / Bedrock coordinators.
 *
 * Not every worker can run hooks. A coordinator that calls the Messages API (or
 * Bedrock) directly holds a model that has no memory tools, no MCP server and
 * no hook surface. That worker still has a lifecycle — dispatched, worked,
 * returned — and the same lifecycle must produce the same events, or the
 * store's view of "what happened" depends on which harness happened to run.
 *
 * So the PARENT produces them. The parent embeds this adapter, feeds it the
 * bounded working set to put in the worker's prompt, and relays the worker's
 * return. The crucial property is that the relay cannot launder authority:
 *
 *   - context handed to a worker produces an `injected` receipt with the
 *     payload hash, exactly like a hook injection, so "what did that worker
 *     see" is answerable;
 *   - whatever the worker says comes back as `reported_result` — "the worker
 *     said", relayed by a trusted parent. The parent's own trustworthiness
 *     does not upgrade the worker's claim (ADR §2.2), and a returned result is
 *     never a completion (C06 AQ2, C15 E1).
 *
 * The adapter deliberately does NOT call a model. It is the record-keeping
 * half; the coordinator owns the transport to the model.
 */
import { sha256Hex, type EventEnvelope } from "../contracts/index.js";
import { buildWorkingSet } from "./working-set.js";
import { payloadHash, type V3Runtime } from "./runtime.js";

export interface WorkerDispatch {
  /** Stable id for this assignment — the coordinator's own. */
  assignment: string;
  attempt?: string;
  /** The worker's label (model id, role). Recorded as asserted_actor. */
  worker: string;
  /** Free-form job id in the coordinator's system. */
  job?: string;
  /** External system name, e.g. "anthropic-api" | "bedrock". */
  system?: string;
}

export interface WorkerContext {
  /** The exact text the coordinator will put in the worker's prompt. */
  text: string;
  /** sha256 of those bytes — the same hash the receipt carries. */
  hash: string;
  /** Record ids included, and those that did not fit. */
  included: string[];
  omitted: string[];
  /** The receipt event id, when one was written. */
  receipt?: string;
}

export interface WorkerReturn {
  /** What the worker returned, verbatim. Stored byte-for-byte. */
  text: string;
  /** Where the worker got to. Never "complete" — see stageOf(). */
  stage?: string;
  /** Ordered next actions, if the coordinator computed any. */
  nextActions?: Array<{ rank: number; action: string; blocking: boolean }>;
}

export class LibraryAdapter {
  constructor(
    private readonly runtime: V3Runtime,
    private readonly opts: { budget?: number } = {},
  ) {}

  get enabled(): boolean {
    return this.runtime.enabled;
  }

  /**
   * Record the dispatch. R04: this is a work REFERENCE — it records that an
   * assignment exists in some external system. It assigns nothing and grants
   * nothing, which is why the payload says so in a field a reader will see.
   */
  async dispatch(d: WorkerDispatch): Promise<EventEnvelope | null> {
    return this.runtime.append({
      kind: "created",
      recordType: "work",
      // `reported_result`, not `verified_observation`: this adapter checked
      // nothing. The coordinator TOLD us it dispatched a worker, and a class
      // that means "we verified the source ourselves" must be reserved for
      // events that carry a real `check_method` (ADR §2.2, §2.4). Minting
      // class-4 evidence for an unchecked assertion is exactly the
      // authority-laundering the evidence classes exist to prevent.
      evidenceClass: "reported_result",
      payload: {
        kind: "assignment",
        system: d.system ?? "library",
        external_id: d.assignment,
        owner: d.worker,
        stage: "dispatched",
        attempt: d.attempt ?? `${d.assignment}:1`,
        job: d.job ?? d.assignment,
        authority: "reference only; this record grants nothing",
      },
      ingress: "adapter",
    });
  }

  /**
   * Assemble the bounded context for a worker and write the `injected`
   * receipt. The coordinator must put EXACTLY `result.text` in the prompt: the
   * receipt's hash is over those bytes, and a receipt over bytes that were not
   * delivered is worse than no receipt at all.
   */
  async contextForWorker(d: WorkerDispatch): Promise<WorkerContext> {
    if (!this.runtime.store) {
      return { text: "", hash: payloadHash(""), included: [], omitted: [] };
    }
    const ws = await buildWorkingSet(this.runtime.store, {
      scope: this.runtime.scope,
      ...(this.opts.budget !== undefined ? { budget: this.opts.budget } : {}),
    });
    const hash = payloadHash(ws.text);
    const receipt = await this.runtime.receipt({
      stage: "injected",
      events: ws.included,
      payloadHash: hash,
      session: d.assignment,
      turn: d.attempt ?? `${d.assignment}:1`,
      ingress: "adapter",
    });
    return {
      text: ws.text,
      hash,
      included: ws.included,
      omitted: ws.omitted,
      ...(receipt ? { receipt: receipt.id } : {}),
    };
  }

  /**
   * Relay a worker's return.
   *
   * The evidence class is `reported_result` and nothing the worker wrote can
   * change that: a worker that returns "APPROVED — merged and accepted" still
   * produces a record whose class says it is a claim, whose text is preserved
   * verbatim, and whose completion/acceptance/merge states are all explicitly
   * negative.
   */
  async relayResult(d: WorkerDispatch, r: WorkerReturn): Promise<EventEnvelope | null> {
    const bytes = Buffer.from(r.text, "utf-8");
    return this.runtime.append({
      kind: "created",
      recordType: "post",
      evidenceClass: "reported_result",
      payload: {
        entry_type: "status",
        summary: truncate(`Worker returned: ${d.worker} (${d.assignment}) — review pending`, 200),
        detail: r.text,
        tags: ["worker-return", "library-adapter", "reported-result"],
        finisher: {
          principal: this.runtime.identity.principal_id,
          host: this.runtime.identity.host_id,
          worker: d.worker,
        },
        assignment: d.assignment,
        attempt: d.attempt ?? `${d.assignment}:1`,
        job: d.job ?? d.assignment,
        stage: r.stage ?? "worker_returned_review_pending",
        task_completion_state: "not_complete",
        acceptance_state: "none_recorded",
        merge_state: "not_merged",
        next_action: {
          ordered: true,
          items:
            r.nextActions ?? [
              { rank: 1, action: "review the worker's returned result", blocking: true },
              { rank: 2, action: "acceptance decision by an authorized human", blocking: false },
            ],
        },
        original_text_preserved: true,
        promoted: false,
        relayed_by: this.runtime.identity.principal_id,
      },
      attachments:
        bytes.byteLength > 0
          ? [
              {
                sha256: sha256Hex(bytes),
                bytes: bytes.byteLength,
                media_type: "text/plain",
                source_kind: "other" as const,
                encoding: "utf-8",
                anchor: `assignment:${d.assignment}`,
              },
            ]
          : undefined,
      ingress: "adapter",
    });
  }

  /** Flush: admit and project everything this coordinator appended. */
  async flush(): Promise<void> {
    if (!this.runtime.store) return;
    await this.runtime.store.admit();
    await this.runtime.store.project();
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}
