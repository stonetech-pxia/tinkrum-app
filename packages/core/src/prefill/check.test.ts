import { describe, expect, it } from 'vitest';

import type { Field } from '../schema';
import { amountChain } from './amount-chain';
import { checkAnswer, keepForModel } from './check';
import { knownValues, planDocument } from './code-rules';
import { modelAnswers } from './model';
import { invoiceNoByKey, stripNoPrefix, upperAmount, upperToNumber } from './zh-rules';

const AMOUNT: Field = { id: 'amount', name: 'Amount', type: 'money', currency: 'MYR' };
const IDR: Field = { id: 'amount', name: 'Amount', type: 'money', currency: 'IDR' };
const TAX: Field = { id: 'tax', name: 'Tax', type: 'money', currency: 'USD' };
const DATE: Field = { id: 'date', name: 'Date', type: 'date' };
const DUE: Field = { id: 'due', name: 'Due date', type: 'date' };
const MERCHANT: Field = { id: 'merchant', name: 'Merchant', type: 'text' };
const NUMBER: Field = { id: 'no', name: 'Number', type: 'text' };
const EMAIL: Field = { id: 'mail', name: 'Email', type: 'text' };

describe('Check model answers (D-396)', () => {
  it('Discard values not present in text', () => {
    expect(checkAnswer(MERCHANT, 'Starbucks', ['Acme Coffee'], 'en')).toBeNull();
    expect(checkAnswer(AMOUNT, '99.00', ['Total 12.50'], 'en')).toBeNull();
    expect(checkAnswer(DATE, '2026-01-02', ['Total 12.50'], 'en')).toBeNull();
  });

  it('Incomplete words do not count (mobile model answered "No" for Noor Haddad\'s vaccinator)', () => {
    const person: Field = { id: 'person', name: '接种人', type: 'text' };
    expect(checkAnswer(person, 'No', ['Patient: Noor Haddad'], 'en')).toBeNull();
    expect(checkAnswer(person, 'Noor Haddad', ['Patient: Noor Haddad'], 'en')).toBe('Noor Haddad');
    expect(checkAnswer(person, '周明', ['投保人：周明远'], 'zh')).toBe('周明');
  });

  it('Discard null or empty answers', () => {
    expect(checkAnswer(MERCHANT, 'null', ['null'], 'en')).toBeNull();
    expect(checkAnswer(MERCHANT, '  ', ['x'], 'en')).toBeNull();
  });

  it('Numbers in payment/change rows are not amounts; when a total row exists, amounts must be in the total row; amount cannot be 0', () => {
    const rows = ['Total 12.50', 'Cash 20.00', 'Change 7.50'];
    expect(checkAnswer(AMOUNT, '20.00', rows, 'en')).toBeNull();
    expect(checkAnswer(AMOUNT, '12.50', rows, 'en')).toBe('12.5');
    expect(checkAnswer(AMOUNT, '5.00', ['Coffee 5.00', 'Total 12.50'], 'en')).toBeNull();
    expect(checkAnswer(AMOUNT, '0.00', ['Rounding 0.00'], 'en')).toBeNull();
  });

  it('Tax must be in the row labeled with tax terms', () => {
    expect(checkAnswer(TAX, '1.20', ['Coffee 1.20'], 'en')).toBeNull();
    expect(checkAnswer(TAX, '1.20', ['GST 6% 1.20'], 'en')).toBe('1.2');
  });

  it('.00 in Indonesian Rupiah is not a decimal', () => {
    expect(checkAnswer(IDR, '31.000,00', ['Total 31.000,00'], 'en')).toBe('31000');
  });

  it('Dates in validity rows are not document dates, but can be expiry dates', () => {
    const rows = ['本票据使用至 2021-12-31'];
    expect(checkAnswer(DATE, '2021-12-31', rows, 'zh')).toBeNull();
    expect(checkAnswer(DUE, '2021-12-31', rows, 'zh')).toBe('2021-12-31');
  });

  it('Dates are also considered recognizable under alternative day-month readings', () => {
    expect(checkAnswer(DATE, '2026-03-04', ['Date 04/03/2026'], 'en')).toBe('2026-03-04');
    expect(checkAnswer(DATE, '2026-04-03', ['Date 04/03/2026'], 'en')).toBe('2026-04-03');
  });

  it('Document numbers: exclude serial number rows, amount-like or product-like rows, addresses, and strip the NO prefix', () => {
    expect(checkAnswer(NUMBER, '77001234', ['业务流水号 77001234'], 'zh')).toBeNull();
    expect(checkAnswer(NUMBER, '1,234.50', ['No 1,234.50'], 'en')).toBeNull();
    expect(checkAnswer(NUMBER, '12号', ['No 12号'], 'zh')).toBeNull();
    expect(checkAnswer(NUMBER, 'NO8039067', ['票据号 NO8039067'], 'zh')).toBe('8039067');
  });

  it('Complete partial store names into full rows; exclude other label rows, addresses, and labels themselves', () => {
    expect(checkAnswer(MERCHANT, 'Acme', ['Acme Coffee Bar'], 'en')).toBe('Acme Coffee Bar');
    expect(checkAnswer(MERCHANT, 'Sam', ['Cashier: Sam'], 'en')).toBeNull();
    expect(checkAnswer(MERCHANT, 'Jalan Besar', ['Jalan Besar'], 'en')).toBeNull();
    expect(checkAnswer(MERCHANT, 'Merchant', ['Merchant'], 'en')).toBeNull();
  });

  it('Email must contain @', () => {
    expect(checkAnswer(EMAIL, 'acme.com', ['acme.com'], 'en')).toBeNull();
    expect(checkAnswer(EMAIL, 'a@acme.com', ['a@acme.com'], 'en')).toBe('a@acme.com');
  });

  it('Verify multiple candidates in a single answer individually, deduplicate, maximum of 3', () => {
    const rows = ['Acme', 'Beta', 'Gamma', 'Delta'];
    expect(modelAnswers(MERCHANT, 'Acme | Fake | Acme | Beta', rows, 'en')).toEqual([
      'Acme',
      'Beta',
    ]);
    expect(modelAnswers(MERCHANT, 'Acme | Beta | Gamma | Delta', rows, 'en').length).toBe(3);
  });

  it('Misleading rows are hidden from the model, rows with total keywords are kept', () => {
    expect(keepForModel('Tel: 012345')).toBe(false);
    expect(keepForModel('Thank you')).toBe(false);
    expect(keepForModel('现金 50.00')).toBe(false);
    expect(keepForModel('Total Cash 50.00')).toBe(true);
    expect(keepForModel('Acme Coffee')).toBe(true);
  });
});

describe('Arithmetic to find total amount', () => {
  it('Payment − change', () => {
    expect(amountChain(['A 3.00', 'Sum 19.00', 'Cash 20.00', 'Change 1.00'], false, 'en')).toEqual({
      value: 19,
      how: 'payMinusChange',
    });
  });

  it('Subtotal − discount = total; when the subtracted row lacks a discount, take the larger value (gross total − net = tax amount)', () => {
    const rows = ['A 6.00', 'B 4.00', 'Subtotal 10.00'];
    expect(amountChain([...rows, 'Discount 1.00', 'Net 9.00'], false, 'en')).toEqual({
      value: 9,
      how: 'subtotalAdjust',
    });
    expect(amountChain([...rows, 'Excl 9.00', 'Tax 1.00'], false, 'en')?.value).toBe(10);
  });

  it('Subtotal + tax', () => {
    expect(
      amountChain(['A 6.00', 'B 4.00', 'Subtotal 10.00', 'Tax 1.00', 'Total 11.00'], false, 'en'),
    ).toEqual({ value: 11, how: 'subtotalAdjust' });
  });

  it('Subtotal itself; returns null if it cannot be calculated', () => {
    expect(amountChain(['A 6.00', 'B 4.00', 'Total 10.00'], false, 'en')).toEqual({
      value: 10,
      how: 'subtotal',
    });
    expect(amountChain(['Hello', 'A 6.00'], false, 'en')).toBeNull();
  });

  it('Currencies without decimals: read thousands separator as integer, difference of 1 counts as equal', () => {
    expect(amountChain(['A 6.000', 'B 4.000', 'Total 10.001'], true, 'en')?.value).toBe(10001);
  });

  it('Ignore documents with too many numbers (to prevent UI freezing)', () => {
    const rows = Array.from({ length: 200 }, (_, i) => `Item ${i} ${i + 1}.00`);
    expect(amountChain(rows, false, 'en')).toBeNull();
  });
});

describe('Chinese rules', () => {
  it('Uppercase amount in words', () => {
    expect(upperToNumber('贰拾捌元玖角')).toBe(28.9);
    expect(upperToNumber('壹拾元整')).toBe(10);
    expect(upperToNumber('壹万贰仟叁佰元伍角陆分')).toBe(12300.56);
    expect(upperToNumber('今天元')).toBeNull();
  });

  it('Decimal amounts in lowercase are only considered reliable if inside text; integers accidentally matching do not count', () => {
    expect(upperAmount(['合计 贰 拾捌元 玖角', '28.90'])).toEqual({ value: 28.9, sure: true });
    expect(upperAmount(['合计 壹拾元整', '10'])).toEqual({ value: 10, sure: false });
    expect(upperAmount(['合计 12.50'])).toBeNull();
  });

  it('Document number key priority', () => {
    expect(invoiceNoByKey(['NO 11112222', '票据号 NO33334444'])).toBe('33334444');
    expect(invoiceNoByKey(['合计 28.90'])).toBeNull();
    expect(stripNoPrefix('N4510498')).toBe('4510498');
    expect(stripNoPrefix('NORTH1')).toBe('NORTH1');
  });
});

describe('Value memory (invariant 14: queried on demand, not stored separately)', () => {
  const fields: Field[] = [MERCHANT, AMOUNT, { id: 'co', name: 'Company', type: 'text' }];

  it('Take only store name and company fields, deduplicate', () => {
    expect(
      knownValues(fields, [
        { values: { merchant: 'Acme', amount: '5', co: 'Beta Ltd' } },
        { values: { merchant: 'Acme', amount: '5' } },
        { values: { merchant: '  ' } },
      ]),
    ).toEqual({ merchant: ['Acme'], co: ['Beta Ltd'] });
  });

  it('Values missing from text are rejected; spacing variations within a row do not count, and values spanning across rows do not count', () => {
    const page = {
      width: 100,
      height: 100,
      lines: [
        { text: 'BOOK TA K', x: 0, y: 0, width: 50, height: 10 },
        { text: 'SDN BHD', x: 0, y: 20, width: 50, height: 10 },
      ],
    };
    const plan = (known: string[]) =>
      planDocument({ fields: [MERCHANT], pages: [page], locale: 'en', known: { merchant: known } })
        .fields[0]!.remembered?.value;
    expect(plan(['book ta k sdn bhd', 'other'])).toBeUndefined();
    expect(plan(['book tak', 'other'])).toBe('book tak');
  });
});
