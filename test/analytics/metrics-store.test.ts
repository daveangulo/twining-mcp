import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { MetricsStore } from "../../src/analytics/metrics-store.js";
import { appendJSONL } from "../../src/storage/file-store.js";
import type { MetricEntry } from "../../src/utils/types.js";

let tmpDir: string;
let twiningDir: string;
let store: MetricsStore;

function metricsPath(): string {
  return path.join(twiningDir, "metrics.jsonl");
}

async function writeMetric(entry: Partial<MetricEntry> & { tool_name: string }): Promise<void> {
  await appendJSONL(metricsPath(), {
    tool_name: entry.tool_name,
    timestamp: entry.timestamp || "2024-01-01T00:00:00Z",
    duration_ms: entry.duration_ms ?? 10,
    success: entry.success ?? true,
    error_code: entry.error_code,
    agent_id: entry.agent_id || "test",
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-metrics-store-test-"));
  twiningDir = path.join(tmpDir, ".twining");
  fs.mkdirSync(twiningDir, { recursive: true });
  store = new MetricsStore(twiningDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("MetricsStore", () => {
  describe("getToolUsageSummary", () => {
    it("returns empty array when no metrics exist", async () => {
      const summary = await store.getToolUsageSummary();
      expect(summary).toEqual([]);
    });

    it("aggregates by tool name with correct counts", async () => {
      await writeMetric({ tool_name: "twining_post", duration_ms: 10 });
      await writeMetric({ tool_name: "twining_post", duration_ms: 20 });
      await writeMetric({ tool_name: "twining_decide", duration_ms: 50 });

      const summary = await store.getToolUsageSummary();
      expect(summary).toHaveLength(2);

      const post = summary.find((s) => s.tool_name === "twining_post");
      expect(post).toBeDefined();
      expect(post!.call_count).toBe(2);
      expect(post!.avg_duration_ms).toBe(15);
    });

    it("computes p95 duration", async () => {
      // Write 20 entries with known durations
      for (let i = 1; i <= 20; i++) {
        await writeMetric({ tool_name: "test_tool", duration_ms: i * 10 });
      }

      const summary = await store.getToolUsageSummary();
      const tool = summary.find((s) => s.tool_name === "test_tool");
      expect(tool).toBeDefined();
      expect(tool!.p95_duration_ms).toBe(190); // 95th percentile of 10-200
    });

    it("counts errors correctly", async () => {
      await writeMetric({ tool_name: "twining_post", success: true });
      await writeMetric({ tool_name: "twining_post", success: false, error_code: "VALIDATION_ERROR" });
      await writeMetric({ tool_name: "twining_post", success: false, error_code: "INTERNAL_ERROR" });

      const summary = await store.getToolUsageSummary();
      const post = summary.find((s) => s.tool_name === "twining_post");
      expect(post!.error_count).toBe(2);
    });

    it("filters by since timestamp", async () => {
      await writeMetric({ tool_name: "twining_post", timestamp: "2024-01-01T00:00:00Z" });
      await writeMetric({ tool_name: "twining_post", timestamp: "2024-06-01T00:00:00Z" });

      const summary = await store.getToolUsageSummary("2024-03-01T00:00:00Z");
      expect(summary).toHaveLength(1);
      expect(summary[0]!.call_count).toBe(1);
    });

    it("sorts by call count descending", async () => {
      await writeMetric({ tool_name: "low" });
      await writeMetric({ tool_name: "high" });
      await writeMetric({ tool_name: "high" });
      await writeMetric({ tool_name: "high" });

      const summary = await store.getToolUsageSummary();
      expect(summary[0]!.tool_name).toBe("high");
      expect(summary[1]!.tool_name).toBe("low");
    });
  });

  describe("getUsageOverTime", () => {
    it("returns empty array when no metrics exist", async () => {
      const buckets = await store.getUsageOverTime();
      expect(buckets).toEqual([]);
    });

    it("buckets metrics by time", async () => {
      await writeMetric({ tool_name: "a", timestamp: "2024-01-01T00:00:00Z" });
      await writeMetric({ tool_name: "b", timestamp: "2024-01-01T00:30:00Z" });
      await writeMetric({ tool_name: "c", timestamp: "2024-01-01T02:00:00Z" });

      const buckets = await store.getUsageOverTime(60);
      expect(buckets).toHaveLength(2);
      expect(buckets[0]!.call_count).toBe(2); // First two in same hour
      expect(buckets[1]!.call_count).toBe(1);
    });
  });

  describe("getErrorBreakdown", () => {
    it("returns empty array when no errors", async () => {
      await writeMetric({ tool_name: "ok", success: true });
      const errors = await store.getErrorBreakdown();
      expect(errors).toEqual([]);
    });

    it("groups errors by tool and code", async () => {
      await writeMetric({ tool_name: "a", success: false, error_code: "ERR1" });
      await writeMetric({ tool_name: "a", success: false, error_code: "ERR1" });
      await writeMetric({ tool_name: "a", success: false, error_code: "ERR2" });
      await writeMetric({ tool_name: "b", success: false, error_code: "ERR1" });

      const errors = await store.getErrorBreakdown();
      expect(errors).toHaveLength(3);
      expect(errors[0]!.count).toBe(2); // a::ERR1 is most frequent
    });
  });

  describe("mtime caching", () => {
    it("returns cached data when file has not changed", async () => {
      await writeMetric({ tool_name: "cached" });

      const first = await store.getToolUsageSummary();
      expect(first).toHaveLength(1);

      // Read again — should use cache (same result)
      const second = await store.getToolUsageSummary();
      expect(second).toHaveLength(1);
      expect(second[0]!.tool_name).toBe("cached");
    });
  });

  describe("corrupt line handling", () => {
    it("skips corrupt JSONL lines gracefully", async () => {
      const mp = metricsPath();
      fs.writeFileSync(mp, "");
      fs.appendFileSync(mp, JSON.stringify({
        tool_name: "good", timestamp: "2024-01-01T00:00:00Z",
        duration_ms: 10, success: true, agent_id: "test",
      }) + "\n");
      fs.appendFileSync(mp, "not valid json\n");
      fs.appendFileSync(mp, JSON.stringify({
        tool_name: "also_good", timestamp: "2024-01-01T00:00:00Z",
        duration_ms: 20, success: true, agent_id: "test",
      }) + "\n");

      const summary = await store.getToolUsageSummary();
      expect(summary).toHaveLength(2);
    });
  });
});
