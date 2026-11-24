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

describe('draftEngine (issues found on mobile)', () => {
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
  it('When field name matches the label on the file, its adjacent value is the first candidate, and numbering also counts', async () => {
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
  it('Amount fields must have a currency: check the symbol on the file; fallback to UI locale if none', () => {
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

describe('Hidden presets can recognize labels in other languages (mobile: French policy with Chinese fields has no candidate)', () => {
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
  it('French policy -> Chinese fields', async () => {
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
  it('Spanish policy -> English fields', async () => {
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
  it('English vaccination record -> Chinese fields', async () => {
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
  it('Type is determined from the adjacent value; if unclear, it is text', () => {
    expect(fieldTypeFor('Annual premium', pages, 'en').type).toBe('money');
    expect(fieldTypeFor('Start of cover', pages, 'en').type).toBe('date');
    expect(fieldTypeFor('Insurer', pages, 'en').type).toBe('text');
    expect(fieldTypeFor('Nothing', pages, 'en').type).toBe('text');
  });
  it('Added before attachments; duplicates and empty names are skipped', () => {
    let t = addDraftField(blank(), 'Insurer', pages, 'en');
    expect(t.fields.map((f) => f.name)).toEqual(['Title', 'Insurer', 'Attachments']);
    expect(addDraftField(t, ' insurer ', pages, 'en')).toBe(t);
    expect(addDraftField(t, '  ', pages, 'en')).toBe(t);
    t = renameDraftField(t, 'title', 'Name');
    expect(t.fields[0]!.name).toBe('Name');
    expect(renameDraftField(t, 'title', 'Insurer')).toBe(t);
  });
  it('Attachment field cannot be removed', () => {
    const t = removeDraftField(removeDraftField(blank(), 'title'), 'attachments');
    expect(t.fields.map((f) => f.id)).toEqual(['attachments']);
  });
});

describe.each([...FILE_RECORD_PRESETS, ...HIDDEN_RECORD_PRESETS])('preset %s', (preset) => {
  it.each(['en', 'zh', 'fr'] as const)('%s: can build both fully and after removing fields (invariant 18)', (locale) => {
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

describe('Hidden preset', () => {
  it('Not in the presets normally visible to users', () => {
    for (const p of HIDDEN_RECORD_PRESETS)
      expect(FILE_RECORD_PRESETS as readonly string[]).not.toContain(p);
  });
});

// File currency linkage (D-548): when creating tables from files, amount fields use the currency from the receipt, falling back to UI language only if unrecognized.
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

// Receipt-type tables carry their own currency per entry, suggesting prefill candidates from the receipt (D-549).
describe('receipt tables: each entry carries its own currency (D-549)', () => {
  // Shopping voucher and sample "Receipt" tables not yet updated: their expense charts need to sum amounts (pending founder decision).
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
        // All currencies recognized on the file are included in the options.
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
