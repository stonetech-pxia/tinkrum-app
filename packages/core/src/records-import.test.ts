import { describe, expect, it } from 'vitest';

import {
  IMPORT_LIMITS,
  dataRows,
  dateOrderOf,
  decodeSheetText,
  importLimitProblem,
  importTargets,
  normalizeName,
  parseCsv,
  planImport,
  proposeMapping,
  readCellFor,
  readNumberText,
  sheetColumns,
  type SheetCell,
} from './records-import';
import { t } from './messages';
import type { Collection, Field } from './schema';

// 表格文件的行导进已有的表（D-574）：读 CSV、按名字对列、宽容地读每一格再交给字段自己的 write、汇总导不进去的行。
// xlsx 的读取在 tool-office（readXlsxRows），整条路在 mobile 的 import-records-test.tsx。

const orders: Collection = {
  id: 'orders',
  name: 'Orders',
  fields: [
    { id: 'customer', name: 'Customer', type: 'text', required: true },
    { id: 'amount', name: 'Amount', type: 'money', currency: 'EUR' },
    { id: 'on', name: 'Date', type: 'date' },
    {
      id: 'status',
      name: 'Status',
      type: 'choice',
      options: [
        { id: 'open', label: 'Open' },
        { id: 'shipped', label: 'Shipped' },
      ],
    },
    { id: 'paid', name: 'Paid', type: 'checkbox' },
    { id: 'labels', name: 'Tags', type: 'tags' },
    { id: 'qty', name: 'Qty', type: 'number', min: 1 },
    { id: 'total', name: 'Total', type: 'formula', expression: '{amount} * {qty}' },
    { id: 'scan', name: 'Scan', type: 'file' },
    { id: 'buyer', name: 'Buyer', type: 'link', table: 'customers' },
  ],
} as Collection;

const field = (id: string) => orders.fields.find((f) => f.id === id) as Field;
const cells = (...texts: string[]): SheetCell[] => texts.map((text) => ({ text }));
const bytes = (s: string) => new TextEncoder().encode(s);
const NOW = new Date(2026, 10, 16, 9, 0);

describe('reading the text of a CSV', () => {
  it('UTF-8 with and without a BOM, UTF-16 with a BOM both ways', () => {
    expect(decodeSheetText(bytes('Prénom,数量\n'))).toEqual({ ok: true, text: 'Prénom,数量\n' });
    expect(decodeSheetText(new Uint8Array([0xef, 0xbb, 0xbf, ...bytes('a,b')]))).toEqual({
      ok: true,
      text: 'a,b',
    });
    const le = new Uint8Array([0xff, 0xfe, 0x61, 0, 0x2c, 0, 0x8f, 0x65]);
    expect(decodeSheetText(le)).toEqual({ ok: true, text: 'a,斏' });
    const be = new Uint8Array([0xfe, 0xff, 0, 0x61, 0, 0x3b, 0x65, 0x8f]);
    expect(decodeSheetText(be)).toEqual({ ok: true, text: 'a;斏' });
  });

  it('another encoding is refused instead of guessed; a zip or binary file is not a spreadsheet', () => {
    // Latin-1 的 é（0xE9）不是 UTF-8。
    expect(decodeSheetText(new Uint8Array([0x63, 0x61, 0x66, 0xe9]))).toEqual({
      ok: false,
      error: 'encoding',
    });
    expect(decodeSheetText(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2]))).toEqual({
      ok: false,
      error: 'notSpreadsheet',
    });
    expect(decodeSheetText(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0, 1]))).toEqual({
      ok: false,
      error: 'notSpreadsheet',
    });
  });
});

describe('parsing CSV', () => {
  const texts = (rows: SheetCell[][]) => rows.map((r) => r.map((c) => c.text));

  it('quotes, doubled quotes, an embedded newline and CRLF', () => {
    const csv = 'Customer,Note\r\n"Smith, Ana","He said ""hi""\nthen left"\r\nBo,\r\n';
    expect(texts(parseCsv(csv))).toEqual([
      ['Customer', 'Note'],
      ['Smith, Ana', 'He said "hi"\nthen left'],
      ['Bo', ''],
    ]);
  });

  it('semicolons (French Excel) and tabs are found from the first line', () => {
    expect(texts(parseCsv('Client;Montant\nAna;1 234,50\n'))).toEqual([
      ['Client', 'Montant'],
      ['Ana', '1 234,50'],
    ]);
    expect(texts(parseCsv('a\tb\n"x,y"\t2'))).toEqual([
      ['a', 'b'],
      ['x,y', '2'],
    ]);
  });

  it('an empty trailing column and the column count from the widest row', () => {
    const rows = parseCsv('Customer,Amount,\nAna,12,\nBo,3,,extra\n');
    expect(sheetColumns(rows, true)).toEqual(['Customer', 'Amount', '', '']);
    expect(sheetColumns(rows, false)).toEqual(['', '', '', '']);
  });
});

describe('matching columns to fields', () => {
  it('only fields that are typed in are targets', () => {
    expect(importTargets(orders).map((f) => f.id)).toEqual([
      'customer',
      'amount',
      'on',
      'status',
      'paid',
      'labels',
      'qty',
    ]);
  });

  it('same name after case, full-width and spaces; nothing fuzzier; a duplicate header goes to the first', () => {
    expect(normalizeName('　ＡＭＯＵＮＴ  ')).toBe('amount');
    expect(
      proposeMapping(
        ['customer', ' Ａmount ', 'Datum', 'Total', 'Scan', 'Buyer', 'Customer', 'Amounts'],
        orders,
      ),
    ).toEqual(['customer', 'amount', null, null, null, null, null, null]);
  });
});

describe('reading a cell for a field', () => {
  it('numbers with thousands separators, currency and both decimal styles', () => {
    expect(readNumberText('1,234.50')).toBe(1234.5);
    expect(readNumberText('€1 234,50')).toBe(1234.5);
    expect(readNumberText('1.234,50 €')).toBe(1234.5);
    expect(readNumberText('12,5')).toBe(12.5);
    expect(readNumberText('EUR 99')).toBe(99);
    expect(readNumberText('-3')).toBe(-3);
    expect(readNumberText('(3.5)')).toBe(-3.5);
    expect(readNumberText("1'000")).toBe(1000);
    expect(readNumberText('1,2,3')).toBeUndefined();
    expect(readNumberText('12 apples')).toBeUndefined();
  });

  it('dates: real Excel dates, ISO, and day / month / year in the order of the column', () => {
    const on = field('on');
    expect(readCellFor(on, { text: '', number: 46296, date: true }, 'dmy')).toEqual({
      value: '2026-10-01',
    });
    // 数字不是日期格式的不当日期。
    expect(readCellFor(on, { text: '46296', number: 46296 }, 'dmy')).toEqual({ invalid: true });
    expect(readCellFor(on, { text: '2026-10-01' }, 'mdy')).toEqual({ value: '2026-10-01' });
    expect(readCellFor(on, { text: '2026年10月1日' }, 'dmy')).toEqual({ value: '2026-10-01' });
    expect(readCellFor(on, { text: '03/04/2026' }, 'dmy')).toEqual({ value: '2026-04-03' });
    expect(readCellFor(on, { text: '03/04/2026' }, 'mdy')).toEqual({ value: '2026-03-04' });
    expect(readCellFor(on, { text: '31.12.2026' }, 'dmy')).toEqual({ value: '2026-12-31' });
    expect(readCellFor(on, { text: '31/12/26' }, 'dmy')).toEqual({ invalid: true });
    expect(readCellFor(on, { text: '30/02/2026' }, 'dmy')).toEqual({ invalid: true });
  });

  it('the order of a column is decided by a day above 12, otherwise day first and flagged', () => {
    const col = (...t: string[]) => t.map((text) => ({ text }));
    expect(dateOrderOf(col('03/04/2026', '25/04/2026'))).toEqual({
      order: 'dmy',
      decided: true,
      ambiguous: false,
    });
    expect(dateOrderOf(col('03/04/2026', '04/25/2026'))).toEqual({
      order: 'mdy',
      decided: true,
      ambiguous: false,
    });
    expect(dateOrderOf(col('03/04/2026', '2026-01-01'))).toEqual({
      order: 'dmy',
      decided: false,
      ambiguous: true,
    });
    expect(dateOrderOf(col('2026-01-01'))).toMatchObject({ decided: false, ambiguous: false });
  });

  it('choice by label or id, checkbox words in three languages, tags split on commas', () => {
    expect(readCellFor(field('status'), { text: ' shipped ' }, 'dmy')).toEqual({
      value: 'shipped',
    });
    expect(readCellFor(field('status'), { text: 'open' }, 'dmy')).toEqual({ value: 'open' });
    expect(readCellFor(field('status'), { text: 'Lost' }, 'dmy')).toEqual({ invalid: true });
    for (const yes of ['Yes', 'TRUE', '1', '是', 'oui', 'Vrai'])
      expect(readCellFor(field('paid'), { text: yes }, 'dmy')).toEqual({ value: true });
    for (const no of ['no', 'FALSE', '0', '否', 'Non', 'faux'])
      expect(readCellFor(field('paid'), { text: no }, 'dmy')).toEqual({ value: false });
    expect(readCellFor(field('paid'), { text: 'maybe' }, 'dmy')).toEqual({ invalid: true });
    expect(readCellFor(field('labels'), { text: 'red, blue，green' }, 'dmy')).toEqual({
      value: ['red', 'blue', 'green'],
    });
    expect(readCellFor(field('customer'), { text: '' }, 'dmy')).toBeUndefined();
  });
});

describe('planning an import', () => {
  const header = cells('Customer', 'Amount', 'Date', 'Status', 'Paid', 'Qty');
  const settings = {
    header: true,
    mapping: ['customer', 'amount', 'on', 'status', 'paid', 'qty'],
    orders: ['dmy', 'dmy', 'dmy', 'dmy', 'dmy', 'dmy'] as const,
  };

  it('good rows become values through the fields’ own write; bad rows are left out by reason with row numbers', () => {
    const rows = [
      header,
      cells('Ana', '1,234.50', '25/12/2026', 'Shipped', 'yes', '2'),
      cells('', '', '', '', '', ''),
      cells('', '10', '', '', '', ''),
      cells('Bo', 'ten', '', '', '', ''),
      cells('Cy', '5', '', '', 'no', '0'),
      cells('Di', '7', '', 'open', '', ''),
    ];
    const plan = planImport(orders, rows, { ...settings, orders: [...settings.orders] }, NOW);
    expect(plan.rows).toBe(5);
    expect(plan.entries).toEqual([
      {
        row: 2,
        values: {
          customer: 'Ana',
          amount: 1234.5,
          on: '2026-12-25',
          status: 'shipped',
          paid: true,
          qty: 2,
        },
      },
      { row: 7, values: { customer: 'Di', amount: 7, status: 'open', paid: false } },
    ]);
    expect(plan.skipped).toEqual([
      { code: 'required', fieldId: 'customer', count: 1, rows: [4] },
      { code: 'invalid', fieldId: 'amount', count: 1, rows: [5] },
      { code: 'tooSmall', fieldId: 'qty', count: 1, rows: [6], limit: 1 },
    ]);
  });

  it('without a header row the first row is data; rows numbers stay those of the file', () => {
    const rows = [cells('Ana', '3'), cells('Bo', '4')];
    const plan = planImport(
      orders,
      rows,
      { header: false, mapping: ['customer', 'amount'], orders: ['dmy', 'dmy'] },
      NOW,
    );
    expect(plan.entries.map((e) => e.row)).toEqual([1, 2]);
  });

  it('a skipped column and an unmatched one are not read; only the first rows are listed per reason', () => {
    const rows = [
      cells('Customer', 'Amount'),
      ...Array.from({ length: 8 }, (_, i) => cells(`c${i}`, 'x')),
    ];
    expect(
      planImport(orders, rows, { header: true, mapping: ['customer', null], orders: [] }, NOW)
        .entries,
    ).toHaveLength(8);
    const plan = planImport(
      orders,
      rows,
      { header: true, mapping: ['customer', 'amount'], orders: [] },
      NOW,
    );
    expect(plan.skipped).toEqual([
      {
        code: 'invalid',
        fieldId: 'amount',
        count: 8,
        rows: [2, 3, 4, 5, 6].slice(0, IMPORT_LIMITS.rowNumbersShown),
      },
    ]);
  });

  it('2,001 data rows are refused, blank rows are not counted', () => {
    const csv = ['Customer', ...Array.from({ length: 2001 }, (_, i) => `c${i}`), '', ','].join(
      '\n',
    );
    const rows = parseCsv(csv);
    expect(dataRows(rows, true)).toHaveLength(2001);
    expect(importLimitProblem(2001, 2001, 0)).toEqual({ code: 'tooManyRows', max: 2000 });
    expect(importLimitProblem(2000, 2000, 0)).toBeNull();
  });

  it('the table cap of 10,000 is not passed, and nothing is imported in part', () => {
    expect(importLimitProblem(10, 10, 9990)).toBeNull();
    expect(importLimitProblem(10, 10, 9995)).toEqual({ code: 'tableFull', room: 5 });
  });
});

describe('the summary sentence for rows left out', () => {
  it('says "rows" / "lignes" before several row numbers and "row" / "ligne" before one', () => {
    const many = { n: 2, field: 'Amount', rows: '2, 4' };
    const one = { n: 1, field: 'Amount', rows: '5' };
    expect(t('en', 'importReason_invalid', many)).toContain('(rows 2, 4)');
    expect(t('en', 'importReason_invalid', one)).toContain('(row 5)');
    expect(t('fr', 'importReason_required', many)).toContain('(lignes 2, 4)');
    expect(t('fr', 'importReason_required', one)).toContain('(ligne 5)');
    expect(t('zh', 'importReason_invalid', many)).toContain('（第 2, 4 行）');
  });
});
