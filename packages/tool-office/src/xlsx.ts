import { strToU8, zipSync, type Zippable } from 'fflate';

import type { Box, CellAlign, TableBlock, TableCell, TableDoc, TablePage } from './types';

// Write xlsx (D-272): write XML manually, packaged using fflate's synchronous API (Hermes lacks Web
// Workers and Node streams). One worksheet per page; strings placed in sharedStrings (Numbers and
// WPS support it more reliably than inlineStr); generate styles on demand: table cells (thin
// borders, wrap text, top alignment), non-table text (wrap text, no borders), numbers (table cells
// with number formats), separated further by alignment (left, center, right; defaults to general
// when unspecified).

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** Maximum of 32,767 characters per cell (Excel's upper limit). */
const MAX_CELL_CHARS = 32767;
/** Total page width of the original image is approximately equivalent to this many character widths (Excel column width unit). */
const PAGE_CHARS = 110;
/** Height of a line of text in points (11 pt font). */
export const LINE_POINTS = 15;
/** Excel's upper limit for row height in points; exceeding this causes corruption errors when opening the file. */
const MAX_ROW_POINTS = 409;
/** Font size used for cells without a specified font size (legacy files, added in editor view): xlsx default font is 11 pt Calibri. */
export const DEFAULT_FONT_SIZE = 11;
/** Width of a single character in Excel column width units is approximately this many pixels (digit width for Calibri 11). */
const CHAR_PIXELS = 7;
const EMU_PER_PIXEL = 9525;
const EMU_PER_POINT = 12700;

/** Remove characters not allowed in XML (control characters, FFFE/FFFF, lone surrogates), and normalize newlines to \\n. */
export function cleanXmlText(text: string): string {
  const s = text.replace(/\r\n?/g, '\n');
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += s[i]! + s[i + 1]!;
        i++;
      }
      continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) continue;
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a) || c === 0xfffe || c === 0xffff) continue;
    out += s[i]!;
  }
  return out;
}

export const escapeXml = (text: string) =>
  cleanXmlText(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Column index (0-based) -> column letters: 0 -> A, 25 -> Z, 26 -> AA. */
export function columnName(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

const ref = (row: number, col: number) => `${columnName(col)}${row + 1}`;

/**
 * Worksheet name: strip characters disallowed by Excel ([]:*?/\\) and control characters, trim
 * leading and trailing single quotes, maximum 31 characters; defaults to Sheet N if empty,
 * appending " (2)" if it conflicts with a preceding name (case-insensitive).
 */
export function sheetName(name: string, index: number, taken: ReadonlySet<string>): string {
  let base = cleanXmlText(name)
    .replace(/[[\]:*?/\\\n\t]/g, '')
    .trim()
    .replace(/^'+|'+$/g, '')
    .trim();
  const cut = (s: string, max: number) => Array.from(s).slice(0, max).join('');
  base = cut(base, 31) || `Sheet${index + 1}`;
  let candidate = base;
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) {
    const suffix = ` (${n})`;
    candidate = cut(base, 31 - suffix.length) + suffix;
  }
  return candidate;
}

/**
 * Pure numbers are written as numeric types (enabling direct summation in Excel): 1234, 1,234.56,
 * -5, 12%. Numbers starting with 0 (phone numbers, IDs), exceeding 15 digits, dates, and others
 * are written as text. format is the Excel number format (retaining thousands separators, decimal
 * places, percentages).
 */
export function cellNumber(text: string): { value: number; format: string } | null {
  const m = /^([-−])?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(%)?$/.exec(text.trim());
  if (!m) return null;
  const [, sign, int, frac = '', percent] = m;
  const digits = int!.replace(/,/g, '');
  if (digits.length > 1 && digits.startsWith('0')) return null;
  if (digits.length + frac.length > 15) return null;
  let value = Number(`${digits}${frac ? `.${frac}` : ''}`);
  if (sign) value = -value;
  if (percent) value = Number((value / 100).toPrecision(15));
  const format =
    (int!.includes(',') ? '#,##0' : '0') +
    (frac ? `.${'0'.repeat(frac.length)}` : '') +
    (percent ?? '');
  return { value, format };
}

/** Excel's built-in number format IDs; others are custom-defined (starting from 164). */
const BUILT_IN_FORMATS: Record<string, number> = {
  General: 0,
  '0': 1,
  '0.00': 2,
  '#,##0': 3,
  '#,##0.00': 4,
  '0%': 9,
  '0.00%': 10,
  // Dates and times (read from external xlsx, D-509): write back using built-in IDs so Excel displays short dates according to the mobile or desktop locale.
  'mm-dd-yy': 14,
  'd-mmm-yy': 15,
  'd-mmm': 16,
  'mmm-yy': 17,
  'h:mm AM/PM': 18,
  'h:mm:ss AM/PM': 19,
  'h:mm': 20,
  'h:mm:ss': 21,
  'm/d/yy h:mm': 22,
  'mm:ss': 45,
  '[h]:mm:ss': 46,
  'mmss.0': 47,
};

/** Estimate how many lines a text snippet occupies in a cell of width characters (CJK characters count as two character widths). Also used by the editor view to estimate row heights. */
export function lineCount(text: string, width: number): number {
  const avail = Math.max(1, width - 1);
  let lines = 0;
  for (const para of text.split('\n')) {
    let units = 0;
    for (const ch of para)
      units += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) || ch.length > 1 ? 2 : 1.1;
    lines += Math.max(1, Math.ceil(units / avail));
  }
  return lines;
}

interface StyleKey {
  /** Table cell: thin borders; non-table text has no borders. */
  border: boolean;
  /** Number format; text has none (text wraps automatically, numbers do not). */
  format?: string;
  align?: CellAlign;
  /** Font size in points and bold status (D-521); 11 pt non-bold is the default font. */
  size?: number;
  bold?: boolean;
}

interface Styles {
  /** Style ID (index in cellXfs); 0 is the default style. */
  style(key: StyleKey): number;
  xml(): string;
}

function createStyles(): Styles {
  const keys: StyleKey[] = [];
  const ids = new Map<string, number>();
  const custom = new Map<string, number>();
  const fonts: { size: number; bold: boolean }[] = [{ size: DEFAULT_FONT_SIZE, bold: false }];
  const fontId = (key: StyleKey) => {
    const size = key.size ?? DEFAULT_FONT_SIZE;
    const bold = key.bold === true;
    let i = fonts.findIndex((f) => f.size === size && f.bold === bold);
    if (i < 0) i = fonts.push({ size, bold }) - 1;
    return i;
  };
  const formatId = (code: string) => {
    if (BUILT_IN_FORMATS[code] !== undefined) return BUILT_IN_FORMATS[code]!;
    if (!custom.has(code)) custom.set(code, 164 + custom.size);
    return custom.get(code)!;
  };
  return {
    style(key) {
      const id = `${key.border}|${key.format ?? ''}|${key.align ?? ''}|${key.size ?? DEFAULT_FONT_SIZE}|${key.bold === true}`;
      if (!ids.has(id)) {
        if (key.format) formatId(key.format);
        fontId(key);
        ids.set(id, keys.push(key));
      }
      return ids.get(id)!;
    },
    xml() {
      const xfs = keys.map((k) => {
        const align =
          (k.align ? ` horizontal="${k.align}"` : '') +
          ' vertical="top"' +
          (k.format ? '' : ' wrapText="1"');
        return (
          `<xf numFmtId="${k.format ? formatId(k.format) : 0}" fontId="${fontId(k)}" fillId="0" borderId="${k.border ? 1 : 0}" xfId="0"` +
          (k.format ? ' applyNumberFormat="1"' : '') +
          (fontId(k) ? ' applyFont="1"' : '') +
          (k.border ? ' applyBorder="1"' : '') +
          ` applyAlignment="1"><alignment${align}/></xf>`
        );
      });
      const numFmts = custom.size
        ? `<numFmts count="${custom.size}">${[...custom]
            .map(([code, id]) => `<numFmt numFmtId="${id}" formatCode="${escapeXml(code)}"/>`)
            .join('')}</numFmts>`
        : '';
      return (
        HEAD +
        `<styleSheet xmlns="${NS}">${numFmts}` +
        `<fonts count="${fonts.length}">${fonts
          .map(
            (f) =>
              `<font>${f.bold ? '<b/>' : ''}<sz val="${f.size}"/><name val="Calibri"/><family val="2"/></font>`,
          )
          .join('')}</fonts>` +
        '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
        '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>' +
        '<border><left style="thin"><color auto="1"/></left><right style="thin"><color auto="1"/></right><top style="thin"><color auto="1"/></top><bottom style="thin"><color auto="1"/></bottom><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        `<cellXfs count="${1 + xfs.length}">` +
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
        xfs.join('') +
        '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
        '</styleSheet>'
      );
    },
  };
}

interface SharedStrings {
  index(text: string): number;
  xml(): string;
}

function createSharedStrings(): SharedStrings {
  const list: string[] = [];
  const seen = new Map<string, number>();
  let count = 0;
  return {
    index(text) {
      count++;
      const s = cleanXmlText(text).slice(0, MAX_CELL_CHARS);
      if (!seen.has(s)) seen.set(s, list.push(s) - 1);
      return seen.get(s)!;
    },
    xml() {
      const items = list.map((s) => {
        const preserve = /^\s|\s$|\n/.test(s) ? ' xml:space="preserve"' : '';
        return `<si><t${preserve}>${escapeXml(s)}</t></si>`;
      });
      return (
        HEAD +
        `<sst xmlns="${NS}" count="${count}" uniqueCount="${list.length}">${items.join('')}</sst>`
      );
    },
  };
}

/** Blocks to write out for this page: when recognition scope is "table content only", non-table text is omitted, but written anyway if the page contains zero tables (D-272). */
export function pageBlocks(page: TablePage, scope: TableDoc['scope']) {
  const hasTable = page.blocks.some((b) => b.kind === 'table');
  return scope === 'tables' && hasTable
    ? page.blocks.filter((b) => b.kind === 'table')
    : page.blocks;
}

/** Pages (1-indexed) where the recognition scope is "table content only" but no tables were found. */
export function pagesWithoutTables(doc: TableDoc): number[] {
  if (doc.scope !== 'tables') return [];
  return doc.pages.flatMap((p, i) => (p.blocks.some((b) => b.kind === 'table') ? [] : [i + 1]));
}

/** Column widths (characters) for a worksheet: shared columns across the entire page (D-272), converted from original image pixels based on page width. */
export function sheetColumns(page: TablePage): number[] {
  const toChars = (px: number) =>
    Math.round(Math.min(120, Math.max(4, (px / Math.max(1, page.width)) * PAGE_CHARS)) * 10) / 10;
  return page.colWidths.map(toChars);
}

/** A cell on the worksheet (merged cells only have it on the top-left): table cells record which table and cell index they correspond to, while non-table text and images record their block index. */
export interface SheetCell {
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
  text: string;
  align?: CellAlign;
  /** Index in page.blocks. */
  block: number;
  /** Index of the table cell in table.cells; non-table text and images do not have this. */
  cell?: number;
  /** Row index of the table cell within its table (side-by-side tables share worksheet rows, rows[].tableRow records only the first table). */
  tableRow?: number;
  write?: TableCell['write'];
  /** Font size in points and bold status (D-521); defaults to 11 pt when absent. */
  size?: number;
  bold?: boolean;
  /** This cell represents an image (D-520): src is the image URL (absent before cropping); width and height are its dimensions on the worksheet in points; text is empty. */
  image?: { src?: string; width: number; height: number };
}

/** How a page is laid out on a worksheet: the edit page renders according to it, and writing xlsx also follows it, so both sides match. */
export interface SheetLayout {
  /** Column width (Excel character width). */
  colWidths: number[];
  /**
   * Each row: estimated line count (calculated from the cell with the most characters in this
   * row), row height (points, based on font size), which block it belongs to (blank rows are
   * null; rows shared by side-by-side blocks are attributed to the first block), and the row
   * index in that table.
   */
  rows: { lines: number; points: number; block: number | null; tableRow?: number }[];
  cells: SheetCell[];
}

/** Line height for a line of text (points): matches the ratio of 11 pt to 15 pt. */
const linePoints = (size: number) =>
  Math.round(((size * LINE_POINTS) / DEFAULT_FONT_SIZE) * 10) / 10;

/** Estimate how many lines a piece of text occupies in a cell of width characters; when font size is less than 11 pt, more characters fit in a single line. */
export function lineCountAt(text: string, width: number, size = DEFAULT_FONT_SIZE): number {
  return lineCount(text, (width * DEFAULT_FONT_SIZE) / size);
}

/** Size of an image on the worksheet (points): width is the width of the columns it spans, and height follows the aspect ratio of the original image box. */
export function imageSizePoints(colWidths: readonly number[], col: number, cols: number, box: Box) {
  let chars = 0;
  for (let c = col; c < col + cols; c++) chars += colWidths[c] ?? 8;
  const width = (chars * CHAR_PIXELS * EMU_PER_PIXEL) / EMU_PER_POINT;
  return { width, height: (width * box.height) / Math.max(1, box.width) };
}

/**
 * Layout a page as a worksheet: blocks are laid out downwards in order; if the gap between blocks
 * exceeds 1.5 times the line height, leave a blank line (roughly preserving original spacing); a
 * single set of columns per page (D-272), with tables starting from their first column
 * (TableBlock.col); text outside tables has one paragraph per line, spanning from the first
 * column to the last column when there is no column range. Blocks in the same band (D-522) start
 * from the same row: left column, right column, and adjacent images are laid out in their
 * respective columns, blocks within each column are laid out top-down, and after a band finishes,
 * the next block starts below the longest column. Images (D-520) occupy rows according to their
 * size, and font size (D-521) determines row height.
 */
export function layoutSheet(page: TablePage, scope: TableDoc['scope']): SheetLayout {
  const blocks = pageBlocks(page, scope);
  const colWidths = sheetColumns(page);
  const bodySize = page.bodySize ?? DEFAULT_FONT_SIZE;
  const rows: SheetLayout['rows'] = [];
  const cells: SheetCell[] = [];
  const ensure = (row: number, block: number | null) => {
    while (rows.length <= row) rows.push({ lines: 1, points: LINE_POINTS, block: null });
    if (block !== null && rows[row]!.block === null) rows[row]!.block = block;
  };
  /** Row height only increases and never decreases. */
  const grow = (row: number, lines: number, points: number) => {
    const r = rows[row]!;
    r.lines = Math.max(r.lines, lines);
    r.points = Math.max(r.points, points);
  };
  let prevBottom: number | null = null;
  // Band: starting row, next blank row for each column, bottom edge of the previous block in each column (original image pixels).
  interface Band {
    id: number;
    start: number;
    next: number[];
    bottom: (number | null)[];
  }
  let band = null as Band | null;
  for (const block of blocks) {
    const index = page.blocks.indexOf(block);
    if (block.kind === 'table' && block.rows < 1) continue;
    const from = block.kind === 'text' ? (block.col ?? 0) : block.col;
    const span =
      block.kind === 'text' ? (block.cols ?? Math.max(1, colWidths.length - from)) : block.cols;
    const col0 = Math.min(Math.max(0, from), Math.max(0, colWidths.length - 1));
    const cols = Math.max(1, Math.min(span, colWidths.length - col0));
    const bandId = block.band;
    let start: number;
    if (bandId !== undefined && band?.id === bandId) {
      // Blocks in the same band: laid out downwards following the previous block within their own column, leaving a blank line if the gap between paragraphs in the column is large.
      start = Math.max(...band.next.slice(col0, col0 + cols));
      const above = Math.max(...band.bottom.slice(col0, col0 + cols).map((b) => b ?? -Infinity));
      if (start > band.start && block.box.y - above > 1.5 * page.lineHeight) start++;
      prevBottom = Math.max(prevBottom ?? -Infinity, block.box.y + block.box.height);
    } else {
      start = rows.length;
      if (prevBottom !== null && block.box.y - prevBottom > 1.5 * page.lineHeight) start++;
      prevBottom = block.box.y + block.box.height;
      band =
        bandId !== undefined
          ? {
              id: bandId,
              start,
              next: colWidths.map(() => start),
              bottom: colWidths.map(() => null),
            }
          : null;
    }
    ensure(start, index);
    let used = 1;
    if (block.kind === 'text') {
      const text = cleanXmlText(block.text);
      let width = 0;
      for (let c = col0; c < col0 + cols; c++) width += colWidths[c] ?? 8;
      const size = block.size ?? bodySize;
      const lines = lineCountAt(text, width, size);
      // Text in a side-by-side band (alongside tables, images, or other columns) does not stretch
      // row height, otherwise the row of the adjacent table would be stretched too tall: merge
      // several rows downwards so the height is sufficient to hold its text.
      if (bandId !== undefined) {
        used = Math.max(1, Math.ceil((lines * linePoints(size)) / LINE_POINTS - 1e-6));
        ensure(start + used - 1, index);
      }
      cells.push({
        row: start,
        col: col0,
        rowSpan: used,
        colSpan: cols,
        text,
        ...(block.align ? { align: block.align } : {}),
        block: index,
        ...(size !== DEFAULT_FONT_SIZE ? { size } : {}),
        ...(block.bold ? { bold: true } : {}),
      });
      if (bandId === undefined) grow(start, lines, lines * linePoints(size));
    } else if (block.kind === 'image') {
      const { width, height } = imageSizePoints(colWidths, col0, cols, block.box);
      used = Math.max(1, Math.ceil(height / LINE_POINTS - 1e-6));
      ensure(start + used - 1, index);
      for (let r = start; r < start + used; r++) grow(r, 1, LINE_POINTS);
      cells.push({
        row: start,
        col: col0,
        rowSpan: used,
        colSpan: cols,
        text: '',
        block: index,
        image: { ...(block.src ? { src: block.src } : {}), width, height },
      });
    } else {
      used = block.rows;
      ensure(start + used - 1, index);
      for (let r = 0; r < block.rows; r++) rows[start + r]!.tableRow = r;
      for (const [i, cell] of block.cells.entries()) {
        const text = cleanXmlText(cell.text).trim();
        const { box: _box, size: cellSize, ...rest } = cell;
        const col = block.col + cell.col;
        const size = cellSize ?? bodySize;
        cells.push({
          ...rest,
          row: start + cell.row,
          col,
          text,
          block: index,
          cell: i,
          tableRow: cell.row,
          ...(size !== DEFAULT_FONT_SIZE ? { size } : {}),
        });
        if (cell.rowSpan === 1 && text) {
          let width = 0;
          for (let c = col; c < col + cell.colSpan; c++) width += colWidths[c] ?? 8;
          const lines = lineCountAt(text, width, size);
          grow(start + cell.row, lines, lines * linePoints(size));
        }
      }
    }
    if (band) {
      for (let c = col0; c < col0 + cols; c++) {
        band.next[c] = start + used;
        band.bottom[c] = block.box.y + block.box.height;
      }
    }
  }
  return { colWidths, rows, cells };
}

/** Image written into xlsx: JPG (or PNG) bytes and pixel dimensions (same as DocxImage in docx). */
export interface XlsxImage {
  bytes: Uint8Array;
  width: number;
  height: number;
}

/** Image file format (checked via magic bytes): PNG; others default to JPG. */
const imageType = (bytes: Uint8Array): 'png' | 'jpg' =>
  bytes[0] === 0x89 && bytes[1] === 0x50 ? 'png' : 'jpg';

/** Image to be placed on a worksheet: top-left cell location, size (points), and index of the image file in the entire file. */
interface SheetPicture {
  row: number;
  col: number;
  width: number;
  height: number;
  media: number;
}

function sheetXml(
  page: TablePage,
  scope: TableDoc['scope'],
  styles: Styles,
  strings: SharedStrings,
  images: ReadonlyMap<string, XlsxImage>,
  media: Uint8Array[],
): { xml: string; pictures: SheetPicture[] } {
  const layout = layoutSheet(page, scope);
  const rowCells: Map<number, string>[] = layout.rows.map(() => new Map());
  const merges: string[] = [];
  const pictures: SheetPicture[] = [];
  for (const cell of layout.cells) {
    if (cell.image) {
      // Images are anchored to their top-left cell; uncropped or unreadable images are omitted.
      const image = cell.image.src ? images.get(cell.image.src) : undefined;
      if (image) {
        let at = media.indexOf(image.bytes);
        if (at < 0) at = media.push(image.bytes) - 1;
        pictures.push({
          row: cell.row,
          col: cell.col,
          width: cell.image.width,
          height: cell.image.height,
          media: at + 1,
        });
      }
      continue;
    }
    const table = cell.cell !== undefined;
    // Tables imported from external xlsx (D-509) do not draw borders.
    const plain = table && (page.blocks[cell.block] as TableBlock).borderless === true;
    const at = ref(cell.row, cell.col);
    const number =
      cell.write?.kind === 'number'
        ? cell.write
        : table && cell.text && !cell.write
          ? cellNumber(cell.text)
          : null;
    const align = cell.align ? { align: cell.align } : {};
    const font = {
      ...(cell.size !== undefined ? { size: cell.size } : {}),
      ...(cell.bold ? { bold: true } : {}),
    };
    const empty = styles.style({ border: !plain, ...font });
    let xml: string;
    if (!cell.text) xml = `<c r="${at}" s="${empty}"/>`;
    else if (number) {
      const s = styles.style({ border: !plain, format: number.format, ...align, ...font });
      xml = `<c r="${at}" s="${s}"><v>${number.value}</v></c>`;
    } else {
      const s = styles.style({ border: table && !plain, ...align, ...font });
      xml = `<c r="${at}" s="${s}" t="s"><v>${strings.index(cell.text)}</v></c>`;
    }
    rowCells[cell.row]!.set(cell.col, xml);
    if (cell.rowSpan > 1 || cell.colSpan > 1) {
      merges.push(`${at}:${ref(cell.row + cell.rowSpan - 1, cell.col + cell.colSpan - 1)}`);
    }
    // Table cells covered by merged regions must also be written (with border styles), otherwise merged cells will only have borders on their top-left cell.
    if (!table) continue;
    for (let dr = 0; dr < cell.rowSpan; dr++) {
      for (let dc = 0; dc < cell.colSpan; dc++) {
        if (dr === 0 && dc === 0) continue;
        const r = cell.row + dr;
        const c = cell.col + dc;
        if (rowCells[r]) rowCells[r]!.set(c, `<c r="${ref(r, c)}" s="${empty}"/>`);
      }
    }
  }
  const cols = layout.colWidths
    .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`)
    .join('');
  const data = layout.rows
    .map((row, r) => {
      const cells = [...rowCells[r]!].sort((a, b) => a[0] - b[0]).map(([, xml]) => xml);
      return cells.length || row.points > LINE_POINTS
        ? `<row r="${r + 1}" ht="${Math.min(MAX_ROW_POINTS, row.points)}" customHeight="1">${cells.join('')}</row>`
        : '';
    })
    .join('');
  const xml =
    HEAD +
    `<worksheet xmlns="${NS}" xmlns:r="${REL_NS}">` +
    '<sheetViews><sheetView workbookViewId="0"/></sheetViews>' +
    `<sheetFormatPr defaultRowHeight="${LINE_POINTS}"/>` +
    `<cols>${cols}</cols>` +
    (data ? `<sheetData>${data}</sheetData>` : '<sheetData/>') +
    (merges.length
      ? `<mergeCells count="${merges.length}">${merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>`
      : '') +
    '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>' +
    (pictures.length ? '<drawing r:id="rId1"/>' : '') +
    '</worksheet>';
  return { xml, pictures };
}

/** Image placement for a worksheet (drawing section): each image is anchored to its top-left cell, with size in points; rId corresponds to the drawing relationship file. */
function drawingXml(pictures: readonly SheetPicture[]): string {
  const anchors = pictures
    .map((p, i) => {
      const cx = Math.round(p.width * EMU_PER_POINT);
      const cy = Math.round(p.height * EMU_PER_POINT);
      return (
        '<xdr:oneCellAnchor>' +
        `<xdr:from><xdr:col>${p.col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${p.row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>` +
        `<xdr:ext cx="${cx}" cy="${cy}"/>` +
        `<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${i + 2}" name="Picture ${i + 1}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>` +
        `<xdr:blipFill><a:blip r:embed="rId${i + 1}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>` +
        `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>` +
        '</xdr:pic><xdr:clientData/></xdr:oneCellAnchor>'
      );
    })
    .join('');
  return (
    HEAD +
    '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" ' +
    `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${REL_NS}">` +
    anchors +
    '</xdr:wsDr>'
  );
}

/**
 * TableDoc bytes for xlsx file. images provides pre-cropped image bytes per image block src
 * (D-520); missing image blocks are skipped.
 */
export function writeXlsx(
  doc: TableDoc,
  images: ReadonlyMap<string, XlsxImage> = new Map(),
): Uint8Array {
  const styles = createStyles();
  const strings = createSharedStrings();
  const taken = new Set<string>();
  const names = doc.pages.map((p, i) => {
    const name = sheetName(p.name, i, taken);
    taken.add(name.toLowerCase());
    return name;
  });
  // There must be at least one worksheet.
  const pages = doc.pages.length
    ? doc.pages
    : [
        {
          name: 'Sheet1',
          source: '',
          width: 1,
          height: 1,
          lineHeight: 20,
          colWidths: [1, 1, 1, 1],
          blocks: [],
        },
      ];
  if (!doc.pages.length) names.push('Sheet1');
  const media: Uint8Array[] = [];
  const built = pages.map((p) => sheetXml(p, doc.scope, styles, strings, images, media));
  const sheets = built.map((b) => b.xml);
  const n = sheets.length;
  // Worksheets with images: the relationship file for sheetN.xml points to drawingM.xml, which in turn points to the image in media.
  const drawn = built.flatMap((b, i) => (b.pictures.length ? [{ sheet: i + 1, ...b }] : []));
  const mediaExt = media.map(imageType);
  const files: Zippable = {
    '[Content_Types].xml': strToU8(
      HEAD +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        (mediaExt.includes('jpg') ? '<Default Extension="jpg" ContentType="image/jpeg"/>' : '') +
        (mediaExt.includes('png') ? '<Default Extension="png" ContentType="image/png"/>' : '') +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        sheets
          .map(
            (_, i) =>
              `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
          )
          .join('') +
        drawn
          .map(
            (_, k) =>
              `<Override PartName="/xl/drawings/drawing${k + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`,
          )
          .join('') +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
        '</Types>',
    ),
    '_rels/.rels': strToU8(
      HEAD +
        `<Relationships xmlns="${PKG_REL}">` +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>',
    ),
    'xl/workbook.xml': strToU8(
      HEAD +
        `<workbook xmlns="${NS}" xmlns:r="${REL_NS}"><bookViews><workbookView/></bookViews><sheets>` +
        names
          .map(
            (name, i) => `<sheet name="${escapeXml(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`,
          )
          .join('') +
        '</sheets></workbook>',
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      HEAD +
        `<Relationships xmlns="${PKG_REL}">` +
        sheets
          .map(
            (_, i) =>
              `<Relationship Id="rId${i + 1}" Type="${REL_NS}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
          )
          .join('') +
        `<Relationship Id="rId${n + 1}" Type="${REL_NS}/styles" Target="styles.xml"/>` +
        `<Relationship Id="rId${n + 2}" Type="${REL_NS}/sharedStrings" Target="sharedStrings.xml"/>` +
        '</Relationships>',
    ),
    ...Object.fromEntries(
      sheets.map((xml, i) => [`xl/worksheets/sheet${i + 1}.xml`, strToU8(xml)]),
    ),
    ...Object.fromEntries(
      drawn.flatMap((d, k) => [
        [
          `xl/worksheets/_rels/sheet${d.sheet}.xml.rels`,
          strToU8(
            HEAD +
              `<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL_NS}/drawing" Target="../drawings/drawing${k + 1}.xml"/></Relationships>`,
          ),
        ],
        [`xl/drawings/drawing${k + 1}.xml`, strToU8(drawingXml(d.pictures))],
        [
          `xl/drawings/_rels/drawing${k + 1}.xml.rels`,
          strToU8(
            HEAD +
              `<Relationships xmlns="${PKG_REL}">` +
              d.pictures
                .map(
                  (p, i) =>
                    `<Relationship Id="rId${i + 1}" Type="${REL_NS}/image" Target="../media/image${p.media}.${mediaExt[p.media - 1]}"/>`,
                )
                .join('') +
              '</Relationships>',
          ),
        ],
      ]),
    ),
    ...Object.fromEntries(
      media.map((bytes, i) => [`xl/media/image${i + 1}.${mediaExt[i]}`, [bytes, { level: 0 }]]),
    ),
    'xl/styles.xml': strToU8(styles.xml()),
    'xl/sharedStrings.xml': strToU8(strings.xml()),
  };
  return zipSync(files, { level: 6 });
}

/** Exported record cell value (provided by core's recordsToSheet, D-427). */
export type RowValue =
  { kind: 'text'; text: string } | { kind: 'number'; value: number; format: string; text: string };

/** Column widths (characters): sufficient for the longest content, not narrower than 8 and not wider than 40. */
function rowColumns(rows: readonly (readonly RowValue[])[]): number[] {
  const cols = Math.max(1, ...rows.map((r) => r.length));
  return Array.from({ length: cols }, (_, c) => {
    let width = 8;
    for (const row of rows) {
      const text = row[c]?.text;
      if (!text) continue;
      for (const line of text.split('\n')) {
        // lineCount places each unit on a line in a cell of width 2: equals the character width of this text.
        width = Math.max(width, lineCount(line, 2) + 2);
        if (width >= 40) return 40;
      }
    }
    return width;
  });
}

/**
 * xlsx for a single worksheet (record export, D-427): cell formatting is determined by the
 * caller, not guessed. Text is always shared strings (t="s"), and files contain no formulas: OCR
 * output like "=SUM(A1)" or "+33 1..." remains text when opened.
 */
export function writeRowsXlsx(name: string, rows: readonly (readonly RowValue[])[]): Uint8Array {
  const widths = rowColumns(rows);
  const cells: TableCell[] = rows.flatMap((row, r) =>
    row.map((value, c) => ({
      row: r,
      col: c,
      rowSpan: 1,
      colSpan: 1,
      text: value.text,
      write:
        value.kind === 'number'
          ? { kind: 'number' as const, value: value.value, format: value.format }
          : { kind: 'text' as const },
    })),
  );
  return writeXlsx({
    version: 3,
    scope: 'tables',
    pages: [
      {
        name,
        source: '',
        // Width = number of characters: sheetColumns converts using width / page width × 110.
        width: PAGE_CHARS,
        height: rows.length,
        lineHeight: 1,
        colWidths: widths,
        blocks: [
          {
            kind: 'table',
            rows: rows.length,
            col: 0,
            cols: widths.length,
            cells,
            box: { x: 0, y: 0, width: PAGE_CHARS, height: rows.length },
          },
        ],
      },
    ],
  });
}
