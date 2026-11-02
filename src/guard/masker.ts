import type { QueryResult } from '../adapters/types.js';

/**
 * Masking of sensitive columns based on the NAME of the result column.
 *
 * Matching is per name segment: the pattern "nik" (Indonesian national ID number) matches "nik" and "no_nik" but not
 * "teknik"; the pattern "card_number" matches "customer_card_number"; "passwordHash"
 * is split into "password" + "hash".
 *
 * Limitation: an alias can rename a column (SELECT password AS x). Masking is therefore
 * an extra layer; the main controls remain database user privileges and VIEWs.
 */

export const MASK = '***';

/** Split a column name into lower-case segments: "passwordHash" -> ["password", "hash"]. */
export function nameSegments(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((s) => s !== '');
}

function containsSequence(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    if (needle.every((part, k) => haystack[i + k] === part)) return true;
  }
  return false;
}

/** Returns true when a column (or key/field) name is sensitive. */
export type ColumnMatcher = (column: string) => boolean;

/** Create a matcher from name patterns; a pattern matches whole name segments, not fragments. */
export function createColumnMatcher(patterns: readonly string[]): ColumnMatcher {
  const compiled = patterns.map(nameSegments).filter((p) => p.length > 0);
  return (column) => {
    const segments = nameSegments(column);
    return compiled.some((pattern) => containsSequence(segments, pattern));
  };
}

/** Replace values in sensitive columns with "***" (NULL stays NULL). */
export function maskResult(
  result: QueryResult,
  isSensitive: ColumnMatcher,
): { result: QueryResult; masked: string[] } {
  const flags = result.columns.map((c) => isSensitive(c));
  const masked = result.columns.filter((_, i) => flags[i]);
  if (masked.length === 0) return { result, masked };
  const rows = result.rows.map((row) =>
    row.map((value, i) => (flags[i] && value !== null && value !== undefined ? MASK : value)),
  );
  return { result: { ...result, rows }, masked };
}
