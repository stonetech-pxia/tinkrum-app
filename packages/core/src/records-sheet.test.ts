import { describe, expect, it } from 'vitest';

import { recordsToCsv, type DataRecord } from './data';
import { recordsToSheet } from './records-sheet';
import type { Collection } from './schema';

// D-427: Columns same as CSV; true numbers and dates, everything else as text.

const table: Collection = {
  id: 't',
  name: 'Expenses',
  fields: [
    { id: 'name', name: 'Name', type: 'text' },
    { id: 'cost', name: 'Cost', type: 'money', currency: 'EUR' },
    { id: 'qty', name: 'Qty', type: 'number' },
    { id: 'day', name: 'Day', type: 'date' },
    { id: 'when', name: 'When', type: 'datetime' },
    {
      id: 'kind',
      name: 'Kind',
      type: 'choice',
      options: [{ id: 'm', label: 'Meals' }],
    },
    { id: 'done', name: 'Done', type: 'checkbox' },
    { id: 'files', name: 'Files', type: 'file' },
    { id: 'owner', name: 'Owner', type: 'link', table: 'people' },
    { id: 'total', name: 'Total', type: 'formula', expression: '{cost} * 2' },
  ],
};

const full: DataRecord = {
  id: 'r',
  collectionId: 't',
  values: {
    name: '=SUM(A1)',
    cost: 12.5,
    qty: 3,
    day: '2026-11-03',
    when: '2026-11-03T14:30',
    kind: 'm',
    done: true,
    files: ['a', 'b'],
    owner: 'p1',
  },
  createdAt: new Date(2026, 10, 3, 9, 15).getTime(),
  updatedAt: 1,
};

const links = () => 'Marie';

describe('recordsToSheet', () => {
  it('has the same columns as the CSV export', () => {
    const [header] = recordsToSheet(table, [full], 'en', links);
    const csvHeader = recordsToCsv(table, [full], 'en', links).split('\r\n')[0]!.replace(/^﻿/, '');
    // Amount cells contain numbers only, currency is written in the header (D-429); everything else is the same as CSV.
    expect(header!.map((c) => c.text).join(',')).toBe(csvHeader.replace('Cost', 'Cost (EUR)'));
    expect(header!.every((c) => c.kind === 'text')).toBe(true);
  });

  it('writes numbers, money and dates as real values', () => {
    const row = recordsToSheet(table, [full], 'en', links)[1]!;
    expect(row[1]).toMatchObject({ kind: 'number', value: 12.5, format: '#,##0.00' });
    expect(row[2]).toMatchObject({ kind: 'number', value: 3 });
    // 2026-11-03 = 46329 (Excel serial number).
    expect(row[3]).toMatchObject({ kind: 'number', value: 46329, format: 'yyyy-mm-dd' });
    expect(row[4]).toMatchObject({ kind: 'number', format: 'yyyy-mm-dd hh:mm' });
    expect((row[4] as { value: number }).value).toBeCloseTo(46329 + 14.5 / 24, 6);
    expect(row[9]).toMatchObject({ kind: 'number', value: 25 });
    expect(row[10]).toMatchObject({ kind: 'number', format: 'yyyy-mm-dd hh:mm' });
    expect((row[10] as { value: number }).value).toBeCloseTo(46329 + 9.25 / 24, 6);
  });

  it('writes the rest as readable text, never as a formula', () => {
    const row = recordsToSheet(table, [full], 'en', links)[1]!;
    expect(row[0]).toEqual({ kind: 'text', text: '=SUM(A1)' });
    expect(row[5]).toEqual({ kind: 'text', text: 'Meals' });
    expect(row[6]).toEqual({ kind: 'text', text: 'Yes' });
    expect(row[7]).toEqual({ kind: 'text', text: '2 attachments' });
    expect(row[8]).toEqual({ kind: 'text', text: 'Marie' });
  });

  it('keeps an empty record and values that do not parse as text', () => {
    const row = recordsToSheet(
      table,
      [{ ...full, values: { day: 'hier', when: '2026-02-31T10:00' } }],
      'en',
    )[1]!;
    expect(row[0]).toEqual({ kind: 'text', text: '' });
    expect(row[3]!.kind).toBe('text');
    expect(row[4]!.kind).toBe('text');
  });
});

it('exports chosen columns in order, including Created', () => {
  const rows = recordsToSheet(table, [full, full], 'en', links, {
    fields: ['cost', 'name', 'day', 'createdAt', 'qty'],
  });
  expect(rows[0]!.map((c) => c.text)).toEqual(['Cost (EUR)', 'Name', 'Day', 'Created', 'Qty']);
});
