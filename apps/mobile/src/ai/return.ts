import type { HandoffScope } from '@morph/core';
import { create } from 'zustand';

/**
 * The "waiting for AI result" flag (system guide, excluded from config or user database). Reading
 * and expiration write nothing; a small file is written only when the user taps share,
 * successfully imports, or dismisses the card (stored outside the database like the startup
 * counter, serving as the app's internal bookkeeping, D-621). On Android, if the Tinkrum process
 * is killed while visiting other apps, this card remains upon return.
 */
export const AI_RETURN_TTL = 24 * 60 * 60 * 1000;
export type AiReturn = { id: number; scope: HandoffScope['kind']; at: number };

/** Flag file; reads and writes are both synchronous, and read/write failures are treated as no flag, never disrupting usage. */
export interface ReturnStore {
  read(): string | null;
  write(text: string): void;
}

const SCOPES: readonly HandoffScope['kind'][] = ['new', 'app', 'setup'];
let sequence = 0;
let backing: ReturnStore | null = null;

function save(value: AiReturn | null) {
  try {
    backing?.write(JSON.stringify(value));
  } catch {
    // If writing fails: skipped for now, and the card remains visible in memory.
  }
}

function load(store: ReturnStore): AiReturn | null {
  try {
    const raw = store.read();
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<AiReturn> | null;
    if (
      v &&
      typeof v.id === 'number' &&
      Number.isInteger(v.id) &&
      typeof v.at === 'number' &&
      Number.isFinite(v.at) &&
      SCOPES.includes(v.scope as HandoffScope['kind'])
    )
      return { id: v.id, scope: v.scope as HandoffScope['kind'], at: v.at };
  } catch {
    // Corrupted files are treated as none.
  }
  return null;
}

export const useAiReturn = create<{
  pending: AiReturn | null;
  start(scope: HandoffScope['kind'], now?: number): AiReturn;
  dismiss(id?: number): void;
  /** Returns the restoration of a flag: rolls back the previous one if sharing fails. */
  restore(previous: AiReturn | null): void;
}>((set, get) => ({
  pending: null,
  start(scope, now = Date.now()) {
    const pending = { id: ++sequence, scope, at: now };
    set({ pending });
    save(pending);
    return pending;
  },
  dismiss(id) {
    // When a previously shared import finishes, it does not close the card of another subsequent sharing round.
    if (id !== undefined && get().pending?.id === id) {
      set({ pending: null });
      save(null);
    }
  },
  restore(previous) {
    set({ pending: previous });
    save(previous);
  },
}));

/** Attaches the flag file at startup: reads whatever was left last time (read-only, no write). Does not overwrite if a new flag already exists. */
export function attachReturnStore(store: ReturnStore, now = Date.now()) {
  backing = store;
  const loaded = load(store);
  if (!loaded || !aiReturnIsActive(loaded, now)) return;
  sequence = Math.max(sequence, loaded.id);
  if (!useAiReturn.getState().pending) useAiReturn.setState({ pending: loaded });
}

export const aiReturnIsActive = (pending: AiReturn | null, now = Date.now()) =>
  pending !== null && now >= pending.at && now - pending.at < AI_RETURN_TTL;
