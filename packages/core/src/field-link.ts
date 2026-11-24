import type { TextFormat } from './fields/text';
import type { Field } from './schema';

// Text field formats (phone, email, URL, D-422): which values can be opened and what they open
// (record page buttons and all four steps follow this, D-428). Pure function, limited to four
// types: tel:, sms:, mailto:, and http(s)://. Returns null for non-matching values: values are
// still stored and displayed normally but remain unclickable (format is not checked during saves).

export interface FieldLink {
  kind: 'phone' | 'message' | 'email' | 'url';
  url: string;
}

/** Permitted phone separators: stripping them does not change the number (both half-width and full-width brackets are included). Newlines are excluded: two lines represent two separate numbers. */
const PHONE_SEPARATORS = /[ \t 　().\-/（）–—]/g;

function phoneLink(value: string): FieldLink | null {
  // Letters and extensions are excluded: extracting only digits prevents misdialing other numbers.
  const dial = value.replace(PHONE_SEPARATORS, '');
  return /^\+?\d{3,}$/.test(dial) ? { kind: 'phone', url: `tel:${dial}` } : null;
}

// Email address first half accepts only RFC 5322 characters and text: colons and whitespace are excluded, preventing mailto:a@b.com and newlines from being injected.
const EMAIL = /^[\p{L}\p{N}!#$%&'*+/=?^_`{|}~.-]+@([\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+)$/u;

function emailLink(value: string): FieldLink | null {
  if (!EMAIL.test(value)) return null;
  const at = value.indexOf('@');
  // Encodes ?, &, and = in the first half: prevents adding ?bcc= or ?subject= injections.
  const local = encodeURIComponent(value.slice(0, at));
  const domain = encodeURIComponent(value.slice(at + 1));
  return { kind: 'email', url: `mailto:${local}@${domain}` };
}

/** Hostnames: letters, numbers, and hyphens only, separated by dots. Usernames (a.com@b.com appearing as a.com) and %2e are excluded. */
function validHost(host: string, bare: boolean): boolean {
  const labels = host.split('.');
  const ok = labels.every(
    (l) => /^[\p{L}\p{N}-]+$/u.test(l) && !l.startsWith('-') && !l.endsWith('-'),
  );
  if (!ok) return false;
  // Unprefixed http(s) values must resemble domain names: x.com is valid, while 3.14 or tel:123 (tel) are invalid.
  return !bare || (labels.length >= 2 && /^\p{L}{2,}$/u.test(labels[labels.length - 1]!));
}

function urlLink(value: string): FieldLink | null {
  if (/[\s\p{Cc}\\]/u.test(value)) return null;
  const scheme = /^(https?):\/\//i.exec(value);
  const rest = scheme ? value.slice(scheme[0].length) : value;
  const authority = /^[^/?#]*/.exec(rest)![0];
  // Hostnames may only be followed by a port; consequently, javascript:..., data:..., ftp://... cannot proceed to the next step.
  const parts = /^([^:]+)(?::\d{1,5})?$/.exec(authority);
  if (!parts || !validHost(parts[1]!, !scheme)) return null;
  return { kind: 'url', url: `${scheme ? scheme[1]!.toLowerCase() : 'https'}://${rest}` };
}

/** Determines what this text can open under this format; returns null if it does not match. */
export function formatLink(format: TextFormat, value: string): FieldLink | null {
  const v = value.trim();
  if (format === 'phone') return phoneLink(v);
  return format === 'email' ? emailLink(v) : urlLink(v);
}

export type LinkKind = FieldLink['kind'];

const asMessage = (link: FieldLink | null): FieldLink | null =>
  link?.kind === 'phone' ? { kind: 'message', url: `sms:${link.url.slice(4)}` } : null;

/** Steps for calling phone, sending SMS/text, sending email, opening websites (D-428): whether this text can be opened as such a link. */
export function actionLink(kind: LinkKind, value: string): FieldLink | null {
  if (kind === 'message') return asMessage(formatLink('phone', value));
  return formatLink(kind, value);
}

/**
 * What this value of this field can open; null when no format or values do not match. message:
 * send SMS for phone fields (D-423, same rules as calling); no other fields.
 */
export function fieldLink(field: Field, value: unknown, as?: 'message'): FieldLink | null {
  if (field.type !== 'text' || !field.format || typeof value !== 'string') return null;
  const link = formatLink(field.format, value);
  if (as !== 'message') return link;
  return asMessage(link);
}
