import {
  formatTimestamp,
  formatValue,
  recordValue,
  type DataRecord,
  type LinkResolver,
} from './data';
import { fieldDefinition, type Collection, type Field, type Locale } from './schema';
import { t } from './messages';

// Record -> spreadsheet cell (D-427, records.toExcel): columns match CSV (fields + creation time). Writing xlsx is handled in tool-office.

export type SheetValue =
  | { kind: 'text'; text: string }
  /** True number or date (Excel dates are numbers with date formatting); text is used for estimating column width and row height. */
  | { kind: 'number'; value: number; format: string; text: string };

const MONEY_FORMAT = '#,##0.00';
const DATE_FORMAT = 'yyyy-mm-dd';
const DATE_TIME_FORMAT = 'yyyy-mm-dd hh:mm';

/** Before 1900-03-01, Excel serial numbers differ from true dates by one day; such dates are written as text. */
const FIRST_SERIAL_DAY = Date.UTC(1900, 2, 1);
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
const DAY_MS = 86_400_000;

/** Date components -> Excel serial number; returns null if not a valid date (e.g., February 31). */
function serial(y: number, mo: number, d: number, h = 0, mi = 0): number | null {
  const day = Date.UTC(y, mo - 1, d);
  const check = new Date(day);
  if (y < 1000 || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  if (h > 23 || mi > 59 || day < FIRST_SERIAL_DAY) return null;
  return (day - EXCEL_EPOCH) / DAY_MS + (h * 60 + mi) / 1440;
}

function dateCell(raw: unknown, text: string): SheetValue {
  const m =
    typeof raw === 'string' ? /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(raw) : null;
  if (!m) return { kind: 'text', text };
  const timed = m[4] !== undefined;
  const value = serial(+m[1]!, +m[2]!, +m[3]!, +(m[4] ?? 0), +(m[5] ?? 0));
  return value === null
    ? { kind: 'text', text }
    : { kind: 'number', value, format: timed ? DATE_TIME_FORMAT : DATE_FORMAT, text };
}

/** Duration displayed as "1 hour 30 min": raw numbers (minutes) are hard to understand, so they are kept as text. */
const isPlainNumber = (f: Field) =>
  fieldDefinition(f.type).numeric === true && f.type !== 'duration';

function cellOf(
  f: Field,
  record: DataRecord,
  collection: Collection,
  locale: Locale,
  links?: LinkResolver,
): SheetValue {
  const v = recordValue(record, collection, f.id);
  if (v === undefined) return { kind: 'text', text: '' };
  const csv = fieldDefinition(f.type).csv;
  const text = csv ? csv(f, v) : formatValue(f, v, locale, links);
  if (isPlainNumber(f) && typeof v === 'number' && Number.isFinite(v))
    return {
      kind: 'number',
      value: v,
      format: f.type === 'money' ? MONEY_FORMAT : 'General',
      text,
    };
  if (f.type === 'date' || f.type === 'datetime') return dateCell(v, text);
  return { kind: 'text', text };
}

/** First row contains field names; identical to older version when options are omitted. */
export function recordsToSheet(
  collection: Collection,
  records: readonly DataRecord[],
  locale: Locale,
  links?: LinkResolver,
  options: { fields?: readonly string[] } = {},
): SheetValue[][] {
  const head = (text: string): SheetValue => ({ kind: 'text', text });
  const ids = options.fields?.length
    ? options.fields
    : [...collection.fields.map((f) => f.id), 'createdAt'];
  const fields = ids.map((id) => collection.fields.find((f) => f.id === id));
  const header = ids.map((id, i) => {
    const f = fields[i];
    if (!f && id !== 'createdAt' && id !== 'updatedAt')
      throw new Error(`Unknown export field: ${id}`);
    return head(
      f
        ? f.type === 'money' && !f.currencyField
          ? `${f.name} (${f.currency})`
          : f.name
        : t(locale, id === 'updatedAt' ? 'html_Updated_74f0c' : 'data_Created_1626a'),
    );
  });
  const rows = records.map((r) =>
    ids.map((id, i): SheetValue => {
      const f = fields[i];
      if (f) return cellOf(f, r, collection, locale, links);
      const stamp = id === 'updatedAt' ? r.updatedAt : r.createdAt;
      const at = new Date(stamp);
      const value = serial(
        at.getFullYear(),
        at.getMonth() + 1,
        at.getDate(),
        at.getHours(),
        at.getMinutes(),
      );
      const text = formatTimestamp(stamp, locale);
      return value === null
        ? head(text)
        : { kind: 'number', value, format: DATE_TIME_FORMAT, text };
    }),
  );
  return [header, ...rows];
}
