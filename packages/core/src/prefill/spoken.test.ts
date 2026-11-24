import { describe, expect, it } from 'vitest';

import type { Field } from '../schema';
import { modelEngine, ruleEngine, type FieldSuggestions } from './engine';
import type { ModelRequest, OpenModel } from './model';
import { textPart } from './spoken';
import { readSpoken } from './spoken-values';

// Spoken sentence -> any table (D-575): code reads values, model extracts text and picks options;
// confident ones are marked sure and filled directly into the form. Today is fixed to 2026-11-17
// (Tuesday).

const TODAY = new Date(2026, 10, 17);
const NOW = new Date(2026, 10, 17, 10, 0);

const read = (text: string) =>
  readSpoken(text, TODAY).map((v) => [v.kind, v.values.join('/'), v.raw]);

describe('Spoken values (spoken-values)', () => {
  it.each([
    [
      '我今天超市买了10块钱',
      [
        ['date', '2026-11-17', '今天'],
        ['money', '10', '10块钱'],
      ],
    ],
    ['二十三块五在全家买的', [['money', '23.5', '二十三块五']]],
    ['七块五毛', [['money', '7.5', '七块五毛']]],
    ['十八块钱', [['money', '18', '十八块钱']]],
    ['一百二', [['number', '120', '一百二']]],
    ['花了一千五', [['number', '1500', '一千五']]],
    ['两万三', [['number', '23000', '两万三']]],
    ['三点五', [['number', '3.5', '三点五']]],
    [
      '买了3瓶水花了6块',
      [
        ['number', '3', '3瓶'],
        ['money', '6', '6块'],
      ],
    ],
    [
      '明天下午三点给妈妈打电话',
      [
        ['date', '2026-11-18', '明天'],
        ['time', '15:00', '下午三点'],
      ],
    ],
    [
      '周日下午两点半去看电影',
      [
        ['date', '2026-11-22', '周日'],
        ['time', '14:30', '下午两点半'],
      ],
    ],
    ['下周五交报告', [['date', '2026-11-27', '下周五']]],
    ['这个月20号交房租', [['date', '2026-11-20', '这个月20号']]],
    [
      '跑了5公里用了30分钟',
      [
        ['number', '5', '5公里'],
        ['duration', '0:30', '30分钟'],
      ],
    ],
    ['一个半小时', [['duration', '1:30', '一个半小时']]],
    ['这本书给四星', [['rating', '4', '四星']]],
    ['我有一点饿', []],
    ['我们一起统一买了', []],
    ['spent twelve fifty at the pharmacy', [['number', '12.5', 'twelve fifty']]],
    [
      'I paid 45 dollars for 3 shirts',
      [
        ['money', '45', '45 dollars'],
        ['number', '3', '3'],
      ],
    ],
    ['12 dollars and 50 cents', [['money', '12.5', '12 dollars and 50 cents']]],
    ['$12.50 at Starbucks', [['money', '12.5', '$12.50']]],
    [
      'yesterday I spent a hundred and twenty bucks',
      [
        ['date', '2026-11-16', 'yesterday'],
        ['money', '120', 'a hundred and twenty bucks'],
      ],
    ],
    [
      'on Friday at 7pm',
      [
        ['date', '2026-11-20', 'on Friday'],
        ['time', '19:00', 'at 7pm'],
      ],
    ],
    [
      'I ran 5 km in 28 minutes',
      [
        ['number', '5', '5 km'],
        ['duration', '0:28', '28 minutes'],
      ],
    ],
    ['I need to buy milk', []],
    ["j'ai pris un taxi pour dix-huit euros", [['money', '18', 'dix-huit euros']]],
    ['quarante-deux euros au restaurant', [['money', '42', 'quarante-deux euros']]],
    ['4 euros 50', [['money', '4.5', '4 euros 50']]],
    ['€4,50 café', [['money', '4.5', '€4,50']]],
    ['soixante-dix-sept', [['number', '77', 'soixante-dix-sept']]],
    ['quatre-vingt-dix-neuf', [['number', '99', 'quatre-vingt-dix-neuf']]],
    [
      'rendez-vous demain à 15h30',
      [
        ['date', '2026-11-18', 'demain'],
        ['time', '15:30', 'à 15h30'],
      ],
    ],
    [
      'lundi prochain à 9 heures du matin',
      [
        ['date', '2026-11-23', 'lundi prochain'],
        ['time', '09:00', 'à 9 heures du matin'],
      ],
    ],
    ['deux heures de ménage', [['duration', '2:00', 'deux heures']]],
    ['le 1er mars', [['date', '2026-03-01', 'le 1er mars']]],
    // Gaps found in the second round of measurement.
    [
      '昨天跑了三点五公里',
      [
        ['date', '2026-11-16', '昨天'],
        ['number', '3.5', '三点五公里'],
      ],
    ],
    ['跑了十公里', [['number', '10', '十公里']]],
    [
      '下周二上午十点看牙',
      [
        ['date', '2026-11-24', '下周二'],
        ['time', '10:00', '上午十点'],
      ],
    ],
    ['用了一小时十分钟', [['duration', '1:10', '一小时十分钟']]],
    ['une heure et quart', [['duration', '1:15', 'une heure et quart']]],
    ["un quart d'heure", [['duration', '0:15', "un quart d'heure"]]],
  ])('%s', (text, expected) => {
    expect(read(text)).toEqual(expected);
  });

  it('Provide two readings for hours without AM/PM: 1-6 defaults to PM first, 7-11 defaults to AM first', () => {
    expect(read('三点开会')).toEqual([['time', '15:00/03:00', '三点']]);
    expect(read('call mom at 9')).toEqual([['time', '09:00/21:00', 'at 9']]);
  });
});

const page = (text: string) => ({
  width: 600,
  height: 40,
  lines: [{ text, x: 0, y: 0, width: 600, height: 24 }],
});

const RECEIPT: Field[] = [
  { id: 'merchant', name: '商家', type: 'text' },
  { id: 'date', name: '日期', type: 'date' },
  { id: 'amount', name: '金额', type: 'money', currency: 'CNY' },
  {
    id: 'category',
    name: '分类',
    type: 'choice',
    options: [
      { id: 'dining', label: '餐饮' },
      { id: 'grocery', label: '超市便利' },
      { id: 'pharmacy', label: '药店' },
      { id: 'other-shopping', label: '其他购物' },
      { id: 'transport', label: '交通' },
      { id: 'other', label: '其他' },
    ],
  },
];
const TODO: Field[] = [
  { id: 'title', name: '事项', type: 'text' },
  { id: 'done', name: '完成', type: 'checkbox' },
  { id: 'due', name: '截止日期', type: 'date' },
];

const spoken = (fields: Field[], text: string) => ({
  fields,
  pages: [page(text)],
  locale: 'zh' as const,
  spoken: true,
  now: NOW,
});
const first = (out: FieldSuggestions, id: string) => out[id]?.[0];

/** Fake model: answers based on field names in the question. Records which fields were asked. */
function fakeModel(answers: Record<string, string>, asked: string[] = []): OpenModel {
  return async () => ({
    generate: async (req: ModelRequest) => {
      const name = /Field "([^"]+)"/.exec(req.prompt)?.[1] ?? '';
      asked.push(name);
      return answers[name] ?? 'null';
    },
    release: async () => undefined,
  });
}

describe('The text snippet shown to text fields (with code-read values excised)', () => {
  it.each([
    ['明天下午三点给妈妈打电话', '给妈妈打电话'],
    ['周五前交报告', '交报告'],
    ['I need to buy milk', 'buy milk'],
    ['submit the tax form by Friday', 'submit the tax form'],
    ['appeler le plombier demain matin', 'appeler le plombier'],
    ['下周二上午十点在协和医院看牙', '协和医院看牙'],
    ['今天三点开会', '开会'],
    ['我要买牛奶', '买牛奶'],
    ['我今天超市买了10块钱', '超市买了'],
  ])('%s → %s', (text, rest) => {
    expect(textPart(text, readSpoken(text, TODAY))).toBe(rest);
  });
});

describe('Spoken sentence -> any table (D-575)', () => {
  it('Receipt: amount and date read reliably by code; supermarket category recognized', async () => {
    const out = await ruleEngine(spoken(RECEIPT, '我今天超市买了10块钱'));
    expect(first(out, 'amount')).toEqual({ value: '10', score: 1, sure: true });
    expect(first(out, 'date')).toMatchObject({ value: '2026-11-17', sure: true });
    expect(first(out, 'category')).toMatchObject({ value: 'grocery', sure: true });
    // Text fields can only be extracted by the model: none when using rules only.
    expect(out.merchant).toBeUndefined();
  });

  it('Quantity is not amount: "3 bottles of water cost 6" -> amount is 6; "two people ate for 180" -> amount is 180', async () => {
    expect(first(await ruleEngine(spoken(RECEIPT, '买了3瓶水花了6块')), 'amount')).toMatchObject({
      value: '6',
      sure: true,
    });
    expect(first(await ruleEngine(spoken(RECEIPT, '两个人吃了180')), 'amount')).toMatchObject({
      value: '180',
      sure: true,
    });
  });

  it('Two ambiguous amounts: provide both as candidates, do not fill directly; the model can only pick from these two, the picked one is ranked first, but still not filled directly', async () => {
    const text = '买了两样东西一个30块一个50块';
    const rules = await ruleEngine(spoken(RECEIPT, text));
    expect(rules.amount?.map((s) => s.value)).toEqual(['30', '50']);
    expect(rules.amount?.some((s) => s.sure)).toBe(false);
    const out = await modelEngine(fakeModel({ 金额: '50块' }))(spoken(RECEIPT, text));
    expect(out.amount?.map((s) => [s.value, s.sure ?? false])).toEqual([
      ['50', false],
      ['30', false],
    ]);
  });

  it('Todo: deadline read by code; item extracted from original text by model with confidence', async () => {
    const asked: string[] = [];
    const out = await modelEngine(fakeModel({ 事项: '给妈妈打电话' }, asked))(
      spoken(TODO, '明天下午给妈妈打电话'),
    );
    expect(first(out, 'due')).toMatchObject({ value: '2026-11-18', sure: true });
    expect(first(out, 'title')).toMatchObject({ value: '给妈妈打电话', sure: true });
    // Checkboxes are left unfilled and not asked; dates are read reliably by code and not asked.
    expect(out.done).toBeUndefined();
    expect(asked).toEqual(['事项']);
  });

  it('Model hallucinates text not present in the original: discard', async () => {
    const out = await modelEngine(fakeModel({ 事项: 'Call mom' }))(
      spoken(TODO, '明天给妈妈打电话'),
    );
    expect(out.title).toBeUndefined();
  });

  it('Two text fields extract the same segment: neither is considered confident', async () => {
    const fields: Field[] = [
      { id: 'a', name: 'A', type: 'text' },
      { id: 'b', name: 'B', type: 'text' },
    ];
    const out = await modelEngine(fakeModel({ A: '买牛奶', B: '买牛奶' }))(
      spoken(fields, '记得买牛奶'),
    );
    expect(first(out, 'a')).toEqual({ value: '买牛奶', score: 2 });
    expect(first(out, 'b')).toEqual({ value: '买牛奶', score: 2 });
  });

  it('Free-form fields like remarks are not asked of the model (second-round measurement: entire sentence filled into remarks)', async () => {
    const asked: string[] = [];
    await modelEngine(fakeModel({}, asked))(
      spoken([...RECEIPT, { id: 'note', name: '备注', type: 'text' }], '星巴克拿铁买了3杯一共96块'),
    );
    expect(asked).not.toContain('备注');
  });

  it('Merchant names are treated only as candidates and extracted ones are not filled directly (third-round measurement: direct fills have high error rates)', async () => {
    const whole = await modelEngine(fakeModel({ 商家: '全家买的东西' }))(
      spoken(RECEIPT, '昨天在全家买的东西二十三块五'),
    );
    expect(first(whole, 'merchant')).toEqual({ value: '全家买的东西', score: 2 });
    const part = await modelEngine(fakeModel({ 商家: '全家' }))(
      spoken(RECEIPT, '昨天在全家买的东西二十三块五'),
    );
    expect(first(part, 'merchant')).toEqual({ value: '全家', score: 2 });
  });

  it('Book title and author where one answers the whole sentence and one answers a substring (one nesting the other): neither is filled directly', async () => {
    const fields: Field[] = [
      { id: 'book', name: '书名', type: 'text' },
      { id: 'author', name: '作者', type: 'text' },
    ];
    const out = await modelEngine(fakeModel({ 书名: '活着', 作者: '活着余华的' }))(
      spoken(fields, '活着余华的'),
    );
    expect(out.book?.[0]?.sure).toBeUndefined();
    expect(out.author?.[0]?.sure).toBeUndefined();
  });

  it('Ask model when receipt category code cannot be recognized; selecting one makes it confident', async () => {
    const out = await modelEngine(fakeModel({ 分类: 'transport' }))(
      spoken(RECEIPT, '打车花了三十'),
    );
    expect(first(out, 'category')).toMatchObject({ value: 'transport', sure: true });
    expect(first(out, 'amount')).toMatchObject({ value: '30', sure: true });
  });

  it('Other single-selects: fill directly if option name is mentioned in text; model can answer none or leave blank if not mentioned', async () => {
    const fields: Field[] = [
      { id: 'title', name: '事项', type: 'text' },
      {
        id: 'priority',
        name: '优先级',
        type: 'choice',
        options: [
          { id: 'high', label: '高' },
          { id: 'low', label: '低' },
        ],
      },
    ];
    // "gao" is in the sentence.
    expect(
      first(await ruleEngine(spoken(fields, '优先级高，周五前交报告')), 'priority'),
    ).toMatchObject({
      value: 'high',
      sure: true,
    });
    const requests: ModelRequest[] = [];
    const open: OpenModel = async () => ({
      generate: async (req) => {
        requests.push(req);
        return /Field "优先级"/.test(req.prompt) ? 'none' : 'null';
      },
      release: async () => undefined,
    });
    const out = await modelEngine(open)(spoken(fields, '周五前交报告'));
    expect(out.priority).toBeUndefined();
    expect(requests.find((r) => r.prompt.includes('优先级'))?.grammar).toContain('"none"');
  });

  it('AM/PM not specified: provide two time candidates, do not fill directly', async () => {
    const fields: Field[] = [{ id: 'at', name: '时间', type: 'time' }];
    const out = await ruleEngine(spoken(fields, '三点开会'));
    expect(out.at?.map((s) => [s.value, s.sure ?? false])).toEqual([
      ['15:00', false],
      ['03:00', false],
    ]);
  });

  it('Date and time fields: combine date and hour if both mentioned; default to today if only hour mentioned', async () => {
    const fields: Field[] = [{ id: 'when', name: '时间', type: 'datetime' }];
    expect(first(await ruleEngine(spoken(fields, '明天下午三点开会')), 'when')).toMatchObject({
      value: '2026-11-18 15:00',
      sure: true,
    });
    expect(first(await ruleEngine(spoken(fields, '晚上八点吃药')), 'when')).toMatchObject({
      value: '2026-11-17 20:00',
      sure: true,
    });
  });

  it('Running record: numbers with units go to same-unit fields, duration goes to duration field', async () => {
    const fields: Field[] = [
      { id: 'km', name: '距离', type: 'number', unit: 'km' },
      { id: 'kg', name: '体重', type: 'number', unit: 'kg' },
      { id: 'time', name: '用时', type: 'duration' },
    ];
    const out = await ruleEngine(spoken(fields, '跑了5公里用了30分钟，体重65公斤'));
    expect(first(out, 'time')).toMatchObject({ value: '0:30', sure: true });
    // Two numeric fields competing: candidates are separated by unit, but not filled directly.
    expect(out.km?.map((s) => s.value)).toEqual(['5']);
    expect(out.kg?.map((s) => s.value)).toEqual(['65']);
  });

  it('Rating: fill matching number of stars based on spoken rating', async () => {
    const fields: Field[] = [
      { id: 'book', name: '书名', type: 'text' },
      { id: 'stars', name: '评分', type: 'rating' },
    ];
    expect(first(await ruleEngine(spoken(fields, '三体看完了给五星')), 'stars')).toMatchObject({
      value: '5',
      sure: true,
    });
  });

  it('Fields like attachments, checkboxes, and formulas are never filled', async () => {
    const fields: Field[] = [
      { id: 'f', name: '附件', type: 'file' },
      { id: 'c', name: '完成', type: 'checkbox' },
    ];
    expect(await modelEngine(fakeModel({}))(spoken(fields, '已经做完了，附上照片'))).toEqual({});
  });

  it('Text read from files (not spoken) remains unchanged: no sure flag', async () => {
    const out = await ruleEngine({
      fields: RECEIPT,
      pages: [page('超市 合计 10.00 2026-11-17')],
      locale: 'zh',
      now: NOW,
    });
    expect(
      Object.values(out)
        .flat()
        .some((s) => s.sure),
    ).toBe(false);
  });
});
