import { describe, expect, it } from 'vitest';
import { RecordSourceSchema } from './components/records';

// Observed (v34 eval P10, TD17-en): models sometimes omit limit, causing the entire response to be rejected. Defaults to standard list limit of 30 items when omitted.
describe('RecordSourceSchema limit', () => {
  it('defaults to 30 when the AI leaves it out', () => {
    const parsed = RecordSourceSchema.safeParse({ table: 'books' });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.limit).toBe(30);
  });

  it('still rejects a limit outside 1–100', () => {
    expect(RecordSourceSchema.safeParse({ table: 'books', limit: 0 }).success).toBe(false);
    expect(RecordSourceSchema.safeParse({ table: 'books', limit: 101 }).success).toBe(false);
  });
});
