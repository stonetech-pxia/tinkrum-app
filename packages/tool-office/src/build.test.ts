import { describe, expect, it } from 'vitest';

import { buildTablePage, dropTrailingRows, isRuleText, sharedColumns, type Grid } from './build';
import { INVOICE, INVOICE_ITEMS } from './fixtures/invoice-ocr';
import { findLines, findTables } from './lines';
import { fakeLine, glyphs, gridRects, renderPage, type Rect } from './test-helpers';
import type { OcrBox, TableBlock, TablePage } from './types';

const W = 1000;
const H = 700;

const tablesOf = (page: TablePage) =>
  page.blocks.filter((b): b is TableBlock => b.kind === 'table');
/** Number of rows and number of cells in the first row (after column alignment to shared columns across the page, cols is the number of shared columns, not the cell count of a single row). */
const shapeOf = (t: TableBlock) => [t.rows, t.cells.filter((c) => c.row === 0).length];
const cellAt = (t: TableBlock, row: number, col: number) =>
  t.cells.find(
    (c) => c.row <= row && row < c.row + c.rowSpan && c.col <= col && col < c.col + c.colSpan,
  );

/** Cell middle line (box 120x24), text is "row r col c". */
function cellTexts(
  xs: number[],
  ys: number[],
  deg = 0,
  skip: (r: number, c: number) => boolean = () => false,
) {
  const lines: OcrBox[] = [];
  const marks: Rect[] = [];
  for (let r = 0; r < ys.length - 1; r++) {
    for (let c = 0; c < xs.length - 1; c++) {
      if (skip(r, c)) continue;
      const box = {
        x: (xs[c]! + xs[c + 1]!) / 2 - 60,
        y: (ys[r]! + ys[r + 1]!) / 2 - 12,
        width: 120,
        height: 24,
      };
      lines.push(fakeLine(`r${r}c${c}`, box, { width: W, height: H, deg }));
      marks.push(...glyphs(box.x + 10, box.y + 4, 100));
    }
  }
  return { lines, marks };
}

const build = (rects: Rect[], lines: OcrBox[], deg = 0) =>
  buildTablePage({
    image: renderPage(W, H, rects, deg),
    lines,
    name: 'Page 1',
    source: 'file:///page.jpg',
  });

describe('table structure from ruled lines (D-272)', () => {
  const xs = [100, 300, 500, 700, 900];
  const ys = [100, 160, 220, 280];

  it('leaves a text line lying wholly above the top rule outside the table (EU sample 024)', () => {
    // Immediately above the timetable header bar is a line of "01 02 04" (less than one tolerance from the top line): not text from the table.
    const { lines, marks } = cellTexts(xs, ys);
    const above = fakeLine(
      '01 02 04 06',
      { x: 520, y: 86, width: 160, height: 13 },
      { width: W, height: H },
    );
    const page = build(
      [...gridRects(xs, ys), ...marks, ...glyphs(530, 88, 140, 10)],
      [...lines, above],
    );
    const [table] = tablesOf(page);
    expect(table!.cells.some((c) => c.text.includes('01 02'))).toBe(false);
    expect(page.blocks.some((b) => b.kind === 'text' && b.text.includes('01 02 04 06'))).toBe(true);
  });

  it('keeps a framed paragraph (no inner rules) as one left-aligned cell, not one row per line (EU sample 038)', () => {
    // Cerfa form tooltip: a thin border on four sides, containing justified body text with equal left and right margins.
    const texts = [
      'When you use this specific form your doctor lets you be paid for your sick leave',
      'without the usual waiting days at the start, during which nothing is normally paid',
      'to you. If your employer keeps paying your salary during the leave, the employer',
      'is paid instead of you for every prescribed day of the leave.',
    ];
    const lines: OcrBox[] = [];
    const marks: Rect[] = [];
    texts.forEach((text, i) => {
      const box = { x: 130, y: 120 + i * 30, width: i < 3 ? 740 : 480, height: 22 };
      lines.push(fakeLine(text, box, { width: W, height: H }));
      marks.push(...glyphs(box.x + 4, box.y + 4, box.width - 8, 14));
    });
    const [table] = tablesOf(build([...gridRects([100, 900], [100, 250]), ...marks], lines));
    expect(shapeOf(table!)).toEqual([1, 1]);
    expect(table!.cells[0]!.text.split('\n')).toHaveLength(4);
    expect(table!.cells[0]!.align).toBe('left');
  });

  it('reads a fully ruled 3 × 4 table and puts each text line in its cell', () => {
    const { lines, marks } = cellTexts(xs, ys);
    const page = build([...gridRects(xs, ys), ...marks], lines);
    const [table, ...others] = tablesOf(page);
    expect(others).toHaveLength(0);
    expect(table!.rows).toBe(3);
    expect(table!.cols).toBe(4);
    expect(table!.cells).toHaveLength(12);
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 4; c++) expect(cellAt(table!, r, c)!.text).toBe(`r${r}c${c}`);
    // Column width is original image pixels (200 per column).
    for (const w of page.colWidths) expect(Math.abs(w - 200)).toBeLessThan(6);
    // No text outside the table.
    expect(page.blocks.filter((b) => b.kind === 'text')).toHaveLength(0);
  });

  it('drops "==" text read from a ruled line instead of putting it in a cell (EU sample 020)', () => {
    const { lines, marks } = cellTexts(xs, ys);
    // OCR read the first row line (dashed) as a line of "==m=", with the box center directly on the line.
    const rule = fakeLine(
      '==m=',
      { x: 320, y: 151, width: 160, height: 18 },
      { width: W, height: H },
    );
    const page = build([...gridRects(xs, ys), ...marks], [...lines, rule]);
    const [table] = tablesOf(page);
    expect(table!.rows).toBe(3);
    expect(table!.cells.some((c) => c.text.includes('='))).toBe(false);
    // Nor arranged as text outside the table.
    expect(page.blocks.filter((b) => b.kind === 'text')).toHaveLength(0);
    // Short dash representing "none" in the cell remains a character.
    expect(isRuleText('-')).toBe(false);
    expect(isRuleText('—')).toBe(false);
    expect(isRuleText('主===主')).toBe(true);
    expect(isRuleText('A-1')).toBe(false);
  });

  it('joins broken lines (photocopies) instead of merging cells', () => {
    const { lines, marks } = cellTexts(xs, ys);
    const page = build([...gridRects(xs, ys, { breakEvery: 120 }), ...marks], lines);
    const [table] = tablesOf(page);
    expect(table!.rows).toBe(3);
    expect(table!.cols).toBe(4);
    expect(table!.cells.every((c) => c.rowSpan === 1 && c.colSpan === 1)).toBe(true);
  });

  it('finds merged cells where an edge has no line', () => {
    // No vertical line between columns 2 and 3 of the first row; no horizontal line between rows 2 and 3 of the first column.
    const skip = (r: number, c: number) => (r === 0 && c === 2) || (r === 2 && c === 0);
    const { lines, marks } = cellTexts(
      xs,
      ys,
      0,
      (r, c) => skip(r, c) || (r === 0 && c === 1) || (r === 1 && c === 0),
    );
    lines.push(
      fakeLine('header', { x: 440, y: 118, width: 120, height: 24 }, { width: W, height: H }),
    );
    lines.push(
      fakeLine('tall', { x: 140, y: 208, width: 120, height: 24 }, { width: W, height: H }),
    );
    const rects = gridRects(xs, ys, { skipV: [[2, 0]], skipH: [[2, 0]] });
    const page = build([...rects, ...marks], lines);
    const [table] = tablesOf(page);
    expect(table!.rows).toBe(3);
    expect(table!.cols).toBe(4);
    const header = cellAt(table!, 0, 1)!;
    expect(header).toMatchObject({ row: 0, col: 1, rowSpan: 1, colSpan: 2, text: 'header' });
    expect(cellAt(table!, 0, 2)).toBe(header);
    const tall = cellAt(table!, 1, 0)!;
    expect(tall).toMatchObject({ row: 1, col: 0, rowSpan: 2, colSpan: 1, text: 'tall' });
    // 3 x 4 = 12 positions, two merged cells occupy 2 each.
    expect(table!.cells).toHaveLength(10);
  });

  it('handles a page photographed 1° off', () => {
    const deg = 1;
    const { lines, marks } = cellTexts(xs, ys, deg);
    const image = renderPage(W, H, [...gridRects(xs, ys), ...marks], deg);
    const found = findLines(image);
    expect(Math.abs(found.skew - deg)).toBeLessThan(0.25);
    const page = buildTablePage({ image, lines, name: 'p', source: 's' });
    const [table, ...others] = tablesOf(page);
    expect(others).toHaveLength(0);
    expect(table!.rows).toBe(3);
    expect(table!.cols).toBe(4);
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 4; c++) expect(cellAt(table!, r, c)!.text).toBe(`r${r}c${c}`);
    // Screenshot box in original image coordinates: the center of cell (2, 3) is roughly at the rotated position.
    const box = cellAt(table!, 2, 3)!.box!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const expected = fakeLine(
      'x',
      { x: 800, y: 250, width: 0, height: 0 },
      { width: W, height: H, deg },
    );
    expect(Math.abs(cx - expected.x)).toBeLessThan(8);
    expect(Math.abs(cy - expected.y)).toBeLessThan(8);
  });

  it('does not treat underlines or strikethroughs as table lines', () => {
    const { lines, marks } = cellTexts(xs, ys);
    const page1 = { width: W, height: H };
    const extra: Rect[] = [
      // A line of text above the table, a rule below.
      ...glyphs(100, 40, 300),
      { x: 100, y: 62, width: 300, height: 2 },
      // A line of text below the table, with strikethrough in the middle.
      ...glyphs(100, 400, 300),
      { x: 95, y: 407, width: 310, height: 2 },
      // A strikethrough below the text of a cell in the table (does not touch vertical lines).
      { x: 330, y: 204, width: 140, height: 2 },
    ];
    lines.push(fakeLine('underlined title', { x: 100, y: 38, width: 300, height: 22 }, page1));
    lines.push(fakeLine('struck out', { x: 100, y: 398, width: 300, height: 22 }, page1));
    const page = build([...gridRects(xs, ys), ...marks, ...extra], lines);
    const tables = tablesOf(page);
    expect(tables).toHaveLength(1);
    expect(tables[0]!.rows).toBe(3);
    expect(tables[0]!.cols).toBe(4);
    const texts = page.blocks.filter((b) => b.kind === 'text').map((b) => b.text);
    expect(texts).toEqual(['underlined title', 'struck out']);
    // Reading order: text above, table, text below.
    expect(page.blocks.map((b) => b.kind)).toEqual(['text', 'table', 'text']);
  });

  it('finds no table on a page with only a separator line and text', () => {
    const page1 = { width: W, height: H };
    const rects = [
      ...glyphs(100, 100, 600),
      { x: 80, y: 200, width: 840, height: 2 },
      ...glyphs(100, 260, 600),
    ];
    const lines = [
      fakeLine('first paragraph', { x: 100, y: 98, width: 600, height: 22 }, page1),
      fakeLine('second paragraph', { x: 100, y: 258, width: 600, height: 22 }, page1),
    ];
    const page = build(rects, lines);
    expect(tablesOf(page)).toHaveLength(0);
    expect(page.blocks.map((b) => b.kind === 'text' && b.text)).toEqual([
      'first paragraph',
      'second paragraph',
    ]);
  });

  it('does not take a solid black bar for a line', () => {
    const lines = findLines(renderPage(W, H, [{ x: 100, y: 100, width: 600, height: 40 }]));
    expect(lines.horizontal).toHaveLength(0);
  });

  it('splits a text line that runs across a vertical line, at the character positions', () => {
    const gx = [100, 400, 700];
    const gy = [100, 160, 220];
    const page1 = { width: W, height: H };
    const lines = [
      fakeLine('左边内容右边内容', { x: 150, y: 118, width: 500, height: 24 }, page1, true),
      fakeLine('下面', { x: 200, y: 178, width: 60, height: 24 }, page1, true),
    ];
    const page = build(gridRects(gx, gy), lines);
    const [table] = tablesOf(page);
    expect(cellAt(table!, 0, 0)!.text).toBe('左边内容');
    expect(cellAt(table!, 0, 1)!.text).toBe('右边内容');
    expect(cellAt(table!, 1, 0)!.text).toBe('下面');
  });

  it('finds two tables on one page, in reading order', () => {
    const a = cellTexts([100, 400, 700], [80, 130, 180]);
    const b = cellTexts([100, 300, 500, 900], [400, 450, 500, 550]);
    const page = build(
      [
        ...gridRects([100, 400, 700], [80, 130, 180]),
        ...gridRects([100, 300, 500, 900], [400, 450, 500, 550]),
        ...a.marks,
        ...b.marks,
      ],
      [...a.lines, ...b.lines],
    );
    const tables = tablesOf(page);
    expect(tables.map(shapeOf)).toEqual([
      [2, 2],
      [3, 3],
    ]);
  });
});

describe('tables with only horizontal lines (D-272)', () => {
  const page1 = { width: W, height: H };
  const row = (r: number, y: number, texts: string[], centers = [200, 500, 800]) =>
    texts.map((t, c) => fakeLine(t, { x: centers[c]! - 50, y, width: 100, height: 22 }, page1));

  it('finds the columns from the gaps between the text', () => {
    const ys = [100, 150, 200, 250, 300];
    const rects = ys.map((y) => ({ x: 100, y, width: 800, height: 2 }));
    const lines = ys.slice(0, -1).flatMap((y, r) => row(r, y + 14, [`a${r}`, `b${r}`, `c${r}`]));
    const page = build(rects, lines);
    const [table] = tablesOf(page);
    expect(table!.rows).toBe(4);
    expect(table!.cols).toBe(3);
    expect(cellAt(table!, 2, 1)!.text).toBe('b2');
    expect(cellAt(table!, 3, 2)!.text).toBe('c3');
  });

  it('uses the header’s vertical lines for the columns below it', () => {
    const ys = [100, 150, 200, 250, 300];
    const vx = [100, 350, 650, 900];
    const rects: Rect[] = [
      ...ys.map((y) => ({ x: 100, y, width: 802, height: 2 })),
      ...vx.map((x) => ({ x, y: 100, width: 2, height: 52 })),
    ];
    // Body text is left-aligned; splitting by text gaps will split incorrectly; should split by header vertical lines.
    const lines = [
      ...row(0, 114, ['Name', 'Qty', 'Price'], [225, 500, 775]),
      ...[1, 2, 3].flatMap((r) =>
        row(r, ys[r]! + 14, [`n${r}`, `q${r}`, `p${r}`], [160, 400, 700]),
      ),
    ];
    const page = build(rects, lines);
    const [table] = tablesOf(page);
    expect(table!.cols).toBe(3);
    expect(table!.rows).toBe(4);
    expect(table!.cells.every((c) => c.colSpan === 1 && c.rowSpan === 1)).toBe(true);
    expect(cellAt(table!, 0, 2)!.text).toBe('Price');
    expect(cellAt(table!, 2, 1)!.text).toBe('q2');
    expect(cellAt(table!, 3, 2)!.text).toBe('p3');
  });

  it('splits the body of a three-line table into one row per line of text', () => {
    const rects = [100, 140, 300].map((y) => ({ x: 100, y, width: 800, height: 2 }));
    const lines = [
      ...row(0, 110, ['Item', 'Unit', 'Total']),
      ...[0, 1, 2, 3].flatMap((r) => row(r, 150 + r * 38, [`i${r}`, `u${r}`, `t${r}`])),
    ];
    const page = build(rects, lines);
    const [table] = tablesOf(page);
    expect(table!.cols).toBe(3);
    expect(table!.rows).toBe(5);
    expect(cellAt(table!, 0, 0)!.text).toBe('Item');
    expect(cellAt(table!, 1, 0)!.text).toBe('i0');
    expect(cellAt(table!, 4, 2)!.text).toBe('t3');
  });

  it('keeps a three-line table below a ruled grid of the same width as its own table', () => {
    const xs = [100, 500, 900];
    const ys = [60, 110, 160, 210];
    const grid = cellTexts(xs, ys);
    const rects = [
      ...gridRects(xs, ys),
      ...[330, 370, 540].map((y) => ({ x: 100, y, width: 802, height: 2 })),
    ];
    const lines = [
      ...grid.lines,
      fakeLine('Contacts', { x: 100, y: 280, width: 200, height: 24 }, page1),
      ...row(0, 340, ['Name', 'Phone', 'Days']),
      ...[0, 1, 2].flatMap((r) => row(r, 385 + r * 50, [`n${r}`, `p${r}`, `d${r}`])),
    ];
    const page = build([...rects, ...grid.marks], lines);
    const tables = tablesOf(page);
    expect(tables.map(shapeOf)).toEqual([
      [3, 2],
      [4, 3],
    ]);
    // The title between the two tables is text outside the tables.
    expect(page.blocks.map((b) => b.kind)).toEqual(['table', 'text', 'table']);
  });

  it('keeps a three-line table apart from a ruled grid above it although the heading gap is under two grid rows', () => {
    // Grid rows are 50 high; the middle title and whitespace are only 80 (less than two rows).
    // Vertical lines stop after covering the three rows of the grid: the grid ends here, not a
    // table where "only the header has vertical lines and below has only horizontal lines".
    const xs = [100, 500, 900];
    const ys = [60, 110, 160, 210];
    const grid = cellTexts(xs, ys);
    const rects = [
      ...gridRects(xs, ys),
      ...[290, 330, 500].map((y) => ({ x: 100, y, width: 802, height: 2 })),
    ];
    const lines = [
      ...grid.lines,
      fakeLine('Contacts', { x: 100, y: 240, width: 200, height: 24 }, page1),
      ...row(0, 300, ['Name', 'Phone', 'Days']),
      ...[0, 1, 2].flatMap((r) => row(r, 345 + r * 50, [`n${r}`, `p${r}`, `d${r}`])),
    ];
    const page = build([...rects, ...grid.marks], lines);
    expect(tablesOf(page).map(shapeOf)).toEqual([
      [3, 2],
      [4, 3],
    ]);
    expect(page.blocks.map((b) => b.kind)).toEqual(['table', 'text', 'table']);
  });

  it('does not make a table out of aligned fill-in blanks with nothing inside', () => {
    const rects = [200, 250, 300].map((y) => ({ x: 300, y, width: 400, height: 2 }));
    const lines = [200, 250, 300].map((y, i) =>
      fakeLine(`Label ${i}:`, { x: 120, y: y - 22, width: 160, height: 22 }, page1),
    );
    const page = build(rects, lines);
    expect(tablesOf(page)).toHaveLength(0);
  });

  it('does not make a table out of prose between aligned rules', () => {
    const rects = [100, 220, 340].map((y) => ({ x: 100, y, width: 800, height: 2 }));
    const lines = [130, 160, 190, 250, 280, 310].map((y, i) =>
      fakeLine(`prose line ${i}`, { x: 110, y, width: 780, height: 22 }, page1),
    );
    const page = build(rects, lines);
    expect(tablesOf(page)).toHaveLength(0);
  });
});

// Cases encountered when tuning parameters with real scans (D-272), each cropped from photos to the minimal composite case.
describe('cases from real scans (D-272)', () => {
  const page1 = { width: W, height: H };
  /** A line of text in a cell: OCR box + stroke-like characters. */
  const word = (text: string, x: number, y: number, width = 120, chars = false) => ({
    line: fakeLine(text, { x, y, width, height: 20 }, page1, chars),
    marks: glyphs(x + 4, y + 3, width - 8, 14),
  });
  const page = (rects: Rect[], words: ReturnType<typeof word>[]) =>
    build(
      [...rects, ...words.flatMap((w) => w.marks)],
      words.map((w) => w.line),
    );

  it('keeps two ruled boxes of the same width apart when text sits between them', () => {
    // Tax form: an upper 2-column table, a section of text in the middle, a lower table with different columns; left and right justified.
    const words = [
      word('nom', 120, 115),
      word('xia', 520, 115),
      word('paragraph between', 120, 230, 500),
      word('pays', 120, 315),
      word('numero', 320, 315),
    ];
    const rects = [
      ...gridRects([100, 500, 900], [100, 150]),
      ...gridRects([100, 300, 900], [300, 350]),
    ];
    const tables = tablesOf(page(rects, words));
    expect(tables.map(shapeOf)).toEqual([
      [1, 2],
      [1, 2],
    ]);
    expect(cellAt(tables[1]!, 0, 1)!.text).toBe('numero');
  });

  it('does not join two boxes 10 pixels apart into one grid', () => {
    // Payslip: vertically adjacent boxes with different columns; their borders must not connect into a single line.
    const words = [
      word('a1', 120, 115),
      word('a2', 520, 115),
      word('b1', 120, 225),
      word('b2', 320, 225),
    ];
    const rects = [
      ...gridRects([100, 500, 900], [100, 200]),
      ...gridRects([100, 300, 900], [212, 262]),
    ];
    const tables = tablesOf(page(rects, words));
    expect(tables.map(shapeOf)).toEqual([
      [1, 2],
      [1, 2],
    ]);
  });

  it('reads a table drawn inside a bigger frame (forms)', () => {
    const words = [
      word('form title', 120, 80, 320),
      word('a long note across the whole frame', 100, 500, 800),
      ...[0, 1].flatMap((r) =>
        [0, 1, 2].map((c) => word(`r${r}c${c}`, [120, 420, 720][c]!, 315 + r * 50)),
      ),
    ];
    const rects = [
      ...gridRects([50, 950], [50, 650]),
      ...gridRects([100, 400, 700, 900], [300, 350, 400]),
    ];
    const [table, ...others] = tablesOf(page(rects, words));
    expect(others).toHaveLength(0);
    // Each cell of the small table is independent (outer border must not absorb all inner text).
    for (let r = 0; r < 2; r++)
      for (let c = 0; c < 3; c++)
        expect(table!.cells.some((cell) => cell.text === `r${r}c${c}`)).toBe(true);
  });

  it('splits a body ruled only by columns into one row per line, ignoring bold labels', () => {
    // Payslip and bill body: vertical lines go all the way down, no lines between rows; item names are bold (resembling a thick horizontal line during scanning).
    const xs = [100, 400, 650, 900];
    const words = [word('label', 120, 110), word('base', 420, 110), word('amount', 670, 110)];
    const bold: Rect[] = [];
    for (let r = 0; r < 5; r++) {
      const y = 160 + r * 32;
      words.push(word(`item ${r}`, 110, y, 200), word(`${r}00`, 420, y), word(`${r}.5`, 670, y));
      bold.push({ x: 102, y: y + 5, width: 200, height: 10 });
    }
    const rects = [...gridRects(xs, [100, 140, 330]), ...bold];
    const [table, ...others] = tablesOf(page(rects, words));
    expect(others).toHaveLength(0);
    expect([table!.rows, table!.cols]).toEqual([6, 3]);
    for (let r = 0; r < 5; r++) {
      expect(cellAt(table!, r + 1, 0)!.text).toBe(`item ${r}`);
      expect(cellAt(table!, r + 1, 2)!.text).toBe(`${r}.5`);
    }
  });

  it('does not take an underlined bold title for a table (D-463)', () => {
    // Prescription title "ORDONNANCE DE LUNETTES": vertical strokes of bold text connect to the
    // underline, top horizontal strokes of characters connect into a line, resembling a row of
    // short verticals sandwiched between two horizontals during scanning. Should be a text block,
    // not a table with one or two letters per cell.
    const rects: Rect[] = [
      { x: 300, y: 205, width: 400, height: 4 },
      { x: 300, y: 229, width: 400, height: 3 },
    ];
    for (let x = 302; x < 700; x += 20) rects.push({ x, y: 205, width: 4, height: 24 });
    const title = fakeLine(
      'ORDONNANCE DE LUNETTES',
      { x: 300, y: 200, width: 400, height: 33 },
      { width: W, height: H },
    );
    const page = build(rects, [title]);
    expect(tablesOf(page)).toHaveLength(0);
    expect(page.blocks).toMatchObject([{ kind: 'text', text: 'ORDONNANCE DE LUNETTES' }]);
  });

  it('keeps text that wraps inside one cell together', () => {
    const words = [
      word('long name', 120, 110, 200),
      word('wraps here', 120, 132, 200),
      word('and here', 120, 154, 200),
      word('42', 420, 132),
    ];
    const [table] = tablesOf(page(gridRects([100, 400, 900], [100, 190]), words));
    expect([table!.rows, table!.cols]).toEqual([1, 2]);
    expect(cellAt(table!, 0, 0)!.text.split('\n')).toHaveLength(3);
  });

  it('keeps a form cell of several lines together when only one column has them', () => {
    // Energy diagnosis header box: left and right cells contain several lines of address and date
    // respectively, with no horizontal line in the middle; only the top two rows have text on both
    // sides, while the lower rows have continuation text only in the left column. Splitting by row
    // would split a single cell into multiple rows (D-333).
    const words = [
      word('Logement F44', 120, 110, 200),
      word('Date 21/02', 420, 110, 200),
      word('No 2093N', 120, 135, 200),
      word('Diagnostiqueur', 420, 136, 200),
      word('Valable 2030', 120, 160, 200),
      word('Type Habitation', 120, 185, 200),
      word('Annee 2019', 120, 210, 200),
      word('Surface 62 m2', 120, 260, 200),
      word('Cage C=3', 120, 285, 200),
    ];
    const [table, ...others] = tablesOf(page(gridRects([100, 400, 900], [100, 320]), words));
    expect(others).toHaveLength(0);
    expect([table!.rows, table!.cols]).toEqual([1, 2]);
    expect(cellAt(table!, 0, 0)!.text.split('\n')).toHaveLength(7);
    expect(cellAt(table!, 0, 1)!.text.split('\n')).toEqual(['Date 21/02', 'Diagnostiqueur']);
  });

  it('keeps the step lists of a one-row box in their cells (EU sample 049)', () => {
    // Manual: a row of three cells, each with a step number and several bullet points, cells have equal row height, no column is numeric.
    const columns = [
      ['1', 'Ins Menü'],
      ['2', 'Datenspeicher', 'Proben-IDs', 'Methoden', 'Einstellungen'],
      ['3', 'Neue Methode', 'Methoden editieren', 'mit OK bestätigen'],
    ];
    const words = columns.flatMap((lines, c) =>
      lines.map((text, r) => word(text, 120 + c * 270, 110 + r * 26, 200)),
    );
    const [table, ...others] = tablesOf(page(gridRects([100, 370, 640, 900], [100, 250]), words));
    expect(others).toHaveLength(0);
    expect([table!.rows, table!.cols]).toEqual([1, 3]);
    expect(cellAt(table!, 0, 1)!.text.split('\n')).toHaveLength(5);
  });

  it('still splits a body where some rows only have a section label', () => {
    // Payslip: subtitles like "URSSAF" and "Retraite" have only one cell per row, other rows have text in every column.
    const xs = [100, 400, 650, 900];
    const words = [word('label', 120, 110), word('base', 420, 110), word('amount', 670, 110)];
    const rows = ['URSSAF', 'item 1', 'item 2', 'Retraite', 'item 4'];
    rows.forEach((text, r) => {
      const y = 160 + r * 32;
      words.push(word(text, 110, y, 200));
      if (text.startsWith('item')) words.push(word(`${r}00`, 420, y), word(`${r}.5`, 670, y));
    });
    const [table] = tablesOf(page(gridRects(xs, [100, 140, 330]), words));
    expect([table!.rows, table!.cols]).toEqual([6, 3]);
    expect(cellAt(table!, 1, 0)!.text).toBe('URSSAF');
    expect(cellAt(table!, 2, 2)!.text).toBe('1.5');
  });

  it('does not split label rows by the lines of a cell spanning them (EU sample 057)', () => {
    // Price list: left cell spans three rows (no horizontal lines above/below), containing two
    // lines of text; middle row label has three lines, right column has description. The two lines
    // of text in the left cell must not cause the middle row to split into multiple rows based on
    // text lines.
    const xs = [100, 330, 650, 900];
    const rects = gridRects(xs, [100, 160, 250, 310], {
      skipH: [
        [1, 0],
        [2, 0],
      ],
    });
    const words = [
      word('QUOTA FISSA', 140, 176, 150),
      word('(EUR/mese)', 140, 212, 150),
      word('VENDITA', 400, 120, 200),
      word('Fissa per 12 mesi', 670, 120, 200),
      word('COMPONENTE DI', 400, 168, 200),
      word('DISPACCIAMENTO', 400, 194, 200),
      word('PARTE FISSA', 400, 220, 200),
      word('Come stabilito', 670, 194, 200),
      word('QUOTA', 400, 270, 200),
      word('Come stabilito', 670, 270, 200),
    ];
    const [table, ...others] = tablesOf(page(rects, words));
    expect(others).toHaveLength(0);
    expect([table!.rows, table!.cols]).toEqual([3, 3]);
    expect(cellAt(table!, 0, 0)).toMatchObject({ rowSpan: 3 });
    expect(cellAt(table!, 1, 1)!.text.split('\n')).toEqual([
      'COMPONENTE DI',
      'DISPACCIAMENTO',
      'PARTE FISSA',
    ]);
  });

  it('keeps a boxed field of several lines whole beside label columns that span past it (EU sample 018)', () => {
    // Diploma supplement: two numbers "3.1" and "3.2" in columns outside the boxes (top and bottom
    // horizontal lines are drawn only on the two boxes), left box has four lines of text, right box
    // has two lines. An outer large box containing two small boxes; numbers are to the left of the
    // small boxes.
    const rects = [
      ...gridRects([60, 940], [60, 260]),
      ...gridRects([160, 600], [100, 210]),
      ...gridRects([660, 900], [100, 210]),
    ];
    const words = [
      word('3.1', 110, 145, 40),
      word('Studii universitare de licenta', 170, 108, 400),
      word('al calificarilor CNC', 170, 132, 400),
      word('Bachelor Studies Level 6', 170, 156, 400),
      word('European Framework', 170, 180, 400),
      word('3.2', 610, 145, 40),
      word('3 ani 180 credite', 670, 130, 200),
      word('3 years 180 credits', 670, 154, 200),
    ];
    const [table] = tablesOf(page(rects, words));
    const cell = table!.cells.find((c) => c.text.includes('Studii'))!;
    expect(cell.text.split('\n')).toHaveLength(4);
  });

  it('keeps column lines that start below an unruled header', () => {
    // Property bill batch table: header has background color, no horizontal lines below, vertical lines in header are broken, starting only from the table body.
    const xs = [100, 300, 500, 700, 900];
    const words: ReturnType<typeof word>[] = [];
    for (const [r, y] of [110, 160, 190].entries())
      for (let c = 0; c < 4; c++) words.push(word(`r${r}c${c}`, xs[c]! + 20, y));
    const rects = [
      ...gridRects([100, 700, 900], [100, 250]),
      ...[300, 500].map((x) => ({ x, y: 145, width: 2, height: 107 })),
    ];
    const [table] = tablesOf(page(rects, words));
    expect([table!.rows, table!.cols]).toEqual([3, 4]);
    expect(cellAt(table!, 0, 3)!.text).toBe('r0c3');
    expect(cellAt(table!, 2, 1)!.text).toBe('r2c1');
  });

  it('finds the column lines of a row only 30 pixels high', () => {
    const words = [word('prix', 120, 305), word('6 034,00', 420, 305), word('remise', 720, 305)];
    const [table] = tablesOf(page(gridRects([100, 400, 700, 900], [300, 330]), words));
    expect([table!.rows, table!.cols]).toEqual([1, 3]);
    expect(cellAt(table!, 0, 1)!.text).toBe('6 034,00');
  });

  it('does not take letter stems stacked through a tight table’s row rules for column lines (EU sample 090)', () => {
    // Lab report: 17 pixels per row height, bold text almost touches row lines top and bottom, vertical strokes of characters starting at the same column (e.g., "P-") connect across row lines into a "vertical line".
    const ys = Array.from({ length: 13 }, (_, r) => 100 + 17 * r);
    const lines: OcrBox[] = [];
    const marks: Rect[] = [];
    for (let r = 0; r + 1 < ys.length; r++) {
      const box = { x: 60, y: ys[r]! + 3, width: 210, height: 12 };
      const text = `P-Analisi numero ${String(r).padStart(2, '0')}`;
      lines.push(fakeLine(text, box, page1, true));
      lines.push(
        fakeLine(`${r} - ${r + 9}`, { x: 420, y: ys[r]! + 3, width: 60, height: 12 }, page1, true),
      );
      // Each character (except spaces) has a vertical stroke in its middle.
      for (const [i, ch] of Array.from(text).entries())
        if (ch !== ' ')
          marks.push({
            x: 60 + ((i + 0.5) / text.length) * 210,
            y: ys[r]! + 3,
            width: 2,
            height: 12,
          });
    }
    const page = build([...gridRects([40, 400, 600], ys), ...marks], lines);
    const [table] = tablesOf(page);
    expect([table!.rows, table!.cells.filter((c) => c.row === 0).length]).toEqual([12, 2]);
    expect(cellAt(table!, 5, 0)!.text).toBe('P-Analisi numero 05');
  });

  it('does not take a framed blank with words just beside it for a one-cell table (EU sample 082)', () => {
    // A background-shaded fill area in a sentence, whose four sides were detected as lines (a cell box): the immediately adjacent "y" is within tolerance, previously enclosed in a 1x1 table.
    const words = [word('y', 475, 300, 12)];
    expect(tablesOf(page(gridRects([400, 472], [298, 326]), words))).toHaveLength(0);
  });

  it('keeps a title whole above a column line that starts below it', () => {
    // Payslip calendar: title spans two columns, vertical lines start only from the second row.
    const words = [
      word('CALENDRIER', 350, 115, 300, true),
      word('jour', 120, 165),
      word('incident', 520, 165),
    ];
    const rects = gridRects([100, 500, 900], [100, 150, 200], { skipV: [[1, 0]] });
    const [table] = tablesOf(page(rects, words));
    expect(cellAt(table!, 0, 0)).toMatchObject({ colSpan: 2, text: 'CALENDRIER' });
    expect(cellAt(table!, 1, 1)!.text).toBe('incident');
  });
});

describe('dark header bands (D-501)', () => {
  const page1 = { width: W, height: H };
  const word = (text: string, x: number, y: number, width = 120) => ({
    line: fakeLine(text, { x, y, width, height: 20 }, page1),
    marks: glyphs(x + 4, y + 3, width - 8, 14),
  });
  /** Vertical line: drawn from top to bottom at x. */
  const column = (x: number, top: number, bottom: number): Rect => ({
    x,
    y: top,
    width: 2,
    height: bottom - top,
  });
  /** White text in dark background bar: OCR box is on the bar, no strokes drawn (white text becomes gaps on the dark bar after binarization, with a very small ratio). */
  const label = (text: string, x: number, y: number) =>
    fakeLine(text, { x, y, width: 100, height: 20 }, page1);

  it('reads a payslip table whose header is a dark band and whose column lines start below it', () => {
    // Payslip: header is a dark background bar (white text), column lines extend from below the bar to the bottom, no lines between table body rows.
    const xs = [100, 400, 650, 900];
    const band = { x: 100, y: 100, width: 802, height: 40 };
    const words = [];
    for (let r = 0; r < 5; r++) {
      const y = 155 + r * 32;
      words.push(word(`item ${r}`, 110, y, 200), word(`${r}00`, 420, y), word(`${r}.5`, 670, y));
    }
    const rects = [
      band,
      ...xs.map((x) => column(x, 140, 330)),
      { x: 100, y: 330, width: 802, height: 2 },
      ...words.flatMap((w) => w.marks),
    ];
    const header = [
      label('Eléments', 200, 110),
      label('Base', 470, 110),
      label('Montant', 720, 110),
    ];
    const page = build(rects, [...header, ...words.map((w) => w.line)]);
    const [table, ...others] = tablesOf(page);
    expect(others).toHaveLength(0);
    expect([table!.rows, table!.cols]).toEqual([6, 3]);
    expect([0, 1, 2].map((c) => cellAt(table!, 0, c)!.text)).toEqual([
      'Eléments',
      'Base',
      'Montant',
    ]);
    for (let r = 0; r < 5; r++) {
      expect([0, 1, 2].map((c) => cellAt(table!, r + 1, c)!.text)).toEqual([
        `item ${r}`,
        `${r}00`,
        `${r}.5`,
      ]);
    }
  });

  it('splits two tables joined by the lower table’s header band, each with its own columns', () => {
    // Payslip breakdown table followed by summary table: breakdown table column lines stop at the summary table header bar, below which is another set of columns.
    const upper = [100, 500, 900];
    const lower = [100, 300, 500, 700, 900];
    const words = [
      ...['a', 'b', 'c'].flatMap((t, r) => [
        word(`label ${t}`, 110, 150 + r * 30, 200),
        word(`${r + 1}.00`, 520, 150 + r * 30),
      ]),
      ...[0, 1, 2, 3].map((c) => word(`v${c}`, lower[c]! + 40, 295, 80)),
    ];
    const rects = [
      { x: 100, y: 100, width: 802, height: 40 },
      ...upper.map((x) => column(x, 140, 240)),
      { x: 100, y: 240, width: 802, height: 40 },
      ...lower.map((x) => column(x, 280, 330)),
      { x: 100, y: 330, width: 802, height: 2 },
      ...words.flatMap((w) => w.marks),
    ];
    const header = [label('Elements', 200, 110), label('Montant', 620, 110)];
    const sums = ['Heures', 'Brut', 'Net', 'Total'].map((t, c) => label(t, lower[c]! + 50, 250));
    const page = build(rects, [...header, ...sums, ...words.map((w) => w.line)]);
    const tables = tablesOf(page);
    expect(tables.map((t) => t.cells.filter((c) => c.row === 0).length)).toEqual([2, 4]);
    expect(cellAt(tables[0]!, 0, 0)!.text).toBe('Elements');
    expect(cellAt(tables[0]!, 3, 0)!.text).toBe('label c');
    // cellAt(tables[0]!, 3, 2)!.text is "3.00": upper table's second column starts from the shared 3rd column line (first cell spans two columns).
    expect(cellAt(tables[0]!, 3, 2)!.text).toBe('3.00');
    expect(tables[1]!.cells.filter((c) => c.row === 0).map((c) => c.text)).toEqual([
      'Heures',
      'Brut',
      'Net',
      'Total',
    ]);
    expect(tables[1]!.cells.filter((c) => c.row === 1).map((c) => c.text)).toEqual([
      'v0',
      'v1',
      'v2',
      'v3',
    ]);
  });

  it('keeps a table’s bottom line hidden in a tall text box and leaves that text out of the table', () => {
    // Curved footer line in photo: OCR box is tall, covering the table bottom line; a middle column line extends downward (connecting to footer strokes).
    const xs = [100, 300, 500, 700, 900];
    const words = [0, 1, 2, 3].map((c) => word(`v${c}`, xs[c]! + 40, 255, 80));
    const footer = fakeLine('Keep this payslip', { x: 100, y: 290, width: 800, height: 40 }, page1);
    const rects = [
      ...gridRects(xs, [200, 240, 300]),
      column(300, 300, 330),
      ...words.flatMap((w) => w.marks),
      ...glyphs(110, 312, 780, 14),
    ];
    const page = build(rects, [...words.map((w) => w.line), footer]);
    const [table] = tablesOf(page);
    expect(table!.rows).toBe(2);
    expect(table!.cells.some((c) => c.text.includes('Keep'))).toBe(false);
    expect(page.blocks.at(-1)).toMatchObject({ kind: 'text', text: 'Keep this payslip' });
  });
});

describe('text just outside a table (D-501)', () => {
  const page1 = { width: W, height: H };
  const word = (text: string, x: number, y: number, width = 120) => ({
    line: fakeLine(text, { x, y, width, height: 20 }, page1),
    marks: glyphs(x + 4, y + 3, width - 8, 14),
  });

  it('keeps a totals row printed just under the table’s last line, one value per column', () => {
    // Invoice: immediately below the last horizontal line is "TOTAL: ... amount", each text segment in a column, forming the table's total row.
    const xs = [100, 300, 500, 700, 900];
    const words = [
      ...[0, 1, 2, 3].map((c) => word(`a${c}`, xs[c]! + 40, 210, 80)),
      ...[0, 1, 2, 3].map((c) => word(`b${c}`, xs[c]! + 40, 250, 80)),
      // Center is 6 pixels below the bottom line (within table-detection tolerance).
      word('TOTAL:', 140, 276, 80),
      word('99.00', 740, 276, 80),
    ];
    const rects = [...gridRects(xs, [200, 240, 280]), ...words.flatMap((w) => w.marks)];
    const page = build(
      rects,
      words.map((w) => w.line),
    );
    // Merged into the last row's cells as before (without horizontal line separation); must not be taken out of the table to avoid thinning and discarding the entire table.
    const [table] = tablesOf(page);
    const cells = table!.cells.map((c) => c.text).join('\n');
    expect(cells).toContain('TOTAL:');
    expect(cells).toContain('99.00');
    expect(page.blocks.filter((b) => b.kind === 'text')).toHaveLength(0);
  });
});

describe('one grid for the whole page (D-272)', () => {
  const page1 = { width: W, height: H };
  const word = (text: string, x: number, y: number, width = 120) => ({
    line: fakeLine(text, { x, y, width, height: 20 }, page1),
    marks: glyphs(x + 4, y + 3, width - 8, 14),
  });
  const page = (rects: Rect[], words: ReturnType<typeof word>[]) =>
    build(
      [...rects, ...words.flatMap((w) => w.marks)],
      words.map((w) => w.line),
    );
  /** Position of each cell in a table on the page-shared columns: [first column on page, column span, text]. */
  const placed = (t: TableBlock) => t.cells.map((c) => [t.col + c.col, c.colSpan, c.text]);

  it('lines up column lines a few pixels apart in two tables on one column', () => {
    const words = [
      word('a', 120, 115),
      word('b', 420, 115),
      word('c', 125, 315),
      word('d', 425, 315),
    ];
    const rects = [
      ...gridRects([100, 400, 700], [100, 150]),
      ...gridRects([105, 404, 696], [300, 350]),
    ];
    const p = page(rects, words);
    const tables = tablesOf(p);
    expect(tables.map(placed)).toEqual([
      [
        [0, 1, 'a'],
        [1, 1, 'b'],
      ],
      [
        [0, 1, 'c'],
        [1, 1, 'd'],
      ],
    ]);
    expect(p.colWidths).toHaveLength(2);
    for (const w of p.colWidths) expect(Math.abs(w - 298)).toBeLessThan(8);
  });

  it('spans the shared columns when one table’s columns are a subset of another’s', () => {
    // 2 columns above, 4 columns below; extra vertical lines below divide each upper cell into 2 column spans; cell contents and merges remain unchanged.
    const words = [
      word('left', 120, 115),
      word('right', 420, 115),
      ...[0, 1, 2, 3].map((c) => word(`x${c}`, 110 + c * 150, 315, 100)),
    ];
    const rects = [
      ...gridRects([100, 400, 700], [100, 150]),
      ...gridRects([100, 250, 400, 550, 700], [300, 350]),
    ];
    const p = page(rects, words);
    const [top, bottom] = tablesOf(p);
    expect(placed(top!)).toEqual([
      [0, 2, 'left'],
      [2, 2, 'right'],
    ]);
    expect(placed(bottom!)).toEqual([0, 1, 2, 3].map((c) => [c, 1, `x${c}`]));
    expect(p.colWidths).toHaveLength(4);
  });

  it('starts a narrower table at its own column of the page grid', () => {
    // Lower table occupies only the right half: starting from column 2. Text outside the table spans the full page width.
    const words = [
      word('a', 120, 115),
      word('b', 420, 115),
      word('note', 120, 220, 200),
      word('c', 420, 315),
      word('d', 570, 315),
    ];
    const rects = [
      ...gridRects([100, 400, 700], [100, 150]),
      ...gridRects([400, 550, 700], [300, 350]),
    ];
    const p = page(rects, words);
    const [top, bottom] = tablesOf(p);
    expect(placed(top!)).toEqual([
      [0, 1, 'a'],
      [1, 2, 'b'],
    ]);
    expect(placed(bottom!)).toEqual([
      [1, 1, 'c'],
      [2, 1, 'd'],
    ]);
    expect([bottom!.col, bottom!.cols]).toEqual([1, 2]);
  });

  it('never folds two column lines of the same table into one', () => {
    // Lines 100 and 110 of the same table (within tolerance 20) are treated as one; line 104 of other tables merges into 100.
    const { pos, maps } = sharedColumns(
      [
        [100, 110, 300],
        [104, 300],
      ],
      20,
    );
    expect(pos.map(Math.round)).toEqual([102, 110, 300]);
    expect(maps).toEqual([
      [0, 1, 2],
      [0, 2],
    ]);
  });
});

describe('horizontal alignment (D-272)', () => {
  const page1 = { width: W, height: H };
  const word = (text: string, x: number, y: number, width = 80) => ({
    line: fakeLine(text, { x, y, width, height: 20 }, page1),
    marks: glyphs(x + 4, y + 3, width - 8, 14),
  });
  const page = (rects: Rect[], words: ReturnType<typeof word>[]) =>
    build(
      [...rects, ...words.flatMap((w) => w.marks)],
      words.map((w) => w.line),
    );

  it('reads left, centred and right text from where it sits in the cell', () => {
    // 300 width per column: left-aligned (8 from left), centered, right-aligned (8 from right).
    const words = [word('left', 108, 115), word('mid', 510, 115), word('right', 912, 115)];
    const [table] = tablesOf(page(gridRects([100, 400, 700, 1000 - 2], [100, 150]), words));
    expect(table!.cells.map((c) => [c.text, c.align])).toEqual([
      ['left', 'left'],
      ['mid', 'center'],
      ['right', 'right'],
    ]);
  });

  it('goes with most lines in a wrapped cell and skips lines that fill it', () => {
    const words = [
      // First cell: three rows, two centered, one nearly full.
      word('title one', 200, 110, 100),
      word('a line that fills the cell', 104, 132, 292),
      word('title two', 200, 154, 100),
      word('x', 420, 132),
    ];
    const [table] = tablesOf(page(gridRects([100, 400, 700], [100, 190]), words));
    expect(cellAt(table!, 0, 0)!.align).toBe('center');
  });

  it('puts amounts on the right when the position does not tell', () => {
    // Characters fill the cell, alignment not visible: amount right-aligned, text unwritten (standard).
    const words = [word('1 954,54', 104, 115, 192), word('Assurance', 304, 115, 192)];
    const [table] = tablesOf(page(gridRects([100, 300, 500], [100, 150]), words));
    expect(cellAt(table!, 0, 0)!.align).toBe('right');
    expect(cellAt(table!, 0, 1)!.align).toBeUndefined();
  });

  it('centres a title above the table over the page’s columns', () => {
    const words = [word('BON DE COMMANDE', 350, 40, 300), word('a', 120, 115), word('b', 520, 115)];
    const p = page(gridRects([100, 500, 900], [100, 150]), words);
    const title = p.blocks.find((b) => b.kind === 'text');
    expect(title).toMatchObject({ text: 'BON DE COMMANDE', align: 'center' });
  });
});

describe('findTables', () => {
  it('keeps only lines connected to other lines', () => {
    const image = renderPage(W, H, [
      ...gridRects([100, 500, 900], [100, 200, 300]),
      { x: 100, y: 500, width: 600, height: 2 },
    ]);
    const tables = findTables(findLines(image, { skew: 0 }));
    expect(tables).toHaveLength(1);
    expect(tables[0]!.hs).toHaveLength(3);
    expect(tables[0]!.vs).toHaveLength(3);
  });
});

describe('tables without lines in Excel (D-506)', () => {
  // Text-version invoice from user testing (2026-11-09): thin horizontal lines too faint, lines not
  // found, previously the whole page became large text blocks in column A. Recognizes borderless
  // tables similarly to Word export (rules of D-471, D-502, D-503).
  const rowsOf = (t: TableBlock) =>
    Array.from({ length: t.rows }, (_, r) =>
      t.cells
        .filter((c) => c.row === r)
        .sort((a, b) => a.col - b.col)
        .map((c) => c.text)
        .filter(Boolean),
    );
  const page = buildTablePage({
    image: renderPage(INVOICE.width, INVOICE.height, []),
    lines: INVOICE.lines,
    name: 'Page 1',
    source: 'file:///page.jpg',
    skew: 0,
  });

  it('the invoice’s items become a four-column table', () => {
    const items = tablesOf(page).find((t) => rowsOf(t)[0]?.[0] === 'Item');
    expect(items?.cols).toBe(4);
    expect(rowsOf(items!).slice(0, INVOICE_ITEMS.length)).toEqual(INVOICE_ITEMS);
  });

  it('the text outside the table stays, and no line is written twice', () => {
    const texts = page.blocks.flatMap((b) =>
      b.kind === 'text' ? [b.text] : b.kind === 'table' ? b.cells.map((c) => c.text) : [],
    );
    for (const l of INVOICE.lines) {
      expect(texts.filter((t) => t.includes(l.text)).length, l.text).toBeGreaterThan(0);
    }
    expect(texts.filter((t) => t.includes('Toner cartridge'))).toHaveLength(1);
  });

  it('the columns of the table are the page’s columns', () => {
    const items = tablesOf(page).find((t) => rowsOf(t)[0]?.[0] === 'Item')!;
    expect(page.colWidths.length).toBeGreaterThanOrEqual(items.col + items.cols);
  });
});

describe('rules-only tables: closing lines under the last rows (EU sample 003)', () => {
  // Receipt: three VAT columns separated by gaps between separators, bottom section is centered
  // "Vielen Dank / Auf Wiedersehen", spanning column gaps.
  const xs = [60, 240, 600, 940].map((pos) => ({ pos, lined: false }));
  const ys = [100, 140, 165, 190, 230, 260, 300].map((pos, i) => ({
    pos,
    lined: [0, 1, 4, 6].includes(i),
  }));
  const rows = ys.length - 1;
  const cells = Array.from({ length: rows * 3 }, (_, k) => ({
    row: Math.floor(k / 3),
    col: k % 3,
    rowSpan: 1,
    colSpan: 1,
    text: '',
    box: { x: xs[k % 3]!.pos, y: ys[Math.floor(k / 3)]!.pos, width: 1, height: 1 },
  }));
  const grid: Grid = { xs, ys, owner: Int32Array.from(cells.keys()), cells };
  const box = (text: string, x: number, y: number, width = 100): OcrBox => ({
    text,
    x,
    y,
    width,
    height: 20,
  });
  const vat = [110, 145, 170, 200].flatMap((y, r) => [
    box(r ? `${r}.00%` : 'MWST', 80, y),
    box(r ? `${r}.10` : 'Netto', 330, y),
    box(r ? `${r}.60` : 'Brutto', 780, y),
  ]);

  it('drops the rows that only hold one centred line across the columns', () => {
    const closing = [
      box('Vielen Dank fuer Ihren Besuch', 200, 235, 500),
      box('Auf Wiedersehen', 380, 270, 300),
    ];
    const trimmed = dropTrailingRows(grid, [...vat, ...closing])!;
    expect(trimmed.grid.ys).toHaveLength(5);
    expect(trimmed.grid.cells.every((c) => c.row < 4)).toBe(true);
    expect(trimmed.lines.map((l) => l.text)).not.toContain('Auf Wiedersehen');
  });

  it('keeps a last row whose text sits in the columns', () => {
    const totals = [box('Summe', 80, 235), box('23.50', 780, 235)];
    expect(dropTrailingRows(grid, [...vat, ...totals])).toBeNull();
  });
});
