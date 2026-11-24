import { fieldLink, formatLink } from './field-link';
import type { TextFormat } from './fields/text';
import { conceptOf } from './prefill/concepts';
import { withDocKind } from './prefill/doc-context';
import type { Field } from './schema';

// Business card text formats (D-423): record → vCard 3.0; scanned vCard / MeCard / URL → field
// candidates. Pure function, local only. Name, title, company, address mapped by field semantics
// (conceptOf, shares dictionary with business card table); phone, email, URL mapped by format.
// Photos, notes, and groups are excluded; values mismatching formats are excluded (unclickable
// phones cannot be dialed), URLs restricted to http(s).

type Slot = 'name' | 'title' | 'company' | 'address' | TextFormat;

const SLOT_OF_CONCEPT: Readonly<Record<string, Slot>> = {
  name: 'name',
  jobTitle: 'title',
  company: 'company',
  address: 'address',
  phone: 'phone',
  email: 'email',
  website: 'url',
};

function slotOf(field: Field): Slot | null {
  if (field.type === 'text' && field.format) return field.format;
  if (field.type !== 'text' && field.type !== 'note') return null;
  // Position and URL concepts are only recognized under business card rules (D-421).
  const concept = withDocKind('card', () => conceptOf(field));
  return concept === null ? null : (SLOT_OF_CONCEPT[concept] ?? null);
}

// ---- Record → vCard ----

/** Normalize all newlines to \\n and strip other control characters. */
function tidy(value: string): string {
  return value
    .replace(/\r\n?|[\u2028\u2029]/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\p{Cc}/gu, ''))
    .join('\n')
    .trim();
}

/** RFC 2426 escaping. Newlines become literal \\n so that newlines in values cannot generate new lines (e.g., forged TEL attributes). */
const escapeValue = (value: string) =>
  value.replace(/\\/g, '\\\\').replace(/,/g, '\\,').replace(/;/g, '\\;').replace(/\n/g, '\\n');

const utf8Bytes = (ch: string) => {
  const cp = ch.codePointAt(0)!;
  return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
};

/** Lines do not exceed 75 bytes (RFC 2425), continuation lines start with a space; words are never split in half. */
function fold(line: string): string {
  const out: string[] = [];
  let current = '';
  let bytes = 0;
  for (const ch of line) {
    const n = utf8Bytes(ch);
    if (bytes + n > 75) {
      out.push(current);
      current = ' ';
      bytes = 1;
    }
    current += ch;
    bytes += n;
  }
  out.push(current);
  return out.join('\r\n');
}

/** N is required: when spaces exist, the last segment is the family name (Maria Garcia); without spaces (Chinese), the entire name is placed in the family name field. */
function structuredName(name: string): string {
  const parts = name.split(/\s+/);
  const family = parts.pop()!;
  return `${escapeValue(family)};${escapeValue(parts.join(' '))};;;`;
}

/**
 * vCard 3.0 for a single record (CRLF, UTF-8 text). Returns null if the table has no business
 * card content (name, company, phone, email, etc. are all empty). FN is required: falls back to
 * company, email, or phone if name is missing.
 */
export function recordToVCard(
  fields: readonly Field[],
  values: Readonly<Record<string, unknown>>,
): string | null {
  const one: Partial<Record<Slot, string>> = {};
  const many: Record<TextFormat, string[]> = { phone: [], email: [], url: [] };
  for (const field of fields) {
    const slot = slotOf(field);
    const raw = values[field.id];
    if (!slot || typeof raw !== 'string') continue;
    const value = tidy(raw);
    if (!value) continue;
    if (slot === 'phone' || slot === 'email' || slot === 'url') {
      const link = fieldLink(field, value);
      if (link) many[slot].push(slot === 'url' ? link.url : value);
    } else one[slot] ??= value;
  }
  const fn = one.name ?? one.company ?? many.email[0] ?? many.phone[0];
  if (fn === undefined && many.url.length === 0 && !one.title && !one.address) return null;
  const shown = fn ?? one.title ?? one.address ?? many.url[0]!;
  const lines = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `FN:${escapeValue(shown)}`,
    `N:${one.name ? structuredName(one.name) : ';;;;'}`,
    ...(one.company ? [`ORG:${escapeValue(one.company)}`] : []),
    ...(one.title ? [`TITLE:${escapeValue(one.title)}`] : []),
    ...many.phone.map((v) => `TEL:${escapeValue(v)}`),
    ...many.email.map((v) => `EMAIL:${escapeValue(v)}`),
    ...many.url.map((v) => `URL:${escapeValue(v)}`),
    ...(one.address ? [`ADR:;;${escapeValue(one.address)};;;;`] : []),
    'END:VCARD',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}

/** Combine multiple records into a single .vcf text string; empty if none of the records contain business card content. */
export function recordsToVCard(
  fields: readonly Field[],
  records: readonly { values: Readonly<Record<string, unknown>> }[],
): string {
  return records.flatMap((r) => recordToVCard(fields, r.values) ?? []).join('');
}

// ---- Scanned text → field candidates ----

export interface ContactCode {
  name?: string;
  title?: string;
  company?: string;
  address?: string;
  phones: string[];
  emails: string[];
  urls: string[];
}

/** Values exceeding field capacity (text fields max 200 chars) are discarded; limit the maximum number of values per type. */
const MAX_VALUE = 200;
const MAX_VALUES = 5;
/** QR codes are at most ~3 KB; anything larger is not a business card. */
const MAX_TEXT = 8000;

const oneLine = (value: string) => tidy(value).replace(/\s*\n\s*/g, ' ');

function addValue(list: string[], format: TextFormat, value: string): void {
  const v = oneLine(value);
  if (
    v.length <= MAX_VALUE &&
    list.length < MAX_VALUES &&
    !list.includes(v) &&
    formatLink(format, v)
  )
    list.push(v);
}

function setText(code: ContactCode, key: 'name' | 'title' | 'company', value: string): void {
  const v = oneLine(value);
  if (v && v.length <= MAX_VALUE) code[key] ??= v;
}

function setAddress(code: ContactCode, parts: readonly string[]): void {
  const v = parts.map(oneLine).filter(Boolean).join(', ');
  if (v && v.length <= MAX_VALUE) code.address ??= v;
}

const HAS_CJK = /[\u3400-\u9fff]/;

/** Concatenate family and given names: no spaces and family name first for Chinese, given name first for others. */
function fullName(family: string, given: string): string {
  return HAS_CJK.test(family + given)
    ? family + given
    : [given, family].filter((s) => s.trim()).join(' ');
}

/** Split by unescaped separator, removing escapes (\\n is a newline). */
function splitEscaped(raw: string, sep: string): string[] {
  const out: string[] = [];
  let current = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (c === '\\' && i + 1 < raw.length) {
      const next = raw[++i]!;
      current += next === 'n' || next === 'N' ? '\n' : next;
    } else if (c === sep) {
      out.push(current);
      current = '';
    } else current += c;
  }
  out.push(current);
  return out;
}

/** Colon separating parameters and value on this line (excluding those inside quotes). */
function valueColon(line: string): number {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    else if (line[i] === ':' && !quoted) return i;
  }
  return -1;
}

function parseVCard(text: string): ContactCode {
  const code: ContactCode = { phones: [], emails: [], urls: [] };
  let structured: string | undefined;
  const unfolded = text.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '');
  for (const line of unfolded.split('\n')) {
    if (/^END:VCARD/i.test(line)) break;
    const colon = valueColon(line);
    if (colon < 0) continue;
    const [property, ...params] = line.slice(0, colon).split(';');
    // Remove group prefixes (item1.TEL).
    const key = property!.replace(/^[^.]*\./, '').toUpperCase();
    // Ignore encoded values (vCard 2.1 QP, photo BASE64).
    if (/QUOTED-PRINTABLE|BASE64|ENCODING=B/i.test(params.join(';'))) continue;
    const raw = line.slice(colon + 1);
    const parts = splitEscaped(raw, ';');
    if (key === 'FN') setText(code, 'name', parts.join(';'));
    else if (key === 'N') structured = fullName(parts[0] ?? '', parts[1] ?? '');
    else if (key === 'ORG') setText(code, 'company', parts[0] ?? '');
    else if (key === 'TITLE') setText(code, 'title', parts.join(';'));
    else if (key === 'TEL') addValue(code.phones, 'phone', parts[0]!.replace(/^tel:/i, ''));
    else if (key === 'EMAIL') addValue(code.emails, 'email', parts[0]!);
    else if (key === 'URL') addValue(code.urls, 'url', parts.join(';'));
    else if (key === 'ADR') setAddress(code, parts);
  }
  if (structured) setText(code, 'name', structured);
  return code;
}

function parseMeCard(text: string): ContactCode {
  const code: ContactCode = { phones: [], emails: [], urls: [] };
  for (const part of splitRaw(text.replace(/^MECARD:/i, ''))) {
    const colon = part.indexOf(':');
    if (colon < 0) continue;
    const key = part.slice(0, colon).toUpperCase();
    const value = part.slice(colon + 1);
    const plain = splitEscaped(value, '\u0000')[0]!;
    if (key === 'N') {
      const [family, given] = splitEscaped(value, ',');
      setText(code, 'name', fullName(family ?? '', given ?? ''));
    } else if (key === 'ORG') setText(code, 'company', plain);
    else if (key === 'TITLE') setText(code, 'title', plain);
    else if (key === 'TEL') addValue(code.phones, 'phone', plain);
    else if (key === 'EMAIL') addValue(code.emails, 'email', plain);
    else if (key === 'URL') addValue(code.urls, 'url', plain);
    else if (key === 'ADR') setAddress(code, [plain]);
  }
  return code;
}

/** Split MeCard by unescaped semicolons, preserving escapes for later processing (values are further split by commas). */
function splitRaw(text: string): string[] {
  const out: string[] = [];
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '\\' && i + 1 < text.length) current += c + text[++i]!;
    else if (c === ';') {
      out.push(current);
      current = '';
    } else current += c;
  }
  out.push(current);
  return out;
}

const hasContent = (c: ContactCode) =>
  c.name !== undefined ||
  c.title !== undefined ||
  c.company !== undefined ||
  c.address !== undefined ||
  c.phones.length + c.emails.length + c.urls.length > 0;

/**
 * Text inside QR codes: extract fields from vCard and MeCard; URLs count only as websites
 * (founder 2026-11-04); all else returns null, and business cards are read as regular text.
 * Recognizes text only, does not open anything.
 */
export function parseContactCode(text: string): ContactCode | null {
  const code = text.replace(/^\uFEFF/, '').trim();
  if (!code || code.length > MAX_TEXT) return null;
  let parsed: ContactCode;
  if (/^BEGIN:VCARD/i.test(code)) parsed = parseVCard(code);
  else if (/^MECARD:/i.test(code)) parsed = parseMeCard(code);
  else {
    parsed = { phones: [], emails: [], urls: [] };
    addValue(parsed.urls, 'url', code);
  }
  return hasContent(parsed) ? parsed : null;
}

/** Values obtained from QR codes for each field in this table (field ID → value). Text and long text fields only. */
export function contactCodeValues(
  fields: readonly Field[],
  code: ContactCode,
): Record<string, string[]> {
  const bySlot: Record<Slot, readonly string[]> = {
    name: code.name ? [code.name] : [],
    title: code.title ? [code.title] : [],
    company: code.company ? [code.company] : [],
    address: code.address ? [code.address] : [],
    phone: code.phones,
    email: code.emails,
    url: code.urls,
  };
  const out: Record<string, string[]> = {};
  for (const field of fields) {
    const slot = slotOf(field);
    if (slot && bySlot[slot].length > 0) out[field.id] = [...bySlot[slot]];
  }
  return out;
}
