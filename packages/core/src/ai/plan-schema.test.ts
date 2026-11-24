import { describe, expect, it } from 'vitest';

import { PlanSchema } from './types';

// An explanation text that is too long should not invalidate the entire legal change (D14): truncate it, and keep other restrictions as they are.

const ops = [{ op: 'setTheme', mode: 'dark' }];
const parse = (extra: object) => PlanSchema.safeParse({ kind: 'ops', ops, ...extra });

describe('PlanSchema notes', () => {
  it('a note over 200 characters is cut, the plan stays', () => {
    const r = parse({ notes: ['短的', '长'.repeat(201)] });
    expect(r.success).toBe(true);
    if (r.success && r.data.kind === 'ops') {
      expect(r.data.notes![0]).toBe('短的');
      expect(r.data.notes![1]).toBe('长'.repeat(200));
    }
  });

  it('cutting does not leave half an emoji', () => {
    const r = parse({ notes: ['a'.repeat(199) + '😀'] });
    if (!r.success || r.data.kind !== 'ops') throw new Error('expected a plan');
    expect(r.data.notes![0]).toBe('a'.repeat(199));
  });

  it('a note at the limit is untouched; an empty one is still refused', () => {
    const r = parse({ notes: ['x'.repeat(200)] });
    if (!r.success || r.data.kind !== 'ops') throw new Error('expected a plan');
    expect(r.data.notes![0]).toHaveLength(200);
    expect(parse({ notes: [''] }).success).toBe(false);
  });
});

describe('build plan (rule 53)', () => {
  const steps = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `s${i}`,
      kind: 'record',
      title: `第 ${i} 步`,
      request: `做第 ${i} 件事`,
    }));
  const build = (over: object = {}) => ({
    kind: 'build',
    summary: '一个 App',
    steps: steps(2),
    ...over,
  });

  it('2 to 8 steps, valid kinds, request is not empty', () => {
    expect(PlanSchema.safeParse(build()).success).toBe(true);
    expect(PlanSchema.safeParse(build({ steps: steps(8) })).success).toBe(true);
    expect(PlanSchema.safeParse(build({ steps: steps(1) })).success).toBe(false);
    expect(PlanSchema.safeParse(build({ steps: steps(9) })).success).toBe(false);
    expect(
      PlanSchema.safeParse(build({ steps: [{ ...steps(1)[0], kind: 'run' }, steps(2)[1]] }))
        .success,
    ).toBe(false);
    expect(
      PlanSchema.safeParse(build({ steps: [{ ...steps(1)[0], request: '  ' }, steps(2)[1]] }))
        .success,
    ).toBe(false);
  });

  it('Step IDs cannot be duplicated or carry operations: the plan is text only (invariant 6)', () => {
    expect(PlanSchema.safeParse(build({ steps: [steps(1)[0], steps(1)[0]] })).success).toBe(false);
    expect(
      PlanSchema.safeParse(build({ steps: [{ ...steps(1)[0], ops: [] }, steps(2)[1]] })).success,
    ).toBe(false);
    expect(PlanSchema.safeParse(build({ ops: [] })).success).toBe(false);
  });
});
