import { describe, expect, it } from 'vitest';

import type { Field, Locale } from '../schema';
import { ruleEngine } from './engine';

// Regression guard (D-403): handcrafted Chinese, English, French, Spanish, and German receipts and
// invoices, asserting only previously correct fields, plus 'better empty' cases (no tax label means
// no tax amount, single dates are accepted, completely empty means nothing filled). These tests
// pass on code prior to rule additions; future rule changes causing failures indicate regressions.

const NOW = new Date('2026-11-02T00:00:00Z');

async function run(rows: string[], opts: { currency?: string; locale?: Locale } = {}) {
  const currency = opts.currency ?? 'USD';
  const fields: Field[] = [
    { id: 'total', name: 'Amount', type: 'money', currency } as Field,
    { id: 'tax', name: 'Tax', type: 'money', currency } as Field,
    { id: 'date', name: 'Date', type: 'date' } as Field,
    { id: 'merchant', name: 'Merchant', type: 'text' } as Field,
  ];
  const page = {
    width: 600,
    height: 40 + rows.length * 30,
    lines: rows.map((text, i) => ({ text, x: 20, y: 20 + i * 30, width: 500, height: 24 })),
  };
  const out = await ruleEngine({
    rules: 'receipt',
    fields,
    pages: [page],
    locale: opts.locale ?? 'en',
    now: NOW,
  });
  const values = (id: string) => (out[id] ?? []).map((s) => s.value);
  return {
    total: values('total'),
    tax: values('tax'),
    date: values('date'),
    merchant: values('merchant'),
  };
}
const num = (v: string | undefined) => Number(v);

describe('Chinese', () => {
  it('Supermarket receipt: total, date', async () => {
    const r = await run(
      [
        '美佳乐超市',
        '地址：南山路88号',
        '2026-09-18 14:32:05',
        '矿泉水 2.00',
        '面包 8.50',
        '牛奶 12.80',
        '合计 23.30',
        '微信支付 23.30',
      ],
      { currency: 'CNY', locale: 'zh' },
    );
    expect(num(r.total[0])).toBe(23.3);
    expect(r.date[0]).toBe('2026-09-18');
  });

  it('Pharmacy receipt: provide tax if present, total not carried away by change', async () => {
    const r = await run(
      [
        '康乐药房',
        '2026年09月18日 10:20',
        '感冒灵 28.00',
        '税额 3.22',
        '合计 28.00',
        '现金 30.00',
        '找零 2.00',
      ],
      { currency: 'CNY', locale: 'zh' },
    );
    expect(num(r.total[0])).toBe(28);
    expect(num(r.tax[0])).toBe(3.22);
    expect(r.date[0]).toBe('2026-09-18');
    expect(r.merchant[0]).toBe('康乐药房');
  });

  it('VAT invoice: tax, invoice date, seller', async () => {
    const r = await run(
      [
        '增值税普通发票',
        '开票日期：2026年08月05日',
        '销售方：星河科技有限公司',
        '金额 1000.00',
        '税额 130.00',
        '价税合计 1130.00',
      ],
      { currency: 'CNY', locale: 'zh' },
    );
    expect(num(r.tax[0])).toBe(130);
    expect(r.date[0]).toBe('2026-08-05');
    expect(r.merchant[0]).toBe('星河科技有限公司');
  });

  it('Restaurant receipt: due amount, date, store name', async () => {
    const r = await run(
      ['老张面馆', '日期：2026-10-02', '牛肉面 28.00', '凉菜 12.00', '应收 40.00', '实收 40.00'],
      { currency: 'CNY', locale: 'zh' },
    );
    expect(num(r.total[0])).toBe(40);
    expect(r.date[0]).toBe('2026-10-02');
    expect(r.merchant[0]).toBe('老张面馆');
  });
});

describe('English', () => {
  it('Restaurant: subtotal, tax, total, US-style date with month first', async () => {
    const r = await run([
      "JOE'S DINER",
      '123 Main St',
      '10/02/2026 7:45 PM',
      'Burger 12.00',
      'Fries 4.00',
      'Subtotal 16.00',
      'Tax 1.32',
      'Total 17.32',
      'Visa 17.32',
    ]);
    expect(num(r.total[0])).toBe(17.32);
    expect(num(r.tax[0])).toBe(1.32);
    expect(r.date[0]).toBe('2026-10-02');
    expect(r.merchant[0]).toBe("JOE'S DINER");
  });

  it('Retail: change is not total', async () => {
    const r = await run([
      'NORTHSIDE HARDWARE',
      'Store 1234',
      '03/14/2026',
      'Hammer 15.99',
      'Nails 4.50',
      'Sub Total 20.49',
      'Sales Tax 1.64',
      'Total 22.13',
      'Cash 25.00',
      'Change 2.87',
    ]);
    expect(num(r.total[0])).toBe(22.13);
    expect(num(r.tax[0])).toBe(1.64);
    expect(r.date[0]).toBe('2026-03-14');
    expect(r.merchant[0]).toBe('NORTHSIDE HARDWARE');
  });

  it('Invoice: Total due, Invoice date, company name', async () => {
    const r = await run([
      'Acme Plumbing LLC',
      'Invoice No 2026-114',
      'Invoice date: 2026-05-12',
      'Description Amount',
      'Repair service 250.00',
      'Subtotal 250.00',
      'Tax 20.00',
      'Total due 270.00',
    ]);
    expect(num(r.total[0])).toBe(270);
    expect(num(r.tax[0])).toBe(20);
    expect(r.date[0]).toBe('2026-05-12');
    expect(r.merchant[0]).toBe('Acme Plumbing LLC');
  });

  it('Receipt without tax specified: total, date, store name still provided', async () => {
    const r = await run([
      'FARMERS MARKET STAND',
      'June 4, 2026',
      'Apples 6.00',
      'Pears 4.00',
      'Total 10.00',
      'Cash 10.00',
    ]);
    expect(num(r.total[0])).toBe(10);
    expect(r.date[0]).toBe('2026-06-04');
    expect(r.merchant[0]).toBe('FARMERS MARKET STAND');
  });
});

describe('French', () => {
  it('Restaurant: Total TTC, montant TVA', async () => {
    const r = await run(
      [
        'BRASSERIE DU COIN',
        '12 rue des Fleurs',
        'Date : 14/03/2026',
        'Plat du jour 14,50',
        'Boisson 3,50',
        'Total TTC 18,00',
        'dont TVA 10% 1,64',
        'Carte bancaire 18,00',
      ],
      { currency: 'EUR', locale: 'fr' },
    );
    expect(num(r.total[0])).toBe(18);
    expect(num(r.tax[0])).toBe(1.64);
    expect(r.date[0]).toBe('2026-03-14');
    expect(r.merchant[0]).toBe('BRASSERIE DU COIN');
  });

  it('Invoice: day first', async () => {
    const r = await run(
      [
        'Dupont Plomberie SARL',
        'Facture n° F-2026-051',
        'Date de facture : 03/04/2026',
        "Main d'oeuvre 200,00",
        'Total HT 200,00',
        'TVA 20% 40,00',
        'Total TTC 240,00',
      ],
      { currency: 'EUR', locale: 'fr' },
    );
    expect(num(r.total[0])).toBe(240);
    expect(num(r.tax[0])).toBe(40);
    expect(r.date[0]).toBe('2026-04-03');
    expect(r.merchant[0]).toBe('Dupont Plomberie SARL');
  });

  it('Single date provided even when only one exists', async () => {
    const r = await run(['Boulangerie Martin', '28/02/2026', 'Baguette 1,20', 'Total 1,20'], {
      currency: 'EUR',
      locale: 'fr',
    });
    expect(r.date).toEqual(['2026-02-28']);
    expect(num(r.total[0])).toBe(1.2);
    expect(r.merchant[0]).toBe('Boulangerie Martin');
  });
});

describe('Spanish', () => {
  it('Receipt: no tax specified means no tax amount', async () => {
    const r = await run(
      [
        'SUPERMERCADO LA PLAZA',
        'Fecha: 21/05/2026',
        'Leche 1,10',
        'Pan 0,90',
        'Total 2,00',
        'Efectivo 5,00',
        'Cambio 3,00',
      ],
      { currency: 'EUR', locale: 'fr' },
    );
    expect(num(r.total[0])).toBe(2);
    expect(r.tax).toEqual([]);
    expect(r.date[0]).toBe('2026-05-21');
    expect(r.merchant[0]).toBe('SUPERMERCADO LA PLAZA');
  });

  it('Invoice: Total factura, date, company', async () => {
    const r = await run(
      [
        'Servicios Torres SL',
        'Factura 2026/77',
        'Fecha 15/06/2026',
        'Base imponible 100,00',
        'IVA 21% 21,00',
        'Total factura 121,00',
      ],
      { currency: 'EUR', locale: 'fr' },
    );
    expect(num(r.total[0])).toBe(121);
    expect(r.date[0]).toBe('2026-06-15');
    expect(r.merchant[0]).toBe('Servicios Torres SL');
  });
});

describe('German', () => {
  it('Cash register receipt: Summe, not Gegeben', async () => {
    const r = await run(
      [
        'BAECKEREI MUELLER',
        'Datum 12.03.2026',
        'Brötchen 1,20',
        'Summe 1,20',
        'Gegeben 5,00',
        'Rückgeld 3,80',
      ],
      { currency: 'EUR', locale: 'fr' },
    );
    expect(num(r.total[0])).toBe(1.2);
    expect(r.date[0]).toBe('2026-03-12');
    expect(r.merchant[0]).toBe('BAECKEREI MUELLER');
  });

  it('Invoice: Gesamtbetrag, Rechnungsdatum', async () => {
    const r = await run(
      [
        'Schmidt Elektro GmbH',
        'Rechnungsnummer 2026-88',
        'Rechnungsdatum: 20.04.2026',
        'Nettobetrag 100,00',
        'MwSt 19% 19,00',
        'Gesamtbetrag 119,00',
      ],
      { currency: 'EUR', locale: 'fr' },
    );
    expect(num(r.total[0])).toBe(119);
    expect(r.date[0]).toBe('2026-04-20');
    expect(r.merchant[0]).toBe('Schmidt Elektro GmbH');
  });
});

describe('Better empty', () => {
  it('Completely empty document: amount, tax, and date are left blank', async () => {
    const r = await run(['Thank you', 'Please come again', 'Have a nice day']);
    expect(r.total).toEqual([]);
    expect(r.tax).toEqual([]);
    expect(r.date).toEqual([]);
  });

  it('Two dates: invoice date ranked first, due date does not preempt', async () => {
    const r = await run(['Shop', 'Date 2026-03-04', 'Due date 2026-04-03', 'Total 8.00']);
    expect(r.date[0]).toBe('2026-03-04');
    expect(r.tax).toEqual([]);
  });
});
