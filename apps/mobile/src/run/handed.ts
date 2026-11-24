import type { HandedFiles, RunValue } from '@morph/core';

// Value passed by the container to the run page (D-428): record contents cannot be placed into
// route parameters, so the route carries only a single key, with the value kept in memory. Only the
// latest copy is retained; after the app is killed, the key mismatches, but the run page
// instructions specify opening from the record page or list, so it will never run with empty data.

let slot: { key: string; value: RunValue | HandedFiles } | null = null;
let next = 0;

export function handOver(value: RunValue | HandedFiles): string {
  const key = String(++next);
  slot = { key, value };
  return key;
}

export const readHanded = (key: string | undefined): RunValue | HandedFiles | null =>
  slot && slot.key === key ? slot.value : null;

export function dropHanded(key: string | undefined): void {
  if (slot?.key === key) slot = null;
}
