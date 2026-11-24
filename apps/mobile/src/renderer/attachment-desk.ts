import { MAX_ATTACHMENTS } from '@morph/core';

// Record attachment "Place on desk" (D-395): creates a copy of the attachment in a new desk
// (leaving the file stored in the entry untouched); upon tapping "Done" after editing on the desk,
// always prompts whether to "Add as new attachment" or "Replace original", saving the result as a
// user file and returning it to the form (saving to the entry requires the user to tap save). The
// return channel is stored strictly in memory and located by desk ID (random); it is not exposed in
// route parameters, preventing external links from smuggling files into entries.

export type DeskReturnMode = 'add' | 'replace';

export interface DeskReturn {
  /** The attachment placed on the desk. */
  assetId: string;
  /** File IDs currently in this form field; null when the form is closed. */
  ids(): readonly string[] | null;
  /** Delivers the desk results (already saved as user files) back to the form. Returns false and makes no changes if the form is already closed. */
  deliver(mode: DeskReturnMode, fresh: readonly string[]): boolean;
}

const returns = new Map<string, DeskReturn>();

/** Registers when the form opens the desk; the returned function is called when the form closes (after which the desk becomes a regular desk). */
export function holdDeskReturn(deskId: string, entry: DeskReturn): () => void {
  returns.set(deskId, entry);
  return () => {
    if (returns.get(deskId) === entry) returns.delete(deskId);
  };
}

/** Checks whether this desk originated from a record attachment (room's "Done" prompts how to return). */
export const deskReturnOf = (deskId: string): DeskReturn | undefined => returns.get(deskId);

/** Disconnects from the form after delivery. */
export function endDeskReturn(deskId: string): void {
  returns.delete(deskId);
}

/** Checks whether n files on the desk can be added as new attachments or replace the original (up to MAX_ATTACHMENTS). */
export function deskReturnChoices(
  ids: readonly string[],
  assetId: string,
  n: number,
): { add: boolean; replace: boolean } {
  return {
    add: n > 0 && ids.length + n <= MAX_ATTACHMENTS,
    replace: n > 0 && ids.includes(assetId) && ids.length - 1 + n <= MAX_ATTACHMENTS,
  };
}

/** Appends to the end or replaces the original file position (the original is removed from this field). */
export function applyDeskReturn(
  ids: readonly string[],
  assetId: string,
  mode: DeskReturnMode,
  fresh: readonly string[],
): string[] {
  if (mode === 'add') return [...ids, ...fresh];
  const at = ids.indexOf(assetId);
  if (at < 0) return [...ids, ...fresh];
  return [...ids.slice(0, at), ...fresh, ...ids.slice(at + 1)];
}
