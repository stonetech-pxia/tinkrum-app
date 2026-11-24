import type { Field, Locale } from '../schema';
import { ruleCandidates } from './candidates';
import { amountChain, amountNear } from './amount-chain';
import { canAskCategory, categoryByCode, currencyInText } from './category';
import { hasNoDecimals, rowHasDate, squash } from './check';
import { conceptOf, type ConceptId } from './concepts';
import { cardRules, ctx, receiptRules, resetDocContext, type DocumentKind } from './doc-context';
import { fieldNameKey } from './field-names';
import { documentLanguage } from './model';
import {
  learnedLabels,
  MAX_SUGGESTIONS,
  setDocContext,
  suggestValues,
  type SuggestInput,
  type ValueSuggestion,
} from './rank';
import { pageOccurrences, type Occurrence } from './rows';
import { analyzeCard, cardCandidates, cardLike, looseEmails } from './card-rules';
import { addressCandidates } from './address-rules';
import { NOT_ISSUE_DATE_LEFT, PRINT_WORD_LEFT } from './rules-data';
import { contactCodeValues, parseContactCode } from '../vcard';
import {
  BAD_DATE_ROW,
  DEPART_ROW,
  HOTEL_DOC,
  invoiceNoByKey,
  mayHaveNumber,
  NOT_NO,
  stripNoPrefix,
  TRAVEL_DOC,
  upperAmount,
} from './zh-rules';

// Candidates for each field when not using the model (D-394 rule scoring + arithmetic + Chinese rules + value memory), as well as fields where code is certain and does not need to ask the model.

/**
 * Confidence threshold for code (score of first candidate ≥ top, and difference from second ≥
 * gap). Determined by two-fold cross-validation, taking the stricter one
 * (per-field/hybrid/plan.json, these cells are 96% correct on real receipts); totals re-measured
 * using D-403 rules, set to 3.5 (D-404). Unlisted fields are never considered confident.
 */
const SURE: Partial<Record<ConceptId, { top: number; gap: number }>> = {
  amount: { top: 3.5, gap: 1 },
  issueDate: { top: 0, gap: 0 },
  email: { top: 0, gap: 0 },
  category: { top: 0, gap: 0 },
  number: { top: 0, gap: 3 },
  tax: { top: 2.5, gap: 0 },
  destination: { top: 0, gap: 0 },
};
/** When rules yield no candidates, these fields are mostly absent (not necessarily printed on the document) and are not asked of the model. */
const EMPTY_IS_SURE: ReadonlySet<ConceptId> = new Set([
  'number',
  'tax',
  'email',
  'origin',
  'destination',
]);

/**
 * Freely filled fields: documents lack their values, and asking the model only yields useless
 * candidates like addresses or phone numbers (observed on iOS simulator on 2026-11-01; D-394 also
 * avoids listing candidates for such fields).
 */
export const FREE_NOTE = /^(备注|附注|说明|notes?|remarks?|comments?|remarques?|commentaires?)$/i;

export interface FieldPlan {
  field: Field;
  /** Candidates provided by code (best first), before value memory. */
  code: ValueSuggestion[];
  /** A value previously saved in this table that also appears in the current text. */
  remembered: ValueSuggestion | null;
  /** Values explicitly stated in QR codes (D-423): placed at the very front, no need to ask the model. */
  fromCode: ValueSuggestion[];
  /** Whether code is uncertain and needs to ask the model. */
  ask: boolean;
  /** Keep rule candidates at the front even if the model is asked (for Chinese receipt totals, the model often picks subtotal, D-404). */
  codeFirst: boolean;
}

const CARD_NO_ASK = new Set<ConceptId>(['phone', 'email', 'website', 'address']);

export interface DocumentPlan {
  /** Which rule set to use: must be consistent when asking the model and verifying the model's answer. */
  kind: DocumentKind;
  /** Full text, one row per line (concatenated across pages). */
  rows: string[];
  fields: FieldPlan[];
  /** Row index where a value not given by rule scoring (arithmetic, value memory, model) was found; missing if not found, not recorded. */
  pickOf(value: string): ValueSuggestion['pick'];
}

/** Which fields in this table use value memory: store name, company (values of other fields change across documents). */
export const usesValueMemory = (f: Field) => {
  const c = conceptOf(f);
  return (f.type === 'text' || f.type === 'note') && (c === 'merchant' || c === 'company');
};

/**
 * Query value memory from existing records in this table (field ID → saved value). Invariant 14:
 * values are not stored separately; records are read-only. The values in each record were saved
 * by the user themselves and are never sent to the cloud AI (invariant 2).
 */
export function knownValues(
  fields: readonly Field[],
  records: readonly { values: Readonly<Record<string, unknown>> }[],
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const f of fields) {
    if (!usesValueMemory(f)) continue;
    const seen = new Set<string>();
    for (const r of records) {
      const v = r.values[f.id];
      if (typeof v === 'string' && v.trim()) seen.add(v.trim());
    }
    if (seen.size > 0) out[f.id] = [...seen];
  }
  return out;
}

const HAS_CJK = /[㐀-鿿]/;
const LOWER = (t: string) => t.normalize('NFKC').toLowerCase();
const ESCAPE = /[.*+?^${}()|[\]\\]/g;

/** Whether a saved value appears verbatim in this row: English and numbers require whole words (spacing can vary); Chinese requires the entire row or sufficient length (2-3 characters are too easily the start of another name). */
function rowHasValue(value: string, row: string): boolean {
  const sq = squash(value);
  if (sq.length < 2) return false;
  if (HAS_CJK.test(sq)) {
    const whole = squash(row);
    return whole === sq || (sq.length >= 4 && whole.includes(sq));
  }
  const body = [...sq].map((c) => c.replace(ESCAPE, '\\$&')).join('\\s*');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'u').test(LOWER(row));
}

/** The longest saved value appearing verbatim in the current text (on the same row). */
function rememberedValue(
  known: readonly string[] | undefined,
  rows: readonly string[],
): string | null {
  const hits = (known ?? []).filter((v) => rows.some((r) => rowHasValue(v, r)));
  return [...hits].sort((a, b) => b.length - a.length)[0] ?? null;
}

const withPick = (value: string, pick: ValueSuggestion['pick']): ValueSuggestion => ({
  value,
  score: 0,
  ...(pick ? { pick } : {}),
});

/**
 * Hotel bills: latest date in the entire text (validity-style rows are excluded). When text
 * cannot distinguish day and month, reads strictly according to the language's primary format,
 * without choosing the later of two interpretations; highlights when the latest date happens to
 * be of this validity type.
 */
function latestDate(
  rows: readonly string[],
  locale: Locale,
): { value: string; ambiguous: boolean } | null {
  let best: { value: string; ambiguous: boolean } | null = null;
  for (const row of rows) {
    if (BAD_DATE_ROW.test(row)) continue;
    const dates = ruleCandidates(row, locale).filter((c) => c.kind === 'date');
    const seen = new Set<number>();
    for (const c of dates) {
      // Printed dates like "Time printed : 28-OCT-20" are excluded from latest dates.
      if (receiptRules() && PRINT_WORD_LEFT.test(row.slice(Math.max(0, c.start - 30), c.start)))
        continue;
      if (seen.has(c.start)) continue;
      seen.add(c.start);
      const ambiguous = dates.some((o) => o.start === c.start && o.value !== c.value);
      if (!best || c.value > best.value || (c.value === best.value && !ambiguous))
        best = { value: c.value, ambiguous };
    }
  }
  return best;
}

/** Whether two candidates count as the same value. */
export const sameValue = (f: Field, a: string, b: string) =>
  f.type === 'money' || f.type === 'number'
    ? Math.abs(Number(a) - Number(b)) < 0.005
    : squash(a) === squash(b);

/**
 * Whether this date (YYYY-MM-DD) in this row is exclusively a validity or return deadline date:
 * its preceding 30 characters contain BAD_DATE_ROW or terms like "validity, return by, refund".
 * Evaluated per row if the value is not recognizable within the row.
 */
function badLeft(row: string, value: string, locale: Locale): boolean {
  const hits = ruleCandidates(row, locale).filter((c) => c.kind === 'date' && c.value === value);
  if (hits.length === 0) return BAD_DATE_ROW.test(row);
  return hits.every((c) => {
    const left = row.slice(Math.max(0, c.start - 30), c.start);
    return BAD_DATE_ROW.test(left) || NOT_ISSUE_DATE_LEFT.test(left);
  });
}

/** Values read from QR codes in attachments (field ID → value): earlier codes appear first, other text is ignored (D-423). */
function codeValues(input: SuggestInput): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const text of input.codes ?? []) {
    const code = parseContactCode(text);
    if (!code) continue;
    for (const [id, values] of Object.entries(contactCodeValues(input.fields, code)))
      out[id] = [...(out[id] ?? []), ...values];
  }
  return out;
}

/** Only one occurrence of a raw value exists after the label (different readings of the same occurrence count as one); ambiguous when different values exist, so not counted. */
function valuesAfterLabel(
  field: Field,
  key: string,
  occurrences: readonly Occurrence[],
): Occurrence[] {
  const money = field.type === 'money' || field.type === 'number';
  const text = field.type === 'text' || field.type === 'note';
  if (!key || (!money && !text && field.type !== 'date')) return [];
  const hits = occurrences.filter(
    (o) =>
      o.label &&
      fieldNameKey(o.label) === key &&
      (text ? !o.other : o.kind === (money ? 'money' : 'date')),
  );
  return new Set(hits.map((o) => o.raw.trim())).size === 1 ? hits : [];
}

/** Rule results and plan for this document. */
export function planDocument(input: SuggestInput): DocumentPlan {
  // Date and amount parsing rules require currency, full text, and "now"; clears context after calculation to prevent the next document from using the current one's context.
  setDocContext(input);
  try {
    return planDocumentInner(input);
  } finally {
    resetDocContext();
  }
}

function planDocumentInner(input: SuggestInput): DocumentPlan {
  const pages = input.pages.map((p, i) => pageOccurrences(p, i, input.locale));
  const rows = pages.flatMap((p) => p.rows.map((r) => r.text));
  const scored = suggestValues(input);
  const upper = upperAmount(rows);
  const keyedNo = invoiceNoByKey(rows);
  const hotel =
    rows.some((r) => DEPART_ROW.test(r)) &&
    rows.some((r) => HOTEL_DOC.test(r)) &&
    !rows.some((r) => TRAVEL_DOC.test(r));
  const occurrences = pages.flatMap((p) => p.occ);
  const coded = cardRules() ? codeValues(input) : {};

  // For values not given by rule scoring: record their row index (for memory usage after tapping, D-394), and use the label from that location.
  const pickOf = (value: string): ValueSuggestion['pick'] => {
    const sq = squash(value);
    const hit =
      occurrences.find((o) => squash(o.value) === sq || squash(o.raw) === sq) ??
      occurrences.find((o) => Number(o.value) === Number(value) && value.trim() !== '');
    if (hit)
      return {
        label: hit.label,
        relY: Math.round(hit.relY * 1000) / 1000,
        ...(hit.dateOrder ? { order: hit.dateOrder } : {}),
      };
    for (const p of pages) {
      const row = p.rows.find((r) => squash(r.text).includes(sq));
      if (row) return { label: '', relY: Math.round(row.relY * 1000) / 1000 };
    }
    return undefined;
  };
  const fromCode = (field: Field, value: string): ValueSuggestion =>
    // Choice values are option IDs and do not exist in text: no position to record (D-405).
    field.type === 'choice' ? { value, score: 0 } : withPick(value, pickOf(value));

  const fields = input.fields.map((field): FieldPlan => {
    const concept = conceptOf(field);
    // Categories (choice): if option name is written on the ticket or vocabulary confidence is high, do not ask the model (D-405).
    const category = field.type === 'choice' && concept === 'category';
    let list = scored[field.id] ?? [];
    if (
      cardRules() &&
      (concept === 'website' ||
        concept === 'jobTitle' ||
        concept === 'name' ||
        // Stricter criteria for company column: must also have phone, email, or website, and row count cannot be excessive.
        (concept === 'company' && cardLike(analyzeCard(input.pages), true)))
    )
      list = cardCandidates(concept, input.pages);
    let code: string | null | undefined;
    const noDecimals = hasNoDecimals(field);
    const extras: string[] = [];
    // Arithmetic results appearing after the first scored candidate (see below).
    const second: string[] = [];
    if (concept === 'issueDate') {
      // Dates on validity, return deadline, and print rows are excluded.
      list = list.filter((s) =>
        rows.some((r) =>
          receiptRules()
            ? rowHasDate(r, s.value) && !badLeft(r, s.value, input.locale)
            : !BAD_DATE_ROW.test(r) && rowHasDate(r, s.value),
        ),
      );
      if (hotel) {
        const latest = latestDate(rows, input.locale);
        // When the latest date has ambiguous day/month: not considered confident, candidate ordering is left to rule scoring (by language).
        if (latest && !latest.ambiguous) {
          code = latest.value;
          extras.push(latest.value);
        }
      }
    } else if (concept === 'number') {
      // Exclude rows for serial numbers, social security numbers, company numbers, and addresses; strip NO prefix.
      list = list
        .filter((s) => !rows.some((r) => squash(r).includes(squash(s.value)) && NOT_NO.test(r)))
        .map((s) => ({ ...s, value: stripNoPrefix(s.value) }));
      if (keyedNo) {
        code = keyedNo;
        extras.push(keyedNo);
      }
    } else if (concept === 'amount') {
      if (upper?.sure) {
        code = String(upper.value);
        extras.push(code);
      }
      const chain = amountChain(rows, noDecimals, input.locale);
      if (chain) {
        // When arithmetic is derived solely from line-item summation (not payment minus change),
        // the arithmetic result is absent from rule scoring, and the first scored candidate has a
        // label score ≥ 3 (label explicitly states total), place the arithmetic result second
        // rather than preempting the first: in misaligned layouts, "Change 7.00" might otherwise be
        // treated as the total.
        if (
          receiptRules() &&
          chain.how !== 'payMinusChange' &&
          (list[0]?.score ?? 0) >= 3 &&
          !list.some((s) => Math.abs(Number(s.value) - chain.value) < 0.005)
        )
          second.push(String(chain.value));
        else extras.push(String(chain.value));
        const top = list[0]?.value;
        if (
          code === undefined &&
          (chain.how === 'payMinusChange' ||
            (top !== undefined && amountNear(chain.value, Number(top), noDecimals)))
        )
          code = String(chain.value);
      }
    }
    if (concept === 'address' && cardRules())
      list = addressCandidates(analyzeCard(input.pages)).slice(0, 3);
    if (concept === 'email' && cardRules()) {
      const extra = looseEmails(analyzeCard(input.pages)).filter(
        (e) => !list.some((s) => s.value.toLowerCase() === e.value),
      );
      list = [...list, ...extra].slice(0, 3);
    }
    const top = list[0];
    if (code === undefined && top && concept) {
      const sure = SURE[concept];
      if (sure && top.score >= sure.top && top.score - (list[1]?.score ?? 0) >= sure.gap)
        code = top.value;
      else if (concept === 'phone') code = top.value;
    }
    if (code === undefined && category && field.type === 'choice')
      code = categoryByCode(field, rows) ?? undefined;
    // This is the amount currency (D-429): currency printed on the ticket. Added to candidates only, filled only when tapped by the user.
    if (
      code === undefined &&
      field.type === 'choice' &&
      input.fields.some((f) => f.type === 'money' && f.currencyField === field.id)
    )
      code = currencyInText(field, rows) ?? undefined;
    if (code === undefined && !top && concept && EMPTY_IS_SURE.has(concept)) {
      // When text contains document number key names but code cannot extract a value, it indicates uncertainty rather than absence: must ask the model.
      if (concept !== 'number' || !mayHaveNumber(rows)) code = null;
    }

    const merged: ValueSuggestion[] = [];
    const add = (s: ValueSuggestion) => {
      if (!merged.some((m) => sameValue(field, m.value, s.value))) merged.push(s);
    };
    // Learned labels (most recently tapped first) and field names: values adjacent to exact file
    // matches rank first. Disregarded if rejected by user; receipt and business card tables use
    // specialized measured rules rather than this flow.
    const pickNow = input.picks?.[field.id];
    const learned = input.rules ? [] : learnedLabels(pickNow);
    const trusted = input.rules
      ? []
      : [
          ...learned,
          ...(learned.some((l) => l.label === fieldNameKey(field.name))
            ? []
            : [{ label: fieldNameKey(field.name) }]),
        ].filter((l) => !('rejected' in l && l.rejected));
    const exact: ValueSuggestion[] = [];
    for (const l of trusted) {
      const hits = valuesAfterLabel(field, l.label, occurrences);
      const order = 'order' in l ? l.order : undefined;
      const sorted = [...hits].sort(
        (a, b) => Number(b.dateOrder === order) - Number(a.dateOrder === order),
      );
      const isLearned = learned.some((x) => x.label === l.label);
      for (const o of sorted) {
        const text = field.type === 'text' || field.type === 'note';
        const value = text ? o.raw.trim() : o.value;
        const same = exact.find((s) => sameValue(field, s.value, value));
        const tag = isLearned ? [l.label] : [];
        if (same) {
          same.learned = [...(same.learned ?? []), ...tag];
          continue;
        }
        exact.push({
          ...(list.find((s) => sameValue(field, s.value, value)) ?? { value, score: 0 }),
          pick: {
            label: o.label,
            relY: Math.round(o.relY * 1000) / 1000,
            ...(o.dateOrder ? { order: o.dateOrder } : {}),
          },
          ...(tag.length > 0 ? { learned: tag } : {}),
        });
      }
    }
    for (const s of exact) add(s);
    if (code) add(list.find((s) => sameValue(field, s.value, code!)) ?? fromCode(field, code));
    for (const v of extras)
      add(list.find((s) => sameValue(field, s.value, v)) ?? fromCode(field, v));
    list.forEach((s, i) => {
      add(s);
      if (i === 0) for (const v of second) add(fromCode(field, v));
    });
    if (list.length === 0) for (const v of second) add(fromCode(field, v));

    const memory = usesValueMemory(field) ? rememberedValue(input.known?.[field.id], rows) : null;
    const remembered = memory ? fromCode(field, memory) : null;
    // When an exact match for the label is written on the file: rank it before the saved value.
    if (exact.length > 0 && remembered) merged.splice(exact.length, 0, remembered);
    return {
      field,
      code: merged,
      remembered: exact.length > 0 ? null : remembered,
      // Without pick: QR code values do not reside in text layout, so tapping them does not record a position.
      fromCode: (coded[field.id] ?? []).map((value) => ({ value, score: 0 })),
      // Choice fields only ask the model for categories (D-405), leaving others to rules;
      // unfillable fields (attachments, checkboxes...) receive no candidates from rules. Values
      // next to labels rank first without needing to ask the model; still ask when there is only a
      // single candidate: prevents mislearned labels from making the correct value untappable.
      ask:
        (exact.length === 0 || merged.length < 2) &&
        !coded[field.id]?.length &&
        code === undefined &&
        !(concept === null && (field.type === 'note' || FREE_NOTE.test(field.name.trim()))) &&
        // If merchant name score is ambiguous and the model keeps getting the first one wrong, do not load the model for it if candidates exist (D-404).
        !(concept === 'merchant' && merged.length > 0) &&
        // Asking the model for phone numbers, emails, websites, or addresses on a business card only yields more erroneous candidates, so do not ask it.
        !(cardRules() && concept !== null && CARD_NO_ASK.has(concept)) &&
        ((category && field.type === 'choice' && canAskCategory(field)) ||
          field.type === 'money' ||
          field.type === 'number' ||
          field.type === 'date' ||
          field.type === 'text' ||
          field.type === 'note'),
      codeFirst:
        exact.length > 0 ||
        cardRules() ||
        (concept === 'amount' && documentLanguage(rows) === 'zh'),
    };
  });
  return { rows, fields, pickOf, kind: ctx.kind };
}

/** Final candidates given for a field: value memory -> model -> code, deduplicated, up to 3. */
export function mergedSuggestions(
  plan: FieldPlan,
  model: readonly string[],
  pickOf: DocumentPlan['pickOf'],
): ValueSuggestion[] {
  const out: ValueSuggestion[] = [];
  const known = plan.code;
  const add = (s: ValueSuggestion) => {
    if (out.length < MAX_SUGGESTIONS && !out.some((m) => sameValue(plan.field, m.value, s.value)))
      out.push(s);
  };
  for (const s of plan.fromCode) add(s);
  if (plan.remembered) add(plan.remembered);
  if (plan.codeFirst) for (const s of known) add(s);
  for (const v of model)
    add(
      known.find((s) => sameValue(plan.field, s.value, v)) ??
        (plan.field.type === 'choice' ? { value: v, score: 0 } : withPick(v, pickOf(v))),
    );
  for (const s of known) add(s);
  return out;
}
