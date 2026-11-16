import type { Calendar } from './calendar';
import { RECORD_LIMITS, prepareRecordValues, type FieldIssue } from './data';
import { isValidDate, normalizeTime } from './field-values';
import { cleanTags, fieldDefinition } from './fields';
import type { Collection, Field } from './schema';
import { decodeUtf8 } from './tool-download';

// 表格文件的行导进一张已有的表（D-574，创始人 2026-11-16 决定 ⑦）：系统层，只在本机。
// 读文件（CSV 在这里，xlsx 在 tool-office）→ 按列名对到字段（只比规范化后的名字是否相同）→ 用户确认对应 →
// 每格先宽容地读成字段能收的样子，再交给字段自己严格的 write（prepareRecordValues）→ 确认后一个事务写进去。
// 列名、格子的内容都不发给 AI、不进配置（底线 1、2、14）。

/** 表格文件里的一格：看到的字；Excel 存的是数字时带着数字，日期格式的数字标上 date（序号按 1900 年制）。 */
export interface SheetCell {
  text: string;
  number?: number;
  date?: boolean;
}

export interface SheetRows {
  name: string;
  rows: SheetCell[][];
}

export const IMPORT_LIMITS = {
  /**
   * 一次最多导入这么多行（不算表头和全空的行）。一次导入是一个事务、一批撤销，这么多行在手机内存里读、对、
   * 写都不慢；再多的分几次导（每张表还有 RECORD_LIMITS.perCollection）。
   */
  maxRows: 2000,
  /** xlsx 最多读这么多个有内容的格子（2,000 行 × 50 列）。 */
  maxCells: 100_000,
  /** 汇总里每种原因列出前几个行号。 */
  rowNumbersShown: 5,
} as const;

export type SpreadsheetError =
  /** 不是 xlsx / csv（例如老的 .xls、.numbers）。 */
  | 'unsupported'
  /** 扩展名是表格，内容不是（改了扩展名的别的文件、坏了）。 */
  | 'notSpreadsheet'
  /** 文字文件但不是 UTF-8、也没有 UTF-16 的 BOM。 */
  | 'encoding'
  | 'tooLarge'
  | 'empty';

// ---- 读文字 ----

const ZIP = [0x50, 0x4b, 0x03, 0x04];

/**
 * 表格文字文件的字节 → 字符串：UTF-8（有没有 BOM 都行）、带 BOM 的 UTF-16（LE / BE）。别的编码（GBK、Latin-1……）
 * 不猜，返回 encoding；其实是 zip、或者开头有 NUL 字节的是别的文件，返回 notSpreadsheet。
 */
export function decodeSheetText(
  bytes: Uint8Array,
): { ok: true; text: string } | { ok: false; error: SpreadsheetError } {
  const b = bytes;
  if (b[0] === 0xff && b[1] === 0xfe) return { ok: true, text: decodeUtf16(b.subarray(2), true) };
  if (b[0] === 0xfe && b[1] === 0xff) return { ok: true, text: decodeUtf16(b.subarray(2), false) };
  if (ZIP.every((x, i) => b[i] === x)) return { ok: false, error: 'notSpreadsheet' };
  const start = b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? 3 : 0;
  if (b.subarray(start, start + 4096).includes(0)) return { ok: false, error: 'notSpreadsheet' };
  try {
    return { ok: true, text: decodeUtf8(b.subarray(start)) };
  } catch {
    return { ok: false, error: 'encoding' };
  }
}

function decodeUtf16(bytes: Uint8Array, little: boolean): string {
  const parts: string[] = [];
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const unit = little ? bytes[i]! | (bytes[i + 1]! << 8) : (bytes[i]! << 8) | bytes[i + 1]!;
    parts.push(String.fromCharCode(unit));
  }
  return parts.join('');
}

/**
 * CSV：分隔符是逗号、分号或制表符（第一行里引号外出现最多的那个，一样多时用逗号）；双引号括起来的格子里可以有
 * 分隔符、换行和写成两个的双引号。行尾的 \r\n、\n、\r 都行。
 */
export function parseCsv(text: string): SheetCell[][] {
  const delimiter = csvDelimiter(text);
  const rows: SheetCell[][] = [];
  let row: SheetCell[] = [];
  let cell = '';
  let quoted = false;
  let i = 0;
  const endCell = () => {
    row.push({ text: cell });
    cell = '';
  };
  const endRow = () => {
    endCell();
    rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else cell += ch;
      i++;
      continue;
    }
    if (ch === '"' && cell === '') quoted = true;
    else if (ch === delimiter) endCell();
    else if (ch === '\r' || ch === '\n') {
      endRow();
      if (ch === '\r' && text[i + 1] === '\n') i++;
    } else cell += ch;
    i++;
  }
  if (cell !== '' || row.length > 0) endRow();
  return rows;
}

function csvDelimiter(text: string): string {
  const counts = new Map<string, number>([
    [',', 0],
    [';', 0],
    ['\t', 0],
  ]);
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\n' || ch === '\r')) break;
    else if (!quoted && counts.has(ch)) counts.set(ch, counts.get(ch)! + 1);
  }
  let best = ',';
  for (const [d, n] of counts) if (n > counts.get(best)!) best = d;
  return best;
}

// ---- 列和字段 ----

/** 能导进去的字段：用户填的（算出来的、文件、日程、引用都不行，D-574）。 */
export function importTargets(collection: Collection): Field[] {
  return collection.fields.filter(
    (f) =>
      !!fieldDefinition(f.type).write &&
      f.type !== 'file' &&
      f.type !== 'schedule' &&
      f.type !== 'link',
  );
}

/** 比名字用：全角变半角、去掉两头的空白、中间的空白算一个、不分大小写。 */
export function normalizeName(s: string): string {
  return halfWidth(s).trim().replace(/\s+/g, ' ').toLowerCase();
}

function halfWidth(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (c >= 0xff01 && c <= 0xff5e) out += String.fromCharCode(c - 0xfee0);
    else if (c === 0x3000) out += ' ';
    else out += ch;
  }
  return out;
}

/**
 * 表头 → 每列对到的字段 ID（null 是跳过）：只看规范化后的名字是否相同，不猜近似的；同一个字段只给第一列。
 */
export function proposeMapping(
  header: readonly string[],
  collection: Collection,
): (string | null)[] {
  const targets = importTargets(collection);
  const used = new Set<string>();
  return header.map((name) => {
    const key = normalizeName(name);
    const field = key ? targets.find((f) => normalizeName(f.name) === key) : undefined;
    if (!field || used.has(field.id)) return null;
    used.add(field.id);
    return field.id;
  });
}

// ---- 日期 ----

export type DateOrder = 'dmy' | 'mdy';

const NUMERIC_DATE = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[ T]+(.+))?$/;
const ISO_DATE = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T]+(.+))?$/;
const CJK_DATE = /^(\d{4})年(\d{1,2})月(\d{1,2})日(?:\s*(.+))?$/;

/**
 * 这一列的日期是日在前还是月在前：有一个前一段大于 12 的就是日在前，有一个后一段大于 12 的就是月在前；
 * 都看不出（或者两种都有）时 decided 为 false，order 默认日在前，用户在对应页上能换。
 */
export function dateOrderOf(cells: readonly (SheetCell | undefined)[]): {
  order: DateOrder;
  decided: boolean;
  /** 有没有两种读法都说得通的日期（这时对应页上让用户选）。 */
  ambiguous: boolean;
} {
  let dmy = false;
  let mdy = false;
  let ambiguous = false;
  for (const cell of cells) {
    if (!cell || cell.number !== undefined) continue;
    const m = NUMERIC_DATE.exec(cell.text.trim());
    if (!m) continue;
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a > 12 && b <= 12) dmy = true;
    else if (b > 12 && a <= 12) mdy = true;
    else if (a !== b) ambiguous = true;
  }
  if (dmy !== mdy) return { order: dmy ? 'dmy' : 'mdy', decided: true, ambiguous: false };
  return { order: 'dmy', decided: false, ambiguous: ambiguous || (dmy && mdy) };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Excel 的序号（1900 年制）→ 本地日期和时间；1900-03-01 之前（序号有一天的错）不认。 */
function serialParts(serial: number): { date: string; time: string } | null {
  if (!Number.isFinite(serial) || serial < 61 || serial > 2958465) return null;
  let minutes = Math.round(serial * 1440);
  const days = Math.floor(minutes / 1440);
  minutes -= days * 1440;
  const d = new Date(Date.UTC(1899, 11, 30) + days * 86_400_000);
  return {
    date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    time: `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`,
  };
}

/** 日期文字 → YYYY-MM-DD 和后面的时间文字；认不出时 null。年份只认四位数（两位数的年份不猜世纪）。 */
function textDate(text: string, order: DateOrder): { date: string; rest?: string } | null {
  const s = halfWidth(text).trim();
  let y: number, mo: number, d: number, rest: string | undefined;
  const iso = ISO_DATE.exec(s) ?? CJK_DATE.exec(s);
  const num = iso ? null : NUMERIC_DATE.exec(s);
  if (iso) [y, mo, d, rest] = [Number(iso[1]), Number(iso[2]), Number(iso[3]), iso[4]];
  else if (num) {
    const a = Number(num[1]);
    const b = Number(num[2]);
    [d, mo] = order === 'dmy' ? [a, b] : [b, a];
    y = Number(num[3]);
    rest = num[4];
  } else return null;
  const date = `${y}-${pad(mo)}-${pad(d)}`;
  return isValidDate(date) ? { date, ...(rest !== undefined ? { rest } : {}) } : null;
}

// ---- 数字 ----

/**
 * 表格里的数字文字：可以有货币符号或货币代码、千位分隔（逗号、点、空格、撇号）、负号。只有一种分隔符时：
 * 逗号后面正好三位一组的算千位，否则算小数点；点后面有两组以上三位的算千位，否则算小数点。
 */
export function readNumberText(text: string): number | undefined {
  let s = halfWidth(text)
    .trim()
    .replace(/^[A-Z]{3}\s*|\s*[A-Z]{3}$/g, '')
    .replace(/[$€£¥₹₩₽₺₫฿]/g, '')
    .replace(/[\s  ']/g, '');
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith('-') || s.startsWith('−')) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith('+')) s = s.slice(1);
  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return undefined;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  let normal: string;
  if (lastComma >= 0 && lastDot >= 0) {
    // 两种都有：后出现的是小数点，前面的是千位分隔，要三位一组。
    const at = Math.max(lastComma, lastDot);
    const group = lastComma > lastDot ? '.' : ',';
    const int = s.slice(0, at);
    const frac = s.slice(at + 1);
    const grouped = group === ',' ? /^\d{1,3}(,\d{3})*$/ : /^\d{1,3}(\.\d{3})*$/;
    if (!grouped.test(int) || !/^\d+$/.test(frac)) return undefined;
    normal = `${int.split(group).join('')}.${frac}`;
  } else if (lastComma >= 0) {
    normal = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  } else if (lastDot >= 0) {
    normal = /^\d{1,3}(\.\d{3}){2,}$/.test(s) ? s.replace(/\./g, '') : s;
  } else normal = s;
  if (!/^\d+(\.\d+)?$/.test(normal)) return undefined;
  const n = Number(normal);
  return Number.isFinite(n) ? (negative ? -n : n) : undefined;
}

const TRUE_WORDS = new Set(['yes', 'y', 'true', '1', '✓', '✔', '√', '是', '对', 'oui', 'vrai']);
const FALSE_WORDS = new Set(['no', 'n', 'false', '0', '否', '不是', '错', 'non', 'faux']);

/**
 * 一格 → 字段能收的值（交给字段自己的 write 再严格检查一遍）；空格子是 undefined（不写，用默认值），
 * 认不出的是 invalid。
 */
export function readCellFor(
  field: Field,
  cell: SheetCell | undefined,
  order: DateOrder,
): { value: unknown } | { invalid: true } | undefined {
  if (!cell) return undefined;
  const text = cell.text.trim();
  if (text === '' && cell.number === undefined) return undefined;
  const num = cell.number;
  const bad = { invalid: true } as const;
  switch (field.type) {
    case 'text':
    case 'note':
      return { value: cell.text };
    case 'number':
    case 'money':
    case 'rating': {
      if (num !== undefined && !cell.date) return { value: num };
      const n = readNumberText(text);
      return n === undefined ? bad : { value: n };
    }
    case 'duration':
      // Excel 的时长是带时间格式的天数。
      if (num !== undefined) return { value: cell.date ? Math.round(num * 1440) : num };
      return { value: text };
    case 'checkbox': {
      if (num !== undefined && !cell.date && (num === 0 || num === 1)) return { value: num === 1 };
      const key = normalizeName(text);
      if (TRUE_WORDS.has(key)) return { value: true };
      if (FALSE_WORDS.has(key)) return { value: false };
      return bad;
    }
    case 'choice': {
      const key = normalizeName(text);
      const option =
        field.options.find((o) => normalizeName(o.label) === key) ??
        field.options.find((o) => o.id === text);
      return option ? { value: option.id } : bad;
    }
    case 'tags':
      return { value: cleanTags(text.split(/[,，、;；]/)) };
    case 'date':
    case 'datetime': {
      if (num !== undefined) {
        const parts = cell.date ? serialParts(num) : null;
        if (!parts) return bad;
        return { value: field.type === 'date' ? parts.date : `${parts.date} ${parts.time}` };
      }
      const found = textDate(text, order);
      if (!found) return bad;
      if (field.type === 'date') return found.rest === undefined ? { value: found.date } : bad;
      const time = found.rest === undefined ? '00:00' : normalizeTime(found.rest);
      return time ? { value: `${found.date} ${time}` } : bad;
    }
    case 'time': {
      if (num !== undefined) {
        // 只有时间的格子（小于一天）。
        if (!cell.date || num < 0 || num >= 1) return bad;
        const minutes = Math.round(num * 1440) % 1440;
        return { value: `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}` };
      }
      return { value: text };
    }
    default:
      return bad;
  }
}

// ---- 一次导入 ----

export interface ImportSettings {
  /** 第一行是表头（默认）。 */
  header: boolean;
  /** 每列对到的字段 ID，null 是跳过。 */
  mapping: readonly (string | null)[];
  /** 每列的日期顺序（只有对到日期字段的列用得到）。 */
  orders: readonly DateOrder[];
}

export interface SkippedGroup {
  code: FieldIssue['code'];
  fieldId: string;
  /** 一共几行。 */
  count: number;
  /** 前几个行号（文件里的行号，从 1 起，表头那行也算）。 */
  rows: number[];
  /** 超出范围时的 min / max。 */
  limit?: number;
}

export interface ImportPlan {
  /** 能导进去的：每条记录的值（已经过字段的 write）和它在文件里的行号。 */
  entries: { row: number; values: Record<string, unknown> }[];
  /** 导不进去的，按原因（哪个字段、什么问题）分组，按出现的先后。 */
  skipped: SkippedGroup[];
  /** 不算全空的行，一共几行数据。 */
  rows: number;
}

const blankRow = (row: readonly SheetCell[]) =>
  row.every((c) => c.text.trim() === '' && c.number === undefined);

/** 数据行（去掉表头）和它们在文件里的行号，全空的行不算。 */
export function dataRows(
  rows: readonly SheetCell[][],
  header: boolean,
): { row: number; cells: SheetCell[] }[] {
  const out: { row: number; cells: SheetCell[] }[] = [];
  rows.forEach((cells, i) => {
    if ((header && i === 0) || blankRow(cells)) return;
    out.push({ row: i + 1, cells });
  });
  return out;
}

/** 表头（没有表头时是空的名字）；列数按最宽的一行。 */
export function sheetColumns(rows: readonly SheetCell[][], header: boolean): string[] {
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  return Array.from({ length: width }, (_, i) => (header ? (rows[0]?.[i]?.text.trim() ?? '') : ''));
}

/** 按对应把每一行变成一条记录的值；一格写不进去，这一行就不导，记下原因。 */
export function planImport(
  collection: Collection,
  rows: readonly SheetCell[][],
  settings: ImportSettings,
  now: Date,
  cal?: Calendar,
): ImportPlan {
  const fields = new Map(collection.fields.map((f) => [f.id, f]));
  const groups = new Map<string, SkippedGroup>();
  const entries: ImportPlan['entries'] = [];
  const data = dataRows(rows, settings.header);
  const skip = (row: number, issue: FieldIssue) => {
    const key = `${issue.code}|${issue.fieldId}`;
    let g = groups.get(key);
    if (!g) {
      g = { code: issue.code, fieldId: issue.fieldId, count: 0, rows: [] };
      if (issue.limit !== undefined) g.limit = issue.limit;
      groups.set(key, g);
    }
    g.count++;
    if (g.rows.length < IMPORT_LIMITS.rowNumbersShown) g.rows.push(row);
  };
  for (const { row, cells } of data) {
    const input: Record<string, unknown> = {};
    let failed: FieldIssue | undefined;
    settings.mapping.forEach((fieldId, col) => {
      const field = fieldId ? fields.get(fieldId) : undefined;
      if (!field || failed) return;
      const read = readCellFor(field, cells[col], settings.orders[col] ?? 'dmy');
      if (read === undefined) return;
      if ('invalid' in read) failed = { fieldId: field.id, code: 'invalid' };
      else input[field.id] = read.value;
    });
    if (failed) {
      skip(row, failed);
      continue;
    }
    const prepared = prepareRecordValues(collection, input, null, now, cal);
    if (prepared.ok) entries.push({ row, values: prepared.values });
    else skip(row, prepared.issues[0]!);
  }
  return { entries, skipped: [...groups.values()], rows: data.length };
}

/**
 * 能不能导：数据行超过 IMPORT_LIMITS.maxRows、或者导进去以后这张表超过 RECORD_LIMITS.perCollection 时不导，
 * 也不导一部分（用户看到原因，分开导或先删一些）。
 */
export function importLimitProblem(
  rows: number,
  entries: number,
  existing: number,
): { code: 'tooManyRows'; max: number } | { code: 'tableFull'; room: number } | null {
  if (rows > IMPORT_LIMITS.maxRows) return { code: 'tooManyRows', max: IMPORT_LIMITS.maxRows };
  if (existing + entries > RECORD_LIMITS.perCollection)
    return { code: 'tableFull', room: Math.max(0, RECORD_LIMITS.perCollection - existing) };
  return null;
}
