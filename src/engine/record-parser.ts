/**
 * Parses natural language decision strings into structured decision input.
 *
 * Examples:
 *   "Chose Redis over Memcached — need persistence across restarts"
 *   "Used event-driven pattern instead of callbacks for notifications"
 *   "Reverted the workaround — root cause was fixed upstream"
 */

/** A rejected option, with its reason only when the prose actually stated one. */
export interface ParsedAlternative {
  option: string;
  reason_rejected?: string;
}

export interface ParsedDecision {
  summary: string;
  rationale: string;
  /**
   * "authored" when a separator or explicit marker split a real rationale out
   * of the text; "derived" when no separator matched and the rationale is an
   * echo of the summary. Consumers must treat an absent marker as unknown,
   * never as authored.
   */
  rationale_source: "authored" | "derived";
  rejected_alternatives: ParsedAlternative[];
  domain: string;
}

/**
 * Explicit rationale markers — preferred over heuristic separators because they
 * are unambiguous and authored intentionally. Word-boundary, case-insensitive.
 */
const EXPLICIT_RATIONALE_MARKERS = /\b(?:Rationale|Why|Reason|Because)\s*:\s*/i;

/**
 * Heuristic fallback separators when no explicit marker is present.
 * The em-dash is the strongest visual cue and is tried first.
 */
const FALLBACK_SEPARATORS = [
  /\s+—\s+/,
  /\s+--\s+/,
  /\s+(?:because|since|due to|so that)\s+/i,
];

/** Patterns that indicate a rejected alternative (unordered-NL style). */
const REJECTION_PATTERNS: RegExp[] = [
  /\bover\s+(.+?)(?:\s+(?:—|--|because|since|due to)|$)/gi,
  /\binstead of\s+(.+?)(?:\s+(?:—|--|because|since|due to)|$)/gi,
  /\brather than\s+(.+?)(?:\s+(?:—|--|because|since|due to)|$)/gi,
];

/** Labelled-list patterns for explicit rejections. */
const LABELLED_REJECTION_PATTERNS: RegExp[] = [
  // "Alternative rejected: X — reason" / "Rejected alternative: X."
  /\b(?:alternative\s+rejected|rejected\s+alternative)\s*:\s*(.+?)(?=\s*(?:\.|$|\balternative\s+rejected\b|\brejected\s+alternative\b))/gi,
  // "Rejected: X." (single)
  /\brejected\s*:\s*(.+?)(?=\.|$)/gi,
];

/**
 * Numbered-list pattern for "(1) item, (2) item, (3) item" phrasings.
 * Matches each (N) <text> up to the next (N+1) or end-of-string.
 */
const NUMBERED_LIST_PATTERN = /\((\d+)\)\s*([^()]+?)(?=\s*\(\d+\)|\.?\s*$)/g;

/** Keywords that hint at a domain. */
const DOMAIN_HINTS: Record<string, string[]> = {
  architecture: ["pattern", "architecture", "event-driven", "microservice", "monolith", "layer", "decouple"],
  security: ["auth", "jwt", "oauth", "token", "encrypt", "permission", "rbac"],
  performance: ["cache", "redis", "memcached", "index", "optimize", "latency", "batch"],
  "data-model": ["schema", "migration", "table", "column", "relation", "model", "entity"],
  "api-design": ["endpoint", "rest", "graphql", "grpc", "route", "api"],
  testing: ["test", "mock", "stub", "fixture", "coverage", "spec"],
  deployment: ["deploy", "docker", "k8s", "ci", "cd", "pipeline", "terraform"],
  implementation: [], // default fallback
};

/**
 * Split text into [summary, rationale] at the first separator of the strongest
 * available kind. Explicit markers win; em-dash is next; word separators last.
 * The rationale preserves the entire remainder (no second-split truncation).
 */
function splitSummaryAndRationale(text: string): {
  summary: string;
  rationale: string;
  rationale_source: "authored" | "derived";
} {
  const explicit = text.match(EXPLICIT_RATIONALE_MARKERS);
  if (explicit && explicit.index !== undefined) {
    const summary = text.slice(0, explicit.index).trim();
    const rationale = text.slice(explicit.index + explicit[0].length).trim();
    if (summary.length > 0 && rationale.length > 0) {
      return { summary, rationale, rationale_source: "authored" };
    }
  }

  for (const sep of FALLBACK_SEPARATORS) {
    const match = text.match(sep);
    if (match && match.index !== undefined) {
      const summary = text.slice(0, match.index).trim();
      const rationale = text.slice(match.index + match[0].length).trim();
      if (summary.length > 0 && rationale.length > 0) {
        return { summary, rationale, rationale_source: "authored" };
      }
    }
  }

  // No separator — the rationale is an echo of the summary, not a stated WHY.
  // Kept non-empty because decide() requires it and it feeds embedding text;
  // the marker is what tells consumers not to trust it as reasoning.
  const trimmed = text.trim();
  return { summary: trimmed, rationale: trimmed, rationale_source: "derived" };
}

/**
 * A choice framed in the negative — "Chose NOT to X over Y" — inverts what the
 * contrast keyword means: Y is the option that was KEPT. The old bare-`not`
 * pattern turned these inside out, filing the kept option as rejected. Unordered
 * extraction is suppressed inside such a clause; labelled and numbered forms are
 * unaffected because they name their rejections explicitly.
 */
const NEGATED_CHOICE =
  /\b(?:chose|decided|opted|elected)\s+(?:explicitly\s+)?not\s+to\b/i;

/**
 * Splits a labelled rejection clause into its option and its reason. This is
 * the only construction in prose that states a real why-not, so it is the only
 * one allowed to populate reason_rejected.
 */
const LABELLED_REASON_SPLIT = /\s+—\s+|\s+--\s+|\s+because\s+|\s+due to\s+/;

/** Extract rejected alternatives from the full text. */
function extractRejectedAlternatives(text: string): ParsedAlternative[] {
  const seen = new Set<string>();
  const out: ParsedAlternative[] = [];

  const push = (raw: string, allowReason: boolean): void => {
    let option = raw.trim().replace(/[.,;]+$/, "").trim();
    let reason: string | undefined;

    if (allowReason) {
      const split = option.split(LABELLED_REASON_SPLIT);
      const head = split[0]?.trim() ?? "";
      const tail = split.slice(1).join(" ").trim();
      if (split.length > 1 && head && tail) {
        option = head.replace(/[.,;]+$/, "").trim();
        reason = tail.replace(/[.,;]+$/, "").trim();
      }
    }

    if (option.length === 0) return;
    const key = option.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(reason ? { option, reason_rejected: reason } : { option });
  };

  // Labelled rejections take priority — they're the clearest signal, and the
  // only ones that can carry a stated reason.
  for (const pattern of LABELLED_REJECTION_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      if (match[1]) push(match[1], true);
    }
  }

  // Numbered lists inside a "rejected" / "alternatives" context.
  if (/\b(?:rejected|alternatives?)\b/i.test(text)) {
    for (const match of text.matchAll(NUMBERED_LIST_PATTERN)) {
      if (match[2]) push(match[2], false);
    }
  }

  // Unordered NL patterns last — skip if we already collected labelled items,
  // since those would otherwise double-count sub-phrases. Never inside a
  // negated choice, where the contrast keyword names the option that was kept.
  if (out.length === 0 && !NEGATED_CHOICE.test(text)) {
    for (const pattern of REJECTION_PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        if (match[1]) push(match[1], false);
      }
    }
  }

  return out;
}

export function parseDecision(text: string): ParsedDecision {
  const { summary, rationale, rationale_source } = splitSummaryAndRationale(text);
  const rejected = extractRejectedAlternatives(text);

  // Infer domain from keywords
  const lower = text.toLowerCase();
  let domain = "implementation";
  for (const [d, keywords] of Object.entries(DOMAIN_HINTS)) {
    if (keywords.some((k) => lower.includes(k))) {
      domain = d;
      break;
    }
  }

  return {
    summary,
    rationale,
    rationale_source,
    rejected_alternatives: rejected,
    domain,
  };
}
