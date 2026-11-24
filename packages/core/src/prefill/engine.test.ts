import { describe, expect, it, vi } from 'vitest';

import type { Field } from '../schema';
import { modelEngine, ruleEngine, type FieldSuggestions } from './engine';
import { MODEL_LIMITS, type ModelRequest, type OpenModel } from './model';
import { rememberPick, suggestValues, type FieldPick } from './rank';

const fields: Field[] = [
  { id: 'total', name: 'Amount', type: 'money', currency: 'USD' },
  { id: 'day', name: 'Date', type: 'date' },
];
const pages = [
  {
    width: 600,
    height: 200,
    lines: [
      { text: 'Date 2026-10-20', x: 20, y: 20, width: 150, height: 20 },
      { text: 'Total 178.23', x: 20, y: 60, width: 120, height: 20 },
    ],
  },
];
/** Page with one row per line (positions are unimportant when testing rules). */
const pageOf = (rows: string[]) => ({
  width: 600,
  height: 40 + rows.length * 30,
  lines: rows.map((text, i) => ({ text, x: 20, y: 20 + i * 30, width: 500, height: 24 })),
});
const now = new Date('2026-11-01T00:00:00Z');
const AMOUNT: Field = { id: 'total', name: 'Amount', type: 'money', currency: 'USD' };
const DATE: Field = { id: 'day', name: 'Date', type: 'date' };
const NUMBER: Field = { id: 'no', name: 'Number', type: 'text' };
const MERCHANT: Field = { id: 'merchant', name: 'Merchant', type: 'text' };
// Company field rule: still asks the model even if candidates exist (unlike merchant names where candidates suppress model queries, D-404); used in subsequent model workflow tests.
const ASKED: Field = { id: 'merchant', name: 'Company', type: 'text' };
const values = (out: FieldSuggestions, id: string) => (out[id] ?? []).map((s) => s.value);

describe('Rule engine (D-398)', () => {
  it('Results match rule scoring when only rule scoring is active, returning scored candidates with memory per field', async () => {
    const input = { fields, pages, locale: 'en' as const, now };
    const out = await ruleEngine(input);
    expect(out).toEqual(suggestValues(input));
    expect(out.total?.[0]).toMatchObject({ value: '178.23', pick: { label: 'Total' } });
    expect(out.day?.[0]?.value).toBe('2026-10-20');
  });

  it('Total calculated as payment minus change ranks first (even when rule scoring places it above other numbers)', async () => {
    const rows = [
      'Coffee 12.00',
      'Cake 8.00',
      'Total Qty 20.00',
      'Amount 19.00',
      'Cash 20.00',
      'Change 1.00',
    ];
    const out = await ruleEngine({
      fields: [AMOUNT],
      pages: [pageOf(rows)],
      locale: 'en',
      now,
    });
    expect(Number(out.total?.[0]?.value)).toBe(19);
  });

  it('Spelled-out Chinese amounts rank first when numeric amounts also appear in text', async () => {
    const rows = [
      '挂号费 3.00',
      '合计（大写）贰拾捌元玖角',
      '检查费 25.90',
      '合计 28.90',
      '业务 1.00',
    ];
    const out = await ruleEngine({
      fields: [{ id: 'total', name: '金额', type: 'money', currency: 'CNY' }],
      pages: [pageOf(rows)],
      locale: 'zh',
      now,
    });
    expect(Number(out.total?.[0]?.value)).toBe(28.9);
  });

  it('Dates in the validity period row are excluded from date candidates', async () => {
    const rows = ['本票据使用至 2021年12月31日', '收费日期 2020年03月05日'];
    const out = await ruleEngine({
      fields: [DATE],
      pages: [pageOf(rows)],
      locale: 'zh',
      now: new Date('2020-06-01T00:00:00Z'),
    });
    expect(values(out, 'day')).toEqual(['2020-03-05']);
  });

  it('Latest date in the full text ranks first when hotel bills contain checkout wording', async () => {
    const rows = [
      '房号 1208 房价 300',
      '入住日期 2020-03-01',
      '离店日期 打印 2020-03-02',
      '2020-03-04',
    ];
    const out = await ruleEngine({
      fields: [DATE],
      pages: [pageOf(rows)],
      locale: 'zh',
      now: new Date('2020-06-01T00:00:00Z'),
    });
    expect(out.day?.[0]?.value).toBe('2020-03-04');
  });

  it('Document numbers prioritize by key name and strip NO prefixes; serial number rows are excluded', async () => {
    const rows = ['业务流水号 77001234', '票据号 NO8039067169'];
    const out = await ruleEngine({
      fields: [NUMBER],
      pages: [pageOf(rows)],
      locale: 'zh',
      now,
    });
    expect(out.no?.[0]?.value).toBe('8039067169');
    expect(values(out, 'no')).not.toContain('77001234');
  });

  it('Merchant names stored previously in this table rank first when appearing verbatim in text, prioritizing longer matches', async () => {
    const rows = ['Receipt', 'welcome to', 'BOOK TA K TAMAN DAYA SDN BHD', 'Total 5.00'];
    const out = await ruleEngine({
      fields: [MERCHANT],
      pages: [pageOf(rows)],
      locale: 'en',
      now,
      known: { merchant: ['BOOK', 'book ta k taman daya sdn bhd', 'NOT THERE LTD'] },
    });
    expect(out.merchant?.[0]?.value).toBe('book ta k taman daya sdn bhd');
    expect(values(out, 'merchant')).not.toContain('NOT THERE LTD');
    expect(values(out, 'merchant')).not.toContain('BOOK');
  });

  it('Up to 3 candidates per field', async () => {
    const rows = ['Total 1.00', 'Total 2.00', 'Total 3.00', 'Total 4.00', 'Total 5.00'];
    const out = await ruleEngine({ fields: [AMOUNT], pages: [pageOf(rows)], locale: 'en', now });
    expect(out.total!.length).toBeLessThanOrEqual(3);
  });
});

/** Mock model: responds based on field name; records queries made and whether it was released. */
function fakeModel(
  answers: Record<string, string>,
  extra: { failOpen?: boolean; hang?: boolean; hangOpen?: boolean } = {},
) {
  const asked: ModelRequest[] = [];
  const state = { released: 0, opened: 0 };
  const open: OpenModel = async () => {
    state.opened++;
    if (extra.failOpen) throw new Error('load failed');
    if (extra.hangOpen) await new Promise(() => undefined);
    return {
      generate: async (req) => {
        asked.push(req);
        if (extra.hang) await new Promise(() => undefined);
        const name = Object.keys(answers).find((n) => req.prompt.includes(`Field "${n}"`));
        return name ? answers[name]! : 'null';
      },
      release: async () => {
        state.released++;
      },
    };
  };
  return { open, asked, state };
}

describe('On-device model engine (D-396, D-398)', () => {
  const rows = ['Bought at', 'Acme Coffee', 'Cafe Royal', 'Total 12.50'];
  const input = {
    fields: [ASKED, AMOUNT],
    pages: [pageOf(rows)],
    locale: 'en' as const,
    now,
  };

  it('Provide rule candidates first, supplement with model results once ready, placing model results upfront', async () => {
    const m = fakeModel({ Company: 'Cafe Royal | Acme Coffee' });
    const partial: FieldSuggestions[] = [];
    const out = await modelEngine(m.open)(input, undefined, (s) => partial.push(s));
    expect(partial.length).toBeGreaterThanOrEqual(1);
    // First pass: model has not been queried yet
    expect(partial[0]).toEqual(await ruleEngine(input));
    expect(values(out, 'merchant').slice(0, 2)).toEqual(['Cafe Royal', 'Acme Coffee']);
    expect(m.state.released).toBe(1);
  });

  it('Discard values hallucinated by the model (not present in text)', async () => {
    const m = fakeModel({ Company: 'Starbucks | Cafe Royal' });
    const out = await modelEngine(m.open)(input);
    expect(values(out, 'merchant')).not.toContain('Starbucks');
    expect(values(out, 'merchant')[0]).toBe('Cafe Royal');
  });

  it('Do not query the model for fields with confident code rules; do not query for single-choice fields', async () => {
    const m = fakeModel({});
    const rowsSure = ['Coffee 12.00', 'Cake 8.00', 'Total 20.00', 'Cash 50.00', 'Change 30.00'];
    await modelEngine(m.open)({
      fields: [
        AMOUNT,
        { id: 'kind', name: 'Kind', type: 'choice', options: [{ id: 'a', label: 'Coffee' }] },
      ],
      pages: [pageOf(rowsSure)],
      locale: 'en',
      now,
    });
    expect(m.asked).toEqual([]);
    // Do not load the model when nothing needs to be queried
    expect(m.state.opened).toBe(0);
  });

  it('Do not query the model for free-form fields like remarks (D-394: exclude useless candidates such as addresses and phone numbers)', async () => {
    const m = fakeModel({});
    await modelEngine(m.open)({
      fields: [
        { id: 'note', name: '备注', type: 'text' },
        { id: 'memo', name: 'Notes', type: 'note' },
        { id: 'who', name: 'Payer', type: 'text' },
      ],
      pages: [pageOf(rows)],
      locale: 'en',
      now,
    });
    expect(m.asked.map((r) => /Field "([^"]+)"/.exec(r.prompt)![1])).toEqual(['Payer']);
  });

  it('Filter out misleading text snippets from model input, retaining totals', async () => {
    const m = fakeModel({});
    await modelEngine(m.open)({
      fields: [ASKED],
      pages: [pageOf(['Acme', 'Tel: 012345', 'Discount 1.00', 'Total 5.00', 'Thank you'])],
      locale: 'en',
      now,
    });
    const prompt = m.asked[0]!.prompt;
    expect(prompt).toContain('Acme');
    expect(prompt).toContain('Total 5.00');
    expect(prompt).not.toContain('Tel:');
    expect(prompt).not.toContain('Discount');
    expect(prompt).not.toContain('Thank you');
  });

  it('Per-field requests: temperature 0, seed 42, up to 120 tokens, constrained grammar, fixed prefix', async () => {
    const m = fakeModel({});
    await modelEngine(m.open)({
      fields: [ASKED, { id: 'who', name: 'Payer', type: 'text' }],
      pages: [pageOf(rows)],
      locale: 'en',
      now,
    });
    expect(m.asked.length).toBe(2);
    expect(m.asked[0]).toMatchObject({ temperature: 0, seed: 42, nPredict: 120 });
    expect(m.asked[0]!.grammar).toContain('root ::= "null"');
    const cut = m.asked[0]!.prompt.indexOf('Field "');
    expect(m.asked[1]!.prompt.startsWith(m.asked[0]!.prompt.slice(0, cut))).toBe(true);
    // Disable thinking block
    expect(m.asked[0]!.prompt.endsWith('<think>\n\n</think>\n\n')).toBe(true);
  });

  it('Truncate text when too long, preserving both start and end contexts around the query', async () => {
    const m = fakeModel({});
    const long = Array.from({ length: 3000 }, (_, i) => `item number ${i}`);
    await modelEngine(m.open)({
      fields: [ASKED],
      pages: [pageOf(['Head Shop', ...long, 'Tail Row'])],
      locale: 'en',
      now,
    });
    const prompt = m.asked[0]!.prompt;
    expect(prompt.length).toBeLessThan(MODEL_LIMITS.textChars + 1500);
    expect(prompt).toContain('Head Shop');
    expect(prompt).toContain('Tail Row');
    expect(prompt).toContain('Field "Company"');
  });

  it.each([
    ['没装或内存不够（open 给 null）', async () => null],
    [
      '加载失败',
      async () => {
        throw new Error('no');
      },
    ],
  ] as [string, OpenModel][])('%s: quietly fall back to rules only', async (_name, open) => {
    await expect(modelEngine(open)(input)).resolves.toEqual(await ruleEngine(input));
  });

  it('Generation failure: fail silently, retain existing data, and release the model', async () => {
    let released = 0;
    const open: OpenModel = async () => ({
      generate: async () => {
        throw new Error('boom');
      },
      release: async () => {
        released++;
      },
    });
    await expect(modelEngine(open)(input)).resolves.toEqual(await ruleEngine(input));
    expect(released).toBe(1);
  });

  it('Cancellation: resolve Promise and release model when generation hangs', async () => {
    const m = fakeModel({}, { hang: true });
    const abort = new AbortController();
    const run = modelEngine(m.open)(input, abort.signal);
    await new Promise((r) => setTimeout(r, 5));
    expect(m.asked.length).toBe(1);
    abort.abort();
    await expect(run).resolves.toBeDefined();
    expect(m.state.released).toBe(1);
  });

  it('Cancellation: resolve Promise when loading hangs', async () => {
    const m = fakeModel({}, { hangOpen: true });
    const abort = new AbortController();
    const run = modelEngine(m.open)(input, abort.signal);
    await new Promise((r) => setTimeout(r, 5));
    abort.abort();
    await expect(run).resolves.toBeDefined();
  });

  it('Loading finishes after cancellation: release model upon completion', async () => {
    let finish: (() => void) | undefined;
    let released = 0;
    const open: OpenModel = () =>
      new Promise((resolve) => {
        finish = () =>
          resolve({
            generate: async () => 'null',
            release: async () => {
              released++;
            },
          });
      });
    const abort = new AbortController();
    const run = modelEngine(open)(input, abort.signal);
    await new Promise((r) => setTimeout(r, 5));
    abort.abort();
    await run;
    finish!();
    await new Promise((r) => setTimeout(r, 5));
    expect(released).toBe(1);
  });

  it('Timeout: field hangs, fall back to rules, stop querying remaining fields', async () => {
    const m = fakeModel({}, { hang: true });
    const out = await modelEngine(m.open, { ...MODEL_LIMITS, callMs: 10 })(input);
    expect(out).toEqual(await ruleEngine(input));
    expect(m.asked.length).toBe(1);
    expect(m.state.released).toBe(1);
  });
});

describe('When to query the model (D-404)', () => {
  const asked = (m: ReturnType<typeof fakeModel>) => m.asked.map((r) => r.prompt).join('\n');

  it('Do not query model when merchant rules find candidates, and protect candidates from model replacement', async () => {
    const m = fakeModel({ Merchant: 'Cafe Royal' });
    const rows = ['Acme Coffee', 'Cafe Royal', 'Total 12.00'];
    const out = await modelEngine(m.open)({
      fields: [MERCHANT],
      pages: [pageOf(rows)],
      locale: 'en',
      now,
    });
    expect(values(out, 'merchant')[0]).toBe('Acme Coffee');
    expect(asked(m)).not.toContain('Field "Merchant"');
  });

  it('Query model only when merchant rules yield zero candidates', async () => {
    const m = fakeModel({ Merchant: 'Cafe Royal' });
    const rows = ['12:49 PM', '0141', '***', 'Coffee 12.00', 'Cafe Royal', 'Total 12.00'];
    const out = await modelEngine(m.open)({
      fields: [MERCHANT],
      pages: [pageOf(rows)],
      locale: 'en',
      now,
    });
    expect(asked(m)).toContain('Field "Merchant"');
    expect(values(out, 'merchant')).toContain('Cafe Royal');
  });

  it('Do noplanet/query model when total score is high (>=3.5) and exceeds runner-up by 1 point', async () => {
    const m = fakeModel({ Amount: '9.00' });
    const rows = ['Shop', 'Total: 12.00', 'Coffee 9.00'];
    const input = { fields: [AMOUNT], pages: [pageOf(rows)], locale: 'en' as const, now };
    const top = (await ruleEngine(input)).total ?? [];
    expect(top[0]?.score).toBeGreaterThanOrEqual(3.5);
    expect(top[0]!.score - (top[1]?.score ?? 0)).toBeGreaterThanOrEqual(1);
    const out = await modelEngine(m.open)(input);
    expect(asked(m)).not.toContain('Field "Amount"');
    expect(values(out, 'total')[0]).toBe('12.00');
  });

  it('Totals in Chinese documents: keep rules ranked first even when model is queried', async () => {
    const m = fakeModel({ 金额: '10.00' });
    const field: Field = { id: 'total', name: '金额', type: 'money', currency: 'CNY' };
    const rows = ['上海小店', '咖啡 90.00', '蛋糕 10.00'];
    const input = { fields: [field], pages: [pageOf(rows)], locale: 'zh' as const, now };
    const ruleTop = (await ruleEngine(input)).total?.[0]?.value;
    const out = await modelEngine(m.open)(input);
    expect(asked(m)).toContain('Field "金额"');
    expect(ruleTop).toBe('90.00');
    expect(values(out, 'total')[0]).toBe(ruleTop);
    expect(values(out, 'total')).toContain('10.00');
  });

  it('Totals in other languages: model ranks first when queried', async () => {
    const m = fakeModel({ Amount: '9.00' });
    const rows = ['Shop', 'Coffee 9.00', 'Cake 3.00'];
    const out = await modelEngine(m.open)({
      fields: [AMOUNT],
      pages: [pageOf(rows)],
      locale: 'en',
      now,
    });
    expect(asked(m)).toContain('Field "Amount"');
    expect(values(out, 'total')[0]).toBe('9.00');
  });
});

describe('QR code values (D-423)', () => {
  const CARD_FIELDS: Field[] = [
    { id: 'name', name: 'Name', type: 'text' },
    { id: 'job', name: 'Job title', type: 'text' },
    { id: 'company', name: 'Company', type: 'text' },
    { id: 'tel', name: 'Phone', type: 'text', format: 'phone' },
    { id: 'mail', name: 'Email', type: 'text', format: 'email' },
    { id: 'site', name: 'Website', type: 'text', format: 'url' },
  ];
  const VCARD =
    'BEGIN:VCARD\nFN:Maria Garcia\nTITLE:CTO\nORG:Acme\nTEL:+33 6 12 34 56 78\nEMAIL:m@acme.example\nURL:https://acme.example\nEND:VCARD';
  const input = (codes: string[], rows: string[] = []) => ({
    fields: CARD_FIELDS,
    rules: 'card' as const,
    pages: rows.length > 0 ? [pageOf(rows)] : [],
    locale: 'en' as const,
    now,
    codes,
  });
  const values = (s: FieldSuggestions) =>
    Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v.map((x) => x.value)]));

  it('a picture with only a QR code still gives candidates', async () => {
    expect(values(await ruleEngine(input([VCARD])))).toEqual({
      name: ['Maria Garcia'],
      job: ['CTO'],
      company: ['Acme'],
      tel: ['+33 6 12 34 56 78'],
      mail: ['m@acme.example'],
      site: ['https://acme.example'],
    });
  });

  it('come before what the text gives, without a position to remember', async () => {
    const s = await ruleEngine(
      input([VCARD], ['Jean Dupont', 'Tel +33 1 11 11 11 11', 'other@acme.example']),
    );
    expect(s.tel![0]!.value).toBe('+33 6 12 34 56 78');
    expect(s.tel!.map((x) => x.value)).toContain('+33 1 11 11 11 11');
    expect(s.mail![0]!.value).toBe('m@acme.example');
    expect(s.mail!.map((x) => x.value)).toContain('other@acme.example');
    expect(s.name![0]!.value).toBe('Maria Garcia');
    expect(s.name![0]!.pick).toBeUndefined();
  });

  it('a web address only suggests the website', async () => {
    expect(values(await ruleEngine(input(['https://acme.example/me'])))).toEqual({
      site: ['https://acme.example/me'],
    });
  });

  it('anything else is ignored and the text is read as usual', async () => {
    const plain = await ruleEngine(input([], ['Tel +33 1 11 11 11 11']));
    const coded = await ruleEngine(input(['WIFI:T:WPA;S:x;;', 'hello'], ['Tel +33 1 11 11 11 11']));
    expect(coded).toEqual(plain);
    expect(await ruleEngine(input(['hello']))).toEqual({});
  });

  it('only on a card table', async () => {
    const s = await ruleEngine({ ...input([VCARD]), rules: 'receipt' });
    expect(s).toEqual({});
    const { rules: _unused, ...plain } = input([VCARD]);
    expect(await ruleEngine(plain)).toEqual({});
  });

  it('the model does not load for a picture with no text', async () => {
    let opened = 0;
    const open: OpenModel = async () => {
      opened++;
      return null;
    };
    const s = await modelEngine(open)(input(['https://acme.example']));
    expect(opened).toBe(0);
    expect(values(s)).toEqual({ site: ['https://acme.example'] });
  });

  it('a field with a code value is not asked of the model; other fields are, without the code', async () => {
    const asked: ModelRequest[] = [];
    const open: OpenModel = async () => ({
      generate: async (r) => {
        asked.push(r);
        return '';
      },
      release: async () => undefined,
    });
    await modelEngine(open)(input(['https://acme.example/SECRET'], ['Some text on the card']));
    expect(asked.length).toBeGreaterThan(0);
    expect(JSON.stringify(asked)).not.toContain('SECRET');
  });
});

describe('Field name matches file tag exactly', () => {
  const openAnswering = (answer: string) => {
    const generate = vi.fn(async () => answer);
    const open: OpenModel = async () => ({ generate, release: async () => undefined });
    return { open, generate };
  };
  const dates = pageOf(['Start of cover: 01/01/2027', 'Valid until: 31/12/2027']);

  it('Value next to tag ranks first; model overrides are ignored and model query is bypassed', async () => {
    const { open, generate } = openAnswering('2027-01-01');
    const out = await modelEngine(open)({
      fields: [{ id: 'end', name: 'Valid until', type: 'date' }],
      pages: [dates],
      locale: 'en',
      now: new Date('2026-11-05T00:00:00Z'),
    });
    expect(out.end?.[0]?.value).toBe('2027-12-31');
    expect(generate).not.toHaveBeenCalled();
  });

  it('Model answer ranks first when tags differ', async () => {
    const { open } = openAnswering('1900.00');
    const out = await modelEngine(open)({
      fields: [{ id: 'deposit', name: 'Deposit', type: 'money', currency: 'GBP' }],
      pages: [pageOf(['Rent per month: £950.00', 'Bond: £1,900.00'])],
      locale: 'en',
    });
    expect(Number(out.deposit?.[0]?.value)).toBe(1900);
  });

  it('Two different values follow the same tag: ambiguous, query model', async () => {
    const { open, generate } = openAnswering('110.00');
    const out = await modelEngine(open)({
      fields: [{ id: 'total', name: 'Total', type: 'money', currency: 'EUR' }],
      pages: [pageOf(['Total: 100.00 €', 'Tax: 10.00 €', 'Total: 110.00 €'])],
      locale: 'en',
    });
    expect(generate).toHaveBeenCalled();
    expect(Number(out.total?.[0]?.value)).toBe(110);
  });
});

describe('Learn tags from tables', () => {
  const START: Field = { id: 'start', name: '起始日期', type: 'date' };
  const noModel: OpenModel = async () => {
    throw new Error('不该问模型');
  };
  /** Read through a file, tap a candidate with the given value, and return the new memory. */
  const tap = async (
    rows: string[],
    value: string,
    prev?: FieldPick,
    field: Field = START,
  ): Promise<FieldPick> => {
    const out = await ruleEngine({
      fields: [field],
      pages: [pageOf(rows)],
      locale: 'en',
      now,
      ...(prev ? { picks: { [field.id]: prev } } : {}),
    });
    const shown = out[field.id] ?? [];
    const hit = shown.find((s) => s.value === value);
    if (!hit) throw new Error(`候选里没有 ${value}: ${JSON.stringify(shown)}`);
    return rememberPick(prev, hit, shown)!;
  };
  const noise = 'Printed on: 15/03/2027';

  it('Remember tags across two files: recognize format when it reappears in a second file without querying model', async () => {
    let pick = await tap(['start date: 20/02/2027', noise], '2027-02-20');
    pick = await tap(['startAt: 21/02/2027', noise], '2027-02-21', pick);
    const generate = vi.fn(async () => '2027-03-15');
    for (const [label, want] of [
      ['start date', '2027-04-22'],
      ['startAt', '2027-04-23'],
    ] as const) {
      const out = await modelEngine(async () => ({ generate, release: async () => undefined }))({
        fields: [START],
        pages: [pageOf([noise, `${label}: ${want.slice(8)}/04/2027`])],
        locale: 'en',
        now,
        picks: { start: pick },
      });
      expect(out.start?.[0]?.value).toBe(want);
    }
    expect(generate).not.toHaveBeenCalled();
  });

  it('Position-independent: learned tag ranks first even when appearing at different vertical offsets', async () => {
    const pick = await tap(['start date: 20/02/2027', noise], '2027-02-20');
    const out = await modelEngine(noModel)({
      fields: [START],
      pages: [pageOf([noise, 'a', 'b', 'c', 'd', 'e', 'f', 'start date: 22/04/2027'])],
      locale: 'en',
      now,
      picks: { start: pick },
    });
    expect(out.start?.[0]?.value).toBe('2027-04-22');
  });

  it('User picks a different value when tag matches: tag no longer ranks first', async () => {
    let pick = await tap(['Date: 20/02/2027', noise], '2027-02-20');
    pick = await tap(['Date: 22/04/2027', 'period from: 23/04/2027'], '2027-04-23', pick);
    const { generate, out } = await (async () => {
      const generate = vi.fn(async () => '2027-06-25');
      const out = await modelEngine(async () => ({ generate, release: async () => undefined }))({
        fields: [START],
        pages: [pageOf(['Date: 24/05/2027', 'other: 25/06/2027'])],
        locale: 'en',
        now,
        picks: { start: pick },
      });
      return { generate, out };
    })();
    expect(generate).toHaveBeenCalled();
    expect(out.start?.[0]?.value).toBe('2027-06-25');
    expect(pick.labels?.find((l) => l.label === 'date')?.rejected).toBe(true);
  });

  it('A single tag can belong to two fields', async () => {
    const rent: Field = { id: 'rent', name: '月租', type: 'money', currency: 'EUR' };
    const deposit: Field = { id: 'deposit', name: '押金', type: 'money', currency: 'EUR' };
    const rows = ['loyer mensuel: 950.00 €'];
    const a = await tap(rows, '950.00', undefined, rent);
    const b = await tap(rows, '950.00', undefined, deposit);
    const out = await modelEngine(noModel)({
      fields: [rent, deposit],
      pages: [pageOf(['loyer mensuel: 800.00 €', 'Printed: 12.00 €'])],
      locale: 'fr',
      picks: { rent: a, deposit: b },
    });
    expect(Number(out.rent?.[0]?.value)).toBe(800);
    expect(Number(out.deposit?.[0]?.value)).toBe(800);
  });

  it('Different values following the same tag: do not recognize directly', async () => {
    const pick = await tap(['Total: 100.00 €'], '100.00', undefined, {
      id: 'x',
      name: '金额',
      type: 'money',
      currency: 'EUR',
    });
    const generate = vi.fn(async () => '110.00');
    const out = await modelEngine(async () => ({ generate, release: async () => undefined }))({
      fields: [{ id: 'x', name: '金额', type: 'money', currency: 'EUR' }],
      pages: [pageOf(['Total: 100.00 €', 'Total: 110.00 €'])],
      locale: 'en',
      picks: { x: pick },
    });
    expect(generate).toHaveBeenCalled();
    expect(Number(out.x?.[0]?.value)).toBe(110);
  });

  it('Ambiguous day/month dates: prioritize the last tapped interpretation for this tag', async () => {
    const pick = await tap(['start date: 20/02/2027', noise], '2027-02-20');
    const out = await modelEngine(noModel)({
      fields: [START],
      pages: [pageOf(['start date: 03/04/2027', noise])],
      locale: 'en',
      now,
      picks: { start: pick },
    });
    expect(out.start?.[0]?.value).toBe('2027-04-03');
    const us = await tap(['start date: 02/20/2027', noise], '2027-02-20');
    const mdy = await modelEngine(noModel)({
      fields: [START],
      pages: [pageOf(['start date: 03/04/2027', noise])],
      locale: 'en',
      now,
      picks: { start: us },
    });
    expect(mdy.start?.[0]?.value).toBe('2027-03-04');
  });

  it('Query model even when learned tag has a unique candidate: corrects mislearned tags and allows correct values to be selected', async () => {
    const generate = vi.fn(async () => '2027-03-10');
    const out = await modelEngine(async () => ({ generate, release: async () => undefined }))({
      fields: [START],
      pages: [pageOf(['Kestrel Life: 25/02/2027', 'Effective 10/03/2027'])],
      locale: 'en',
      now,
      picks: { start: { label: 'Kestrel Life', relY: 0.1 } },
    });
    expect(out.start?.map((s) => s.value)).toEqual(
      expect.arrayContaining(['2027-02-25', '2027-03-10']),
    );
    expect(out.start?.[0]?.value).toBe('2027-02-25');
  });

  it('Legacy memories storing only a single tag are also treated as learned', async () => {
    const out = await modelEngine(noModel)({
      fields: [START],
      pages: [pageOf([noise, 'startAt: 22/04/2027'])],
      locale: 'en',
      now,
      picks: { start: { label: 'startAt', relY: 0.9 } },
    });
    expect(out.start?.[0]?.value).toBe('2027-04-22');
  });

  it('Receipt and business card tables continue using measured rules rather than prioritizing learned tags', async () => {
    const generate = vi.fn(async () => 'null');
    await modelEngine(async () => ({ generate, release: async () => undefined }))({
      fields: [ASKED],
      rules: 'receipt',
      pages: [pageOf(['Vendor: ACME Trading'])],
      locale: 'en',
      picks: { merchant: { label: 'Vendor', relY: 0.1 } },
    });
    expect(generate).toHaveBeenCalled();
  });

  it('Do not store values: memory retains only tags and positions', async () => {
    const pick = await tap(['start date: 20/02/2027', noise], '2027-02-20');
    expect(JSON.stringify(pick)).not.toContain('2027');
  });

  it('Memory retains at most 20 tags, keeping newest ones', () => {
    let pick: FieldPick | undefined;
    for (let i = 0; i < 25; i++) {
      const s = { value: 'v', score: 1, pick: { label: `label ${i}x`, relY: 0.5 } };
      pick = rememberPick(pick, s, [s]);
    }
    expect(pick?.labels).toHaveLength(20);
    expect(pick?.labels?.[0]?.label).toBe('label 24x');
  });
});
