import { strToU8, zipSync, type Zippable } from 'fflate';

import {
  leafBlocks,
  flowCellBlocks,
  textEm,
  type DocBlock,
  type DocDoc,
  type DocLeaf,
  type DocList,
  type DocPage,
  type DocParagraph,
  type DocRow,
  type DocRun,
  type DocStyle,
  type DocTable,
} from './doc';
import { splitRuns } from './doc-runs';
import { imageExt } from './docx-import';
import { escapeXml } from './xlsx';

// Write docx (D-328): write minimal OOXML ourselves, packaged using fflate's synchronous API (same
// as writing xlsx, D-272). Default sans-serif font (D-330), paragraphs (headings use bold Heading1
// / Heading2 styles, first-line indent), run bold / color / font size, numbering lists
// (numbering.xml), tables (gridSpan / vMerge merging), images (embedded JPG), side-by-side rows
// (borderless layout tables, D-331). A4 portrait, page break between original pages. Positioning
// (D-463, benchmarked against CamScanner): all ordinary paragraphs, no text boxes; paragraph left
// indent matches its left position in the original image, space-before matches the original empty
// height between it and the previous block.

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** A4 (twips, 1/20 pt) and page margins (2 cm). */
const PAGE_W = 11906;
const PAGE_H = 16838;
const MARGIN = 1134;
const CONTENT_W = PAGE_W - 2 * MARGIN;
const TABLE_FONT_PAGE_SHARE = CONTENT_W / PAGE_W;
/** 1 twip = 635 EMU。 */
const EMU_PER_TWIP = 635;
/** Left/right cell padding for all tables (twips); shared by actual file values and dimension budget estimation. */
const CELL_PAD = 80;

function cellMarginsXml(): string {
  return `<w:tblCellMar><w:left w:w="${CELL_PAD}" w:type="dxa"/><w:right w:w="${CELL_PAD}" w:type="dxa"/></w:tblCellMar>`;
}
/** Paragraph spacing before written as space-before (twips): used when a block has no available position (text-to-Word placeholder frame). */
const SPACED_BEFORE = 160;
/** Height of a line of text in Word ≈ multiple of font size (D-463): Arial ascents/descents 1.117 × default line spacing 1.15. */
const LINE_HEIGHT = 1.28;
/** Cells use Word single line spacing; layout still uses fonts' true ascents and descents, without clipping text using fixed heights. */
const CELL_LINE_HEIGHT = 1.12;
/** Left indents and space-befores smaller than this (twip: 6 pt, 3 pt) are not written: recognition box jitter, slight difference between text left edge and page margin. */
const MIN_INDENT = 120;
const MIN_BEFORE = 60;
/** Blocks whose left side differs by less than this many character widths are aligned to the same position. */
/** Blocks whose left side differs by less than this many character widths are aligned to the same position. */
const SNAP_EM = 0.7;
const WIDTH_SLACK = 1.1;

/**
 * Default font (D-330): sans-serif, same as CamScanner. Western Arial, Chinese Microsoft YaHei
 * (included in Windows and Mac Office versions); font table specifies sans-serif (swiss),
 * computers lacking this font fall back to another sans-serif font (Helvetica or PingFang on
 * Mac).
 */
const LATIN_FONT = 'Arial';
const CJK_FONT = 'Microsoft YaHei';
/** Write font on every run: Apple's Preview (Mac, iPhone "Files") does not read fonts from default styles, recognizing only run-level fonts. */
const RUN_FONTS = `<w:rFonts w:ascii="${LATIN_FONT}" w:hAnsi="${LATIN_FONT}" w:eastAsia="${CJK_FONT}" w:cs="${LATIN_FONT}"/>`;

function fontTableXml(): string {
  return (
    `${HEAD}<w:fonts xmlns:w="${W_NS}">` +
    `<w:font w:name="${LATIN_FONT}"><w:altName w:val="Helvetica"/><w:charset w:val="00"/>` +
    '<w:family w:val="swiss"/><w:pitch w:val="variable"/></w:font>' +
    `<w:font w:name="${CJK_FONT}"><w:altName w:val="PingFang SC"/><w:charset w:val="86"/>` +
    '<w:family w:val="swiss"/><w:pitch w:val="variable"/></w:font>' +
    '</w:fonts>'
  );
}

/** A cropped image: JPG bytes and pixel dimensions. */
export interface DocxImage {
  bytes: Uint8Array;
  width: number;
  height: number;
}

/** Heading style scale relative to body text (Heading1, Heading2). */
const HEADING_SCALE: Record<string, number> = { Heading1: 1.6, Heading2: 1.3 };

/**
 * Runs for a paragraph of text: line breaks written as <w:br/>, tabs written as <w:tab/> (D-332),
 * surrounding spaces preserved. Every run writes font size (D-335): Apple's Preview does not read
 * font sizes from default styles (treating all as 12 pt), recognizing only run-level sizes; those
 * without their own size use heading style or body font size.
 */
function sizeXml(style: DocStyle, bodySize: number, styleId?: string): string {
  const body = Math.round(bodySize * 2);
  const half = style.size
    ? Math.round(style.size * 2)
    : styleId && HEADING_SCALE[styleId]
      ? Math.round(body * HEADING_SCALE[styleId])
      : body;
  return `<w:sz w:val="${half}"/><w:szCs w:val="${half}"/>`;
}

function runXml(text: string, style: DocStyle, bodySize: number, styleId?: string): string {
  const props =
    RUN_FONTS +
    (style.bold ? '<w:b/><w:bCs/>' : '') +
    (style.italic ? '<w:i/><w:iCs/>' : '') +
    (style.color ? `<w:color w:val="${style.color}"/>` : '') +
    sizeXml(style, bodySize, styleId) +
    // Schema order: color, sz/szCs come before u.
    (style.underline ? '<w:u w:val="single"/>' : '');
  const rPr = `<w:rPr>${props}</w:rPr>`;
  return text
    .split('\n')
    .map(
      (part, i) =>
        `<w:r>${rPr}${i ? '<w:br/>' : ''}` +
        part
          .split('\t')
          .map((seg) => `<w:t xml:space="preserve">${escapeXml(seg)}</w:t>`)
          .join('<w:tab/>') +
        '</w:r>',
    )
    .join('');
}

/** Text of a paragraph: distinct styled sections (D-465) written as individual runs, unstyled ones follow the paragraph default. */
function runsXml(
  text: string | readonly DocRun[] | undefined,
  style: DocStyle,
  bodySize: number,
  styleId?: string,
): string {
  if (typeof text === 'string' || !text) return runXml(text ?? '', style, bodySize, styleId);
  return text
    .map(({ text: part, ...own }) => runXml(part, { ...style, ...own }, bodySize, styleId))
    .join('');
}

function paragraphXml(
  text: string | readonly DocRun[] | undefined,
  style: DocStyle,
  bodySize: number,
  extra: {
    styleId?: string;
    spaced?: boolean;
    /** Space before paragraph (twips, D-463): sometimes replaces spaced; headings also set space-after to 0 (avoiding heading style default before/after spacing). */
    before?: number;
    numId?: number;
    pageBreak?: boolean;
    /** First-line indent (twips). */
    indent?: number;
    /** Left indent (twips, D-463): left position in original image. */
    left?: number;
    fill?: string;
    tabs?: number[];
    single?: boolean;
  } = {},
): string {
  const spacing = extra.single
    ? `<w:spacing w:before="${extra.before ?? 0}" w:after="0" w:line="240" w:lineRule="auto"/>`
    : extra.before !== undefined
      ? extra.before >= MIN_BEFORE || extra.styleId?.startsWith('Heading')
        ? `<w:spacing w:before="${extra.before >= MIN_BEFORE ? extra.before : 0}"${extra.styleId?.startsWith('Heading') ? ' w:after="0"' : ''}/>`
        : ''
      : extra.spaced
        ? `<w:spacing w:before="${SPACED_BEFORE}"/>`
        : '';
  // Left indent for list items is added to the numbering indent (420), keeping hanging indent unchanged.
  const left = extra.left ? (extra.numId ? 420 + extra.left : extra.left) : 0;
  const ind =
    left || extra.indent
      ? `<w:ind${left ? ` w:left="${left}"` : ''}${left && extra.numId ? ' w:hanging="420"' : ''}${extra.indent ? ` w:firstLine="${extra.indent}"` : ''}/>`
      : '';
  const pPr =
    (extra.styleId ? `<w:pStyle w:val="${extra.styleId}"/>` : '') +
    (extra.pageBreak ? '<w:pageBreakBefore/>' : '') +
    (extra.numId ? `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${extra.numId}"/></w:numPr>` : '') +
    // Schema order: shd, tabs come before spacing, ind.
    (extra.fill || style.fill
      ? `<w:shd w:val="clear" w:color="auto" w:fill="${extra.fill ?? style.fill}"/>`
      : '') +
    (extra.tabs?.length
      ? `<w:tabs>${extra.tabs.map((pos) => `<w:tab w:val="left" w:pos="${pos}"/>`).join('')}</w:tabs>`
      : '') +
    spacing +
    ind +
    (style.align && style.align !== 'left'
      ? `<w:jc w:val="${style.align === 'center' ? 'center' : 'right'}"/>`
      : '') +
    // Paragraph mark font size (D-335): empty paragraphs and empty cell heights are calculated based on it.
    `<w:rPr>${sizeXml(style, bodySize, extra.styleId)}</w:rPr>`;
  return `<w:p><w:pPr>${pPr}</w:pPr>${runsXml(text, style, bodySize, extra.styleId)}</w:p>`;
}

/** Empty paragraph (separators after tables, empty cells): paragraph marks also write font size (D-335), otherwise default styles inflate the height (Apple's Preview uses 12 pt). */
function blankXml(size: number, single = false): string {
  return `<w:p><w:pPr>${single ? '<w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/>' : size <= 1 ? '<w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/>' : ''}<w:rPr>${sizeXml({}, size)}</w:rPr></w:pPr></w:p>`;
}

/** Combined left and right cell padding for tables (points), matching the value written into each table. */
const TABLE_CELL_PAD_PT = (2 * CELL_PAD) / 20;
/** The maximum font size reduction for text in the table to fit the longest word (in points, D-335). */
const TABLE_MIN_SIZE = 5;
/**
 * When a cell cannot fit its longest word, the entire table shrinks by at most this multiplier
 * relative to its original proportion, while general tables retain their font size (D-335);
 * individual cells that still cannot fit shrink further on their own. Otherwise, a very narrow
 * cell (an extraneous dummy column) would shrink the entire table and long descriptive paragraphs
 * down to 5 pt.
 */
const TABLE_SHRINK_FLOOR = 0.6;

/** Combined left and right cell padding (twips): padding for narrow cells is capped at 1/4 of the cell width, preventing an 8 pt padding from consuming a 10 pt wide cell. */
function cellPadTwip(width: number): number {
  return Math.min(2 * CELL_PAD, Math.round(width / 4));
}

/**
 * Approximate width of a word in Arial (in font-size units, D-335): uppercase letters ~0.7,
 * lowercase ~0.52, digits ~0.56, CJK characters 1 (each character can break and is counted as a
 * separate word), other symbols ~0.35. Better to slightly overestimate (overestimation just
 * results in smaller text, whereas underestimation splits words).
 */
function longestWordEm(text: string): number {
  let best = 0;
  let cur = 0;
  for (const ch of text) {
    if (/\s/.test(ch)) {
      cur = 0;
      continue;
    }
    if (
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\uFF00-\uFFEF]/u.test(
        ch,
      )
    ) {
      cur = 0;
      best = Math.max(best, 1);
      continue;
    }
    cur += /[A-Z\u00C0-\u00DE]/.test(ch)
      ? 0.7
      : /[a-z\u00DF-\u00FF]/.test(ch)
        ? 0.52
        : /\d/.test(ch)
          ? 0.56
          : 0.35;
    best = Math.max(best, cur);
  }
  return best;
}

/**
 * Original image pixels -> twips: total page width is based on A4 width, scaled down
 * proportionally to the content area if it does not fit. Font sizes in tables (D-335) scale down
 * together with the table's own font size; if the longest word in any cell still does not fit,
 * the table shrinks further overall, but by at most TABLE_SHRINK_FLOOR; cells that still do not
 * fit shrink individually down to a minimum of 5 pt (rounded to the nearest half point).
 */
function tableMetrics(
  block: DocTable,
  page: DocPage,
  bodySize: number,
  maxWidth: number,
  fontMaxWidth: number,
) {
  const { table, colWidths } = block;
  const raw = colWidths.map(
    (w) => (w / page.width) * (page.paper ? Math.round(page.paper.width * 20) : PAGE_W),
  );
  const total = raw.reduce((a, b) => a + b, 0) || 1;
  const k = Math.min(1, maxWidth / total);
  const widths = raw.map((w) => Math.max(200, Math.round(w * k)));
  const sourceSize = block.size ?? bodySize;
  const base = Math.min(k, fontMaxWidth / total);
  // Ratio at which each cell fits its longest word; the minimum of these is taken for the entire table, but it is not less than base multiplied by TABLE_SHRINK_FLOOR.
  const fits = new Map<DocTable['table']['cells'][number], number>();
  for (const cell of table.cells) {
    const em = longestWordEm(cell.text);
    if (!em) continue;
    const span = Math.max(1, Math.min(cell.colSpan, table.cols - cell.col));
    const cross = widths.slice(cell.col, cell.col + span).reduce((a, b) => a + b, 0) / 20;
    const w =
      block.direction && cell.box
        ? (cell.box.height / page.width) * (page.paper?.width ?? PAGE_W / 20)
        : cross;
    let fit = (w - cellPadTwip(w * 20) / 20) / em / (cell.size ?? sourceSize);
    if (block.direction)
      fit = Math.min(fit, (cross - TABLE_CELL_PAD_PT) / LINE_HEIGHT / (cell.size ?? sourceSize));
    fits.set(cell, fit);
  }
  const scale = Math.min(
    base,
    Math.max(base * TABLE_SHRINK_FLOOR, Math.min(base, ...fits.values())),
  );
  const size = Math.max(TABLE_MIN_SIZE, Math.floor(sourceSize * scale * 2) / 2);
  /** Font size of a cell: scaled according to the table-wide ratio, then shrunk further if the cell itself cannot fit its longest word. */
  const sizeOfCell = (c: DocTable['table']['cells'][number]) => {
    const own = Math.min(scale, fits.get(c) ?? scale);
    return c.size === undefined && own === scale
      ? size
      : Math.max(TABLE_MIN_SIZE, Math.floor((c.size ?? sourceSize) * own * 2) / 2);
  };
  const minimum = Array.from({ length: table.rows }, (_, row) =>
    Math.max(
      size * CELL_LINE_HEIGHT * 20,
      ...table.cells
        .filter((c) => c.row <= row && c.row + c.rowSpan > row)
        .map((c) => {
          const own = sizeOfCell(c);
          if (c.row !== row) return own * CELL_LINE_HEIGHT * 20;
          const cross = widths.slice(c.col, c.col + c.colSpan).reduce((n, w) => n + w, 0);
          const width = Math.max(1, cross - cellPadTwip(cross));
          const count = c.text
            .split('\n')
            .reduce(
              (n, line) =>
                n + Math.max(1, Math.ceil((textEm(line) * own * 20 * WIDTH_SLACK) / width)),
              0,
            );
          return count * own * CELL_LINE_HEIGHT * 20;
        }),
    ),
  ).map((height) => height + (block.borderless ? 0 : 10));
  const source = minimum.map((min, row) => {
    const raw = Math.min(
      ...table.cells
        .filter((c) => c.box && c.row <= row && c.row + c.rowSpan > row)
        .map((c) => c.box!.height / c.rowSpan),
    );
    return Number.isFinite(raw) && page.paper
      ? Math.max(min, (raw / page.height) * page.paper.height * 20 * k)
      : min;
  });
  // When the source label is near the bottom of a cell, adding line spacing for paragraph-before
  // might exceed the height of the source cell. Page measurement and line writing share this lower
  // limit; we cannot measure only trHeight while missing paragraphs inside cells that are
  // automatically expanded by Word.
  const contents = table.cells
    .filter((c) => c.rowSpan === 1)
    .map((c) => {
      const own = sizeOfCell(c);
      const lines = c.text.split('\n');
      const positions = block.cellLayout?.find((p) => p.row === c.row && p.col === c.col)?.lines;
      const sourceLines = c.box && positions?.length === lines.length ? positions : undefined;
      const cross = widths.slice(c.col, c.col + c.colSpan).reduce((n, w) => n + w, 0);
      const width = Math.max(1, cross - cellPadTwip(cross));
      const text =
        lines.reduce(
          (n, l) => n + Math.max(1, Math.ceil((textEm(l) * own * 20 * WIDTH_SLACK) / width)),
          0,
        ) *
        own *
        CELL_LINE_HEIGHT *
        20;
      const yScale = ((page.paper?.height ?? PAGE_H / 20) / page.height) * 20 * k;
      const gaps =
        sourceLines?.reduce(
          (n, p, i) =>
            n +
            Math.max(
              0,
              Math.round(
                (p.y - (sourceLines[i - 1]?.y ?? c.box!.y)) * yScale -
                  (i ? own * CELL_LINE_HEIGHT * 20 : own * 4),
              ),
            ),
          0,
        ) ?? 0;
      return { row: c.row, text, gaps };
    });
  const heightAt = (row: number, fit: number) =>
    Math.max(
      minimum[row]! + (source[row]! - minimum[row]!) * fit,
      ...contents
        .filter((c) => c.row === row)
        .map((c) => c.text + c.gaps * fit + (block.borderless ? 0 : 10)),
    );
  return { widths, k, scale, size, sizeOfCell, minimum, source, heightAt };
}

function tableXml(
  block: DocTable,
  page: DocPage,
  bodySize: number,
  maxWidth = CONTENT_W,
  left = 0,
  fontMaxWidth = maxWidth,
  spaceScale = 1,
): string {
  const { table } = block;
  const metrics = tableMetrics(block, page, bodySize, maxWidth, fontMaxWidth);
  const { widths, k, size, sizeOfCell } = metrics;
  // Mapping of each position to its cell (positions other than the top-left of a merged cell are written as vMerge continuation cells).
  const at = new Map<string, number>();
  table.cells.forEach((c, i) => {
    for (let r = c.row; r < c.row + c.rowSpan; r++)
      for (let col = c.col; col < c.col + c.colSpan; col++) at.set(`${r},${col}`, i);
  });
  const rows: string[] = [];
  for (let r = 0; r < table.rows; r++) {
    const cells: string[] = [];
    for (let c = 0; c < table.cols;) {
      const i = at.get(`${r},${c}`);
      const cell = i === undefined ? undefined : table.cells[i];
      if (!cell) {
        // Positions in the grid lacking a cell (malformed/edited file): insert a blank placeholder cell.
        cells.push(
          `<w:tc><w:tcPr><w:tcW w:w="${widths[c]}" w:type="dxa"/></w:tcPr>${blankXml(size, !!page.paper)}</w:tc>`,
        );
        c++;
        continue;
      }
      const span = Math.max(1, Math.min(cell.colSpan, table.cols - c));
      const w = widths.slice(c, c + span).reduce((a, b) => a + b, 0);
      const first = cell.row === r;
      const cellLayout = block.cellLayout?.find((p) => p.row === cell.row && p.col === cell.col);
      // Schema order: tcW, gridSpan, vMerge, shd, tcMar, textDirection, vAlign.
      const tcPr =
        `<w:tcW w:w="${w}" w:type="dxa"/>` +
        (span > 1 ? `<w:gridSpan w:val="${span}"/>` : '') +
        (cell.rowSpan > 1 ? (first ? '<w:vMerge w:val="restart"/>' : '<w:vMerge/>') : '') +
        (cellLayout?.fill
          ? `<w:shd w:val="clear" w:color="auto" w:fill="${cellLayout.fill}"/>`
          : '');
      const ownSize = sizeOfCell(cell);
      const style = { size: ownSize, ...(cell.align ? { align: cell.align } : {}) };
      const positions =
        !block.direction && cell.box
          ? block.cellLayout?.find((p) => p.row === cell.row && p.col === cell.col)?.lines
          : undefined;
      const sourceLines =
        positions?.length === cell.text.split('\n').length ? positions : undefined;
      const yScale = ((page.paper?.height ?? PAGE_H / 20) / page.height) * 20 * k;
      const xScale = ((page.paper?.width ?? PAGE_W / 20) / page.width) * 20 * k;
      const body = first
        ? cell.text
            .split('\n')
            .map((line, i) => {
              const position = sourceLines?.[i];
              if (!position)
                return paragraphXml(line, style, bodySize, page.paper ? { single: true } : {});
              const previous = sourceLines![i - 1];
              const before = Math.max(
                0,
                Math.round(
                  (position.y - (previous?.y ?? cell.box!.y)) * yScale -
                    (previous ? ownSize * CELL_LINE_HEIGHT * 20 : ownSize * 4),
                ),
              );
              const needed = textEm(line) * ownSize * 20 * WIDTH_SLACK;
              const left = Math.max(
                0,
                Math.min(Math.round((position.x - cell.box!.x) * xScale), w - needed - 20),
              );
              return paragraphXml(
                line,
                { ...style, align: 'left', ...(position.color ? { color: position.color } : {}) },
                bodySize,
                {
                  before: cell.rowSpan > 1 ? 0 : Math.round(before * spaceScale),
                  left,
                  single: true,
                  ...(position.fill ? { fill: position.fill } : {}),
                  ...(position.tabs
                    ? { tabs: position.tabs.map((x) => Math.round((x - cell.box!.x) * xScale)) }
                    : {}),
                },
              );
            })
            .join('')
        : blankXml(size, !!page.paper);
      // Left and right padding for narrow cells scaled down by cell width (cellPadTwip), matching the value used when measuring font size.
      const pad = cellPadTwip(w);
      const sourceMargins = sourceLines
        ? '<w:tcMar><w:top w:w="0" w:type="dxa"/><w:left w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tcMar>'
        : pad < 2 * CELL_PAD
          ? `<w:tcMar><w:left w:w="${Math.floor(pad / 2)}" w:type="dxa"/><w:right w:w="${Math.floor(pad / 2)}" w:type="dxa"/></w:tcMar>`
          : '';
      const direction = block.direction ? '<w:textDirection w:val="tbRl"/>' : '';
      const vAlign = sourceLines && cell.rowSpan > 1 ? '<w:vAlign w:val="center"/>' : '';
      cells.push(
        `<w:tc><w:tcPr>${tcPr}${sourceMargins}${direction}${vAlign}</w:tcPr>${body || blankXml(size)}</w:tc>`,
      );
      c += span;
    }
    let rowHeight = block.direction
      ? Math.round(
          (Math.max(
            0,
            ...table.cells
              .filter((c) => c.row === r && c.box)
              .map((c) => c.box!.height / c.rowSpan),
          ) /
            page.width) *
            (page.paper?.width ?? PAGE_W / 20) *
            20,
        )
      : page.paper
        ? Math.round(metrics.heightAt(r, spaceScale))
        : 0;
    // trHeight is the minimum height within a cell; outer drawn 0.5 pt row borders still take up height, so we must not add height for them on every row.
    if (rowHeight && !block.borderless) rowHeight = Math.max(1, rowHeight - 10);
    rows.push(
      `<w:tr>${rowHeight ? `<w:trPr><w:trHeight w:val="${rowHeight}" w:hRule="atLeast"/></w:trPr>` : ''}${cells.join('')}</w:tr>`,
    );
  }
  // Borderless tables identified by column alignment without explicit lines in the original image (D-471) do not have borders drawn.
  const border = (side: string) =>
    block.borderless
      ? `<w:${side} w:val="nil"/>`
      : `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="000000"/>`;
  return (
    '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>' +
    (left ? `<w:tblInd w:w="${left}" w:type="dxa"/>` : '') +
    // Schema order: tblBorders must precede tblLayout.
    '<w:tblBorders>' +
    ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(border).join('') +
    `</w:tblBorders><w:tblLayout w:type="fixed"/>${cellMarginsXml()}</w:tblPr><w:tblGrid>` +
    widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('') +
    `</w:tblGrid>${rows.join('')}</w:tbl>`
  );
}

/** Proportionally shrink column widths if they exceed maxWidth, with each column being at least 200 twips. */
function fitWidths(raw: readonly number[], maxWidth: number): number[] {
  const k = Math.min(1, maxWidth / (raw.reduce((a, b) => a + b, 0) || 1));
  return raw.map((w) => Math.max(200, Math.round(w * k)));
}

/** Borderless layout tables (D-331, D-332): rows are XML fragments for each cell in each row; each cell ends with a paragraph (required by Word). */
function layoutTableXml(
  widths: readonly number[],
  rows: readonly (readonly string[])[],
  size: number,
  left = 0,
): string {
  const none = (side: string) => `<w:${side} w:val="nil"/>`;
  const tr = (cells: readonly string[]) =>
    '<w:tr>' +
    cells
      .map((inner, i) => {
        const ends = inner.endsWith('</w:p>');
        return `<w:tc><w:tcPr><w:tcW w:w="${widths[i]}" w:type="dxa"/></w:tcPr>${inner}${ends ? '' : blankXml(size)}</w:tc>`;
      })
      .join('') +
    '</w:tr>';
  return (
    `<w:tbl><w:tblPr><w:tblW w:w="${widths.reduce((a, b) => a + b, 0)}" w:type="dxa"/>` +
    (left ? `<w:tblInd w:w="${left}" w:type="dxa"/>` : '') +
    '<w:tblBorders>' +
    ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(none).join('') +
    `</w:tblBorders><w:tblLayout w:type="fixed"/>${cellMarginsXml()}</w:tblPr><w:tblGrid>` +
    widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('') +
    `</w:tblGrid>${rows.map(tr).join('')}</w:tbl>`
  );
}

function imageXml(
  rid: string,
  id: number,
  cx: number,
  cy: number,
  pPr = '',
  background = false,
): string {
  return (
    `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}<w:r><w:rPr><w:sz w:val="2"/><w:szCs w:val="2"/></w:rPr><w:drawing>` +
    (background
      ? '<wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="0" behindDoc="1" locked="0" layoutInCell="0" allowOverlap="1">' +
        '<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>0</wp:posOffset></wp:positionH>' +
        '<wp:positionV relativeFrom="page"><wp:posOffset>0</wp:posOffset></wp:positionV>' +
        `<wp:extent cx="${cx}" cy="${cy}"/><wp:wrapNone/>`
      : `<wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/>`) +
    `<wp:docPr id="${id}" name="Picture ${id}"/>` +
    '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
    '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    `<pic:nvPicPr><pic:cNvPr id="${id}" name="image${id}.jpg"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>' +
    '</a:graphicData></a:graphic>' +
    (background ? '</wp:anchor>' : '</wp:inline>') +
    '</w:drawing></w:r></w:p>'
  );
}

/** List numbering definitions (one per list, starting numbering from its own first item). */
function numberingXml(lists: readonly DocList[]): string {
  const abstracts = lists.map((list, i) => {
    const fmt = !list.ordered
      ? 'bullet'
      : list.format === '%1' && list.start !== undefined
        ? 'decimalEnclosedCircle'
        : 'decimal';
    const text = list.ordered ? (list.format ?? '%1.') : '•';
    return (
      `<w:abstractNum w:abstractNumId="${i}"><w:multiLevelType w:val="singleLevel"/>` +
      `<w:lvl w:ilvl="0"><w:start w:val="${list.start ?? 1}"/><w:numFmt w:val="${fmt}"/>` +
      `<w:lvlText w:val="${escapeXml(text)}"/><w:lvlJc w:val="left"/>` +
      '<w:pPr><w:ind w:left="420" w:hanging="420"/></w:pPr></w:lvl></w:abstractNum>'
    );
  });
  const nums = lists.map(
    (_, i) => `<w:num w:numId="${i + 1}"><w:abstractNumId w:val="${i}"/></w:num>`,
  );
  return `${HEAD}<w:numbering xmlns:w="${W_NS}">${abstracts.join('')}${nums.join('')}</w:numbering>`;
}

function stylesXml(bodySize: number): string {
  const sz = Math.round(bodySize * 2);
  const heading = (id: string, name: string, size: number) =>
    `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/>` +
    `<w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/>` +
    `<w:outlineLvl w:val="${id === 'Heading1' ? 0 : 1}"/></w:pPr>` +
    `<w:rPr><w:b/><w:bCs/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`;
  return (
    `${HEAD}<w:styles xmlns:w="${W_NS}">` +
    '<w:docDefaults><w:rPrDefault><w:rPr>' +
    RUN_FONTS +
    `<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr></w:rPrDefault>` +
    '<w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault>' +
    '</w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
    heading('Heading1', 'heading 1', Math.round(sz * HEADING_SCALE.Heading1!)) +
    heading('Heading2', 'heading 2', Math.round(sz * HEADING_SCALE.Heading2!)) +
    '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/>' +
    '<w:basedOn w:val="Normal"/><w:qFormat/></w:style>' +
    '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/>' +
    `<w:tblPr>${cellMarginsXml()}</w:tblPr></w:style>` +
    '</w:styles>'
  );
}

/**
 * Write docx. images provides cropped image bytes keyed by image block src; missing image blocks
 * are skipped. The default body font size uses the first page's size; each run writes its own
 * page's font size (D-335).
 */
export function writeDocx(
  doc: DocDoc,
  images: ReadonlyMap<string, DocxImage> = new Map(),
): Uint8Array {
  const docSize = doc.pages[0]?.bodySize ?? 11;
  const lists: DocList[] = [];
  const media: { name: string; rid: string; bytes: Uint8Array }[] = [];
  const body: string[] = [];
  const sections = doc.pages.some((p) => p.paper);
  const geometry = (page?: DocPage) => {
    const width = page?.paper ? Math.round(page.paper.width * 20) : PAGE_W;
    const height = page?.paper ? Math.round(page.paper.height * 20) : PAGE_H;
    const maxMargin = Math.min(MARGIN, Math.floor(width / 4), Math.floor(height / 4));
    const margins = Object.fromEntries(
      ['top', 'right', 'bottom', 'left'].map((side) => [
        side,
        Math.max(
          0,
          Math.min(
            maxMargin,
            page?.margins
              ? Math.round(page.margins[side as keyof NonNullable<DocPage['margins']>] * 20)
              : maxMargin,
          ),
        ),
      ]),
    ) as Record<'top' | 'right' | 'bottom' | 'left', number>;
    // Word forces retention of the paragraph after a table; when source content adheres to the lower margin, this invisible line height must be preserved in the bottom page margin.
    const last = page?.blocks.filter((b) => !(b.kind === 'image' && b.background)).at(-1);
    const separators =
      last?.kind === 'table'
        ? 1
        : last?.kind === 'row'
          ? last.cells.some((c) => c.blocks.some((b) => b.kind === 'table'))
            ? 2
            : 1
          : 0;
    if (page?.paper)
      margins.bottom = Math.max(0, margins.bottom - Math.ceil(separators * LINE_HEIGHT * 20));
    return { width, height, margins };
  };
  const sectionXml = (page?: DocPage, next = false) => {
    const { width, height, margins: m } = geometry(page);
    return (
      '<w:sectPr>' +
      (next ? '<w:type w:val="nextPage"/>' : '') +
      `<w:pgSz w:w="${width}" w:h="${height}"${width > height ? ' w:orient="landscape"' : ''}/>` +
      `<w:pgMar w:top="${m.top}" w:right="${m.right}" w:bottom="${m.bottom}" w:left="${m.left}" w:header="${Math.min(567, m.top)}" w:footer="${Math.min(567, m.bottom)}" w:gutter="0"/></w:sectPr>`
    );
  };
  doc.pages.forEach((page, p) => {
    const { width: PAGE_W, height: PAGE_H, margins } = geometry(page);
    const CONTENT_W = PAGE_W - margins.left - margins.right;
    const CONTENT_H = PAGE_H - margins.top - margins.bottom;
    if (sections && p > 0)
      body.push(
        // sectPr must be the last child element of pPr (schema order).
        `<w:p><w:pPr><w:spacing w:line="1" w:lineRule="exact"/>${sectionXml(doc.pages[p - 1], true)}</w:pPr></w:p>`,
      );
    const pageStart = body.length;
    // Write the text of each page using that page's body font size (D-335: body font sizes may differ significantly between form pages and text pages).
    const bodySize = page.bodySize ?? docSize;
    let first = p > 0 && !sections;
    const pageBreak = () => {
      const b = first;
      first = false;
      return b;
    };
    const twip = (px: number) => Math.round((px / page.width) * PAGE_W);
    const yTwip = (px: number) => (page.paper ? Math.round((px / page.height) * PAGE_H) : twip(px));
    // Position (D-463): left indent is calculated from the A4 left margin (or from the leftmost
    // character if characters in the original image are further left); paragraph-before spacing is
    // the vacant height between this block and the previous one in the original image. When the
    // combined height of text and whitespace exceeds the A4 content area in Word, but fits on a
    // single page based on text alone, the paragraph-before spacing is scaled down proportionally
    // so the original document remains a single page (text pages exceeding one page natively are
    // not shrunk, but spacing between paragraphs is still preserved).
    const marginPx = page.paper
      ? (margins.top / PAGE_H) * page.height
      : (margins.top / PAGE_W) * page.width;
    const foreground = page.blocks.filter((b) => !(b.kind === 'image' && b.background));
    const leaves = leafBlocks({ blocks: foreground });
    // Like page margins, calculated based on text (doc.ts): images hugging the paper edge do not push the indent of all text to the right; images positioned further left than this have an indent of 0.
    const textLeaves = leaves.filter((b) => b.kind !== 'image');
    const base = Math.min(
      (margins.left / PAGE_W) * page.width,
      ...(textLeaves.length ? textLeaves : leaves).map((b) => b.box.x),
    );
    // Align blocks with nearly identical left alignments (recognition bounding boxes always have a
    // few pixels of jitter) to the same position, otherwise every paragraph's indent would differ
    // by a few points, resulting in a jagged left edge in Word. Items within 0.7 character widths
    // of difference are grouped together, taking the leftmost of the group.
    const emPx = (bodySize / (PAGE_W / 20)) * page.width;
    const snap = new Map<number, number>();
    let anchor = -Infinity;
    for (const x of [...new Set(leaves.map((b) => b.box.x))].sort((a, b) => a - b)) {
      if (x - anchor > SNAP_EM * emPx) anchor = x;
      snap.set(x, anchor);
    }
    const metricsCache = new Map<DocTable, Map<string, ReturnType<typeof tableMetrics>>>();
    const measureTable = (block: DocTable, width: number, fontWidth: number) => {
      let cache = metricsCache.get(block);
      if (!cache) {
        cache = new Map();
        metricsCache.set(block, cache);
      }
      const key = `${width}:${fontWidth}`;
      let metrics = cache.get(key);
      if (!metrics) {
        metrics = tableMetrics(block, page, bodySize, width, fontWidth);
        cache.set(key, metrics);
      }
      return metrics;
    };
    let fit = 1;
    let pictureScale = 1;
    // Pages with known paper dimensions need to fully account for default Arial line box top/bottom overhangs; font height is not the full line height.
    const leading = page.paper ? 1.34 : LINE_HEIGHT;
    const blankHeight = Math.round(LINE_HEIGHT * bodySize * 20);
    /**
     * Previous block: top, bottom (original pixels), and the height it occupies in Word (twips,
     * including appended empty paragraphs). Paragraph-before spacing is calculated from top to
     * top (the bottom of a recognition bounding box extends downward with letters like p and g,
     * whereas the top is more stable).
     */
    interface Flow {
      top: number;
      bottom: number;
      height: number;
    }
    const sizeOf = (b: DocParagraph) =>
      b.size ?? (b.heading ? bodySize * HEADING_SCALE[`Heading${b.heading}`]! : bodySize);
    // Paragraphs that span only a single line in the original image; required width for a single line in Word (calculated from export font size and measured word width, plus margins and cell padding).
    const oneLine = (b: DocParagraph) =>
      !/[\n\t]/.test(b.text) && twip(b.box.height) <= 1.5 * LINE_HEIGHT * sizeOf(b) * 20;
    const lineWidth = (b: DocParagraph, em = textEm(b.text)) =>
      Math.ceil(em * sizeOf(b) * 20 * WIDTH_SLACK + 2 * CELL_PAD);
    /**
     * The last cell spans only the width of those few characters in the original image (page
     * numbers like "1/3", "Page 2 of 5", labels like "AUTRE TOTAL" pinned to the right): Word's
     * Arial is wider than the original characters, so if it does not fit, it wraps character by
     * character. When no blank space is available to borrow on the right, borrow from unused
     * widths in preceding cells such that the longest word in single-line items fits on one line,
     * while multi-line titles and centered items remain unbroken (borrowing to the left would
     * shift their positions, D-526); preceding cells are not shrunk narrower than their own text
     * width.
     */
    const lendToLast = (row: DocRow, widths: number[]) => {
      const last = row.cells.at(-1)!;
      const texts = last.blocks.filter((b): b is DocParagraph => b.kind === 'paragraph' && !b.tab);
      if (!texts.length || texts.length !== last.blocks.length) return;
      const wanted = Math.max(
        ...texts.map((b) =>
          oneLine(b) && !b.heading && b.align !== 'center'
            ? lineWidth(b)
            : lineWidth(b, longestWordEm(b.text)),
        ),
      );
      let deficit = wanted - widths.at(-1)!;
      for (let i = widths.length - 2; i >= 0 && deficit > 0; i--) {
        const blocks = row.cells[i]!.blocks;
        const from = Math.min(...blocks.map((b) => b.box.x));
        const own = Math.max(
          2 * CELL_PAD,
          ...blocks.map(
            (b) =>
              twip(b.box.x - from) +
              (b.kind === 'paragraph' && !b.tab && oneLine(b)
                ? lineWidth(b)
                : twip(b.box.width) + 2 * CELL_PAD),
          ),
        );
        const lend = Math.min(deficit, Math.max(0, widths[i]! - own));
        widths[i]! -= lend;
        widths[widths.length - 1]! += lend;
        deficit -= lend;
      }
    };
    const nestedWidths = (row: DocRow, max: number) => {
      const widths = fitWidths(
        row.cells.map((c) => twip(c.width)),
        max,
      );
      const last = row.cells.at(-1)!;
      const needed = Math.max(
        widths.at(-1)!,
        ...last.blocks
          .filter(
            (b): b is DocParagraph => b.kind === 'paragraph' && !b.tab && !/[\n\t]/.test(b.text),
          )
          .map((b) =>
            Math.ceil(textEm(b.text) * (b.size ?? bodySize) * 20 * WIDTH_SLACK + 2 * CELL_PAD),
          ),
      );
      const spare = Math.max(0, max - widths.reduce((n, w) => n + w, 0));
      widths[widths.length - 1]! += Math.min(spare, needed - widths.at(-1)!);
      lendToLast(row, widths);
      return widths;
    };
    // Approximate height of a block in Word (twips): text height based on original line count multiplied by line height, tables and images based on original height.
    const heightOf = (block: DocBlock, maxWidth = CONTENT_W, from = base): number => {
      const h = yTwip(block.box.height);
      const left = block.kind === 'row' ? 0 : leftOf(block, from, maxWidth);
      const available = Math.max(1, maxWidth - left);
      const wrapped = (text: string, size: number, width: number) =>
        text
          .split('\n')
          .reduce(
            (n, line) =>
              n +
              Math.max(1, Math.ceil((textEm(line) * size * 20 * WIDTH_SLACK) / Math.max(1, width))),
            0,
          );
      if (block.kind === 'paragraph' && !block.tab) {
        const size = block.size || bodySize;
        const one = leading * size * 20;
        return (
          Math.max(
            1,
            Math.round(h / one),
            wrapped(block.text, size, available - twip(block.indent ?? 0)),
          ) * one
        );
      }
      if (block.kind === 'list') {
        const one = leading * (block.size || bodySize) * 20;
        const lines = block.items.reduce(
          (n, item) => n + wrapped(item, block.size || bodySize, available - 420),
          0,
        );
        return Math.max(lines, Math.round(h / one)) * one;
      }
      if (page.paper && block.kind === 'row') {
        const widths = nestedWidths(block, maxWidth);
        const measured = block.cells.map((cell, i) => {
          const flow: Flow = { top: block.box.y, bottom: block.box.y, height: 0 };
          let total = 0;
          const from = Math.min(...cell.blocks.map((b) => b.box.x));
          for (const child of flowCellBlocks(cell.blocks, emPx)) {
            const height = heightOf(child, Math.max(1, widths[i]! - 2 * CELL_PAD), from);
            total += (beforeOf(child, flow) ?? 0) + height;
            flow.top = child.box.y;
            flow.bottom = child.box.y + child.box.height;
            flow.height = height;
          }
          return total;
        });
        return Math.max(0, ...measured) + LINE_HEIGHT * 20;
      }
      if (page.paper && block.kind === 'table' && !block.direction) {
        const m = measureTable(
          block,
          available,
          Math.min(maxWidth, PAGE_W * TABLE_FONT_PAGE_SHARE) - left,
        );
        return m.minimum.reduce((n, _v, i) => n + m.heightAt(i, fit), 0) + LINE_HEIGHT * 20;
      }
      if (block.kind === 'space') return h;
      if (page.paper && block.kind === 'image' && block.src && images.has(block.src)) {
        const image = images.get(block.src)!;
        const w = (block.box.width / page.width) * PAGE_W,
          h = (w * image.height) / Math.max(1, image.width);
        return (
          h *
            Math.min(1, maxWidth / Math.max(1, w), (CONTENT_H * 0.9) / Math.max(1, h)) *
            pictureScale +
          20
        );
      }
      return block.kind === 'image' ? h + (page.paper ? bodySize * 6 : 0) : h + LINE_HEIGHT * 20;
    };
    // Paragraph-before spacing (twips); absent when located on or overlapping the previous block
    // (where position cannot be utilized, e.g., text-to-Word placeholder frames), written as
    // spaced. The first block of a page (or cell) does not add spacing if it is less than one line
    // away from the top (top of characters slightly offset from page margin).
    const beforeOf = (block: DocBlock, flow: Flow): number | undefined => {
      if (block.box.y < flow.bottom && !page.paper) return undefined;
      const v = (yTwip(block.box.y - flow.top) - flow.height) * fit;
      if (!flow.height && v < blankHeight && !page.paper) return 0;
      return Math.max(0, Math.round(v / 10) * 10);
    };
    const advance = (flow: Flow, block: DocBlock, maxWidth = CONTENT_W, from = base) => {
      flow.top = block.box.y;
      flow.bottom = block.box.y + block.box.height;
      flow.height = heightOf(block, maxWidth, from);
    };
    // Left indent (twips): zero for centered and right-aligned paragraphs; single-line paragraphs
    // are indented only if they fit (preventing wrapping to the next line). Paragraphs that cannot
    // fit on a single line even when flush-left at the margin will wrap anyway, so indentation is
    // not sacrificed for remaining space: aligned with titles and short paragraphs sharing the same
    // left edge (otherwise wider paragraphs would have smaller indents, causing a ragged left
    // margin, EU samples 053, 057).
    let wrappedIndent = true;
    const leftOf = (block: DocLeaf, from: number, maxWidth: number): number => {
      if (block.kind === 'paragraph' && block.tab) return 0;
      if (
        block.kind !== 'image' &&
        block.kind !== 'table' &&
        block.kind !== 'space' &&
        block.align &&
        block.align !== 'left'
      )
        return 0;
      const room = maxWidth - twip(block.box.width) * (block.kind === 'table' ? 1 : WIDTH_SLACK);
      const offset = twip((snap.get(block.box.x) ?? block.box.x) - from);
      const wraps =
        wrappedIndent &&
        block.kind === 'paragraph' &&
        !/[\n\t]/.test(block.text) &&
        textEm(block.text) * sizeOf(block) * 20 * WIDTH_SLACK > maxWidth;
      const v = wraps ? offset : Math.min(offset, Math.max(0, room));
      return v >= MIN_INDENT ? Math.round(v / 10) * 10 : 0;
    };
    // Spacing before a table: a 1 pt empty paragraph with paragraph-before spacing.
    const spacerXml = (before: number | undefined) =>
      before !== undefined && before >= MIN_BEFORE
        ? `<w:p><w:pPr><w:spacing w:before="${before}" w:line="240" w:lineRule="auto"/>` +
          '<w:rPr><w:sz w:val="2"/><w:szCs w:val="2"/></w:rPr></w:pPr></w:p>'
        : '';
    interface Place {
      before?: number;
      left: number;
    }
    // XML for a block; maxWidth is the available width (twips): the full content area or a cell in a multi-column row.
    const leafXml = (
      block: DocLeaf,
      maxWidth: number,
      place: Place,
      fontMaxWidth = maxWidth,
    ): string[] => {
      const { before, left } = place;
      switch (block.kind) {
        case 'paragraph':
          if (block.tab) {
            // Form labels and values (D-332): two-column borderless table, one pair per row (tab
            // stops would jump to the next tab stop if a label is longer than in the original,
            // pushing the value to the next line). The label column is sized based on the value's
            // position in the original image (at most 60%), and the value column occupies the
            // remaining available space to the right.
            const label = Math.round(Math.min(twip(block.tab), 0.6 * maxWidth));
            const widths = [label, Math.max(200, maxWidth - label)];
            const rows = splitRuns(block.runs ?? [{ text: block.text }], '\n').map((line) => {
              const [label = [], ...rest] = splitRuns(line, '\t');
              const value = rest.flatMap((part, i) => (i ? [{ text: ' ' }, ...part] : part));
              return [label, value].map((t) => paragraphXml(t, block, bodySize));
            });
            return [
              ...(pageBreak() ? [paragraphXml('', {}, bodySize, { pageBreak: true })] : []),
              spacerXml(before),
              layoutTableXml(widths, rows, bodySize),
              blankXml(1),
            ];
          }
          return [
            paragraphXml(block.runs ?? block.text, block, bodySize, {
              ...(block.heading ? { styleId: `Heading${block.heading}` } : {}),
              ...(block.indent ? { indent: twip(block.indent) } : {}),
              ...(before !== undefined ? { before } : block.spaced ? { spaced: true } : {}),
              ...(left ? { left } : {}),
              ...(pageBreak() ? { pageBreak: true } : {}),
            }),
          ];
        case 'list': {
          lists.push(block);
          const numId = lists.length;
          return block.items.map((item, i) =>
            paragraphXml(block.itemRuns?.[i] ?? item, block, bodySize, {
              styleId: 'ListParagraph',
              numId,
              ...(i === 0 && before !== undefined
                ? { before }
                : i === 0 && block.spaced
                  ? { spaced: true }
                  : {}),
              ...(left ? { left } : {}),
              ...(i === 0 && pageBreak() ? { pageBreak: true } : {}),
            }),
          );
        }
        case 'table':
          return [
            ...(pageBreak() ? [paragraphXml('', {}, bodySize, { pageBreak: true })] : []),
            spacerXml(before),
            tableXml(
              block,
              page,
              bodySize,
              maxWidth - left,
              left,
              Math.max(200, fontMaxWidth - left),
              fit,
            ),
            // When two tables are adjacent, Word combines them into one: append an empty paragraph after.
            blankXml(1),
          ];
        case 'space':
          return [
            `<w:p><w:pPr><w:spacing w:before="${before ?? 0}" w:after="0" w:line="${Math.max(1, twip(block.box.height))}" w:lineRule="exact"/><w:rPr><w:sz w:val="2"/></w:rPr></w:pPr></w:p>`,
          ];
        case 'image': {
          const image = block.src ? images.get(block.src) : undefined;
          if (!image) return [];
          const n = media.length + 1;
          const rid = `rIdImg${n}`;
          // Extracted image format is JPG; images read from external docx files (D-509) might also be PNG, GIF, or BMP, identified via file header magic bytes.
          const ext = imageExt(image.bytes) ?? 'jpg';
          media.push({ name: `image${n}.${ext}`, rid, bytes: image.bytes });
          if (block.background)
            return [
              imageXml(
                rid,
                n,
                Math.round(PAGE_W * EMU_PER_TWIP),
                Math.round(PAGE_H * EMU_PER_TWIP),
                '<w:spacing w:before="0" w:after="0" w:line="1" w:lineRule="exact"/><w:rPr><w:sz w:val="2"/></w:rPr>',
                true,
              ),
            ];
          const out = pageBreak() ? [paragraphXml('', {}, bodySize, { pageBreak: true })] : [];
          // Size based on the width occupied in the original image, scaled down proportionally if it does not fit.
          let w = (block.box.width / page.width) * PAGE_W;
          let h = (w * image.height) / Math.max(1, image.width);
          const k = Math.min(1, maxWidth / w, (CONTENT_H * 0.9) / h);
          w *= k * pictureScale;
          h *= k * pictureScale;
          // Schema order: spacing, ind; paragraph mark rPr comes last.
          const pPr =
            (page.paper
              ? `<w:spacing w:before="${before ?? 0}" w:after="0" w:line="240" w:lineRule="auto"/>`
              : before !== undefined && before >= MIN_BEFORE
                ? `<w:spacing w:before="${before}"/>`
                : '') +
            (left ? `<w:ind w:left="${left}"/>` : '') +
            (page.paper ? '<w:rPr><w:sz w:val="2"/><w:szCs w:val="2"/></w:rPr>' : '');
          out.push(
            imageXml(rid, n, Math.round(w * EMU_PER_TWIP), Math.round(h * EMU_PER_TWIP), pPr),
          );
          return out;
        }
      }
    };
    const cellXml = (
      blocks: readonly DocLeaf[],
      max: number,
      top: number,
      fontMax: number,
    ): string => {
      const flow: Flow = { top, bottom: top, height: 0 };
      const from = Math.min(...blocks.map((b) => b.box.x));
      return flowCellBlocks(blocks, emPx)
        .flatMap((b) => {
          const before = beforeOf(b, flow);
          advance(flow, b, max, from);
          if (b.kind !== 'row')
            return leafXml(
              b,
              max,
              { ...(before !== undefined ? { before } : {}), left: leftOf(b, from, max) },
              fontMax,
            );
          const widths = nestedWidths(b, max);
          const cells = b.cells.map((c, i) =>
            cellXml(
              c.blocks,
              Math.max(1, widths[i]! - CELL_PAD * 2),
              b.box.y,
              Math.min(fontMax, widths[i]! - CELL_PAD * 2),
            ),
          );
          return [spacerXml(before), layoutTableXml(widths, [cells], 1), blankXml(1)];
        })
        .join('');
    };
    {
      const measure = () => {
        const dry: Flow = { top: marginPx, bottom: marginPx, height: 0 };
        let total = 0;
        for (const block of foreground) {
          total += (beforeOf(block, dry) ?? 0) + heightOf(block);
          advance(dry, block);
        }
        return total;
      };
      if (measure() > CONTENT_H - (page.paper ? Math.round(leading * bodySize * 20) : 0)) {
        if (page.paper) {
          // When whitespace is compressed to zero and the image is shrunk to minimum size yet still fails to fit on the page (body text naturally requiring pagination), whitespace is not compressed: maintain normal paragraph spacing and normal pagination.
          fit = 0;
          pictureScale = leaves.some((b) => b.kind === 'image') ? 0.25 : 1;
          // Retaining original indentation on wrapping paragraphs causes extra line wraps: thus, when it does not fit on a page, surrender indentation to the remaining space (avoiding an extra page overflow).
          if (measure() > CONTENT_H - Math.round(leading * bodySize * 20)) wrappedIndent = false;
          const fits = measure() <= CONTENT_H - Math.round(leading * bodySize * 20);
          fit = 1;
          pictureScale = 1;
          if (fits) {
            let lo = 0,
              hi = 1;
            for (let i = 0; i < 12; i++) {
              fit = (lo + hi) / 2;
              // Leave a one-line margin for font substitution and last-line wrapping; compress source whitespace only, without shrinking body text or letting text overlap images.
              if (measure() > CONTENT_H - Math.round(leading * bodySize * 20)) hi = fit;
              else lo = fit;
            }
            fit = lo;
            // Normal paragraph line height plus the full image itself may exceed the source page; image is scaled proportionally only after source whitespace is compressed to the limit, without shrinking body text font size.
            if (
              measure() > CONTENT_H - Math.round(leading * bodySize * 20) &&
              leaves.some((b) => b.kind === 'image')
            ) {
              let low = 0.25,
                high = 1;
              pictureScale = low;
              // When body text naturally requires pagination, image scaling cannot resolve overflow; retain original image dimensions and proceed with normal pagination.
              const feasible = measure() <= CONTENT_H - Math.round(leading * bodySize * 20);
              for (let i = 0; feasible && i < 12; i++) {
                pictureScale = (low + high) / 2;
                if (measure() > CONTENT_H - Math.round(leading * bodySize * 20))
                  high = pictureScale;
                else low = pictureScale;
              }
              pictureScale = feasible ? low : 1;
            }
          }
        } else {
          const dry: Flow = { top: marginPx, bottom: marginPx, height: 0 };
          let gaps = 0,
            heights = 0;
          for (const block of foreground) {
            gaps += beforeOf(block, dry) ?? 0;
            heights += heightOf(block);
            advance(dry, block);
          }
          if (gaps > 0 && heights < CONTENT_H) fit = Math.max(0, (CONTENT_H - heights) / gaps);
        }
      }
    }
    const flow: Flow = { top: marginPx, bottom: marginPx, height: 0 };
    for (const block of foreground) {
      const before = beforeOf(block, flow);
      advance(flow, block);
      if (block.kind !== 'row') {
        body.push(
          ...leafXml(
            block,
            CONTENT_W,
            {
              ...(before !== undefined ? { before } : {}),
              left: leftOf(block, base, CONTENT_W),
            },
            Math.min(CONTENT_W, PAGE_W * TABLE_FONT_PAGE_SHARE),
          ),
        );
        continue;
      }
      // Side-by-side layout (D-331): borderless layout table, single row, cell widths based on original image positions, scaled down proportionally if they do not fit.
      if (pageBreak()) body.push(paragraphXml('', {}, bodySize, { pageBreak: true }));
      body.push(spacerXml(before));
      const widths = fitWidths(
        block.cells.map((c) => twip(c.width)),
        CONTENT_W,
      );
      // Margin correction only expands column widths without enlarging already-recognized table fonts.
      const fontWidths = fitWidths(
        block.cells.map((c) => twip(c.width)),
        Math.min(CONTENT_W, PAGE_W * TABLE_FONT_PAGE_SHARE),
      );
      // The original image width of the last column extends only to the right edge of the text, not
      // necessarily the right edge of available space. Single-line left-aligned paragraphs and
      // centered titles in the original image have their word widths measured at export font size
      // plus padding, borrowing right-side whitespace; preceding columns remain untouched.
      const last = block.cells.at(-1)!;
      const from = Math.min(...last.blocks.map((b) => b.box.x));
      let needed = widths.at(-1)!;
      for (const b of last.blocks) {
        if (b.kind !== 'paragraph' || b.tab || /[\n\t]/.test(b.text)) continue;
        const centeredHeading = b.heading !== undefined && b.align === 'center';
        if (b.align && b.align !== 'left' && !centeredHeading) continue;
        const size =
          b.size ?? (b.heading ? bodySize * HEADING_SCALE[`Heading${b.heading}`]! : bodySize);
        // Only widen trusted single lines for newly added centered headings; do not stretch originally multi-line headings into a single line, keeping existing left-aligned paths unchanged.
        if (twip(b.box.height) > (centeredHeading ? 1 : 1.5) * LINE_HEIGHT * size * 20) continue;
        const runs = b.runs ?? [{ text: b.text }];
        const textWidth = runs.reduce(
          // textEm removes leading and trailing whitespace by default; spaces between runs also occupy width, preserved using characters at both ends.
          (sum, r) => sum + (textEm(`|${r.text}|`) - 2 * textEm('|')) * (r.size ?? size) * 20,
          0,
        );
        needed = Math.max(
          needed,
          Math.ceil(
            textWidth * WIDTH_SLACK + 2 * CELL_PAD + twip(b.box.x - from + (b.indent ?? 0)),
          ),
        );
      }
      const spare = Math.max(0, CONTENT_W - widths.reduce((a, b) => a + b, 0));
      widths[widths.length - 1]! += Math.min(spare, needed - widths.at(-1)!);
      // When an entire row is shrunk, an unbreakable short label on the right must still retain
      // adequate word width and padding. Borrow the minimum required width solely from preceding
      // wrap-eligible body text, without enlarging the page or compressing titles, tables, or
      // images.
      const labels = last.blocks.filter((b) => b.kind === 'paragraph');
      const previousCell = block.cells.at(-2);
      const prose = previousCell?.blocks.filter((b) => b.kind === 'paragraph') ?? [];
      if (
        labels.length > 0 &&
        labels.length === last.blocks.length &&
        labels.every(
          (b) =>
            b.align === 'right' &&
            !b.heading &&
            !b.tab &&
            !/[\n\t]/.test(b.text) &&
            b.text.trim().split(/\s+/).length <= 3 &&
            b.text.length <= 32,
        ) &&
        previousCell &&
        prose.length === previousCell.blocks.length &&
        prose.every((b) => !b.heading && !b.tab) &&
        prose.some((b) => /\s/.test(b.text))
      ) {
        const minimum = (b: (typeof labels)[number]) =>
          Math.ceil(longestWordEm(b.text) * (b.size ?? bodySize) * 20 * WIDTH_SLACK + 2 * CELL_PAD);
        const labelWidth = Math.max(
          ...labels.map((b) =>
            Math.ceil(textEm(b.text) * (b.size ?? bodySize) * 20 * WIDTH_SLACK + 2 * CELL_PAD),
          ),
        );
        const proseWidth = Math.max(...prose.map(minimum));
        if (labelWidth <= CONTENT_W / 5) {
          const borrowed = Math.max(
            0,
            Math.min(labelWidth - widths.at(-1)!, widths[widths.length - 2]! - proseWidth),
          );
          widths[widths.length - 1]! += borrowed;
          widths[widths.length - 2]! -= borrowed;
        }
      }
      lendToLast(block, widths);
      // Left side-by-side elements in the original image (labels and address windows on the right
      // half of an invoice): indent the entire row to the right rather than shifting everything to
      // the left page margin; utilize only the available blank width on the right of the cell,
      // keeping cell widths unchanged.
      const shift = Math.min(
        twip((snap.get(block.box.x) ?? block.box.x) - base),
        CONTENT_W - widths.reduce((a, b) => a + b, 0),
      );
      const indent = shift >= MIN_INDENT ? Math.round(shift / 10) * 10 : 0;
      // Leave a small margin inside cells; tables and images inside cells scale down to cell width; positions inside cells are calculated relative to the cell's top-left corner.
      const cells = block.cells.map((cell, i) => {
        const max = widths[i]! - 2 * CELL_PAD;
        return cellXml(cell.blocks, max, block.box.y, fontWidths[i]! - 2 * CELL_PAD);
      });
      body.push(layoutTableXml(widths, [cells], bodySize, indent), blankXml(1));
    }
    // Place anchors only into existing paragraphs outside tables; do not add body text lines or cause vertical table cells to contribute background images to height measurement.
    const drawings = page.blocks
      .filter((b) => b.kind === 'image' && b.background)
      .flatMap((b) => {
        if (b.kind !== 'image') return [];
        return leafXml(b, CONTENT_W, { left: 0 }).map((xml) =>
          xml.slice(xml.indexOf('<w:r>'), xml.lastIndexOf('</w:p>')),
        );
      })
      .join('');
    if (drawings) {
      const at = body.findIndex((xml, i) => i >= pageStart && xml.startsWith('<w:p>'));
      if (at >= 0) body[at] = body[at]!.replace('</w:p>', drawings + '</w:p>');
      else
        body.splice(
          pageStart,
          0,
          `<w:p><w:pPr>${pageBreak() ? '<w:pageBreakBefore/>' : ''}<w:spacing w:before="0" w:after="0" w:line="1" w:lineRule="exact"/><w:rPr><w:sz w:val="2"/><w:szCs w:val="2"/></w:rPr></w:pPr>${drawings}</w:p>`,
        );
    }
  });
  const documentXml =
    `${HEAD}<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}" ` +
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">' +
    `<w:body>${body.join('')}` +
    sectionXml(doc.pages.at(-1)) +
    '</w:body></w:document>';
  const files: Zippable = {
    '[Content_Types].xml': strToU8(
      HEAD +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Default Extension="jpg" ContentType="image/jpeg"/>' +
        '<Default Extension="png" ContentType="image/png"/>' +
        '<Default Extension="gif" ContentType="image/gif"/>' +
        '<Default Extension="bmp" ContentType="image/bmp"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
        '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
        '<Override PartName="/word/fontTable.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml"/>' +
        '</Types>',
    ),
    '_rels/.rels': strToU8(
      HEAD +
        `<Relationships xmlns="${PKG_REL}">` +
        `<Relationship Id="rId1" Type="${R_NS}/officeDocument" Target="word/document.xml"/>` +
        '</Relationships>',
    ),
    'word/_rels/document.xml.rels': strToU8(
      HEAD +
        `<Relationships xmlns="${PKG_REL}">` +
        `<Relationship Id="rId1" Type="${R_NS}/styles" Target="styles.xml"/>` +
        `<Relationship Id="rId2" Type="${R_NS}/numbering" Target="numbering.xml"/>` +
        `<Relationship Id="rId3" Type="${R_NS}/fontTable" Target="fontTable.xml"/>` +
        media
          .map((m) => `<Relationship Id="${m.rid}" Type="${R_NS}/image" Target="media/${m.name}"/>`)
          .join('') +
        '</Relationships>',
    ),
    'word/document.xml': strToU8(documentXml),
    'word/styles.xml': strToU8(stylesXml(docSize)),
    'word/numbering.xml': strToU8(numberingXml(lists)),
    'word/fontTable.xml': strToU8(fontTableXml()),
    ...Object.fromEntries(media.map((m) => [`word/media/${m.name}`, [m.bytes, { level: 0 }]])),
  };
  return zipSync(files, { level: 6 });
}
