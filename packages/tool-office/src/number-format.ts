// Number display formats from native Excel format IDs (ECMA-376 18.8.30); unlisted ones (localized
// dates) default to date. For external xlsx files (D-509), render cell values into formatted
// display text as seen in the spreadsheet (used in edit page and preview; when saving, write back
// original values and formats without relying on this text). Implements common formats only:
// General, decimal places, thousands separator, percentage, scientific notation, currency symbols
// and quoted text, positive/negative/zero three-part formats, dates and times (English month
// names). Fractions, conditional formatting, etc., are written as General.

/** Excel built-in format numbers -> format (ECMA-376 18.8.30); unlisted formats (regional dates) are treated as dates. */
export const BUILTIN_NUMBER_FORMATS: Record<number, string> = {
  0: 'General',
  1: '0',
  2: '0.00',
  3: '#,##0',
  4: '#,##0.00',
  9: '0%',
  10: '0.00%',
  11: '0.00E+00',
  12: '# ?/?',
  13: '# ??/??',
  14: 'mm-dd-yy',
  15: 'd-mmm-yy',
  16: 'd-mmm',
  17: 'mmm-yy',
  18: 'h:mm AM/PM',
  19: 'h:mm:ss AM/PM',
  20: 'h:mm',
  21: 'h:mm:ss',
  22: 'm/d/yy h:mm',
  37: '#,##0 ;(#,##0)',
  38: '#,##0 ;[Red](#,##0)',
  39: '#,##0.00;(#,##0.00)',
  40: '#,##0.00;[Red](#,##0.00)',
  45: 'mm:ss',
  46: '[h]:mm:ss',
  47: 'mmss.0',
  48: '##0.0E+0',
  49: '@',
};

/** Regional date formats (27-36, 50-58): no format written in file, replaced with year-month-day. */
export function builtinFormat(id: number): string | undefined {
  if (BUILTIN_NUMBER_FORMATS[id] !== undefined) return BUILTIN_NUMBER_FORMATS[id];
  if ((id >= 27 && id <= 36) || (id >= 50 && id <= 58)) return 'yyyy-mm-dd';
  return undefined;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Strip quoted text, backslash-escaped characters, and [color] tags to inspect the format itself (used for date detection). */
const bare = (code: string) =>
  code
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/\[(?:h+|m+|s+)\]/gi, 'h')
    .replace(/\[[^\]]*\]/g, '');

/** This format is a date or time. */
export function isDateFormat(code: string): boolean {
  const b = bare(code.split(';')[0] ?? '');
  return /[dyhs]/i.test(b) || (/m/i.test(b) && !/[0#?]/.test(b));
}

/** Serial number -> year-month-day hour-minute-second (the 1900 system has a bug for 1900-02-29; the 1904 system starts from 1904-01-01). */
function serialToParts(serial: number, date1904: boolean) {
  const days = Math.floor(serial);
  let ms: number;
  if (date1904) ms = Date.UTC(1904, 0, 1) + days * 86400000;
  else if (days >= 61) ms = Date.UTC(1899, 11, 30) + days * 86400000;
  else if (days === 60) return { y: 1900, mo: 2, d: 29, wd: 3, ...timeOf(serial) };
  else ms = Date.UTC(1899, 11, 31) + days * 86400000;
  const date = new Date(ms);
  return {
    y: date.getUTCFullYear(),
    mo: date.getUTCMonth() + 1,
    d: date.getUTCDate(),
    wd: date.getUTCDay(),
    ...timeOf(serial),
  };
}

function timeOf(serial: number) {
  let secs = Math.round((serial - Math.floor(serial)) * 86400);
  if (secs >= 86400) secs = 86399;
  return {
    h: Math.floor(secs / 3600),
    mi: Math.floor((secs % 3600) / 60),
    s: secs % 60,
    total: serial,
  };
}

const pad = (n: number, w: number) => String(n).padStart(w, '0');

function formatDate(serial: number, code: string, date1904: boolean): string {
  const t = serialToParts(serial, date1904);
  const ampm = /AM\/PM|A\/P/i.test(code);
  const tokens: { kind: 'lit' | 'tok'; v: string }[] = [];
  for (let i = 0; i < code.length;) {
    const c = code[i]!;
    if (c === '"') {
      const end = code.indexOf('"', i + 1);
      tokens.push({ kind: 'lit', v: code.slice(i + 1, end < 0 ? code.length : end) });
      i = end < 0 ? code.length : end + 1;
      continue;
    }
    if (c === '\\') {
      tokens.push({ kind: 'lit', v: code[i + 1] ?? '' });
      i += 2;
      continue;
    }
    if (c === '[') {
      const end = code.indexOf(']', i);
      const inner = code.slice(i + 1, end < 0 ? code.length : end);
      // [h], [mm], [ss]: accumulated hours, minutes, and seconds.
      if (/^(h+|m+|s+)$/i.test(inner)) tokens.push({ kind: 'tok', v: `[${inner.toLowerCase()}]` });
      i = end < 0 ? code.length : end + 1;
      continue;
    }
    if (c === '_' || c === '*') {
      if (c === '_') tokens.push({ kind: 'lit', v: ' ' });
      i += 2;
      continue;
    }
    const am = /^(AM\/PM|A\/P)/i.exec(code.slice(i));
    if (am) {
      tokens.push({ kind: 'tok', v: 'ampm' });
      i += am[0].length;
      continue;
    }
    const run = /^(y+|m+|d+|h+|s+)/i.exec(code.slice(i));
    if (run) {
      tokens.push({ kind: 'tok', v: run[0].toLowerCase() });
      i += run[0].length;
      continue;
    }
    if (c === '.' && /^\.0+/.test(code.slice(i))) {
      const frac = /^\.0+/.exec(code.slice(i))![0];
      tokens.push({ kind: 'lit', v: '' });
      i += frac.length;
      continue;
    }
    tokens.push({ kind: 'lit', v: c });
    i++;
  }
  // m / mm following hours or preceding seconds represents minutes.
  const toks = tokens.map((x, i) => ({ ...x, i }));
  const real = toks.filter((x) => x.kind === 'tok');
  const minute = new Set<number>();
  real.forEach((x, k) => {
    if (!/^m{1,2}$/.test(x.v)) return;
    const before = real[k - 1]?.v ?? '';
    const after = real[k + 1]?.v ?? '';
    if (/^h|^\[h/.test(before) || /^s|^\[s/.test(after)) minute.add(x.i);
  });
  const hour12 = (h: number) => (h % 12 === 0 ? 12 : h % 12);
  return toks
    .map((x) => {
      if (x.kind === 'lit') return x.v;
      const v = x.v;
      if (v.startsWith('y')) return v.length <= 2 ? pad(t.y % 100, 2) : String(t.y);
      if (v.startsWith('m') && minute.has(x.i)) return v.length === 1 ? String(t.mi) : pad(t.mi, 2);
      if (v.startsWith('m')) {
        if (v.length === 1) return String(t.mo);
        if (v.length === 2) return pad(t.mo, 2);
        if (v.length === 3) return MONTHS[t.mo - 1]!.slice(0, 3);
        if (v.length === 5) return MONTHS[t.mo - 1]![0]!;
        return MONTHS[t.mo - 1]!;
      }
      if (v.startsWith('d')) {
        if (v.length === 1) return String(t.d);
        if (v.length === 2) return pad(t.d, 2);
        if (v.length === 3) return DAYS[t.wd]!.slice(0, 3);
        return DAYS[t.wd]!;
      }
      if (v.startsWith('h')) {
        const h = ampm ? hour12(t.h) : t.h;
        return v.length === 1 ? String(h) : pad(h, 2);
      }
      if (v.startsWith('s')) return v.length === 1 ? String(t.s) : pad(t.s, 2);
      if (v === 'ampm') return t.h < 12 ? 'AM' : 'PM';
      if (v.startsWith('[h')) return String(Math.floor(t.total * 24));
      if (v.startsWith('[m')) return String(Math.floor(t.total * 1440));
      if (v.startsWith('[s')) return String(Math.floor(t.total * 86400));
      return '';
    })
    .join('');
}

/** General: at most 11 significant digits; use scientific notation for very large or very small numbers (1.23457E+11). */
export function generalNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (value === 0) return '0';
  const abs = Math.abs(value);
  if (abs >= 1e11 || abs < 1e-9) {
    const [m, e] = value.toExponential(5).split('e');
    const mant = String(Number(m));
    const exp = Number(e);
    return `${mant}E${exp < 0 ? '-' : '+'}${pad(Math.abs(exp), 2)}`;
  }
  return String(Number(value.toPrecision(11)));
}

const group = (int: string) => int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** Characters before and after the number in a format section (quoted text, escaped characters, currency symbols) and the number formatting itself. */
function formatPlain(value: number, section: string): string {
  let prefix = '';
  let suffix = '';
  let pattern = '';
  let seenDigits = false;
  for (let i = 0; i < section.length;) {
    const c = section[i]!;
    let lit: string | null = null;
    if (c === '"') {
      const end = section.indexOf('"', i + 1);
      lit = section.slice(i + 1, end < 0 ? section.length : end);
      i = end < 0 ? section.length : end + 1;
    } else if (c === '\\') {
      lit = section[i + 1] ?? '';
      i += 2;
    } else if (c === '[') {
      const end = section.indexOf(']', i);
      const inner = section.slice(i + 1, end < 0 ? section.length : end);
      // [$€-40C]: currency symbol; [Red], [>100], etc. are not displayed.
      lit = inner.startsWith('$') ? inner.slice(1).split('-')[0]! : '';
      i = end < 0 ? section.length : end + 1;
    } else if (c === '_') {
      lit = ' ';
      i += 2;
    } else if (c === '*') {
      lit = '';
      i += 2;
    } else if (
      /[0#?.,%]/.test(c) ||
      ((c === 'E' || c === 'e') && /[+-]/.test(section[i + 1] ?? ''))
    ) {
      if (c === 'E' || c === 'e') {
        pattern += section.slice(i, i + 2);
        i += 2;
      } else {
        pattern += c;
        i++;
      }
      if (/[0#?]/.test(c)) seenDigits = true;
      // Percent sign acts both as a multiplier (multiplies by 100) and is displayed normally.
      if (c === '%') {
        if (seenDigits) suffix += '%';
        else prefix += '%';
      }
      continue;
    } else if (c === '@') {
      i++;
      continue;
    } else {
      lit = c;
      i++;
    }
    if (seenDigits) suffix += lit;
    else prefix += lit;
  }
  if (!/[0#?]/.test(pattern))
    return `${prefix}${generalNumber(value)}${suffix}`.trim() || generalNumber(value);
  const percent = (pattern.match(/%/g) ?? []).length;
  let v = value * 100 ** percent;
  const sci = /E[+-]/i.exec(pattern);
  const [intPart = '', fracPart = ''] = (sci ? pattern.slice(0, sci.index) : pattern)
    .replace(/%/g, '')
    .split('.');
  const decimals = (fracPart.match(/[0#?]/g) ?? []).length;
  if (sci) {
    const [m, e] = Math.abs(v).toExponential(decimals).split('e');
    const exp = Number(e);
    const digits = (pattern.slice(sci.index + 2).match(/0/g) ?? []).length || 1;
    return `${prefix}${v < 0 ? '-' : ''}${m}E${exp < 0 ? '-' : '+'}${pad(Math.abs(exp), digits)}${suffix}`;
  }
  // Trailing commas in the format: divide by 1000.
  const trailing = /,+$/.exec(intPart)?.[0].length ?? 0;
  v /= 1000 ** trailing;
  const thousands = /[0#?],[0#?]/.test(intPart);
  const minInt = (intPart.match(/0/g) ?? []).length;
  const fixed = Math.abs(v).toFixed(decimals);
  let [int = '0', frac = ''] = fixed.split('.');
  if (minInt === 0 && int === '0') int = '';
  int = int.padStart(minInt, '0');
  if (thousands) int = group(int);
  // The # portion in decimal places: omit trailing zeros.
  const optional = (fracPart.match(/[#?]/g) ?? []).length;
  if (optional && frac) {
    const keep = decimals - optional;
    while (frac.length > keep && frac.endsWith('0')) frac = frac.slice(0, -1);
  }
  const number = frac ? `${int || '0'}.${frac}` : int || '0';
  return `${prefix}${v < 0 && Number(fixed) !== 0 ? '-' : ''}${number}${suffix}`;
}

/** Format a number into a display string using a number format. */
export function formatNumber(value: number, code: string, date1904 = false): string {
  if (!code || /^general$/i.test(code.trim())) return generalNumber(value);
  const sections = code.split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  let section = sections[0]!;
  let v = value;
  if (value < 0 && sections.length >= 2 && sections[1]!.trim()) {
    section = sections[1]!;
    v = -value;
  } else if (value === 0 && sections.length >= 3 && sections[2]!.trim()) section = sections[2]!;
  // "General" written within a section ([Red]-General): keep surrounding text, format the number as general.
  if (/general/i.test(bare(section))) return formatPlain(v, section.replace(/general/i, ''));
  if (isDateFormat(section)) {
    // Negative or out-of-range dates are displayed as #### by Excel; formatted here as a general number.
    if (value < 0 || value > 2958465) return generalNumber(value);
    return formatDate(value, section, date1904);
  }
  // Fractions (# ?/?): formatted as general.
  if (/\?\/\?|#\/#|0\/0/.test(bare(section))) return generalNumber(value);
  return formatPlain(v, section);
}
