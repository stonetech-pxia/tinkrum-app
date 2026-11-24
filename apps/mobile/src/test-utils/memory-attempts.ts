import type { AttemptStore } from '../rescue/attempts';

/** Startup counter file for testing; throws errors on both read and write when broken (simulating disk issues). */
export class MemoryAttemptStore implements AttemptStore {
  text: string | null = null;
  broken = false;
  constructor(initial?: { failures: number; lastError?: string }) {
    if (initial) this.text = JSON.stringify(initial);
  }
  read() {
    if (this.broken) throw new Error('disk');
    return this.text;
  }
  write(text: string) {
    if (this.broken) throw new Error('disk');
    this.text = text;
  }
}
