import type { Locale } from '../schema';
import { extractAll } from '../text-rules';
import { ruleCandidates } from './candidates';
import { ctx } from './doc-context';
import type { ValueKind } from './concepts';

// Candidate values for new record forms (D-394): recognized text lines (with bounding boxes) are
// grouped by vertical overlap, then split into 'label → value'. Reuses measurement script
// side-session-notes/prefill-ranking/scripts/emit.ts: line-based text is more accurate than joining
// via layoutOcrLines (prefill-real-ocr section 8 item 5). Text stays on-device and is not sent to
// AI. Avoid lookbehinds (not supported in older Hermes versions): use capturing groups for
// preceding boundaries.

/** Single line recognition result: text and its bounding box on this page (in pixels). */
export interface TextBox {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A page: lines given by recognition (or PDF text layer). */
export interface TextPage {
  width: number;
  height: number;
  lines: readonly TextBox[];
}

/** A value occurrence: type, normalized representation, raw text, and its label ("" if no label). */
export interface Occurrence {
  kind: ValueKind;
  value: string;
  raw: string;
  label: string;
  /** Page index (0-indexed) and row index on this page. */
  page: number;
  row: number;
  /** Vertical position of this row on the page (0 at top, 1 at bottom). */
  relY: number;
  dateOrder?: 'DMY' | 'MDY';
  /** Other?: boolean; text value appears to be another type (date, amount, phone number, URL...), text fields should reject it. */
  other?: boolean;
}

export interface PageRows {
  rows: { text: string; relY: number }[];
}

function rowsOf(lines: readonly TextBox[]): TextBox[][] {
  const sorted = lines
    .filter((l) => l.text.trim())
    .sort((a, b) => a.y + a.height / 2 - (b.y + b.height / 2));
  const groups: TextBox[][] = [];
  for (const line of sorted) {
    const first = groups.at(-1)?.[0];
    if (first) {
      const overlap =
        Math.min(first.y + first.height, line.y + line.height) - Math.max(first.y, line.y);
      if (overlap >= 0.5 * Math.min(first.height, line.height)) {
        groups.at(-1)!.push(line);
        continue;
      }
    }
    groups.push([line]);
  }
  return groups.map((g) => g.sort((a, b) => a.x - b.x));
}

/** Split a row into cells: join adjacent segments if the gap is less than 0.8 times the font height, otherwise split them. */
function cellsOf(row: readonly TextBox[]): string[] {
  const h = Math.min(...row.map((s) => s.height));
  const cells: string[] = [];
  let prevEnd = -Infinity;
  for (const s of row) {
    if (cells.length && s.x - prevEnd < 0.8 * h) cells[cells.length - 1] += ' ' + s.text.trim();
    else cells.push(s.text.trim());
    prevEnd = s.x + s.width;
  }
  return cells;
}

const cleanLabel = (s: string) => s.replace(/^[\s|·•*=\-–—#]+|[\s:：\-–—|·•*=#.]+$/g, '').trim();
// Phone number, ID: cannot be immediately preceded by alphanumeric characters (use capturing groups instead of lookbehinds).
const PHONE = /(^|[^\w+\-/#])(\+?\(?\d[\d\s\-().·]{5,}\d)(?!\d)/g;
const ID = /(^|[^\w])((?=[A-Za-z0-9\-/#.]*\d)[A-Za-z0-9][A-Za-z0-9\-/#.]{3,29})(?!\w)/g;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const digits = (s: string) => s.replace(/\D/g, '');

interface Typed {
  kind: ValueKind;
  value: string;
  raw: string;
  start: number;
  end: number;
  dateOrder?: 'DMY' | 'MDY';
}

/** Typed values within a cell (amount, date, phone, email, ID), with start and end positions. */
function typed(cell: string, locale: Locale): Typed[] {
  const out: Typed[] = [];
  for (const c of ruleCandidates(cell, locale))
    out.push({
      kind: c.kind === 'amount' ? 'money' : 'date',
      value: c.value,
      raw: c.raw,
      start: c.start,
      end: c.end,
      ...(c.dateOrder ? { dateOrder: c.dateOrder } : {}),
    });
  const overlaps = (s: number, e: number) => out.some((o) => s < o.end && e > o.start);
  for (const m of cell.matchAll(EMAIL)) {
    if (extractAll(m[0], 'email', locale).length)
      out.push({
        kind: 'email',
        value: m[0].toLowerCase(),
        raw: m[0],
        start: m.index,
        end: m.index + m[0].length,
      });
  }
  for (const m of cell.matchAll(PHONE)) {
    const at = m.index + m[1]!.length;
    const raw = m[2]!.replace(/[\s\-(.·]+$/, '');
    const n = digits(raw).length;
    if (n < 7 || n > 15 || overlaps(at, at + raw.length)) continue;
    out.push({ kind: 'phone', value: digits(raw), raw, start: at, end: at + raw.length });
  }
  for (const m of cell.matchAll(ID)) {
    const at = m.index + m[1]!.length;
    const raw = m[2]!.replace(/[.\-/]+$/, '');
    if (digits(raw).length < 3 || overlaps(at, at + raw.length)) continue;
    out.push({ kind: 'id', value: raw.toUpperCase(), raw, start: at, end: at + raw.length });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Appears to be a typed value (not ordinary text): IDs must occupy more than half of the text segment. */
export function looksTyped(s: string, locale: Locale): boolean {
  return (
    typed(s, locale).some(
      (t) => t.kind !== 'id' || t.raw.length >= 0.5 * s.replace(/\s/g, '').length,
    ) || extractAll(s, 'url', locale).length > 0
  );
}

const wordCount = (s: string) =>
  /[㐀-鿿]/.test(s)
    ? Math.ceil(s.replace(/\s/g, '').length / 3)
    : s.split(/\s+/).filter(Boolean).length;

/** Rows of a page and all 'label → value' pairs. */
export function pageOccurrences(
  page: TextPage,
  pageIndex: number,
  locale: Locale,
): { rows: { text: string; relY: number; cells: string[] }[]; occ: Occurrence[] } {
  const rows = rowsOf(page.lines);
  const pageH = page.height || 1;
  const info = rows.map((r) => {
    const top = Math.min(...r.map((s) => s.y));
    const bottom = Math.max(...r.map((s) => s.y + s.height));
    const cells = cellsOf(r);
    return { cells, text: cells.join(' '), relY: (top + bottom) / 2 / pageH };
  });
  const occ: Occurrence[] = [];
  // Rows consisting only of labels: no typed value of its own, short (≤4 words), no text after
  // colon ('Purpose: Dining' already has a value), ending with a colon is considered 'definitely a
  // label'.
  const labelOnly = info.map(
    (r) =>
      !looksTyped(r.text, locale) &&
      wordCount(r.text) <= 4 &&
      r.text.length <= 30 &&
      !/[:：]\s*\S/.test(r.text),
  );
  const sureLabel = info.map((r, i) => labelOnly[i] && /[:：]\s*$/.test(r.text));
  info.forEach((r, ri) => {
    // Tell date and amount rules how many amounts are in this row (whether to treat space-separated thousand-separator numbers as a single whole).
    ctx.rowMany = (r.text.match(/\d[.,]\d{2}(?!\d)/g) ?? []).length;
    const above = ri > 0 && labelOnly[ri - 1] ? cleanLabel(info[ri - 1]!.text) : '';
    const aboveSure = ri > 0 && sureLabel[ri - 1];
    const base = { page: pageIndex, row: ri, relY: r.relY };
    let prevText = ''; // The nearest non-value cell to the left within this row
    for (const cell of r.cells) {
      const colon = cell.search(/[:：]/);
      const hasColon = colon > 0 && colon <= 40;
      const left = hasColon ? cleanLabel(cell.slice(0, colon)) : '';
      const right = hasColon ? cell.slice(colon + 1) : cell;
      // Typed value: label = text preceding the value in the same cell (including left of colon),
      // or left cell, or above single-label row. When a cell contains multiple values (Inv No
      // :KSB800 Date:11/03/18), the label for each value is the text between it and the previous
      // value.
      const tc = typed(cell, locale);
      for (const v of tc) {
        const prevEnd = Math.max(0, ...tc.filter((w) => w.end <= v.start).map((w) => w.end));
        const prefix = cleanLabel(cell.slice(prevEnd, v.start).replace(/[\d.,\s$€£¥￥]+$/, ''));
        let label = prefix || prevText;
        if (!label && above) label = above;
        const order = v.dateOrder ? { dateOrder: v.dateOrder } : {};
        occ.push({ kind: v.kind, value: v.value, raw: v.raw, label, ...base, ...order });
        if (!prefix && !prevText && above && !aboveSure)
          occ.push({ kind: v.kind, value: v.value, raw: v.raw, label: '', ...base, ...order });
      }
      // Text value (fields like merchant name, person name, departure location, and radio choices): entire cell (right of colon).
      const value = right.trim();
      if (value) {
        const other = looksTyped(value, locale);
        const label = left || prevText;
        if (label) occ.push({ kind: 'text', value, raw: value, label, other, ...base });
        else {
          if (above) occ.push({ kind: 'text', value, raw: value, label: above, other, ...base });
          if (!above || !aboveSure)
            occ.push({ kind: 'text', value, raw: value, label: '', other, ...base });
        }
      }
      const t = typed(right, locale);
      if (!t.some((v) => v.kind !== 'id') && !hasColon && /\p{L}/u.test(cell))
        prevText = cleanLabel(cell);
      // Cells like 'Purpose:' or 'TOTAL :' where the text after the colon is empty, and the value is in the cell to the right: it is the label for the right cell.
      else if (hasColon) prevText = right.trim() ? '' : left;
    }
  });
  ctx.rowMany = 0;
  return { rows: info.map((r) => ({ text: r.text, relY: r.relY, cells: r.cells })), occ };
}
