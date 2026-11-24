import { describe, expect, it } from 'vitest';

import { describeChange } from './describe';
import type { BlockChanges, Op } from './ops-schema';
import type { Locale, WorkspaceConfig } from './schema';
import { apply, registry, workspace } from './test-helpers';

// Draft description states what the user says: fields use field names, without exposing internal keys and IDs (walkthrough REPORT3 item 4).

const setup: Op[] = [
  {
    op: 'addData',
    table: {
      id: 'tasks',
      name: '任务',
      fields: [
        { id: 'title', name: '标题', type: 'text', required: true },
        { id: 'project', name: '项目', type: 'text' },
        {
          id: 'priority',
          name: '优先级',
          type: 'choice',
          options: [{ id: 'high', label: '高' }],
        },
        { id: 'notes', name: '备注', type: 'note' },
        { id: 'due', name: '到期', type: 'date' },
        { id: 'cost', name: '费用', type: 'number' },
      ],
    },
  },
  {
    op: 'addContainer',
    page: 'home',
    block: {
      id: 'list1',
      look: 'list',
      source: { table: 'tasks', limit: 30 },
      show: { title: 'title' },
    },
  },
  {
    op: 'addContainer',
    page: 'home',
    block: {
      id: 'form1',
      look: 'form',
      show: { mode: 'inline' },
      tools: [{ as: 'submit', label: '添加', do: 'create', table: 'tasks', ask: ['title'] }],
    },
  },
  {
    op: 'addContainer',
    page: 'home',
    block: {
      id: 'stat1',
      look: 'number',
      show: { label: '总数' },
      source: { table: 'tasks', aggregate: 'count' },
    },
  },
];

const base = (locale: Locale): WorkspaceConfig => apply(workspace(locale), setup, locale);

const lines = (block: string, changes: BlockChanges, locale: Locale = 'zh') =>
  describeChange(
    [{ op: 'updateContainer', page: 'home', block, changes } as Op],
    base(locale),
    [],
    { registry, locale, now: new Date(2026, 10, 4) },
  );

describe('Display of record list (fields use field names)', () => {
  it('Right-side display', () => {
    expect(lines('list1', { show: { trailing: 'priority' } })).toEqual([
      '修改「任务」的记录列表：右侧显示「优先级」',
    ]);
    expect(lines('list1', { show: { trailing: null } })[0]).toContain('右侧不再显示');
  });

  it('Title, subtitle, format, empty state prompt', () => {
    expect(lines('list1', { show: { title: 'project' } })[0]).toContain('每条的标题显示「项目」');
    expect(lines('list1', { show: { subtitles: ['project', 'due'] } })[0]).toContain('项目、到期');
    expect(
      lines('list1', { show: { trailing: 'cost', format: { kind: 'progress', goal: 10 } } })[0],
    ).toContain('右侧显示进度');
    expect(lines('list1', { show: { emptyText: '还没有任务' } })[0]).toContain(
      '没有内容时显示「还没有任务」',
    );
  });

  it('System fields also speak human language', () => {
    expect(lines('list1', { show: { trailing: 'createdAt' } })[0]).toContain(
      '右侧显示「添加时间」',
    );
  });

  it('What to read: sorting, limit, filters, grouping', () => {
    const line = lines('list1', {
      source: {
        sort: { field: 'due', direction: 'desc' },
        limit: 5,
        group: { by: 'priority' },
      },
    })[0]!;
    expect(line).toContain('按「到期」');
    expect(line).toContain('最多显示 5 条');
    expect(line).toContain('按「优先级」分组');
  });
});

describe('How tools are modified', () => {
  it('What forms ask: specify which fields to ask for, without saying "one-tap button"', () => {
    const [line] = lines('form1', {
      tools: [
        {
          as: 'submit',
          label: '添加',
          do: 'create',
          table: 'tasks',
          ask: ['title', 'project', 'priority', 'notes'],
        },
      ],
    });
    expect(line).toBe('修改「任务」的添加表单：问「标题、项目、优先级、备注」');
  });

  it('Adding checkboxes and buttons to the list', () => {
    const [line] = lines('list1', {
      tools: [
        { as: 'check', do: 'toggle', table: 'tasks', field: 'priority' },
        {
          as: 'button',
          label: '完成',
          do: 'set',
          table: 'tasks',
          field: 'priority',
          value: 'high',
        },
      ],
    });
    expect(line).toContain('勾选');
    expect(line).toContain('按钮「完成」');
    expect(line).not.toContain('一键按钮');
  });
});

describe('Guard: Descriptions of common modifications contain no internal key names or IDs', () => {
  const common: [string, BlockChanges][] = [
    ['list1', { show: { title: 'project' } }],
    ['list1', { show: { subtitles: ['project', 'due'] } }],
    ['list1', { show: { subtitles: null } }],
    ['list1', { show: { trailing: 'priority' } }],
    ['list1', { show: { trailing: null } }],
    ['list1', { show: { format: { kind: 'elapsed' } } }],
    ['list1', { show: { format: null } }],
    ['list1', { show: { color: 'priority' } }],
    ['list1', { show: { emptyText: null } }],
    ['list1', { source: { table: 'tasks' } }],
    ['list1', { source: { sort: { field: 'due', direction: 'asc' } } }],
    ['list1', { source: { sort: null } }],
    ['list1', { source: { limit: 1 } }],
    ['list1', { source: { filter: [{ field: 'priority', op: 'eq', value: 'high' }] } }],
    ['list1', { source: { filter: null } }],
    ['list1', { source: { group: { by: 'priority' } } }],
    ['list1', { source: { group: null } }],
    ['list1', { tools: [{ as: 'check', do: 'toggle', table: 'tasks', field: 'priority' }] }],
    ['list1', { tools: null }],
    ['list1', { opens: 'home' }],
    ['form1', { show: { mode: 'sheet' } }],
    ['form1', { tools: [{ as: 'submit', do: 'create', table: 'tasks', ask: ['project'] }] }],
    [
      'form1',
      {
        tools: [
          {
            as: 'submit',
            label: '记一笔',
            do: 'create',
            table: 'tasks',
            ask: ['title'],
            smartDate: { from: 'title', to: 'due' },
          },
        ],
      },
    ],
    ['stat1', { source: { aggregate: 'sum', field: 'cost' } }],
    ['stat1', { source: { goal: 10, compare: 'previous' } }],
  ];
  // Words like goal and group are normal in English and French; only check for key names and IDs that would not occur naturally.
  const KEYS =
    /\b(trailing|subtitles|emptyText|aggregate|priority|project|tasks|list1|form1|stat1|smartDate)\b/;

  for (const [block, changes] of common) {
    it(`${block} ${JSON.stringify(changes).slice(0, 70)}`, () => {
      for (const locale of ['zh', 'en', 'fr'] as const) {
        const [line] = lines(block, changes, locale);
        expect(line, locale).toBeTruthy();
        // Chinese descriptions should not contain any English words.
        expect(line, locale).not.toMatch(KEYS);
        if (locale === 'zh') expect(line).not.toMatch(/[A-Za-z]{3,}/);
        expect(line, locale).not.toMatch(/[{}[\]]/);
      }
    });
  }
});
