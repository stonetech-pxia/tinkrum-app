import type { Calendar } from './calendar';
import { RECORD_LIMITS, prepareRecordValues, type FieldIssue } from './data';
import { isValidDate, normalizeTime } from './field-values';
import { cleanTags, fieldDefinition } from './fields';
import type { Collection, Field } from './schema';
import { decodeUtf8 } from './tool-download';

// Importing rows from a spreadsheet file into an existing table (D-574, founder's decision on
// 2026-11-16 item 7): System layer, local-only. Read file (CSV here, xlsx in tool-office) -> map
// columns to fields by normalized name only -> user confirms mapping -> leniently parse each cell
// into what the field can accept, then run field's strict write (`prepareRecordValues`) -> write
// into a transaction after confirmation. Neither column names nor cell contents are sent to the AI
// or stored in config (Invariants 1, 2, 14).

/** A cell in a spreadsheet file: visible text; when Excel stores numbers, it includes the number, and date-formatted numbers are marked as date (serial numbers based on the 1900 date system). */
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
   * Maximum number of rows imported at once (excluding header and completely empty rows). A
   * single import is one transaction and one undo batch; reading, matching, and writing this many
   * rows in mobile memory is fast. Larger amounts can be imported in batches (each table also has
   * `RECORD_LIMITS.perCollection`).
   */
  maxRows: 2000,
  /** Maximum number of content-bearing cells read from xlsx (2,000 rows x 50 columns). */
  maxCells: 100_000,
  /** List the first few row numbers for each cause in the summary. */
  rowNumbersShown: 5,
} as const;

export type SpreadsheetError =
  /** Not xlsx or csv (e.g., old .xls, .numbers). */
  | 'unsupported'
  /** Extension is a spreadsheet, but content is not (e.g., renamed other files, corrupted files). */
  | 'notSpreadsheet'
  /** Text file but not UTF-8 and missing UTF-16 BOM. */
  | 'encoding'
  | 'tooLarge'
  | 'empty';

// ---- Read Text ----

const ZIP = [0x50, 0x4b, 0x03, 0x04];

/**
 * Spreadsheet text file bytes -> string: UTF-8 (with or without BOM), UTF-16 with BOM (LE / BE).
 * Other encodings (GBK, Latin-1, etc.) are not guessed and return encoding; files that are
 * actually zip archives or start with a NUL byte return notSpreadsheet.
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
 * CSV: Separators are comma, semicolon, or tab (the one appearing most often outside quotes in
 * the first line; defaults to comma on ties); cells enclosed in double quotes may contain
 * separators, newlines, and escaped double quotes. Line endings can be \\r\\n, \\n, or \\r.
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

// ---- Columns and Fields ----

/** Fields eligible for import: user-filled fields (calculated, file, schedule, and relation fields are excluded, D-574). */
export function importTargets(collection: Collection): Field[] {
  return collection.fields.filter(
    (f) =>
      !!fieldDefinition(f.type).write &&
      f.type !== 'file' &&
      f.type !== 'schedule' &&
      f.type !== 'link',
  );
}

/** Used for name comparison: full-width to half-width, strip leading/trailing whitespace, collapse middle whitespace to a single space, case-insensitive. */
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
 * Header -> field ID mapped for each column (null means skip): checks normalized name equality
 * only, does not guess approximate matches; assigns each field to the first column only.
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

// ---- Date ----

export type DateOrder = 'dmy' | 'mdy';

const NUMERIC_DATE = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[ T]+(.+))?$/;
const ISO_DATE = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T]+(.+))?$/;
const CJK_DATE = /^(\d{4})年(\d{1,2})月(\d{1,2})日(?:\s*(.+))?$/;

/**
 * Determines whether dates in this column are day-first or month-first: if any preceding segment
 * is greater than 12, it is day-first; if any succeeding segment is greater than 12, it is
 * month-first; if inconclusive (or both), decided is false and order defaults to day-first, which
 * the user can change on the mapping page.
 */
export function dateOrderOf(cells: readonly (SheetCell | undefined)[]): {
  order: DateOrder;
  decided: boolean;
  /** Whether both interpretations of a date are plausible (in which case the user is prompted to choose on the mapping page). */
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

/** Excel serial number (1900 date system) -> local date and time; values before 1900-03-01 (due to the 1-day Excel leap year bug) are rejected. */
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

/** Date text -> YYYY-MM-DD and trailing time text; returns null if unrecognized. Years must be 4 digits (two-digit years are not guessed). */
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

// ---- Numbers ----

/**
 * Number text in spreadsheets: may include currency symbols or currency codes, thousand
 * separators (comma, dot, space, apostrophe), and negative signs. When only one separator type
 * exists: commas followed by groups of exactly three digits are thousand separators, otherwise
 * decimals; dots preceded by two or more groups of three digits are thousand separators,
 * otherwise decimals.
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
    // Both exist: the later one is the decimal separator, and the preceding ones are thousand separators which must be grouped in threes.
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

/** Separators between multiple tags or options in a cell: commas, ideographic commas, semicolons (English and Chinese). */
const TAG_SEPARATORS = /[,，、;；]/;

const TRUE_WORDS = new Set(['yes', 'y', 'true', '1', '✓', '✔', '√', '是', '对', 'oui', 'vrai']);
const FALSE_WORDS = new Set(['no', 'n', 'false', '0', '否', '不是', '错', 'non', 'faux']);

/**
 * Cell -> value acceptable to the field (subject to strict validation by the field's own write
 * method); empty cells are undefined (omitted, uses default value), unrecognized values are
 * invalid.
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
      // Excel durations are days with time formatting.
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
      const optionOf = (part: string) =>
        field.options.find((o) => normalizeName(o.label) === normalizeName(part)) ??
        field.options.find((o) => o.id === part);
      const option = optionOf(text);
      if (option) return { value: field.multiple ? [option.id] : option.id };
      if (!field.multiple) return bad;
      // Multi-select (D-607): option names separated by commas, ideographic commas, or semicolons (same as tags, also export format); if any option is unrecognized, the entire cell is skipped.
      const parts = text
        .split(TAG_SEPARATORS)
        .map((p) => p.trim())
        .filter(Boolean);
      const ids = parts.map((p) => optionOf(p)?.id);
      return parts.length > 0 && ids.every((id) => id !== undefined) ? { value: ids } : bad;
    }
    case 'tags':
      return { value: cleanTags(text.split(TAG_SEPARATORS)) };
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
        // Time-only cells (less than one day).
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

// ---- Single Import ----

export interface ImportSettings {
  /** First row is the header (default). */
  header: boolean;
  /** Field ID mapped to each column, null means skip. */
  mapping: readonly (string | null)[];
  /** Date order for each column (applicable only to columns mapped to date fields). */
  orders: readonly DateOrder[];
}

export interface SkippedGroup {
  code: FieldIssue['code'];
  fieldId: string;
  /** Total row count. */
  count: number;
  /** First few row numbers (file row numbers starting from 1, including the header row). */
  rows: number[];
  /** Min / max limits when out of range. */
  limit?: number;
}

export interface ImportPlan {
  /** Importable entries: field values for each record (already processed by field write) and its file row number. */
  entries: { row: number; values: Record<string, unknown> }[];
  /** Unimported items, grouped by reason (which field, what issue) in order of appearance. */
  skipped: SkippedGroup[];
  /** Total data rows excluding completely empty rows. */
  rows: number;
}

const blankRow = (row: readonly SheetCell[]) =>
  row.every((c) => c.text.trim() === '' && c.number === undefined);

/** Data rows (excluding header) and their file row numbers, ignoring completely empty rows. */
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

/** Headers (empty string if no header); column count based on the widest row. */
export function sheetColumns(rows: readonly SheetCell[][], header: boolean): string[] {
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  return Array.from({ length: width }, (_, i) => (header ? (rows[0]?.[i]?.text.trim() ?? '') : ''));
}

/** Transform each row into record values according to the mapping; if any cell fails to write, skip the row and record the reason. */
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
 * Import feasibility: reject import if data rows exceed IMPORT_LIMITS.maxRows, or if importing
 * causes the table to exceed RECORD_LIMITS.perCollection; does not perform partial imports (the
 * user sees the reason and can import separately or delete items first).
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
