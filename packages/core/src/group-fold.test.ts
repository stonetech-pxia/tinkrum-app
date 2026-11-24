import { describe, expect, it } from 'vitest';

import { prepareOps } from './change';
import type { Op } from './ops';
import { registry, workspace } from './test-helpers';

// Groupings can be collapsed (D-578): show.fold turns the group title into a clickable header that
// collapses or expands the blocks inside when tapped; its value represents the initial state. This
// is purely a display preference (invariant 15) and does not modify data, so collapsed states are
// not persisted.

const ctx = { registry, locale: 'en' as const, now: new Date(2026, 10, 17) };
const text = { id: 't', look: 'text', show: { text: 'hello' } };
const group = (show: Record<string, unknown>) => ({
  id: 'g',
  look: 'group',
  show,
  children: [text],
});
const add = (block: unknown) =>
  prepareOps(workspace('en'), [{ op: 'addContainer', page: 'home', block } as Op], ctx);
const problems = (block: unknown) => {
  const r = add(block);
  return r.ok ? [] : r.issues.map(String);
};

describe('a group that can be folded (D-578)', () => {
  it('accepts fold closed or open on a group that has a title', () => {
    expect(problems(group({ title: 'Subscriptions', layout: 'stack', fold: 'closed' }))).toEqual(
      [],
    );
    expect(problems(group({ title: 'Everyday', layout: 'stack', fold: 'open' }))).toEqual([]);
  });

  it('accepts it on the group inside a group too', () => {
    const outer = {
      id: 'o',
      look: 'group',
      show: { layout: 'stack' },
      children: [
        {
          id: 'i',
          look: 'group',
          show: { title: 'More', layout: 'stack', fold: 'closed' },
          children: [text],
        },
      ],
    };
    expect(problems(outer)).toEqual([]);
  });

  it('refuses fold on a group without a title, because there is nothing to tap', () => {
    expect(problems(group({ layout: 'stack', fold: 'closed' })).join()).toMatch(/fold.*title/i);
  });

  it('refuses any other value', () => {
    expect(problems(group({ title: 'x', layout: 'stack', fold: 'maybe' })).join()).not.toBe('');
  });

  it('leaves a group without fold exactly as before', () => {
    expect(problems(group({ title: 'x', layout: 'stack' }))).toEqual([]);
    expect(problems(group({ layout: 'row' }))).toEqual([]);
  });
});
