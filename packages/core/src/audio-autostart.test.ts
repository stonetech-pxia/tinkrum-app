import { describe, expect, it } from 'vitest';

import { registry } from './test-helpers';

// autoStart for recording steps (D-587): only meaningful when recording now; omitting it behaves as before.

const params = (p: Record<string, unknown>) =>
  registry.actions.get('in.audio')!.params.safeParse(p);

describe('in.audio autoStart (D-587)', () => {
  it('accepts it when recording now', () => {
    expect(params({ source: 'record', min: 1, max: 1, autoStart: true }).success).toBe(true);
    expect(params({ source: 'record', min: 1, max: 1, autoStart: false }).success).toBe(true);
  });

  it('is optional: the old way of writing the step still works', () => {
    expect(params({ source: 'record', min: 1, max: 1 }).success).toBe(true);
    expect(params({ source: 'files', min: 1, max: 10 }).success).toBe(true);
  });

  it('refuses it when the audio comes from files, and a value that is not true or false', () => {
    expect(params({ source: 'files', min: 1, max: 10, autoStart: true }).success).toBe(false);
    expect(params({ source: 'record', min: 1, max: 1, autoStart: 'yes' }).success).toBe(false);
  });
});
