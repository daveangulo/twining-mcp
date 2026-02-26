/**
 * PostHog telemetry client — opt-in anonymous usage data.
 *
 * Privacy safeguards:
 * - Disabled by default, requires explicit config opt-in
 * - Respects DO_NOT_TRACK=1 and CI=true env vars
 * - Identity: SHA-256 hash of hostname + projectRoot (never raw)
 * - Never sends: file paths, decision content, agent names, error messages, env vars
 * - Dynamic import of posthog-node — graceful no-op if not installed
 * - Non-blocking: fire-and-forget, silent on network failure
 */
import { createHash } from "node:crypto";
import os from "node:os";
import type { AnalyticsConfig } from "../utils/types.js";

const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

interface PostHogLike {
  capture(event: { distinctId: string; event: string; properties?: Record<string, unknown> }): void;
  shutdown(): Promise<void>;
}

export class TelemetryClient {
  private client: PostHogLike | null = null;
  private distinctId: string = "";
  private enabled: boolean = false;

  /** Initialize telemetry. Returns true if enabled and ready. */
  async init(
    config: AnalyticsConfig | undefined,
    projectRoot: string,
    version: string,
  ): Promise<boolean> {
    // Gate: disabled by default
    if (!config?.telemetry?.enabled) return false;

    // Gate: respect DO_NOT_TRACK
    if (process.env.DO_NOT_TRACK === "1") return false;

    // Gate: auto-disable in CI
    if (process.env.CI === "true") return false;

    // Read key from env var or config — never hardcoded in source
    const apiKey = process.env.POSTHOG_API_KEY || config.telemetry.posthog_api_key;
    const host = config.telemetry.posthog_host || DEFAULT_POSTHOG_HOST;
    if (!apiKey) return false;

    // Compute anonymous distinct ID
    this.distinctId = createHash("sha256")
      .update(os.hostname() + projectRoot)
      .digest("hex")
      .slice(0, 16);

    // Dynamic import — graceful no-op if not installed
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = await (Function('return import("posthog-node")')() as Promise<Record<string, unknown>>);
      const PostHog = mod.PostHog || (mod.default as Record<string, unknown>)?.PostHog;
      if (!PostHog) return false;

      this.client = new (PostHog as new (...args: unknown[]) => PostHogLike)(
        apiKey,
        { host },
      );
      this.enabled = true;

      // Track server start
      this.trackServerStarted(version);
      return true;
    } catch {
      // posthog-node not installed or import failed — graceful no-op
      return false;
    }
  }

  /** Track server started event */
  trackServerStarted(version: string): void {
    if (!this.enabled || !this.client) return;
    try {
      this.client.capture({
        distinctId: this.distinctId,
        event: "server_started",
        properties: {
          version,
          node_version: process.version,
          os: process.platform,
          arch: process.arch,
        },
      });
    } catch {
      // Silent failure
    }
  }

  /** Track a tool call (sanitized — no args/content/errors) */
  trackToolCalled(toolName: string, durationMs: number, success: boolean): void {
    if (!this.enabled || !this.client) return;
    try {
      this.client.capture({
        distinctId: this.distinctId,
        event: "tool_called",
        properties: {
          tool_name: toolName,
          duration_ms: durationMs,
          success,
        },
      });
    } catch {
      // Silent failure
    }
  }

  /** Track session summary (periodic aggregate) */
  trackSessionSummary(
    callCountsByTool: Record<string, number>,
    decisionCount: number,
    entityCount: number,
  ): void {
    if (!this.enabled || !this.client) return;
    try {
      this.client.capture({
        distinctId: this.distinctId,
        event: "session_summary",
        properties: {
          call_counts: callCountsByTool,
          decision_count: decisionCount,
          entity_count: entityCount,
        },
      });
    } catch {
      // Silent failure
    }
  }

  /** Flush and shut down */
  async shutdown(): Promise<void> {
    if (!this.enabled || !this.client) return;
    try {
      await this.client.shutdown();
    } catch {
      // Silent failure
    }
  }

  /** Whether telemetry is active */
  isEnabled(): boolean {
    return this.enabled;
  }
}
