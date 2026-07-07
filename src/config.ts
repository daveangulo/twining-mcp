/**
 * Configuration loading from .twining/config.yml with sensible defaults.
 */
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import type { TwiningConfig } from "./utils/types.js";

/**
 * Highest .twining/ on-disk format version this server can write.
 * A project whose config.yml carries a higher version was migrated by a
 * newer Twining release — this server must not write there (see
 * formatVersionRefusal), or old and new clients silently diverge.
 */
export const SUPPORTED_CONFIG_VERSION = 2;

/**
 * Returns a human-readable refusal reason when the on-disk format is newer
 * than this server supports, or null when writes are safe.
 */
export function formatVersionRefusal(config: TwiningConfig): string | null {
  if (
    typeof config.version === "number" &&
    config.version > SUPPORTED_CONFIG_VERSION
  ) {
    return (
      `.twining/ format version ${config.version} is newer than this ` +
      `twining-mcp release supports (${SUPPORTED_CONFIG_VERSION}). ` +
      `The project was migrated by a newer Twining version — update ` +
      `twining-mcp to record here. Reads still work; writes are refused ` +
      `to prevent divergence.`
    );
  }
  return null;
}

export const DEFAULT_CONFIG: TwiningConfig = {
  version: 1,
  project_name: "",
  embedding_model: "all-MiniLM-L6-v2",
  storage: {
    backend: "auto",         // v2: resolve by legacy detection — sqlite state → sqlite, legacy content → files + nudge, fresh → sqlite
    export_records: true,    // sqlite only: maintain committable .twining/records/ tree + ingest on startup
    auto_migrate: false,     // opt-in: auto-run `twining-mcp migrate` at startup on legacy projects (or TWINING_AUTO_MIGRATE=1)
  },
  archive: {
    auto_archive_on_commit: true,
    auto_archive_on_context_switch: true,
    max_blackboard_entries_before_archive: 500,
  },
  context_assembly: {
    default_max_tokens: 4000,
    priority_weights: {
      recency: 0.2,
      relevance: 0.2,
      decision_confidence: 0.15,
      warning_boost: 0.1,
      graph_reachability: 0.35,
    },
  },
  conflict_resolution: "human",
  agents: {
    liveness: {
      idle_after_ms: 300000, // 5 minutes
      gone_after_ms: 1800000, // 30 minutes
    },
  },
  delegations: {
    timeouts: {
      high_ms: 300000,       // 5 minutes
      normal_ms: 1800000,    // 30 minutes
      low_ms: 14400000,      // 4 hours
    },
  },
  analytics: {
    metrics: {
      enabled: true,         // Local metrics on by default
    },
    telemetry: {
      enabled: false,        // Opt-in only
      posthog_api_key: "",
      posthog_host: "https://us.i.posthog.com",
    },
  },
  instructions: {
    auto_inject: true,       // Include workflow instructions in MCP initialize response
  },
  tools: {
    mode: "full",            // "full" or "lite" — lite registers only core tools
    full_surface: false,     // when false, hide 16 rarely-used tools to reduce context noise
  },
  graph: {
    auto_populate: false,    // when false, skip auto-graph-population from tool calls
  },
  housekeeping: {
    staleness_threshold: 0.95,
  },
};

/** Deep merge source into target, returning a new object */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const key of Object.keys(target)) {
    const targetVal = target[key];
    const sourceVal = source[key];
    if (sourceVal === undefined) continue;
    if (
      targetVal !== null &&
      typeof targetVal === "object" &&
      !Array.isArray(targetVal) &&
      sourceVal !== null &&
      typeof sourceVal === "object" &&
      !Array.isArray(sourceVal)
    ) {
      result[key] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>,
      );
    } else {
      result[key] = sourceVal;
    }
  }
  return result;
}

/** Tolerance for treating a weight sum as "equal to 1.0". */
const WEIGHT_SUM_TOLERANCE = 0.01;

type PriorityWeights = TwiningConfig["context_assembly"]["priority_weights"];

function formatWeights(weights: Record<string, number>): string {
  return Object.entries(weights)
    .map(([k, v]) => `${k}=${Number(v.toFixed(4))}`)
    .join(", ");
}

/**
 * Resolve effective priority weights from what the user actually wrote in
 * config.yml (issue #34). deepMerge fills unspecified keys from defaults, so
 * a partial user set that sums to 1.0 on its own would look over-budget after
 * the merge — the old code then silently discarded ALL user weights.
 *
 * Rules:
 * 1. User keys alone sum to ~1.0 (±0.01): the set is complete — missing keys
 *    become 0. User intent is explicit.
 * 2. Otherwise: merge user keys over defaults and rescale proportionally so
 *    the set sums to 1.0. User weights are never silently discarded.
 * 3. Full defaults only for genuinely invalid input (non-numeric, negative,
 *    all-zero, or priority_weights not a mapping) — with a warning saying so.
 *
 * Returns the effective weights plus an actionable warning (what was
 * provided, what was done, final effective weights) or null when nothing
 * needed to change.
 */
function resolvePriorityWeights(
  rawUserWeights: unknown,
  defaults: Record<string, number>,
): { weights: Record<string, number>; warning: string | null } {
  if (rawUserWeights === undefined || rawUserWeights === null) {
    return { weights: { ...defaults }, warning: null };
  }
  if (typeof rawUserWeights !== "object" || Array.isArray(rawUserWeights)) {
    return {
      weights: { ...defaults },
      warning:
        `priority_weights must be a mapping of weight names to numbers ` +
        `(got ${JSON.stringify(rawUserWeights)}). Using defaults: ` +
        `${formatWeights(defaults)}.`,
    };
  }

  const userEntries = Object.entries(rawUserWeights as Record<string, unknown>);
  if (userEntries.length === 0) {
    return { weights: { ...defaults }, warning: null };
  }

  const invalid = userEntries.filter(
    ([, v]) => typeof v !== "number" || !Number.isFinite(v) || v < 0,
  );
  if (invalid.length > 0) {
    return {
      weights: { ...defaults },
      warning:
        `priority_weights has invalid values ` +
        `(${invalid.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ")}); ` +
        `weights must be non-negative numbers. Using defaults: ` +
        `${formatWeights(defaults)}.`,
    };
  }

  const user = Object.fromEntries(userEntries) as Record<string, number>;
  const userSum = Object.values(user).reduce((a, b) => a + b, 0);

  if (userSum === 0) {
    return {
      weights: { ...defaults },
      warning:
        `priority_weights are all zero (${formatWeights(user)}); nothing to ` +
        `normalize. Using defaults: ${formatWeights(defaults)}.`,
    };
  }

  // Rule 1: the user's own keys sum to ~1.0 — treat the set as complete.
  if (Math.abs(userSum - 1.0) <= WEIGHT_SUM_TOLERANCE) {
    const weights: Record<string, number> = {};
    for (const key of Object.keys(defaults)) weights[key] = 0;
    Object.assign(weights, user);
    const zeroed = Object.keys(defaults).filter((k) => !(k in user));
    if (zeroed.length === 0) {
      return { weights, warning: null };
    }
    return {
      weights,
      warning:
        `priority_weights (${formatWeights(user)}) sum to 1.0 on their own, ` +
        `so the set was treated as complete: unlisted keys ` +
        `${zeroed.join(", ")} set to 0. Effective weights: ` +
        `${formatWeights(weights)}. List all keys explicitly to silence this.`,
    };
  }

  // Rule 2: merge over defaults and rescale proportionally to sum 1.0.
  const merged: Record<string, number> = { ...defaults, ...user };
  const mergedSum = Object.values(merged).reduce((a, b) => a + b, 0);
  if (Math.abs(mergedSum - 1.0) <= WEIGHT_SUM_TOLERANCE) {
    return { weights: merged, warning: null };
  }
  const weights = Object.fromEntries(
    Object.entries(merged).map(([k, v]) => [k, v / mergedSum]),
  );
  return {
    weights,
    warning:
      `priority_weights (${formatWeights(user)}) merged with defaults sum to ` +
      `${Number(mergedSum.toFixed(4))}, expected 1.0; rescaled all weights ` +
      `proportionally. Effective weights: ${formatWeights(weights)}. ` +
      `Provide a full set summing to 1.0 to silence this.`,
  };
}

/**
 * Load config from .twining/config.yml, deep-merged with defaults.
 * If the file doesn't exist, returns DEFAULT_CONFIG.
 */
export function loadConfig(twiningDir: string): TwiningConfig {
  const configPath = path.join(twiningDir, "config.yml");
  if (!fs.existsSync(configPath)) {
    return { ...DEFAULT_CONFIG };
  }
  const raw = fs.readFileSync(configPath, "utf-8");
  const parsed = yaml.load(raw);
  if (parsed === null || parsed === undefined || typeof parsed !== "object") {
    return { ...DEFAULT_CONFIG };
  }
  const config = deepMerge(
    DEFAULT_CONFIG as unknown as Record<string, unknown>,
    parsed as Record<string, unknown>,
  ) as unknown as TwiningConfig;

  // Resolve priority weights from the RAW user config, not the merged one —
  // after deepMerge, user-provided keys are indistinguishable from defaults.
  const parsedCa = (parsed as Record<string, unknown>)["context_assembly"];
  const rawUserWeights =
    parsedCa !== null && typeof parsedCa === "object" && !Array.isArray(parsedCa)
      ? (parsedCa as Record<string, unknown>)["priority_weights"]
      : undefined;
  const { weights, warning } = resolvePriorityWeights(
    rawUserWeights,
    DEFAULT_CONFIG.context_assembly.priority_weights as Record<string, number>,
  );
  config.context_assembly.priority_weights = weights as PriorityWeights;
  if (warning) {
    console.error(`[twining] Warning: ${warning}`);
  }

  return config;
}
