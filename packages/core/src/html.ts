import { REPORT_ATTACHMENT_LIMITS } from './limits';
import { t } from './messages';
import {
  aggregateRecords,
  fieldOf,
  formatRef,
  recordTitle,
  type DataRecord,
  type LinkResolver,
  perCurrencyText,
} from './data';
import { attachmentIds, localDate } from './field-values';
import { DEFAULT_CALENDAR, type Calendar } from './calendar';
import { fieldDefinition, type Collection, type Field, type Locale } from './schema';

// Fixed HTML template for converting text to PDF and generating PDFs from records (rendered via
// expo-print, system fonts, supports CJK). User text and record values are always escaped first
// before being filled in locally; the AI can only select templates, titles, and field names
// (D-042). The template contains no scripts and no external resources.

export function escapeHtml(text: string, { apostrophes = true } = {}): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return apostrophes ? escaped.replace(/'/g, '&#39;') : escaped;
}

export type PageSize = 'a4' | 'letter';

/** Paper sizes (in PDF points, 1/72 inch). */
export const PAGE_POINTS: Record<PageSize, { width: number; height: number }> = {
  a4: { width: 595, height: 842 },
  letter: { width: 612, height: 792 },
};

const FONT_STACK =
  "-apple-system, 'Helvetica Neue', 'PingFang SC', 'Hiragino Sans', 'Noto Sans CJK SC', Roboto, sans-serif";

function page(body: string, css: string, size: PageSize): string {
  const { width, height } = PAGE_POINTS[size];
  return `<!doctype html><html><head><meta charset="utf-8">
<style>
@page { size: ${width}pt ${height}pt; margin: 40pt 44pt; }
* { box-sizing: border-box; }
body { margin: 0; font-family: ${FONT_STACK}; color: #1a1a1a; }
${css}
</style></head><body>${body}</body></html>`;
}

/** A piece of text -> multi-page PDF (preserves newlines, long lines automatically wrap). */
export function textToHtml(
  text: string,
  opts: { fontSize: number; pageSize: PageSize; title?: string },
): string {
  const paragraphs = text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
  const title = opts.title ? `<h1>${escapeHtml(opts.title)}</h1>` : '';
  return page(
    `${title}${paragraphs}`,
    `h1 { font-size: ${opts.fontSize * 1.6}pt; margin: 0 0 12pt; }
p { font-size: ${opts.fontSize}pt; line-height: 1.5; margin: 0 0 ${opts.fontSize * 0.8}pt; white-space: normal; overflow-wrap: anywhere; }`,
    opts.pageSize,
  );
}

export const RECORD_TEMPLATES = ['table', 'cards', 'receipt'] as const;
export type RecordTemplate = (typeof RECORD_TEMPLATES)[number];

export interface RecordsHtmlOptions {
  template: RecordTemplate;
  title: string;
  /** Fields to display (field IDs or createdAt); empty = all fields. Non-existent fields are ignored. */
  fields: readonly string[];
  pageSize: PageSize;
  locale: Locale;
  now: Date;
  /** Reference fields display the title of the referenced record (D-250). */
  links?: LinkResolver;
  /** Notes printed below the title (D-425: which attachments were not included). Text shown to the user is escaped before filling. */
  notes?: readonly string[];
}

/** Records -> HTML. For receipts, sums up the first numeric (or number) field below the table. */
export function recordsToHtml(
  collection: Collection,
  records: readonly DataRecord[],
  opts: RecordsHtmlOptions,
): string {
  const { locale } = opts;
  const refs = (opts.fields.length > 0 ? opts.fields : collection.fields.map((f) => f.id)).filter(
    (ref) => ref === 'createdAt' || ref === 'updatedAt' || fieldOf(collection, ref),
  );
  const nameOf = (ref: string) =>
    ref === 'createdAt'
      ? t(locale, 'html_Created_1626a')
      : ref === 'updatedAt'
        ? t(locale, 'html_Updated_74f0c')
        : fieldOf(collection, ref)!.name;
  // Right-aligned numeric columns (field definition print.numeric: numbers, amounts).
  const numeric = (ref: string) => {
    const f = fieldOf(collection, ref);
    return f !== undefined && fieldDefinition(f.type).print?.numeric === true;
  };
  const cell = (r: DataRecord, ref: string) =>
    escapeHtml(formatRef(r, collection, ref, locale, opts.links));
  const date = localDate(opts.now);
  const header = `<header><h1>${escapeHtml(opts.title || collection.name)}</h1>
<div class="meta">${escapeHtml(collection.name)} · ${t(locale, 'html_records_3f794', { v0: records.length })} · ${date}</div>${(opts.notes ?? []).map((n) => `<p class="note">${escapeHtml(n)}</p>`).join('')}</header>`;

  let body: string;
  if (opts.template === 'cards') {
    body = records
      .map(
        (r) =>
          `<section class="card">${refs
            .map(
              (ref) =>
                `<div class="row"><span class="k">${escapeHtml(nameOf(ref))}</span><span class="v">${cell(r, ref) || '—'}</span></div>`,
            )
            .join('')}</section>`,
      )
      .join('\n');
  } else {
    const head = refs
      .map((ref) => `<th${numeric(ref) ? ' class="num"' : ''}>${escapeHtml(nameOf(ref))}</th>`)
      .join('');
    const rows = records
      .map(
        (r) =>
          `<tr>${refs.map((ref) => `<td${numeric(ref) ? ' class="num"' : ''}>${cell(r, ref)}</td>`).join('')}</tr>`,
      )
      .join('\n');
    let total = '';
    if (opts.template === 'receipt') {
      // Which field to sum: field definition print.total with smaller rank takes priority (amounts first, then numbers), taking the first for the same type.
      const candidates = collection.fields.filter(
        (f) => refs.includes(f.id) && fieldDefinition(f.type).print?.total,
      );
      const rank = (f: Field) => fieldDefinition(f.type).print!.total!.rank;
      const best = Math.min(...candidates.map(rank));
      const field = candidates.find((f) => rank(f) === best);
      if (field) {
        const sum = aggregateRecords(records, collection, 'sum', field.id) ?? 0;
        const shown =
          perCurrencyText(records, collection, 'sum', field.id, locale) ??
          fieldDefinition(field.type).print!.total!.format(field, sum, locale);
        // Colons according to locale: Chinese full-width, French preceded by a narrow non-breaking space, English half-width.
        const colon = locale === 'zh' ? '：' : locale === 'fr' ? '\u202f: ' : ': ';
        total = `<div class="total">${t(locale, 'html_Total_08322')} · ${escapeHtml(field.name)}${colon}<strong>${escapeHtml(shown)}</strong></div>`;
      }
    }
    body = `<table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>${total}`;
  }
  return page(
    `${header}${body}`,
    `${opts.notes?.length ? '.note { font-size: 10pt; margin: 6pt 0 0; overflow-wrap: anywhere; }\n' : ''}header { margin-bottom: 16pt; }
h1 { font-size: 20pt; margin: 0 0 4pt; }
.meta { font-size: 9pt; color: #666; }
table { width: 100%; border-collapse: collapse; font-size: 10pt; }
th { text-align: left; border-bottom: 1.5pt solid #333; padding: 5pt 6pt; }
td { border-bottom: 0.5pt solid #ccc; padding: 5pt 6pt; vertical-align: top; overflow-wrap: anywhere; }
tr { page-break-inside: avoid; }
.num { text-align: right; white-space: nowrap; }
.total { margin-top: 12pt; text-align: right; font-size: 12pt; }
.card { border: 0.75pt solid #ccc; border-radius: 6pt; padding: 8pt 10pt; margin-bottom: 10pt; page-break-inside: avoid; }
.row { display: flex; gap: 12pt; font-size: 10pt; padding: 2pt 0; }
.k { width: 30%; color: #666; }
.v { flex: 1; overflow-wrap: anywhere; }`,
    opts.pageSize,
  );
}

// ---- Reports with attachments (D-425) ----

/** An attachment to include in the report: which record it belongs to, and what caption to write. */
export interface ReportAttachment {
  /** User file ID: used only on-device, not included in HTML, and not sent to the AI. */
  assetId: string;
  title: string;
  /** The printed value of this record in the report, allowing the reader to match it to the correct row. */
  detail: string;
  /** Sequence number of this record (1-based) and total count. */
  index: number;
  total: number;
}

const CAPTION_CHARS = 120;

/** List attachments in file fields, ordered by record order, and within each record by field and attachment order. */
export function reportAttachments(
  collection: Collection,
  records: readonly DataRecord[],
  opts: {
    fields: readonly string[];
    locale: Locale;
    now: Date;
    cal?: Calendar;
    links?: LinkResolver;
  },
): ReportAttachment[] {
  const { locale, now, cal = DEFAULT_CALENDAR } = opts;
  const refs = (opts.fields.length > 0 ? opts.fields : collection.fields.map((f) => f.id)).filter(
    (ref) =>
      ref === 'createdAt' ||
      ref === 'updatedAt' ||
      (fieldOf(collection, ref) && fieldOf(collection, ref)!.type !== 'file'),
  );
  const fileFields = collection.fields.filter((f) => f.type === 'file');
  return records.flatMap((record) => {
    const ids = fileFields.flatMap((f) => attachmentIds(record.values[f.id]));
    if (ids.length === 0) return [];
    const title = recordTitle(record, collection, locale, now, cal);
    const detail = refs
      .map((ref) => formatRef(record, collection, ref, locale, opts.links, now, cal))
      .filter((text) => text !== '' && text !== title)
      .join(' · ');
    return ids.map((assetId, i) => ({
      assetId,
      title,
      detail,
      index: i + 1,
      total: ids.length,
    }));
  });
}

/** An attachment page: caption + photo (JPEG base64). When there are no photos, it serves as the caption page preceding the PDF pages. */
export interface ReportAttachmentPage {
  attachment: ReportAttachment;
  jpegBase64?: string;
  /** Number of subsequent PDF pages. */
  pdfPages?: number;
}

/** HTML for attachment pages: one photo per page, with the caption above. */
export function reportAttachmentsToHtml(
  pages: readonly ReportAttachmentPage[],
  opts: { pageSize: PageSize; locale: Locale },
): string {
  const { height } = PAGE_POINTS[opts.pageSize];
  const cut = (s: string) => Array.from(s).slice(0, CAPTION_CHARS).join('');
  const body = pages
    .map(({ attachment: a, jpegBase64, pdfPages }) => {
      const count =
        a.total > 1 ? t(opts.locale, 'reportAttachmentOf', { index: a.index, total: a.total }) : '';
      const meta = [cut(a.detail), count].filter(Boolean).join(' · ');
      const pdf =
        pdfPages !== undefined
          ? `<p class="pdf">${escapeHtml(t(opts.locale, 'reportAttachmentPdfFollows', { n: pdfPages }))}</p>`
          : '';
      const image = jpegBase64
        ? `<img alt="" src="data:image/jpeg;base64,${escapeHtml(jpegBase64)}">`
        : '';
      return `<section class="att"><h2>${escapeHtml(cut(a.title))}</h2><div class="meta">${escapeHtml(meta)}</div>${pdf}${image}</section>`;
    })
    .join('\n');
  // Top and bottom margins of 40pt, caption takes at most approx. 90pt: photos will not be pushed to the next page.
  return page(
    body,
    `.att { page-break-after: always; break-after: page; }
.att:last-child { page-break-after: auto; break-after: auto; }
h2 { font-size: 14pt; margin: 0 0 3pt; overflow-wrap: anywhere; }
.meta { font-size: 9pt; color: #666; margin-bottom: 8pt; overflow-wrap: anywhere; }
.pdf { font-size: 10pt; }
img { display: block; margin: 0 auto; max-width: 100%; max-height: ${height - 80 - 90}pt; }`,
    opts.pageSize,
  );
}

/** Unincluded attachments -> text to print on the report. When there are more than 8 records, only the first 8 are listed. */
export function reportAttachmentNotes(
  left: { overLimit: readonly string[]; unreadable: readonly string[] },
  locale: Locale,
): string[] {
  const titles = (list: readonly string[]) => {
    const unique = [...new Set(list)];
    const shown = unique.slice(0, 8).join(t(locale, 'reportAttachmentSeparator'));
    return unique.length > 8 ? `${shown}…` : shown;
  };
  const notes: string[] = [];
  if (left.overLimit.length > 0)
    notes.push(
      t(locale, 'reportAttachmentsOverLimit', {
        n: left.overLimit.length,
        max: REPORT_ATTACHMENT_LIMITS.maxCount,
        mb: REPORT_ATTACHMENT_LIMITS.maxBytes / (1024 * 1024),
        titles: titles(left.overLimit),
      }),
    );
  if (left.unreadable.length > 0)
    notes.push(
      t(locale, 'reportAttachmentsUnreadable', {
        n: left.unreadable.length,
        titles: titles(left.unreadable),
      }),
    );
  return notes;
}
