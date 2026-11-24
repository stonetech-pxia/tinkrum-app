import { describe, expect, it } from 'vitest';

import { conditionProblems } from './conditions';
import { filterRecords, type DataRecord } from './data';
import { ConditionSchema, type Collection } from './schema';

// D-538: A single-select field "is one of" (is with 2–8 options). Does not cross fields, non-nested.

const tasks: Collection = {
  id: 'tasks',
  name: 'Tasks',
  fields: [
    { id: 'title', name: 'Title', type: 'text' },
    {
      id: 'status',
      name: 'Status',
      type: 'choice',
      options: [
        { id: 'todo', label: 'To do' },
        { id: 'doing', label: 'Doing' },
        { id: 'done', label: 'Done' },
      ],
    },
    { id: 'tags', name: 'Tags', type: 'tags' },
    { id: 'n', name: 'N', type: 'number' },
  ],
};
const rec = (id: string, status?: string): DataRecord => ({
  id,
  collectionId: 'tasks',
  values: status ? { status } : {},
  createdAt: 0,
  updatedAt: 0,
});

describe('is any of on a choice field (D-538)', () => {
  it('matches records whose option is one of the list', () => {
    const records = [rec('a', 'todo'), rec('b', 'doing'), rec('c', 'done'), rec('d')];
    const ids = filterRecords(
      records,
      tasks,
      [{ field: 'status', op: 'is', value: ['todo', 'doing'] }],
      new Date(2026, 10, 14),
    ).map((r) => r.id);
    expect(ids).toEqual(['a', 'b']);
  });

  it('validates: choice field, is only, known options', () => {
    const p = (field: string, op: 'is' | 'isNot' | 'contains', value: string[]) =>
      conditionProblems([{ field, op, value }], tasks);
    expect(p('status', 'is', ['todo', 'doing'])).toEqual([]);
    expect(p('status', 'is', ['todo', 'nope'])).not.toEqual([]);
    expect(p('status', 'isNot', ['todo', 'doing'])).not.toEqual([]);
    expect(p('title', 'is', ['a', 'b'])).not.toEqual([]);
    expect(p('title', 'contains', ['a', 'b'])).not.toEqual([]);
    // Tag names are record content and cannot be written by the AI (only isEmpty / isNotEmpty allowed).
    expect(p('tags', 'is', ['a', 'b'])).not.toEqual([]);
  });

  it('takes 2 to 8 values', () => {
    const ok = (value: string[]) =>
      ConditionSchema.safeParse({ field: 'status', op: 'is', value }).success;
    expect(ok(['a'])).toBe(false);
    expect(ok(['a', 'b'])).toBe(true);
    expect(ok(['1', '2', '3', '4', '5', '6', '7', '8'])).toBe(true);
    expect(ok(['1', '2', '3', '4', '5', '6', '7', '8', '9'])).toBe(false);
  });
});
