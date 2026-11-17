import { describe, expect, it } from 'vitest';

import type { Field } from '../schema';
import { modelEngine, ruleEngine, type FieldSuggestions } from './engine';
import type { ModelRequest, OpenModel } from './model';
import { textPart } from './spoken';
import { readSpoken } from './spoken-values';

// 说出来的一句话 → 任何一张表（D-575）：代码读值，模型截文字、挑选项；有把握的标 sure，表单直接填。
// 今天固定为 2026-11-17（星期二）。

const TODAY = new Date(2026, 10, 17);
const NOW = new Date(2026, 10, 17, 10, 0);

const read = (text: string) =>
  readSpoken(text, TODAY).map((v) => [v.kind, v.values.join('/'), v.raw]);

describe('口语里的值（spoken-values）', () => {
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
    // 第二轮测量找到的缺口。
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

  it('没说上午下午的钟点给两种读法：1–6 点先当下午，7–11 点先当上午', () => {
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

/** 假模型：按问题里的字段名回答。记下问了哪些字段。 */
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

describe('给文字字段看的那段话（挖掉代码读出的值）', () => {
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

describe('说的话 → 任何一张表（D-575）', () => {
  it('收据：金额、日期由代码读，有把握；超市认得出分类', async () => {
    const out = await ruleEngine(spoken(RECEIPT, '我今天超市买了10块钱'));
    expect(first(out, 'amount')).toEqual({ value: '10', score: 1, sure: true });
    expect(first(out, 'date')).toMatchObject({ value: '2026-11-17', sure: true });
    expect(first(out, 'category')).toMatchObject({ value: 'grocery', sure: true });
    // 文字字段只有模型能截：只用规则时没有。
    expect(out.merchant).toBeUndefined();
  });

  it('数量不是金额：「3瓶水花了6块」金额是 6，「两个人吃了180」金额是 180', async () => {
    expect(first(await ruleEngine(spoken(RECEIPT, '买了3瓶水花了6块')), 'amount')).toMatchObject({
      value: '6',
      sure: true,
    });
    expect(first(await ruleEngine(spoken(RECEIPT, '两个人吃了180')), 'amount')).toMatchObject({
      value: '180',
      sure: true,
    });
  });

  it('两个金额拿不准：都给候选，不直接填；模型只能从这两个里挑，挑的排第一，也不直接填', async () => {
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

  it('待办：截止日期由代码读；事项由模型从原话里截一段，有把握', async () => {
    const asked: string[] = [];
    const out = await modelEngine(fakeModel({ 事项: '给妈妈打电话' }, asked))(
      spoken(TODO, '明天下午给妈妈打电话'),
    );
    expect(first(out, 'due')).toMatchObject({ value: '2026-11-18', sure: true });
    expect(first(out, 'title')).toMatchObject({ value: '给妈妈打电话', sure: true });
    // 勾选不填，也不问；日期代码有把握，不问。
    expect(out.done).toBeUndefined();
    expect(asked).toEqual(['事项']);
  });

  it('模型编出原话里没有的字：丢掉', async () => {
    const out = await modelEngine(fakeModel({ 事项: 'Call mom' }))(
      spoken(TODO, '明天给妈妈打电话'),
    );
    expect(out.title).toBeUndefined();
  });

  it('两个文字字段截到同一段：都不算有把握', async () => {
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

  it('备注这种自由填写的字段不问模型（第二轮测量：整句被填进备注）', async () => {
    const asked: string[] = [];
    await modelEngine(fakeModel({}, asked))(
      spoken([...RECEIPT, { id: 'note', name: '备注', type: 'text' }], '星巴克拿铁买了3杯一共96块'),
    );
    expect(asked).not.toContain('备注');
  });

  it('店名只当候选，截出来的也不直接填（第三轮测量：直接填的错得多）', async () => {
    const whole = await modelEngine(fakeModel({ 商家: '全家买的东西' }))(
      spoken(RECEIPT, '昨天在全家买的东西二十三块五'),
    );
    expect(first(whole, 'merchant')).toEqual({ value: '全家买的东西', score: 2 });
    const part = await modelEngine(fakeModel({ 商家: '全家' }))(
      spoken(RECEIPT, '昨天在全家买的东西二十三块五'),
    );
    expect(first(part, 'merchant')).toEqual({ value: '全家', score: 2 });
  });

  it('书名和作者一个答整句一个答一段（一段包着另一段）：都不直接填', async () => {
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

  it('收据的分类代码认不出时问模型，选了就有把握', async () => {
    const out = await modelEngine(fakeModel({ 分类: 'transport' }))(
      spoken(RECEIPT, '打车花了三十'),
    );
    expect(first(out, 'category')).toMatchObject({ value: 'transport', sure: true });
    expect(first(out, 'amount')).toMatchObject({ value: '30', sure: true });
  });

  it('别的单选：话里说了选项的名字就直接填；没说时模型可以答 none，空着', async () => {
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
    // 「高」在话里。
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

  it('没说上午下午：时间给两个候选，不直接填', async () => {
    const fields: Field[] = [{ id: 'at', name: '时间', type: 'time' }];
    const out = await ruleEngine(spoken(fields, '三点开会'));
    expect(out.at?.map((s) => [s.value, s.sure ?? false])).toEqual([
      ['15:00', false],
      ['03:00', false],
    ]);
  });

  it('日期时间字段：说了日子和钟点合成一个；只说了钟点是今天', async () => {
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

  it('跑步记录：带单位的数进同单位的字段，时长进时长字段', async () => {
    const fields: Field[] = [
      { id: 'km', name: '距离', type: 'number', unit: 'km' },
      { id: 'kg', name: '体重', type: 'number', unit: 'kg' },
      { id: 'time', name: '用时', type: 'duration' },
    ];
    const out = await ruleEngine(spoken(fields, '跑了5公里用了30分钟，体重65公斤'));
    expect(first(out, 'time')).toMatchObject({ value: '0:30', sure: true });
    // 两个数字字段在抢：候选按单位分开，但不直接填。
    expect(out.km?.map((s) => s.value)).toEqual(['5']);
    expect(out.kg?.map((s) => s.value)).toEqual(['65']);
  });

  it('评分：说了几星就填几星', async () => {
    const fields: Field[] = [
      { id: 'book', name: '书名', type: 'text' },
      { id: 'stars', name: '评分', type: 'rating' },
    ];
    expect(first(await ruleEngine(spoken(fields, '三体看完了给五星')), 'stars')).toMatchObject({
      value: '5',
      sure: true,
    });
  });

  it('附件、勾选、公式这类字段从不填', async () => {
    const fields: Field[] = [
      { id: 'f', name: '附件', type: 'file' },
      { id: 'c', name: '完成', type: 'checkbox' },
    ];
    expect(await modelEngine(fakeModel({}))(spoken(fields, '已经做完了，附上照片'))).toEqual({});
  });

  it('从文件读的文字（不是说的话）照旧：没有 sure', async () => {
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
