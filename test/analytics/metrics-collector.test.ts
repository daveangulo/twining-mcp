import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { MetricsCollector } from "../../src/analytics/metrics-collector.js";
import { readJSONL } from "../../src/storage/file-store.js";
import type { MetricEntry } from "../../src/utils/types.js";

let tmpDir: string;
let twiningDir: string;
let collector: MetricsCollector;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-metrics-test-"));
  twiningDir = path.join(tmpDir, ".twining");
  fs.mkdirSync(twiningDir, { recursive: true });
  collector = new MetricsCollector(twiningDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("MetricsCollector", () => {
  it("appends metric entries to metrics.jsonl", async () => {
    await collector.record({
      tool_name: "twining_post",
      timestamp: "2024-01-01T00:00:00Z",
      duration_ms: 42,
      success: true,
      agent_id: "agent-1",
    });

    const entries = await readJSONL<MetricEntry>(
      path.join(twiningDir, "metrics.jsonl"),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.tool_name).toBe("twining_post");
    expect(entries[0]!.duration_ms).toBe(42);
    expect(entries[0]!.success).toBe(true);
  });

  it("records error metrics with error_code", async () => {
    await collector.record({
      tool_name: "twining_decide",
      timestamp: "2024-01-01T00:00:00Z",
      duration_ms: 100,
      success: false,
      error_code: "VALIDATION_ERROR",
      agent_id: "agent-1",
    });

    const entries = await readJSONL<MetricEntry>(
      path.join(twiningDir, "metrics.jsonl"),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.success).toBe(false);
    expect(entries[0]!.error_code).toBe("VALIDATION_ERROR");
  });

  it("handles concurrent writes", async () => {
    const promises = [];
    for (let i = 0; i < 10; i++) {
      promises.push(
        collector.record({
          tool_name: `tool_${i}`,
          timestamp: "2024-01-01T00:00:00Z",
          duration_ms: i,
          success: true,
          agent_id: "agent-1",
        }),
      );
    }
    await Promise.all(promises);

    const entries = await readJSONL<MetricEntry>(
      path.join(twiningDir, "metrics.jsonl"),
    );
    expect(entries).toHaveLength(10);
  });

  it("never throws even when write fails (fire-and-forget)", async () => {
    // Point collector at a non-existent directory that can't be created
    const badCollector = new MetricsCollector("/nonexistent/path/.twining");

    // Should not throw
    await badCollector.record({
      tool_name: "test",
      timestamp: "2024-01-01T00:00:00Z",
      duration_ms: 1,
      success: true,
      agent_id: "agent-1",
    });
  });

  it("forwards to telemetry client when set", async () => {
    const captured: Array<{ tool: string; duration: number; success: boolean }> = [];
    const mockTelemetry = {
      trackToolCalled(toolName: string, durationMs: number, success: boolean) {
        captured.push({ tool: toolName, duration: durationMs, success });
      },
    };

    collector.setTelemetryClient(mockTelemetry);
    await collector.record({
      tool_name: "twining_assemble",
      timestamp: "2024-01-01T00:00:00Z",
      duration_ms: 55,
      success: true,
      agent_id: "agent-1",
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]!.tool).toBe("twining_assemble");
    expect(captured[0]!.duration).toBe(55);
  });

  it("silently ignores telemetry failures", async () => {
    const mockTelemetry = {
      trackToolCalled() {
        throw new Error("telemetry failure");
      },
    };

    collector.setTelemetryClient(mockTelemetry);

    // Should not throw
    await collector.record({
      tool_name: "test",
      timestamp: "2024-01-01T00:00:00Z",
      duration_ms: 1,
      success: true,
      agent_id: "agent-1",
    });
  });
});
