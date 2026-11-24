import { localDate } from '../field-values';
import type { Field } from '../schema';
import { categoryByLexicon, categoryPromptOptions, type ChoiceField } from './category';
import { squash } from './check';
import { FREE_NOTE } from './code-rules';
import { conceptOf, type ConceptId } from './concepts';
import type { ModelRequest } from './model';
import { MAX_SUGGESTIONS, type SuggestInput, type ValueSuggestion } from './rank';
import { readSpoken, type SpokenKind, type SpokenValue } from './spoken-values';

// Spoken sentence -> fields of this table (D-575). Any table works: division of labor by field type
// — "model picks, code reads and verifies". Amounts, numbers, dates, times, durations, ratings, and
// scores are read from speech by code (spoken-values.ts); text fields are extracted as a substring
// from speech by the on-device model (must be a substring of the original text); single-selects
// first check if option names are mentioned in speech, otherwise let the model pick from options.
// When speech contains multiple values of the same type, or the table contains multiple fields of
// the same type, the model can only pick from the values read by code (cannot invent new values),
// and the picked result serves only as a candidate. Confident candidates are marked sure and filled
// directly into the form (user-specific spoken input for this matter, D-575); uncertain ones
// require manual tap as before (D-394).

type Suggestions = Record<string, ValueSuggestion[]>;

/** A field to ask the model about. */
export interface SpokenAsk {
  fieldId: string;
  request: ModelRequest;
  /** Model answer -> verified candidates (empty if unverified). */
  read(answer: string): ValueSuggestion[];
}

export interface SpokenPlan {
  /** Candidates provided by code itself. */
  code: Suggestions;
  asks: SpokenAsk[];
  /** Field ID -> type (used during merging). */
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

/** String written into GBNF. */
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

/** Text field: extract a substring from speech. */
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

// Sentence-initial filler words like "remind me" or "I need to" are not content.
const FILLER =
  /^(?:提醒我|帮我记一下|帮我记|记一下|记得要?|别忘了|我要|我需要|我得|我想|我们?(?=[\u3400-\u9fff])|remind me to|remind me|i need to|i have to|i want to|i must|i should|don'?t forget to|rappelle-moi de|rappelle-moi d'|rappelle-moi|il faut que je|je dois|n'oublie pas de|je voudrais)\s*/iu;
// Function words remaining at both ends after removing dates, times, and amounts ("submit report before Friday" -> "before submit report" -> "submit report").
const EDGE_HEAD =
  /^(?:之前|以前|前|在|于|再|就|by|on|at|before|for|in|à|au|le|la|pour|avant|vers|de|du)(?:\s+|(?=[\u3400-\u9fff]))/iu;
const EDGE_TAIL =
  /(?:之前|以前|前)$|\s+(?:by|on|at|before|for|in|à|au|le|la|pour|avant|vers|matin|soir|après-midi|morning|afternoon|evening)$/iu;

/**
 * Speech text shown to text fields: code-read dates, times, amounts, durations, ratings, and
 * unit-ed numbers are excised, and sentence-initial filler words like "remind me" are removed. 2B
 * models often echo the full sentence back (35 instances in second-round measurement); even if
 * echoed back after excision, it will not carry other fields' values.
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
  // Do not leave spaces where values are excised in Chinese ("Visit Peking Union Medical College Hospital for teeth").
  s = s.replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/gu, '$1');
  for (let i = 0; i < 4; i++) {
    const before = s;
    s = s.replace(FILLER, '').replace(EDGE_HEAD, '').replace(EDGE_TAIL, '').trim();
    s = s.replace(/^[，,\s]+|[，,\s]+$/g, '');
    if (s === before) break;
  }
  return s;
}

/** Remove quotes and punctuation from both ends of the answer. */
const tidy = (s: string) =>
  s
    .trim()
    .replace(/^["'“”‘’「」]+|["'“”‘’「」]+$/g, '')
    .replace(/^[\s,，。.!！?？;；:：]+|[\s,，。.!！?？;；:：]+$/g, '')
    .trim();

// Field type -> which kind of value code reads.
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

/** Option name is in speech (Latin words require whole-word match). */
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

/** Sentence parsed according to this table's fields: code candidates and fields to ask the model. */
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

  // Pick one from code-read values: provide only these original phrasings to the model when asking.
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

  // Ordered: dates and times first, then durations, ratings, amounts, and finally numbers (amounts take numbers, so number fields no longer receive them).
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
      // Categories (the six receipt categories include "other") must choose one; other single-selects can say "none" (leave blank if priority not mentioned in speech).
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

  // Text fields: free-form fields like remarks are not asked (second-round measurement: model filled entire sentence into remarks 15 times); others extract a substring from the value-excised text.
  const rest = textPart(sentence, found);
  const texts = fields.filter((f) => f.type === 'text' && !FREE_NOTE.test(f.name.trim()));
  if (rest) {
    for (const f of texts) {
      // Specific-meaning fields like merchant name, company, person name, address only receive
      // candidates (third-round measurement: 3 out of 5 directly filled merchant names were wrong).
      // Other fields are considered confident only when a substring is extracted; full-sentence
      // echoes are confident only if it is the sole text field to be asked (such as todo "item").
      const plain = conceptOf(f) === null;
      const wholeOk = texts.length === 1;
      asks.push({
        fieldId: f.id,
        request: request(rest, textQuestion(f), 'root ::= "null" | [^\\n<|]+', 80),
        read: (answer) => {
          const s = tidy(answer);
          if (!s || s.toLowerCase() === 'null' || s.length > 200) return [];
          // Cannot invent words not present in speech: must be a substring of this text.
          if (!squash(rest).includes(squash(s))) return [];
          return [suggestion(s, plain && (wholeOk || squash(s) !== squash(rest)), 2)];
        },
      });
    }
  }
  return { code, asks, types };
}

/** Code candidates plus model answers (model answers first), up to MAX_SUGGESTIONS per field; neither is considered confident when two text fields extract the same segment. */
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
      // When the model picks one, code's original "sure" status is no longer counted (except for the same value).
      list.push(list.length > 0 && s.sure ? suggestion(s.value, false, s.score) : s);
    }
    if (list.length > 0) out[id] = list.slice(0, MAX_SUGGESTIONS);
  }
  const textFirsts = Object.entries(out).filter(([id]) => plan.types[id] === 'text');
  const sureText = textFirsts.filter(([, list]) => list[0]?.sure);
  for (const [id, list] of sureText) {
    // When two fields extract the same segment, or one nests the other (book title and author answered as a single sentence): neither is considered confident.
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
