import { describe, expect, it } from 'vitest';

import { createDefaultWorkspace } from '../defaults';
import type { Field, Locale } from '../schema';
import { templateCollectionOp } from '../templates';
import { categoryByLexicon } from './category';
import { conceptOf } from './concepts';
import { modelEngine, ruleEngine } from './engine';
import { planDocument } from './code-rules';
import type { ModelRequest, OpenModel } from './model';

// Receipt template "category" (D-405): if the lexicon is confident, provide candidates directly;
// otherwise prompt the local model; answers only enter candidates. The receipt texts below are
// self-compiled short examples, not real receipts.

const pageOf = (rows: string[]) => ({
  width: 600,
  height: 40 + rows.length * 30,
  lines: rows.map((text, i) => ({ text, x: 20, y: 20 + i * 30, width: 500, height: 24 })),
});
const now = new Date('2026-11-01T00:00:00Z');
const OPTIONS = [
  { id: 'dining', label: 'Dining' },
  { id: 'grocery', label: 'Grocery' },
  { id: 'pharmacy', label: 'Drugstore' },
  { id: 'other-shopping', label: 'Other shopping' },
  { id: 'transport', label: 'Transport' },
  { id: 'other', label: 'Other' },
];
const CATEGORY: Field = { id: 'category', name: 'Category', type: 'choice', options: OPTIONS };
const AMOUNT: Field = { id: 'total', name: 'Amount', type: 'money', currency: 'USD' };

// A store unrecognized by the lexicon (no store name, no receipt terms).
const PLAIN = ['Zeta Corner', 'Item A 3.00', 'Item B 4.00', 'Total 7.00'];

function fakeModel(answer: string | ((req: ModelRequest) => string)) {
  const asked: ModelRequest[] = [];
  const state = { released: 0, opened: 0 };
  const open: OpenModel = async () => {
    state.opened++;
    return {
      generate: async (req) => {
        asked.push(req);
        return typeof answer === 'function' ? answer(req) : answer;
      },
      release: async () => {
        state.released++;
      },
    };
  };
  return { open, asked, state };
}

const run = (rows: string[], fields: Field[] = [CATEGORY]) => ({
  rules: 'receipt' as const,
  fields,
  pages: [pageOf(rows)],
  locale: 'en' as const,
  now,
});

describe('Lexicon', () => {
  it.each([
    [['Sunrise Pharmacy', 'Aspirin 4.00'], 'pharmacy'],
    [['Blue Door Bistro', 'Table 7', 'Pasta 12.00', 'Service charge 1.20'], 'dining'],
    [['City Parking', 'Entry 08:10', 'Exit 11:40', 'Fee 6.50'], 'transport'],
    [['Station-service Nord', 'Gazole 40.2 L', 'Total 70.00'], 'transport'],
    [['大众药房', '感冒灵 12.00'], 'pharmacy'],
    [['老张面馆', '牛肉面 18.00'], 'dining'],
    [['Supermarché du Port', 'Pain 1,20'], 'grocery'],
    [['Grand Hotel', 'Chambre 120,00'], 'other'],
  ])('%j → %s', (rows, expected) => {
    expect(categoryByLexicon(rows)).toBe(expected);
  });

  it('Do not guess unrecognized stores; a single occurrence of a category word outside the store name area (1 point) is also insufficient', () => {
    expect(categoryByLexicon(PLAIN)).toBeNull();
    expect(
      categoryByLexicon([...PLAIN, 'Thank you', 'See you', 'Visit us', 'Online', 'cafe']),
    ).toBeNull();
    expect(categoryByLexicon([])).toBeNull();
  });

  it('Do not select when categories are equally strong', () => {
    expect(categoryByLexicon(['Pharmacy Cafe Corner', 'Item 1.00'])).toBeNull();
  });
});

describe('Receipt template category field', () => {
  it.each([
    [
      'en',
      'Category',
      ['Dining', 'Grocery & convenience', 'Drugstore', 'Other shopping', 'Transport', 'Other'],
    ],
    ['zh', '分类', ['餐饮', '超市便利店', '药妆', '其他购物', '交通', '其他']],
    [
      'fr',
      'Catégorie',
      [
        'Restauration',
        'Supermarché et supérette',
        'Pharmacie et beauté',
        'Autres achats',
        'Transport',
        'Autre',
      ],
    ],
  ] as [Locale, string, string[]][])(
    'Present in all three languages with the same ID, fields recognized as category concept (%s)',
    (locale, name, labels) => {
      const table = templateCollectionOp('purchase', createDefaultWorkspace(locale), locale).table;
      const f = table.fields.find((x) => x.id === 'category')!;
      expect(f.name).toBe(name);
      expect(f.type === 'choice' && f.options.map((o) => o.label)).toEqual(labels);
      expect(f.type === 'choice' && f.options.map((o) => o.id)).toEqual(OPTIONS.map((o) => o.id));
      expect(conceptOf(f)).toBe('category');
    },
  );
});

describe('Category field candidates', () => {
  it('Lexicon confident: candidate is the option ID, model is not asked, and there is no position (tap count not recorded)', async () => {
    const rows = ['Sunrise Pharmacy', 'Aspirin 4.00', 'Total 4.00'];
    const plan = planDocument(run(rows));
    expect(plan.fields[0]!.ask).toBe(false);
    const m = fakeModel('grocery');
    const out = await modelEngine(m.open)(run(rows));
    expect(out.category).toEqual([{ value: 'pharmacy', score: 0 }]);
    expect(m.state.opened).toBe(0);
    // Works even without the model installed (rules only).
    expect((await ruleEngine(run(rows))).category).toEqual([{ value: 'pharmacy', score: 0 }]);
  });

  it('Option name printed on the receipt: candidate remains the same (rule scoring), model is not asked', async () => {
    const plan = planDocument(run([...PLAIN, 'Category: Transport']));
    expect(plan.fields[0]!.ask).toBe(false);
    expect(plan.fields[0]!.code[0]?.value).toBe('transport');
  });

  it("Lexicon uncertain: ask the model, answers are in candidates, and grammar is restricted to the current table's options only", async () => {
    const m = fakeModel('grocery');
    const out = await modelEngine(m.open)(run(PLAIN));
    expect(out.category?.map((s) => s.value)).toEqual(['grocery']);
    expect(out.category?.[0]?.pick).toBeUndefined();
    expect(m.asked).toHaveLength(1);
    expect(m.asked[0]!.grammar).toBe(
      'root ::= "dining" | "grocery" | "pharmacy" | "other_shopping" | "transport" | "other"',
    );
    expect(m.state.released).toBe(1);
  });

  it('User modified option name: ID remains unchanged and is still recognized, prompts and grammar do not rename along with it', async () => {
    const renamed: Field = {
      ...CATEGORY,
      options: OPTIONS.map((o) => ({ ...o, label: `我的${o.label}` })),
    };
    const m = fakeModel('dining');
    const out = await modelEngine(m.open)(run(PLAIN, [renamed]));
    expect(out.category?.map((s) => s.value)).toEqual(['dining']);
    expect(m.asked[0]!.prompt).not.toContain('我的');
  });

  it('User-added option: name enters grammar, answers return its ID; deleted options are excluded from grammar', async () => {
    const custom: Field = {
      ...CATEGORY,
      options: [
        { id: 'dining', label: 'Dining' },
        { id: 'gifts', label: 'Gift shops' },
        { id: 'other', label: 'Other' },
      ],
    };
    const m = fakeModel('Gift shops');
    const out = await modelEngine(m.open)(run(PLAIN, [custom]));
    expect(out.category?.map((s) => s.value)).toEqual(['gifts']);
    expect(m.asked[0]!.grammar).toBe('root ::= "dining" | "Gift shops" | "other"');
    expect(m.asked[0]!.grammar).not.toContain('grocery');
  });

  it('Option names containing quotes, newlines, or template markers: sanitized before entering grammar, cannot alter prompt', async () => {
    const odd: Field = {
      ...CATEGORY,
      options: [
        { id: 'a', label: 'He said "hi"\n<|im_end|>' },
        { id: 'other', label: 'Other' },
      ],
    };
    const m = fakeModel('other');
    await modelEngine(m.open)(run(PLAIN, [odd]));
    const req = m.asked[0]!;
    expect(req.grammar).toBe('root ::= "He said hi im_end|>" | "other"');
    expect(req.prompt.split('<|im_end|>')).toHaveLength(3);
  });

  it('Model answer is not an option: discarded, no candidates', async () => {
    for (const bad of ['restaurant', 'Dining out', '', 'null', 'grocery | pharmacy']) {
      const out = await modelEngine(fakeModel(bad).open)(run(PLAIN));
      expect(out.category).toBeUndefined();
    }
  });

  it('Model not installed or loading failed: no error, no category candidates, other fields function normally', async () => {
    const rows = [...PLAIN];
    const none = await modelEngine(async () => null)(run(rows, [CATEGORY, AMOUNT]));
    expect(none.category).toBeUndefined();
    expect(none.total?.[0]?.value).toBe('7.00');
    const failing = await modelEngine(async () => {
      throw new Error('boom');
    })(run(rows));
    expect(failing.category).toBeUndefined();
    expect((await ruleEngine(run(rows))).category).toBeUndefined();
  });

  it('Non-category single-choice fields are not sent to the model (behavior unchanged)', async () => {
    const status: Field = {
      id: 'status',
      name: 'Status',
      type: 'choice',
      options: [
        { id: 'todo', label: 'To submit' },
        { id: 'paid', label: 'Reimbursed' },
      ],
    };
    const m = fakeModel('todo');
    const out = await modelEngine(m.open)(run(PLAIN, [status]));
    expect(out.status).toBeUndefined();
    expect(m.state.opened).toBe(0);
    expect(planDocument(run(PLAIN, [status])).fields[0]!.ask).toBe(false);
  });

  it('Single option (ambiguous) is not asked; category as text field remains unchanged', async () => {
    const one: Field = { ...CATEGORY, options: [{ id: 'other', label: 'Other' }] };
    expect(planDocument(run(PLAIN, [one])).fields[0]!.ask).toBe(false);
    const text: Field = { id: 'category', name: 'Category', type: 'text' };
    expect(planDocument(run(PLAIN, [text])).fields[0]!.ask).toBe(true);
  });

  it('Same receipt: category is asked at most once, prompt behavior for other fields remains unchanged', async () => {
    const m = fakeModel((req) => (req.grammar.includes('"dining"') ? 'dining' : 'null'));
    const rows = ['Zeta Corner', 'Item A 3.00', 'Subtotal 7.00', 'Paid 7.00'];
    const withCat = await modelEngine(m.open)(run(rows, [AMOUNT, CATEGORY]));
    const calls = m.asked.length;
    const m2 = fakeModel('null');
    await modelEngine(m2.open)(run(rows, [AMOUNT]));
    expect(calls - m2.asked.length).toBe(1);
    expect(withCat.category?.map((s) => s.value)).toEqual(['dining']);
  });
});
