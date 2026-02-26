/**
 * Metrics collector — appends tool call metrics to .twining/metrics.jsonl.
 * Fire-and-forget: never fails a tool call, silently logs on error.
 */
import path from "node:path";
import type { MetricEntry } from "../utils/types.js";
import { appendJSONL } from "../storage/file-store.js";

export class MetricsCollector {
  private readonly metricsPath: string;
  private telemetryClient: TelemetryClientLike | null = null;

  constructor(twiningDir: string) {
    this.metricsPath = path.join(twiningDir, "metrics.jsonl");
  }

  /** Set an optional telemetry client to forward sanitized events */
  setTelemetryClient(client: TelemetryClientLike): void {
    this.telemetryClient = client;
  }

  /** Record a tool call metric. Fire-and-forget — never throws. */
  async record(entry: MetricEntry): Promise<void> {
    try {
      await appendJSONL(this.metricsPath, entry);
    } catch (err) {
      console.error("[twining] Metrics write failed (non-fatal):", (err as Error).message);
    }

    // Forward to telemetry if configured (sanitized — no args/content)
    if (this.telemetryClient) {
      try {
        this.telemetryClient.trackToolCalled(entry.tool_name, entry.duration_ms, entry.success);
      } catch {
        // Silently ignore telemetry failures
      }
    }
  }
}

/** Minimal interface for telemetry client to avoid circular imports */
export interface TelemetryClientLike {
  trackToolCalled(toolName: string, durationMs: number, success: boolean): void;
}
