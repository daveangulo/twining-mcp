import { describe, it, expect } from "vitest";
import {
  computeLiveness,
  DEFAULT_LIVENESS_THRESHOLDS,
} from "../src/utils/liveness.js";

describe("computeLiveness", () => {
  const now = new Date("2026-02-17T12:00:00Z");

  it("returns 'active' when last_active is within 5 minutes", () => {
    const lastActive = new Date(now.getTime() - 2 * 60 * 1000).toISOString(); // 2 min ago
    expect(computeLiveness(lastActive, now)).toBe("active");
  });

  it("returns 'idle' when last_active is 10 minutes ago", () => {
    const lastActive = new Date(now.getTime() - 10 * 60 * 1000).toISOString(); // 10 min ago
    expect(computeLiveness(lastActive, now)).toBe("idle");
  });

  it("returns 'gone' when last_active is 60 minutes ago", () => {
    const lastActive = new Date(now.getTime() - 60 * 60 * 1000).toISOString(); // 60 min ago
    expect(computeLiveness(lastActive, now)).toBe("gone");
  });

  it("supports custom thresholds", () => {
    const thresholds = { idle_after_ms: 1000, gone_after_ms: 5000 };
    const lastActive = new Date(now.getTime() - 3000).toISOString(); // 3 sec ago
    expect(computeLiveness(lastActive, now, thresholds)).toBe("idle");
  });

  it("returns 'active' at exactly idle_after_ms - 1", () => {
    const lastActive = new Date(
      now.getTime() - DEFAULT_LIVENESS_THRESHOLDS.idle_after_ms + 1,
    ).toISOString();
    expect(computeLiveness(lastActive, now)).toBe("active");
  });

  it("returns 'idle' at exactly idle_after_ms", () => {
    const lastActive = new Date(
      now.getTime() - DEFAULT_LIVENESS_THRESHOLDS.idle_after_ms,
    ).toISOString();
    expect(computeLiveness(lastActive, now)).toBe("idle");
  });

  it("returns 'active' for future timestamp (last_active ahead of now)", () => {
    const lastActive = new Date(now.getTime() + 60 * 1000).toISOString(); // 1 min in future
    expect(computeLiveness(lastActive, now)).toBe("active");
  });

  it("exports DEFAULT_LIVENESS_THRESHOLDS with correct values", () => {
    expect(DEFAULT_LIVENESS_THRESHOLDS.idle_after_ms).toBe(5 * 60 * 1000);
    expect(DEFAULT_LIVENESS_THRESHOLDS.gone_after_ms).toBe(30 * 60 * 1000);
  });
});
