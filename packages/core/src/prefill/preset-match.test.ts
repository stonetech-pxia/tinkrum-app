import { describe, expect, it } from 'vitest';

import {
  presetAnswer,
  presetMatchRequest,
  rankPresets,
  recommendPreset,
  rulePreset,
} from './preset-match';
import type { TextPage } from './rows';

const doc = (...rows: string[]): TextPage[] => [
  {
    width: 800,
    height: 1100,
    lines: rows.map((text, i) => ({ text, x: 40, y: 40 + i * 30, width: 400, height: 16 })),
  },
];

describe('rankPresets', () => {
  it('No amount: presets requiring amounts are sorted to the end without being hidden', () => {
    const r = rankPresets(doc('Vaccination record', 'Name: Ana', 'Dose 1: 3 March 2025'));
    expect(r.unlikely).toEqual(expect.arrayContaining(['purchase', 'bill', 'payslip']));
    expect(r.likely).toContain('vaccination');
    expect(r.likely).not.toContain('purchase');
    expect([...r.likely, ...r.unlikely]).toHaveLength(21);
  });
  it('Has amount: keep all', () => {
    expect(rankPresets(doc('Total 48.60 €')).unlikely).toEqual([]);
    expect(rankPresets(doc('合计 2380.00元')).unlikely).toEqual([]);
  });
  it('Passport MRZ sorted to the very top', () => {
    expect(rankPresets(doc('P<GBRSMITH<<ANNA<MARIE<<<<<<<<')).likely[0]).toBe('identity');
  });
  it('Nothing sorted to the end when text is empty', () => {
    expect(rankPresets([]).unlikely).toEqual([]);
  });
});

describe('folded in rankPresets (amount categories with totals merged into shopping receipts, D-480)', () => {
  it('Has totals and amounts: bank, billing, loan, payslip, expense report, and tax are excluded from model selection but remain in the list', () => {
    const r = rankPresets(doc('Total 48.60 €'));
    expect(r.folded).toEqual(['bank', 'bill', 'loan', 'payslip', 'reimbursement', 'tax']);
    expect(r.likely).toEqual(expect.arrayContaining(['bill', 'purchase', 'bank', 'payslip']));
  });
  it('Has amount but no total keyword: do not merge', () => {
    expect(rankPresets(doc('Premium 45.00 €')).folded).toEqual([]);
  });
  it('No folded when amount is absent', () => {
    expect(rankPresets(doc('Dose 1: 3 March 2025')).folded).toEqual([]);
  });
});

describe('presetMatchRequest / presetAnswer', () => {
  it('Catalog contains only provided presets, grammar must answer them or none', () => {
    const q = presetMatchRequest(doc('Hello'), ['bill', 'tax']);
    expect(q.prompt).toContain('bill: ');
    expect(q.prompt).not.toContain('payslip:');
    expect(q.grammar).toBe('root ::= "bill" | "tax" | "none"\n');
  });
  it('none and items outside the catalog evaluate to null', () => {
    expect(presetAnswer('bill', ['bill'])).toBe('bill');
    expect(presetAnswer('none', ['bill'])).toBeNull();
    expect(presetAnswer('tax', ['bill'])).toBeNull();
  });
});

describe('Catalog for recommendPreset', () => {
  it('Has amount: billing, loan, expense report, and tax are absent from catalog, shopping receipt description includes them', async () => {
    const prompts: string[] = [];
    const open = async () => ({
      generate: async (r: { prompt: string }) => {
        prompts.push(r.prompt);
        return 'purchase';
      },
      release: async () => undefined,
    });
    const got = await recommendPreset(open, doc('Invoice 7', 'Total 48.60 €'));
    expect(got).toBe('purchase');
    expect(prompts[0]).toContain('purchase: ');
    for (const id of ['bill', 'loan', 'reimbursement', 'tax']) {
      expect(prompts[0]).not.toContain(`\n${id}: `);
    }
    expect(prompts[0]).toMatch(/purchase: [^\n]*invoice/);
  });
});

describe('recommendPreset', () => {
  const session = (answer: string, released: string[]) => ({
    generate: async () => answer,
    release: async () => {
      released.push('released');
    },
  });
  it('Recommend when answer is correct, release after use', async () => {
    const released: string[] = [];
    const got = await recommendPreset(async () => session('insurance', released), doc('Policy'));
    expect(got).toBe('insurance');
    await Promise.resolve();
    expect(released).toEqual(['released']);
  });
  it('Model not installed, loading failed, or no text: all return null', async () => {
    expect(await recommendPreset(async () => null, doc('Policy'))).toBeNull();
    expect(
      await recommendPreset(async () => {
        throw new Error('boom');
      }, doc('Policy')),
    ).toBeNull();
    let opened = false;
    await recommendPreset(async () => {
      opened = true;
      return null;
    }, []);
    expect(opened).toBe(false);
  });
});

describe('rulePreset (when no local model is present, clearly recognizable receipts should still recommend shopping receipts)', () => {
  it('English receipt', () => {
    expect(
      rulePreset(
        doc(
          'CORNER MARKET',
          'Milk 2.49',
          'Bread 3.10',
          'Subtotal 5.59',
          'Tax 0.45',
          'Total 6.04',
          'Cash 10.00',
          'Change 3.96',
        ),
      ),
    ).toBe('purchase');
  });
  it('French receipt', () => {
    expect(
      rulePreset(
        doc(
          'BOULANGERIE',
          'Pain 1,20',
          'Croissant 1,10',
          'TVA 0,13',
          'Total TTC 2,30 €',
          'Carte bancaire',
        ),
      ),
    ).toBe('purchase');
  });
  it('Lidl receipt (recognition with typos)', () => {
    expect(
      rulePreset(
        doc(
          'LIDL',
          'Place Salvador Allendé',
          'FR93170BAGNOLET',
          'Ticket de vente',
          'Article P.U.EUR Qté EUR',
          'Oeufs sol x12 2,76 1 2,76 A T',
          'Pizza jambon fromage 2,29 1 2,29 A T',
          'Nombre de lignes: 5',
          'A payer 14,60',
          '13,84 HT',
          'Fotal éligible TR (T) : 14,60',
          ':arte 14,60',
          'VA Taux MONT.TTC MONT.TVA TOTAL HT',
          'A 5,5% 14,60 0,76 13,84',
        ),
      ),
    ).toBe('purchase');
  });
  it('Chinese receipt', () => {
    expect(
      rulePreset(doc('永辉超市小票', '牛奶 12.50', '面包 8.00', '合计 20.50', '微信支付 20.50')),
    ).toBe('purchase');
  });
  it('Bills, loans, taxes, and reimbursements with a total amount also use shopping vouchers (D-476)', () => {
    expect(
      rulePreset(doc('Invoice 2025-03', 'Due date 1 April', 'Amount due 120.00 €', 'VAT 20.00')),
    ).toBe('purchase');
    expect(rulePreset(doc('Avis d’impôt', 'Montant à payer 1 240,00 €'))).toBe('purchase');
    expect(rulePreset(doc('Expense claim', 'Taxi 18.50', 'Hotel 120.00', 'Total 138.50'))).toBe(
      'purchase',
    );
  });
  it('Bank statements and payslips with totals also use shopping vouchers (D-480)', () => {
    expect(
      rulePreset(doc('Invoice 2025-03', 'Amount due 120.00 €', 'IBAN FR7612345678901234567890123')),
    ).toBe('purchase');
    expect(
      rulePreset(doc('Payslip March', 'Gross 3000.00', 'Net pay 2300.00', 'Total 2300.00')),
    ).toBe('purchase');
    expect(rulePreset(doc('工资条', '应发合计 8 000.00', '实发合计 6 512.30'))).toBe('purchase');
  });
  it('No amount, no text, contracts, and insurance policies are all not recommended', () => {
    expect(
      rulePreset(
        doc('SERVICE AGREEMENT', 'between Acme Ltd and Beta SARL', 'Total fee 5 000.00 €'),
      ),
    ).toBeNull();
    expect(rulePreset(doc('Policy number 88-221', 'Total premium 45.00 €'))).toBeNull();
    expect(rulePreset(doc('Vaccination record', 'Dose 1: 3 March 2025'))).toBeNull();
    expect(rulePreset([])).toBeNull();
  });
});
