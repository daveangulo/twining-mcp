/**
 * Entity property merge semantics, shared by both graph backends so they
 * cannot drift apart (file: storage/graph-store.ts, sqlite:
 * storage/sqlite/sqlite-stores.ts).
 *
 * Background: entity upsert merged properties with `{...existing, ...input}`,
 * so a repeated key was overwritten last-writer-wins. That is correct for most
 * properties but wrong for `scope`. The graph auto-populator stamps every file
 * and symbol entity with the scope of the decision that touched it
 * (engine/graph-auto-populator.ts), so a file touched by decisions in two
 * scopes ended up carrying only the most recent one — irrecoverably, and
 * rewriting the entity record every time it flipped.
 *
 * Measured on this repo before the fix: of 242 file entities carrying a scope,
 * only 132 had a name starting with that scope. The other 110 had been stamped
 * with an unrelated scope by a later decision.
 *
 * `scope` therefore accumulates as a sorted, deduplicated set. Sorting matters
 * for two reasons: it makes the stored bytes deterministic (no git churn from
 * ordering alone), and it makes the cap stable, so a hot entity converges
 * instead of oscillating.
 */

/** Property keys that union rather than overwrite on upsert. */
const SET_VALUED_KEYS = new Set(["scope"]);

/** Separator for set-valued properties. Scopes are paths; commas are safe. */
const SET_SEPARATOR = ",";

/**
 * Caps on an accumulated set. A file at the centre of a large project can be
 * touched from many scopes; without a bound the property grows forever and can
 * exceed the 1000-char limit the tool schema enforces on property values.
 * Entries beyond the cap are dropped in sort order, which is arbitrary but
 * stable — the alternative (drop oldest) reintroduces churn.
 */
const MAX_SET_ENTRIES = 12;
const MAX_SET_LENGTH = 480;

/** Split a stored set-valued property back into its members. */
export function splitSetProperty(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(SET_SEPARATOR)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Join members into the stored form, sorted, deduplicated, and capped. */
export function joinSetProperty(members: string[]): string {
  const unique = [...new Set(members.map((m) => m.trim()).filter(Boolean))].sort();
  const capped: string[] = [];
  let length = 0;
  for (const m of unique) {
    if (capped.length >= MAX_SET_ENTRIES) break;
    const added = length === 0 ? m.length : m.length + SET_SEPARATOR.length;
    if (length + added > MAX_SET_LENGTH) break;
    capped.push(m);
    length += added;
  }
  return capped.join(SET_SEPARATOR);
}

/**
 * Merge incoming entity properties over existing ones. Ordinary keys overwrite
 * (last writer wins); keys in SET_VALUED_KEYS union into a sorted set.
 *
 * Backward compatible: an existing singular value like "src/auth/" is a valid
 * one-element set, and every consumer of `scope` does substring matching
 * (engine/context-assembler.ts getRelatedEntities and computeGraphReachability),
 * which still matches against a joined set.
 */
export function mergeEntityProperties(
  existing: Record<string, string> | undefined,
  incoming: Record<string, string> | undefined,
): Record<string, string> {
  const merged: Record<string, string> = { ...(existing ?? {}) };
  for (const [key, value] of Object.entries(incoming ?? {})) {
    if (SET_VALUED_KEYS.has(key)) {
      const union = [...splitSetProperty(merged[key]), ...splitSetProperty(value)];
      const joined = joinSetProperty(union);
      if (joined) merged[key] = joined;
      continue;
    }
    merged[key] = value;
  }
  return merged;
}
