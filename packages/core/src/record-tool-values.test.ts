import { describe, expect, it } from 'vitest';

import { prepareOps } from './change';
import { reminderDoneInput } from './reminders';
import { computeRecords, expandCollection } from './related';
import type { DataRecord } from './data';
import { usesOf } from './file-uses';
import {
  RecordToolValueSchema,
  ToolUseSchema,
  createInput,
  rowUpdateInput,
  toolReadsEntry,
  type RecordTool,
} from './record-ops';
import type { Collection, WorkspaceConfig } from './schema';
import { fromV33, registry, v33Fixture } from './test-helpers';
import { validateWorkspace } from './validate';

// 一键记录工具能写的值（D-565）：从今天或这一条的日期起加减几天、几个月；抄这一条的一个字段；
// increment 加这一条的一个数字字段。配置里只有引用，没有内容（底线 14），AI 看不到值（底线 2）。
process.env.TZ = 'Europe/Paris';

const now = new Date(2026, 0, 31, 18, 5); // 2026-01-31

const cards: Collection = {
  id: 'cards',
  name: 'Cards',
  fields: [
    { id: 'front', name: 'Front', type: 'text' },
    { id: 'due', name: 'Due', type: 'date' },
    { id: 'interval', name: 'Interval', type: 'number' },
    { id: 'seen', name: 'Seen', type: 'datetime' },
    { id: 'score', name: 'Score', type: 'number' },
    { id: 'level', name: 'Level', type: 'choice', options: [{ id: 'new', label: 'New' }] },
  ],
};
const products: Collection = {
  id: 'products',
  name: 'Products',
  fields: [
    { id: 'name', name: 'Name', type: 'text' },
    { id: 'price', name: 'Price', type: 'money', currency: 'EUR' },
    { id: 'qty', name: 'Usual qty', type: 'number' },
    { id: 'gross', name: 'Gross', type: 'formula', expression: '{price} * 1.2' },
    { id: 'photo', name: 'Photo', type: 'file' },
  ],
};
const orders: Collection = {
  id: 'orders',
  name: 'Orders',
  fields: [
    { id: 'product', name: 'Product', type: 'link', table: 'products' },
    { id: 'what', name: 'What', type: 'note' },
    { id: 'price', name: 'Price', type: 'money', currency: 'EUR' },
    { id: 'qty', name: 'Qty', type: 'number' },
    { id: 'on', name: 'On', type: 'date' },
    { id: 'photo', name: 'Photo', type: 'file' },
    { id: 'gross', name: 'Gross', type: 'formula', expression: '{price} * 1.2' },
  ],
};

const base = (): WorkspaceConfig => {
  const config = fromV33(v33Fixture('default-en'));
  config.data.tables.push(...structuredClone([cards, products, orders]));
  config.containers.pages.push({ id: 'product', title: 'Product', of: 'products', blocks: [] });
  return config;
};

const list = (table: string, tools: unknown[], id = 'l1') => ({
  id,
  look: 'list',
  source: { table, limit: 30 },
  show: { title: 'createdAt' },
  tools,
});
const button = (tool: unknown, id = 'b1') => ({
  id,
  look: 'button',
  show: { label: 'Go', variant: 'filled' },
  tools: [tool],
});
function problems(blocks: unknown[], pageId = 'home', config = base()): string {
  const copy = structuredClone(config);
  copy.containers.pages.find((p) => p.id === pageId)!.blocks.push(...(blocks as never[]));
  const r = validateWorkspace(copy, registry);
  return r.ok ? '' : r.issues.map((i) => i.message).join('\n');
}
const rowButton = (tool: Record<string, unknown>) => ({ as: 'button', label: 'Go', ...tool });

describe('values relative to today or to this entry (D-565)', () => {
  it('has the same {from, add, unit} form as a computed date, and {copy}', () => {
    for (const v of [
      { from: 'today', add: 7, unit: 'days' },
      { from: 'due', add: 'interval', unit: 'days' },
      { from: 'today', add: -1, unit: 'months' },
      { copy: 'price' },
    ])
      expect(RecordToolValueSchema.safeParse(v).success).toBe(true);
    for (const v of [
      { from: 'today', add: 1.5, unit: 'days' },
      { from: 'today', add: 7, unit: 'weeks' },
      { from: 'today', add: 7, unit: 'days', extra: 1 },
      { copy: 'price', of: 'x' },
      { copy: 'Some words!' },
    ])
      expect(RecordToolValueSchema.safeParse(v).success).toBe(false);
    expect(
      ToolUseSchema.safeParse({ do: 'increment', table: 'cards', field: 'score', by: 'interval' })
        .success,
    ).toBe(true);
  });

  it('accepts snooze, renew, next review, log again and order at today’s price', () => {
    expect(
      problems([
        list('cards', [
          rowButton({
            do: 'set',
            table: 'cards',
            field: 'due',
            value: { from: 'today', add: 7, unit: 'days' },
          }),
          rowButton({
            do: 'set',
            table: 'cards',
            field: 'due',
            value: { from: 'due', add: 12, unit: 'months' },
          }),
          rowButton({
            do: 'set',
            table: 'cards',
            field: 'due',
            value: { from: 'today', add: 'interval', unit: 'days' },
          }),
        ]),
        list(
          'products',
          [
            rowButton({
              do: 'create',
              table: 'orders',
              values: {
                product: '$row',
                price: { copy: 'price' },
                qty: { copy: 'qty' },
                what: { copy: 'name' },
              },
            }),
          ],
          'l2',
        ),
        list(
          'orders',
          [
            rowButton({
              do: 'create',
              table: 'orders',
              values: { product: { copy: 'product' }, price: { copy: 'gross' } },
            }),
          ],
          'l3',
        ),
        list(
          'cards',
          [rowButton({ do: 'increment', table: 'cards', field: 'score', by: 'interval' })],
          'l4',
        ),
        // 一个按钮不作用在某一条上：只能从今天算。
        button({
          do: 'create',
          table: 'orders',
          values: { on: { from: 'today', add: 1, unit: 'days' } },
        }),
      ]),
    ).toBe('');
    // 一条记录的页面上，按钮可以抄这一条（"$record"）。
    expect(
      problems(
        [
          button({
            do: 'create',
            table: 'orders',
            values: { product: '$record', price: { copy: 'price' } },
          }),
        ],
        'product',
      ),
    ).toBe('');
  });

  it('a date value only fills a date field, from today or a date of this entry, adding a whole number or a number field', () => {
    const set = (value: unknown, field = 'due') =>
      problems([list('cards', [rowButton({ do: 'set', table: 'cards', field, value })])]);
    expect(set({ from: 'today', add: 1, unit: 'days' }, 'score')).toMatch(
      /cards\.score is a number field.*\{from, add, unit\} only fills a date field/,
    );
    expect(set({ from: 'front', add: 1, unit: 'days' })).toMatch(
      /from front must be "today" or a date or datetime field of this entry/,
    );
    expect(set({ from: 'today', add: 'level', unit: 'days' })).toMatch(
      /add level must be a whole number or a number field of this entry/,
    );
    expect(set({ from: 'seen', add: 1, unit: 'days' })).toBe('');
  });

  it('a copy needs this entry, and a field whose kind fits', () => {
    // 首页的按钮没有「这一条」。
    expect(
      problems([button({ do: 'create', table: 'orders', values: { price: { copy: 'price' } } })]),
    ).toMatch(/\{copy\} reads a field of this entry/);
    // setAll 改的是很多条，也没有「这一条」；从今天算的日期可以。
    expect(
      problems([
        button({
          do: 'setAll',
          table: 'cards',
          field: 'due',
          value: { from: 'due', add: 1, unit: 'days' },
        }),
      ]),
    ).toMatch(/needs this entry/);
    expect(
      problems([
        button({
          do: 'setAll',
          table: 'cards',
          field: 'due',
          value: { from: 'today', add: 1, unit: 'days' },
        }),
      ]),
    ).toBe('');
    const order = (values: Record<string, unknown>) =>
      problems([
        list('products', [
          rowButton({ do: 'create', table: 'orders', values: { product: '$row', ...values } }),
        ]),
      ]);
    expect(order({ qty: { copy: 'name' } })).toMatch(
      /can't copy products\.name \(text\) into orders\.qty \(number\)/,
    );
    expect(order({ price: { copy: 'nope' } })).toMatch(/nope is not a field of products/);
    // 算出来的字段可以抄出来（下单时的价格就定住了），不能抄进去；文件不抄（底线 3）。
    expect(order({ gross: { copy: 'price' } })).toMatch(/orders\.gross is a formula field/);
    expect(order({ photo: { copy: 'photo' } })).toMatch(/orders\.photo is a file field/);
    expect(order({ price: { copy: 'gross' } })).toBe('');
    // 不同表的引用不能抄。
    expect(
      problems([
        list('orders', [
          rowButton({ do: 'create', table: 'orders', values: { product: { copy: 'what' } } }),
        ]),
      ]),
    ).toMatch(/can't copy/);
  });

  it('increment by a field takes a number field of this entry', () => {
    const inc = (by: unknown) =>
      problems([
        list('cards', [rowButton({ do: 'increment', table: 'cards', field: 'score', by })]),
      ]);
    expect(inc('front')).toMatch(/by front must be a number field of cards/);
    expect(inc('interval')).toBe('');
  });

  it('a reminder’s done may use them: it acts on this entry', () => {
    const config = base();
    config.data.tables
      .find((t) => t.id === 'cards')!
      .fields.push({
        id: 'plan',
        name: 'Plan',
        type: 'schedule',
        lastDone: 'due',
      } as never);
    config.tools.push({
      id: 'r',
      kind: 'reminder',
      title: 'Review',
      enabled: true,
      when: { each: { table: 'cards', field: 'plan' }, at: '09:00' },
      opens: 'page:home',
      done: {
        do: 'set',
        table: 'cards',
        field: 'due',
        value: { from: 'today', add: 'interval', unit: 'days' },
      },
    } as never);
    const r = validateWorkspace(config, registry);
    expect(r.ok ? '' : r.issues.map((i) => i.message).join('\n')).toBe('');
  });
});

describe('running them', () => {
  const card: DataRecord = {
    id: 'c1',
    collectionId: 'cards',
    values: { due: '2026-01-31', interval: 3, score: 2 },
    createdAt: now.getTime(),
    updatedAt: now.getTime(),
  };
  const entry = { record: card, view: cards };

  it('today or a date of this entry, plus days or months; a month end clamps', () => {
    const set = (value: unknown) =>
      rowUpdateInput(
        { do: 'set', table: 'cards', field: 'due', value } as never,
        cards,
        card.values,
        {
          now,
          entry,
        },
      );
    expect(set({ from: 'today', add: 7, unit: 'days' })).toEqual({ due: '2026-02-07' });
    expect(set({ from: 'today', add: 1, unit: 'months' })).toEqual({ due: '2026-02-28' });
    expect(set({ from: 'due', add: -1, unit: 'months' })).toEqual({ due: '2025-12-31' });
    expect(set({ from: 'today', add: 'interval', unit: 'days' })).toEqual({ due: '2026-02-03' });
    // 起点或加数没有值：这一项不写。
    expect(set({ from: 'seen', add: 1, unit: 'days' })).toEqual({});
  });

  it('a copy is taken from this entry when tapped, computed fields included', () => {
    const tables = [products, orders];
    const product: DataRecord = {
      id: 'p1',
      collectionId: 'products',
      values: { name: 'Coffee beans', price: 12.5, qty: 2 },
      createdAt: 0,
      updatedAt: 0,
    };
    const [computed] = computeRecords(tables, 'products', new Map([['products', [product]]]), now);
    const input = createInput(
      orders,
      { product: '$row', price: { copy: 'gross' }, qty: { copy: 'qty' }, what: { copy: 'name' } },
      { now, rowId: 'p1', entry: { record: computed!, view: expandCollection(tables, products) } },
    );
    expect(input).toEqual({ product: 'p1', price: 15, qty: 2, what: 'Coffee beans' });
    // 没有「这一条」（不该发生，检查会拦）：这一项不写。
    expect(createInput(orders, { price: { copy: 'price' } }, { now })).toEqual({});
  });

  it('increment by a number field of this entry', () => {
    const tool = { do: 'increment', table: 'cards', field: 'score', by: 'interval' } as RecordTool;
    expect(rowUpdateInput(tool as never, cards, card.values, { now, entry })).toEqual({ score: 5 });
  });

  it('a reminder’s done reads this entry too', () => {
    const config = base();
    const done = {
      do: 'set',
      table: 'cards',
      field: 'due',
      value: { from: 'today', add: 'interval', unit: 'days' },
    } as RecordTool;
    expect(reminderDoneInput(done, config, cards, card, now)).toEqual({
      kind: 'update',
      input: { due: '2026-02-03' },
    });
  });

  it('the app knows which tools read this entry', () => {
    expect(toolReadsEntry({ do: 'set', table: 'cards', field: 'due', value: 'today' })).toBe(false);
    expect(
      toolReadsEntry({
        do: 'set',
        table: 'cards',
        field: 'due',
        value: { from: 'today', add: 1, unit: 'days' },
      }),
    ).toBe(false);
    expect(
      toolReadsEntry({
        do: 'set',
        table: 'cards',
        field: 'due',
        value: { from: 'due', add: 1, unit: 'days' },
      }),
    ).toBe(true);
    expect(
      toolReadsEntry({ do: 'create', table: 'orders', values: { price: { copy: 'price' } } }),
    ).toBe(true);
    expect(
      toolReadsEntry({ do: 'increment', table: 'cards', field: 'score', by: 'interval' }),
    ).toBe(true);
  });
});

describe('deleting what a value reads (invariant 18)', () => {
  it('removing a field a copy or a date reads removes the tool with it', () => {
    const config = base();
    config.containers.pages
      .find((p) => p.id === 'home')!
      .blocks.push(
        list('products', [
          rowButton({
            do: 'create',
            table: 'orders',
            values: { product: '$row', what: { copy: 'name' } },
          }),
        ]) as never,
        list(
          'cards',
          [
            rowButton({
              do: 'set',
              table: 'cards',
              field: 'due',
              value: { from: 'today', add: 'interval', unit: 'days' },
            }),
          ],
          'l2',
        ) as never,
      );
    config.containers.pages
      .find((p) => p.id === 'product')!
      .blocks.push(
        button({
          do: 'create',
          table: 'orders',
          values: { product: '$record', qty: { copy: 'qty' } },
        }) as never,
      );
    expect(validateWorkspace(config, registry).ok).toBe(true);
    const ctx = { registry, locale: 'en' as const, now };
    for (const [table, field, block, page] of [
      ['products', 'name', 'l1', 'home'],
      ['cards', 'interval', 'l2', 'home'],
      ['products', 'qty', 'b1', 'product'],
    ] as const) {
      const r = prepareOps(config, [{ op: 'removeData', table, field } as never], ctx);
      expect(r.ok, `${table}.${field}`).toBe(true);
      if (!r.ok) continue;
      const blocks = r.after.containers.pages.find((p) => p.id === page)!.blocks;
      const b = blocks.find((x) => x.id === block) as { tools?: unknown[] } | undefined;
      expect(b?.tools ?? [], `${table}.${field}`).toEqual([]);
    }
  });
});

describe('an exported file lists them (D-556)', () => {
  it('marks the new value forms and increment by a field', () => {
    const config = base();
    config.containers.pages
      .find((p) => p.id === 'home')!
      .blocks.push(
        list('cards', [
          rowButton({
            do: 'set',
            table: 'cards',
            field: 'due',
            value: { from: 'today', add: 7, unit: 'days' },
          }),
        ]) as never,
      );
    expect(usesOf(config).features).toContain('recordToolDateValue');
    const copy = base();
    copy.containers.pages
      .find((p) => p.id === 'home')!
      .blocks.push(
        list('products', [
          rowButton({
            do: 'create',
            table: 'orders',
            values: { product: '$row', price: { copy: 'price' } },
          }),
        ]) as never,
      );
    expect(usesOf(copy).features).toContain('recordToolCopyValue');
    const by = base();
    by.containers.pages
      .find((p) => p.id === 'home')!
      .blocks.push(
        list('cards', [
          rowButton({ do: 'increment', table: 'cards', field: 'score', by: 'interval' }),
        ]) as never,
      );
    expect(usesOf(by).features).toContain('incrementByField');
    expect(usesOf(base()).features ?? []).not.toContain('recordToolCopyValue');
  });
});
