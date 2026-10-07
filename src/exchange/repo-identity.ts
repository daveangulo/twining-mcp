/**
 * Repository identity and its LABELS (ADR §3, R01, C24 §B).
 *
 * `repo_id` is minted once and never derived from anything mutable. The remote
 * URL, the local path, the display name and the branch are *labels*: they are
 * carried in `source` and in relocation observations, and they are resolvable
 * back to the identity — but they never decide it. Two repositories that share
 * a display name, a local leaf path and an ancestor revision are still two
 * identities, and no amount of label overlap merges them.
 *
 * Aliases are derived from admitted `observation` records rather than stored in
 * a side table, so a rename is ordinary evidence with an author, a time and an
 * evidence class (a connector observed it; nobody ruled it), and it survives
 * losing the projection database like everything else.
 */
import type { Scope } from "../contracts/scope.js";
import type { SliceProjectedRecord } from "../events/projection.js";

export interface RepoLabels {
  remote?: string;
  path?: string;
  name?: string;
}

export interface RepoAlias extends RepoLabels {
  repo: string;
  /** The observation that recorded this label set. */
  observed_by: string;
  effective_from?: string;
  effective_until?: string;
  status: "current" | "historical";
}

const RELOCATION_KINDS = new Set(["repo_relocated", "repo_renamed"]);

/**
 * Every label set a repository has carried, oldest first, each marked current
 * or historical. A relocation observation CLOSES the previous label set rather
 * than deleting it — the pre-rename URL stays resolvable (C24 B-2).
 */
export function repoAliases(records: Iterable<SliceProjectedRecord>, repoId: string): RepoAlias[] {
  const events: Array<{ at: string; by: string; from?: RepoLabels; to: RepoLabels }> = [];
  for (const rec of records) {
    if (rec.record_type !== "observation") continue;
    const body = rec.body as { result?: Record<string, unknown>; observed_at?: string };
    const result = body.result ?? {};
    if (!RELOCATION_KINDS.has(String(result.op ?? ""))) continue;
    if (result.repo !== repoId) continue;
    events.push({
      at: String(body.observed_at ?? ""),
      by: rec.record_id,
      ...(result.from ? { from: result.from as RepoLabels } : {}),
      to: (result.to ?? {}) as RepoLabels,
    });
  }
  events.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.by < b.by ? -1 : 1));

  const out: RepoAlias[] = [];
  for (const e of events) {
    if (e.from) {
      const prior = out.find((a) => sameLabels(a, e.from as RepoLabels));
      if (prior) prior.effective_until = e.at;
      else out.push({ repo: repoId, ...e.from, observed_by: e.by, effective_until: e.at, status: "historical" });
    }
    out.push({ repo: repoId, ...e.to, observed_by: e.by, effective_from: e.at, status: "current" });
  }
  for (const a of out) a.status = a.effective_until === undefined ? "current" : "historical";
  return out;
}

function sameLabels(a: RepoLabels, b: RepoLabels): boolean {
  return a.remote === b.remote && a.path === b.path && a.name === b.name;
}

/**
 * Resolve a mutable label back to a repository identity.
 *
 * A HISTORICAL label still resolves — a renamed repository does not lose its
 * authorization (C24 D-7) — and says so, so a caller can tell "this is the
 * current name" from "this used to be the name". A label that no repository
 * ever carried resolves to nothing; it is never guessed from similarity, which
 * is the fork-conflation failure (C24 B-4/B-5).
 */
export function resolveRepoByLabel(
  records: Iterable<SliceProjectedRecord>,
  repoIds: string[],
  label: RepoLabels,
): { repo: string; alias_status: "current" | "historical" } | null {
  const all = new Map<string, SliceProjectedRecord[]>();
  const snapshot = [...records];
  for (const repo of repoIds) all.set(repo, snapshot);
  const matches: Array<{ repo: string; alias_status: "current" | "historical" }> = [];
  for (const repo of repoIds) {
    for (const alias of repoAliases(snapshot, repo)) {
      const hit =
        (label.remote !== undefined && alias.remote === label.remote) ||
        (label.path !== undefined && alias.path === label.path) ||
        (label.name !== undefined && alias.name === label.name);
      if (hit) matches.push({ repo, alias_status: alias.status });
    }
  }
  if (matches.length === 0) return null;
  // A label shared by two identities resolves to NEITHER: ambiguity is reported
  // by refusing, never settled by picking one (R01, C24 B-4).
  const distinct = new Set(matches.map((m) => m.repo));
  if (distinct.size > 1) return null;
  return matches.find((m) => m.alias_status === "current") ?? (matches[0] as { repo: string; alias_status: "current" | "historical" });
}

/** Records bound to a repository identity — never to a label (C24 B-3/B-5). */
export function recordsForRepo(records: Iterable<SliceProjectedRecord>, repoId: string, path?: string): SliceProjectedRecord[] {
  return [...records].filter((rec) => {
    const scope = rec.scope as Scope;
    if (scope.repo !== repoId) return false;
    if (path === undefined) return true;
    return (scope.path ?? "").startsWith(path);
  });
}
