// Paired samples (prefill/pairs*/cases.jsonl, written by people who have not read the rule code):
// several pages of the same layout in order, each first prefilled, then saved according to the
// ground truth. Learning happens on save, so from the 2nd page onward, check if the reading is
// correct (the 1st page uses rules only). Each page is prefilled first, then "saved" according to
// the ground truth (user corrected it), and memory learns from it. Compared against rules only (no
// memory). Usage (repository root): npx tsx tests/local-model-eval/prefill/evaluate_pairs.ts
// [pairs|pairs2] [--show-wrong]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  isLearned,
  learnLayout,
  prefillRecord,
  type LayoutMemory,
} from '../../../packages/core/src/prefill';
import type { Field } from '../../../packages/core/src/schema';

type Locale = 'zh' | 'en' | 'fr';
interface Case {
  id: string;
  layout: string;
  seq: number;
  lang: Locale;
  variation: string;
  text: string;
  truth: Record<string, unknown>;
}
const NAMES: Record<Locale, [string, string, string, string]> = {
  zh: ['金额', '日期', '商家', '单号'],
  en: ['Amount', 'Date', 'Merchant', 'Number'],
  fr: ['Montant', 'Date', 'Commerçant', 'Numéro'],
};
const fieldsFor = (lang: Locale): Field[] => {
  const [amount, date, merchant, no] = NAMES[lang];
  return [
    { id: 'amount', name: amount, type: 'money', currency: 'EUR' },
    { id: 'date', name: date, type: 'date' },
    { id: 'merchant', name: merchant, type: 'text' },
    { id: 'invoiceNo', name: no, type: 'text' },
  ] as Field[];
};
const FIELDS = ['amount', 'date', 'merchant', 'invoiceNo'] as const;
type Outcome = 'correct' | 'wrong' | 'empty' | 'emptyOk' | 'filledNull';
const same = (field: string, a: unknown, b: unknown) =>
  field === 'amount' ? Math.abs(Number(a) - Number(b)) < 0.005 : a === b;

const show = process.argv.includes('--show-wrong');
const set = process.argv.find((a) => a.startsWith('pairs')) ?? 'pairs';
const cases = readFileSync(join(import.meta.dirname, set, 'cases.jsonl'), 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as Case);
const layouts = new Map<string, Case[]>();
for (const c of cases) layouts.set(c.layout, [...(layouts.get(c.layout) ?? []), c]);

const tally = new Map<string, Record<Outcome, number>>();
const count = (key: string, o: Outcome) => {
  const t = tally.get(key) ?? { correct: 0, wrong: 0, empty: 0, emptyOk: 0, filledNull: 0 };
  t[o]++;
  tally.set(key, t);
};
const learned: Record<string, number> = { amount: 0, date: 0, merchant: 0, invoiceNo: 0 };
const found = new Map<number, number>();
const blockedCount = new Map<string, number>();

for (const [layoutId, docs] of layouts) {
  docs.sort((a, b) => a.seq - b.seq);
  let memories: LayoutMemory[] = [];
  for (const doc of docs) {
    const fields = fieldsFor(doc.lang);
    const withMemory = prefillRecord({ text: doc.text, locale: doc.lang, fields, memories });
    if (doc.seq >= 2) {
      if (withMemory.layout) found.set(doc.seq, (found.get(doc.seq) ?? 0) + 1);
      for (const reason of Object.values(withMemory.blocked))
        blockedCount.set(reason, (blockedCount.get(reason) ?? 0) + 1);
      const rulesOnly = prefillRecord({ text: doc.text, locale: doc.lang, fields });
      for (const field of FIELDS) {
        const truth = doc.truth[field];
        for (const [version, got] of [
          ['memory', withMemory.values[field]?.value],
          ['rules', rulesOnly.values[field]?.value],
        ] as const) {
          const o: Outcome =
            truth === null || truth === undefined
              ? got === undefined
                ? 'emptyOk'
                : 'filledNull'
              : got === undefined
                ? 'empty'
                : same(field, truth, got)
                  ? 'correct'
                  : 'wrong';
          for (const key of [
            `${field} ${version} all`,
            `${field} ${version} seq${doc.seq}`,
            `${field} ${version} ${doc.variation}`,
            `${field} ${version} ${doc.lang}`,
          ])
            count(key, o);
          if (show && version === 'memory' && (o === 'wrong' || o === 'filledNull'))
            console.log(
              `WRONG ${doc.id} ${doc.variation} ${field} truth=${truth} got=${got} via=${withMemory.values[field]?.source}`,
            );
        }
      }
    }
    // User checks and saves the ground truth; memory learns from the saved values.
    const memory = learnLayout(
      withMemory.layout,
      {
        text: doc.text,
        fields,
        saved: doc.truth,
        prefilled: withMemory.values,
        candidates: withMemory.candidates,
      },
      layoutId,
    );
    if (memory) memories = [...memories.filter((m) => m.id !== memory.id), memory];
    if (doc.seq === 1)
      for (const field of FIELDS) {
        const habit = memory?.fields[field];
        if (habit && isLearned(habit)) learned[field]!++;
      }
  }
}
console.log(`${set}：版式数 ${layouts.size}；第 1 张保存后学会的字段：`, learned);
console.log('按张认出版式（有把握的）：', Object.fromEntries(found));
console.log('记忆学过、这次空着的原因：', Object.fromEntries(blockedCount));
console.log('字段 方式 分组 | 对 | 读错 | 该填没填 | 正确空着 | 不该填却填');
for (const [key, t] of [...tally].sort())
  console.log(`${key} | ${t.correct} | ${t.wrong} | ${t.empty} | ${t.emptyOk} | ${t.filledNull}`);
