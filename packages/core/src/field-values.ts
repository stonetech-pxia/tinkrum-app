import { localeTag } from './localization';
import type { ScheduleRule } from './schedule';
import type { Locale } from './schema-primitives';

// Basic writing style and display format of field values. Used by both field definitions (fields/)
// and record pure functions (data.ts); kept in a separate file to avoid mutual references between
// field definitions and data.ts. Exported externally from data.ts.

/** Attachment field values (D-187, D-263) are a set of file IDs; schedule values (D-292) are a rule; other fields are text, numbers, or checkboxes. */
export type FieldValue = string | number | boolean | readonly string[] | ScheduleRule;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const pad = (n: number) => String(n).padStart(2, '0');

/** Device local date YYYY-MM-DD. */
export function localDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Device local date YYYYMMDD, shared for file names and guide version parameters. */
export const localDateStamp = (d: Date): string => localDate(d).replace(/-/g, '');

export function isValidDate(s: string): boolean {
  if (!DATE_PATTERN.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

/** Time HH:mm (00:00-23:59). */
export const isValidTime = (s: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

/** Filled time ('8:05', '08:05', '8：05', may include seconds) -> HH:mm; undefined when unrecognized. */
export function normalizeTime(input: string): string | undefined {
  const m = /^(\d{1,2})[:：](\d{2})(?:[:：]\d{2})?$/.exec(input.trim());
  const time = m ? `${pad(Number(m[1]))}:${m[2]}` : '';
  return isValidTime(time) ? time : undefined;
}

/** Device local datetime YYYY-MM-DDTHH:mm (D-279, without timezone). */
export const localDateTime = (d: Date) =>
  `${localDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

export const isValidDateTime = (s: string) =>
  s.length === 16 && s[10] === 'T' && isValidDate(s.slice(0, 10)) && isValidTime(s.slice(11));

/** Duration (minutes) -> h:mm ('1:30', '41:05'), rounded to the nearest minute (D-279). */
export function formatDuration(minutes: number): string {
  const total = Math.round(Math.abs(minutes));
  return `${minutes < 0 && total > 0 ? '-' : ''}${Math.floor(total / 60)}:${pad(total % 60)}`;
}

export const round = (n: number, decimals: number) => {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
};

/** Attachment value: file ID (same format as IDs in config). */
export const FILE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Maximum number of files allowed in an attachment field (D-263). */
export const MAX_ATTACHMENTS = 20;

/** Attachment field value (or form value) -> list of file IDs: a single ID in old data is treated as a set, other values as empty. */
export function attachmentIds(value: unknown): string[] {
  if (typeof value === 'string') return value ? [value] : [];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  CNY: '¥',
  JPY: '¥',
  USD: '$',
  EUR: '€',
  GBP: '£',
  HKD: 'HK$',
  TWD: 'NT$',
  KRW: '₩',
};

function groupThousands(n: number, decimals: number): string {
  const [int, frac] = Math.abs(n).toFixed(decimals).split('.') as [string, string | undefined];
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${n < 0 ? '-' : ''}${grouped}${frac ? `.${frac}` : ''}`;
}

export function formatMoney(n: number, currency: string, locale: Locale = 'en'): string {
  if (locale === 'fr')
    return new Intl.NumberFormat(localeTag(locale), { style: 'currency', currency }).format(n);
  const symbol = CURRENCY_SYMBOLS[currency];
  const amount = groupThousands(n, 2);
  return symbol
    ? `${n < 0 ? '-' : ''}${symbol}${amount.replace('-', '')}`
    : `${currency} ${amount}`;
}

export function formatNumber(n: number, decimals?: number, locale: Locale = 'en'): string {
  if (locale === 'fr')
    return new Intl.NumberFormat(localeTag(locale), {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals ?? 4,
    }).format(n);
  if (decimals !== undefined) return groupThousands(n, decimals);
  // Scientific notation may lack a decimal point, but is still displayed with up to four decimal places; the numerical value itself remains unchanged.
  return groupThousands(
    n,
    Number.isInteger(n) ? 0 : Math.min(4, String(n).split('.')[1]?.length ?? 4),
  );
}

/**
 * Title of the record pointed to by a reference field (D-250); null when that record has been
 * deleted (or the records for that table are not yet loaded). Provided by the App based on loaded
 * records (makeLinkResolver); reference fields appear empty when absent.
 */
export type LinkResolver = (collectionId: string, recordId: string) => string | null;

export function formatTimestamp(ms: number, locale: Locale = 'en'): string {
  const d = new Date(ms);
  if (locale === 'fr')
    return new Intl.DateTimeFormat(localeTag(locale), {
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(d);
  return `${localDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
