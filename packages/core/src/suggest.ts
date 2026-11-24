import { ID_PATTERN } from './schema-primitives';

// Fixes in error messages (D-597): when App files written by other AIs are incorrect, tell it "Did you mean to write X" or "Change this id to Y" so it can be fixed directly.

const normal = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++)
      next[j] = Math.min(
        row[j]! + 1,
        next[j - 1]! + 1,
        row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    row = next;
  }
  return row[b.length]!;
}

/**
 * The candidate most similar to value: differing only in case and symbols, one being a prefix of
 * the other (at least 3 characters), or differing by only one or two characters. If none are
 * similar, do not guess: guessing wrong is more misleading than saying nothing.
 */
export function closest(value: string, candidates: Iterable<string>): string | undefined {
  const v = normal(value);
  if (!v) return undefined;
  let best: string | undefined;
  let bestScore = Infinity;
  for (const candidate of candidates) {
    if (candidate === value) continue;
    const c = normal(candidate);
    if (!c) continue;
    const score =
      c === v
        ? 0
        : Math.min(c.length, v.length) >= 3 && (c.startsWith(v) || v.startsWith(c))
          ? 1
          : distance(v, c) <= (v.length >= 5 ? 2 : 1)
            ? 1 + distance(v, c)
            : Infinity;
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

/** "(Did you mean "x"?)", returns empty string if no guess can be made. */
export function didYouMean(value: string, candidates: Iterable<string>, show = JSON.stringify) {
  const guess = closest(value, candidates);
  return guess === undefined ? '' : ` (did you mean ${show(guess)}?)`;
}

/** Convert incorrect IDs into valid formats: opening_balance → opening-balance, dueDate → due-date. Returns undefined if it cannot be converted (e.g., entirely Chinese). */
export function idFrom(value: string): string | undefined {
  const id = value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .slice(0, 48)
    .replace(/-+$/, '');
  return ID_PATTERN.test(id) ? id : undefined;
}
