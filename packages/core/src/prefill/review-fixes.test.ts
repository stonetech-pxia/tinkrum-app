import { describe, expect, it } from 'vitest';

import type { Field } from '../schema';
import { amountChain } from './amount-chain';
import { checkAnswer, keepForModel } from './check';
import { mergedSuggestions, planDocument } from './code-rules';
import { modelEngine, ruleEngine } from './engine';
import { modelRequest, type OpenModel } from './model';
import { invoiceNoByKey, upperAmount, upperToNumber } from './zh-rules';

// Issues found when reviewing D-399; each item describes the expected behavior (each had failed in the code prior to the fix).

const AMOUNT: Field = { id: 'total', name: 'Amount', type: 'money', currency: 'USD' };
const IDR: Field = { id: 'total', name: 'Amount', type: 'money', currency: 'IDR' };
const DATE: Field = { id: 'day', name: 'Date', type: 'date' };
const NUMBER: Field = { id: 'no', name: 'Number', type: 'text' };
const MERCHANT: Field = { id: 'merchant', name: 'Merchant', type: 'text' };
const NOTE_TIME: Field = { id: 'time', name: 'Time', type: 'text' };
const money = (name: string): Field => ({ id: 'x', name, type: 'money', currency: 'CNY' });
const text = (name: string): Field => ({ id: 'x', name, type: 'text' });

const pageOf = (rows: string[]) => ({
  width: 600,
  height: 40 + rows.length * 30,
  lines: rows.map((t, i) => ({ text: t, x: 20, y: 20 + i * 30, width: 500, height: 24 })),
});
const now = new Date('2026-11-01T00:00:00Z');
const first = async (field: Field, rows: string[], locale: 'en' | 'fr' | 'zh' = 'en') =>
  (await ruleEngine({ rules: 'receipt', fields: [field], pages: [pageOf(rows)], locale, now }))[
    field.id
  ]?.[0]?.value;
const planOf = (field: Field, rows: string[], locale: 'en' | 'fr' | 'zh' = 'en') =>
  planDocument({ rules: 'receipt', fields: [field], pages: [pageOf(rows)], locale, now })
    .fields[0]!;

describe('No.: generic No does not consume other numbers (item 1)', () => {
  it.each([
    'Tel No: 03-12345678',
    'Co No: 123456-X',
    'Reg No: 200301012345',
    'No. 12A-3, Jalan Bukit',
    '流水号 NO 998877',
  ])('%s is not an order/invoice number', async (row) => {
    expect(invoiceNoByKey([row])).toBeNull();
    const p = planOf(NUMBER, [row]);
    expect(p.code.map((s) => s.value)).toEqual([]);
  });

  it('Explicit key names beat generic No; starting with letters and having more than 2 letters can also be retrieved', () => {
    expect(invoiceNoByKey(['Invoice No: INV12345'])).toBe('INV12345');
    expect(invoiceNoByKey(['No: 998877', 'Invoice No: INV12345'])).toBe('INV12345');
    expect(invoiceNoByKey(['Receipt No: RCP-2026-77'])).toBe('RCP-2026-77');
  });

  it('Recognize N°', () => {
    expect(invoiceNoByKey(['FACTURE N° 2026-0451'])).toBe('2026-0451');
    expect(invoiceNoByKey(['N° 2026-0451'])).toBe('2026-0451');
  });

  it('Previously recognized items are still recognized', () => {
    expect(invoiceNoByKey(['NO 11112222'])).toBe('11112222');
    expect(invoiceNoByKey(['No.8039067169'])).toBe('8039067169');
    expect(invoiceNoByKey(['Ticket No 12345678'])).toBe('12345678');
  });

  it('OCR on real receipts joins multiple boxes into a single line: look only at No\'s own segment (SIBR)', () => {
    expect(invoiceNoByKey(['业务流水号： 医疗类型： NO. 2007092215'])).toBe('2007092215');
    expect(invoiceNoByKey(['业务流水号： NO 2038022056'])).toBe('2038022056');
    expect(invoiceNoByKey(['备流水号 U9649201 医疗类型城市医保 NO 7912778710'])).toBe('7912778710');
    expect(invoiceNoByKey(['医疗机构类型： 二甲 皖财专（2014）P No 9059707910'])).toBe(
      '9059707910',
    );
    expect(invoiceNoByKey(['账单号 Folio No. 15646', 'Conf. No. 11849'])).toBe('15646');
    expect(invoiceNoByKey(['Beijing Invoice 24718066052020', 'No.25407626'])).toBe('25407626');
  });

  it('Key name for document number exists in text but code cannot retrieve value: unsure, ask the model; only considered absent if no key name exists at all', () => {
    expect(planOf(NUMBER, ['Invoice No: ABC', 'Total 5.00']).ask).toBe(true);
    expect(planOf(NUMBER, ['Thank you', 'Total 5.00']).ask).toBe(false);
  });

  it('Model responses also cannot come from the company name or address row', () => {
    expect(checkAnswer(NUMBER, '123456-X', ['Co No: 123456-X'], 'en')).toBeNull();
    expect(checkAnswer(NUMBER, '12A-3', ['No. 12A-3, Jalan Bukit'], 'en')).toBeNull();
  });
});

describe('Arithmetic: payment and subtotal do not precede total (item 2)', () => {
  const items = ['Coffee 5.00', 'Cake 10.00'];

  it('Has line items but no change: cash is not the total amount', async () => {
    const rows = [...items, 'Total 15.00', 'Cash 20.00'];
    expect(amountChain(rows, false, 'en')?.value).not.toBe(20);
    expect(Number(await first(AMOUNT, rows))).toBe(15);
  });

  it('Payment rows do not count as subtotal', async () => {
    const rows = ['Coffee 12.00', 'Cake 8.00', 'Total 19.00', 'Visa 20.00'];
    expect(amountChain(rows, false, 'en')?.value).not.toBe(20);
    expect(Number(await first(AMOUNT, rows))).toBe(19);
  });

  it('Negative discounts must be included', async () => {
    const rows = ['Tea 12.00', 'Cake 8.00', 'Subtotal 20.00', 'Discount -5.00', 'Total 15.00'];
    expect(amountChain(rows, false, 'en')).toEqual({ value: 15, how: 'subtotalAdjust' });
    expect(Number(await first(AMOUNT, rows))).toBe(15);
    expect(Number(await first(AMOUNT, ['Subtotal 20', 'Discount -5.00', 'Total 15']))).not.toBe(20);
  });

  it('Recognize change even if larger than total (the row stating total); cash may have no decimals', () => {
    const chain = { value: 28.9, how: 'payMinusChange' };
    expect(amountChain(['Total 28.90', 'Cash 100.00', 'Change 71.10'], false, 'en')).toEqual(chain);
    expect(amountChain(['Total 28.90', 'Cash 100', 'Change 71.10'], false, 'en')).toEqual(chain);
  });

  it('When OCR fails to read numbers on the total row, the number on the payment row can be the total amount (real receipt)', () => {
    const rows = [
      'A 100.00',
      'B 44.68',
      'SUB-TOTAL 144.68',
      'TOTAL TAX 8.68',
      'TOTAL',
      'CASH 153.35',
    ];
    expect(amountChain(rows, false, 'en')?.value).toBe(153.35);
  });

  it('Rows without a total label should not be treated as total based on large change amounts', () => {
    const rows = ['Coffee 5.00', 'Cash 100.00', 'Change 95.00'];
    expect(amountChain(rows, false, 'en')?.how).not.toBe('payMinusChange');
  });
});

describe('Hotel latest date determination (item 3)', () => {
  it('\'room\' must be a single word: Mushroom Cafe is not a hotel', async () => {
    const rows = ['Mushroom Cafe', 'Departure board', 'Date 2026-01-01', 'Next visit 2026-03-01'];
    expect(await first(DATE, rows)).toBe('2026-01-01');
  });

  it('Flight and transfer departures do not count as hotels', async () => {
    const rows = ['Booking date 2026-11-01', 'Guest details', 'Departure', 'Return 2027-01-05'];
    expect(await first(DATE, rows)).toBe('2026-11-01');
  });

  it('English expiry wording does not count either', async () => {
    const rows = [
      'Guest folio',
      'Invoice date 2026-03-01',
      'Departure 2026-03-02',
      'Card exp 2030-01-31',
    ];
    const out = await ruleEngine({
      rules: 'receipt',
      fields: [DATE],
      pages: [pageOf(rows)],
      locale: 'en',
      now,
    });
    expect(out.day?.[0]?.value).toBe('2026-03-02');
    expect(out.day?.map((s) => s.value)).not.toContain('2030-01-31');
  });

  it('When day, month, and year order is ambiguous, do not pick the later of two interpretations; follow the order given by the language first', async () => {
    const rows = ['Guest folio', 'Departure 03/04/2026'];
    expect(await first(DATE, rows, 'en')).toBe('2026-03-04');
    expect(await first(DATE, rows, 'fr')).toBe('2026-04-03');
  });

  it('Actual hotel bills still pick the latest date', async () => {
    const rows = ['Guest folio', 'Date 2026-03-01', 'Departure', 'Closed 2026-03-04'];
    expect(await first(DATE, rows)).toBe('2026-03-04');
  });

  it('Print date is not included in the latest date (D-403)', async () => {
    const rows = ['Guest folio', 'Date 2026-03-01', 'Departure', 'Time printed 2026-03-04'];
    expect(await first(DATE, rows)).toBe('2026-03-01');
  });
});

describe('Amount in words must be checked from that row (item 4)', () => {
  it('Words for received amount or deposit do not count', () => {
    expect(upperAmount(['合计 128', '实收大写 贰佰元整', '实收 200.00'])?.sure ?? false).toBe(
      false,
    );
    expect(upperAmount(['押金伍元整', '押金 5.00'])?.sure ?? false).toBe(false);
  });

  it('If there is a total-like category, pick it', () => {
    expect(upperAmount(['服务费 壹拾元整 10.00', '价税合计 壹佰壹拾元整 110.00'])).toEqual({
      value: 110,
      sure: true,
    });
    expect(upperAmount(['服务费 壹拾元整 10.00 价税合计 壹佰壹拾元整 110.00'])).toEqual({
      value: 110,
      sure: true,
    });
  });

  it('Unlabeled ones are still recognized; mismatched pairs are rejected', () => {
    expect(upperAmount(['人民币 贰拾捌元玖角', '28.90'])).toEqual({ value: 28.9, sure: true });
    const two = upperAmount(['壹拾元整 10.00', '贰拾元整 20.00']);
    expect(two?.sure ?? false).toBe(false);
  });

  it('Recognized even when \'Total (in words)\' and the amount in words are split into two rows (SIBR)', () => {
    expect(upperAmount(['金额合计（大写）：', '收款： 肆拾肆元肆角伍分', '44.45'])).toEqual({
      value: 44.45,
      sure: true,
    });
    expect(upperAmount(['合计(大写)：', '现金 壹佰元整 ￥100.00'])).toEqual({
      value: 100,
      sure: true,
    });
  });

  it('Form\'s first candidate is not the amount in words for deposits or received amounts', async () => {
    expect(
      Number(await first(money('金额'), ['押金伍元整', '押金 5.00', '合计 88.00'], 'zh')),
    ).toBe(88);
  });

  it('Can parse zero and traditional Chinese numerals', () => {
    expect(upperToNumber('贰拾捌元零伍分')).toBe(28.05);
    expect(upperToNumber('壹佰元零伍角')).toBe(100.5);
    expect(upperToNumber('貳拾元整')).toBe(20);
    expect(upperAmount(['合計 貳拾元整', '20.00'])).toEqual({ value: 20, sure: true });
  });
});

describe('Amount verification checks the entire number (item 6, D-396 \'verifiable\')', () => {
  it.each([
    ['8.90', ['Total 28.90']],
    ['1.25', ['Total 11.25']],
    ['5', ['Date 2026-10-30', 'Coffee 5.00']],
    ['30', ['Date 2026-10-30']],
    ['12', ['Time 12:30']],
    ['1234', ['Tel 012-1234']],
  ])('%s cannot be matched against %j', (answer, rows) => {
    expect(checkAnswer(AMOUNT, answer, rows, 'en')).toBeNull();
  });

  it.each([
    ['28.90', ['Total 28.90'], '28.9'],
    ['RM 28.90', ['Total RM28.90'], '28.9'],
    ['8.2', ['Total 8.20'], '8.2'],
    ['100', ['Total 100.00'], '100'],
    ['1234.50', ['Total 1,234.50'], '1234.5'],
    ['1,234.50', ['Total 1234.50'], '1234.5'],
    ['1.234,50', ['Total 1.234,50'], '1234.5'],
    ['1234.50', ['Total 1 234,50'], '1234.5'],
  ])('%s is successfully matched against %j', (answer, rows, value) => {
    expect(checkAnswer(AMOUNT, answer, rows, 'en')).toBe(value);
  });

  it('OCR-damaged separators on the total row (real receipt); a sequence of digits must match entirely', () => {
    expect(checkAnswer(IDR, '20000', ['TOTAL 20 0 0 0'], 'en')).toBe('20000');
    expect(checkAnswer(IDR, '36000', ['TOTAL 36-000'], 'en')).toBe('36000');
    expect(checkAnswer(AMOUNT, '19.8', ['NET TOTAL: 19-80'], 'en')).toBeNull();
    expect(checkAnswer(AMOUNT, '19.80', ['NET TOTAL: 19-80'], 'en')).toBe('19.8');
    expect(checkAnswer(AMOUNT, '9.80', ['NET TOTAL: 19-80'], 'en')).toBeNull();
  });

  it('Currencies without decimals: thousands separator', () => {
    expect(checkAnswer(IDR, '32.000', ['Total 32.000'], 'en')).toBe('32000');
    expect(checkAnswer(IDR, '32000', ['Total Rp 32.000'], 'en')).toBe('32000');
    expect(checkAnswer(IDR, '32,000.00', ['Total 32,000.00'], 'en')).toBe('32000');
    expect(checkAnswer(IDR, '2000', ['Total 32.000'], 'en')).toBeNull();
  });
});

describe('Model candidate memory (item 7)', () => {
  it('Only candidates provided by the model carry real labels and positions; do not hardcode relY 0', async () => {
    const rows = ['Header line', 'Note x', 'Store: Cafe Royal', 'Total 5.00'];
    const open: OpenModel = async () => ({
      generate: async () => 'Cafe Royal',
      release: async () => undefined,
    });
    const out = await modelEngine(open)({
      // Company field rules also ask the model even if there are candidates (store name doesn't ask if there are candidates, D-404).
      fields: [{ id: 'merchant', name: 'Company', type: 'text' }],
      pages: [pageOf(rows)],
      locale: 'en',
      now,
    });
    const hit = out.merchant?.find((s) => s.value === 'Cafe Royal');
    expect(hit?.pick?.relY).toBeGreaterThan(0.3);
  });

  it('Do not record if position cannot be found, rather than recording a fake page top', () => {
    const plan = planDocument({
      rules: 'receipt',
      fields: [MERCHANT],
      pages: [pageOf(['Acme Coffee'])],
      locale: 'en',
      now,
    });
    const [s] = mergedSuggestions(plan.fields[0]!, ['Not On Page'], plan.pickOf);
    expect(s?.value).toBe('Not On Page');
    expect(s?.pick).toBeUndefined();
  });
});

describe('Text given to the model by field (item 8)', () => {
  const COUPON = money('优惠金额');
  const CASH = money('现金');

  it.each([
    [COUPON, '优惠 -5.00'],
    [CASH, '现金 100.00'],
    [text('地址'), '地址: 北京路 1 号'],
    [text('电话'), '电话 010-1234567'],
    [text('Address'), 'Address: 1 Main St'],
    [text('Phone'), 'Tel: 03-12345678'],
    [text('Email'), 'hello@acme.com'],
    [money('Discount'), 'Discount 5.00'],
  ])('%j queried for its own row: %s', (field, row) => {
    expect(keepForModel(row, field)).toBe(true);
    expect(modelRequest(field, [row, 'Total 9.00']).prompt).toContain(row);
  });

  it('Other fields remain hidden; total field is same as during measurement', () => {
    expect(keepForModel('优惠 -5.00', AMOUNT)).toBe(false);
    expect(keepForModel('现金 100.00', money('金额'))).toBe(false);
    expect(keepForModel('实收 100.00', money('金额'))).toBe(false);
    expect(keepForModel('Cash 100.00', AMOUNT)).toBe(false);
    expect(keepForModel('电话 010-1234567', COUPON)).toBe(false);
  });

  it('Answers for custom fields pass verification in their own row', () => {
    expect(checkAnswer(COUPON, '5.00', ['优惠 -5.00', '合计 95.00'], 'zh')).toBe('5');
    expect(checkAnswer(CASH, '100.00', ['合计 95.00', '现金 100.00', '找零 5.00'], 'zh')).toBe(
      '100',
    );
    expect(checkAnswer(AMOUNT, '100.00', ['Total 95.00', 'Cash 100.00'], 'en')).toBeNull();
  });
});

describe('Value memory must have boundaries (item 9)', () => {
  const remembered = (known: string[], rows: string[]) =>
    planDocument({
      rules: 'receipt',
      fields: [MERCHANT],
      pages: [pageOf(rows)],
      locale: 'zh',
      now,
      known: { merchant: known },
    }).fields[0]!.remembered?.value;

  it('English requires whole words', () => {
    expect(remembered(['Apple'], ['PINEAPPLE JUICE BAR'])).toBeUndefined();
    expect(remembered(['Apple'], ['APPLE STORE KLCC'])).toBe('Apple');
    expect(remembered(['Acme Coffee'], ['ACMECOFFEE 12'])).toBe('Acme Coffee');
    expect(remembered(['Acme'], ['ACME2'])).toBeUndefined();
  });

  it('Chinese requires entire rows or sufficient length', () => {
    expect(remembered(['中国'], ['中国银行'])).toBeUndefined();
    expect(remembered(['中国'], ['中国'])).toBe('中国');
    expect(remembered(['中国银行'], ['中国银行北京分行'])).toBe('中国银行');
  });

  it('Cross-row combination is prohibited', () => {
    expect(remembered(['Apple Store'], ['Apple', 'Store'])).toBeUndefined();
    expect(remembered(['中国银行'], ['中国', '银行'])).toBeUndefined();
  });
});

describe('Product line items are not store names (model response)', () => {
  const rows = ['MUSHROOM CAFE', 'Latte 4.50', 'A4 CLR COPY 8 0.53 4.24 SR', 'BAKERY 24'];
  it.each(['Latte 4.50', 'Latte', 'A4 CLR COPY 8 0.53 4.24 SR'])('%s is not a store name', (answer) => {
    expect(checkAnswer(MERCHANT, answer, rows, 'en')).toBeNull();
  });
  it('Real store name remains, other text fields are unaffected', () => {
    expect(checkAnswer(MERCHANT, 'MUSHROOM CAFE', rows, 'en')).toBe('MUSHROOM CAFE');
    expect(checkAnswer(MERCHANT, 'BAKERY 24', rows, 'en')).toBe('BAKERY 24');
    expect(checkAnswer(text('Item'), 'Latte 4.50', rows, 'en')).toBe('Latte 4.50');
  });
});

describe('Strip labels (item 10)', () => {
  it('12:30 is not \'label: value\'', () => {
    expect(checkAnswer(NOTE_TIME, '12:30', ['Open 12:30'], 'en')).toBe('12:30');
  });

  it('Real labels are still stripped', () => {
    expect(checkAnswer(MERCHANT, 'Store: Cafe Royal', ['Store: Cafe Royal'], 'en')).toBe(
      'Cafe Royal',
    );
  });
});

describe('Tap selection memory only adjusts order, does not add to new candidates', () => {
  // Real receipt found on mobile (SROIE): after tapping the first candidate, address and 0.00, 4.00 appeared extra.
  const page = {
    width: 736,
    height: 1248,
    lines: (
      [
        ['TSH POWER HARDWÀRE', 125, 174, 493, 48],
        ['TRADING', 274, 224, 195, 42],
        ['002458685-T', 284, 271, 177, 31],
        ['13-1, Jalan PJU 5/10,', 221, 307, 299, 42],
        ['Dataran Sunway, Kota Damansara,', 131, 345, 481, 42],
        ['47810, Petaling Jaya, Selangor', 157, 383, 428, 43],
        ['Tel:012-373 2096', 245, 422, 254, 38],
        ['TAX INVOICE', 266, 462, 210, 35],
        ['Date', 41, 590, 72, 39],
        ['10/10/2017 4:22:12 PM', 241, 593, 333, 37],
        ['1 MAJESTA HSS', 54, 707, 210, 36],
        ['4.00', 455, 707, 73, 38],
        ['2', 380, 708, 29, 36],
        ['8.00 SR+', 593, 707, 137, 38],
        ['Sub Total:', 300, 833, 148, 39],
        ['8.00', 594, 836, 70, 34],
        ['Round Amt:', 277, 871, 172, 39],
        ['0.00', 594, 874, 70, 34],
        ['NET TOTAL :', 183, 912, 264, 45],
        ['8.00', 578, 913, 104, 45],
        ['Cash Received :', 206, 968, 218, 34],
        ['8.00', 593, 967, 72, 37],
      ] as [string, number, number, number, number][]
    ).map(([text, x, y, width, height]) => ({ text, x, y, width, height })),
  };
  const fields = [MERCHANT, AMOUNT];
  const input = { rules: 'receipt' as const, fields, pages: [page], locale: 'en' as const, now };
  const values = (o: Awaited<ReturnType<typeof ruleEngine>>, id: string) =>
    (o[id] ?? []).map((s) => s.value);

  it('After tapping, candidates remain those from before the tap', async () => {
    const before = await ruleEngine(input);
    const picks = { merchant: before.merchant![0]!.pick!, total: before.total![0]!.pick! };
    const after = await ruleEngine({ ...input, picks });
    expect(values(after, 'merchant').sort()).toEqual(values(before, 'merchant').sort());
    expect(values(after, 'total').sort()).toEqual(values(before, 'total').sort());
  });

  it('Memory can also determine priority: tapped the second one, next time it ranks first', async () => {
    const before = await ruleEngine(input);
    const second = before.merchant![1]!;
    const after = await ruleEngine({ ...input, picks: { merchant: second.pick! } });
    expect(after.merchant![0]!.value).toBe(second.value);
  });
});
