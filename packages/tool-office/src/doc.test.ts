import { describe, expect, it, vi } from 'vitest';

import {
  arrangeUnits,
  buildDocPage,
  clusterLines,
  fieldBoxTables,
  foldEmptyColumns,
  hasUnderline,
  isRuleGrid,
  isVertical,
  leafBlocks,
  looksLikeHeading,
  mergeColumnRows,
  mergeTextRegions,
  paragraphsOf,
  splitLabelColumn,
  strokeRatio,
  textColor,
  textEm,
  type DocList,
  type DocParagraph,
  type DocBlock,
  type DocRow,
  verticalBoxes,
} from './doc';
import { isDiagram, type LayoutRegion } from './layout';
import { fakeLine, glyphs, gridRects, renderPage, type Rect } from './test-helpers';
import type { OcrBox, RgbaImage, TableBlock } from './types';

const line = (text: string, x: number, y: number, width: number, height = 20): OcrBox => ({
  text,
  x,
  y,
  width,
  height,
});

const W = 1000;
const H = 1400;
const page = { width: W, height: H };

/** Single page: render each line of text as vertical bars (like character strokes) with optional stroke thickness; returns image and recognition results. */
function textPage(
  rows: { text: string; x: number; y: number; width: number; h?: number; stroke?: number }[],
  extra: Rect[] = [],
): { image: RgbaImage; lines: OcrBox[] } {
  const rects: Rect[] = [...extra];
  const lines: OcrBox[] = [];
  for (const r of rows) {
    const h = r.h ?? 20;
    // Character strokes leave 20% blank space at the top and bottom of the box.
    const stroke = r.stroke ?? 2;
    for (let s = 0; s + stroke <= r.width; s += 7 + stroke)
      rects.push({ x: r.x + s, y: r.y + h * 0.2, width: stroke, height: h * 0.6 });
    lines.push(fakeLine(r.text, { x: r.x, y: r.y, width: r.width, height: h }, page));
  }
  return { image: renderPage(W, H, rects), lines };
}

describe('paragraphsOf', () => {
  it('keeps a wrapped numeric page-range tail in its paragraph, but preserves a real numbered item and a bare label', () => {
    const reference = line('[1] Martin, E. Document analysis. 2024. pp. 12-', 100, 100, 550, 30);
    const tail = line('18.', 100, 135, 45, 30);
    const paras = paragraphsOf([reference, tail]);
    expect(paras).toHaveLength(1);
    expect(paras[0]!.list).toBe(false);
    expect(paras[0]!.rows.map((r) => r.text)).toEqual([reference.text, '18.']);
    expect(paragraphsOf([reference, { ...tail, text: '18. A new entry' }])).toHaveLength(2);
    const label = paragraphsOf([
      { ...reference, text: 'A complete preceding sentence without a numeric range.' },
      tail,
    ]);
    expect(label).toHaveLength(2);
    expect(label[1]!.list).toBe(false);
  });

  it('keeps receipt item lines apart when each has its own amount far to the right (EU sample 003)', () => {
    // Receipt: two lines "1 0,4 Schorle" and "1 T-RINDERSTEAK", with unit prices and amounts far
    // away on the right; the line above ("Bed. 2 Rg.") makes the right side look non-empty. Not a
    // wrapped paragraph.
    const items = [
      line('10,4 Schorle', 52, 709, 214, 39),
      line('1 T-RINDERSTEAK', 51, 749, 246, 38),
    ];
    const peers = [
      line('Bed. 2 Rg.:244744', 373, 590, 330, 38),
      line('3.60', 503, 712, 73, 37),
      line('3.60', 631, 713, 75, 37),
      line('19.90', 491, 751, 86, 40),
      line('19.90', 620, 752, 86, 40),
    ];
    expect(paragraphsOf(items, peers)).toHaveLength(2);
    // When the right side is prose (not an amount), evaluate line wrapping as usual.
    const prose = peers.map((p) => ({ ...p, text: 'and so on' }));
    expect(paragraphsOf(items, prose)).toHaveLength(1);
  });

  it('keeps two short lines apart when a blank line height separates them (EU sample 041, 049)', () => {
    // Two stacked "○ ja ○ nein" in an answer column separated by nearly one line height: two separate lines, not a wrapped paragraph.
    const a = line('Oja Onein', 1140, 930, 165, 28);
    const b = line('O ja O nein', 1140, 984, 165, 28);
    expect(paragraphsOf([a, b])).toHaveLength(2);
    // Two short lines with normal line spacing (wrapped lines in a narrow column) are still joined into a single paragraph.
    expect(paragraphsOf([a, { ...b, y: 962 }])).toHaveLength(1);
  });

  it('joins wrapped lines, starts a paragraph after a gap, an indent or a list marker', () => {
    const lines = [
      line('First paragraph runs to the right edge and', 100, 100, 800),
      line('wraps here.', 100, 125, 200),
      // Indented: new paragraph (two-space indentation at paragraph start in Chinese books).
      line('Second paragraph starts with an indent and runs', 140, 150, 760),
      line('to the next line.', 100, 175, 300),
      // More than one line gap: new paragraph, record as spaced.
      line('Third after a gap.', 100, 240, 400),
      line('1. A list item that is long enough to reach the', 100, 265, 800),
      line('right edge, continued with a hanging indent', 130, 290, 500),
      line('2. Second item', 100, 315, 300),
    ];
    const paras = paragraphsOf(lines);
    expect(paras.map((p) => p.rows.map((r) => r.text))).toEqual([
      ['First paragraph runs to the right edge and', 'wraps here.'],
      ['Second paragraph starts with an indent and runs', 'to the next line.'],
      ['Third after a gap.'],
      [
        '1. A list item that is long enough to reach the',
        'right edge, continued with a hanging indent',
      ],
      ['2. Second item'],
    ]);
    expect(paras.map((p) => [p.spaced, p.list])).toEqual([
      [false, false],
      [false, false],
      [true, false],
      [false, true],
      [false, true],
    ]);
  });

  it('keeps centred letterhead lines apart when the next first word would have fit, and joins a wrapped centred title', () => {
    // Sharing the same center line, left coordinates differ by only 9 and 15 pixels (less than half
    // a line height). The full-width body text below spans 129–1239: "Telefon" appended to the
    // previous line would fit even while centered, yet it wrapped, indicating line-by-line layout.
    const lines = [
      line('Praxis für Allgemeinmedizin · Dr. med. Lena Hartmann', 279, 158, 849, 37),
      line('Lindenstraße 14, 79098 Freiburg im Breisgau', 347, 207, 713, 41),
      line('Telefon 0761 555 0192 · Fax 0761 555 0193', 356, 256, 695, 37),
      line('Sprechzeiten Montag bis Freitag 8–12 Uhr', 371, 308, 666, 37),
    ];
    const body = line(
      'Ibuprofen 400 mg, one tablet up to three times a day with food',
      129,
      475,
      1110,
      40,
    );
    expect(paragraphsOf(lines, [body])).toHaveLength(4);
    // Centered title wrapped across two lines of similar length: the first word of the second line does not fit within the column width, so it is the same paragraph.
    const title = [
      line('Annual report on the regional water quality of', 200, 100, 600, 40),
      line('measurements taken in the alpine lakes', 215, 145, 570, 40),
    ];
    const narrow = line('Body text of this column.', 200, 260, 600, 40);
    expect(paragraphsOf(title, [narrow])).toHaveLength(1);
  });

  it('does not take the widest of a few short lines as the right edge when the column around them is wider', () => {
    const pets = line(
      'Pets are allowed with the written consent of the landlord. Small',
      170,
      438,
      1081,
      46,
    );
    const lines = [
      line('Subletting is not permitted.', 170, 540, 318, 37),
      line('Inventory checked: Ok', 170, 603, 263, 31),
    ];
    // Upper body text in the same column reaches 1251: "Inventory" fits after 488, so these are two paragraphs.
    expect(paragraphsOf(lines, [pets])).toHaveLength(2);
    // Lines in other columns (with unaligned left edges) do not count toward this column's width.
    expect(paragraphsOf(lines, [{ ...pets, x: 700, width: 500 }])).toHaveLength(1);
  });
});

describe('OCR region paragraph fragments', () => {
  it('keeps the legacy joining of an unrepaired paragraph, including a label and decimal value', () => {
    const lines = [line('Total due', 100, 200, 180, 24), line('739.55', 100, 230, 170, 24)];
    const joinLines = (ls: readonly OcrBox[]) => ls.map((l) => l.text).join('\n');
    const joinParagraph = vi.fn((ls: readonly OcrBox[]) => ls.map((l) => l.text).join(' '));
    const doc = buildDocPage(
      { image: renderPage(W, H, []), lines, source: 's', skew: 0 },
      { joinLines, joinParagraph },
    );
    expect(leafBlocks(doc)[0]).toMatchObject({ kind: 'paragraph', text: 'Total due\n739.55' });
    expect(joinParagraph).not.toHaveBeenCalled();
  });
  it('retains the legacy joiner on dense pages as well as retaining their region groups', () => {
    const lines = Array.from({ length: 90 }, (_, i) =>
      line('A long line of ordinary text on a dense page.', 100, 30 + i * 12, 700, 10),
    );
    const joinLines = vi.fn((ls: readonly OcrBox[]) => ls.map((l) => l.text).join(' '));
    const joinParagraph = vi.fn(() => 'A replacement that must not be used here');
    const doc = buildDocPage(
      { image: renderPage(W, H, []), lines, source: 's', skew: 0 },
      { joinLines, joinParagraph },
    );
    expect(leafBlocks(doc).length).toBeGreaterThan(0);
    expect(joinLines).toHaveBeenCalled();
    expect(joinParagraph).not.toHaveBeenCalled();
  });
  const body = [
    {
      text: 'A complete opening line reaches the column edge before it wraps',
      x: 100,
      y: 200,
      width: 700,
    },
    {
      text: 'The following line continues the same paragraph across the region boundary',
      x: 100,
      y: 225,
      width: 700,
    },
    {
      text: 'More of the same paragraph reaches the column edge once again',
      x: 100,
      y: 250,
      width: 700,
    },
    { text: 'ending here.', x: 100, y: 275, width: 160 },
  ];
  const region = (y: number, height: number): LayoutRegion => ({
    kind: 'text',
    label: 'text',
    score: 0.9,
    box: { x: 95, y, width: 715, height },
  });
  const paragraphs = (rows: typeof body, regions: LayoutRegion[]) => {
    const { image, lines } = textPage(rows);
    return leafBlocks(buildDocPage({ image, lines, regions, source: 's', skew: 0 })).filter(
      (b): b is DocParagraph => b.kind === 'paragraph',
    );
  };
  it.each([
    ['unowned first line', [region(223, 80)]],
    ['unowned final line', [region(195, 77)]],
    ['nested model regions', [region(190, 120), region(223, 80)]],
    [
      'nested model regions with edge jitter',
      [
        region(190, 120),
        {
          ...region(223, 80),
          box: { ...region(223, 80).box, x: 91 },
        },
      ],
    ],
  ])('reconciles %s from physical wrapping evidence without losing any line', (_, regions) => {
    const paras = paragraphs(body, regions as LayoutRegion[]);
    expect(paras).toHaveLength(1);
    expect(paras[0]!.text).toBe(body.map((r) => r.text).join(' '));
  });
  it('keeps a genuine paragraph indent or large gap across an ownership boundary', () => {
    const indented = [...body.slice(0, 3), { ...body[3]!, x: 150 }];
    expect(paragraphs(indented, [region(195, 77)])).toHaveLength(2);
    const spaced = [...body.slice(0, 3), { ...body[3]!, y: 340 }];
    expect(paragraphs(spaced, [region(195, 77)])).toHaveLength(2);
  });

  it('does not absorb separate single-line metadata just because another paragraph shares its region', () => {
    const rows = [
      { text: 'Elena Martin | ID: DOC-106-1 | 2026-10-15', x: 100, y: 175, width: 700 },
      { text: 'Northfield Municipal Office', x: 100, y: 200, width: 300 },
      ...body.slice(0, 3).map((r, i) => ({ ...r, y: 250 + i * 25 })),
    ];
    const paras = paragraphs(rows, [region(195, 130)]);
    expect(paras).toHaveLength(3);
    expect(paras[0]!.text).toBe(rows[0]!.text);
    expect(paras[1]!.text).toBe(rows[1]!.text);
  });

  it('preserves independently inferred font sizes when a region boundary separates different styles', () => {
    const { image, lines } = textPage(body.map((r, i) => ({ ...r, h: i === 0 ? 27 : 20 })));
    const doc = buildDocPage({ image, lines, regions: [region(223, 80)], source: 's', skew: 0 });
    const paras = leafBlocks(doc).filter((b): b is DocParagraph => b.kind === 'paragraph');
    expect(paras).toHaveLength(2);
    expect(paras[0]!.text).toBe(body[0]!.text);
    expect(paras[0]!.size).toBeGreaterThan(paras[1]!.size ?? doc.bodySize);
  });
});

describe('paragraphsOf: centered lines (D-463)', () => {
  it('keeps centered letter-head lines one per paragraph, but still joins wrapped prose', () => {
    // Prescription header: each line centered with similar width, widest line defines the right boundary; previously "CDS 20 PANTIN" and the address on the next line were joined together as wrapped text.
    const head = [
      line('CENTRE DE SANTE', 473, 124, 304, 31),
      line('CDS 20 PANTIN', 502, 175, 243, 32),
      line('20 rue du pré saint Gervais', 478, 229, 292, 30),
      line('93500 Pantin', 552, 269, 144, 27),
      line('Tél: 01 48 46 66 66', 519, 309, 211, 27),
      line('NoFINESS :93 002 730 5', 487, 348, 275, 29),
    ];
    expect(paragraphsOf(head).map((p) => p.rows.map((r) => r.text))).toEqual(
      head.map((l) => [l.text]),
    );
    // Left-aligned prose extending to the right is correctly joined into a single paragraph.
    const prose = [
      line('A long line of body text that runs to the right', 100, 100, 800),
      line('edge and wraps here.', 100, 125, 300),
    ];
    expect(paragraphsOf(prose)).toHaveLength(1);
  });

  it('does not put a small tagline into the row of the big wordmark whose box reaches over it (EU sample 091)', () => {
    // Marker text with a 136-pixel-high box presses down onto the slogan (24 pixels high), overlapping vertically.
    const head = [
      line('flexPEDIA', 456, 72, 505, 136),
      line('FLEX OPLOSSINGEN WAAR JE BLIJ VAN WORDT', 478, 191, 471, 24),
    ];
    expect(paragraphsOf(head).map((p) => p.rows.map((r) => r.text))).toEqual([
      ['flexPEDIA'],
      ['FLEX OPLOSSINGEN WAAR JE BLIJ VAN WORDT'],
    ]);
  });
});

describe('clusterLines', () => {
  it('keeps a letter head’s address (left) and date (right) apart, and splits at big gaps', () => {
    const lines = [
      line('PARIS TURBIGO', 80, 300, 200),
      line('PARIS, le 12 juillet 2018', 650, 300, 280),
      line('78 RUE DE TURBIGO', 80, 325, 220),
      line('75003 PARIS', 80, 350, 150),
      line('Madame, Monsieur,', 80, 500, 240),
    ];
    const clusters = clusterLines(lines, 20).map((c) => c.map((l) => l.text));
    expect(clusters).toEqual([
      ['PARIS TURBIGO', '78 RUE DE TURBIGO', '75003 PARIS'],
      ['PARIS, le 12 juillet 2018'],
      ['Madame, Monsieur,'],
    ]);
  });
});

describe('strokeRatio and textColor', () => {
  it('measures bold strokes as thicker than regular ones', () => {
    const { image, lines } = textPage([
      { text: 'regular', x: 100, y: 100, width: 400, stroke: 2 },
      { text: 'bold', x: 100, y: 200, width: 400, stroke: 5 },
    ]);
    const regular = strokeRatio(image, lines[0]!);
    const bold = strokeRatio(image, lines[1]!);
    expect(regular).toBeGreaterThan(0);
    expect(bold).toBeGreaterThan(1.8 * regular);
  });

  it('does not count a strike-through or an underline as a stroke', () => {
    // Identame text, with an additional horizontal line piercing across the entire line (strikethrough).
    const plain = textPage([{ text: 'a', x: 100, y: 100, width: 400 }]);
    const struck = textPage(
      [{ text: 'a', x: 100, y: 100, width: 400 }],
      [{ x: 100, y: 109, width: 400, height: 2 }],
    );
    expect(strokeRatio(struck.image, struck.lines[0]!)).toBeCloseTo(
      strokeRatio(plain.image, plain.lines[0]!),
      2,
    );
  });

  it('reads the colour of coloured text and nothing for black or gray text', () => {
    const image = renderPage(W, 200, glyphs(100, 50, 300, 20));
    const box = { x: 100, y: 50, width: 300, height: 20 };
    expect(textColor(image, box)).toBeUndefined();
    // Change character pixels to blue.
    const blue = { ...image, data: image.data.slice() };
    for (let i = 0; i < blue.data.length; i += 4) {
      if (blue.data[i]! < 128) blue.data.set([23, 32, 148], i);
    }
    expect(textColor(blue, box)).toBe('172094');
  });
});

describe('hasUnderline (D-463)', () => {
  it('sees a line under the text as long as the text, not a longer rule or a strike-through', () => {
    const box = { x: 100, y: 100, width: 400, height: 20 };
    const text = glyphs(100, 104, 400, 12);
    const page = (extra: Rect[]) => renderPage(W, 300, [...text, ...extra]);
    expect(hasUnderline(page([]), box)).toBe(false);
    // Underline: positioned below text, matching text length.
    expect(hasUnderline(page([{ x: 100, y: 118, width: 400, height: 2 }]), box)).toBe(true);
    // Divider lines, table lines: significantly longer than text.
    expect(hasUnderline(page([{ x: 20, y: 118, width: 900, height: 2 }]), box)).toBe(false);
    // Strikethrough: positioned across the middle of text.
    expect(hasUnderline(page([{ x: 100, y: 109, width: 400, height: 2 }]), box)).toBe(false);
  });
});

describe('foldEmptyColumns', () => {
  it('merges a column that is empty in every row into the cells on its left', () => {
    const table: TableBlock = {
      kind: 'table',
      rows: 2,
      col: 0,
      cols: 3,
      box: { x: 0, y: 0, width: 300, height: 40 },
      cells: [
        { row: 0, col: 0, rowSpan: 1, colSpan: 1, text: 'A' },
        { row: 0, col: 1, rowSpan: 1, colSpan: 2, text: '' },
        { row: 1, col: 0, rowSpan: 1, colSpan: 1, text: 'B' },
        { row: 1, col: 1, rowSpan: 1, colSpan: 1, text: '' },
        { row: 1, col: 2, rowSpan: 1, colSpan: 1, text: '' },
      ],
    };
    const folded = foldEmptyColumns(table);
    expect(folded.cells.map((c) => [c.row, c.col, c.colSpan, c.text])).toEqual([
      [0, 0, 3, 'A'],
      [1, 0, 3, 'B'],
    ]);
    // Middle column contains text: fold only empty columns to its right into it, do not fold the middle column itself.
    const kept = foldEmptyColumns({
      ...table,
      cells: table.cells.map((c) => (c.row === 1 && c.col === 1 ? { ...c, text: 'x' } : c)),
    });
    expect(kept.cells.map((c) => [c.row, c.col, c.colSpan])).toEqual([
      [0, 0, 1],
      [0, 1, 2],
      [1, 0, 1],
      [1, 1, 2],
    ]);
  });
});

describe('buildDocPage', () => {
  const regions = (list: [LayoutRegion['kind'], string, Rect][]): LayoutRegion[] =>
    list.map(([kind, label, box]) => ({ kind, label, score: 0.9, box }));

  it('does not center a line that nearly fills the text width (EU sample 021)', () => {
    // Header text is slightly wider than body text: a line close to full page width with over two line heights of blank space on both sides is not centered.
    const { image, lines } = textPage([
      { text: 'Gazette of the Region', x: 60, y: 100, width: 220, h: 22 },
      { text: 'No. 2292', x: 840, y: 100, width: 100, h: 22 },
      {
        text: 'He was employed at the company from the first of May until today',
        x: 110,
        y: 300,
        width: 780,
        h: 22,
      },
      { text: 'Short note', x: 110, y: 400, width: 120, h: 22 },
    ]);
    const doc = buildDocPage({ image, lines, source: 's', skew: 0 });
    const wide = leafBlocks(doc).find(
      (b): b is DocParagraph => b.kind === 'paragraph' && b.text.startsWith('He was'),
    )!;
    expect(wide.align).toBeUndefined();
  });

  it('preserves independent header rows after the layout regions have been merged', () => {
    const { image, lines } = textPage([
      { text: '陈晓明 | ID: DOC-101-3 | 2026-10-15', x: 105, y: 223, width: 432, h: 31 },
      { text: '开票方：北方工作室', x: 105, y: 279, width: 243, h: 31 },
      { text: '收件人：陈晓明', x: 721, y: 279, width: 189, h: 31 },
    ]);
    const doc = buildDocPage({
      image,
      lines,
      source: 's',
      skew: 0,
      regions: regions([
        ['text', 'text', { x: 100, y: 220, width: 440, height: 35 }],
        ['text', 'text', { x: 100, y: 276, width: 250, height: 35 }],
        ['text', 'text', { x: 715, y: 276, width: 200, height: 35 }],
      ]),
    });
    const paragraphs = leafBlocks(doc)
      .filter((b) => b.kind === 'paragraph')
      .map((b) => b.text);
    expect(paragraphs).toContain('开票方：北方工作室');
    expect(paragraphs).toContain('收件人：陈晓明');
    expect(paragraphs).toContain(lines[0]!.text);
  });

  it('makes headings, paragraphs, lists, a ruled table and an image in reading order', () => {
    const xs = [100, 400, 700];
    const ys = [700, 740, 780];
    const { image, lines } = textPage(
      [
        { text: 'Annual Report', x: 300, y: 60, width: 400, h: 40, stroke: 6 },
        { text: 'This paragraph is the body text of the page and it', x: 100, y: 150, width: 800 },
        { text: 'wraps onto a second line.', x: 100, y: 175, width: 300 },
        { text: '• first point', x: 100, y: 240, width: 300 },
        { text: '• second point', x: 100, y: 265, width: 300 },
        { text: 'Name', x: 120, y: 710, width: 100 },
        { text: 'Total', x: 420, y: 710, width: 100 },
        { text: 'Alice', x: 120, y: 750, width: 100 },
        { text: '12', x: 420, y: 750, width: 40 },
        { text: '3', x: 950, y: 1360, width: 15 },
      ],
      gridRects(xs, ys),
    );
    const doc = buildDocPage({
      image,
      lines,
      source: 'file:///page.jpg',
      skew: 0,
      regions: regions([
        ['title', 'doc_title', { x: 290, y: 50, width: 420, height: 60 }],
        ['text', 'text', { x: 90, y: 140, width: 820, height: 70 }],
        ['image', 'image', { x: 100, y: 400, width: 300, height: 200 }],
        ['pageNumber', 'number', { x: 940, y: 1350, width: 40, height: 40 }],
      ]),
    });
    expect(doc.blocks.map((b) => b.kind)).toEqual([
      'paragraph',
      'paragraph',
      'list',
      'image',
      'table',
    ]);
    const [title, body, list] = doc.blocks as [DocParagraph, DocParagraph, DocList];
    expect(title).toMatchObject({ text: 'Annual Report', heading: 1, bold: true, align: 'center' });
    expect(body.text).toBe(
      'This paragraph is the body text of the page and it wraps onto a second line.',
    );
    expect(body.heading).toBeUndefined();
    expect(body.bold).toBeUndefined();
    expect(body.size).toBeUndefined();
    expect(list).toMatchObject({ ordered: false, items: ['first point', 'second point'] });
    const table = doc.blocks[4]!;
    expect(table.kind === 'table' && table.table.cells.map((c) => c.text)).toEqual([
      'Name',
      'Total',
      'Alice',
      '12',
    ]);
    expect(table.kind === 'table' && table.colWidths).toEqual([300, 300]);
    // Page numbers are not written to file.
    expect(JSON.stringify(doc.blocks)).not.toContain('"3"');
    expect(doc.bodySize).toBeGreaterThanOrEqual(9);
    expect(doc.bodySize).toBeLessThanOrEqual(12);
  });

  it('keeps short text the layout model calls a page number unless it reads like one', () => {
    const { image, lines } = textPage([
      {
        text: 'Il Ministro decreta quanto segue per tutte le parti della legge',
        x: 100,
        y: 150,
        width: 800,
      },
      { text: 'Decreta:', x: 440, y: 1150, width: 120 },
      { text: 'Art. 1', x: 450, y: 1210, width: 100 },
      { text: 'n.a.', x: 100, y: 1270, width: 45 },
      { text: 'Pagina 2 di 3', x: 820, y: 1360, width: 140 },
    ]);
    const doc = buildDocPage({
      image,
      lines,
      source: 's',
      skew: 0,
      regions: regions([
        ['text', 'text', { x: 90, y: 140, width: 820, height: 40 }],
        ['pageNumber', 'number', { x: 445, y: 1205, width: 110, height: 30 }],
        ['pageNumber', 'number', { x: 95, y: 1265, width: 55, height: 30 }],
        ['pageNumber', 'number', { x: 815, y: 1355, width: 150, height: 30 }],
      ]),
    });
    const text = leafBlocks(doc)
      .flatMap((b) => (b.kind === 'paragraph' ? [b.text] : []))
      .join('\n');
    expect(text).toContain('Art. 1');
    expect(text).toContain('n.a.');
    // Actual page numbers remain unwritten as before (D-334).
    expect(text).not.toContain('Pagina 2');
  });

  it('does not take decorative asterisks or dashes around a line for a bullet', () => {
    const { image, lines } = textPage([
      { text: '*** ATTO COMPLETO ***', x: 380, y: 100, width: 240 },
      { text: 'Il testo segue qui sotto.', x: 100, y: 160, width: 300 },
      { text: '– Anmeldebestätigung –', x: 380, y: 260, width: 240 },
      { text: 'Bitte aufbewahren.', x: 100, y: 320, width: 250 },
      { text: '*********RECHNUNG**********', x: 340, y: 420, width: 320 },
      { text: 'Tisch: 137', x: 100, y: 480, width: 120 },
      { text: '- echter Punkt eins', x: 100, y: 580, width: 260 },
      { text: '- echter Punkt zwei', x: 100, y: 605, width: 260 },
    ]);
    const doc = buildDocPage({ image, lines, source: 's', skew: 0 });
    const leaves = leafBlocks(doc);
    const paragraphs = leaves.flatMap((b) => (b.kind === 'paragraph' ? [b.text] : []));
    expect(paragraphs).toContain('*** ATTO COMPLETO ***');
    expect(paragraphs).toContain('– Anmeldebestätigung –');
    expect(paragraphs).toContain('*********RECHNUNG**********');
    expect(leaves.filter((b) => b.kind === 'list')).toMatchObject([
      { items: ['echter Punkt eins', 'echter Punkt zwei'] },
    ]);
  });

  it('does not take a date at the start of a line for a numbered item (EU sample 076)', () => {
    const { image, lines } = textPage([
      { text: '21. APR. 2006', x: 100, y: 100, width: 180 },
      { text: 'Gültig vom', x: 100, y: 200, width: 140 },
      { text: '1. Januar 2024 bis 31. März 2024', x: 100, y: 260, width: 400 },
      { text: 'Termin', x: 100, y: 360, width: 100 },
      { text: '3. 4. 2025', x: 100, y: 420, width: 130 },
      { text: 'Ablauf', x: 100, y: 520, width: 100 },
      { text: '1. Erstens kommt der Antrag.', x: 100, y: 580, width: 380 },
      { text: '2. Zweitens kommt der Bescheid.', x: 100, y: 605, width: 400 },
    ]);
    const doc = buildDocPage({ image, lines, source: 's', skew: 0 });
    const leaves = leafBlocks(doc);
    const paragraphs = leaves.flatMap((b) => (b.kind === 'paragraph' ? [b.text] : []));
    expect(paragraphs).toContain('21. APR. 2006');
    expect(paragraphs).toContain('1. Januar 2024 bis 31. März 2024');
    expect(paragraphs).toContain('3. 4. 2025');
    expect(leaves.filter((b) => b.kind === 'list')).toMatchObject([
      {
        ordered: true,
        start: 1,
        items: ['Erstens kommt der Antrag.', 'Zweitens kommt der Bescheid.'],
      },
    ]);
  });

  it('does not take bracketed field codes for numbered items (EU sample 089)', () => {
    // EU uniform registration certificate: cell numbers "(12)", "(13)" are field codes, not list numbers.
    const { image, lines } = textPage([
      { text: '(12) (13)', x: 100, y: 100, width: 120 },
      { text: 'Masse', x: 100, y: 200, width: 100 },
      { text: '(6)', x: 100, y: 300, width: 45 },
      { text: 'Bemerkungen', x: 100, y: 400, width: 160 },
      { text: '(1) Erstens kommt der Antrag.', x: 100, y: 500, width: 380 },
      { text: '(2) Zweitens kommt der Bescheid.', x: 100, y: 525, width: 400 },
    ]);
    const doc = buildDocPage({ image, lines, source: 's', skew: 0 });
    const leaves = leafBlocks(doc);
    const paragraphs = leaves.flatMap((b) => (b.kind === 'paragraph' ? [b.text] : []));
    expect(paragraphs).toContain('(12) (13)');
    expect(paragraphs).toContain('(6)');
    expect(leaves.filter((b) => b.kind === 'list')).toMatchObject([
      {
        ordered: true,
        start: 1,
        items: ['Erstens kommt der Antrag.', 'Zweitens kommt der Bescheid.'],
      },
    ]);
  });

  it('without layout regions still makes paragraphs and numbered lists from positions', () => {
    const { image, lines } = textPage([
      { text: 'Conditions', x: 100, y: 60, width: 300, h: 40 },
      { text: '1) Delivery takes two weeks.', x: 100, y: 150, width: 500 },
      { text: '2) Payment on delivery.', x: 100, y: 175, width: 450 },
    ]);
    const doc = buildDocPage({ image, lines, source: 's', skew: 0 });
    expect(doc.blocks).toMatchObject([
      { kind: 'paragraph', text: 'Conditions', heading: 1 },
      {
        kind: 'list',
        ordered: true,
        format: '%1)',
        start: 1,
        items: ['Delivery takes two weeks.', 'Payment on delivery.'],
      },
    ]);
  });

  it('starts a new numbered list when the number does not continue the last item (EU sample 037)', () => {
    const { image, lines } = textPage([
      { text: '1. Opening of the meeting', x: 100, y: 150, width: 420 },
      { text: '2. Reading of the rules', x: 100, y: 175, width: 400 },
      { text: '3. Any other business', x: 100, y: 200, width: 380 },
      { text: '1. Decisions:', x: 100, y: 225, width: 220 },
      { text: '1. The meeting opened at ten o’clock.', x: 100, y: 250, width: 560 },
    ]);
    const doc = buildDocPage({ image, lines, source: 's', skew: 0 });
    const shown = leafBlocks(doc).flatMap((b) =>
      b.kind === 'list' ? b.items.map((t, i) => `${(b.start ?? 1) + i} ${t}`) : [],
    );
    expect(shown).toEqual([
      '1 Opening of the meeting',
      '2 Reading of the rules',
      '3 Any other business',
      '1 Decisions:',
      '1 The meeting opened at ten o’clock.',
    ]);
  });

  it('keeps a force-justified line whose words OCR returned one by one as one line (EU sample 037)', () => {
    const words = ['whose', 'seat', 'is', 'set', 'at', '(full', 'address)'];
    const { image, lines } = textPage([
      {
        text: 'The meeting decided to found the association named below.',
        x: 100,
        y: 100,
        width: 800,
      },
      ...words.map((text, i) => ({ text, x: 100 + i * 120, y: 160, width: 60 })),
      { text: 'The chair then presents the draft statutes.', x: 100, y: 220, width: 620 },
    ]);
    const doc = buildDocPage({ image, lines, source: 's', skew: 0 });
    const texts = leafBlocks(doc).flatMap((b) => (b.kind === 'paragraph' ? [b.text] : []));
    expect(texts.some((t) => t.includes('whose seat is set at (full address)'))).toBe(true);
  });

  it('still splits a row whose far-apart pieces are not single words with even gaps', () => {
    const { image, lines } = textPage([
      { text: 'Atelier Lindenhof', x: 100, y: 100, width: 220 },
      { text: 'Rechnung RE-2026-0311', x: 600, y: 100, width: 300 },
    ]);
    const doc = buildDocPage({ image, lines, source: 's', skew: 0 });
    const texts = leafBlocks(doc).flatMap((b) => (b.kind === 'paragraph' ? [b.text] : []));
    expect(texts.some((t) => t.includes('Lindenhof Rechnung'))).toBe(false);
  });

  it('keeps each number of a numbered item column with its own text (EU sample 032)', () => {
    const items = [
      'Name of the manufacturer:',
      'Object of the declaration:',
      'The object is in conformity with the following Directives:',
      'References to the harmonised standards used:',
      'Additional information:',
    ];
    const rows = items.flatMap((text, i) => [
      { text: `${i + 2}.`, x: 100, y: 120 + i * 70, width: 24 },
      { text, x: 190, y: 120 + i * 70, width: 14 * text.length },
    ]);
    const { image, lines } = textPage(rows);
    // Layout model categorized numbering into a major region, while item clauses have a separate minor region.
    const doc = buildDocPage({
      image,
      lines,
      source: 's',
      skew: 0,
      regions: regions([
        ['text', 'text', { x: 95, y: 110, width: 800, height: 380 }],
        ['text', 'text', { x: 105, y: 115, width: 500, height: 32 }],
      ]),
    });
    // Numbering formatted as list numbers is also acceptable: compute displayed numbers based on starting list number.
    const texts = leafBlocks(doc).flatMap((b) =>
      b.kind === 'paragraph'
        ? [b.text]
        : b.kind === 'list'
          ? b.items.map((t, k) => `${(b.start ?? 1) + k}. ${t}`)
          : [],
    );
    for (const [i, text] of items.entries())
      expect(texts.some((t) => t.startsWith(`${i + 2}.`) && t.includes(text))).toBe(true);
    expect(leafBlocks(doc).some((b) => b.kind === 'paragraph' && b.text === '2.')).toBe(false);
  });

  it('does not centre a ragged-right paragraph whose lines share one left edge (EU sample 036)', () => {
    // Similar spacing on both left and right of text (full-page image pushed left and right text bounds to paper edges), but lines are left-aligned with ragged right edges: left-aligned.
    const { image, lines } = textPage([
      { text: 'A margin note sits at the far left.', x: 5, y: 60, width: 300 },
      {
        text: 'The programme supports schools and towns in planning their buildings',
        x: 160,
        y: 200,
        width: 680,
      },
      {
        text: 'and offers a library of tools, independent advice and a community',
        x: 160,
        y: 228,
        width: 600,
      },
      { text: 'A footer mark sits at the far right.', x: 690, y: 1300, width: 305 },
    ]);
    const doc = buildDocPage({
      image,
      lines,
      source: 's',
      skew: 0,
      paper: { width: 595, height: 842 },
    });
    const para = leafBlocks(doc).find(
      (b): b is DocParagraph => b.kind === 'paragraph' && b.text.startsWith('The programme'),
    );
    expect(para?.text).toContain('and offers a library');
    expect(para?.align).toBeUndefined();
  });

  it('treats a picture region full of body text as text, not as a picture', () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      text: `Line ${i + 1} of a long paragraph that fills the page width`,
      x: 100,
      y: 100 + i * 25,
      width: 800,
    }));
    const { image, lines } = textPage(rows);
    const doc = buildDocPage({
      image,
      lines,
      source: 's',
      skew: 0,
      regions: regions([['image', 'image', { x: 90, y: 90, width: 820, height: 140 }]]),
    });
    expect(doc.blocks.map((b) => b.kind)).toEqual(['paragraph']);
  });

  it('does not take a quoted line of dialogue or a long sentence for a heading (D-330)', () => {
    const { image, lines } = textPage([
      { text: 'Chapter One', x: 100, y: 60, width: 300, h: 30 },
      { text: '“Why not, then?”', x: 140, y: 150, width: 300, h: 30 },
      {
        text: 'This sentence is printed a little larger than the rest of the page.',
        x: 100,
        y: 230,
        width: 800,
        h: 30,
      },
      {
        text: 'Body text of the page goes here and runs on to the right',
        x: 100,
        y: 330,
        width: 800,
      },
      {
        text: 'edge of the block before it wraps, and goes on for a few more',
        x: 100,
        y: 355,
        width: 800,
      },
      {
        text: 'lines so that the body size is clear from the median line',
        x: 100,
        y: 380,
        width: 800,
      },
      { text: 'height.', x: 100, y: 405, width: 100 },
    ]);
    const doc = buildDocPage({
      image,
      lines,
      source: 's',
      skew: 0,
      // The layout model treats the dialogue as a title (book pages in experiments are structured this way).
      regions: regions([['title', 'paragraph_title', { x: 130, y: 140, width: 320, height: 50 }]]),
    });
    const paras = doc.blocks as DocParagraph[];
    expect(paras.map((p) => [p.text.slice(0, 12), p.heading])).toEqual([
      ['Chapter One', 2],
      ['“Why not, th', undefined],
      ['This sentenc', undefined],
      ['Body text of', undefined],
    ]);
  });

  it('keeps the first-line indent of a paragraph (D-330)', () => {
    const { image, lines } = textPage([
      {
        text: 'Indented first line of a paragraph that runs on to the',
        x: 160,
        y: 100,
        width: 740,
      },
      { text: 'right edge and wraps back to the left margin.', x: 100, y: 125, width: 600 },
      // Single-line paragraph: compared to the left edge of other lines in this block.
      { text: 'A short indented line.', x: 160, y: 150, width: 300 },
      { text: 'Next paragraph without an indent runs on to the right', x: 100, y: 175, width: 800 },
      { text: 'edge as well.', x: 100, y: 200, width: 200 },
      // Single line in its own block (dialogue in a standalone region on a book page): compared to the left margin of the entire page; stray characters in the margin do not count as the left margin.
      { text: '“A line of dialogue on its own.”', x: 160, y: 300, width: 400 },
      { text: 'A line on its own at the margin.', x: 100, y: 400, width: 400 },
      { text: '00', x: 20, y: 600, width: 30 },
    ]);
    const doc = buildDocPage({ image, lines, source: 's', skew: 0 });
    const paras = doc.blocks as DocParagraph[];
    // Paragraphs with only a single line have no first-line indent (D-463): docx writes left indentation based on its left side, see "places each paragraph" in docx.test.
    expect(paras.map((p) => [p.text.slice(0, 10), p.indent, Math.round(p.box.x)])).toEqual([
      ['Indented f', 60, 100],
      ['A short in', undefined, 160],
      ['Next parag', undefined, 100],
      ['“A line of', undefined, 160],
      ['A line on ', undefined, 100],
      ['00', undefined, 20],
    ]);
  });

  it('puts side-by-side tables and text columns into one row, the rest top to bottom (D-331)', () => {
    const { image, lines } = textPage(
      [
        { text: 'Report', x: 100, y: 40, width: 200, h: 30 },
        // Two tables side by side with overlapping vertical ranges.
        { text: 'A', x: 120, y: 110, width: 40 },
        { text: '1', x: 320, y: 110, width: 20 },
        { text: 'B', x: 620, y: 110, width: 40 },
        { text: '2', x: 820, y: 110, width: 20 },
        // Two text columns side by side.
        { text: 'Left column first line of text that runs', x: 100, y: 300, width: 380 },
        { text: 'on to a second line.', x: 100, y: 325, width: 200 },
        { text: 'Right column first line of text that runs', x: 600, y: 300, width: 380 },
        { text: 'on to a second line too.', x: 600, y: 325, width: 220 },
        { text: 'Closing line across the page.', x: 100, y: 500, width: 600 },
      ],
      [...gridRects([100, 300, 400], [100, 140]), ...gridRects([600, 800, 900], [100, 140])],
    );
    const doc = buildDocPage({ image, lines, source: 's', skew: 0 });
    expect(doc.blocks.map((b) => b.kind)).toEqual(['paragraph', 'row', 'row', 'paragraph']);
    const tables = doc.blocks[1] as DocRow;
    expect(tables.cells.map((c) => c.blocks.map((b) => b.kind))).toEqual([['table'], ['table']]);
    // Column width based on original image position: from the left of the first cell to the second, and the last cell to its right edge.
    expect(tables.cells.map((c) => Math.round(c.width))).toEqual([500, 300]);
    const columns = doc.blocks[2] as DocRow;
    expect(
      columns.cells.map((c) => c.blocks.map((b) => (b as DocParagraph).text.slice(0, 5))),
    ).toEqual([['Left '], ['Right']]);
    expect(leafBlocks(doc).map((b) => b.kind)).toEqual([
      'paragraph',
      'table',
      'table',
      'paragraph',
      'paragraph',
      'paragraph',
    ]);
  });

  it('drops short stray marks at the page edge or far from the text, keeps short real text (D-334)', () => {
    const { image, lines } = textPage([
      // Corner smudges recognized as "00": adjacent to the page edge, with bounding boxes much taller than body lines.
      { text: '00', x: 4, y: 0, width: 40, h: 90 },
      { text: 'GENERAL CONDITIONS', x: 300, y: 150, width: 400, h: 30 },
      { text: 'Never put a hot pan directly on the worktop, use a', x: 100, y: 250, width: 800 },
      { text: 'trivet.', x: 100, y: 275, width: 100 },
      // Signature recognized as "Q": far away from other text, low confidence.
      { text: 'Q', x: 600, y: 500, width: 40, h: 50 },
      // Numbering (such as "②") that is far away, accurately recognized, and as tall as body text is kept.
      { text: '(2)', x: 100, y: 700, width: 30 },
      { text: 'Ok', x: 100, y: 900, width: 30 },
    ]);
    const scored = lines.map((l) =>
      l.text === 'Q' ? { ...l, score: 0.6 } : { ...l, score: l.text === '00' ? 0.95 : 0.99 },
    );
    const doc = buildDocPage({ image, lines: scored, source: 's', skew: 0 });
    const texts = leafBlocks(doc).map((b) => (b.kind === 'paragraph' ? b.text : ''));
    expect(texts).not.toContain('00');
    expect(texts).not.toContain('Q');
    expect(texts).toContain('(2)');
    expect(texts).toContain('Ok');
    expect(texts[0]).toBe('GENERAL CONDITIONS');
  });

  it('keeps a short tall code printed white on a coloured band (EU sample 056)', () => {
    // Large white text "A1" on the green form header bar: short, tall, and far from other text, but not a smudge.
    const code = { x: 120, y: 120, width: 80, height: 70 };
    const white: Rect[] = [];
    for (let s = 0; s + 6 <= code.width; s += 14)
      white.push({ x: code.x + s, y: code.y + 12, width: 6, height: 46, shade: 255 });
    const band: Rect = { x: 100, y: 100, width: 800, height: 110, color: [74, 140, 63] };
    const { image, lines } = textPage(
      [
        { text: 'INFORMATION FOR THE HOLDER', x: 100, y: 400, width: 400 },
        {
          text: 'This certificate concerns the legislation which applies to you.',
          x: 100,
          y: 440,
          width: 800,
        },
      ],
      [...white, band],
    );
    const a1 = fakeLine('A1', code, page);
    const doc = buildDocPage({ image, lines: [a1, ...lines], source: 's', skew: 0 });
    const texts = leafBlocks(doc).map((b) => (b.kind === 'paragraph' ? b.text : ''));
    expect(texts).toContain('A1');
  });

  it('sizes a form in proportion to the page, down to about 6 pt; prose stays at 9 pt or more (D-335)', () => {
    // Original image width of 1000 pixels scaled to A4 595 points: 13-pixel-tall text is approximately 7 points.
    const form = textPage(
      Array.from({ length: 8 }, (_, i) => [
        { text: `LABEL ${i}`, x: 80, y: 100 + i * 30, width: 90, h: 13 },
        { text: `${i}0,00`, x: 700, y: 100 + i * 30, width: 50, h: 13 },
      ]).flat(),
    );
    expect(buildDocPage({ ...form, source: 's', skew: 0 }).bodySize).toBe(7);
    const tiny = textPage([
      { text: 'NAME', x: 80, y: 100, width: 40, h: 9 },
      { text: 'DATE', x: 80, y: 130, width: 40, h: 9 },
    ]);
    expect(buildDocPage({ ...tiny, source: 's', skew: 0 }).bodySize).toBe(6);
    // Terms page: text is equally small, but consists of long wrapped paragraphs; body text is at least 9 points.
    const prose = textPage(
      Array.from({ length: 4 }, (_, p) =>
        [0, 1, 2].map((r) => ({
          text: `Paragraph ${p} line ${r} of small print that runs across the whole page width`,
          x: 80,
          y: 100 + p * 80 + r * 18,
          width: r === 2 ? 400 : 840,
          h: 13,
        })),
      ).flat(),
    );
    expect(buildDocPage({ ...prose, source: 's', skew: 0 }).bodySize).toBe(9);
  });

  it('gives a ruled table the size of its own text (D-335)', () => {
    const { image, lines } = textPage(
      [
        {
          text: 'Some body text that wraps across the page width here',
          x: 100,
          y: 100,
          width: 800,
        },
        { text: 'and ends on this line.', x: 100, y: 125, width: 300 },
        { text: 'Name', x: 120, y: 712, width: 60, h: 13 },
        { text: 'Total', x: 420, y: 712, width: 60, h: 13 },
        { text: 'Alice', x: 120, y: 752, width: 60, h: 13 },
        { text: '12', x: 420, y: 752, width: 20, h: 13 },
      ],
      gridRects([100, 400, 700], [700, 740, 780]),
    );
    const doc = buildDocPage({ image, lines, source: 's', skew: 0 });
    const table = leafBlocks(doc).find((b) => b.kind === 'table');
    expect(table).toMatchObject({ size: 7 });
  });

  it('keeps each line of a table cell on its own line in Word (D-333)', () => {
    const { image, lines } = textPage(
      [
        { text: 'Logement F44', x: 120, y: 110, width: 200 },
        { text: 'Valable 2030', x: 120, y: 135, width: 200 },
        { text: 'Type Habitation', x: 120, y: 160, width: 200 },
        { text: 'Date 21/02', x: 420, y: 110, width: 200 },
      ],
      gridRects([100, 400, 900], [100, 200]),
    );
    // The app's joining logic (D-268) joins sufficiently long lines into a single paragraph; table cells wrap according to the original image.
    const join = (ls: readonly OcrBox[]) =>
      [...ls]
        .sort((a, b) => a.y - b.y)
        .map((l) => l.text)
        .join(' ');
    const doc = buildDocPage({ image, lines, source: 's', skew: 0 }, { joinLines: join });
    const table = leafBlocks(doc).find((b) => b.kind === 'table');
    expect(table?.kind === 'table' && table.table.cells[0]!.text).toBe(
      'Logement F44\nValable 2030\nType Habitation',
    );
  });

  it('sizes text on a landscape page by the landscape paper width, not the portrait A4 width (EU sample 017)', () => {
    // Landscape A4 (842 × 595 points) rendered at 1400 × 990 pixels: 20-pixel-tall lines are approximately 842 × 0.9 × 20 / 1400 ≈ 11 points.
    const LW = 1400;
    const LH = 990;
    const rects: Rect[] = [];
    const lines: OcrBox[] = [];
    [
      'An editable paragraph on a landscape source page.',
      'The same landscape page continues with a second line.',
      'And a third body line keeps the size estimate stable.',
    ].forEach((text, i) => {
      const y = 100 + i * 45;
      for (let s = 0; s + 2 <= 900; s += 9)
        rects.push({ x: 80 + s, y: y + 4, width: 2, height: 12 });
      lines.push(fakeLine(text, { x: 80, y, width: 900, height: 20 }, { width: LW, height: LH }));
    });
    const image = renderPage(LW, LH, rects);
    const pdf = buildDocPage({
      image,
      lines,
      source: 's',
      paper: { width: 841.9, height: 595.3 },
      skew: 0,
    });
    // Old estimation based on 595 points: about 7.7 points (only 0.71x of original), raised to 9 points by the body text minimum limit.
    expect(pdf.bodySize).toBeGreaterThanOrEqual(10.5);
    // Photos taken in landscape orientation lack paper information, and Word treats the page as landscape A4: text size remains the same.
    expect(buildDocPage({ image, lines, source: 's', skew: 0 }).bodySize).toBe(pdf.bodySize);
  });

  it('calibrates fonts to a known narrow PDF before applying the readable body minimum', () => {
    const { image, lines } = textPage([
      {
        text: 'An editable paragraph on the narrow source paper.',
        x: 60,
        y: 100,
        width: 800,
        h: 32,
      },
      {
        text: 'The same source contains another complete body line.',
        x: 60,
        y: 150,
        width: 800,
        h: 32,
      },
      { text: 'This physical paper is about half the A4 width.', x: 60, y: 200, width: 800, h: 32 },
    ]);
    const old = buildDocPage({ image, lines, source: 's', skew: 0 });
    const narrow = buildDocPage({
      image,
      lines,
      source: 's',
      paper: { width: 300, height: 420 },
      skew: 0,
    });
    const letter = buildDocPage({
      image,
      lines,
      source: 's',
      paper: { width: 612, height: 792 },
      skew: 0,
    });
    expect(narrow.bodySize).toBe(9);
    expect(narrow.bodySize).toBeLessThan(old.bodySize);
    expect(letter.bodySize).toBe(old.bodySize);
  });
  it('gives a photo without paper metadata a page with its own proportions', () => {
    const page = (width: number, height: number) => {
      const lines = [
        fakeLine('Corner Bakery', { x: 150, y: 80, width: 300, height: 30 }, { width, height }),
        fakeLine(
          'Total 12.50',
          { x: 150, y: height - 200, width: 260, height: 30 },
          { width, height },
        ),
      ];
      return buildDocPage({
        image: renderPage(
          width,
          height,
          lines.flatMap((l) => glyphs(l.x, l.y + 6, l.width, 18)),
        ),
        lines,
        source: 'receipt.jpg',
        skew: 0,
      });
    };
    // Pages not matching the A4 aspect ratio (such as Letter): paper aspect ratio matches the photo, using the same scale for both dimensions without squishing the vertical axis.
    const letter = page(1000, 1290);
    expect(letter.paper!.width).toBeCloseTo(595.3, 1);
    expect(letter.paper!.height / letter.paper!.width).toBeCloseTo(1290 / 1000, 3);
    // Photos close to A4 aspect ratio are still treated as A4; tall and narrow receipts have no assigned paper size and use continuous layout like older versions, naturally paginating without being squished into a single A4 page.
    expect(page(1000, 1400).paper).toEqual({ width: 595.3, height: 841.9 });
    expect(page(600, 1500).paper).toBeUndefined();
    expect(page(600, 2400).paper).toBeUndefined();
  });
  it('fits a PDF page far larger than A3 (a scan stored at one point per pixel) to A4 width', () => {
    const { image, lines } = textPage([
      {
        text: 'Montant total prélevé ce mois-ci sur votre compte bancaire',
        x: 60,
        y: 150,
        width: 800,
      },
      { text: 'Le détail de vos communications se trouve en page 2.', x: 60, y: 180, width: 700 },
    ]);
    const build = (paper: { width: number; height: number }) =>
      buildDocPage({ image, lines, source: 's', paper, skew: 0 });
    const scan = build({ width: 2481, height: 3508.5 });
    const a4 = build({ width: 595.3, height: 841.9 });
    expect(scan.paper!.width).toBeCloseTo(595.3, 1);
    expect(scan.paper!.height / scan.paper!.width).toBeCloseTo(3508.5 / 2481, 3);
    // Font size, margins, and A4 original match; text is not shrunk into a tiny cluster just because the paper is large.
    expect(scan.bodySize).toBe(a4.bodySize);
    expect(scan.margins!.left).toBeCloseTo(a4.margins!.left, 0);
    // Large landscape paper follows the long edge of A4; real paper sizes like A3, Letter, and Legal remain unchanged.
    expect(build({ width: 3508.5, height: 2481 }).paper!.width).toBeCloseTo(841.9, 1);
    expect(build({ width: 841.9, height: 1190.6 }).paper).toEqual({ width: 841.9, height: 1190.6 });
    expect(build({ width: 612, height: 1008 }).paper).toEqual({ width: 612, height: 1008 });
  });
  it('sizes lines by the width of their letters when the page is set in one font (D-463)', () => {
    // Recognition boxes are equally tall (descending letters like p and g make small text boxes share the same height), but font width reflects size: body text is 17 pixels, small text 13, large text 22.
    const px = (text: string, size: number) => Math.round(textEm(text) * size);
    const body = [
      'Docteur Martin LEROY',
      'Ophtalmologiste diplômé',
      'Ancien Assistant à la fondation',
      'MALADIES ET CHIRURGIE DES YEUX',
      'Pantin le 11/05/2026',
    ];
    const rows = body.map((text, i) => ({ text, x: 100, y: 100 + i * 60, width: px(text, 17) }));
    const small = 'Une paire de lunettes avec monture';
    const big = 'Simple foyer';
    rows.push(
      { text: small, x: 300, y: 600, width: px(small, 13) },
      { text: big, x: 300, y: 660, width: px(big, 22) },
    );
    const { image, lines } = textPage(rows);
    const doc = buildDocPage({ image, lines, source: 's', skew: 0 });
    const paras = doc.blocks as DocParagraph[];
    const sizeOf = (text: string) => paras.find((p) => p.text === text)!.size ?? doc.bodySize;
    for (const text of body) expect(sizeOf(text)).toBe(doc.bodySize);
    expect(sizeOf(small)).toBeCloseTo((doc.bodySize * 13) / 17, 0);
    expect(sizeOf(big)).toBeCloseTo((doc.bodySize * 22) / 17, 0);
  });

  it('keeps the letter-width size of an all-capitals heading on known paper, only removing the body-minimum inflation', () => {
    // All-caps lines lack ascending/descending letters, making their recognition boxes shorter than body text of the same size: box height is specified as 1.2x, width as 1.41x (D-463 based on font width).
    const px = (text: string, size: number) => Math.round(textEm(text) * size);
    const body = [
      'Docteur Claire FONTAINE',
      'Ophtalmologiste diplômée',
      'Ancienne assistante des hôpitaux',
      'Réf. cabinet 2026-0417',
      'Vallon le 11/05/2026',
    ];
    const title = 'ORDONNANCE DE LUNETTES';
    const rows = [
      ...body.map((text, i) => ({ text, x: 100, y: 100 + i * 60, width: px(text, 17) })),
      { text: title, x: 300, y: 500, width: px(title, 24), h: 24 },
    ];
    const { image, lines } = textPage(rows);
    const sizes = (paper: { width: number; height: number }) => {
      const doc = buildDocPage({ image, lines, source: 's', paper, skew: 0 });
      const para = (doc.blocks as DocParagraph[]).find((p) => p.text === title)!;
      return { body: doc.bodySize, title: para.size ?? doc.bodySize };
    };
    const a4 = sizes({ width: 595.3, height: 841.9 });
    expect(a4.title / a4.body).toBeCloseTo(24 / 17, 1);
    // Narrow paper (D-533): body text width is physically ~5.4 points, raised to the minimum font size of 6 points; titles are ~7.6 points from the original image and do not scale up further with this increase.
    const narrow = sizes({ width: 300, height: 420 });
    expect(narrow.body).toBe(6);
    expect(narrow.title).toBeLessThanOrEqual(8);
  });

  it('does not make same-size, regular lines in a title region headings; headings keep their size (D-463)', () => {
    // The layout model boxes the entire header (organization name + address, phone) into a single title region.
    const { image, lines } = textPage([
      { text: 'CENTRE DE SANTE', x: 380, y: 60, width: 240, h: 26, stroke: 5 },
      { text: '20 rue du pré saint Gervais', x: 400, y: 100, width: 200 },
      { text: 'Tél: 01 48 46 66 66', x: 420, y: 130, width: 160 },
      { text: 'Body text of the page that is long enough to count', x: 100, y: 300, width: 800 },
      { text: 'as prose and sets the size of the body text.', x: 100, y: 325, width: 700 },
    ]);
    const doc = buildDocPage({
      image,
      lines,
      source: 's',
      skew: 0,
      regions: [
        {
          kind: 'title',
          label: 'doc_title',
          score: 0.9,
          box: { x: 370, y: 50, width: 260, height: 110 },
        },
      ],
    });
    const [title, street, phone] = doc.blocks as DocParagraph[];
    expect(title).toMatchObject({ text: 'CENTRE DE SANTE', heading: 1, bold: true });
    // Titles explicitly declare their own font size rather than scaling up based on title styles.
    expect(title!.size).toBeDefined();
    expect(street).toMatchObject({ text: '20 rue du pré saint Gervais', align: 'center' });
    expect(street!.heading).toBeUndefined();
    expect(phone!.heading).toBeUndefined();
  });

  it('centres a single line centred on the page although the text around it is lopsided (D-463)', () => {
    // Large doctor information block on the left with very short text on the right: left and right margins of the entire page text are asymmetric, so calculating centering based on them would miss the header.
    const { image, lines } = textPage([
      { text: 'ORDONNANCE DE LUNETTES', x: 300, y: 100, width: 400 },
      { text: 'Ancien Assistant à la fondation Ophtalmologique', x: 40, y: 200, width: 500 },
      { text: 'Docteur Martin LEROY', x: 150, y: 240, width: 250 },
    ]);
    const doc = buildDocPage({ image, lines, source: 's', skew: 0 });
    const [title, wide, doctor] = doc.blocks as DocParagraph[];
    expect(title!.align).toBe('center');
    // Centered lines within the left block are not treated as centered for the whole page: position is reserved for docx left indentation.
    expect(wide!.align).toBeUndefined();
    expect(doctor!.align).toBeUndefined();
  });

  it('pairs form labels with their values row by row (D-332)', () => {
    const { image, lines } = textPage([
      // An extra line above the right-hand block (merged with the value into a single block) is excluded from pairing.
      { text: 'IN EUROS', x: 830, y: 120, width: 120 },
      // Left: address; right: a column of labels and a column of values (spaced far apart, split into two blocks).
      { text: 'ACME SARL', x: 80, y: 150, width: 160 },
      { text: '12 RUE DE PARIS', x: 80, y: 175, width: 220 },
      { text: '75003 PARIS', x: 80, y: 200, width: 160 },
      { text: 'START OF PERIOD', x: 560, y: 150, width: 160 },
      { text: 'END OF PERIOD', x: 560, y: 175, width: 140 },
      { text: 'HIRED ON', x: 560, y: 200, width: 100 },
      { text: 'SOCIAL SECURITY NO', x: 560, y: 225, width: 190 },
      { text: '1 MARCH 2019', x: 830, y: 150, width: 140 },
      { text: '31 MARCH 2019', x: 830, y: 175, width: 140 },
      { text: '2 MAY 2017', x: 830, y: 200, width: 120 },
      { text: '1 85 03 75 115 042', x: 830, y: 225, width: 160 },
      // Labels ending with a colon are matched even if they are a single line.
      { text: 'Date :', x: 100, y: 600, width: 80 },
      { text: '12 mars 2019', x: 500, y: 600, width: 150 },
    ]);
    const doc = buildDocPage({ image, lines, source: 's', skew: 0 });
    expect(doc.blocks.map((b) => b.kind)).toEqual(['paragraph', 'row', 'paragraph']);
    expect((doc.blocks[0] as DocParagraph).text).toBe('IN EUROS');
    const row = doc.blocks[1] as DocRow;
    expect(row.cells).toHaveLength(2);
    const form = row.cells[1]!.blocks[0] as DocParagraph;
    expect(form.text).toBe(
      [
        'START OF PERIOD\t1 MARCH 2019',
        'END OF PERIOD\t31 MARCH 2019',
        'HIRED ON\t2 MAY 2017',
        'SOCIAL SECURITY NO\t1 85 03 75 115 042',
      ].join('\n'),
    );
    // Value position: distance relative to the left of the label (in original image pixels).
    expect(form.tab).toBe(270);
    expect(doc.blocks[2]).toMatchObject({ text: 'Date :\t12 mars 2019', tab: 400 });
  });
});

describe('ragged-right wrapping (D-473)', () => {
  it('keeps an aligned pair of header fields separate from the preceding line', () => {
    const date = line('姓名 | ID: DOC-101-3 | 2026-10-15', 105, 223, 432, 31);
    const issuer = line('开票方：北方工作室', 105, 279, 243, 31);
    const recipient = line('收件人：陈晓明', 721, 279, 189, 31);
    expect(paragraphsOf([date, issuer], [recipient]).map((p) => p.rows.map((r) => r.text))).toEqual(
      [[date.text], [issuer.text]],
    );
  });

  it('still joins prose beside a column and wrapped values below a header field', () => {
    const prose = [
      line('This is a long paragraph that reaches the edge of its own text column', 100, 100, 430),
      line('and continues on the following line.', 100, 125, 330),
    ];
    expect(paragraphsOf(prose, [line('Another column', 721, 125, 190)])).toHaveLength(1);
    const value = [
      line('Address: Northfield Studio', 100, 100, 430),
      line('Second floor', 100, 125, 240),
    ];
    expect(paragraphsOf(value, [line('Account: 123', 721, 100, 190)])).toHaveLength(1);
  });

  it('keeps stacked short lines apart when the next word would fit in the room to their right (EU sample 023, 025)', () => {
    // Address: the widest line appears to fill the block, but the right side remains empty all the way to the page edge (or another distant block on the right).
    const address = [
      line('Atelier Garance', 600, 100, 150),
      line('Camille Rousseau', 600, 125, 165),
      line('8 place du Marché', 600, 150, 175),
      line('69002 Lyon', 600, 175, 105),
    ];
    expect(paragraphsOf(address, [], 950)).toHaveLength(4);
    expect(
      paragraphsOf(
        address.map((l) => ({ ...l, x: l.x - 500 })),
        [line('Kunden-Nr.: 1004711', 700, 110, 200)],
      ),
    ).toHaveLength(4);
    // Narrow column body text: separated from another column by a narrow gap on the right; when the next word does not fit, it wraps accordingly.
    const column = [
      line('Die Abschläge haben', 100, 100, 200),
      line('wir an Ihren Verbrauch', 100, 125, 190),
      line('angepasst.', 100, 150, 100),
    ];
    expect(paragraphsOf(column, [line('Rechte Spalte mit Text', 340, 110, 220)], 600)).toHaveLength(
      1,
    );
  });

  it('joins a line that stopped short because the next word would not fit', () => {
    // Right side of left-aligned body text is ragged: second line does not reach the end (30 units from the right) because the first word of the next line does not fit.
    const lines = [
      line(
        'Whereas recognition of the inherent dignity and of the equal rights of all',
        100,
        100,
        800,
      ),
      line('the human family is the foundation of freedom, justice', 100, 125, 770),
      line('and peace in the world,', 100, 150, 280),
      // Previous line is far from the right edge and the next word fits: the paragraph ends here.
      line('Whereas disregard and contempt', 100, 175, 300),
    ];
    const paras = paragraphsOf(lines);
    expect(paras.map((p) => p.rows.length)).toEqual([3, 1]);
  });

  it('keeps short label rows of uneven length as separate paragraphs', () => {
    const lines = [
      line('START OF PERIOD', 100, 100, 160),
      line('END OF PERIOD', 100, 125, 140),
      line('HIRED ON', 100, 150, 100),
      line('SOCIAL SECURITY NO', 100, 175, 190),
    ];
    expect(paragraphsOf(lines)).toHaveLength(4);
  });
});

describe('rotated text (D-473)', () => {
  it('treats tall narrow multi-character boxes as vertical text', () => {
    expect(isVertical(line('Sprouts', 1163, 1154, 60, 206))).toBe(true);
    expect(isVertical(line('W-9', 109, 67, 95, 49))).toBe(false);
    expect(isVertical(line('A', 10, 10, 20, 60))).toBe(false);
  });

  it('merges nearby vertical lines into one padded box', () => {
    const boxes = verticalBoxes(
      [
        line('Print or type.', 71, 411, 24, 108),
        line('See Specific Instructions', 92, 322, 23, 288),
      ],
      20,
      page,
    );
    expect(boxes).toHaveLength(1);
    expect(boxes[0]!.x).toBeLessThanOrEqual(71);
    expect(boxes[0]!.y).toBeLessThanOrEqual(322);
  });

  it('cuts vertical text out as an image instead of writing it as a huge heading', () => {
    const { image, lines } = textPage([
      { text: 'Body text line one of the page', x: 100, y: 100, width: 500 },
      { text: 'Body text line two of the page', x: 100, y: 130, width: 500 },
      { text: 'Side logo', x: 900, y: 500, width: 30, h: 180 },
    ]);
    const doc = buildDocPage({ image, lines, source: 's', skew: 0 });
    const leaves = leafBlocks(doc);
    expect(leaves.filter((b) => b.kind === 'image')).toHaveLength(1);
    expect(JSON.stringify(doc)).not.toContain('Side logo');
  });
});

describe('mergeTextRegions (D-473)', () => {
  const r = (kind: string, x: number, y: number, width: number, height: number) => ({
    kind,
    box: { x, y, width, height },
  });
  it('joins stacked text regions with the same left edge, not columns or titles', () => {
    const out = mergeTextRegions(
      [r('text', 100, 100, 800, 50), r('text', 100, 160, 800, 25), r('title', 100, 200, 400, 30)],
      24,
    );
    expect(out.map((x) => x.kind)).toEqual(['text', 'title']);
    expect(out[0]!.box).toEqual({ x: 100, y: 100, width: 800, height: 85 });
    const cols = mergeTextRegions(
      [r('text', 100, 100, 400, 200), r('text', 520, 100, 400, 200)],
      24,
    );
    expect(cols).toHaveLength(2);
  });
});

describe('rule grids and diagrams (D-473)', () => {
  const cell = (i: number, text: string) => ({
    row: Math.floor(i / 6),
    col: i % 6,
    rowSpan: 1,
    colSpan: 1,
    text,
  });
  const grid = (filled: number, total: number): TableBlock => ({
    kind: 'table',
    rows: total / 6,
    col: 0,
    cols: 6,
    cells: Array.from({ length: total }, (_, i) => cell(i, i < filled ? 'x' : '')),
    box: { x: 0, y: 0, width: 100, height: 100 },
  });

  it('rejects a big grid that is mostly empty cells (form underlines), keeps real tables', () => {
    expect(isRuleGrid(grid(10, 60))).toBe(true);
    expect(isRuleGrid(grid(40, 60))).toBe(false);
    // Small, sparse tables (signature blocks) are ignored.
    expect(isRuleGrid(grid(2, 12))).toBe(false);
  });

  it('rejects a layout grid: many positions but few (heavily merged) cells', () => {
    // 17 rows × 14 columns with only 20 cells: form layout, not a data table (upper half of W-9).
    const layout = { ...grid(20, 20), rows: 17, cols: 14 };
    expect(isRuleGrid(layout)).toBe(true);
    // 8 × 6 where every position has a cell: data table.
    expect(isRuleGrid({ ...grid(48, 48), rows: 8, cols: 6 })).toBe(false);
  });

  it('keeps a well-structured merged form table (order form) but rejects paragraph-in-cell grids', () => {
    // Order form: 441 positions, 175 cells (0.40), each cell containing less than one line of text: true table, retained.
    const order = { ...grid(175, 175), rows: 21, cols: 21 };
    expect(isRuleGrid(order, 127)).toBe(false);
    // W-4: 120 positions, 42 cells (0.35), each cell containing 1.8 lines of text: cells contain full paragraphs, not treated as a table.
    const w4 = { ...grid(42, 42), rows: 15, cols: 8 };
    expect(isRuleGrid(w4, 74)).toBe(true);
    expect(isRuleGrid(w4, 30)).toBe(false);
  });

  it('keeps a labelled diagram as an image but not a block of prose lines', () => {
    const rects: Rect[] = [
      // Color blocks and lines: graphics other than text.
      { x: 110, y: 110, width: 80, height: 80 },
      { x: 210, y: 110, width: 80, height: 80 },
      { x: 110, y: 210, width: 180, height: 60 },
    ];
    const box = { x: 100, y: 100, width: 200, height: 180 };
    const image = renderPage(W, H, rects);
    const labels = [line('Softmax', 120, 130, 60, 14), line('Linear', 220, 130, 60, 14)];
    expect(isDiagram(image, box, labels)).toBe(true);
    const prose = [line('This is a long sentence of ordinary prose text here', 100, 130, 190, 14)];
    expect(isDiagram(image, box, prose)).toBe(false);
    // No graphics, only labels (misrecognized images in forms) are not treated as diagrams.
    expect(isDiagram(renderPage(W, H, []), box, labels)).toBe(false);
  });
});

describe('label column (D-473)', () => {
  it('splits a narrow label column from the content column, with full-width lines apart', () => {
    const labels = [0, 1, 2, 3, 4].map((i) => line(`Step ${i}`, 50, 200 + i * 40, 80));
    const contents = [0, 1, 2, 3, 4].map((i) =>
      line(`Content of step ${i}`, 250, 200 + i * 40, 600),
    );
    const across = line(
      'Complete steps 2 to 4 only if they apply to you, otherwise skip',
      50,
      100,
      800,
    );
    const split = splitLabelColumn([across, ...labels, ...contents], 20);
    expect(split).not.toBeNull();
    expect(split!.labels).toEqual(labels);
    expect(split!.contents).toEqual(contents);
    expect(split!.across).toEqual([across]);
  });

  it('leaves ordinary prose and two-column pages alone', () => {
    const prose = [0, 1, 2, 3, 4, 5, 6, 7].map((i) =>
      line(`Prose line ${i}`, 100, 100 + i * 25, 800),
    );
    expect(splitLabelColumn(prose, 20)).toBeNull();
    const columns = [0, 1, 2, 3, 4].flatMap((i) => [
      line(`left ${i}`, 100, 100 + i * 25, 380),
      line(`right ${i}`, 520, 100 + i * 25, 380),
    ]);
    expect(splitLabelColumn(columns, 20)).toBeNull();
  });
});

describe('small layout fixes (D-473)', () => {
  it('does not pair rows of very different height (logo and big title next to small print)', () => {
    // True position of W-9 header (scaled to 1000 width): large "Form" / "W-9" logo and small text on the left, three lines of small text on the right.
    const k = 0.8;
    const rows = [
      { text: 'Form', x: 71, y: 94, width: 42, h: 22 },
      { text: 'W-9', x: 109, y: 67, width: 95, h: 49 },
      { text: '(Rev. March 2024)', x: 73, y: 117, width: 122, h: 17 },
      { text: 'Department of the Treasury', x: 73, y: 138, width: 177, h: 18 },
      { text: 'Give form to the', x: 1039, y: 93, width: 145, h: 17 },
      { text: 'requester. Do not', x: 1037, y: 117, width: 161, h: 17 },
      { text: 'send to the IRS.', x: 1037, y: 139, width: 144, h: 17 },
    ].map((r) => ({ ...r, x: r.x * k, width: r.width * k }));
    const { image, lines } = textPage(rows);
    const doc = buildDocPage({ image, lines, source: 's', skew: 0 });
    const texts = leafBlocks(doc).flatMap((b) => (b.kind === 'paragraph' ? [b.text] : []));
    // Large logo is not paired as "label\tvalue" using the median line height of small text.
    expect(texts.some((t) => t.includes('W-9') && t.includes('\t'))).toBe(false);
  });

  it('sizes long lines of a slightly skewed scan by their text, not their taller box (EU sample 050)', () => {
    // 0.57° tilt: right side of text on the same row in left and right blocks is lower by 7 pixels; very long footer line bounding box is taller than the text by width × slope.
    const slope = 0.01;
    const rows = [0, 1, 2, 3, 4, 5].flatMap((i) => [
      { text: `Anreise ${i}`, x: 100, y: 200 + i * 40, width: 150 },
      { text: `Datum ${i}`, x: 800, y: 200 + i * 40 + Math.round(700 * slope), width: 150 },
    ]);
    const footer = 'Hotel am See | Seestraße 12 | 5020 Salzburg | Austria | T: +43 662 000000';
    const { image, lines } = textPage([
      ...rows,
      { text: footer, x: 150, y: 1200, width: 700, h: Math.round(20 + 700 * slope) },
    ]);
    const doc = buildDocPage({
      image,
      lines,
      source: 's',
      skew: (Math.atan(slope) * 180) / Math.PI,
    });
    const p = leafBlocks(doc).find(
      (b): b is DocParagraph => b.kind === 'paragraph' && b.text.startsWith('Hotel'),
    )!;
    expect(p.heading).toBeUndefined();
    expect(p.size ?? doc.bodySize).toBeLessThanOrEqual(doc.bodySize * 1.1);
  });

  it('only calls letter-led, mostly-letter text a size-based heading', () => {
    expect(looksLikeHeading('Request for Taxpayer')).toBe(true);
    expect(looksLikeHeading('Displays (8) 40 Floor (40)')).toBe(false);
    expect(looksLikeHeading('# Customers Attended 35')).toBe(false);
    expect(looksLikeHeading('(if approved)')).toBe(false);
  });

  it('merges stacked two-column rows with the same columns into one row', () => {
    const para = (text: string, x: number, y: number): DocBlock => ({
      kind: 'paragraph',
      text,
      box: { x, y, width: 300, height: 20 },
    });
    const row = (y: number, a: string, b: string): DocRow => ({
      kind: 'row',
      cells: [
        { width: 400, blocks: [para(a, 100, y) as never] },
        { width: 400, blocks: [para(b, 520, y) as never] },
      ],
      box: { x: 100, y, width: 720, height: 20 },
    });
    const out = mergeColumnRows([row(100, 'L1', 'R1'), row(300, 'L2', 'R2')], 20);
    expect(out).toHaveLength(1);
    const merged = out[0] as DocRow;
    expect(merged.cells.map((c) => c.blocks.length)).toEqual([2, 2]);
    // Two lines with differing column positions are not merged.
    const other = row(300, 'L2', 'R2');
    other.cells[1]!.blocks = [para('R2', 700, 300) as never];
    expect(mergeColumnRows([row(100, 'L1', 'R1'), other], 20)).toHaveLength(2);
  });
});

describe('answer column beside clauses (EU sample 041)', () => {
  const para = (text: string, x: number, y: number, width: number, height: number) => ({
    kind: 'paragraph' as const,
    text,
    box: { x, y, width, height },
  });

  it('gives each short answer its own row with the clauses up to the one it stands beside', () => {
    // Four clauses in a region (one without an answer), with a column of "○ ja ○ nein" on the right corresponding to the last line of each clause.
    const clauses = [
      para('Sie darf in allen Angelegenheiten entscheiden und befugt sein.', 150, 100, 850, 90),
      para('Solange es erforderlich ist, darf sie', 150, 230, 400, 25),
      para('über meine freiheitsentziehende Unterbringung', 190, 280, 700, 25),
      para('über ärztliche Zwangsmaßnahmen nach dem Gesetz entscheiden.', 190, 330, 800, 60),
    ];
    const answers = [
      para('○ ja ○ nein', 1140, 162, 165, 28),
      para('○ ja ○ nein', 1140, 278, 165, 28),
      para('○ ja ○ nein', 1140, 362, 165, 28),
    ];
    const units = [
      { box: { x: 150, y: 100, width: 850, height: 290 }, blocks: clauses },
      ...answers.map((a) => ({ box: a.box, blocks: [a] })),
    ];
    const out = arrangeUnits(units, 28);
    const rows = out.filter((b): b is DocRow => b.kind === 'row');
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.cells.map((c) => c.blocks.length))).toEqual([
      [1, 1],
      [2, 1],
      [1, 1],
    ]);
    expect((rows[1]!.cells[0]!.blocks[0] as DocParagraph).text).toMatch(/^Solange/);
  });

  it('keeps a column of prose beside prose as one row', () => {
    const left = [para('Lorem ipsum dolor sit amet, a long paragraph.', 100, 100, 500, 90)];
    const right = [
      para('Another long paragraph of prose in the right column here.', 700, 100, 500, 90),
      para('And a second paragraph of prose in the right column here.', 700, 220, 500, 90),
    ];
    const units = [
      { box: { x: 100, y: 100, width: 500, height: 90 }, blocks: left },
      { box: { x: 700, y: 100, width: 500, height: 210 }, blocks: right },
    ];
    const rows = arrangeUnits(units, 28).filter((b) => b.kind === 'row');
    expect(rows).toHaveLength(1);
  });
});

describe('persistent prose columns', () => {
  const unit = (text: string, x: number, y: number, width = 340, height = 80) => {
    const box = { x, y, width, height };
    return { box, blocks: [{ kind: 'paragraph' as const, text, box }] };
  };
  const body = () => [
    unit('L1', 100, 200),
    unit('R1', 520, 200),
    unit('L2 isolated', 100, 310),
    unit('L3', 100, 440),
    unit('R2 shorter', 520, 440, 250),
    unit('L4 tail', 100, 510, 300, 40),
  ];

  it('keeps isolated and trailing paragraphs in stable columns despite uneven ink widths', () => {
    const blocks = arrangeUnits(body(), 20);
    expect(blocks).toHaveLength(1);
    const row = blocks[0] as DocRow;
    expect(row.kind).toBe('row');
    expect(row.cells.map((c) => c.blocks.map((b) => (b as DocParagraph).text))).toEqual([
      ['L1', 'L2 isolated', 'L3', 'L4 tail'],
      ['R1', 'R2 shorter'],
    ]);
    expect(row.cells.map((c) => c.width)).toEqual([420, 340]);
  });

  it('ends a column scope at full-width content and keeps headers and distant footers outside', () => {
    const head = unit('Full width title', 100, 80, 760, 30);
    const author = unit('Author metadata', 100, 125, 280, 20);
    const across = unit('Spanning statement', 100, 400, 760, 25);
    const footer = unit('Page footer', 100, 700, 160, 20);
    const blocks = arrangeUnits([head, author, ...body(), across, footer], 20);
    expect(blocks.map((b) => b.kind)).toEqual([
      'paragraph',
      'paragraph',
      'row',
      'paragraph',
      'row',
      'paragraph',
    ]);
    expect((blocks[2] as DocRow).cells[0]!.blocks.map((b) => (b as DocParagraph).text)).toEqual([
      'L1',
      'L2 isolated',
    ]);
    expect((blocks.at(-1) as DocParagraph).text).toBe('Page footer');
  });

  it('leaves sparse parallel fields and single-column prose on the existing path', () => {
    const fields = [
      unit('Seller', 100, 200, 140, 20),
      unit('Buyer', 520, 200, 140, 20),
      unit('Invoice note', 100, 300, 340, 20),
    ];
    expect(arrangeUnits(fields, 20).map((b) => b.kind)).toEqual(['row', 'paragraph']);
    expect(arrangeUnits([unit('A', 100, 200), unit('B', 100, 310)], 20).map((b) => b.kind)).toEqual(
      ['paragraph', 'paragraph'],
    );
  });

  it('extends a proven scope back into a narrow heading row without absorbing author metadata', () => {
    const blocks = arrangeUnits(
      [
        unit('Author metadata', 100, 160, 300, 20),
        unit('Opening prose', 100, 200),
        unit('Short title', 520, 200, 90, 20),
        unit('Continuing prose', 100, 310),
        unit('Right content', 520, 310),
      ],
      20,
    );
    expect(blocks.map((b) => b.kind)).toEqual(['paragraph', 'row']);
    expect((blocks[1] as DocRow).cells[1]!.blocks.map((b) => (b as DocParagraph).text)).toEqual([
      'Short title',
      'Right content',
    ]);
    expect((blocks[0] as DocParagraph).text).toBe('Author metadata');
  });

  it('starts a separate scope when the next column boundary changes', () => {
    const blocks = arrangeUnits(
      [unit('L1', 100, 200), unit('R1', 520, 200), unit('L2', 100, 310), unit('R2', 650, 310)],
      20,
    );
    expect(blocks).toHaveLength(2);
    expect((blocks[0] as DocRow).cells[0]!.width).toBe(420);
    expect((blocks[1] as DocRow).cells[0]!.width).toBe(550);
  });

  it('retains separate bands for dense pages rather than creating a large pagination container', () => {
    const blocks = arrangeUnits(body(), 20, { dense: true });
    expect(blocks.map((b) => b.kind)).toEqual(['row', 'paragraph', 'row', 'paragraph']);
    expect(leafBlocks({ blocks }).map((b) => (b as DocParagraph).text)).toEqual([
      'L1',
      'R1',
      'L2 isolated',
      'L3',
      'R2 shorter',
      'L4 tail',
    ]);
  });

  it('infers alignment against the proven column, retaining genuinely centered and right-aligned text', () => {
    const rows = [
      { text: 'Full width heading across the page', x: 100, y: 60, width: 800 },
      ...[0, 1, 2, 3].map((i) => ({
        text: 'A sufficiently long prose line wraps across this column',
        x: 100,
        y: 200 + i * 25,
        width: 360,
      })),
      { text: 'Results', x: 520, y: 200, width: 80, h: 25 },
      { text: 'Right column text establishes the far edge', x: 520, y: 250, width: 380 },
      { text: 'Centered', x: 650, y: 300, width: 120 },
      { text: 'End', x: 850, y: 350, width: 50 },
      { text: 'Reference continuation', x: 520, y: 400, width: 375 },
      { text: '18.', x: 520, y: 430, width: 30 },
      ...[0, 1, 2, 3].map((i) => ({
        text: 'More ordinary prose continues down the left column',
        x: 100,
        y: 370 + i * 25,
        width: 360,
      })),
    ];
    const { image, lines } = textPage(rows);
    const regions: LayoutRegion[] = rows.map((r) => ({
      kind: 'text',
      label: 'text',
      score: 0.9,
      box: { x: r.x, y: r.y, width: r.width, height: r.h ?? 20 },
    }));
    const doc = buildDocPage({ image, lines, regions, source: 's', skew: 0 });
    const paras = leafBlocks(doc).filter((b): b is DocParagraph => b.kind === 'paragraph');
    const byText = (text: string) => paras.find((b) => b.text === text)!;
    expect(byText('Results').align).toBeUndefined();
    expect(byText('Reference continuation').align).toBeUndefined();
    expect(byText('18.').align).toBeUndefined();
    expect(byText('Centered').align).toBe('center');
    expect(byText('End').align).toBe('right');
  });
});

describe('ruled tables and barcodes (D-501)', () => {
  it('does not cut the empty part of a ruled table with many columns out as a barcode', () => {
    // The lower half of the payslip has only a row of parallel column lines where there is no text; after being clipped into an image like a barcode, it is a blank image with a vertical black line.
    const xs = Array.from({ length: 13 }, (_, i) => 100 + i * 65);
    const lines: OcrBox[] = [];
    const rects: Rect[] = [...gridRects(xs, [100, 140, 600])];
    for (let c = 0; c < 12; c++) {
      lines.push(fakeLine(`h${c}`, { x: xs[c]! + 15, y: 110, width: 35, height: 20 }, page));
      lines.push(fakeLine(`${c}.0`, { x: xs[c]! + 15, y: 150, width: 35, height: 20 }, page));
      rects.push(...glyphs(xs[c]! + 17, 113, 30, 14), ...glyphs(xs[c]! + 17, 153, 30, 14));
    }
    const doc = buildDocPage({ image: renderPage(W, H, rects), lines, source: 'p.jpg', skew: 0 });
    const leaves = leafBlocks(doc);
    expect(leaves.filter((b) => b.kind === 'table')).toHaveLength(1);
    expect(leaves.filter((b) => b.kind === 'image')).toHaveLength(0);
  });
});

describe('text left out of a table (D-501)', () => {
  it('a footer whose tall box covers the table’s bottom line comes out once, as text after the table', () => {
    // A curved line of footer text in the photo: recognition box is very tall, covering the table bottom line and spanning all column lines. It is neither included in the table nor discarded.
    const xs = [100, 300, 500, 700, 900];
    const rects: Rect[] = [...gridRects(xs, [200, 240, 300])];
    const lines: OcrBox[] = [];
    for (let c = 0; c < 4; c++) {
      lines.push(fakeLine(`v${c}`, { x: xs[c]! + 40, y: 255, width: 80, height: 20 }, page));
      rects.push(...glyphs(xs[c]! + 44, 258, 72, 14));
    }
    // Center just past the bottom line (less than 0.3 line heights from the table box): box-based calculation would treat it as table text, but since it is not in the table, it gets lost.
    lines.push(fakeLine('Keep this payslip', { x: 100, y: 284, width: 800, height: 34 }, page));
    rects.push({ x: 300, y: 300, width: 2, height: 30 }, ...glyphs(110, 304, 780, 12));
    const doc = buildDocPage({ image: renderPage(W, H, rects), lines, source: 'p.jpg', skew: 0 });
    const leaves = leafBlocks(doc);
    const texts = leaves.flatMap((b) =>
      b.kind === 'table'
        ? b.table.cells.map((c) => c.text)
        : b.kind === 'paragraph'
          ? [b.text]
          : [],
    );
    expect(texts.filter((t) => t.includes('Keep this payslip'))).toEqual(['Keep this payslip']);
    expect(leaves.at(-1)).toMatchObject({ kind: 'paragraph', text: 'Keep this payslip' });
  });
});

describe('ruled tables whose column lines cut through words (D-502)', () => {
  it('are not used as tables; their text stays whole', () => {
    // Vertical lines passing through the middle of text lines (strokes or creases misrecognized as column lines): structured by this table, each text line is cut in half.
    const rects: Rect[] = [...gridRects([100, 400, 700], [100, 140, 180, 220])];
    const lines: OcrBox[] = [];
    for (let r = 0; r < 3; r++) {
      const text = `Consommations${r}annuelles`;
      lines.push(fakeLine(text, { x: 150, y: 110 + r * 40, width: 500, height: 20 }, page, true));
      rects.push(...glyphs(152, 113 + r * 40, 496, 14));
    }
    const doc = buildDocPage({ image: renderPage(W, H, rects), lines, source: 'p.jpg', skew: 0 });
    const leaves = leafBlocks(doc);
    expect(leaves.filter((b) => b.kind === 'table')).toHaveLength(0);
    const texts = leaves.flatMap((b) => (b.kind === 'paragraph' ? b.text.split('\n') : []));
    for (let r = 0; r < 3; r++) expect(texts.join(' ')).toContain(`Consommations${r}annuelles`);
  });
});

describe('ruled field boxes in a rejected form grid (EU sample 062)', () => {
  // Full-page grid: shared column lines across 12 columns, with boxes of each row located in different places.
  const colWidths = Array.from({ length: 12 }, () => 100);
  const cell = (row: number, col: number, colSpan: number, text: string, y: number, h = 60) => ({
    row,
    col,
    rowSpan: 1,
    colSpan,
    text,
    box: { x: col * 100, y, width: colSpan * 100, height: h },
  });
  const cells = [
    // Section title bar: text in the middle, with no writable area below.
    cell(0, 0, 12, 'C. Dane podatnika', 0, 40),
    cell(1, 0, 5, '10. Nazwisko', 40),
    cell(1, 5, 3, '11. Pierwsze imię', 40),
    cell(1, 8, 4, '12. Data urodzenia', 40),
    cell(2, 0, 4, '13. Kraj', 100),
    cell(2, 4, 5, '14. Województwo', 100),
    cell(2, 9, 3, '', 100),
    // Option section: multiple lines of text.
    cell(3, 0, 12, '7. Składasz\n1. zeznanie\n2. korektę zeznania', 160, 90),
    cell(4, 0, 6, '20. Miejscowość', 250),
    cell(4, 6, 6, '21. Kod pocztowy', 250),
  ];
  const table: TableBlock = {
    kind: 'table',
    rows: 5,
    col: 0,
    cols: 12,
    cells,
    box: { x: 0, y: 0, width: 1200, height: 310 },
  };
  const placed = [
    line('C. Dane podatnika', 20, 10, 300),
    line('10. Nazwisko', 10, 45, 150, 16),
    line('11. Pierwsze imię', 510, 45, 150, 16),
    line('12. Data urodzenia', 810, 45, 150, 16),
    line('13. Kraj', 10, 105, 80, 16),
    line('14. Województwo', 410, 105, 150, 16),
    line('7. Składasz', 10, 165, 120, 16),
    line('1. zeznanie', 40, 192, 120, 16),
    line('2. korektę zeznania', 40, 220, 160, 16),
    line('20. Miejscowość', 10, 255, 150, 16),
    line('21. Kod pocztowy', 610, 255, 150, 16),
  ];

  it('takes the runs of rows whose filled cells are labelled field boxes as tables', () => {
    const found = fieldBoxTables(table, colWidths, placed, 20);
    expect(found).toHaveLength(2);
    const [first, second] = found;
    // Rows 10–14 form a single table, keeping only the column lines used by these rows: 0, 4, 5, 8, 9, 12.
    expect(first!.table.rows).toBe(2);
    expect(first!.colWidths).toEqual([400, 100, 300, 100, 300]);
    expect(first!.table.cells.map((c) => [c.row, c.col, c.colSpan, c.text])).toEqual([
      [0, 0, 2, '10. Nazwisko'],
      [0, 2, 1, '11. Pierwsze imię'],
      [0, 3, 2, '12. Data urodzenia'],
      [1, 0, 1, '13. Kraj'],
      [1, 1, 3, '14. Województwo'],
      [1, 4, 1, ''],
    ]);
    // Items 20 and 21 below the option section form another table.
    expect(second!.table.cells.map((c) => c.text)).toEqual(['20. Miejscowość', '21. Kod pocztowy']);
    expect(second!.colWidths).toEqual([600, 600]);
  });

  it('leaves out the empty frame space beside the boxes (EU sample 004)', () => {
    // Two boxes occupy only the left half of the outer box: the empty space on the right is also divided into grid cells by lines, leaving the entire column empty.
    const side = (row: number, y: number, a: string, b: string) => [
      cell(row, 0, 3, a, y),
      cell(row, 3, 3, b, y),
      cell(row, 6, 3, '', y),
      cell(row, 9, 3, '', y),
    ];
    const framed: TableBlock = {
      ...table,
      rows: 2,
      cells: [...side(0, 40, '10. Nazwisko', '11. Imię'), ...side(1, 100, '13. Kraj', '14. Gmina')],
    };
    const labels = [
      line('10. Nazwisko', 10, 45, 150, 16),
      line('11. Imię', 310, 45, 150, 16),
      line('13. Kraj', 10, 105, 80, 16),
      line('14. Gmina', 310, 105, 100, 16),
    ];
    const found = fieldBoxTables(framed, colWidths, labels, 20);
    expect(found.map((f) => [f.table.cols, f.colWidths])).toEqual([[2, [300, 300]]]);
  });

  it('does not take one column of stacked boxes (EU sample 076)', () => {
    const stacked: TableBlock = {
      ...table,
      rows: 2,
      cells: [cell(0, 0, 12, 'Patient/in', 40), cell(1, 0, 12, 'Anschrift', 100)],
    };
    const labels = [line('Patient/in', 10, 45, 150, 16), line('Anschrift', 10, 105, 150, 16)];
    expect(fieldBoxTables(stacked, colWidths, labels, 20)).toEqual([]);
  });

  it('does not take a single field box on its own', () => {
    // Row 20 is by itself (preceded by the option section) and has only a single box: ignored.
    const single = {
      ...table,
      cells: cells
        .filter((c) => c.text !== '21. Kod pocztowy')
        .map((c) =>
          c.text === '20. Miejscowość' ? { ...c, colSpan: 12, box: { ...c.box, width: 1200 } } : c,
        ),
    };
    const found = fieldBoxTables(
      single,
      colWidths,
      placed.filter((l) => !l.text.startsWith('21.')),
      20,
    );
    expect(found.map((f) => f.table.cells.map((c) => c.text))).toEqual([
      [
        '10. Nazwisko',
        '11. Pierwsze imię',
        '12. Data urodzenia',
        '13. Kraj',
        '14. Województwo',
        '',
      ],
    ]);
  });
});
