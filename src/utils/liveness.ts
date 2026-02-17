/**
 * Agent liveness computation.
 * Pure function that determines agent state from last_active timestamp.
 */
import type { AgentLiveness, LivenessThresholds } from "./types.js";

export const DEFAULT_LIVENESS_THRESHOLDS: LivenessThresholds = {
  idle_after_ms: 5 * 60 * 1000, // 5 minutes
  gone_after_ms: 30 * 60 * 1000, // 30 minutes
};

/**
 * Compute agent liveness state based on elapsed time since last activity.
 * - "active" if elapsed < idle_after_ms
 * - "idle" if elapsed < gone_after_ms
 * - "gone" otherwise
 */
export function computeLiveness(
  lastActive: string,
  now: Date = new Date(),
  thresholds: LivenessThresholds = DEFAULT_LIVENESS_THRESHOLDS,
): AgentLiveness {
  const elapsed = now.getTime() - new Date(lastActive).getTime();
  if (elapsed < thresholds.idle_after_ms) return "active";
  if (elapsed < thresholds.gone_after_ms) return "idle";
  return "gone";
}
