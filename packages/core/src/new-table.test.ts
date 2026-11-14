import { describe, expect, it } from 'vitest';

import {
  addDraftField,
  draftEngine,
  fieldTypeFor,
  fileCurrency,
  removeDraftField,
  renameDraftField,
  withCurrency,
} from './new-table';
import { applyOps } from './ops';
import { createDefaultWorkspace } from './defaults';
import type { TextPage } from './prefill/rows';
import type { Collection } from './schema';
import { draftTable, draftTableOps, FILE_RECORD_PRESETS, HIDDEN_RECORD_PRESETS } from './templates';
import { registry } from './test-helpers';

const pages: TextPage[] = [
  {
    width: 800,
    height: 1100,
    lines: [
      { text: 'Annual premium: $612.40', x: 40, y: 100, width: 300, height: 16 },
      { text: 'Start of cover: 3 March 2025', x: 40, y: 150, width: 300, height: 16 },
      { text: 'Insurer: Bluecrest', x: 40, y: 200, width: 300, height: 16 },
    ],
  },
];
const blank = (): Collection => draftTable('blank', createDefaultWorkspace('en'), 'en');

describe('draftEngine（手机上发现的问题）', () => {
  const doc: TextPage[] = [
    {
      width: 800,
      height: 1100,
      lines: [
        { text: 'Numéro de contrat : CT-77120', x: 40, y: 100, width: 300, height: 16 },
        { text: 'Prime annuelle : 214,00 €', x: 40, y: 150, width: 300, height: 16 },
      ],
    },
  ];
  it('字段名和文件上的标签一样时，它旁边的值是第一个候选，编号也算', async () => {
    const t = addDraftField(
      addDraftField(blank(), 'Numéro de contrat', doc, 'fr'),
      'Prime annuelle',
      doc,
      'fr',
    );
    const got = await draftEngine({ fields: t.fields, pages: doc, locale: 'fr' });
    const number = t.fields.find((f) => f.name === 'Numéro de contrat')!;
    const premium = t.fields.find((f) => f.name === 'Prime annuelle')!;
    expect(got[number.id]![0]!.value).toBe('CT-77120');
    expect(got[premium.id]![0]!.value).toBe('214.00');
  });
  it('金额字段一定有货币：看文件上的符号，没有就按界面语言', () => {
    const t = addDraftField(blank(), 'Prime annuelle', doc, 'en');
    expect(t.fields.find((f) => f.name === 'Prime annuelle')).toMatchObject({
      type: 'money',
      currency: 'EUR',
    });
    const plain: TextPage[] = [
      {
        width: 800,
        height: 100,
        lines: [{ text: 'Total: 214.00', x: 0, y: 0, width: 200, height: 16 }],
      },
    ];
    expect(fieldTypeFor('Total', plain, 'zh')).toMatchObject({ type: 'money', currency: 'CNY' });
  });
});

describe('隐藏预设的字段认得出别的语言的标签（手机上法语保单配中文字段没有候选）', () => {
  const page = (...rows: string[]): TextPage[] => [
    {
      width: 900,
      height: 900,
      lines: rows.map((text, i) => ({
        text,
        x: 40,
        y: 40 + i * 50,
        width: text.length * 14,
        height: 24,
      })),
    },
  ];
  const values = async (
    preset: Parameters<typeof draftTable>[0],
    pages: TextPage[],
    locale: 'zh' | 'en' | 'fr',
  ) => {
    const t = draftTable(preset, createDefaultWorkspace(locale), locale);
    const got = await draftEngine({ fields: t.fields, pages, locale });
    return Object.fromEntries(t.fields.map((f) => [f.id, got[f.id]?.[0]?.value]));
  };
  it('法语保单 → 中文字段', async () => {
    const got = await values(
      'insurance',
      page(
        'Assureur : Mutuelle Azur',
        'Numéro de contrat : CT-77120',
        'Date d’échéance : 31/12/2025',
      ),
      'zh',
    );
    expect(got).toMatchObject({ provider: 'Mutuelle Azur', number: 'CT-77120', end: '2025-12-31' });
  });
  it('西语保单 → 英语字段', async () => {
    const got = await values(
      'insurance',
      page(
        'Aseguradora: Mutua Levante',
        'Número de póliza: PZ-33091',
        'Fecha de vencimiento: 28/02/2026',
      ),
      'en',
    );
    expect(got).toMatchObject({ provider: 'Mutua Levante', number: 'PZ-33091', end: '2026-02-28' });
  });
  it('英语疫苗记录 → 中文字段', async () => {
    const got = await values(
      'vaccination',
      page('Patient: Noor Haddad', 'Vaccine: tetanus booster', 'Administered: 3 March 2025'),
      'zh',
    );
    expect(got).toMatchObject({
      person: 'Noor Haddad',
      vaccine: 'tetanus booster',
      date: '2025-03-03',
    });
  });
});

describe('draft fields', () => {
  it('类型从旁边的值判断，看不出来是文字', () => {
    expect(fieldTypeFor('Annual premium', pages, 'en').type).toBe('money');
    expect(fieldTypeFor('Start of cover', pages, 'en').type).toBe('date');
    expect(fieldTypeFor('Insurer', pages, 'en').type).toBe('text');
    expect(fieldTypeFor('Nothing', pages, 'en').type).toBe('text');
  });
  it('加在附件前面，重复和空名不加', () => {
    let t = addDraftField(blank(), 'Insurer', pages, 'en');
    expect(t.fields.map((f) => f.name)).toEqual(['Title', 'Insurer', 'Attachments']);
    expect(addDraftField(t, ' insurer ', pages, 'en')).toBe(t);
    expect(addDraftField(t, '  ', pages, 'en')).toBe(t);
    t = renameDraftField(t, 'title', 'Name');
    expect(t.fields[0]!.name).toBe('Name');
    expect(renameDraftField(t, 'title', 'Insurer')).toBe(t);
  });
  it('附件字段去不掉', () => {
    const t = removeDraftField(removeDraftField(blank(), 'title'), 'attachments');
    expect(t.fields.map((f) => f.id)).toEqual(['attachments']);
  });
});

describe.each([...FILE_RECORD_PRESETS, ...HIDDEN_RECORD_PRESETS])('preset %s', (preset) => {
  it.each(['en', 'zh', 'fr'] as const)('%s：完整和去掉字段后都能建（底线 18）', (locale) => {
    const config = createDefaultWorkspace(locale);
    const table = draftTable(preset, config, locale);
    const whole = applyOps(config, draftTableOps(table, preset, config, locale), {
      registry,
      locale,
    });
    expect(whole.ok).toBe(true);
    const removed = table.fields.find((f) => f.type !== 'file')!;
    const smaller = removeDraftField(table, removed.id);
    const part = applyOps(config, draftTableOps(smaller, preset, config, locale), {
      registry,
      locale,
    });
    expect(part.ok).toBe(true);
    expect(table.fields.some((f) => f.type === 'file')).toBe(true);
  });
});

describe('隐藏的预设', () => {
  it('不在用户平时看到的预设里', () => {
    for (const p of HIDDEN_RECORD_PRESETS)
      expect(FILE_RECORD_PRESETS as readonly string[]).not.toContain(p);
  });
});

// 金额的货币跟着文件（D-548）：用文件建表时，金额字段用小票上的货币，认不出才按界面语言。
describe('fileCurrency', () => {
  const page = (...texts: string[]): TextPage[] => [
    {
      width: 600,
      height: 800,
      lines: texts.map((text, i) => ({ text, x: 20, y: 20 + i * 40, width: 300, height: 16 })),
    },
  ];
  it('reads the sign or code on the money lines, Western receipts first', () => {
    expect(fileCurrency(page('Corner Deli', 'TOTAL $18.40'), 'en')).toBe('USD');
    expect(fileCurrency(page('Boulangerie', 'Total 12,50 €'), 'fr')).toBe('EUR');
    expect(fileCurrency(page('Panadería', 'TOTAL 7,80 EUR'), 'en')).toBe('EUR');
    expect(fileCurrency(page('Tesco', 'Total £4.20'), 'en')).toBe('GBP');
  });
  it('a Malaysian receipt in RM is MYR (user tests 2026-11-09, 2026-11-10)', () => {
    expect(fileCurrency(page('KEDAI PAPAN YEW CHUAN', 'TOTAL RM 121.90'), 'en')).toBe('MYR');
    expect(fileCurrency(page('Restoran Ali', 'Jumlah RM 33.90'), 'en')).toBe('MYR');
    expect(fileCurrency(page('Kedai', 'TOTAL 9.00 MYR'), 'en')).toBe('MYR');
  });
  it('without a sign it says nothing, so the table keeps the language default', () => {
    expect(fileCurrency(page('Maple Corner', 'Total 178.23'), 'en')).toBeNull();
    expect(fileCurrency(page('Platform rm 33.90'), 'en')).toBeNull();
    expect(fileCurrency([], 'en')).toBeNull();
  });
  it('withCurrency sets the money fields and leaves the others', () => {
    const table = withCurrency(draftTable('purchase', createDefaultWorkspace('en'), 'en'), 'MYR');
    expect(table.fields.filter((f) => f.type === 'money').map((f) => f.currency)).toEqual(['MYR']);
    expect(table.fields.length).toBe(
      draftTable('purchase', createDefaultWorkspace('en'), 'en').fields.length,
    );
  });
});

// 收据类的表每一笔自己带货币，预填从小票上给候选（D-549）。
describe('receipt tables: each entry carries its own currency (D-549)', () => {
  // 购物凭证和样板「收据」还没改：它们的开销图表要把金额加起来（等创始人定）。
  const RECEIPT_TABLES = ['bill', 'reimbursement'] as const;
  const page = (...texts: string[]): TextPage[] => [
    {
      width: 600,
      height: 800,
      lines: texts.map((text, i) => ({ text, x: 20, y: 20 + i * 40, width: 300, height: 16 })),
    },
  ];
  const currencyChoice = (table: Collection) => {
    const money = table.fields.find((f) => f.type === 'money');
    const id = money?.type === 'money' ? money.currencyField : undefined;
    return table.fields.find((f) => f.id === id && f.type === 'choice') as
      Extract<Collection['fields'][number], { type: 'choice' }> | undefined;
  };
  const receipts = [
    ['Corner Deli', 'TOTAL $18.40'],
    ['Boulangerie', 'Total 12,50 €'],
    ['Tesco', 'Total £4.20'],
    ['超市', '合计 ￥12.00'],
    ['Restoran Ali', 'Jumlah RM33.90'],
  ];

  it.each(RECEIPT_TABLES)(
    '%s: the money field points at a currency choice, nothing picked',
    (p) => {
      for (const locale of ['en', 'zh', 'fr'] as const) {
        const table = draftTable(p, createDefaultWorkspace(locale), locale);
        const choice = currencyChoice(table);
        expect(choice).toBeDefined();
        expect(choice!.default).toBeUndefined();
        // 文件上认得出的货币都在选项里。
        for (const texts of receipts) {
          const code = fileCurrency(page(...texts), locale)!;
          expect(choice!.options.map((o) => o.id)).toContain(code.toLowerCase());
        }
      }
    },
  );

  it.each(RECEIPT_TABLES)(
    '%s: a ringgit receipt offers MYR as the currency candidate',
    async (p) => {
      const table = draftTable(p, createDefaultWorkspace('en'), 'en');
      const out = await draftEngine({
        rules: 'receipt',
        fields: table.fields,
        pages: page('Restoran Ali', '14/11/2026', 'TOTAL RM33.90'),
        locale: 'en',
        now: new Date('2026-11-14T00:00:00Z'),
      });
      expect(out[currencyChoice(table)!.id]?.[0]?.value).toBe('myr');
      expect(Number(out.amount?.[0]?.value)).toBe(33.9);
    },
  );

  it('no currency on the receipt: no currency candidate', async () => {
    const table = draftTable('bill', createDefaultWorkspace('en'), 'en');
    const out = await draftEngine({
      rules: 'receipt',
      fields: table.fields,
      pages: page('Maple Corner', 'Total 178.23'),
      locale: 'en',
    });
    expect(out[currencyChoice(table)!.id]).toBeUndefined();
  });

  it('works on any table whose money field points at a currency choice, whatever the names', async () => {
    const fields = [
      { id: 'x1', name: 'Paid', type: 'money', currency: 'EUR', currencyField: 'x2' },
      {
        id: 'x2',
        name: 'Kind',
        type: 'choice',
        options: [
          { id: 'eur', label: 'EUR' },
          { id: 'myr', label: 'MYR' },
        ],
      },
    ] as Collection['fields'];
    const out = await draftEngine({
      fields,
      pages: page('Kedai', 'TOTAL RM 9.00'),
      locale: 'en',
    });
    expect(out.x2?.[0]?.value).toBe('myr');
  });

  it('a table made from a file falls back to the file currency', () => {
    const table = withCurrency(draftTable('bill', createDefaultWorkspace('fr'), 'fr'), 'MYR');
    expect(table.fields.find((f) => f.type === 'money')).toMatchObject({ currency: 'MYR' });
  });

  it('removing the currency field from the draft keeps the table valid', () => {
    const config = createDefaultWorkspace('en');
    const table = draftTable('reimbursement', config, 'en');
    const smaller = removeDraftField(table, currencyChoice(table)!.id);
    const money = smaller.fields.find((f) => f.type === 'money');
    expect(money?.type === 'money' && money.currencyField).toBeFalsy();
    const made = applyOps(config, draftTableOps(smaller, 'reimbursement', config, 'en'), {
      registry,
      locale: 'en',
    });
    expect(made.ok).toBe(true);
  });
});
