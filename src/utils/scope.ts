/**
 * Shared scope matching.
 * Scopes use path-prefix semantics: two scopes match when either is a
 * prefix of the other (a broad "src/" matches a narrow "src/auth/" and
 * vice versa).
 */
export function scopeMatches(a: string, b: string): boolean {
  return a.startsWith(b) || b.startsWith(a);
}
