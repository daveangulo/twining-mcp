/**
 * Triage read-model — docs/TRIAGE-SPEC.md §3–§5.
 * Classifies decisions and blackboard entries into two buckets keyed on exit
 * semantics: `open` (awaiting a defined resolution act; unbounded, never
 * windowed) and `recent` (no resolution lifecycle; drained by time and the
 * `since` cursor). All input range-normalization lives here so the tool and
 * HTTP adapters cannot drift (§4.1).
 */
import { computeResolvedIds } from "./resolution.js";
import {
  isDelegationExpired,
  parseDelegationMetadata,
} from "./coordination.js";
import { scopeMatches } from "../utils/scope.js";
import type {
  BlackboardEntry,
  Decision,
  DelegationMetadata,
  TriageItem,
  TriageResult,
} from "../utils/types.js";
import type {
  IBlackboardStore,
  IDecisionStore,
} from "../storage/interfaces.js";

// 7 days — the repo's existing stale-provisional horizon (§4.1).
const DEFAULT_WINDOW_MS = 604_800_000;
const DEFAULT_LIMIT = 25;
const LIMIT_MIN = 1;
const LIMIT_MAX = 200;
const PREVIEW_CHARS = 200;

export interface TriageStores {
  decisionStore: IDecisionStore;
  blackboardStore: IBlackboardStore;
}

/** Raw inputs — §4.1. Adapters pass values through; normalization happens here. */
export interface TriageInput {
  scope?: string;
  window_ms?: number;
  section?: "all" | "open" | "recent";
  limit?: number;
  since?: string;
  for_agent?: string;
}

interface NormalizedInput {
  scope?: string;
  windowMs: number;
  section: "all" | "open" | "recent";
  limit: number;
  since?: string;
  sinceMs?: number;
  forAgent?: string;
}

function normalize(input: TriageInput): NormalizedInput {
  const normalized: NormalizedInput = {
    // Empty-string scope/for_agent are treated as absent — "" passed to
    // scopeMatches would silently match everything while looking like a filter.
    // §4.1 letter: "absent or ≤ 0 → default; no upper clamp" — positive
    // Infinity (reachable only via the HTTP adapter's Number() parse) is > 0,
    // so it is applied as an unbounded window (cutoff -Infinity), not
    // silently defaulted. NaN (> 0 is false) defaults. Known wrinkle: the
    // echoed window_ms serializes to JSON null through the adapters —
    // Infinity has no JSON representation.
    windowMs:
      typeof input.window_ms === "number" && input.window_ms > 0
        ? input.window_ms
        : DEFAULT_WINDOW_MS,
    section:
      input.section === "open" || input.section === "recent"
        ? input.section
        : "all",
    limit: Math.min(
      LIMIT_MAX,
      Math.max(
        LIMIT_MIN,
        typeof input.limit === "number" && Number.isFinite(input.limit)
          ? input.limit
          : DEFAULT_LIMIT,
      ),
    ),
  };
  if (input.scope) normalized.scope = input.scope;
  if (input.for_agent) normalized.forAgent = input.for_agent;
  if (input.since) {
    // since is foreign input: epoch-normalize for the cutoff comparison
    // (§3.2); unparseable values are ignored and not echoed.
    const parsed = new Date(input.since).getTime();
    if (!Number.isNaN(parsed)) {
      normalized.since = input.since;
      normalized.sinceMs = parsed;
    }
  }
  return normalized;
}

/**
 * Collapse whitespace runs and trim FIRST, then truncate to 200 chars;
 * detail_truncated iff the COLLAPSED string exceeds 200 (§4).
 */
function preview(
  source: string,
): Pick<TriageItem, "detail_preview" | "detail_truncated"> {
  const collapsed = source.replace(/\s+/g, " ").trim();
  if (!collapsed) return {};
  if (collapsed.length > PREVIEW_CHARS) {
    return {
      detail_preview: collapsed.slice(0, PREVIEW_CHARS),
      detail_truncated: true,
    };
  }
  return { detail_preview: collapsed };
}

/**
 * Raw-string (timestamp, id) comparator — safe because every compared value
 * is store-generated: Z-suffixed ISO timestamps and ULID ids, both
 * lexicographically time-ordered (§4.2). No clock involved.
 */
function byTimestampIdAsc(a: TriageItem, b: TriageItem): number {
  if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

function decisionItem(
  decision: Decision,
  status: "provisional" | "active",
  nowMs: number,
): TriageItem {
  return {
    kind: "decision",
    id: decision.id,
    scope: decision.scope,
    summary: decision.summary,
    agent_id: decision.agent_id,
    timestamp: decision.timestamp,
    age_ms: nowMs - Date.parse(decision.timestamp),
    ...preview(decision.rationale ?? ""),
    reversible: decision.reversible,
    confidence: decision.confidence,
    status,
  };
}

function blackboardItem(
  entry: BlackboardEntry,
  kind: "need" | "question" | "warning" | "artifact",
  nowMs: number,
  delegation?: DelegationMetadata,
): TriageItem {
  const item: TriageItem = {
    kind,
    id: entry.id,
    scope: entry.scope,
    summary: entry.summary,
    agent_id: entry.agent_id,
    timestamp: entry.timestamp,
    age_ms: nowMs - Date.parse(entry.timestamp),
    tags: entry.tags,
  };
  if (delegation) {
    // Delegation needs omit detail_preview — their detail is the JSON
    // metadata blob; the parsed fields replace it (§4).
    item.urgency = delegation.urgency;
    item.expires_at = delegation.expires_at;
  } else {
    Object.assign(item, preview(entry.detail ?? ""));
  }
  return item;
}

function countKind(items: TriageItem[], kind: TriageItem["kind"]): number {
  return items.filter((i) => i.kind === kind).length;
}

function countIrreversible(items: TriageItem[]): number {
  return items.filter(
    (i) => i.kind === "decision" && i.reversible === false,
  ).length;
}

/**
 * Build the triage read-model. Two-phase read: getIndex() narrows decision
 * candidates on status/scope/timestamp, then full records are read for the
 * narrowed set only (§5). The resolution corpus is ALWAYS the complete
 * unfiltered live board — membership filters never apply to it (§3.4).
 */
export async function buildTriage(
  stores: TriageStores,
  input: TriageInput = {},
  now: () => Date = () => new Date(),
): Promise<TriageResult> {
  const opts = normalize(input);
  // Sampled BEFORE the store reads (§3.2) — a strictly-cursoring consumer can
  // miss only a write landing in the same millisecond as generated_at.
  const generatedAt = now();
  const nowMs = generatedAt.getTime();
  const cutoffMs = Math.max(nowMs - opts.windowMs, opts.sinceMs ?? -Infinity);

  const index = await stores.decisionStore.getIndex();
  const { entries: board } = await stores.blackboardStore.read();
  const resolvedIds = computeResolvedIds(board);

  const candidates = index.filter((entry) => {
    if (opts.scope !== undefined && !scopeMatches(entry.scope, opts.scope)) {
      return false;
    }
    if (entry.status === "provisional") return true;
    if (entry.status === "active") return Date.parse(entry.timestamp) > cutoffMs;
    return false;
  });

  const openItems: TriageItem[] = [];
  const recentItems: TriageItem[] = [];

  for (const candidate of candidates) {
    const decision = await stores.decisionStore.get(candidate.id);
    if (!decision) continue;
    if (decision.status === "provisional") {
      openItems.push(decisionItem(decision, "provisional", nowMs));
    } else if (
      decision.status === "active" &&
      Date.parse(decision.timestamp) > cutoffMs
    ) {
      recentItems.push(decisionItem(decision, "active", nowMs));
    }
  }

  for (const entry of board) {
    if (opts.scope !== undefined && !scopeMatches(entry.scope, opts.scope)) {
      continue;
    }
    if (opts.forAgent !== undefined && entry.agent_id === opts.forAgent) {
      continue;
    }
    if (
      entry.entry_type === "need" ||
      entry.entry_type === "question" ||
      entry.entry_type === "warning"
    ) {
      if (resolvedIds.has(entry.id)) continue;
      if (entry.entry_type === "need") {
        const delegation = parseDelegationMetadata(entry);
        if (delegation) {
          if (isDelegationExpired(delegation, generatedAt)) continue;
          openItems.push(blackboardItem(entry, "need", nowMs, delegation));
          continue;
        }
      }
      openItems.push(blackboardItem(entry, entry.entry_type, nowMs));
    } else if (entry.entry_type === "artifact") {
      if (Date.parse(entry.timestamp) > cutoffMs) {
        recentItems.push(blackboardItem(entry, "artifact", nowMs));
      }
    }
  }

  // Sorting doubles as truncation selection: open ascending retains the N
  // oldest, recent descending retains the N newest — the §4.1 contractual
  // selection rule, independent of the advisory ordering.
  openItems.sort(byTimestampIdAsc);
  recentItems.sort((a, b) => byTimestampIdAsc(b, a));

  const result: TriageResult = {
    generated_at: generatedAt.toISOString(),
    window_ms: opts.windowMs,
    section: opts.section,
    counts: {
      open: {
        total: openItems.length,
        irreversible: countIrreversible(openItems),
        by_kind: {
          decision: countKind(openItems, "decision"),
          need: countKind(openItems, "need"),
          question: countKind(openItems, "question"),
          warning: countKind(openItems, "warning"),
        },
      },
      recent: {
        total: recentItems.length,
        irreversible: countIrreversible(recentItems),
        by_kind: {
          decision: countKind(recentItems, "decision"),
          artifact: countKind(recentItems, "artifact"),
        },
      },
    },
  };
  if (opts.scope !== undefined) result.scope = opts.scope;
  if (opts.forAgent !== undefined) result.for_agent = opts.forAgent;
  if (opts.since !== undefined) result.since = opts.since;
  if (opts.section !== "recent") result.open = openItems.slice(0, opts.limit);
  if (opts.section !== "open") result.recent = recentItems.slice(0, opts.limit);
  return result;
}
