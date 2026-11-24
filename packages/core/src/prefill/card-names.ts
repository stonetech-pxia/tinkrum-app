import { COMMON_FIRST_NAMES, FIRST_NAMES } from './card-names-data';

// Common first names (ASCII lowercase): split into two tiers of at least 1,000 users and at least 100 users. Surnames were tested and showed no gain, so they are omitted.
let common: Set<string> | null = null;
let known: Set<string> | null = null;

/** Approximate user count for this name: 1,000 for at least 1,000 users, 100 for at least 100 users, otherwise 0. */
export function firstCount(word: string): number {
  common ??= new Set(COMMON_FIRST_NAMES.split(' '));
  known ??= new Set(FIRST_NAMES.split(' '));
  return common.has(word) ? 1000 : known.has(word) ? 100 : 0;
}
