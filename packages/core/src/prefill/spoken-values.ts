import { localDate, formatDuration } from '../field-values';

// Values in a spoken sentence (D-575): amount, number, date, time, duration, rating, in Chinese,
// English, and French. Speech-to-text output often contains Chinese numerals or English/French
// number words (e.g., "twenty-three point five", "twelve fifty", "quarante-deux euros"); first
// normalize numbers to Arabic digits (recording each word's position in the original utterance),
// then match by kind; code-only, no model queries. Output each value in form-compatible format
// (date YYYY-MM-DD, time HH:mm, duration h:mm; amounts and numbers as plain text); for ambiguous
// cases (e.g., whether "three o'clock" means afternoon or midnight), provide two interpretations,
// with the first being more likely. Avoid regex lookbehind (Hermes).

export type SpokenKind = 'money' | 'number' | 'date' | 'time' | 'duration' | 'rating';

export interface SpokenValue {
  kind: SpokenKind;
  /** Form representations; when multiple readings exist, the first is more likely. */
  values: readonly string[];
  /** This segment in the original speech. */
  raw: string;
  start: number;
  end: number;
  /** Unit following a number (e.g., "kilometer", "km", "bottle"), used for matching field units. */
  unit?: string;
  /** Amount: currency was explicitly stated (e.g., Chinese yuan character, "euros", "$"). Unspecified numbers are treated as numbers, and only treated as amounts when no currency-specified amounts exist. */
  marked?: boolean;
}

// ---------- Step 1: Normalize numbers to Arabic numerals ----------

interface Normalized {
  text: string;
  /** Start and end indices in the original speech corresponding to the i-th normalized character. */
  from: number[];
  to: number[];
}

const ZH_DIGIT: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};
const ZH_UNIT: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10000 };

/** Chinese numbers ("twenty-three", colloquial "one-twenty" for 120, "twenty-three thousand", "one-three-eight") -> number; returns null if unparseable. */
export function zhNumber(s: string): number | null {
  if (!s) return null;
  if (![...s].some((c) => c in ZH_UNIT)) {
    // Without tens, hundreds, thousands: digits read one by one (e.g., "one-three-eight", "two-zero-two-six").
    let out = '';
    for (const c of s) {
      const d = ZH_DIGIT[c];
      if (d === undefined) return null;
      out += String(d);
    }
    return Number(out);
  }
  let total = 0;
  let section = 0;
  let digit: number | null = null;
  let lastUnit = 0;
  for (const c of s) {
    if (c in ZH_DIGIT) {
      digit = ZH_DIGIT[c]!;
      continue;
    }
    const unit = ZH_UNIT[c];
    if (unit === undefined) return null;
    if (unit === 10000) {
      section += digit ?? 0;
      total += (section || 1) * 10000;
      section = 0;
      lastUnit = 10000;
    } else {
      section += (digit ?? (unit === 10 ? 1 : 0)) * unit;
      lastUnit = unit;
    }
    digit = null;
  }
  if (digit !== null) {
    // "one-two-zero" = 120, "one-thousand-five" = 1500, "twenty-three thousand" = 23000: the last digit following hundred, thousand, or ten-thousand represents the next position.
    section += lastUnit >= 100 ? digit * (lastUnit / 10) : digit;
  }
  return total + section;
}

const EN_WORDS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};
const FR_WORDS: Record<string, number> = {
  zéro: 0,
  zero: 0,
  un: 1,
  une: 1,
  deux: 2,
  trois: 3,
  quatre: 4,
  cinq: 5,
  six: 6,
  sept: 7,
  huit: 8,
  neuf: 9,
  dix: 10,
  onze: 11,
  douze: 12,
  treize: 13,
  quatorze: 14,
  quinze: 15,
  seize: 16,
  vingt: 20,
  vingts: 20,
  trente: 30,
  quarante: 40,
  cinquante: 50,
  soixante: 60,
};
const MULTIPLIERS: Record<string, number> = {
  hundred: 100,
  thousand: 1000,
  cent: 100,
  cents: 100,
  mille: 1000,
};
/** 'one', 'un', 'a' appearing alone are mostly not numbers ('one coffee', 'un café'), counted as numbers only when followed by these words. */
const LONE_ONE = /^(?:one|un|une|a|an)$/;
const AFTER_ONE =
  /^\s*(?:-?\s*)(?:hours?|hour|minutes?|euros?|dollars?|bucks?|stars?|heures?|étoiles?|demi|half|hundred|thousand|cents?|mille)\b/i;

/** English and French number words read one by one: a sequence of number words combined into a single number; two numbers both >= 10 like 'twelve fifty' are split into two numbers. */
function wordNumbers(text: string, out: { start: number; end: number; value: number }[]): void {
  const word = /[a-zà-ÿ]+(?:-[a-zà-ÿ]+)*/gi;
  let m: RegExpExecArray | null;
  interface Tok {
    start: number;
    end: number;
    word: string;
  }
  const toks: Tok[] = [];
  while ((m = word.exec(text)) !== null) {
    // Split hyphenated numbers (twenty-five, quatre-vingt-dix, dix-sept).
    let at = m.index;
    for (const part of m[0].split('-')) {
      toks.push({ start: at, end: at + part.length, word: part.toLowerCase() });
      at += part.length + 1;
    }
  }
  const valueOf = (i: number): number | null => {
    const w = toks[i]!.word;
    if (w in EN_WORDS) return EN_WORDS[w]!;
    if (w in FR_WORDS) return FR_WORDS[w]!;
    return null;
  };
  let i = 0;
  while (i < toks.length) {
    const first = toks[i]!;
    const v0 = valueOf(i);
    const isA = first.word === 'a' || first.word === 'an';
    if (v0 === null && !(isA && toks[i + 1] && toks[i + 1]!.word in MULTIPLIERS)) {
      i++;
      continue;
    }
    // Sequence: numerals, hundred/thousand/cent/mille, with optional and/et in between (vingt et un, one hundred and five).
    let total = 0;
    let current = isA ? 1 : 0;
    let last = isA ? 1 : -1;
    let j = i;
    let end = first.end;
    if (isA) j++;
    for (; j < toks.length; j++) {
      const t = toks[j]!;
      // Only whitespace or hyphens are allowed between two words.
      if (j > i && !/^[\s-]*$/.test(text.slice(toks[j - 1]!.end, t.start))) break;
      if ((t.word === 'and' || t.word === 'et') && j > i) {
        const next = toks[j + 1];
        const nv = next ? (valueOf(j + 1) ?? (next.word in MULTIPLIERS ? 0 : null)) : null;
        if (nv === null || current === 0) break;
        continue;
      }
      if (t.word === 'quatre' && toks[j + 1]?.word.startsWith('vingt')) {
        // quatre-vingt(s) = 80。
        if (last >= 0 && last < 10 && current % 100 !== 0) break;
        current += 80;
        last = 80;
        end = toks[j + 1]!.end;
        j++;
        continue;
      }
      const mult = MULTIPLIERS[t.word];
      if (mult !== undefined) {
        if (mult === 1000) {
          total += (current || 1) * 1000;
          current = 0;
        } else current = (current || 1) * 100;
        last = mult;
        end = t.end;
        continue;
      }
      const v = valueOf(j);
      if (v === null) break;
      if (j > i && last >= 0) {
        // Tens can only be followed by units (French 60 and 80 can be followed by 10-19); teens cannot be followed by further numbers.
        const tens = last >= 20 && last < 100 && last % 10 === 0;
        const ok =
          (last >= 100 && v < 100) ||
          (tens && v < 10) ||
          (tens && (last === 60 || last === 80) && v >= 10 && v < 20) ||
          // French dix-sept, soixante-dix-neuf: 10 followed by 7-9.
          (last === 10 && v >= 7 && v <= 9 && /^(?:sept|huit|neuf)$/.test(t.word));
        if (!ok) break;
      }
      current += v;
      last = v;
      end = t.end;
    }
    const value = total + current;
    const raw = text.slice(first.start, end).toLowerCase();
    const lone = LONE_ONE.test(raw);
    if (!lone || AFTER_ONE.test(text.slice(end))) out.push({ start: first.start, end, value });
    i = Math.max(j, i + 1);
  }
}

// A single Chinese digit (yi, liang, san) is considered a number only when followed by these (yiqi and tongyi are not numbers); Monday and Wednesday also count.
const ZH_FOLLOW =
  /^[块元圆毛角个瓶件杯份本张次斤克米升人位盒包袋支双条只顿页章集岁天周月年号日点小分星颗倍折碗碟盘根台部篇首遍圈步层楼趟]|^公[里斤]|^千[米克]|^钟头/;
const ZH_RUN = /[零〇一二两三四五六七八九十百千万]+/g;

function normalize(text: string): Normalized {
  const found: { start: number; end: number; value: number }[] = [];
  let m: RegExpExecArray | null;
  ZH_RUN.lastIndex = 0;
  while ((m = ZH_RUN.exec(text)) !== null) {
    const s = m[0];
    const before = text.slice(Math.max(0, m.index - 2), m.index);
    const after = text.slice(m.index + s.length);
    const single = s.length === 1;
    // "yidian", "youdian": mostly "yixie"; standalone "shi", "qian", "wan" are also not treated as
    // numbers. Standalone "shi" counts when followed by a measure word or hour (shigongli, shidian,
    // shifenzhong); standalone bai, qian, wan do not count.
    if (single && !(s in ZH_DIGIT) && !(s === '十' && ZH_FOLLOW.test(after))) continue;
    if (single && !ZH_FOLLOW.test(after) && !/(?:周|星期|礼拜|[块元圆点])$/.test(before)) continue;
    if (s === '一' && /^点(?![0-9零〇一二三四五六七八九十半])/.test(after)) continue;
    const value = zhNumber(s);
    if (value !== null) found.push({ start: m.index, end: m.index + s.length, value });
  }
  wordNumbers(text, found);
  found.sort((a, b) => a.start - b.start);
  let out = '';
  const from: number[] = [];
  const to: number[] = [];
  let at = 0;
  for (const f of found) {
    if (f.start < at) continue;
    for (; at < f.start; at++) {
      out += text[at];
      from.push(at);
      to.push(at + 1);
    }
    const digits = String(f.value);
    for (let k = 0; k < digits.length; k++) {
      from.push(f.start);
      to.push(f.end);
    }
    out += digits;
    at = f.end;
  }
  for (; at < text.length; at++) {
    out += text[at];
    from.push(at);
    to.push(at + 1);
  }
  return { text: out, from, to };
}

// ---------- Step 2: Find by type ----------

const pad2 = (n: number) => String(n).padStart(2, '0');
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const money = (n: number) => String(Math.round(n * 100) / 100);
const num = (s: string) => Number(s.replace(',', '.'));

/** Weekday: 1 = Monday ... 7 = Sunday. */
const weekday = (d: Date) => ((d.getDay() + 6) % 7) + 1;
/**
 * which: this = this week (starting Monday), next = next week, last = last week, coming = today
 * or the nearest future day, after = nearest future day after today, before = nearest past day
 * before today.
 */
function dayOfWeek(
  today: Date,
  day: number,
  which: 'this' | 'next' | 'nextnext' | 'last' | 'coming' | 'after' | 'before',
): Date {
  const now = weekday(today);
  switch (which) {
    case 'this':
      return addDays(today, day - now);
    case 'next':
      return addDays(today, 7 + day - now);
    case 'nextnext':
      return addDays(today, 14 + day - now);
    case 'last':
      return addDays(today, -7 + day - now);
    case 'coming':
      return addDays(today, (day - now + 7) % 7);
    case 'after':
      return addDays(today, ((day - now + 6) % 7) + 1);
    case 'before':
      return addDays(today, -(((now - day + 6) % 7) + 1));
  }
}

const EN_DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const FR_DAYS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
const EN_MONTHS = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
];
const FR_MONTHS = [
  'janvier',
  'février',
  'mars',
  'avril',
  'mai',
  'juin',
  'juillet',
  'août',
  'septembre',
  'octobre',
  'novembre',
  'décembre',
];
const monthIndex = (w: string): number => {
  const s = w.toLowerCase();
  const fr = FR_MONTHS.findIndex((m) => s === m || (m === 'février' && s === 'fevrier'));
  if (fr >= 0) return fr;
  if (s === 'may') return 4;
  return s.length >= 3 ? EN_MONTHS.findIndex((m) => s.startsWith(m)) : -1;
};
const validDay = (y: number, m: number, d: number) => {
  const date = new Date(y, m, d);
  return date.getMonth() === m && date.getDate() === d ? date : null;
};

interface Hit {
  kind: SpokenKind;
  values: string[];
  start: number;
  end: number;
  unit?: string;
  marked?: boolean;
}

/** Latin word boundary (without lookbehind): preceded by a non-letter/non-digit. */
const B = '(?:^|[^\\p{L}\\p{N}])';
const E = '(?![\\p{L}\\p{N}])';

type Finder = (n: string, today: Date) => Hit[];

function scan(
  n: string,
  re: RegExp,
  make: (m: RegExpExecArray) => Omit<Hit, 'start' | 'end'> | null,
) {
  const out: Hit[] = [];
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  let m: RegExpExecArray | null;
  while ((m = g.exec(n)) !== null) {
    // The preceding character swallowed by the Latin word boundary is excluded.
    const lead = m[0].length - m[0].replace(/^[^\p{L}\p{N}$€£¥￥]+/u, '').length;
    const hit = make(m);
    if (hit) out.push({ ...hit, start: m.index + lead, end: m.index + m[0].length });
    if (m[0].length === 0) g.lastIndex++;
  }
  return out;
}

const DATE_FINDERS: Finder[] = [
  // Chinese: today, tomorrow...
  (n, today) =>
    scan(n, /大后天|大前天|今天|今晚|今早|明天|明晚|明早|后天|昨天|昨晚|前天/u, (m) => {
      const map: Record<string, number> = {
        大后天: 3,
        大前天: -3,
        今天: 0,
        今晚: 0,
        今早: 0,
        明天: 1,
        明晚: 1,
        明早: 1,
        后天: 2,
        昨天: -1,
        昨晚: -1,
        前天: -2,
      };
      return { kind: 'date', values: [localDate(addDays(today, map[m[0]]!))] };
    }),
  // Next Friday, this Wednesday, Sunday, last Monday.
  (n, today) =>
    scan(n, /(下下|下个?|这个?|本|上个?)?(?:周|星期|礼拜)([1-7日天])/u, (m) => {
      const day = /[日天]/.test(m[2]!) ? 7 : Number(m[2]);
      const p = m[1] ?? '';
      const which = p.startsWith('下下')
        ? 'nextnext'
        : p.startsWith('下')
          ? 'next'
          : p.startsWith('上')
            ? 'last'
            : p
              ? 'this'
              : 'coming';
      return { kind: 'date', values: [localDate(dayOfWeek(today, day, which))] };
    }),
  // March 5, 2026, March 5, next month's 5th, the 5th.
  (n, today) =>
    scan(
      n,
      /(?:(\d{4})\s*年\s*)?(?:(下个?|上个?|这个?|本)月|(\d{1,2})\s*月)\s*(\d{1,2})\s*[日号]|(\d{1,2})\s*[日号]/u,
      (m) => {
        let y = m[1] ? Number(m[1]) : today.getFullYear();
        let mo = today.getMonth();
        if (m[3]) mo = Number(m[3]) - 1;
        else if (m[2]?.startsWith('下')) mo += 1;
        else if (m[2]?.startsWith('上')) mo -= 1;
        if (mo > 11) [y, mo] = [y + 1, mo - 12];
        if (mo < 0) [y, mo] = [y - 1, mo + 12];
        const d = validDay(y, mo, Number(m[4] ?? m[5]));
        return d ? { kind: 'date', values: [localDate(d)] } : null;
      },
    ),
  // English.
  (n, today) =>
    scan(
      n,
      new RegExp(
        `${B}(the day after tomorrow|the day before yesterday|today|tonight|this (?:morning|afternoon|evening)|tomorrow|yesterday|last night)${E}`,
        'iu',
      ),
      (m) => {
        const w = m[1]!.toLowerCase();
        const shift = w.startsWith('the day after')
          ? 2
          : w.startsWith('the day before')
            ? -2
            : w === 'tomorrow'
              ? 1
              : w === 'yesterday' || w === 'last night'
                ? -1
                : 0;
        return { kind: 'date', values: [localDate(addDays(today, shift))] };
      },
    ),
  (n, today) =>
    scan(n, new RegExp(`${B}(?:(next|this|last|on)\\s+)?(${EN_DAYS.join('|')})${E}`, 'iu'), (m) => {
      const day = EN_DAYS.indexOf(m[2]!.toLowerCase()) + 1;
      const p = (m[1] ?? '').toLowerCase();
      const which =
        p === 'next' ? 'next' : p === 'last' ? 'before' : p === 'this' ? 'this' : 'coming';
      return { kind: 'date', values: [localDate(dayOfWeek(today, day, which))] };
    }),
  // March 3rd, 3 March, the 3rd of March (can include year).
  (n, today) =>
    scan(
      n,
      new RegExp(
        `${B}(?:(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\\.?\\s+(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?|(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(january|february|march|april|may|june|july|august|september|october|november|december))(?:,?\\s+(\\d{4}))?${E}`,
        'iu',
      ),
      (m) => {
        const mo = monthIndex(m[1] ?? m[4]!);
        const d = validDay(m[5] ? Number(m[5]) : today.getFullYear(), mo, Number(m[2] ?? m[3]));
        return d ? { kind: 'date', values: [localDate(d)] } : null;
      },
    ),
  // French.
  (n, today) =>
    scan(
      n,
      new RegExp(
        `${B}(après-demain|avant-hier|aujourd'hui|aujourd’hui|ce soir|ce matin|demain|hier)${E}`,
        'iu',
      ),
      (m) => {
        const w = m[1]!.toLowerCase();
        const shift = w.startsWith('après')
          ? 2
          : w.startsWith('avant')
            ? -2
            : w === 'demain'
              ? 1
              : w === 'hier'
                ? -1
                : 0;
        return { kind: 'date', values: [localDate(addDays(today, shift))] };
      },
    ),
  (n, today) =>
    scan(
      n,
      new RegExp(
        `${B}(?:le\\s+)?(\\d{1,2}|1er)\\s+(${FR_MONTHS.join('|')}|fevrier|aout)(?:\\s+(\\d{4}))?${E}`,
        'iu',
      ),
      (m) => {
        const mo = monthIndex(m[2]!.replace(/^aout$/i, 'août'));
        const day = m[1] === '1er' ? 1 : Number(m[1]);
        const d = validDay(m[3] ? Number(m[3]) : today.getFullYear(), mo, day);
        return d ? { kind: 'date', values: [localDate(d)] } : null;
      },
    ),
  (n, today) =>
    scan(n, new RegExp(`${B}(${FR_DAYS.join('|')})(?:\\s+(prochain|dernier))?${E}`, 'iu'), (m) => {
      const day = FR_DAYS.indexOf(m[1]!.toLowerCase()) + 1;
      const which = m[2] === 'prochain' ? 'after' : m[2] === 'dernier' ? 'before' : 'coming';
      return { kind: 'date', values: [localDate(dayOfWeek(today, day, which))] };
    }),
  // 2026-03-05。
  (n) =>
    scan(n, /(\d{4})-(\d{2})-(\d{2})/u, (m) => {
      const d = validDay(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      return d ? { kind: 'date', values: [localDate(d)] } : null;
    }),
];

/** Hours and minutes; for 1-11 o'clock without AM/PM specified, provide two readings (1-6 defaults to PM first, 7-11 defaults to AM first). */
function timeValues(h: number, min: number, period: 'am' | 'pm' | 'noon' | null): string[] | null {
  if (min < 0 || min > 59 || h < 0 || h > 24) return null;
  if (h === 24) h = 0;
  const hm = (x: number) => `${pad2(x)}:${pad2(min)}`;
  if (period === 'pm') return [hm(h < 12 ? h + 12 : h)];
  if (period === 'am') return [hm(h === 12 ? 0 : h)];
  if (period === 'noon') return [hm(h <= 3 ? h + 12 : h)];
  if (h === 0 || h >= 12) return [hm(h)];
  return h <= 6 ? [hm(h + 12), hm(h)] : [hm(h), hm(h + 12)];
}

const ZH_PERIOD: Record<string, 'am' | 'pm' | 'noon'> = {
  早上: 'am',
  早晨: 'am',
  上午: 'am',
  凌晨: 'am',
  清早: 'am',
  中午: 'noon',
  下午: 'pm',
  傍晚: 'pm',
  晚上: 'pm',
  夜里: 'pm',
  今晚: 'pm',
  明晚: 'pm',
  昨晚: 'pm',
  半夜: 'am',
};

const TIME_FINDERS: Finder[] = [
  // Chinese: 3:30 PM, 8:15 PM, 10 o'clock, 3:15. "San dian wu" has no day/night or minutes, "dian" is a decimal point, not time.
  (n) =>
    scan(
      n,
      /(早上|早晨|上午|凌晨|清早|中午|下午|傍晚|晚上|夜里|今晚|明晚|昨晚|半夜)?\s*(\d{1,2})\s*点\s*(?:(半)|(\d{1,2})\s*(分)?|(1|一)刻|(3|三)刻)?\s*(钟)?/u,
      (m) => {
        const period = m[1] ? ZH_PERIOD[m[1]]! : null;
        const h = Number(m[2]);
        const marked = period !== null || m[3] || m[5] || m[6] || m[7] || m[8];
        if (!marked) {
          // Counted as time only if not followed by a digit after "3" (not a decimal) and not "yidian" (some).
          if (m[4] !== undefined) return null;
          if (h < 2 && !/\d/.test(m[2]!)) return null;
        }
        if (m[4] !== undefined && !period && !m[5]) return null;
        const min = m[3] ? 30 : m[6] ? 15 : m[7] ? 45 : m[4] ? Number(m[4]) : 0;
        const v = timeValues(h, min, period);
        return v ? { kind: 'time', values: v } : null;
      },
    ),
  // 15:30 (various languages).
  (n) =>
    scan(n, /(\d{1,2})\s*[:：]\s*(\d{2})(?:\s*(am|pm|a\.m\.|p\.m\.))?/iu, (m) => {
      const p = m[3]?.toLowerCase().startsWith('p') ? 'pm' : m[3] ? 'am' : null;
      const v = timeValues(Number(m[1]), Number(m[2]), p ?? (Number(m[1]) >= 13 ? 'pm' : null));
      return v ? { kind: 'time', values: v } : null;
    }),
  // English: 3pm, at 3, at 3 30, half past three, noon.
  (n) =>
    scan(
      n,
      new RegExp(
        `${B}(?:at\\s+)?(\\d{1,2})(?:\\s+(\\d{2}))?\\s*(am|pm|a\\.m\\.|p\\.m\\.|o'?clock)(?:\\s+in the (morning|afternoon|evening))?`,
        'iu',
      ),
      (m) => {
        const p = m[3]!.toLowerCase();
        const period = p.startsWith('p')
          ? 'pm'
          : p.startsWith('a')
            ? 'am'
            : m[4]
              ? m[4].toLowerCase() === 'morning'
                ? 'am'
                : 'pm'
              : null;
        const v = timeValues(Number(m[1]), m[2] ? Number(m[2]) : 0, period);
        return v ? { kind: 'time', values: v } : null;
      },
    ),
  (n) =>
    scan(
      n,
      new RegExp(
        `${B}at\\s+(\\d{1,2})(?:\\s+(\\d{2}))?(?!\\s*(?:[:.,]\\d|dollars?|bucks?|euros?|\\$|€|%))(?:\\s+(?:in the (morning|afternoon|evening)|(tonight)))?${E}`,
        'iu',
      ),
      (m) => {
        const period = m[3] ? (m[3].toLowerCase() === 'morning' ? 'am' : 'pm') : m[4] ? 'pm' : null;
        const v = timeValues(Number(m[1]), m[2] ? Number(m[2]) : 0, period);
        return v ? { kind: 'time', values: v } : null;
      },
    ),
  (n) =>
    scan(n, new RegExp(`${B}(half|quarter) (past|to) (\\d{1,2})${E}`, 'iu'), (m) => {
      const h = Number(m[3]);
      const min = m[1]!.toLowerCase() === 'half' ? 30 : 15;
      const v =
        m[2]!.toLowerCase() === 'past'
          ? timeValues(h, min, null)
          : timeValues(h - 1, 60 - min, null);
      return v ? { kind: 'time', values: v } : null;
    }),
  (n) =>
    scan(n, new RegExp(`${B}(noon|midday|midnight|midi|minuit)${E}`, 'iu'), (m) => ({
      kind: 'time',
      values: [/^(noon|midday|midi)$/i.test(m[1]!) ? '12:00' : '00:00'],
    })),
  // French: 15h30, à 3 heures et demie, 8 heures du soir. "2 heures" without à and without day/night is a duration.
  (n) =>
    scan(
      n,
      new RegExp(
        `${B}(à|vers)?\\s*(\\d{1,2})\\s*(?:h(?:\\s*(\\d{2}))?|heures?(?:\\s+(et demie|et quart|moins le quart|\\d{1,2}))?)(?:\\s+(du matin|de l'après-midi|de l’après-midi|du soir))?${E}`,
        'iu',
      ),
      (m) => {
        const short = !/heure/i.test(m[0]);
        if (!short && !m[1] && !m[5]) return null;
        const h = Number(m[2]);
        const tail = (m[4] ?? '').toLowerCase();
        const min = m[3]
          ? Number(m[3])
          : tail === 'et demie'
            ? 30
            : tail === 'et quart'
              ? 15
              : tail === 'moins le quart'
                ? -15
                : tail
                  ? Number(tail)
                  : 0;
        const period = m[5] ? (m[5].toLowerCase() === 'du matin' ? 'am' : 'pm') : null;
        const v =
          min < 0
            ? timeValues(h - 1, 60 + min, period)
            : timeValues(h, min, period ?? (h >= 13 ? 'pm' : null));
        return v ? { kind: 'time', values: v } : null;
      },
    ),
];

const DURATION_FINDERS: Finder[] = [
  // Chinese: one and a half hours, 2 hours 30 minutes, half an hour, 45 minutes, a quarter of an hour.
  (n) =>
    scan(
      n,
      /(\d+(?:\.\d+)?)\s*个?\s*(半)?\s*(?:小时|钟头)(?:\s*(\d{1,2})\s*分钟?)?|半\s*个?\s*(?:小时|钟头)/u,
      (m) => {
        if (m[1] === undefined) return { kind: 'duration', values: [formatDuration(30)] };
        const min = Number(m[1]) * 60 + (m[2] ? 30 : 0) + (m[3] ? Number(m[3]) : 0);
        return { kind: 'duration', values: [formatDuration(min)] };
      },
    ),
  (n) =>
    scan(n, /(\d+)\s*分钟|(?:1|一)\s*刻钟/u, (m) => ({
      kind: 'duration',
      values: [formatDuration(m[1] ? Number(m[1]) : 15)],
    })),
  // English.
  (n) =>
    scan(
      n,
      new RegExp(
        `${B}(?:(\\d+(?:\\.\\d+)?)\\s*(?:and a half\\s+)?(?:hours?|hrs?)(?:\\s+and a half)?(?:\\s+(?:and\\s+)?(\\d{1,2})\\s*(?:minutes?|mins?))?|(\\d+)\\s*(?:minutes?|mins?)|(half an hour))${E}`,
        'iu',
      ),
      (m) => {
        if (m[4]) return { kind: 'duration', values: [formatDuration(30)] };
        if (m[3]) return { kind: 'duration', values: [formatDuration(Number(m[3]))] };
        const half = /and a half/i.test(m[0]) ? 30 : 0;
        return {
          kind: 'duration',
          values: [formatDuration(Number(m[1]) * 60 + half + (m[2] ? Number(m[2]) : 0))],
        };
      },
    ),
  // French: 2 heures, une heure et demie, une demi-heure, 45 minutes (those with à are times, recognized above).
  (n) =>
    scan(
      n,
      new RegExp(
        `${B}(?:(\\d+)\\s*heures?(?:\\s+(et demie|et quart)|\\s+(\\d{1,2})(?:\\s*minutes?)?)?|(\\d+)\\s*minutes?|(une demi-heure|1 demi-heure)|(un quart d'heure|un quart d’heure|1 quart d'heure|1 quart d’heure))${E}`,
        'iu',
      ),
      (m) => {
        if (m[5]) return { kind: 'duration', values: [formatDuration(30)] };
        if (m[6]) return { kind: 'duration', values: [formatDuration(15)] };
        if (m[4]) return { kind: 'duration', values: [formatDuration(Number(m[4]))] };
        const extra = m[2] === 'et quart' ? 15 : m[2] ? 30 : 0;
        return {
          kind: 'duration',
          values: [formatDuration(Number(m[1]) * 60 + extra + (m[3] ? Number(m[3]) : 0))],
        };
      },
    ),
];

const RATING_FINDERS: Finder[] = [
  (n) =>
    scan(
      n,
      new RegExp(
        `(\\d)\\s*(?:颗)?星|打\\s*(\\d)\\s*分|${B}(\\d)\\s*(?:stars?|étoiles?|out of 5|sur 5)${E}`,
        'iu',
      ),
      (m) => {
        const v = Number(m[1] ?? m[2] ?? m[3]);
        return v >= 1 && v <= 5 ? { kind: 'rating', values: [String(v)] } : null;
      },
    ),
];

const CURRENCY_WORD = 'dollars?|bucks?|usd|euros?|eur|pounds?|gbp|francs?|chf|yuan|rmb|yens?';
const SUB_WORD = 'cents?|centimes?|pence|p';

const ZH_COUNTER =
  '个|瓶|件|杯|份|本|张|次|斤|公斤|千克|克|公里|千米|米|升|毫升|人|位|盒|包|袋|支|双|条|只|顿|页|章|集|岁|碗|碟|盘|根|台|部|篇|首|遍|圈|步|层|楼|趟|天|周|个月|年|倍|折|%';
const MONEY_FINDERS: Finder[] = [
  // Chinese: 23.5 yuan (kuai), 7.5 mao, 23.5 yuan, 5 mao, RMB 30.
  (n) =>
    scan(
      n,
      // "30 kuai each": if the number after kuai is followed by a measure word, it is the quantity of the next item, not jiao/mao.
      new RegExp(
        `(\\d+(?:\\.\\d+)?)\\s*(?:块钱|块|元钱|元|圆)(?:\\s*(\\d)(?!\\s*(?:${ZH_COUNTER}))\\s*(?:毛|角)?(?:\\s*(\\d)\\s*分?)?)?|(\\d+)\\s*点\\s*(\\d+)\\s*(?:块钱|块|元)|(\\d)\\s*(?:毛|角)(?:钱)?|(?:人民币|¥|￥|RMB)\\s*(\\d+(?:\\.\\d+)?)`,
        'iu',
      ),
      (m) => {
        let v: number;
        if (m[1] !== undefined)
          v = Number(m[1]) + (m[2] ? Number(m[2]) / 10 : 0) + (m[3] ? Number(m[3]) / 100 : 0);
        else if (m[4] !== undefined) v = Number(`${m[4]}.${m[5]}`);
        else if (m[6] !== undefined) v = Number(m[6]) / 10;
        else v = Number(m[7]);
        return { kind: 'money', values: [money(v)], marked: true };
      },
    ),
  // $12.50、€4,50、£3。
  (n) =>
    scan(n, /[$€£]\s*(\d+(?:[.,]\d{1,2})?)/u, (m) => ({
      kind: 'money',
      values: [money(num(m[1]!))],
      marked: true,
    })),
  // 12 dollars 50、4 euros 50、12.50 dollars、42 euros、12 dollars and 50 cents、50 cents。
  (n) =>
    scan(
      n,
      new RegExp(
        `${B}(\\d+(?:[.,]\\d{1,2})?)\\s*(?:${CURRENCY_WORD}|€|\\$|£)(?:\\s+(?:and\\s+|et\\s+)?(\\d{1,2})(?:\\s*(?:${SUB_WORD}))?(?![\\p{L}\\p{N}]|\\s*(?:h\\b|heures?|hours?|minutes?|[:：])))?${E}`,
        'iu',
      ),
      (m) => ({
        kind: 'money',
        values: [money(num(m[1]!) + (m[2] ? Number(m[2]) / 100 : 0))],
        marked: true,
      }),
    ),
  (n) =>
    scan(n, new RegExp(`${B}(\\d{1,2})\\s*(?:${SUB_WORD})${E}`, 'iu'), (m) => ({
      kind: 'money',
      values: [money(Number(m[1]) / 100)],
      marked: true,
    })),
];

const LATIN_UNIT =
  'km|kms|kilometers?|kilometres?|kilomètres?|miles?|mi|kg|kgs|kilos?|lbs?|g|grams?|grammes?|l|liters?|litres?|ml|pages?|chapters?|chapitres?|times|fois|people|persons?|personnes?|items?|bottles?|bouteilles?|cups?|tasses?|glasses?|verres?|reps?|sets?|laps?|tours?|steps?|pas|days?|jours?|weeks?|semaines?|months?|mois|years?|ans?|%';

const NUMBER_FINDERS: Finder[] = [
  // Chinese decimals (not recognized as time): san dian wu, san dian wu gongli (recognized first, otherwise "wu gongli" would be taken separately).
  (n) =>
    scan(n, new RegExp(`(\\d+)\\s*点\\s*(\\d+)(?:\\s*(${ZH_COUNTER}))?`, 'u'), (m) => ({
      kind: 'number',
      values: [`${m[1]}.${m[2]}`],
      ...(m[3] ? { unit: m[3].toLowerCase() } : {}),
    })),
  // Numbers with units (quantities, not money): 3 bottles, 5 kilometers, 12 km; English nouns like 3 shirts are not recognized and treated as unitless numbers.
  (n) =>
    scan(
      n,
      new RegExp(
        `(\\d+(?:[.,]\\d+)?)\\s*(${ZH_COUNTER})|${B}(\\d+(?:[.,]\\d+)?)\\s*(${LATIN_UNIT})${E}`,
        'iu',
      ),
      (m) => ({
        kind: 'number',
        values: [String(num(m[1] ?? m[3]!))],
        unit: (m[2] ?? m[4]!).toLowerCase(),
      }),
    ),
  // English "twelve fifty": two consecutive numerals where the second is a two-digit number are treated as a decimal number (mostly prices).
  (n) => scan(n, /(\d+(?:[.,]\d+)?)/u, (m) => ({ kind: 'number', values: [String(num(m[1]!))] })),
];

/** "twelve fifty": in the original text, two numerals (not digits) with the second being 10-99, combined into 12.50. */
function wordPrice(hits: Hit[], raw: (h: Hit) => string, n: string): Hit[] {
  const out: Hit[] = [];
  for (let i = 0; i < hits.length; i++) {
    const a = hits[i]!;
    const b = hits[i + 1];
    if (
      b &&
      a.kind === 'number' &&
      b.kind === 'number' &&
      !a.unit &&
      !b.unit &&
      /^\s+$/.test(n.slice(a.end, b.start)) &&
      /^[a-zà-ÿ\s-]+$/i.test(raw(a)) &&
      /^[a-zà-ÿ\s-]+$/i.test(raw(b)) &&
      Number(a.values[0]) >= 1 &&
      Number(b.values[0]) >= 10 &&
      Number(b.values[0]) <= 99
    ) {
      out.push({
        ...a,
        end: b.end,
        values: [money(Number(a.values[0]) + Number(b.values[0]) / 100)],
      });
      i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

/**
 * Read values in a sentence, ordered by their appearance. First recognize dates, times,
 * durations, ratings, amounts, then remaining numbers; each text segment is counted only once ("3
 * PM" is no longer treated as the number 3). today is the user's today (local date).
 */
export function readSpoken(text: string, today: Date): SpokenValue[] {
  const n = normalize(text);
  const taken: Hit[] = [];
  const overlaps = (h: Hit) => taken.some((t) => h.start < t.end && t.start < h.end);
  const groups: Finder[][] = [
    DATE_FINDERS,
    TIME_FINDERS,
    DURATION_FINDERS,
    RATING_FINDERS,
    MONEY_FINDERS,
    NUMBER_FINDERS,
  ];
  for (const finders of groups) {
    for (const find of finders) {
      for (const h of find(n.text, today)) {
        // Parts of a number (the "2" in "123") do not count.
        if (overlaps(h)) continue;
        const digit = (i: number) => /\d/.test(n.text[i] ?? '');
        if ((digit(h.start) && digit(h.start - 1)) || (digit(h.end - 1) && digit(h.end))) continue;
        taken.push(h);
      }
    }
  }
  taken.sort((a, b) => a.start - b.start);
  const rawOf = (h: Hit) => text.slice(n.from[h.start]!, n.to[h.end - 1]!);
  return wordPrice(taken, rawOf, n.text).map((h) => ({
    kind: h.kind,
    values: h.values,
    raw: rawOf(h),
    start: n.from[h.start]!,
    end: n.to[h.end - 1]!,
    ...(h.unit !== undefined ? { unit: h.unit } : {}),
    ...(h.marked ? { marked: true } : {}),
  }));
}
