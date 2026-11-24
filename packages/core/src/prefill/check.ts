import type { Field, Locale } from '../schema';
import { ruleCandidates } from './candidates';
import { conceptOf, fieldTerms, type ConceptId } from './concepts';
import { BAD_DATE_ROW, NOT_NO, stripNoPrefix } from './zh-rules';

// Model answers must pass verification (D-396): values must actually exist in the recognized text
// and not be on an obviously incorrect row. Failures are discarded, so the model cannot hallucinate
// values not present in the text. These rules stem from error analysis in per-field/REPORT.md.

export const squash = (s: string) => s.normalize('NFKC').replace(/\s+/g, '').toLowerCase();

const NO_DECIMALS = new Set(['IDR', 'JPY', 'KRW', 'VND']);
/** Currencies of this type have no decimals (field currency). */
export const hasNoDecimals = (f: Field) =>
  f.type === 'money' &&
  f.currency !== undefined &&
  f.currencyField === undefined &&
  NO_DECIMALS.has(f.currency);

const LOCALES: readonly Locale[] = ['en', 'fr', 'zh'];
/** Dates readable from this row (trying three language formats; when day and month are ambiguous, both are considered). */
function dateReadings(row: string): string[] {
  const out = new Set<string>();
  for (const l of LOCALES)
    for (const c of ruleCandidates(row, l)) if (c.kind === 'date') out.add(c.value);
  for (const v of [...out]) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    if (m && Number(m[3]) <= 12) out.add(`${m[1]}-${m[3]}-${m[2]}`);
  }
  return [...out];
}
/** Can this date be read from this row (also used for rule candidate filtering). */
export const rowHasDate = (row: string, date: string) => dateReadings(row).includes(date);

const PAY =
  /\b(cash|tender|tendered|change|payment|visa|master|card|credit|debit|rounding adj)\b|找零|现金|实收|收款|monnaie|espèces/i;
const TAX_WORD = /tax|tva|gst|vat|sst|税/i;
const ADDRESS =
  /\b\d{5}\b|\b(jalan|jln|taman|lorong|street|road|rue|avenue|blvd)\b|[路街]\d|\d+号|大道/i;
const TOTAL_WORD = /total|合计|总计|montant|grand|net\s*amt|amount\s*due|payer|ttc|应付|实付/i;
const NOT_TOTAL =
  /sub\s*-?\s*total|小计|优惠|discount|remise|rounding|change|找零|paid\s*amount|tendered/i;
/** Values for these fields will not be on the same row as such labels. */
const OTHER_LABEL: Partial<Record<ConceptId, RegExp>> = {
  origin: /^(to|arriv[ée]e|到达|终点|destination)\s*[:：]/i,
  destination: /^(from|d[ée]part|出发|地址|address)\s*[:：]/i,
  merchant:
    /^(invoice\s*no|bill\s*no|n°|station|cashier|tel|t[ée]l|电话|地址|address|order|订单)\b.*[:：]/i,
  company: /^(tel|t[ée]l|电话|地址|address|email)\b.*[:：]/i,
  name: /^(tel|t[ée]l|电话|地址|address|email)\b.*[:：]/i,
  number: /^(tel|t[ée]l|phone|电话|地址|address|total|合计|小计|date|日期)\b.*[:：]?/i,
};
/** Code-recognizable misleading rows: hidden from the model (rows with total-related keywords are kept). */
const MISLEAD =
  /sub\s*-?\s*total|小计|sous-total|优惠|折扣|discount|remise|promo|thank\s*you|thankyou|merci|谢谢|欢迎|welcome|scan\s*qr|二维码|qr\s*au\s*verso|gst\s*summary|tax\s*code|\b(tel|t[ée]l|phone|fax|mobile)\b|电话|手机|传真|\S+@\S+\.\w+|地址|address|adresse|\bchange\b|找零|monnaie|rendu|\b(cash|tender(ed)?|visa|master(card)?)\b|现金|实收/i;
const BARE_LABELS = new Set([
  'from',
  'to',
  'départ',
  'arrivée',
  'origin',
  'destination',
  'name',
  'company',
  'merchant',
  'total',
  'date',
  'tax',
]);

/**
 * This row refers to this field (keywords for the field name or its concept appear in this row):
 * for user-created "discount amount", "cash", or "address", we specifically want the misleading
 * rows of other fields. In Chinese, matches two consecutive characters in the name (discount
 * amount → discount); English and French match whole words.
 */
function isOwnRow(f: Pick<Field, 'id' | 'name'>, row: string): boolean {
  const { concept, keywords } = fieldTerms(f);
  const lower = row.normalize('NFKC').toLowerCase();
  if (concept === 'email' && /\S+@\S+\.\w+/.test(row)) return true;
  return keywords.some((k) => {
    const term = k.normalize('NFKC').toLowerCase().trim();
    for (let i = 0; i + 2 <= term.length; i++) {
      const pair = term.slice(i, i + 2);
      if (/^[㐀-鿿]{2}$/.test(pair) && lower.includes(pair)) return true;
    }
    return term
      .split(/[^\p{L}\p{N}]+/u)
      .some(
        (w) =>
          w.length >= 3 &&
          !/[㐀-鿿]/.test(w) &&
          new RegExp(`(^|[^\\p{L}\\p{N}])${w}(?![\\p{L}\\p{N}])`, 'u').test(lower),
      );
  });
}

/**
 * Whether to show this row to the model. When a field is provided, filter by field: rows
 * containing the field's own keywords are not deleted. Total amount field is an exception: its
 * keywords (received, paid) fall right on misleading rows, so like the prompt and measurements,
 * they are not unblocked.
 */
export const keepForModel = (row: string, field?: Pick<Field, 'id' | 'name'>) =>
  TOTAL_WORD.test(row) ||
  !MISLEAD.test(row) ||
  (field !== undefined && conceptOf(field) !== 'amount' && isOwnRow(field, row));

/** Consecutive digits like dates, times, and phone numbers are not amounts. */
const NOT_AMOUNT_DIGITS =
  /\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|\d{1,2}:\d{2}(?::\d{2})?|\d+(?:[-/:]\d+)+/g;

interface RowNumber {
  value: number;
  /** Decimals are written out (100.00). */
  cents: boolean;
}

/**
 * Numbers in this text, treated as whole numbers. When separators have two possible
 * interpretations, both are considered: 32.000 is 32 or 32000, "2 500.00" is 2500.00 or two cells
 * 2 and 500.00.
 */
function numbersIn(text: string): RowNumber[] {
  const t = text
    .replace(NOT_AMOUNT_DIGITS, ' ')
    // OCR often adds extra spaces around decimal points.
    .replace(/(\d)\s*([.,])\s*(\d{2})(?!\d)/g, '$1$2$3');
  const out: RowNumber[] = [];
  for (const m of t.matchAll(/\d+(?:[ .,'’]\d+)*/g)) {
    const raw = m[0];
    const parts = raw.split(/[ .,'’]/);
    const lastSep = /[ .,'’](?=\d+$)/.exec(raw)?.[0];
    const tail = parts.at(-1)!;
    if (parts.length === 1) {
      out.push({ value: Number(raw), cents: false });
      continue;
    }
    // The final segment is not three digits: it is a decimal (or another cell separated by a space).
    if ((lastSep === '.' || lastSep === ',') && tail.length <= 2) {
      const whole = parts.slice(0, -1);
      out.push({ value: Number(`${whole.join('')}.${tail}`), cents: true });
      // Spaces earlier in the string separate another cell (quantity).
      const cells = raw.split(' ');
      if (cells.length > 1) {
        const lastCell = cells.at(-1)!;
        out.push({
          value: Number(lastCell.replace(/[.,'’](?=\d+$)/, '.').replace(/[,'’]/g, '')),
          cents: true,
        });
      }
      continue;
    }
    if (parts.slice(1).every((p) => p.length === 3))
      out.push({ value: Number(parts.join('')), cents: false });
    if ((lastSep === '.' || lastSep === ',') && parts.length === 2)
      out.push({ value: Number(`${parts[0]}.${tail}`), cents: true });
    if (lastSep === ' ') for (const p of parts) out.push({ value: Number(p), cents: false });
  }
  return out;
}

const isTotalRow = (r: string) => TOTAL_WORD.test(r) && !NOT_TOTAL.test(r);

/**
 * Whether this number is in this row (compared as a whole number). Answers without decimals (5)
 * match numbers with decimals (5.00) only on total rows, otherwise line items can also match. On
 * total rows, OCR frequently corrupts separators (TOTAL 20 0 0 0, 36-000, 19-80): a continuous
 * digit sequence whose value equals the answer is also valid.
 */
function rowHasAmount(row: string, n: number, answer: string, strict: boolean): boolean {
  const wroteCents = /[.,]\d{1,2}\s*\D*$/.test(answer);
  const near = (v: number) => Math.abs(v - n) < 0.005;
  if (
    numbersIn(row).some(
      (x) => near(x.value) && (wroteCents || !x.cents || !strict || isTotalRow(row)),
    )
  )
    return true;
  if (!isTotalRow(row)) return false;
  const digits = answer.replace(/\D/g, '');
  return (row.match(/\d(?:[\s.,-]*\d)*/g) ?? []).some((b) => b.replace(/\D/g, '') === digits);
}

function checkAmount(
  f: Field,
  concept: ConceptId | null,
  s: string,
  rows: readonly string[],
  locale: Locale,
): string | null {
  let n: number | null = null;
  if (hasNoDecimals(f) && /\d/.test(s)) n = Number(s.replace(/[.,]00$/, '').replace(/[^\d]/g, ''));
  else if (/^-?\d+(\.\d+)?$/.test(s)) n = Number(s);
  else {
    const a = ruleCandidates(s, locale).find((c) => c.kind === 'amount');
    n = a ? Number(a.value) : null;
  }
  if (n === null || !Number.isFinite(n)) return null;
  const noDecimals = hasNoDecimals(f);
  // Which rows it appears in (compared as a whole number).
  const inRows = rows.filter((r) => rowHasAmount(r, n, s, !noDecimals));
  if (inRows.length === 0) return null;
  // For user-created fields (discount amount, cash), this row is precisely what is needed, and the "not a total" checks below do not apply.
  if (inRows.some((r) => concept !== 'amount' && isOwnRow(f, r))) return String(n);
  if (inRows.every((r) => PAY.test(r) && !/total|合计|总|montant/i.test(r))) return null;
  if (concept === 'tax' && !inRows.some((r) => TAX_WORD.test(r))) return null;
  if (concept !== 'tax') {
    if (n === 0) return null;
    // When a total row exists, the amount must be on the total row.
    if (rows.some((r) => isTotalRow(r) && /\d/.test(r)) && !inRows.some(isTotalRow)) return null;
  }
  return String(n);
}

function checkDate(
  concept: ConceptId | null,
  s: string,
  rows: readonly string[],
  locale: Locale,
): string | null {
  const v = /^\d{4}-\d{2}-\d{2}$/.test(s)
    ? s
    : (ruleCandidates(s, locale).find((c) => c.kind === 'date')?.value ?? null);
  if (!v) return null;
  if (!rows.some((r) => rowHasDate(r, v))) return null;
  // The date on the validity row is intended for the due date, whereas document dates are not.
  if (concept !== 'dueDate' && !rows.some((r) => !BAD_DATE_ROW.test(r) && rowHasDate(r, v)))
    return null;
  return v;
}

/**
 * The value is a whole word in this row: "No" is not considered present inside "Noor" (when the
 * model outputs half a name). Checks letter boundaries only: Chinese has no word boundaries, and
 * after removing a numbering prefix (NO8039067 → 8039067), if it starts with a digit, it is not
 * considered split.
 */
function wholeWords(row: string, value: string): boolean {
  const v = value.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
  const r = row.normalize('NFKC').toLowerCase();
  const pattern = [...v].map((c) => c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('\\s*');
  const start = /^[\p{L}]/u.test(v) && !/^[㐀-鿿]/.test(v) ? '(^|[^\\p{L}])' : '()';
  const end = /[\p{L}]$/u.test(v) && !/[㐀-鿿]$/.test(v) ? '(?!\\p{L})' : '';
  return new RegExp(`${start}${pattern}${end}`, 'u').test(r);
}

function checkText(
  f: Field,
  concept: ConceptId | null,
  s: string,
  rows: readonly string[],
): string | null {
  const sq = squash(s);
  if (!sq) return null;
  const row = rows.find((r) => squash(r).includes(sq) && wholeWords(r, s))?.trim();
  if (row === undefined) return null;
  if (concept && OTHER_LABEL[concept]?.test(row)) return null;
  if (concept === 'email' && !s.includes('@')) return null;
  if (concept === 'number') {
    if (NOT_NO.test(row) && !/票据号|发票号/.test(row)) return null;
    // Document number looks like an amount or item.
    if (/[€$¥£]|\b(article|item)\b/i.test(s) || /^\d{1,3}([., ]\d{3})*[.,]\d{2}$/.test(s))
      return null;
    if (!/\d/.test(s) || ADDRESS.test(s)) return null;
  }
  let value = s;
  // Complete a partial store name to the full row.
  if (
    (concept === 'merchant' || concept === 'company') &&
    squash(row) !== sq &&
    squash(row).startsWith(sq) &&
    row.split(/\s+/).length <= 4 &&
    !/[:：]/.test(row)
  )
    value = row;
  if (BARE_LABELS.has(value.toLowerCase()) || squash(f.name) === sq) return null;
  if (
    (concept === 'merchant' || concept === 'company' || concept === 'name') &&
    ADDRESS.test(value)
  )
    return null;
  // Rows containing prices are item details, not store names. Deleting them from text beforehand makes results worse (model answers get scrambled), so they are filtered here.
  if (
    (concept === 'merchant' || concept === 'company') &&
    /\p{L}.*\d+[.,]\d{2}\s*[A-Za-z]{0,3}\s*$/u.test(value)
  )
    return null;
  return value;
}

/** A model answer → form field representation; fails verification returns null. */
export function checkAnswer(
  f: Field,
  answer: string,
  rows: readonly string[],
  locale: Locale,
): string | null {
  let s = answer.trim();
  if (!s || s === 'null') return null;
  const concept = conceptOf(f);
  if (concept === 'number') s = stripNoPrefix(s);
  // Strip leading "label:".
  const m = /^([^:：]{1,20})[:：]\s*(.+)$/.exec(s);
  // Colons in 12:30, https://... are not labels.
  if (
    m &&
    f.type !== 'date' &&
    !(/\d$/.test(m[1]!) && /^\d/.test(m[2]!)) &&
    !m[2]!.startsWith('//')
  )
    s = m[2]!.trim();
  if (f.type === 'money' || f.type === 'number') return checkAmount(f, concept, s, rows, locale);
  if (f.type === 'date') return checkDate(concept, s, rows, locale);
  return checkText(f, concept, s, rows);
}
