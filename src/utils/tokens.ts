/**
 * Token estimation utility.
 * Uses the simple heuristic of 4 characters per token (spec section 10.4).
 */

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
