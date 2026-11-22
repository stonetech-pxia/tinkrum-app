import { localDate } from '../field-values';
import type { Field } from '../schema';
import { categoryByLexicon, categoryPromptOptions, type ChoiceField } from './category';
import { squash } from './check';
import { FREE_NOTE } from './code-rules';
import { conceptOf, type ConceptId } from './concepts';
import type { ModelRequest } from './model';
import { MAX_SUGGESTIONS, type SuggestInput, type ValueSuggestion } from './rank';
import { readSpoken, type SpokenKind, type SpokenValue } from './spoken-values';

// 说出来的一句话 → 这张表的字段（D-575）。任何一张表都行：按字段的类型分工，
// 「模型挑，代码读和核对」——金额、数字、日期、时间、时长、评分由代码从话里读（spoken-values.ts）；
// 文字字段由本机模型从话里截一段（必须是原话里的一段）；单选先看话里有没有选项的名字，没有再让模型从选项里挑。
// 话里有几个同类的值、或者表里有几个同类的字段时，模型只能从代码读出的值里挑一个（编不出新值），挑的结果只当候选。
// 有把握的候选标 sure：表单直接填（用户为这件事专门说的话，D-575）；没把握的照旧点了才填（D-394）。

type Suggestions = Record<string, ValueSuggestion[]>;

/** 要问模型的一个字段。 */
export interface SpokenAsk {
  fieldId: string;
  request: ModelRequest;
  /** 模型的回答 → 核对过的候选（核对不过是空的）。 */
  read(answer: string): ValueSuggestion[];
}

export interface SpokenPlan {
  /** 代码自己给的候选。 */
  code: Suggestions;
  asks: SpokenAsk[];
  /** 字段 ID → 类型（合并时用）。 */
  types: Record<string, Field['type']>;
}

const SYSTEM =
  'You read one sentence a person said to add an entry to a table (speech to text; it may have small mistakes). ' +
  'Then you are asked for one field at a time. Use only what the sentence says: no guessing, no outside knowledge. ' +
  'Output only the answer.';

const HINTS: Partial<Record<ConceptId, string>> = {
  merchant: 'the shop, restaurant or place name',
  company: 'the organization name',
  name: 'a person name',
  address: 'a place or address',
  phone: 'a phone number',
  email: 'an email address',
};

/** 写进 GBNF 的字符串。 */
const gbnf = (s: string) =>
  `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')}"`;

const prompt = (sentence: string, question: string) =>
  `<|im_start|>system\n${SYSTEM}<|im_end|>\n` +
  `<|im_start|>user\nSENTENCE: ${sentence.replace(/\s+/g, ' ').slice(0, 1000)}\n\n${question}<|im_end|>\n` +
  '<|im_start|>assistant\n<think>\n\n</think>\n\n';

const request = (
  sentence: string,
  question: string,
  grammar: string,
  nPredict: number,
): ModelRequest => ({
  prompt: prompt(sentence, question),
  grammar,
  temperature: 0,
  seed: 42,
  nPredict,
  stop: ['\n', '<|im_end|>'],
});

/** 文字字段：从话里截一段。 */
function textQuestion(f: Field): string {
  const concept = conceptOf(f);
  const hint = concept ? HINTS[concept] : undefined;
  return (
    `Field "${f.name}" (text)${hint ? `: ${hint}` : ''}. ` +
    'Copy only the words of the sentence for this field, exactly as said: leave out dates, times, amounts, ' +
    'and words like "remind me", "I need to", "I spent", "帮我记", "提醒我", "我要". ' +
    'Answer null if the sentence does not say it.'
  );
}

// 句首的「提醒我」「I need to」这类话不是内容。
const FILLER =
  /^(?:提醒我|帮我记一下|帮我记|记一下|记得要?|别忘了|我要|我需要|我得|我想|我们?(?=[\u3400-\u9fff])|remind me to|remind me|i need to|i have to|i want to|i must|i should|don'?t forget to|rappelle-moi de|rappelle-moi d'|rappelle-moi|il faut que je|je dois|n'oublie pas de|je voudrais)\s*/iu;
// 挖掉日期、钟点、金额以后两头剩下的虚词（「周五前交报告」→「前交报告」→「交报告」）。
const EDGE_HEAD =
  /^(?:之前|以前|前|在|于|再|就|by|on|at|before|for|in|à|au|le|la|pour|avant|vers|de|du)(?:\s+|(?=[\u3400-\u9fff]))/iu;
const EDGE_TAIL =
  /(?:之前|以前|前)$|\s+(?:by|on|at|before|for|in|à|au|le|la|pour|avant|vers|matin|soir|après-midi|morning|afternoon|evening)$/iu;

/**
 * 给文字字段看的话：代码读出的日期、钟点、金额、时长、评分、带单位的数挖掉，句首的「提醒我」这类话去掉。
 * 2B 模型常把整句抄回来（第二轮测量 35 处），挖掉以后整句抄回来也不带别的字段的值。
 */
export function textPart(sentence: string, found: readonly SpokenValue[]): string {
  let out = '';
  let at = 0;
  for (const v of [...found].sort((a, b) => a.start - b.start)) {
    if (v.start < at) continue;
    out += `${sentence.slice(at, v.start)} `;
    at = v.end;
  }
  out += sentence.slice(at);
  const parts = out
    .split(/[,，。.!！?？;；]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  let s = parts.join('，').replace(/\s+/g, ' ').trim();
  // 中文挖掉值的地方不留空格（「在 协和医院看牙」）。
  s = s.replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/gu, '$1');
  for (let i = 0; i < 4; i++) {
    const before = s;
    s = s.replace(FILLER, '').replace(EDGE_HEAD, '').replace(EDGE_TAIL, '').trim();
    s = s.replace(/^[，,\s]+|[，,\s]+$/g, '');
    if (s === before) break;
  }
  return s;
}

/** 去掉回答两头的引号和标点。 */
const tidy = (s: string) =>
  s
    .trim()
    .replace(/^["'“”‘’「」]+|["'“”‘’「」]+$/g, '')
    .replace(/^[\s,，。.!！?？;；:：]+|[\s,，。.!！?？;；:：]+$/g, '')
    .trim();

// 字段类型 → 代码读出的哪种值。
const KIND_OF: Partial<Record<Field['type'], SpokenKind>> = {
  date: 'date',
  time: 'time',
  duration: 'duration',
  rating: 'rating',
  money: 'money',
  number: 'number',
};

const UNIT_SYNONYMS: readonly (readonly string[])[] = [
  [
    'km',
    'kms',
    '公里',
    '千米',
    'kilometer',
    'kilometers',
    'kilometre',
    'kilometres',
    'kilomètre',
    'kilomètres',
  ],
  ['kg', 'kgs', '公斤', '千克', 'kilo', 'kilos'],
  ['l', '升', 'liter', 'liters', 'litre', 'litres'],
  ['mi', 'mile', 'miles'],
  ['lb', 'lbs'],
  ['页', 'page', 'pages'],
];
const sameUnit = (a: string, b: string) => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x === y || UNIT_SYNONYMS.some((group) => group.includes(x) && group.includes(y));
};

const suggestion = (value: string, sure: boolean, score = 1): ValueSuggestion =>
  sure ? { value, score, sure: true } : { value, score };

/** 选项的名字在话里（拉丁词要整词）。 */
function optionsInText(field: ChoiceField, sentence: string): string[] {
  const low = sentence.toLowerCase();
  const hits: string[] = [];
  for (const o of field.options) {
    const label = o.label.trim().toLowerCase();
    if (!label) continue;
    const at = low.indexOf(label);
    if (at < 0) continue;
    const latin = /[a-z0-9]/i.test(label);
    const edge = (c: string | undefined) => c === undefined || !/[\p{L}\p{N}]/u.test(c);
    if (latin && !(edge(low[at - 1]) && edge(low[at + label.length]))) continue;
    hits.push(o.id);
  }
  return hits;
}

/** 这句话按这张表的字段分好：代码的候选和要问模型的字段。 */
export function planSpoken(input: SuggestInput): SpokenPlan {
  const sentence = input.pages
    .flatMap((p) => p.lines.map((l) => l.text))
    .join(' ')
    .trim();
  const now = input.now ?? new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const found = sentence ? readSpoken(sentence, today) : [];
  const code: Suggestions = {};
  const asks: SpokenAsk[] = [];
  const types: Record<string, Field['type']> = {};
  const claimed = new Set<SpokenValue>();
  const fields = input.fields;
  const hasMoney = fields.some((f) => f.type === 'money');
  for (const f of fields) types[f.id] = f.type;

  const pool = (f: Field): SpokenValue[] => {
    const kind = KIND_OF[f.type];
    if (f.type === 'money') {
      const marked = found.filter((v) => v.kind === 'money');
      return marked.length > 0 ? marked : found.filter((v) => v.kind === 'number' && !v.unit);
    }
    if (f.type === 'number') {
      const unit = 'unit' in f ? f.unit : undefined;
      const numbers = found.filter((v) => v.kind === 'number' || (!hasMoney && v.kind === 'money'));
      if (unit) {
        const same = numbers.filter((v) => v.unit !== undefined && sameUnit(v.unit, unit));
        if (same.length > 0) return same;
      }
      return numbers;
    }
    return kind ? found.filter((v) => v.kind === kind) : [];
  };

  // 从代码读出的值里挑一个：问模型时只给它这几个原话里的写法。
  const pickAsk = (f: Field, options: readonly SpokenValue[]) => {
    const raws = [...new Set(options.map((v) => v.raw))];
    asks.push({
      fieldId: f.id,
      request: request(
        sentence,
        `Field "${f.name}" (${f.type}). Which of these parts of the sentence is this field: ${raws
          .map((r) => `"${r}"`)
          .join(', ')}? Answer null if none.`,
        `root ::= "null" | ${raws.map(gbnf).join(' | ')}`,
        48,
      ),
      read: (answer) => {
        const hit = options.find((v) => v.raw === answer.trim());
        return hit ? hit.values.map((value) => suggestion(value, false, 2)) : [];
      },
    });
  };

  // 有序：先日期、时间，再时长、评分、金额，最后数字（金额拿走的数，数字字段不再给）。
  const order: Field['type'][] = [
    'date',
    'time',
    'datetime',
    'duration',
    'rating',
    'money',
    'number',
  ];
  for (const type of order) {
    const same = fields.filter((f) => f.type === type);
    for (const f of same) {
      if (f.type === 'datetime') {
        const dates = found.filter((v) => v.kind === 'date' && !claimed.has(v));
        const times = found.filter((v) => v.kind === 'time' && !claimed.has(v));
        if (times.length === 0) continue;
        const day =
          dates.length === 1 ? dates[0]!.values[0]! : dates.length === 0 ? localDate(today) : null;
        if (day === null) continue;
        const sure =
          same.length === 1 &&
          dates.length <= 1 &&
          times.length === 1 &&
          times[0]!.values.length === 1;
        code[f.id] = times
          .flatMap((t) => t.values)
          .slice(0, MAX_SUGGESTIONS)
          .map((t, i) => suggestion(`${day} ${t}`, sure && i === 0));
        if (sure) for (const v of [...dates, ...times]) claimed.add(v);
        continue;
      }
      const available = pool(f).filter((v) => !claimed.has(v));
      if (available.length === 0) continue;
      const competing =
        same.length +
        (f.type === 'date' || f.type === 'time'
          ? fields.filter((x) => x.type === 'datetime').length
          : 0);
      const distinct = [...new Set(available.map((v) => v.values.join('|')))];
      const sure = competing === 1 && distinct.length === 1 && available[0]!.values.length === 1;
      code[f.id] = [...new Set(available.flatMap((v) => v.values))]
        .slice(0, MAX_SUGGESTIONS)
        .map((value, i) => suggestion(value, sure && i === 0));
      if (sure) {
        for (const v of available) claimed.add(v);
      } else if (distinct.length > 1 || competing > 1) {
        pickAsk(f, available);
      }
    }
  }

  for (const f of fields) {
    if (f.type === 'choice') {
      const named = optionsInText(f, sentence);
      if (named.length === 1) {
        code[f.id] = [suggestion(named[0]!, true)];
        continue;
      }
      if (named.length > 1) {
        code[f.id] = named.slice(0, MAX_SUGGESTIONS).map((id) => suggestion(id, false));
        continue;
      }
      const category = conceptOf(f) === 'category';
      if (category) {
        const id = categoryByLexicon([sentence]);
        if (id !== null && f.options.some((o) => o.id === id)) {
          code[f.id] = [suggestion(id, true)];
          continue;
        }
      }
      const options = categoryPromptOptions(f);
      if (options.length < 2 || !sentence) continue;
      // 分类（收据的六类有「其他」）一定选一个；别的单选可以说「none」（话里没说优先级就空着）。
      const names = category ? options.map((o) => o.name) : [...options.map((o) => o.name), 'none'];
      asks.push({
        fieldId: f.id,
        request: request(
          sentence,
          `Field "${f.name}" (one choice). Options:\n${options.map((o) => o.line).join('\n')}${
            category ? '' : '\n- none: the sentence does not say'
          }\n\nWhich option?`,
          `root ::= ${names.map(gbnf).join(' | ')}`,
          48,
        ),
        read: (answer) => {
          const hit = options.find((o) => o.name === answer.trim());
          return hit ? [suggestion(hit.id, true, 2)] : [];
        },
      });
      continue;
    }
  }

  // 文字字段：备注这种自由填写的不问（第二轮测量：模型把整句填进备注 15 处）；别的从挖掉了值的话里截一段。
  const rest = textPart(sentence, found);
  const texts = fields.filter((f) => f.type === 'text' && !FREE_NOTE.test(f.name.trim()));
  if (rest) {
    for (const f of texts) {
      // 店名、公司、人名、地址这种有具体意思的字段只给候选（第三轮测量：店名直接填的 5 个错了 3 个）。
      // 别的字段截出一段才算有把握；整段抄回来只有表里唯一一个要问的文字字段（待办的「事项」）才算。
      const plain = conceptOf(f) === null;
      const wholeOk = texts.length === 1;
      asks.push({
        fieldId: f.id,
        request: request(rest, textQuestion(f), 'root ::= "null" | [^\\n<|]+', 80),
        read: (answer) => {
          const s = tidy(answer);
          if (!s || s.toLowerCase() === 'null' || s.length > 200) return [];
          // 编不出话里没有的字：必须是这段话里的一段。
          if (!squash(rest).includes(squash(s))) return [];
          return [suggestion(s, plain && (wholeOk || squash(s) !== squash(rest)), 2)];
        },
      });
    }
  }
  return { code, asks, types };
}

/** 代码的候选加上模型答过的（模型的在前），每个字段最多 MAX_SUGGESTIONS 个；两个文字字段截到同一段时都不算有把握。 */
export function mergeSpoken(
  plan: SpokenPlan,
  answers: ReadonlyMap<string, readonly ValueSuggestion[]>,
): Suggestions {
  const out: Suggestions = {};
  const ids = new Set([...Object.keys(plan.code), ...answers.keys()]);
  for (const id of ids) {
    const list: ValueSuggestion[] = [];
    for (const s of [...(answers.get(id) ?? []), ...(plan.code[id] ?? [])]) {
      if (list.some((x) => x.value === s.value)) continue;
      // 模型挑了一个时，代码原来的「有把握」不再算（同一个值除外）。
      list.push(list.length > 0 && s.sure ? suggestion(s.value, false, s.score) : s);
    }
    if (list.length > 0) out[id] = list.slice(0, MAX_SUGGESTIONS);
  }
  const textFirsts = Object.entries(out).filter(([id]) => plan.types[id] === 'text');
  const sureText = textFirsts.filter(([, list]) => list[0]?.sure);
  for (const [id, list] of sureText) {
    // 两个字段截到同一段、或一段包着另一段（书名和作者答成一句）：都不算有把握。
    const mine = squash(list[0]!.value);
    if (
      textFirsts.some(([other, l]) => {
        const theirs = squash(l[0]!.value);
        return other !== id && (theirs.includes(mine) || mine.includes(theirs));
      })
    )
      out[id] = list.map((s) => suggestion(s.value, false, s.score));
  }
  return out;
}
