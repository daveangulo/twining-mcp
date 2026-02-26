/**
 * Metrics store — reads metrics.jsonl with mtime caching.
 * Same pattern as BlackboardStore for efficient repeated reads.
 */
import fs from "node:fs";
import path from "node:path";
import type { MetricEntry, ToolUsageSummary, UsageBucket } from "../utils/types.js";
import { readJSONL } from "../storage/file-store.js";

export class MetricsStore {
  private readonly metricsPath: string;
  private cachedEntries: MetricEntry[] | null = null;
  private cachedMtime: number = 0;

  constructor(twiningDir: string) {
    this.metricsPath = path.join(twiningDir, "metrics.jsonl");
  }

  /** Read all metrics, using mtime cache when possible */
  private async readAll(): Promise<MetricEntry[]> {
    try {
      if (!fs.existsSync(this.metricsPath)) return [];
      const stat = fs.statSync(this.metricsPath);
      if (this.cachedEntries !== null && stat.mtimeMs === this.cachedMtime) {
        return this.cachedEntries;
      }
      const entries = await readJSONL<MetricEntry>(this.metricsPath);
      this.cachedEntries = entries;
      this.cachedMtime = stat.mtimeMs;
      return entries;
    } catch {
      return [];
    }
  }

  /** Get tool usage summary, optionally filtered by time */
  async getToolUsageSummary(since?: string): Promise<ToolUsageSummary[]> {
    const entries = await this.readAll();
    const filtered = since
      ? entries.filter((e) => e.timestamp >= since)
      : entries;

    const byTool = new Map<string, MetricEntry[]>();
    for (const entry of filtered) {
      const existing = byTool.get(entry.tool_name) || [];
      existing.push(entry);
      byTool.set(entry.tool_name, existing);
    }

    const summaries: ToolUsageSummary[] = [];
    for (const [tool_name, toolEntries] of byTool) {
      const durations = toolEntries.map((e) => e.duration_ms).sort((a, b) => a - b);
      const errorCount = toolEntries.filter((e) => !e.success).length;
      const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length;
      const p95Index = Math.min(
        Math.ceil(durations.length * 0.95) - 1,
        durations.length - 1,
      );

      summaries.push({
        tool_name,
        call_count: toolEntries.length,
        error_count: errorCount,
        avg_duration_ms: Math.round(avgDuration),
        p95_duration_ms: durations[p95Index]!,
        last_called: toolEntries[toolEntries.length - 1]!.timestamp,
      });
    }

    return summaries.sort((a, b) => b.call_count - a.call_count);
  }

  /** Get usage over time in buckets */
  async getUsageOverTime(bucketMinutes: number = 60): Promise<UsageBucket[]> {
    const entries = await this.readAll();
    if (entries.length === 0) return [];

    const bucketMs = bucketMinutes * 60 * 1000;
    const buckets = new Map<number, MetricEntry[]>();

    for (const entry of entries) {
      const ts = new Date(entry.timestamp).getTime();
      const bucketStart = Math.floor(ts / bucketMs) * bucketMs;
      const existing = buckets.get(bucketStart) || [];
      existing.push(entry);
      buckets.set(bucketStart, existing);
    }

    const result: UsageBucket[] = [];
    const sortedKeys = [...buckets.keys()].sort((a, b) => a - b);

    for (const key of sortedKeys) {
      const bucketEntries = buckets.get(key)!;
      const durations = bucketEntries.map((e) => e.duration_ms);
      const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length;

      result.push({
        bucket_start: new Date(key).toISOString(),
        bucket_end: new Date(key + bucketMs).toISOString(),
        call_count: bucketEntries.length,
        error_count: bucketEntries.filter((e) => !e.success).length,
        avg_duration_ms: Math.round(avgDuration),
      });
    }

    return result;
  }

  /** Get error breakdown by tool and error code */
  async getErrorBreakdown(): Promise<
    Array<{ tool_name: string; error_code: string; count: number }>
  > {
    const entries = await this.readAll();
    const errors = entries.filter((e) => !e.success);

    const byKey = new Map<string, number>();
    for (const entry of errors) {
      const key = `${entry.tool_name}::${entry.error_code || "unknown"}`;
      byKey.set(key, (byKey.get(key) || 0) + 1);
    }

    return [...byKey.entries()]
      .map(([key, count]) => {
        const [tool_name, error_code] = key.split("::");
        return { tool_name: tool_name!, error_code: error_code!, count };
      })
      .sort((a, b) => b.count - a.count);
  }
}
