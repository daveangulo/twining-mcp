/**
 * Tag normalization utility for agent capabilities and other tag arrays.
 * Lowercases, trims, deduplicates, and filters empty strings.
 */

/**
 * Normalize an array of tags: lowercase, trim, deduplicate, filter empties.
 */
export function normalizeTags(tags: string[]): string[] {
  const normalized = tags.map((tag) => tag.toLowerCase().trim()).filter((tag) => tag !== "");
  return [...new Set(normalized)];
}
