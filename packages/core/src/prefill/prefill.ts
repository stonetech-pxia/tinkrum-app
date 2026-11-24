import type { Field, Locale } from '../schema';
import { extractFirst } from '../text-rules';
import {
  mergeCandidates,
  ruleCandidates,
  systemCandidates,
  type SystemMatch,
  type ValueCandidate,
} from './candidates';
import {
  anchorOf,
  isLearned,
  matchLayout,
  readWithLayout,
  reconcileLayout,
  SURE_LAYOUT_MATCH,
  type LayoutMemory,
  type LineBox,
} from './memory';
import { amountTier, labelOf, pickAmount, pickDate, pickTax } from './pick';

// "Log an expense" prefill (extension of D-244, prototype, not connected to UI). Order: 1. Fields
// learned by layout memory are read via memory; if any aspect of a new file mismatches or seems
// unreasonable compared to memory (layout only somewhat similar, memory cannot read it, rule
// reading differs, extra discount line not present in memory, unreasonable date), prefer leaving
// the field blank rather than falling back to rule-based guessing (founder decision 2026-10-28); 2.
// If no memory or memory cannot read it, pick via label rules (amount, tax, date, document number);
// candidates prioritize rules, with system recognition as fallback; 3. Leave blank if nothing can
// be picked. Un-rule-based fields like merchant rely solely on memory; category and other fields
// are not prefilled, nor prefilled by large models. Only forms are prefilled, saved only after user
// confirmation and tapping "Save" (D-187, D-190). Text stays on device, never sent to AI.

export type PrefillSource = 'memory' | 'rule' | 'system';

export interface PrefillValue {
  value: string | number;
  source: PrefillSource;
}

export interface PrefillInput {
  text: string;
  /** File language (year at end, English month-first when day and month are ambiguous). */
  locale: Locale;
  fields: readonly Field[];
  /** System recognition results; use rules only when absent (Expo Go, legacy systems). */
  system?: readonly SystemMatch[];
  /** Position of each line (line boxes from recognizeText), used by layout memory to pick under the same label. */
  boxes?: readonly (LineBox | null)[];
  /** Layout memory for this table. */
  memories?: readonly LayoutMemory[];
  /** Used for evaluating date reasonableness; defaults to current time. */
  now?: Date;
}

/** Reason why a learned memory item was skipped this time. */
export type PrefillBlock =
  'layoutUnsure' | 'memoryUnreadable' | 'conflictsWithRules' | 'newAdjustment' | 'implausible';

export interface PrefillResult {
  values: Record<string, PrefillValue>;
  /** Fields learned by memory but skipped this time along with reasons (for testing and debugging only, not displayed to user). */
  blocked: Record<string, PrefillBlock>;
  /** Recognized layout (passed to learnLayout upon saving); null if only somewhat similar, initiating a new one upon save. */
  layout: LayoutMemory | null;
  candidates: ValueCandidate[];
}

const TAX_NAME = /税|tax|tva|vat/i;
const NUMBER_NAME =
  /单号|编号|号码|发票号|订单号|invoice|receipt no|order no|number|\bno\b|n°|numéro|référence|\bref\b/i;

const sourceOf = (c: ValueCandidate): PrefillSource => (c.source === 'system' ? 'system' : 'rule');

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export function prefillRecord(input: PrefillInput): PrefillResult {
  const rules = ruleCandidates(input.text, input.locale);
  const candidates = input.system
    ? mergeCandidates(rules, systemCandidates(input.text, input.system))
    : rules;
  const match = input.memories ? matchLayout(input.memories, input.text) : null;
  const memory = match ? reconcileLayout(match.memory, input.fields) : null;
  const sure = match !== null && match.score >= SURE_LAYOUT_MATCH;
  const values: Record<string, PrefillValue> = {};
  const blocked: Record<string, PrefillBlock> = {};
  const now = input.now ?? new Date();
  const lines = input.text.split('\n');

  // When memory is absent, rules only recognize "amount, tax, date, document number": if there are multiple fields of the same type in the table, it becomes ambiguous and is left blank.
  const money = input.fields.filter((f) => f.type === 'money');
  const tax = money.filter((f) => TAX_NAME.test(f.name));
  const amount = money.filter((f) => !TAX_NAME.test(f.name));
  const dates = input.fields.filter((f) => f.type === 'date');
  const numbers = input.fields.filter((f) => f.type === 'text' && NUMBER_NAME.test(f.name));

  const byRules = (field: Field): ValueCandidate | null => {
    if (field.type === 'money' && amount.length === 1 && amount[0] === field)
      return pickAmount(input.text, candidates);
    if (field.type === 'money' && tax.length === 1 && tax[0] === field)
      return pickTax(input.text, candidates);
    if (field.type === 'date' && dates.length === 1) return pickDate(input.text, candidates);
    return null;
  };

  // Discounts, deductions, or negative lines unseen in memory: total calculation algorithm has changed, so memory's "where actual payment is" may no longer be correct.
  const anchors = new Set(memory?.anchors ?? []);
  const newAdjustment = candidates.some((c) => {
    if (c.kind !== 'amount') return false;
    const adjusts =
      Number(c.value) < 0 || amountTier(labelOf(lines, c, candidates).text, false) === -1;
    return adjusts && !anchors.has(anchorOf(lines[c.line] ?? ''));
  });

  /** Check whether the value read from memory has any unreasonable aspects; return reason if any. */
  const doubt = (field: Field, value: string): PrefillBlock | null => {
    if (field.type === 'money') {
      if (!(Number(value) > 0)) return 'implausible';
      if (newAdjustment && !tax.includes(field)) return 'newAdjustment';
    }
    if (field.type === 'date') {
      const t = Date.parse(`${value}T12:00:00`);
      if (!(t > now.getTime() - 10 * YEAR_MS && t < now.getTime() + YEAR_MS)) return 'implausible';
    }
    const ruled = byRules(field);
    if (ruled) {
      const same =
        field.type === 'money'
          ? Math.abs(Number(ruled.value) - Number(value)) < 0.005
          : ruled.value === value;
      if (!same) return 'conflictsWithRules';
    }
    return null;
  };

  for (const field of input.fields) {
    const habit = memory?.fields[field.id];
    // Constant text like merchant name: fill only if the new text contains the same value, otherwise treat as no memory (do not block rules).
    if (habit?.kind === 'constant') {
      const same = isLearned(habit) ? readWithLayout(habit, input.text, candidates) : null;
      if (sure && same !== null) {
        values[field.id] = { value: same, source: 'memory' };
        continue;
      }
    } else if (habit && isLearned(habit)) {
      // Memory has learned this field: fill strictly by memory; leave blank on any anomaly, do not fall back to rules.
      const remembered = sure ? readWithLayout(habit, input.text, candidates, input.boxes) : null;
      const reason: PrefillBlock | null = !sure
        ? 'layoutUnsure'
        : remembered === null
          ? 'memoryUnreadable'
          : doubt(field, remembered);
      if (reason || remembered === null) {
        blocked[field.id] = reason ?? 'memoryUnreadable';
        continue;
      }
      values[field.id] = {
        value: field.type === 'money' ? Number(remembered) : remembered,
        source: 'memory',
      };
      continue;
    }
    const picked = byRules(field);
    if (picked) {
      values[field.id] = {
        value: field.type === 'money' ? Number(picked.value) : picked.value,
        source: sourceOf(picked),
      };
      continue;
    }
    if (field.type === 'text' && numbers.length === 1 && numbers[0] === field) {
      const no = extractFirst(input.text, 'invoiceNo', input.locale);
      if (no) values[field.id] = { value: no, source: 'rule' };
    }
  }
  return { values, blocked, layout: sure ? memory : null, candidates };
}
