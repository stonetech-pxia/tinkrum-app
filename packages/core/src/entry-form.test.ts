import { describe, expect, it } from 'vitest';

import { prepareRecordValues, readValue } from './data';
import { createDefaultWorkspace } from './defaults';
import { describeChange } from './describe';
import { formInput, formSections, visibleFormSections } from './entry-form';
import { usesOf } from './file-uses';
import { applyOps, type Op } from './ops';
import { FieldSchema, fieldDefinition, type Collection, type WorkspaceConfig } from './schema';
import { registry } from './test-helpers';
import { validateWorkspace } from './validate';

// D-570 (Founder decision 2026-11-16 ①): Delegated entry form configuration, restricting it to four
// features: sections, conditional display (evaluating only the current record's own fields),
// field-level hints, and numeric ranges. Saving, deletion, attachments, and candidate values remain
// core responsibilities.

const NOW = new Date(2026, 10, 16, 12);

const orders: Collection = {
  id: 'orders',
  name: 'Orders',
  fields: [
    { id: 'item', name: 'Item', type: 'text', required: true },
    { id: 'qty', name: 'Quantity', type: 'number', min: 1 },
    { id: 'price', name: 'Price', type: 'money', currency: 'EUR', max: 10_000 },
    { id: 'invoice', name: 'Needs invoice', type: 'checkbox' },
    {
      id: 'tax-no',
      name: 'Tax number',
      type: 'text',
      required: true,
      hint: '15 or 18 characters',
    },
    { id: 'company', name: 'Company', type: 'text' },
    { id: 'note', name: 'Note', type: 'note' },
    { id: 'packing', name: 'Packing time', type: 'duration', max: 120 },
  ],
  form: {
    sections: [
      { title: 'Order', fields: ['item', 'qty', 'price', 'invoice'] },
      {
        title: 'Invoice',
        fields: ['tax-no', 'company'],
        when: [{ field: 'invoice', op: 'is', value: true }],
      },
    ],
  },
};

const build = (...ops: Op[]): WorkspaceConfig => {
  const result = applyOps(createDefaultWorkspace('en'), ops, { registry, locale: 'en' });
  if (!result.ok) throw new Error(result.error);
  return result.config;
};
const problems = (table: Collection) => {
  const result = applyOps(createDefaultWorkspace('en'), [{ op: 'addData', table }], {
    registry,
    locale: 'en',
  });
  if (!result.ok) return result.error;
  const checked = validateWorkspace(result.config, registry);
  return checked.ok ? '' : checked.issues.map((i) => i.message).join('\n');
};
const prepare = (input: Record<string, unknown>, previous: Record<string, unknown> | null = null) =>
  prepareRecordValues(orders, input, previous, NOW);
const issuesOf = (r: ReturnType<typeof prepare>) => (r.ok ? [] : r.issues);

describe('sections (D-570)', () => {
  it('a table with sections, a condition, a hint and ranges is valid', () => {
    expect(problems(orders)).toBe('');
  });

  it('configured sections come first; a field not named in any appears after them in table order', () => {
    expect(formSections(orders).map((s) => [s.title ?? null, s.fields])).toEqual([
      ['Order', ['item', 'qty', 'price', 'invoice']],
      ['Invoice', ['tax-no', 'company']],
      [null, ['note', 'packing']],
    ]);
    const plain = { ...orders, form: undefined };
    expect(formSections(plain)).toEqual([{ index: null, fields: plain.fields.map((f) => f.id) }]);
  });

  it('a section with a condition shows only while it holds for the values in the form', () => {
    const titles = (values: Record<string, unknown>) =>
      visibleFormSections(orders, values, NOW).map((s) => s.title ?? null);
    expect(titles({})).toEqual(['Order', null]);
    expect(titles({ invoice: false })).toEqual(['Order', null]);
    expect(titles({ invoice: true })).toEqual(['Order', 'Invoice', null]);
  });

  it('refuses a field that is not in the table, a field in two sections and a condition on its own section', () => {
    const at = (sections: object[]) => problems({ ...orders, form: { sections } } as Collection);
    expect(at([{ fields: ['nope'] }])).toMatch(/nope is not a field of orders/);
    expect(at([{ fields: ['item'] }, { fields: ['item'] }])).toMatch(/already in another section/);
    expect(
      at([{ fields: ['invoice', 'tax-no'], when: [{ field: 'invoice', op: 'is', value: true }] }]),
    ).toMatch(/in this same section/);
    expect(
      at([{ fields: ['note'], when: [{ field: 'createdAt', op: 'inPeriod', value: 'today' }] }]),
    ).toMatch(/only depend on fields filled in on this entry/);
    expect(
      at([{ fields: ['note'], when: [{ field: 'invoice', op: 'contains', value: 'x' }] }]),
    ).toMatch(/contains needs a text field/);
    // Maximum of 3 conditions.
    const four = Array.from({ length: 4 }, () => ({ field: 'invoice', op: 'is', value: true }));
    expect(at([{ fields: ['note'], when: four }])).not.toBe('');
  });

  it('a required field in a hidden section is not required while hidden, and is once shown', () => {
    expect(issuesOf(prepare({ item: 'Desk', invoice: false }))).toEqual([]);
    expect(issuesOf(prepare({ item: 'Desk', invoice: true }))).toEqual([
      { fieldId: 'tax-no', code: 'required' },
    ]);
  });

  it('hiding a section clears nothing: the stored values stay and come back when it shows', () => {
    const stored = { item: 'Desk', invoice: true, 'tax-no': 'DE123456789012345', company: 'ACME' };
    const r = prepare({ invoice: false }, stored);
    expect(r.ok && r.values).toEqual({ ...stored, invoice: false });
  });

  it('the form hands in only what is shown: edits in a hidden section do not count', () => {
    expect(formInput(orders, { item: 'Desk', invoice: false, 'tax-no': 'x' }, NOW)).toEqual({
      item: 'Desk',
      invoice: false,
    });
    expect(formInput(orders, { invoice: true, 'tax-no': 'x' }, NOW)).toEqual({
      invoice: true,
      'tax-no': 'x',
    });
  });

  it('removing a field takes it out of the sections and their conditions (invariant 18)', () => {
    const config = build(
      { op: 'addData', table: orders },
      { op: 'removeData', table: 'orders', field: 'invoice' },
      { op: 'removeData', table: 'orders', field: 'company' },
    );
    expect(config.data.tables[0]!.form).toEqual({
      sections: [
        { title: 'Order', fields: ['item', 'qty', 'price'] },
        { title: 'Invoice', fields: ['tax-no'] },
      ],
    });
    expect(validateWorkspace(config, registry).ok).toBe(true);
    const gone = build(
      { op: 'addData', table: { ...orders, form: { sections: [{ fields: ['note'] }] } } },
      { op: 'removeData', table: 'orders', field: 'note' },
    );
    expect(gone.data.tables[0]!.form).toBeUndefined();
  });

  it('the AI sets it with updateData on the table, and the change says so', () => {
    const before = build({ op: 'addData', table: { ...orders, form: undefined } });
    const op: Op = { op: 'updateData', table: 'orders', changes: { form: orders.form } };
    const after = applyOps(before, [op], { registry, locale: 'en' });
    expect(after.ok).toBe(true);
    expect(describeChange([op], before, [], { registry, locale: 'en', now: NOW })).toEqual([
      '“Orders”: change the sections of the entry form',
    ]);
  });
});

describe('hints (D-570)', () => {
  it('any stored field may carry a short hint; a long one is refused', () => {
    const field = { id: 'a', name: 'A', type: 'date', hint: 'The day it arrived' };
    expect(FieldSchema.safeParse(field).success).toBe(true);
    expect(FieldSchema.safeParse({ ...field, hint: 'x'.repeat(81) }).success).toBe(false);
  });

  it('changing a field type keeps its hint', () => {
    const config = build(
      { op: 'addData', table: orders },
      { op: 'updateData', table: 'orders', field: 'note', changes: { type: 'text' } },
    );
    expect(config.data.tables[0]!.fields.find((f) => f.id === 'note')).not.toHaveProperty('hint');
    const hinted = build(
      { op: 'addData', table: orders },
      { op: 'updateData', table: 'orders', field: 'tax-no', changes: { type: 'note' } },
    );
    const f = hinted.data.tables[0]!.fields.find((x) => x.id === 'tax-no');
    expect(f && 'hint' in f && f.hint).toBe('15 or 18 characters');
  });
});

describe('ranges (D-570)', () => {
  it('a value outside min / max is refused with the limit', () => {
    expect(issuesOf(prepare({ item: 'Desk', qty: 0 }))).toEqual([
      { fieldId: 'qty', code: 'tooSmall', limit: 1 },
    ]);
    expect(issuesOf(prepare({ item: 'Desk', price: '10000.01' }))).toEqual([
      { fieldId: 'price', code: 'tooLarge', limit: 10_000 },
    ]);
    expect(issuesOf(prepare({ item: 'Desk', packing: '2:01' }))).toEqual([
      { fieldId: 'packing', code: 'tooLarge', limit: 120 },
    ]);
    expect(issuesOf(prepare({ item: 'Desk', qty: 1, price: 10_000, packing: 120 }))).toEqual([]);
  });

  it('a stored value outside a range added later is still shown, and other fields still save', () => {
    const stored = { item: 'Desk', qty: 0 };
    expect(readValue(orders.fields[1]!, 0)).toBe(0);
    const r = prepare({ item: 'Chair' }, stored);
    expect(r.ok && r.values).toEqual({ item: 'Chair', qty: 0 });
    // Checked only upon modification.
    expect(issuesOf(prepare({ qty: -1 }, stored))).toEqual([
      { fieldId: 'qty', code: 'tooSmall', limit: 1 },
    ]);
  });

  it('min above max, or a default outside the range, is refused', () => {
    const withQty = (extra: object) =>
      problems({
        ...orders,
        fields: orders.fields.map((f) => (f.id === 'qty' ? { ...f, ...extra } : f)),
      } as Collection);
    expect(withQty({ min: 5, max: 2 })).toMatch(/min 5 is larger than max 2/);
    expect(withQty({ default: 0 })).toMatch(/default 0 is outside min \/ max/);
  });

  it('the AI is told about min and max on number, money and duration', () => {
    for (const type of ['number', 'money', 'duration'] as const)
      expect(fieldDefinition(type).ai.doc).toMatch(/min\?.*max\?/);
  });
});

it('an exported file names each of them as a feature', () => {
  const config = build({ op: 'addData', table: orders });
  expect(usesOf(config).features).toEqual(
    expect.arrayContaining(['entryForm', 'fieldHint', 'fieldRange']),
  );
  const plain = build({
    op: 'addData',
    table: { id: 'plain', name: 'Plain', fields: [{ id: 'n', name: 'N', type: 'number' }] },
  });
  for (const f of ['entryForm', 'fieldHint', 'fieldRange'])
    expect(usesOf(plain).features ?? []).not.toContain(f);
});
