import { describe, expect, it } from 'vitest';

import type { Field, Locale } from '../schema';
import { ruleEngine } from './engine';

// D-403: One test per behavioral rule in the prefill engine. Texts are handcrafted receipts; each
// failed on code prior to its rule addition. Assertions specify expected behavior. Regression guard
// is in receipt-guard.test.ts.

const NOW = new Date('2026-11-02T00:00:00Z');

/** Row-by-row text; a row can be several segments [text, x] (multiple columns in the same row). */
type Row = string | [string, number][];

async function run(rows: Row[], opts: { currency?: string; locale?: Locale; now?: Date } = {}) {
  const currency = opts.currency ?? 'USD';
  const fields: Field[] = [
    { id: 'total', name: 'Amount', type: 'money', currency } as Field,
    { id: 'tax', name: 'Tax', type: 'money', currency } as Field,
    { id: 'date', name: 'Date', type: 'date' } as Field,
    { id: 'merchant', name: 'Merchant', type: 'text' } as Field,
  ];
  const lines = rows.flatMap((row, i) =>
    (typeof row === 'string' ? [[row, 20] as [string, number]] : row).map(([text, x]) => ({
      text,
      x,
      y: 20 + i * 30,
      width: text.length * 10,
      height: 24,
    })),
  );
  const page = { width: 600, height: 40 + rows.length * 30, lines };
  const out = await ruleEngine({
    rules: 'receipt',
    fields,
    pages: [page],
    locale: opts.locale ?? 'en',
    now: opts.now ?? NOW,
  });
  const values = (id: string) => (out[id] ?? []).map((s) => s.value);
  return {
    total: values('total'),
    tax: values('tax'),
    date: values('date'),
    merchant: values('merchant'),
  };
}
const n = (v: string | undefined) => Number(v);

describe('Total', () => {
  it('Japanese total term is total, while subtotal, deposit, and change are not', async () => {
    const r = await run(
      [
        'ファミリー商店',
        '2025年11月3日',
        'おにぎり ¥150',
        'お茶 ¥140',
        '小計 ¥290',
        '合計 ¥313',
        'お預り ¥1000',
        'お釣り ¥687',
      ],
      { currency: 'JPY', locale: 'zh' },
    );
    expect(n(r.total[0])).toBe(313);
  });

  it('Integers immediately following labels are also totals (without two decimal places)', async () => {
    const r = await run(['SHOP SDN BHD', '12/11/2025', 'Total:20', 'Cash:50'], { currency: 'MYR' });
    expect(r.total.map(Number)).toEqual([20]);
  });

  it('Malaysian Ringgit adjacent to number (RM33.90) is also an amount, not a reference number (D-549)', async () => {
    const r = await run(['RESTORAN ALI', 'TOTAL RM33.90', 'Tunai RM50.00'], { currency: 'MYR' });
    expect(n(r.total[0])).toBe(33.9);
    // Ignore items preceded by letters (FORM12.00, serial numbers).
    const id = await run(['Shop', 'FORM12.00', 'Total 4.50']);
    expect(id.total.map(Number)).not.toContain(12);
  });

  it('Tied total candidates: larger ones derivable by adding other candidates are ranked first', async () => {
    const r = await run(['Shop', 'Total 10.00', 'Total 3.00', 'Total 7.00']);
    expect(r.total.map(Number)).toEqual([10, 7, 3]);
  });

  it('Spaces as thousand separators (3 620,84 €) taken as a whole, not split into 620,84', async () => {
    const r = await run(
      [
        'Facture',
        'Date 12/03/2025',
        'Total HT 3 017,37 €',
        'TVA 20% 603,47 €',
        'Total TTC 3 620,84 €',
      ],
      { currency: 'EUR', locale: 'fr' },
    );
    expect(r.total.map(Number)).toEqual([3620.84]);
  });

  it("A row of 'label + three numbers' A + B = C: C is the total", async () => {
    const r = await run(['Shop', '03/11/2025', 'Net Tax Total 100.00 8.00 108.00']);
    expect(n(r.total[0])).toBe(108);
  });

  it('Tax-inclusive total is a total; quantity and Total tax do not preempt total', async () => {
    const r = await run([
      'Shop',
      'Total qty 3.00',
      'Subtotal 30.00',
      'Vat 6.00',
      'Total incl tax 36.00',
    ]);
    expect(n(r.total[0])).toBe(36);
    expect(r.total.map(Number)).not.toContain(3);
  });

  it('German: Summe is total, Gegeben and Rückgeld are not', async () => {
    const r = await run(
      [
        'Kassenbon',
        'Datum 12.03.2025',
        'Brot 2,50',
        'Kaffee 4,90',
        'Summe 7,40',
        'Gegeben 10,00',
        'Rückgeld 2,60',
      ],
      { currency: 'EUR', locale: 'fr' },
    );
    expect(n(r.total[0])).toBe(7.4);
  });

  it('German: When no total label exists, payment Bar minus Rückgeld is the total amount', async () => {
    const r = await run(
      ['Laden', '12.03.2025', 'Brot 2,50', 'Kaffee 4,90', '7,40', 'Bar 10,00', 'Rückgeld 2,60'],
      { currency: 'EUR', locale: 'fr' },
    );
    expect(n(r.total[0])).toBe(7.4);
  });

  it('When amounts all have two decimal places, integer amounts ($20) are ranked after those with decimals', async () => {
    const r = await run(['Shop', 'Total $20', 'Total 15.50']);
    expect(n(r.total[0])).toBe(15.5);
  });

  it('Numbers labeled as total are ranked first; those derived purely from itemized sums do not preempt', async () => {
    const r = await run(['Total 9.00', 'Coffee 3.00', 'Muffin 4.00', 'Cash 20.00', 'Change 7.00']);
    expect(n(r.total[0])).toBe(9);
  });
});

describe('Tax amount', () => {
  it('Japanese consumption tax term is tax amount', async () => {
    const r = await run(
      ['ファミリー商店', '2025年11月3日', '小計 ¥290', '消費税 ¥23', '合計 ¥313'],
      {
        currency: 'JPY',
        locale: 'zh',
      },
    );
    expect(n(r.tax[0])).toBe(23);
  });

  it('Integers immediately following labels are also tax amounts', async () => {
    const r = await run(
      ['SHOP SDN BHD', '12/11/2025', 'Subtotal: 100.00', 'GST:6', 'Total: 106.00'],
      {
        currency: 'MYR',
      },
    );
    expect(r.tax.map(Number)).toEqual([6]);
  });

  it('Numbers matching the tax rate on the ticket are ranked first', async () => {
    const r = await run(['Shop', 'Subtotal 100.00', 'Tax 107.00', 'Tax 7% 7.00']);
    expect(n(r.tax[0])).toBe(7);
  });

  it('Tax candidates that can add up to other amounts are ranked higher; for ties, take the smaller one', async () => {
    const r = await run(['Shop', 'Tax 54.00', 'Tax 4.00', 'Net 50.00']);
    expect(n(r.tax[0])).toBe(4);
  });

  it('Tax amount is recognized even with labels like 14VAT', async () => {
    const r = await run(['Shop', 'Sales 100.00', '14VAT 14.00', 'Total 114.00']);
    expect(n(r.tax[0])).toBe(14);
  });

  it("In a 'label + three numbers' row, the middle one is the tax amount", async () => {
    const r = await run(['Shop', 'Subtotal Tax Total', '100.00 8.00 108.00']);
    expect(n(r.tax[0])).toBe(8);
  });

  it("Amounts where 'tax amount + X = maximum amount in text' enter candidates even without a tax label", async () => {
    const r = await run(['Shop', 'Items 50.00', 'Surcharge 4.00', 'Total 54.00', 'VAT included']);
    expect(n(r.tax[0])).toBe(4);
  });

  it('Receipts without a tax label do not receive tax amount candidates (better empty)', async () => {
    const r = await run(['Shop', 'Item 40.00', 'Discount 5.00', 'Total 35.00']);
    expect(r.tax).toEqual([]);
  });

  it('When no tax keyword appears anywhere in the text, isolated numbers are not treated as tax amounts', async () => {
    const r = await run(['Shop', 'thank you', 'Ref', '3.20']);
    expect(r.tax).toEqual([]);
  });

  // Old code lacked 'deduct points when tax is missing'; these cases passed on old code naturally.
  // They guard against new deductions over-penalizing: when restricted to English, French, Spanish,
  // German, Italian, Dutch, and 'tax' vocabularies, Arabic, Russian, Portuguese, Korean, Turkish,
  // and Polish fail (see DECISIONS D-403).
  it.each([
    ['阿拉伯语', 'EGP', 'ضريبة القيمة المضافة مشمولة'],
    ['俄语', 'RUB', 'В том числе НДС'],
    ['葡萄牙语', 'BRL', 'Imposto incluso'],
    ['韩语', 'KRW', '부가세 포함'],
    ['土耳其语', 'TRY', 'KDV dahil'],
    ['波兰语', 'PLN', 'zawiera PTU'],
    ['日语', 'JPY', '消費税込み'],
    ['中文', 'CNY', '含税价'],
  ])('Tax wording in %s: isolated tax amounts are not penalized', async (_name, currency, line) => {
    const r = await run(['Shop', line, 'Ref', '3.20'], { currency });
    expect(r.tax).toEqual(['3.20']);
  });
});

describe('Date', () => {
  it('Numeric dates with year at the end separated by hyphens have day first', async () => {
    const r = await run(['Shop', 'Date 05-03-2026', 'Total 5.00']);
    expect(r.date[0]).toBe('2026-03-05');
  });

  it('Document currency is Euro, 03/04/2026 is April 3', async () => {
    const r = await run(['Shop', 'Date 03/04/2026', 'Total 5.00'], { currency: 'EUR' });
    expect(r.date[0]).toBe('2026-04-03');
  });

  it('Text containing £ or VAT (without $) has day first', async () => {
    const gbp = await run(['Shop', 'Date 03/04/2026', 'Total £5.00'], { currency: 'GBP' });
    expect(gbp.date[0]).toBe('2026-04-03');
    const vat = await run(['Shop Ltd', 'VAT No 123', 'Date 03/04/2026', 'Total 5.00']);
    expect(vat.date[0]).toBe('2026-04-03');
  });

  it('Has GST without Canadian provincial tax: day first', async () => {
    const r = await run(['Shop', 'GST 0.45', 'Date 03/04/2026', 'Total 5.00'], { currency: 'AUD' });
    expect(r.date[0]).toBe('2026-04-03');
  });

  it("When the document has explicit evidence like '25/12/2025', obey it (regardless of UI language)", async () => {
    const r = await run(['Shop', 'Date 03/04/2026', 'Ref 25/12/2025', 'Total $5.00']);
    expect(r.date.indexOf('2026-04-03')).toBeGreaterThanOrEqual(0);
    expect(r.date.indexOf('2026-04-03')).toBeLessThan(
      r.date.indexOf('2026-03-04') < 0 ? 99 : r.date.indexOf('2026-03-04'),
    );
  });

  it('Recognized even when time and date are stuck together', async () => {
    const r = await run(['Shop', 'Total 5.00', '23:16:4615/08/2025']);
    expect(r.date).toEqual(['2025-08-15']);
  });

  it('Unlabeled real dates are not crowded out of the window by a fake date', async () => {
    const r = await run(['Shop', 'Ref 2010-02-19', '2026-03-05', 'Total 5.00']);
    expect(r.date).toEqual(['2026-03-05']);
  });

  it('Return period is not invoice date, but invoice date on the same row remains', async () => {
    const r = await run(['Shop', 'Date 03/04/2026 Return by 03/20/2026', 'Total 5.00']);
    expect(r.date).not.toContain('2026-03-20');
    expect(r.date[0]).toBe('2026-03-04');
  });

  it('1-2-25 in Japanese addresses is not a date', async () => {
    const r = await run(['ファミリー 東京都渋谷区神南 1-2-25', 'Total 500', '2026-01-05'], {
      currency: 'JPY',
    });
    expect(r.date).toEqual(['2026-01-05']);
  });

  it('Print dates are sorted to the end', async () => {
    const r = await run(['Shop', 'Printed 2026-11-01', 'Date 2026-10-30', 'Total 5.00']);
    expect(r.date).toEqual(['2026-10-30', '2026-11-01']);
  });

  it.each([
    ['28-Oct-2025', 'Date 28-Oct-2025', '2025-10-28', 'USD'],
    ['西语「3 de enero de 2026」', 'Fecha 3 de enero de 2026', '2026-01-03', 'EUR'],
    ['德语「15. März 2026」', '15. März 2026', '2026-03-15', 'EUR'],
  ])('Month name spelling %s', async (_name, row, expected, currency) => {
    const r = await run(['Shop', row, 'Total 5.00'], { currency });
    expect(r.date).toEqual([expected]);
  });

  it('Two-digit year 99 is 1999, not 2099', async () => {
    const r = await run(['Shop', 'Date 15/08/99', 'Total 5.00']);
    expect(r.date).toEqual(['1999-08-15']);
  });

  it('Two-digit year dates must have consistent separators (12-05/26 is not a date)', async () => {
    const r = await run(['Shop', 'Ref 12-05/26', 'Total 5.00']);
    expect(r.date).toEqual([]);
  });

  it("'Date sent' is not invoice date", async () => {
    const r = await run(['Shop', 'Date sent: 2026-01-02', 'Order date: 2026-01-01', 'Total 5.00']);
    expect(r.date[0]).toBe('2026-01-01');
  });

  it('Standalone date at the very top of the page is given even if other dates are numerous and its score is below threshold', async () => {
    const r = await run([
      '12 Jan 2026',
      'Shop A',
      'Item 01/02/2026 2.00',
      'Item 02/02/2026 3.00',
      'Item 03/02/2026 4.00',
      'Item 04/02/2026 5.00',
      'Item 05/02/2026 6.00',
    ]);
    expect(r.date).toEqual(['2026-01-12']);
  });
});

describe('Store name', () => {
  it("Document name 'SALES RECEIPT' is not a store name", async () => {
    const r = await run(['SALES RECEIPT', 'Joes Diner', 'Total 5.00']);
    expect(r.merchant).toEqual(['Joes Diner']);
  });

  it('Japanese receipt term is not store name, only those with corporate suffix are', async () => {
    const r = await run(['領収書', '2025年11月3日', '合計 ¥500', '株式会社ファミリー商事'], {
      currency: 'JPY',
      locale: 'zh',
    });
    expect(r.merchant[0]).toBe('株式会社ファミリー商事');
  });

  it("'Store: Downtown Branch' is a branch; store name is at the top", async () => {
    const r = await run(['JOES DINER', 'Store: Downtown Branch', 'Total 5.00']);
    expect(r.merchant).toEqual(['JOES DINER']);
  });

  it("Short word in previous row (Pago) just happens to look like 'store', not a store name label", async () => {
    const r = await run(
      [
        'Ropa Outdoor Norte',
        'Emisor',
        'Factura B',
        'Domicilio: San Martin 300',
        'Receptor',
        'Pago',
        'Total 55,00',
      ],
      { currency: 'ARS' },
    );
    expect(r.merchant[0]).toBe('Ropa Outdoor Norte');
  });

  it("Strip 'Welcome to'", async () => {
    const r = await run(['Welcome to Joes Diner', 'Total 5.00']);
    expect(r.merchant).toEqual(['Joes Diner']);
  });

  it('Standalone rows with company suffixes added to candidates', async () => {
    const r = await run(['Tel 123', 'Order 55', 'Thank you', 'Foo Bar Trading Pty', 'Total 5.00']);
    expect(r.merchant).toEqual(['Foo Bar Trading Pty']);
  });

  it("Store names containing 'Supermarket' or 'Street' are not excluded for looking like addresses", async () => {
    const zh = await run(['大润发超市', '合计 12.00'], { currency: 'CNY', locale: 'zh' });
    expect(zh.merchant).toEqual(['大润发超市']);
    const en = await run(['12 Main Street Cafe', 'Total 12.00']);
    expect(en.merchant).toEqual(['12 Main Street Cafe']);
  });

  it("'Powered by' is not a store name", async () => {
    const r = await run(['Powered by Toast', 'Joes Diner', 'Total 5.00']);
    expect(r.merchant).toEqual(['Joes Diner']);
  });

  it("In the row below 'Seller: Client:' header, the left cell is the seller", async () => {
    const r = await run([
      'INVOICE',
      'Invoice No 77',
      [
        ['Seller:', 20],
        ['Client:', 300],
      ],
      [
        ['Acme Supplies Ltd', 20],
        ['Contoso Trading Inc', 300],
      ],
      [
        ['12 Oak Road', 20],
        ['9 Pine Road', 300],
      ],
      'Total 5.00',
    ]);
    expect(r.merchant[0]).toBe('Acme Supplies Ltd');
  });

  it('Invoice: Issuer (Supplier) is ranked before recipient (Bill to)', async () => {
    const r = await run([
      'INVOICE',
      'Bill to',
      'Acme Corp',
      'Invoice No 1',
      'Due date 2026-03-01',
      'Supplier',
      'Joes Plumbing',
      'Amount due 55.00',
    ]);
    expect(r.merchant[0]).toBe('Joes Plumbing');
  });
});
