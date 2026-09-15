/**
 * Git / GitHub source connector (lane 03, brief step 6).
 *
 * ADR §6 splits facts by how they can go wrong. This module handles the
 * `volatile: true` class — remote head, branch existence, PR range — the facts
 * that were true when observed and may not be true now.
 *
 * Two rules it exists to enforce (R12):
 *
 *  1. **A local check is not a remote check.** `git rev-parse` in a local
 *     checkout, a file existence test, an index refresh — none of them observe
 *     the remote. Every observation here records `check_method` naming the
 *     command actually run, so a reader can tell a real remote check from a
 *     local one instead of trusting the word "verified".
 *  2. **Consequential use requires a fresh observation, or it is refused.**
 *     `requalify()` does not return a best guess when the fact is stale or
 *     unobtainable; it returns a refusal with a reason. Offline is
 *     `revocation_unknown`-shaped: the replica says it does not know, never
 *     that the answer is the last one it saw.
 */
import { execFileSync } from "node:child_process";

import type { EventEnvelope, Scope } from "../../contracts/index.js";
import type { V3Runtime } from "../runtime.js";

export interface CheckResult {
  ok: boolean;
  /** The exact command that produced this answer. */
  check_method: string;
  result: Record<string, unknown>;
  error?: string;
}

function run(cmd: string, args: string[], cwd: string, timeout = 10_000): { ok: boolean; out: string; err: string } {
  try {
    const out = execFileSync(cmd, args, {
      cwd,
      encoding: "utf-8",
      timeout,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, out: out.trim(), err: "" };
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string };
    return {
      ok: false,
      out: "",
      err: (typeof err.stderr === "string" ? err.stderr : err.stderr?.toString()) ?? err.message ?? "unknown error",
    };
  }
}

/** Does the remote have this ref, and at what sha? A real network call. */
export function checkRemoteRef(cwd: string, remote: string, ref: string): CheckResult {
  const method = `git ls-remote --exit-code ${remote} ${ref}`;
  const r = run("git", ["ls-remote", "--exit-code", remote, ref], cwd);
  if (!r.ok) {
    return {
      ok: false,
      check_method: method,
      result: { ref, remote, exists: "unknown", reason: "remote unreachable or ref absent" },
      error: r.err.slice(0, 500),
    };
  }
  const line = r.out.split("\n")[0] ?? "";
  const sha = line.split(/\s+/)[0] ?? "";
  return {
    ok: true,
    check_method: method,
    result: { ref, remote, exists: sha.length > 0, head: sha || null },
  };
}

/** The remote's current default-branch head. */
export function checkRemoteHead(cwd: string, remote: string, branch: string): CheckResult {
  return checkRemoteRef(cwd, remote, `refs/heads/${branch}`);
}

/**
 * A PR's base..head range, via `gh` when it is available.
 *
 * When `gh` is absent this returns ok:false with `check_method` naming the
 * attempt — an unavailable tool is an unknown answer, not a missing PR.
 */
export function checkPullRequestRange(cwd: string, repo: string, number: number): CheckResult {
  const method = `gh pr view ${number} --repo ${repo} --json baseRefOid,headRefOid,state,mergeable`;
  const r = run(
    "gh",
    ["pr", "view", String(number), "--repo", repo, "--json", "baseRefOid,headRefOid,state,mergeable"],
    cwd,
    20_000,
  );
  if (!r.ok) {
    return {
      ok: false,
      check_method: method,
      result: { repo, pr: number, state: "unknown", reason: "gh unavailable or the request failed" },
      error: r.err.slice(0, 500),
    };
  }
  try {
    const parsed = JSON.parse(r.out) as Record<string, unknown>;
    return {
      ok: true,
      check_method: method,
      result: {
        repo,
        pr: number,
        base: parsed.baseRefOid ?? null,
        head: parsed.headRefOid ?? null,
        state: parsed.state ?? null,
        mergeable: parsed.mergeable ?? null,
      },
    };
  } catch {
    return {
      ok: false,
      check_method: method,
      result: { repo, pr: number, state: "unknown", reason: "gh returned unparseable JSON" },
    };
  }
}

/**
 * Write a `verified_observation` for a check this connector actually ran.
 *
 * `volatile: true` is set unconditionally for this whole class of facts: the
 * observation is true as of `observed_at` and says nothing about now. A failed
 * check is ALSO recorded — an unanswered question is evidence, and suppressing
 * it is how a replica ends up quietly serving a stale answer.
 */
export async function recordObservation(
  runtime: V3Runtime,
  check: CheckResult,
  opts: { sourceKind: "branch" | "pr_body" | "commit" | "permission" | "other"; sourceUri?: string; scope?: Scope } = {
    sourceKind: "other",
  },
): Promise<EventEnvelope | null> {
  return runtime.append({
    kind: "created",
    recordType: "observation",
    evidenceClass: check.ok ? "verified_observation" : "question",
    ...(opts.scope ? { scope: opts.scope } : {}),
    payload: {
      source_kind: opts.sourceKind === "branch" ? "branch" : opts.sourceKind,
      ...(opts.sourceUri ? { source_uri: opts.sourceUri } : {}),
      observed_at: new Date().toISOString(),
      volatile: true,
      check_method: check.check_method,
      result: check.ok ? check.result : { ...check.result, error: check.error ?? null, observed: false },
    },
    ingress: "connector",
  });
}

// ------------------------------------------------------------- requalification

export type Qualification =
  | { qualified: true; observation: string; observed_at: string; result: Record<string, unknown> }
  | {
      qualified: false;
      reason: "stale" | "never_observed" | "unreachable" | "changed";
      detail: string;
      /** Present for `stale`: how old the last-known answer is. */
      last_known?: { observed_at: string; age_ms: number; result: Record<string, unknown> };
    };

export interface RequalifyOptions {
  /** How old an observation may be and still qualify a consequential action. */
  maxAgeMs?: number;
  /** The value the caller believes is current — a mismatch refuses with `changed`. */
  expect?: Record<string, unknown>;
  now?: () => number;
}

/**
 * Qualify a consequential action against a live fact.
 *
 * The contract is refusal-by-default. There is no code path here that returns
 * `qualified: true` from a cached value: either a fresh check succeeded inside
 * `maxAgeMs`, or the answer is a refusal with a named reason. That is the
 * difference between "the branch still exists" and "the branch existed when we
 * last looked", and the whole reason the class is called volatile.
 */
export async function requalify(
  runtime: V3Runtime,
  check: () => CheckResult,
  opts: RequalifyOptions = {},
): Promise<Qualification> {
  const maxAge = opts.maxAgeMs ?? 5 * 60_000;
  const now = opts.now ?? (() => Date.now());

  const result = check();
  const observed = await recordObservation(runtime, result, { sourceKind: "other" });
  const observedAt = new Date(now()).toISOString();

  if (!result.ok) {
    return {
      qualified: false,
      reason: "unreachable",
      detail:
        `the live check could not be completed (${result.check_method}); ` +
        "this replica does not know the present state and will not assume the last one it saw",
    };
  }

  if (opts.expect) {
    for (const [key, want] of Object.entries(opts.expect)) {
      if (result.result[key] !== want) {
        return {
          qualified: false,
          reason: "changed",
          detail: `${key} is ${JSON.stringify(result.result[key])}, not the expected ${JSON.stringify(want)}`,
        };
      }
    }
  }

  const age = 0; // the check just ran
  if (age > maxAge) {
    return {
      qualified: false,
      reason: "stale",
      detail: `the freshest available observation is ${age} ms old, older than the ${maxAge} ms policy`,
    };
  }

  return {
    qualified: true,
    observation: observed?.id ?? "(not recorded: store is not v3-enabled)",
    observed_at: observedAt,
    result: result.result,
  };
}
