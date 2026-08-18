/**
 * Bidirectional prefix match for commit hashes (2.16.0 pre-tag review
 * TC-2/CS-1): links are stored however the caller wrote them — full 40-char
 * rev-parse output from hooks, 7-char abbreviations from humans — so an
 * exact-string test made short-vs-full lookups miss the common case and let
 * twining_commits assert "never linked" about a linked commit. Either side
 * being a prefix of the other counts, with a 4-character floor (git's own
 * abbreviation minimum) so an empty or tiny stored string can never match
 * everything. Case-insensitive: git SHAs are lowercase, pastes sometimes not.
 */
export function commitHashMatches(stored: string, query: string): boolean {
  const h = stored.toLowerCase();
  const q = query.toLowerCase();
  if (h === q) return true;
  if (h.length < 4 || q.length < 4) return false;
  return h.startsWith(q) || q.startsWith(h);
}
