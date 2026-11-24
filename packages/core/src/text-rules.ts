import type { Locale } from './schema';

// Extracts specific fixed content types from text (D-244): shared between naming templates
// ({ocr:rule} / {qr:rule}), the "extract text" action, and prefill logic for "log an expense".
// Rules must be selected from this list; user- or AI-written regexes are not accepted. Text is
// processed strictly on-device, and the AI only sees rule names. Avoids lookbehind assertions
// (unsupported in older Hermes versions), handling preceding boundaries with capture groups
// instead.

export const TEXT_RULES = [
  'firstLine',
  'invoiceNo',
  'date',
  'amount',
  'phone',
  'email',
  'url',
  'number',
] as const;
export type TextRule = (typeof TEXT_RULES)[number];

/** The types of information that can be extracted (first line, invoice number, and amount are unique and handled separately). */
export const EXTRACT_KINDS = ['phone', 'email', 'url', 'number', 'date'] as const;
export type ExtractKind = (typeof EXTRACT_KINDS)[number];

const pad = (n: number) => String(n).padStart(2, '0');

export function validDate(y: number, m: number, d: number): string | null {
  const date = new Date(y, m - 1, d);
  if (y < 1900 || y > 2200) return null;
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d
    ? `${y}-${pad(m)}-${pad(d)}`
    : null;
}

const YMD = /(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?/g;
const DMY = /(?:^|[^\d])(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?!\d)/g;

/**
 * Normalize dates in text to YYYY-MM-DD. For year-first formats (2026-10-22, 2026/10/22,
 * 2026-10-22 with year/month/day characters), parse directly; for year-last formats (22/10/2026,
 * 10/22/2026), check which part is greater than 12. If ambiguous, default to month-first for
 * English and day-first for other locales.
 */
function dates(text: string, locale: Locale): { at: number; value: string }[] {
  const found: { at: number; value: string }[] = [];
  for (const m of text.matchAll(YMD)) {
    const v = validDate(Number(m[1]), Number(m[2]), Number(m[3]));
    if (v) found.push({ at: m.index, value: v });
  }
  for (const m of text.matchAll(DMY)) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const y = Number(m[3]);
    const monthFirst = a > 12 ? false : b > 12 ? true : locale === 'en';
    const v = monthFirst ? validDate(y, a, b) : validDate(y, b, a);
    if (v) found.push({ at: m.index, value: v });
  }
  return found.sort((x, y) => x.at - y.at);
}

// Phone numbers: international format (starting with +), Chinese phone numbers, common grouping formats (01 23 45 67 89, (415) 555-0100).
const PHONE_INTL = /\+\d[\d\s\-().]{6,18}\d/g;
const PHONE_CN = /(?:^|[^\d])(1[3-9]\d{9})(?!\d)/g;
// Local phone number formats require separators (spaces, dots, hyphens) or parentheses: a continuous string of digits is usually a serial or invoice number rather than a phone number. Excludes numbers preceded by letters or hyphens (INV-2026-0042).
const PHONE_LOCAL = /(?:^|[^\w+\-/.])(\(?\d{2,4}\)?(?:[\s.-]\d{2,4}){1,4})(?![\d])/g;

const digitsOnly = (s: string) => s.replace(/[^\d+]/g, '');

function phones(text: string): { at: number; value: string }[] {
  const found: { at: number; value: string }[] = [];
  const taken: [number, number][] = [];
  const add = (at: number, raw: string) => {
    const value = digitsOnly(raw);
    const digits = value.replace('+', '').length;
    if (digits < 8 || digits > 15) return;
    if (taken.some(([s, e]) => at < e && at + raw.length > s)) return;
    taken.push([at, at + raw.length]);
    found.push({ at, value });
  };
  for (const m of text.matchAll(PHONE_INTL)) add(m.index, m[0]);
  for (const m of text.matchAll(PHONE_CN)) add(m.index + m[0].indexOf(m[1]!), m[1]!);
  for (const m of text.matchAll(PHONE_LOCAL)) {
    // The date (2026-10-22) is not a phone number.
    const raw = m[1]!;
    if (/^\d{4}[-./]\d{1,2}[-./]\d{1,2}$/.test(raw)) continue;
    add(m.index + m[0].indexOf(raw), raw);
  }
  return found.sort((x, y) => x.at - y.at);
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<>"'，。、]+/gi;
const NUMBER = /-?\d{1,3}(?:[,\u00a0\u202f ]\d{3})+(?:[.,]\d+)?|-?\d+(?:[.,]\d+)?/g;

function all(pattern: RegExp, text: string, clean = (s: string) => s) {
  return [...text.matchAll(pattern)].map((m) => ({ at: m.index, value: clean(m[0]) }));
}

const trimUrl = (s: string) => s.replace(/[.,;:!?)\]}>]+$/, '');

/**
 * Normalizes numbers to 1234.56: if both commas and periods appear, the rightmost one is the
 * decimal separator; if only one separator type appears, multiple occurrences or exactly 3
 * trailing digits indicate a thousand separator (1,234, 1.234.567), otherwise it is a decimal
 * separator (12,5, 3.50).
 */
export function normalizeNumber(raw: string): string {
  const s = raw.replace(/[\u00a0\u202f ]/g, '');
  const comma = s.lastIndexOf(',');
  const dot = s.lastIndexOf('.');
  if (comma >= 0 && dot >= 0) {
    const decimal = comma > dot ? ',' : '.';
    const group = decimal === ',' ? '.' : ',';
    return s.split(group).join('').replace(decimal, '.');
  }
  const sep = comma >= 0 ? ',' : dot >= 0 ? '.' : null;
  if (!sep) return s;
  const parts = s.split(sep);
  if (parts.length > 2 || parts[1]!.length === 3) return parts.join('');
  return parts.join('.');
}

const INVOICE =
  /(?:invoice|inv|receipt|bill|order|facture|commande|reçu|n°|no\.|№|发票号码|发票代码|发票号|单据号|订单号|单号|编号|票号)\s*(?:number|no\.?|n°|#|num(?:éro)?)?\s*[:：#.]?\s*([A-Za-z0-9][A-Za-z0-9\-/]{3,29})/i;
const TOTAL =
  /(?:\btotal\b|\bamount due\b|\bbalance\b|\bmontant\b|net à payer|合计|总计|总额|价税合计|实付|应付|金额)[^\d\n-]{0,12}(-?\d[\d\s,.\u00a0\u202f]*\d|\d)/i;

const firstLine = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
    ?.slice(0, 40) ?? null;

/** Extracts the first match according to the rule; returns null if none found. */
export function extractFirst(text: string, rule: TextRule, locale: Locale): string | null {
  switch (rule) {
    case 'firstLine':
      return firstLine(text);
    case 'invoiceNo': {
      const m = INVOICE.exec(text);
      return m && /\d/.test(m[1]!) ? m[1]! : null;
    }
    case 'amount': {
      const m = TOTAL.exec(text);
      if (m) return normalizeNumber(m[1]!.trim());
      // No keywords like "total": picks the largest number with two decimal places.
      const money = extractAll(text, 'number', locale)
        .filter((n) => /\.\d{2}$/.test(n))
        .sort((a, b) => Number(b) - Number(a));
      return money[0] ?? null;
    }
    default:
      return extractAll(text, rule, locale)[0] ?? null;
  }
}

/** Extracts all matches of a given type (in order of appearance, with duplicates removed). */
export function extractAll(text: string, kind: ExtractKind, locale: Locale): string[] {
  const found =
    kind === 'date'
      ? dates(text, locale)
      : kind === 'phone'
        ? phones(text)
        : kind === 'email'
          ? all(EMAIL, text)
          : kind === 'url'
            ? all(URL_PATTERN, text, trimUrl)
            : all(NUMBER, text, normalizeNumber);
  return [...new Set(found.map((f) => f.value))];
}
