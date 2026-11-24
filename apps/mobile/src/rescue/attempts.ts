// Counter file; reads and writes are both synchronous: in the event of an immediate crash, this
// startup is already recorded.

/** Counter file; reads and writes are both synchronous: in the event of an immediate crash, this startup is already recorded. */
export interface AttemptStore {
  read(): string | null;
  write(text: string): void;
}

export interface Attempts {
  /** Number of consecutive startup failures to reach "normal". */
  failures: number;
  /** Last error that caused the app to halt (for display on the rescue page, shared by the user). */
  lastError?: string;
}

/** Number of consecutive failures before advancing to the rescue page on the next open. */
export const RESCUE_AFTER = 2;
/** Duration the home page must display normally to consider this startup successful. */
export const HEALTHY_AFTER_MS = 5000;
const MAX_ERROR = 2000;

export function readAttempts(store: AttemptStore): Attempts {
  try {
    const raw = store.read();
    if (!raw) return { failures: 0 };
    const value = JSON.parse(raw) as { failures?: unknown; lastError?: unknown };
    const failures =
      typeof value.failures === 'number' && Number.isInteger(value.failures) && value.failures > 0
        ? value.failures
        : 0;
    return {
      failures,
      ...(typeof value.lastError === 'string' ? { lastError: value.lastError } : {}),
    };
  } catch {
    return { failures: 0 };
  }
}

function save(store: AttemptStore, attempts: Attempts) {
  try {
    store.write(JSON.stringify(attempts));
  } catch {
    // Write failure: skip counting this time and start normally.
  }
}

/** A foreground startup begins: returns prior status and pre-records this attempt as a failure (cleared when normal is reached). */
export function startAttempt(store: AttemptStore): Attempts {
  const before = readAttempts(store);
  save(store, { ...before, failures: before.failures + 1 });
  return before;
}

/** This startup reached the normal home page: reset count from zero. */
export function markHealthy(store: AttemptStore) {
  save(store, { failures: 0 });
}

/** Error text for human viewing and user sharing: message and stack trace, length-limited. */
export const errorText = (error: unknown) =>
  (error instanceof Error ? `${error.message}\n${error.stack ?? ''}`.trim() : String(error)).slice(
    0,
    MAX_ERROR,
  );

/** Record the error that caused the app to halt (called in global error handling and rescue gate error boundaries). */
export function recordFatal(store: AttemptStore, error: unknown) {
  save(store, { ...readAttempts(store), lastError: errorText(error) });
}
