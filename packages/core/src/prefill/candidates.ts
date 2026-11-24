import type { Locale } from '../schema';
import { normalizeNumber, validDate } from '../text-rules';
import { ctx, receiptRules } from './doc-context';
import { docAdds, orderPref } from './rules';
import * as D from './rules-data';

// Pre-filled candidates for "log an expense" (D-244 extension): which text segment resembles an
// amount or date. Rule-based first, system recognition (iOS DataDetection / NSDataDetector, Android
// ML Kit entity recognition) serves only as auxiliary and supplementary: if rule finds it and
// system finds it too, record as "matching"; only when rule misses and system finds is it added as
// supplementary. Candidates only state "here is an amount/date", not which one is actually paid:
// selection is done in pick.ts and memory.ts. Text is processed entirely on-device and never sent
// to AI.

export type CandidateKind = 'amount' | 'date';
export type CandidateSource = 'rule' | 'system';

export interface ValueCandidate {
  kind: CandidateKind;
  /** Unified format: amount 1234.56, date YYYY-MM-DD. */
  value: string;
  /** This segment in the original text. */
  raw: string;
  /** Line number (0-indexed, split by \\n). */
  line: number;
  /** Position within this line (UTF-16, same as JS strings). */
  start: number;
  end: number;
  source: CandidateSource;
  /** Rule candidate, with system recognition also recognizing the same value at the same position. */
  confirmed?: boolean;
  /** Number contained misrecognized letters (1O7.45, 2026-S-month), recognized after correcting back to numbers based on common confusions. */
  repaired?: boolean;
  /** Day-month order in numeric dates with year at the end, determined from original text or confirmed by user. */
  dateOrder?: 'DMY' | 'MDY';
}

/** System recognition result: position in the full text (UTF-16) and value provided by system; systemCandidates converts positions to lines. */
export interface SystemMatch {
  kind: CandidateKind;
  start: number;
  end: number;
  /** Value provided by system: date YYYY-MM-DD; amount may be absent (ML Kit decimal part unreliable), in which case unified according to original text. */
  value?: string;
}

export const splitLines = (text: string): string[] => text.split('\n');

// ---- Date ----

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  janvier: 1,
  janv: 1,
  feb: 2,
  february: 2,
  février: 2,
  fevrier: 2,
  févr: 2,
  fev: 2,
  mar: 3,
  march: 3,
  mars: 3,
  apr: 4,
  april: 4,
  avril: 4,
  avr: 4,
  may: 5,
  mai: 5,
  jun: 6,
  june: 6,
  juin: 6,
  jul: 7,
  july: 7,
  juillet: 7,
  juil: 7,
  aug: 8,
  august: 8,
  août: 8,
  aout: 8,
  sep: 9,
  sept: 9,
  september: 9,
  septembre: 9,
  oct: 10,
  october: 10,
  octobre: 10,
  nov: 11,
  november: 11,
  novembre: 11,
  dec: 12,
  december: 12,
  décembre: 12,
  decembre: 12,
  déc: 12,
};
const MONTH_NAMES = Object.keys(MONTHS)
  .sort((a, b) => b.length - a.length)
  .join('|');

const YMD = /(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?/g;
// Year at the end: two or four-digit year (05/03/26, 05/03/2026). Cannot be preceded by a digit, cannot be followed by a digit.
const DMY = /(^|[^\d])(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})(?!\d)/g;
// 12 mars 2026、1er avril 2026、5 March 2026
const D_MONTH_Y = new RegExp(
  `(^|[^\\w])(\\d{1,2})(?:er)?\\s+(${MONTH_NAMES})\\.?\\s+(\\d{4})(?!\\d)`,
  'gi',
);
// March 5, 2026、Mar 5 2026
const MONTH_D_Y = new RegExp(
  `(^|[^\\w])(${MONTH_NAMES})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})(?!\\d)`,
  'gi',
);

const fullYear = (y: string) => {
  if (y.length !== 2) return Number(y);
  const v = 2000 + Number(y);
  // Century for two-digit years chosen based on "now": if 2000+yy is later than next year, treat as 19yy (99 -> 1999, not 2099).
  return receiptRules() && ctx.nowYear > 0 && v > ctx.nowYear + 1 ? v - 100 : v;
};

// Time and date stuck together (23:16:4615/08/2022, 20/10/2021 19:29).
const G1 =
  /(\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AaPp][Mm])?)(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})(?!\d)/g;
const G2 = /(^|[^\d])(\d{1,2})[/.-](\d{1,2})[/.-](20\d{2})(?=\d{1,2}[:.]\d{2})/g;
// Month name formats (words using \\p{L}, accent-insensitive table lookup; without lookbehind): 28-Oct-2021, 3 de enero de 2024, 15. März 2024, Oct28'21.
const W_D_MON_Y =
  /(^|[^\p{L}\p{N}])(\d{1,2})(?:st|nd|rd|th|er)?\.?(?:\s+de)?[\s.\-/]*(\p{L}{3,9})\.?(?:\s+de)?\s*([,'’°\-.]?)\s*(\d{4}|\d{2})(?:(?!\d)|(?=\d{1,2}:\d{2}))(?![:.]\d)/giu;
const W_MON_D_Y =
  /(^|[^\p{L}\p{N}])(\p{L}{3,9})\.?\s*(\d{1,2})(?:st|nd|rd|th)?(?:\s*([,'’°.])\s*|(\s+))(\d{4}|\d{2})(?:(?!\d)|(?=\d{1,2}:\d{2}))(?![:.]\d)/giu;
const W_CTIME =
  /(^|[^\p{L}\p{N}])(\p{L}{3,9})\.?\s+(\d{1,2})\s+\d{1,2}:\d{2}(?::\d{2})?\s+(\d{4})(?!\d)/giu;
/** Two-digit year recognized only if preceded by a separator and followed by time or at the end of a line; 00 not recognized (MAY 4.00). */
function yearOk(line: string, end: number, sepChar: string, year: string): boolean {
  if (year.length === 4) return true;
  if (year === '00') return false;
  return (
    sepChar !== '' || /^\s*\d{1,2}[:.]\d{2}/.test(line.slice(end)) || line.slice(end).trim() === ''
  );
}
// Two-digit year, fake dates separated by - or . (Japanese address numbers, sandwiched between alphanumeric characters).
const TIME_AFTER = /^\s*,?\s*\d{1,2}[:.]\d{2}/;
const DATE_WORD_LEFT = /date|tarih|fecha|日付|日/i;
const ADDR_CJK = /[都道府県市区町村丁目]/;
function fakeShortDate(line: string, at: number, raw: string): boolean {
  const m = /^\d{1,2}([-.])\d{1,2}[-.]\d{2}$/.exec(raw);
  if (!m) return false;
  const before = line[at - 1] ?? '';
  const after = line[at + raw.length] ?? '';
  if (/[A-Za-z0-9-]/.test(before) || /[-A-Za-z0-9]/.test(after)) return true;
  return (
    m[1] === '-' &&
    !TIME_AFTER.test(line.slice(at + raw.length)) &&
    !DATE_WORD_LEFT.test(line.slice(0, at)) &&
    ADDR_CJK.test(line)
  );
}

/** Dates in a line. Keep both interpretations when year is at the end and day/month is ambiguous; language determines display order only. */
function datesInLine(
  line: string,
  locale: Locale,
): { start: number; end: number; value: string; dateOrder?: 'DMY' | 'MDY' }[] {
  const found: { start: number; end: number; value: string; dateOrder?: 'DMY' | 'MDY' }[] = [];
  const add = (start: number, raw: string, value: string | null, dateOrder?: 'DMY' | 'MDY') => {
    if (!value) return;
    const end = start + raw.length;
    if (found.some((f) => (f.start !== start || f.end !== end) && start < f.end && end > f.start))
      return;
    if (found.some((f) => f.start === start && f.end === end && f.value === value)) return;
    found.push({ start, end, value, ...(dateOrder ? { dateOrder } : {}) });
  };
  for (const m of line.matchAll(YMD)) {
    add(m.index, m[0].trimEnd(), validDate(Number(m[1]), Number(m[2]), Number(m[3])));
  }
  for (const m of line.matchAll(D_MONTH_Y)) {
    const month = MONTHS[m[3]!.toLowerCase()];
    const raw = m[0].slice(m[1]!.length);
    add(m.index + m[1]!.length, raw, month ? validDate(Number(m[4]), month, Number(m[2])) : null);
  }
  for (const m of line.matchAll(MONTH_D_Y)) {
    const month = MONTHS[m[2]!.toLowerCase()];
    const raw = m[0].slice(m[1]!.length);
    add(m.index + m[1]!.length, raw, month ? validDate(Number(m[4]), month, Number(m[3])) : null);
  }
  const addNumeric = (at: number, raw: string, a: number, b: number, y: number) => {
    const dmy = validDate(y, b, a);
    const mdy = validDate(y, a, b);
    if (dmy && mdy && dmy !== mdy) {
      const pref = orderPref(/\D/.exec(raw)?.[0] ?? '/', locale);
      if (pref ? pref === 'MDY' : locale === 'en') {
        add(at, raw, mdy, 'MDY');
        add(at, raw, dmy, 'DMY');
      } else {
        add(at, raw, dmy, 'DMY');
        add(at, raw, mdy, 'MDY');
      }
    } else {
      add(at, raw, dmy ?? mdy, dmy && !mdy ? 'DMY' : mdy && !dmy ? 'MDY' : undefined);
    }
  };
  for (const m of line.matchAll(DMY)) {
    const raw = m[0].slice(m[1]!.length);
    const at = m.index + m[1]!.length;
    if (receiptRules() && fakeShortDate(line, at, raw)) continue;
    // For two-digit year dates, the two separators must match (2/1.00, 12-05/09 are not dates).
    if (receiptRules() && m[4]!.length === 2) {
      const seps = /^\d{1,2}(\D)\d{1,2}(\D)/.exec(raw);
      if (seps && seps[1] !== seps[2]) continue;
    }
    addNumeric(at, raw, Number(m[2]), Number(m[3]), fullYear(m[4]!));
  }
  for (const m of receiptRules() ? line.matchAll(G1) : []) {
    const at = m.index + m[1]!.length;
    addNumeric(at, m[0].slice(m[1]!.length), Number(m[2]), Number(m[3]), fullYear(m[4]!));
  }
  for (const m of receiptRules() ? line.matchAll(G2) : []) {
    const at = m.index + m[1]!.length;
    addNumeric(at, m[0].slice(m[1]!.length), Number(m[2]), Number(m[3]), Number(m[4]));
  }
  const monthOf = (w: string) =>
    D.MONTHS_WEST[
      w
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
    ];
  // 28-Oct-2021、3 de enero de 2024、15. März 2024、10 JAN17、Dec02'16
  for (const m of receiptRules() ? line.matchAll(W_D_MON_Y) : []) {
    const month = monthOf(m[3]!);
    const raw = m[0].slice(m[1]!.length);
    if (!month || !yearOk(line, m.index + m[0].length, m[4]!, m[5]!)) continue;
    add(m.index + m[1]!.length, raw, validDate(fullYear(m[5]!), month, Number(m[2])));
  }
  // Oct28'21、AUGUST 13,2017、May 21. 2019、WED MAY 17,2017
  for (const m of receiptRules() ? line.matchAll(W_MON_D_Y) : []) {
    const month = monthOf(m[2]!);
    const raw = m[0].slice(m[1]!.length);
    if (!month || !yearOk(line, m.index + m[0].length, m[4] ?? '', m[6]!)) continue;
    // Month and day written together, day and year separated only by space (Oct2 2020) are mostly month/year with noise, not recognized; Oct28'21 has an apostrophe, recognized.
    if (m[5] && /^\d/.test(raw.slice(m[2]!.length))) continue;
    add(m.index + m[1]!.length, raw, validDate(fullYear(m[6]!), month, Number(m[3])));
  }
  // SUN JUN 24 20:49:53 2018 (ctime format: month day time year)
  for (const m of receiptRules() ? line.matchAll(W_CTIME) : []) {
    const month = monthOf(m[2]!);
    const raw = m[0].slice(m[1]!.length);
    if (!month) continue;
    add(m.index + m[1]!.length, raw, validDate(Number(m[4]), month, Number(m[3])));
  }
  return found.sort((x, y) => x.start - y.start);
}

// ---- Amount ----

const CURRENCY_BEFORE = /(?:[$€£¥￥]|rmb|cny|eur|usd|gbp|myr|us\$)\s*$/i;
// Malaysian Ringgit written as RM33.90 (D-549): RM recognized only in uppercase, not connected to preceding letters, otherwise the whole segment is treated as a serial number.
const RM_BEFORE = /(?:^|[^A-Za-z])RM\s?$/;
const currencyBefore = (s: string) => CURRENCY_BEFORE.test(s) || RM_BEFORE.test(s);
const CURRENCY_AFTER = /^\s*(?:[€$£¥￥元]|eur|euros?|rmb|cny|usd|gbp|myr)/i;
// Numbers (thousand separator can be comma, dot, space), optionally followed by one or two decimal places.
const NUMBER = /-?\d{1,3}(?:[,.   ]\d{3})+(?:[.,]\d{1,2})?|-?\d+(?:[.,]\d{1,2})?/g;
// Things following quantities, weights, percentages, times: not amounts.
const NOT_MONEY_AFTER = /^\s*(?:%|kg|g\b|ml|l\b|x\b|×|件|个|份|张|pcs|km|h\b|min|:\d)/i;

/** Numbers in a line resembling amounts: have two decimal places, or immediately follow a currency symbol. Dates, times, percentages, quantities do not count. */
function amountsInLine(
  line: string,
  dates: readonly { start: number; end: number }[],
  locale: Locale,
): { start: number; end: number; raw: string; value: string }[] {
  const out: { start: number; end: number; raw: string; value: string }[] = [];
  // Numbers using spaces as thousand separators (3 620.84): taken as a whole only if immediately
  // preceded or followed by a currency symbol, or if this row has more than three amounts, or if it
  // can be derived by adding/subtracting other amounts in the text (otherwise quantity in "2 x 3
  // 12.50" would get joined).
  const spaced: { start: number; end: number; raw: string; value: string }[] = [];
  const many = Math.max(ctx.rowMany, (line.match(/\d[.,]\d{2}(?!\d)/g) ?? []).length) >= 3;
  for (const m of receiptRules()
    ? line.matchAll(/(^|[^\d.,])(\d{1,3}(?: \d{3})+[.,]\d{2})(?!\d)/g)
    : []) {
    const start = m.index + m[1]!.length;
    const end = start + m[2]!.length;
    if (dates.some((d) => start < d.end && end > d.start)) continue;
    const v = normalizeNumber(m[2]!.replace(/ /g, ''));
    // Currency symbol at the end (1 819.68 €; French and German receipts use spaces as thousand separators).
    const spacedHere = CURRENCY_AFTER.test(line.slice(end));
    if (!(currencyBefore(line.slice(0, start)) || many || spacedHere || docAdds(Number(v))))
      continue;
    spaced.push({ start, end, raw: m[2]!, value: v });
  }
  for (const m of line.matchAll(NUMBER)) {
    if (spaced.some((s) => m.index < s.end && m.index + m[0].length > s.start)) continue;
    let raw = m[0];
    let start = m.index;
    // When spaces are used as thousand separators, regex might also capture the preceding quantity ("2 120.00"): trusted only when immediately preceded by a currency symbol or label.
    const end = start + raw.length;
    if (dates.some((d) => start < d.end && end > d.start)) continue;
    const before = line.slice(0, start);
    const after = line.slice(end);
    if (/[\d.,]$/.test(before) || /^[\d]/.test(after)) continue;
    if (NOT_MONEY_AFTER.test(after)) continue;
    // Preceded immediately by letters or hyphens as part of a reference/serial number (INV-2026-0042, A12).
    if (/[A-Za-z\-/#]$/.test(before) && !currencyBefore(before)) continue;
    const decimals = /[.,]\d{2}$/.test(raw);
    const currency = currencyBefore(before) || CURRENCY_AFTER.test(after);
    if (!decimals && !currency) continue;
    // Integer amounts of 4 or more digits in English/French use thousand separators (1,234 / 1
    // 234): written continuously without decimals (5256 €) are likely unrecognized decimal points,
    // not treated as amounts. Chinese often omits thousand separators and is not subject to this
    // rule.
    if (locale !== 'zh' && !decimals && /^-?\d{4,}$/.test(raw)) continue;
    if (raw.startsWith('-')) {
      // "-2.00" is a negative number (discount); keep the negative sign, excluded during selection.
    } else if (/\s/.test(raw) && !currency) {
      // When space-separated without a currency symbol, take only the last segment (12.50 in "2 x 3 12.50").
      const last = raw.split(/\s/).pop()!;
      start = end - last.length;
      raw = last;
      if (!/[.,]\d{2}$/.test(raw)) continue;
    }
    out.push({ start, end, raw, value: normalizeNumber(raw) });
  }
  if (spaced.length) {
    out.push(...spaced);
    out.sort((x, y) => x.start - y.start);
  }
  return out;
}

// OCR often mistakes numbers for resembling letters. Modified only within an "amount or date" segment, character by character, keeping positions unchanged.
const LOOKALIKE: Record<string, string> = {
  O: '0',
  o: '0',
  D: '0',
  S: '5',
  s: '5',
  l: '1',
  I: '1',
  '|': '1',
  B: '8',
  Z: '2',
};
const NUMERIC_RUN = /[0-9OoDSslI|BZ][0-9OoDSslI|BZ.,/\-年月]*[0-9OoDSslI|BZ]/g;
const MONEY_SHAPE = /^\d{1,3}(?:[,.]\d{3})*[.,]\d{2}$|^\d+[.,]\d{2}$/;
const DATE_SHAPE =
  /^\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}$|^\d{1,2}[-/.]\d{1,2}[-/.](?:\d{4}|\d{2})$|^\d{4}年\d{1,2}月\d{1,2}$/;

/** This line after digit repair, and changed positions; lines not resembling amount or date after repair are unchanged. */
export function repairDigits(line: string): { text: string; changed: boolean[] } {
  const chars = [...line];
  const changed = line.split('').map(() => false);
  for (const m of line.matchAll(NUMERIC_RUN)) {
    const run = m[0];
    const digits = run.replace(/[^\d]/g, '').length;
    if (digits < 2 || !/[OoDSslI|BZ]/.test(run)) continue;
    // Preceded or followed immediately by letters as words or codes (SOS, B12, Total), unchanged.
    const before = line[m.index - 1] ?? '';
    const after = line[m.index + run.length] ?? '';
    if (/[A-Za-z]/.test(before) || /[A-Za-z]/.test(after)) continue;
    const fixed = run.replace(/[OoDSslI|BZ]/g, (ch) => LOOKALIKE[ch]!);
    if (!MONEY_SHAPE.test(fixed) && !DATE_SHAPE.test(fixed)) continue;
    for (let i = 0; i < run.length; i++) {
      if (fixed[i] !== run[i]) {
        chars[m.index + i] = fixed[i]!;
        changed[m.index + i] = true;
      }
    }
  }
  return { text: chars.join(''), changed };
}

/** All amount and date candidates found by rules, ordered by line and position. raw is original text (unmodified). */
export function ruleCandidates(text: string, locale: Locale): ValueCandidate[] {
  const out: ValueCandidate[] = [];
  splitLines(text).forEach((original, index) => {
    const { text: line, changed } = repairDigits(original);
    const repaired = (start: number, end: number) => changed.slice(start, end).some(Boolean);
    const dates = datesInLine(line, locale);
    for (const d of dates)
      out.push({
        kind: 'date',
        value: d.value,
        raw: original.slice(d.start, d.end),
        line: index,
        start: d.start,
        end: d.end,
        source: 'rule',
        ...(d.dateOrder ? { dateOrder: d.dateOrder } : {}),
        ...(repaired(d.start, d.end) ? { repaired: true } : {}),
      });
    for (const a of amountsInLine(line, dates, locale))
      out.push({
        kind: 'amount',
        value: a.value,
        raw: original.slice(a.start, a.end),
        line: index,
        start: a.start,
        end: a.end,
        source: 'rule',
        ...(repaired(a.start, a.end) ? { repaired: true } : {}),
      });
  });
  return out;
}

export const sameValue = (kind: CandidateKind, a: string, b: string) =>
  kind === 'amount' ? Math.abs(Number(a) - Number(b)) < 0.005 : a === b;

/** Convert system recognition results (positions in full text) into candidates; skip those spanning across lines. */
export function systemCandidates(text: string, matches: readonly SystemMatch[]): ValueCandidate[] {
  const lines = splitLines(text);
  const starts: number[] = [];
  let at = 0;
  for (const line of lines) {
    starts.push(at);
    at += line.length + 1;
  }
  const out: ValueCandidate[] = [];
  for (const m of matches) {
    let index = starts.length - 1;
    while (index > 0 && starts[index]! > m.start) index--;
    const line = lines[index]!;
    const start = m.start - starts[index]!;
    const end = m.end - starts[index]!;
    if (start < 0 || end > line.length || end <= start) continue;
    const raw = line.slice(start, end);
    let value = m.value;
    if (m.kind === 'amount' && value === undefined) {
      const number = /-?\d[\d,.   ]*\d|\d/.exec(raw);
      if (!number) continue;
      value = normalizeNumber(number[0]);
    }
    if (value === undefined || (m.kind === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value))) continue;
    out.push({ kind: m.kind, value, raw, line: index, start, end, source: 'system' });
  }
  return out;
}

/**
 * Rule-based primary, system secondary: keep all rule-based candidates; when the system
 * recognizes the same value at the same position, mark the rule candidate as confirmed; when the
 * system recognizes a value where rules have no candidate, add it as a supplement; when values at
 * the same position differ, follow the rules.
 */
export function mergeCandidates(
  rules: readonly ValueCandidate[],
  system: readonly ValueCandidate[],
): ValueCandidate[] {
  const out = rules.map((c) => ({ ...c }));
  for (const s of system) {
    const overlap = out.filter(
      (r) => r.kind === s.kind && r.line === s.line && s.start < r.end && s.end > r.start,
    );
    if (overlap.length === 0) {
      out.push({ ...s });
      continue;
    }
    for (const r of overlap)
      if (r.source === 'rule' && sameValue(r.kind, r.value, s.value)) r.confirmed = true;
  }
  return out.sort((a, b) => a.line - b.line || a.start - b.start);
}
