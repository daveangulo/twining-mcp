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
export const SUPPORTED_CONFIG_VERSION = 1;

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

  // Validate priority weights sum to 1.0
  const weights = config.context_assembly.priority_weights;
  const weightSum = Object.values(weights).reduce((a, b) => (a ?? 0) + (b ?? 0), 0) as number;
  if (Math.abs(weightSum - 1.0) > 0.01) {
    console.error(
      `[twining] Warning: priority_weights sum to ${weightSum}, expected 1.0. Using defaults.`,
    );
    config.context_assembly.priority_weights = { ...DEFAULT_CONFIG.context_assembly.priority_weights };
  }

  return config;
}
