import { pad } from './field-values';
// File naming template (§7C): only whitelisted placeholders are allowed, no expressions are supported.
//   {date}         = {date:YYYY-MM-DD}
// {date:FORMAT} FORMAT can only consist of YYYY MM DD HH mm ss and - _ ., using device local time.
// {index} Sequential number in the same execution (starting from 1). {seq} Two-digit sequence
// number: 01, 02... (continues incrementing past 99). {sourceName} Original name of this file
// (without extension). {taken} / {taken:FORMAT} Photo capture date; falls back to current date if
// unreadable. {ocr:RULE} / {qr:RULE} A segment extracted according to rules from the text / QR code
// content recognized on-device from this file during the current run (D-244); RULE must be a
// TEXT_RULES entry from text-rules.ts, AI only picks the rule and cannot see the text.

import { TEXT_RULES, extractFirst, type TextRule } from './text-rules';
import type { Locale } from './schema';

const PLACEHOLDER = /\{([^{}]*)\}/g;
const DATE_FORMAT = /^(YYYY|MM|DD|HH|mm|ss|[-_.])+$/;
const MAX_NAME_LENGTH = 80;
const SIMPLE = new Set(['index', 'seq', 'sourceName', 'date', 'taken']);

export type TemplateCheck = { ok: true } | { ok: false; error: string };

export function checkNameTemplate(template: string): TemplateCheck {
  if (template.trim().length === 0) return { ok: false, error: 'template is empty' };
  if (template.length > MAX_NAME_LENGTH) return { ok: false, error: 'template is too long' };
  const stripped = template.replace(PLACEHOLDER, '');
  if (/[{}]/.test(stripped)) return { ok: false, error: 'unbalanced braces' };
  for (const [, body = ''] of template.matchAll(PLACEHOLDER)) {
    if (SIMPLE.has(body)) continue;
    const format = /^(date|taken):(.*)$/.exec(body)?.[2];
    if (format !== undefined && DATE_FORMAT.test(format)) continue;
    const rule = /^(ocr|qr):(.*)$/.exec(body)?.[2];
    if (rule !== undefined && (TEXT_RULES as readonly string[]).includes(rule)) continue;
    return { ok: false, error: `unsupported placeholder {${body}}` };
  }
  return { ok: true };
}

export interface NameContext {
  now: Date;
  index?: number;
  sourceName?: string;
  /** Photo capture timestamp (EXIF). */
  takenAt?: Date;
  /** Recognized text and QR code content for this file on-device (present only when templates contain {ocr:...} / {qr:...}, D-244). */
  recognized?: { ocr?: string; qr?: string };
  /** Used when disambiguating day/month order for dates (English month first). */
  locale?: Locale;
}

/** Whether the template requires on-device text / QR code recognition (D-244). */
export function templateReads(template: string): { ocr: boolean; qr: boolean } {
  return { ocr: /\{ocr:[^{}]*\}/.test(template), qr: /\{qr:[^{}]*\}/.test(template) };
}

function formatDate(format: string, d: Date): string {
  return format.replace(/YYYY|MM|DD|HH|mm|ss/g, (token) => {
    switch (token) {
      case 'YYYY':
        return String(d.getFullYear());
      case 'MM':
        return pad(d.getMonth() + 1);
      case 'DD':
        return pad(d.getDate());
      case 'HH':
        return pad(d.getHours());
      case 'mm':
        return pad(d.getMinutes());
      default:
        return pad(d.getSeconds());
    }
  });
}

/**
 * Strip characters disallowed by the file system: sequences of consecutive bad characters are
 * replaced with a single hyphen; leading dots and hyphens are removed (leading dots create hidden
 * files in the Files app, and "../" leaves only dots and hyphens after replacement).
 */
export function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[/\\:*?"<>|\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.-]+/, '')
    .trim();
  return cleaned.slice(0, MAX_NAME_LENGTH) || 'untitled';
}

/** Render template, returning the file name without extension. Should be validated via checkNameTemplate before calling. */
export function renderNameTemplate(template: string, ctx: NameContext): string {
  let missing = false;
  let rendered = template.replace(PLACEHOLDER, (_, body: string) => {
    const read = /^(ocr|qr):(.*)$/.exec(body);
    if (read) {
      const source = ctx.recognized?.[read[1] as 'ocr' | 'qr'];
      const found = source ? extractFirst(source, read[2] as TextRule, ctx.locale ?? 'en') : null;
      if (!found) missing = true;
      return found ?? '';
    }
    if (body === 'index') return String(ctx.index ?? 1);
    if (body === 'seq') return String(ctx.index ?? 1).padStart(2, '0');
    if (body === 'sourceName') return ctx.sourceName ?? '';
    const [kind, format = 'YYYY-MM-DD'] = body.split(':');
    return formatDate(format, kind === 'taken' ? (ctx.takenAt ?? ctx.now) : ctx.now);
  });
  // Required content could not be recognized: remove any leftover hyphens; fall back to the original name if nothing remains (D-244).
  if (missing)
    rendered = rendered.replace(/^[\s\-_.]+|[\s\-_.]+$/g, '').replace(/([-_.])[\s\-_.]+/g, '$1');
  if (missing && !rendered) rendered = ctx.sourceName ?? '';
  return sanitizeFileName(rendered);
}

/** Append sequence number on name collision, never overwrite existing files: report.pdf -> report-2.pdf -> report-3.pdf */
export function uniqueFileName(base: string, ext: string, existing: Iterable<string>): string {
  const taken = new Set([...existing].map((n) => n.toLowerCase()));
  let candidate = `${base}.${ext}`;
  for (let i = 2; taken.has(candidate.toLowerCase()); i++) candidate = `${base}-${i}.${ext}`;
  return candidate;
}
