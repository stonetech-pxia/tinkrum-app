import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { buildDocPage, leafBlocks, type DocDoc, type DocTable } from './doc';
import { INVOICE, INVOICE_ITEMS } from './fixtures/invoice-ocr';
import { RECEIPT } from './fixtures/receipt-ocr';
import { writeDocx } from './docx';
import { renderPage, type Rect } from './test-helpers';
import { findBarcodes, levelLines, pageSlope } from './text-table';
import type { LayoutRegion } from './layout';
import type { OcrBox } from './types';

// General layout correction for Word conversion (D-471). The receipt is one sent by the founder on
// 2026-11-06 (Lidl, photographed slightly crooked, paper is curved), and recognition results are
// lines recognized by the macOS system recognition (Vision) (fixtures/receipt-ocr.ts, containing
// only store name, address, and prices). Previously: the right column was higher than the left,
// incorrectly assigned to the previous row; multiple columns merged into a single sentence
// ("Article P.U.EUR Qté 2,76 A T Oeufs sol x12 2,76 1").

const receipt = RECEIPT;
const white = (width: number, height: number) => renderPage(width, height, []);

const rowsOf = (t: DocTable) =>
  Array.from({ length: t.table.rows }, (_, r) =>
    t.table.cells
      .filter((c) => c.row === r)
      .map((c) => c.text)
      .filter(Boolean),
  );

describe('tilt (D-471)', () => {
  it('finds the receipt’s tilt: the right column sits higher than the left', () => {
    expect(pageSlope(receipt.lines, 36)).toBeCloseTo(-0.05, 2);
  });

  it('leveled, each amount is on the same row as its article', () => {
    const lv = levelLines(receipt.lines, 36, receipt.width / 2);
    const mid = (text: string) => {
      const l = lv.find((x) => x.text === text)!;
      return l.y + l.height / 2;
    };
    expect(Math.abs(mid('Oeufs sol x12') - mid('2,76 A T'))).toBeLessThan(10);
    expect(Math.abs(mid('Article') - mid('2,76 A T'))).toBeGreaterThan(25);
    // Below, the paper curves differently: the total is also on the same row as its label.
    expect(Math.abs(mid('A payer') - mid('14,60'))).toBeLessThan(15);
  });

  it('a straight page stays as it is', () => {
    const lines: OcrBox[] = [
      { text: 'Name', x: 50, y: 100, width: 100, height: 20 },
      { text: 'Price', x: 500, y: 100, width: 80, height: 20 },
      { text: 'Tea', x: 50, y: 140, width: 60, height: 20 },
      { text: '2,00', x: 500, y: 140, width: 60, height: 20 },
    ];
    expect(pageSlope(lines, 20)).toBe(0);
  });
});

describe('tables without lines (D-471)', () => {
  const page = buildDocPage({
    image: white(receipt.width, receipt.height),
    lines: receipt.lines,
    source: 's',
  });
  const tables = page.blocks.filter((b): b is DocTable => b.kind === 'table');

  it('the receipt’s articles and totals become borderless tables, one row per line', () => {
    expect(tables.length).toBe(2);
    expect(tables.every((t) => t.borderless)).toBe(true);
    const items = rowsOf(tables[0]!);
    expect(items[0]).toEqual(['Article', 'P.U.EUR Qté', 'EUR']);
    expect(items[1]).toEqual(['Oeufs sol x12', '2,76', '2,76 A T']);
    expect(items[2]).toEqual(['Pizza jambon fromage', '2,29', '2,29 A T']);
    expect(items[3]).toEqual(['Pizza Crust Boeuf', '4,19', '4,19 A T']);
    const totals = rowsOf(tables[1]!);
    expect(totals).toContainEqual(['VA Taux', 'MONT.TTC MONT.TVA', 'TOTAL HT']);
    expect(totals).toContainEqual(['A 5,5%', '14,60', '0,76', '13,84']);
    // The price column is right-aligned.
    const price = tables[0]!.table.cells.find((c) => c.text === '2,76')!;
    expect(price.align).toBe('right');
    // Cells record their position in the original image (for original image thumbnail and screenshot verification, D-468).
    expect(price.box).toMatchObject({ x: 427, y: 348 });
  });

  it('no paragraph mixes the columns any more', () => {
    const texts = page.blocks.flatMap((b) => (b.kind === 'paragraph' ? [b.text] : []));
    expect(texts.join('\n')).not.toMatch(/Article.*Oeufs/);
    expect(texts).toContain('Ticket de vente');
  });

  it('when the layout model sees the whole receipt as one text region, the order stays top to bottom (simulator 2026-11-06)', () => {
    const doc = buildDocPage({
      image: white(receipt.width, receipt.height),
      lines: receipt.lines,
      regions: [
        {
          kind: 'text',
          label: 'text',
          score: 0.5,
          box: { x: 60, y: 100, width: 700, height: 1000 },
        },
      ],
      source: 's',
    });
    const order = doc.blocks.map((b) =>
      b.kind === 'paragraph'
        ? b.text
        : b.kind === 'table'
          ? `table:${b.table.cells[0]!.text}`
          : b.kind,
    );
    const at = (x: string) => order.findIndex((o) => o.startsWith(x));
    expect(at('Place Salvador')).toBeLessThan(at('table:Article'));
    expect(at('table:Article')).toBeLessThan(at('Enregistrez'));
    // The store name and text below no longer connect into a single block (no longer a block spanning from the top of the page to the bottom).
    expect(doc.blocks.every((b) => b.box.height < 0.8 * receipt.height)).toBe(true);
  });

  it('three columns of prose are not a table', () => {
    const lines: OcrBox[] = [];
    for (let r = 0; r < 6; r++) {
      for (const x of [40, 360, 680]) {
        lines.push({
          text: 'Lorem ipsum dolor sit amet consectetur',
          x,
          y: 100 + r * 28,
          width: 280,
          height: 20,
        });
      }
    }
    const doc = buildDocPage({ image: white(1000, 400), lines, source: 's', skew: 0 });
    expect(doc.blocks.some((b) => b.kind === 'table')).toBe(false);
  });

  it('a borderless table is written to Word without borders', () => {
    const doc: DocDoc = { version: 1, pages: [{ ...page, source: 's' }] };
    const xml = strFromU8(unzipSync(writeDocx(doc))['word/document.xml']!);
    expect(xml).toContain('<w:insideV w:val="nil"/>');
    expect(xml).toContain('Oeufs sol x12');
  });
});

describe('barcodes (D-471)', () => {
  // A line of text with a strip of vertical bars underneath (barcode).
  const bars: Rect[] = [];
  for (let x = 100; x < 700; x += 12) bars.push({ x, y: 300, width: 5 + (x % 3), height: 120 });
  const text: Rect[] = [];
  for (let x = 100; x < 500; x += 9) text.push({ x, y: 104, width: 2, height: 12 });
  const image = renderPage(800, 500, [...bars, ...text]);
  const lines: OcrBox[] = [
    { text: 'Merci de votre visite', x: 100, y: 100, width: 400, height: 20 },
    // Sporadic text recognized inside the barcode.
    { text: '7.00', x: 600, y: 350, width: 50, height: 20 },
  ];

  it('finds the stripes, not the line of text', () => {
    const found = findBarcodes(image, lines.slice(0, 1), 20);
    expect(found).toHaveLength(1);
    expect(found[0]!.y).toBeGreaterThanOrEqual(280);
    expect(found[0]!.x).toBeLessThanOrEqual(110);
    expect(found[0]!.x + found[0]!.width).toBeGreaterThanOrEqual(690);
  });

  it('does not take a security pattern carrying a line of text for a barcode (EU sample 066)', () => {
    // A line of recognized body text sandwiched between the same vertical bars: that is textured background with printed text, not a barcode, and the text must not be discarded as garbage inside the barcode.
    const words: OcrBox = { text: 'Nach: Bad Kissingen', x: 200, y: 350, width: 300, height: 20 };
    expect(findBarcodes(image, [lines[0]!, words], 20)).toEqual([]);
    // Sporadic numbers recognized inside the barcode are still ignored as before.
    expect(findBarcodes(image, lines, 20)).toHaveLength(1);
  });

  it('does not take a dashed connector on textured paper for a barcode next to text (D-533)', () => {
    // Oblique dashed lines (flowchart return lines) have only a few segments per line; paper texture jumps around the average brightness of the entire line, consistent across adjacent lines.
    const dashes: Rect[] = [];
    for (let x = 600; x < 1100; x += 14)
      dashes.push({ x, y: 140 + Math.round((x - 600) * 0.07), width: 8, height: 4 });
    const paper = renderPage(1400, 300, dashes);
    for (let y = 0; y < paper.height; y++)
      for (let x = 0; x < paper.width; x++)
        for (let c = 0; c < 3; c++) {
          const o = (y * paper.width + x) * 4 + c;
          if (paper.data[o] === 255) paper.data[o] = (x * 7919) % 13 < 6 ? 238 : 254;
        }
    expect(findBarcodes(paper, [], 35, true)).toEqual([]);
    // Real barcodes are still found along this path.
    expect(findBarcodes(image, lines.slice(0, 1), 20, true)).toHaveLength(1);
  });

  it('keeps a Word barcode beside text without swallowing that text', () => {
    const beside = Array.from({ length: 5 }, (_, i) => ({
      text: `Address ${i + 1}`,
      x: 5,
      y: 300 + i * 24,
      width: 70,
      height: 20,
    }));
    const framed = renderPage(800, 500, [
      ...bars,
      ...text,
      { x: 1, y: 300, width: 2, height: 120 },
      { x: 797, y: 300, width: 2, height: 120 },
    ]);
    const doc = buildDocPage({ image: framed, lines: beside, source: 's', skew: 0 });
    const pictures = leafBlocks(doc).filter((b) => b.kind === 'image');
    expect(pictures).toHaveLength(1);
    expect(pictures[0]!.box.x).toBeGreaterThanOrEqual(90);
    expect(pictures[0]!.box.x + pictures[0]!.box.width).toBeLessThanOrEqual(710);
    expect(pictures[0]!.box.height).toBeGreaterThanOrEqual(100);
    expect(JSON.stringify(doc)).toContain('Address 1');
    expect(JSON.stringify(doc)).toContain('Address 5');
  });

  it('writes the barcode once when the layout model also found it as a picture', () => {
    const regions: LayoutRegion[] = [
      {
        kind: 'image',
        label: 'image',
        score: 0.73,
        box: { x: 90, y: 290, width: 620, height: 140 },
      },
    ];
    const doc = buildDocPage({ image, lines, regions, source: 's', skew: 0 });
    expect(leafBlocks(doc).filter((b) => b.kind === 'image')).toHaveLength(1);
    expect(JSON.stringify(doc)).not.toContain('7.00');
  });

  it('the barcode is kept as a picture and the stray digits in it are dropped', () => {
    const doc = buildDocPage({ image, lines, source: 's', skew: 0 });
    expect(doc.blocks.some((b) => b.kind === 'image')).toBe(true);
    expect(JSON.stringify(doc)).not.toContain('7.00');
  });
});

describe('numbers are not list markers (D-471)', () => {
  it('「7.29」「-7.29」 under a barcode stay text', () => {
    const lines: OcrBox[] = [
      { text: '-7.29', x: 600, y: 100, width: 80, height: 20 },
      { text: '7.29', x: 600, y: 200, width: 80, height: 20 },
      { text: '- first point', x: 100, y: 300, width: 200, height: 20 },
      { text: '2. second point', x: 100, y: 330, width: 220, height: 20 },
    ];
    const doc = buildDocPage({ image: white(800, 400), lines, source: 's', skew: 0 });
    const kinds = doc.blocks.map((b) => b.kind);
    expect(kinds.filter((k) => k === 'paragraph')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'list').length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(doc)).toContain('"text":"-7.29"');
  });
});

describe('rows kept together when no table lines are found (D-502)', () => {
  const box = (text: string, x: number, y: number, width = 80): OcrBox => ({
    text,
    x,
    y,
    width,
    height: 20,
  });
  const tablesIn = (lines: OcrBox[]) =>
    buildDocPage({ image: white(1400, 900), lines, source: 's', skew: 0 }).blocks.filter(
      (b): b is DocTable => b.kind === 'table',
    );

  it('a payslip body (item names far from columns of amounts) becomes one row per item', () => {
    // Payslip body table, table lines not recognized: item names on the left, separated by seven or eight row heights, with three amount columns on the right; some items only have values in one or two columns.
    const items = [
      ['Salaire de base', '151.67', '12.3100', '1 867.06'],
      ['Heures supplémentaires 10 %', '17.33', '13.5410', '234.67'],
      ['Sous total Salaire de base', '169.00', '', '2 101.73'],
      ['Indemnité congés payés', '', '', '404.18'],
      ['AeN nourriture (repas pris)', '44.00', '4.3500', '191.40'],
    ];
    const lines = items.flatMap(([label, ...amounts], r) => [
      box(label!, 100, 100 + r * 30, 300),
      ...amounts.flatMap((a, c) => (a ? [box(a, 600 + c * 150, 100 + r * 30)] : [])),
    ]);
    const [table, ...others] = tablesIn(lines);
    expect(others).toHaveLength(0);
    expect(rowsOf(table!)).toEqual(items.map((row) => row.filter(Boolean)));
  });

  it('a lab report (names far from value, unit and range columns) becomes one row per test (EU sample 098)', () => {
    // Laboratory report: test items on the left, with result, unit, and reference value columns far away on the right; the unit column has no numbers.
    const items = [
      ['GOT', '23', 'U/l', '<35'],
      ['GPT', '35', 'U/l', '<45'],
      ['Alk. Phosphatase', '98', 'U/l', '0-129'],
      ['Bilirubin gesamt', '0.68', 'mg/dl', '<1.00'],
      ['Gesamteiweiß', '+ 8.2', 'g/dl', '6.0-8.0'],
      ['Natrium', '138', 'mmol/l', '135-150'],
    ];
    const lines = items.flatMap(([label, ...rest], r) => [
      box(label!, 100, 100 + r * 30, 180),
      ...rest.map((t, c) => box(t, 760 + c * 190, 100 + r * 30, 70)),
    ]);
    const [table, ...others] = tablesIn(lines);
    expect(others).toHaveLength(0);
    expect(rowsOf(table!)).toEqual(items);
  });

  it('a list of labels with amounts far to the right becomes a two-column table', () => {
    // Receipt totals: two columns, far apart, with numbers on the right.
    const pairs = [
      ['Total', 'RM 30.91'],
      ['ROUNDING ADJUSTMENT', '-RM 0.01'],
      ['TOTAL ROUNDED', 'RM 30.90'],
      ['CASH', 'RM 51.00'],
    ];
    const lines = pairs.flatMap(([label, amount], r) => [
      box(label!, 100, 100 + r * 30, 220),
      box(amount!, 700, 100 + r * 30, 90),
    ]);
    const [table] = tablesIn(lines);
    expect(rowsOf(table!)).toEqual(pairs);
  });

  it('a two-column list does not take rows from a three-column table below it', () => {
    // Receipt (position of SROIE S_094, row height 20): total in two columns, amounts far apart;
    // separated by a row below is the invoice number, which is a three-column GST summary where the
    // header "Amount Tax" is not a number and the Tax column is also far apart. The total must not
    // swallow the summary into a two-column table and compress it into two columns.
    const totals = [
      ['Sub-total', '5.90', 140],
      ['Total Sales Incl GST', '5.90', 285],
      ['Total After Adj Incl GST', '5.90', 343],
      ['CASH', '10.00', 66],
      ['Item Count 1', '4.10', 174],
    ] as const;
    const gst = [
      ['GST Summary', 'Amount', 'Tax'],
      ['SR @ 6%', '5.57', '0.33'],
      ['Total', '5.57', '0.33'],
    ];
    const lines = [
      ...totals.flatMap(([label, amount, w], r) => [
        box(label, 76, 100 + r * 20, w / 2),
        box(amount, 583 / 2, 100 + r * 20, 32),
      ]),
      box('Invoice No: 2018020951320023885', 67, 200, 221),
      ...gst.flatMap((row, r) =>
        row.map((t, c) => box(t, [38, 180, 292][c]!, 220 + r * 20, [80, 45, 32][c]!)),
      ),
    ].map((l) => ({ ...l, height: 18 }));
    const rows = tablesIn(lines).flatMap(rowsOf);
    for (const row of gst) expect(rows).toContainEqual(row);
  });

  it('a short summary right under a table joins it with the table’s columns', () => {
    // Receipt (position of SROIE S_454): items and totals arranged in a three-column table,
    // immediately followed by the GST summary (header row, values row), with the summary header
    // lying across the two columns; followed by a line of text. The summary rows attach below the
    // table, three cells per row, without breaking into six segments.
    const t = (text: string, x: number, y: number, w: number): OcrBox => ({
      text,
      x,
      y,
      width: w,
      height: 30,
    });
    const lines = [
      t('001697', 82, 100, 85),
      t('5.00 1.00', 330, 100, 124),
      t('5.00 SR', 560, 100, 100),
      t('766271', 82, 136, 85),
      t('1.00 22.00', 320, 136, 134),
      t('22.00 SR', 560, 136, 106),
      t('Total Amt Incl. GST', 194, 172, 250),
      t('27.00', 560, 172, 71),
      t('Rounding Adjusment:', 231, 208, 210),
      t('0.00', 600, 208, 40),
      t('Total Amt Payable :', 194, 244, 249),
      t('27.00', 560, 244, 71),
      t('GST Summary', 82, 280, 182),
      t('Amount(RM)', 293, 280, 162),
      t('GST (RM)', 498, 280, 130),
      t('SR = 6 %', 83, 316, 124),
      t('25.47', 382, 316, 72),
      t('1.53', 571, 316, 57),
      t('POINT. 0.00', 232, 352, 162),
    ];
    const rows = tablesIn(lines).flatMap(rowsOf);
    expect(rows).toContainEqual(['GST Summary', 'Amount(RM)', 'GST (RM)']);
    expect(rows).toContainEqual(['SR = 6 %', '25.47', '1.53']);
  });

  it('two blocks side by side (an address next to an address) are not a table', () => {
    const left = ['ASAKI SUSHI', '48 RUE DE CHARTRES', '91410 DOURDAN', 'Siret 81265228'];
    const right = ['Monsieur XIA', '52T RUE VICTOR HUGO', 'PORTE 185', '93500 PANTIN'];
    const lines = left.flatMap((t, r) => [
      box(t, 100, 100 + r * 30, 220),
      box(right[r]!, 800, 100 + r * 30, 220),
    ]);
    expect(tablesIn(lines)).toHaveLength(0);
  });

  it('amounts shifted against their labels (a steep photo) are not paired up', () => {
    // Photographed very obliquely: numbers on the right are two rows higher than items on the left, with no items next to the top two numbers.
    const lines = [
      box('497.16', 700, 40),
      box('184.91', 700, 70),
      ...['Room Charge', 'Room Service', 'Service VAT', 'Package VAT'].flatMap((t, r) => [
        box(t, 100, 100 + r * 30, 220),
        box(['11.09', '2.83', '695.99', '0.00'][r]!, 700, 100 + r * 30),
      ]),
    ];
    expect(tablesIn(lines)).toHaveLength(0);
  });
});

describe('an invoice’s item table with its totals under the right-hand columns (D-506)', () => {
  // Text-based invoice from user testing (2026-11-09): header and four rows of items, each row
  // underlined with a faint thin horizontal line (cannot be found by line detection); separated by
  // a gap below the table, the right two columns contain Subtotal / VAT 20% / Total due.
  // Previously: total rows were isolated in distant columns with no text on the left, treated as
  // "offset numbers" (D-502), causing the entire table to fail recognition; item names merged into
  // one segment, multi-column numbers each formed a segment, and the last row combined with the
  // total into a two-column table.
  const page = buildDocPage({
    image: white(INVOICE.width, INVOICE.height),
    lines: INVOICE.lines,
    source: 's',
    skew: 0,
  });
  const leaves = leafBlocks(page);
  const tables = leaves.filter((b): b is DocTable => b.kind === 'table');

  it('the header and the four items become one four-column table', () => {
    const items = tables.find((t) => rowsOf(t)[0]?.[0] === 'Item');
    expect(items?.table.cols).toBe(4);
    expect(rowsOf(items!).slice(0, INVOICE_ITEMS.length)).toEqual(INVOICE_ITEMS);
  });

  it('no paragraph holds item names or their amounts, and nothing is lost', () => {
    const paragraphs = leaves.flatMap((b) => (b.kind === 'paragraph' ? [b.text] : []));
    for (const text of ['Toner cartridge', '£129.80', 'Desk organiser']) {
      expect(paragraphs.filter((p) => p.includes(text))).toEqual([]);
    }
    const all = [...paragraphs, ...tables.flatMap((t) => t.table.cells.map((c) => c.text))].join(
      ' ',
    );
    for (const l of INVOICE.lines) expect(all).toContain(l.text);
  });
});
