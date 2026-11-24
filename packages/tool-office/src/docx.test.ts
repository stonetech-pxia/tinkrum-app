import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { textEm, type DocDoc, type DocPage, type DocTable } from './doc';
import { writeDocx } from './docx';

const box = { x: 100, y: 100, width: 400, height: 40 };

function page(blocks: DocPage['blocks'], bodySize = 11): DocPage {
  return { source: 'file:///p.jpg', width: 1000, height: 1400, bodySize, blocks };
}

const unzip = (bytes: Uint8Array) => {
  const files = unzipSync(bytes);
  return {
    names: Object.keys(files).sort(),
    text: (name: string) => strFromU8(files[name]!),
    bytes: (name: string) => files[name]!,
  };
};

describe('writeDocx', () => {
  it('includes source label insets when measuring the content that can enlarge a table row', () => {
    const b = { x: 50, y: 100, width: 800, height: 20 };
    const table: DocTable = {
      kind: 'table',
      box: b,
      colWidths: [800],
      cellLayout: [{ row: 0, col: 0, lines: [{ x: 50, y: 119, width: 100, height: 1 }] }],
      table: {
        kind: 'table',
        box: b,
        col: 0,
        rows: 1,
        cols: 1,
        cells: [{ row: 0, col: 0, rowSpan: 1, colSpan: 1, box: b, text: 'Label' }],
      },
    };
    const xml = unzip(
      writeDocx({ version: 4, pages: [{ ...page([table]), paper: { width: 600, height: 840 } }] }),
    ).text('word/document.xml');
    const cell = xml.slice(xml.indexOf('<w:tc>'));
    const gap = Number(cell.match(/<w:spacing w:before="(\d+)"/)?.[1]);
    const row = Number(xml.match(/<w:trHeight w:val="(\d+)"/)?.[1]);
    expect(gap).toBeGreaterThan(0);
    expect(row).toBeGreaterThanOrEqual(gap + Math.round(10 * 1.18 * 20));
  });
  it('uses spare width for a short label in the last column of a nested layout row', () => {
    const p: DocPage = {
      ...page(
        [
          {
            kind: 'row',
            box: { x: 50, y: 100, width: 850, height: 80 },
            cells: [
              {
                width: 450,
                blocks: [
                  {
                    kind: 'paragraph',
                    text: 'Passenger',
                    box: { x: 50, y: 100, width: 150, height: 20 },
                  },
                  {
                    kind: 'paragraph',
                    text: 'FLIGHT',
                    box: { x: 360, y: 100, width: 40, height: 20 },
                  },
                  {
                    kind: 'paragraph',
                    text: 'Name and flight number',
                    box: { x: 50, y: 135, width: 350, height: 20 },
                  },
                ],
              },
              {
                width: 400,
                blocks: [
                  {
                    kind: 'paragraph',
                    text: 'Date and destination',
                    box: { x: 500, y: 100, width: 350, height: 20 },
                  },
                ],
              },
            ],
          },
        ],
        10,
      ),
      paper: { width: 600, height: 840 },
    };
    const xml = unzip(writeDocx({ version: 4, pages: [p] })).text('word/document.xml');
    const grids = xml.match(/<w:tblGrid>.*?<\/w:tblGrid>/g)!;
    const widths = [...grids[1]!.matchAll(/w:w="(\d+)"/g)].map((m) => Number(m[1]));
    expect(widths.at(-1)).toBeGreaterThanOrEqual(Math.ceil(textEm('FLIGHT') * 10 * 20 + 160));
  });
  it('borrows unused width from earlier cells so a short last cell stays on one line', () => {
    // Footer: a URL on the left, and "1/3" flush against the right page margin; the whole row is wider than the content area, with no empty space on the right to borrow, so the cell is only as wide as "1/3".
    const footer = (last: string, lastWidth: number) => ({
      kind: 'row' as const,
      box: { x: 40, y: 1350, width: 950, height: 20 },
      cells: [
        {
          width: 950 - lastWidth,
          blocks: [
            {
              kind: 'paragraph' as const,
              text: 'http://www.example.org/atto/stampa/originario',
              box: { x: 40, y: 1350, width: 380, height: 18 },
            },
          ],
        },
        {
          width: lastWidth,
          blocks: [
            {
              kind: 'paragraph' as const,
              text: last,
              box: { x: 990 - lastWidth, y: 1350, width: lastWidth, height: 18 },
            },
          ],
        },
      ],
    });
    for (const [text, width] of [
      ['1/3', 24],
      ['Page 2 of 5', 62],
      ['AUTRE TOTAL', 46],
    ] as const) {
      const p: DocPage = { ...page([footer(text, width)], 9), paper: { width: 595, height: 842 } };
      const xml = unzip(writeDocx({ version: 4, pages: [p] })).text('word/document.xml');
      const grid = xml.match(/<w:tblGrid>.*?<\/w:tblGrid>/)![0];
      const widths = [...grid.matchAll(/w:w="(\d+)"/g)].map((m) => Number(m[1]));
      expect(widths.at(-1)).toBeGreaterThanOrEqual(Math.ceil(textEm(text) * 9 * 20 + 160));
      // Only the unused width on the left is borrowed: the URL still fits on one line.
      expect(widths[0]).toBeGreaterThanOrEqual(
        Math.ceil(textEm('http://www.example.org/atto/stampa/originario') * 9 * 20 + 160),
      );
    }
  });
  it('keeps a side-by-side row on the right half where the source has it', () => {
    // "FOB | DATE D'EXPÉDITION" on the right side of the invoice: the left half is empty, and the entire row should not be shifted to the left margin.
    const p: DocPage = {
      ...page(
        [
          {
            kind: 'paragraph',
            text: 'FACTURER À',
            box: { x: 100, y: 300, width: 150, height: 20 },
          },
          {
            kind: 'row',
            box: { x: 700, y: 400, width: 220, height: 20 },
            cells: [
              {
                width: 90,
                blocks: [
                  {
                    kind: 'paragraph',
                    text: 'FOB',
                    box: { x: 700, y: 400, width: 40, height: 20 },
                  },
                ],
              },
              {
                width: 130,
                blocks: [
                  {
                    kind: 'paragraph',
                    text: 'EXPÉDIÉ VIA',
                    box: { x: 790, y: 400, width: 120, height: 20 },
                  },
                ],
              },
            ],
          },
        ],
        10,
      ),
      paper: { width: 595, height: 833 },
    };
    const xml = unzip(writeDocx({ version: 4, pages: [p] })).text('word/document.xml');
    const indent = Number(xml.match(/<w:tblInd w:w="(\d+)"/)?.[1] ?? 0);
    expect(indent).toBeGreaterThan(0.85 * ((700 - 100) / 1000) * 11906);
    const grid = xml.match(/<w:tblGrid>.*?<\/w:tblGrid>/)![0];
    const total = [...grid.matchAll(/w:w="(\d+)"/g)].reduce((n, m) => n + Number(m[1]), 0);
    expect(indent + total).toBeLessThanOrEqual(11906 - 2 * 1134);
  });
  it('reserves the painted border in the minimum height of a tightly packed text row', () => {
    const b = { x: 50, y: 100, width: 800, height: 2 };
    const t: DocTable = {
      kind: 'table',
      box: b,
      colWidths: [800],
      table: {
        kind: 'table',
        box: b,
        col: 0,
        cols: 1,
        rows: 1,
        cells: [{ row: 0, col: 0, rowSpan: 1, colSpan: 1, box: b, text: 'Label' }],
      },
    };
    const xml = unzip(
      writeDocx({ version: 4, pages: [{ ...page([t]), paper: { width: 600, height: 840 } }] }),
    ).text('word/document.xml');
    expect(Number(xml.match(/<w:trHeight w:val="(\d+)"/)?.[1])).toBeGreaterThanOrEqual(246);
  });
  it('uses the physical vertical scale after OCR padded the raster to another aspect ratio', () => {
    const p: DocPage = {
      ...page([
        { kind: 'paragraph', text: 'Body', box: { x: 20, y: 1000, width: 500, height: 30 } },
      ]),
      height: 1500,
      paper: { width: 600, height: 840 },
      margins: { top: 0, left: 0, right: 0, bottom: 0 },
    };
    expect(unzip(writeDocx({ version: 4, pages: [p] })).text('word/document.xml')).toContain(
      '<w:spacing w:before="11200"',
    );
  });
  it('does not charge the full vertical gap of a merged cell to its first row', () => {
    const b = { x: 50, y: 100, width: 800, height: 200 };
    const t: DocTable = {
      kind: 'table',
      box: b,
      colWidths: [400, 400],
      cellLayout: [
        {
          row: 0,
          col: 0,
          lines: [
            { x: 70, y: 110, width: 200, height: 20 },
            { x: 70, y: 270, width: 200, height: 20 },
          ],
        },
      ],
      table: {
        kind: 'table',
        box: b,
        col: 0,
        cols: 2,
        rows: 2,
        cells: [
          {
            row: 0,
            col: 0,
            rowSpan: 2,
            colSpan: 1,
            box: { ...b, width: 400 },
            text: 'Top\nBottom',
          },
          ...[0, 1].map((row) => ({
            row,
            col: 1,
            rowSpan: 1,
            colSpan: 1,
            box: { x: 450, y: 100 + 100 * row, width: 400, height: 100 },
            text: 'Value',
          })),
        ],
      },
    };
    const xml = unzip(
      writeDocx({ version: 4, pages: [{ ...page([t]), paper: { width: 600, height: 840 } }] }),
    ).text('word/document.xml');
    const cell = xml.slice(xml.indexOf('<w:tc>'), xml.indexOf('</w:tc>'));
    expect(cell.match(/w:before="0"/g)).toHaveLength(2);
    expect(cell).toContain('<w:vAlign w:val="center"/>');
    expect(cell).not.toContain('w:lineRule="exact"');
  });
  it('keeps a form label below its empty writing area using normal cell paragraph spacing', () => {
    const table: DocTable = {
      kind: 'table',
      box: { x: 50, y: 100, width: 800, height: 100 },
      colWidths: [800],
      cellLayout: [{ row: 0, col: 0, lines: [{ x: 70, y: 160, width: 300, height: 20 }] }],
      table: {
        kind: 'table',
        col: 0,
        cols: 1,
        rows: 1,
        box: { x: 50, y: 100, width: 800, height: 100 },
        cells: [
          {
            row: 0,
            col: 0,
            rowSpan: 1,
            colSpan: 1,
            text: 'Label',
            box: { x: 50, y: 100, width: 800, height: 100 },
          },
        ],
      },
    } as DocTable;
    const xml = unzip(
      writeDocx({ version: 3, pages: [{ ...page([table]), paper: { width: 600, height: 840 } }] }),
    ).text('word/document.xml');
    const before = Number(
      xml.slice(xml.indexOf('<w:tc>')).match(/<w:spacing w:before="(\d+)"/)?.[1],
    );
    expect(before).toBeGreaterThan(600);
    expect(before).toBeLessThan(720);
    expect(xml).toContain('<w:ind w:left="240"');
    expect(xml).not.toContain('<w:txbxContent>');
  });
  it('keeps editable table rows at their source heights using the vertical paper scale', () => {
    const table: DocTable = {
      kind: 'table',
      box: { x: 50, y: 100, width: 800, height: 200 },
      colWidths: [800],
      table: {
        kind: 'table',
        col: 0,
        cols: 1,
        rows: 2,
        box: { x: 50, y: 100, width: 800, height: 200 },
        cells: [0, 1].map((row) => ({
          row,
          col: 0,
          rowSpan: 1,
          colSpan: 1,
          text: 'Label',
          box: { x: 50, y: 100 + row * 100, width: 800, height: 100 },
        })),
      },
    };
    const xml = unzip(
      writeDocx({ version: 3, pages: [{ ...page([table]), paper: { width: 600, height: 840 } }] }),
    ).text('word/document.xml');
    expect(xml.match(/<w:trHeight w:val="1190" w:hRule="atLeast"\/>/g)).toHaveLength(2);
  });
  it('gives required table separator paragraphs an explicit one-point line height', () => {
    const table: DocTable = {
      kind: 'table',
      box,
      colWidths: [400],
      table: {
        kind: 'table',
        box,
        col: 0,
        cols: 1,
        rows: 1,
        cells: [{ row: 0, col: 0, rowSpan: 1, colSpan: 1, text: 'Editable value' }],
      },
    };
    const xml = unzip(writeDocx({ version: 3, pages: [page([table])] })).text('word/document.xml');
    expect(xml).toContain('<w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/>');
  });
  it('preserves a blank source page between two populated pages', () => {
    const paper = { width: 595.3, height: 841.9 };
    const first = {
      ...page([{ kind: 'paragraph' as const, text: 'First source page', box }]),
      paper,
    };
    const blank = { ...page([]), paper };
    const third = {
      ...page([{ kind: 'paragraph' as const, text: 'Third source page', box }]),
      paper,
    };
    const xml = unzip(writeDocx({ version: 2, pages: [first, blank, third] })).text(
      'word/document.xml',
    );
    expect(xml.match(/<w:sectPr>/g)).toHaveLength(3);
    expect(xml.match(/<w:type w:val="nextPage"\/>/g)).toHaveLength(2);
    expect(xml).toContain('First source page');
    expect(xml).toContain('Third source page');
  });

  it('keeps source spacing on a physical page whose text needs another page anyway', () => {
    const blocks: DocPage['blocks'] = [];
    let y = 60;
    for (let i = 0; i < 8; i++) {
      blocks.push({
        kind: 'paragraph',
        text: `Heading line ${i}`,
        box: { x: 80, y, width: 300, height: 20 },
      });
      y += 80;
    }
    blocks.push({
      kind: 'paragraph',
      text: 'lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(80),
      box: { x: 80, y, width: 840, height: 600 },
    });
    const befores = (paper?: { width: number; height: number }) =>
      [
        ...unzip(
          writeDocx({ version: 5, pages: [{ ...page(blocks), ...(paper ? { paper } : {}) }] }),
        )
          .text('word/document.xml')
          .matchAll(/w:before="(\d+)"/g),
      ].map((m) => Number(m[1]));
    // Cannot fit into a single page even by squeezing whitespace: like the old writing style, do not squeeze, and keep spacing between paragraphs as usual.
    const spaced = befores({ width: 595.3, height: 841.9 });
    expect(spaced.length).toBeGreaterThanOrEqual(7);
    expect(spaced.every((v) => v > 0)).toBe(true);
    expect(befores()).toHaveLength(spaced.length);
  });

  it('gives rotated table cells their source text direction and vertical writing room', () => {
    const table: DocTable = {
      kind: 'table',
      direction: 'tbRl',
      box,
      colWidths: [200, 200],
      size: 12,
      table: {
        kind: 'table',
        box,
        col: 0,
        cols: 2,
        rows: 1,
        cells: [0, 1].map((col) => ({
          row: 0,
          col,
          rowSpan: 1,
          colSpan: 1,
          text: 'Vertical label',
          box: { x: 100 + col * 200, y: 100, width: 200, height: 400 },
        })),
      },
    };
    const xml = unzip(
      writeDocx({ version: 2, pages: [{ ...page([table]), paper: { width: 840, height: 600 } }] }),
    ).text('word/document.xml');
    expect(xml.match(/<w:textDirection w:val="tbRl"\/>/g)).toHaveLength(2);
    expect(xml).toContain('<w:trHeight w:val="6710" w:hRule="atLeast"/>');
  });

  it('does not enlarge recognized table fonts when source margins make more horizontal room', () => {
    const tables: DocTable[] = Array.from({ length: 4 }, (_, i) => ({
      kind: 'table',
      box: { x: 40 + i * 230, y: 200, width: 230, height: 80 },
      colWidths: [230],
      size: 12,
      table: {
        kind: 'table',
        col: 0,
        cols: 1,
        rows: 1,
        box,
        cells: [{ row: 0, col: 0, rowSpan: 1, colSpan: 1, text: `Field ${i + 1}` }],
      },
    }));
    const sheet = {
      ...page([
        {
          kind: 'row',
          box: { x: 40, y: 200, width: 920, height: 80 },
          cells: tables.map((t) => ({ width: 230, blocks: [t] })),
        },
      ]),
      paper: { width: 595.3, height: 841.9 },
    };
    const sizes = (margins?: DocPage['margins']) => {
      const xml = unzip(
        writeDocx({ version: 2, pages: [{ ...sheet, ...(margins ? { margins } : {}) }] }),
      ).text('word/document.xml');
      return [...xml.matchAll(/<w:sz w:val="(\d+)"\/>/g)].map((m) => m[1]);
    };
    expect(sizes({ top: 10, left: 10, right: 10, bottom: 10 })).toEqual(sizes());
  });

  it('preserves the smaller label and larger value sizes carried by cells', () => {
    const table: DocTable = {
      kind: 'table',
      box,
      colWidths: [200, 200],
      size: 12,
      table: {
        kind: 'table',
        box,
        col: 0,
        cols: 2,
        rows: 1,
        cells: [
          { row: 0, col: 0, rowSpan: 1, colSpan: 1, text: 'Label', size: 9 },
          { row: 0, col: 1, rowSpan: 1, colSpan: 1, text: '118.40', size: 18 },
        ],
      },
    };
    const xml = unzip(writeDocx({ version: 1, pages: [page([table])] })).text('word/document.xml');
    expect(xml).toMatch(/<w:sz w:val="18"\/>[^]*?>Label<\/w:t>/);
    expect(xml).toMatch(/<w:sz w:val="36"\/>[^]*?>118.40<\/w:t>/);
    expect(xml).toMatch(
      /<\/w:tbl><w:p><w:pPr>(?:<w:spacing[^>]*\/>)?<w:rPr>[^]*?<w:sz w:val="2"\/>/,
    );
  });

  it('writes per-page source paper sizes, including a small landscape ticket, without extra page breaks', () => {
    const first = {
      ...page([{ kind: 'paragraph' as const, text: 'Ticket', box }]),
      paper: { width: 595.28, height: 255.12 },
    };
    const second = {
      ...page([{ kind: 'paragraph' as const, text: 'Letter', box }]),
      paper: { width: 612, height: 792 },
    };
    const xml = unzip(writeDocx({ version: 1, pages: [first, second] })).text('word/document.xml');
    expect(xml).toContain('<w:pgSz w:w="11906" w:h="5102" w:orient="landscape"/>');
    expect(xml).toContain('<w:pgSz w:w="12240" w:h="15840"/>');
    expect(xml.match(/<w:sectPr>/g)).toHaveLength(2);
    expect(xml).not.toContain('<w:pageBreakBefore/>');
    expect(xml).toContain('<w:type w:val="nextPage"/>');
  });

  it('writes explicit data-table cell margins consistent with its text-width budget, including nested tables', () => {
    const table: DocTable = {
      kind: 'table',
      box,
      colWidths: [200, 200],
      table: {
        kind: 'table',
        rows: 1,
        cols: 2,
        col: 0,
        box,
        cells: ['Label', 'Amount'].map((text, col) => ({
          row: 0,
          col,
          rowSpan: 1,
          colSpan: 1,
          text,
        })),
      },
    };
    const doc: DocDoc = {
      version: 1,
      pages: [page([table, { kind: 'row', box, cells: [{ width: 500, blocks: [table] }] }])],
    };
    const xml = unzip(writeDocx(doc)).text('word/document.xml');
    const props = [...xml.matchAll(/<w:tblPr>(.*?)<\/w:tblPr>/g)].map((m) => m[1]!);
    expect(props).toHaveLength(3);
    // Do not rely solely on default table styles: some readers replace them with their own default padding.
    for (const p of props)
      expect(p).toContain(
        '<w:tblCellMar><w:left w:w="80" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar>',
      );
  });

  it.each([
    ['2结果', 15.5, 103],
    ['参考文献', 15, 139],
    ['Résumé', 16, 90],
  ])(
    'keeps a single-line centered heading %s inside the last cell without splitting it',
    (text, size, width) => {
      const at = { x: 720, y: 300, width, height: 39 };
      const doc: DocDoc = {
        version: 1,
        pages: [
          {
            ...page([], 10.5),
            width: 1408,
            height: 2016,
            blocks: [
              {
                kind: 'row',
                box: { x: 105, y: 300, width: 720 + width - 105, height: 39 },
                cells: [
                  {
                    width: 615,
                    blocks: [
                      { kind: 'paragraph', text: 'Body', box: { ...at, x: 105, width: 560 } },
                    ],
                  },
                  {
                    width,
                    blocks: [
                      { kind: 'paragraph', heading: 2, text, size, align: 'center', box: at },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };
      const xml = unzip(writeDocx(doc)).text('word/document.xml');
      const widths = [...xml.matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].map((m) => Number(m[1]));
      const minimum =
        text === '2结果' ? (2 * size + 8.6) * 20 : text === '参考文献' ? 4 * size * 20 : 60 * 20;
      expect(widths[1]! - 160).toBeGreaterThanOrEqual(minimum);
      expect(widths[0]).toBe(Math.round((615 / 1408) * 11906));
      expect(widths.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(9638);
      expect(xml).toContain('<w:jc w:val="center"/>');
      expect(xml).toContain(`>${text}</w:t>`);
    },
  );

  it.each([
    ['center', undefined, 39],
    ['right', 2, 39],
    ['center', 2, 100],
  ] as const)(
    'preserves the width for %s text with heading=%s and source height=%s',
    (align, heading, height) => {
      const doc: DocDoc = {
        version: 1,
        pages: [
          {
            ...page([], 11),
            width: 1408,
            height: 2016,
            blocks: [
              {
                kind: 'row',
                box,
                cells: [
                  { width: 615, blocks: [{ kind: 'paragraph', text: 'Body', box }] },
                  {
                    width: 139,
                    blocks: [
                      {
                        kind: 'paragraph',
                        text: '参考文献',
                        size: 15,
                        align,
                        ...(heading ? { heading } : {}),
                        box: { x: 720, y: 300, width: 139, height },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };
      const xml = unzip(writeDocx(doc)).text('word/document.xml');
      const widths = [...xml.matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].map((m) => Number(m[1]));
      expect(widths).toEqual([Math.round((615 / 1408) * 11906), Math.round((139 / 1408) * 11906)]);
    },
  );

  it('keeps a centered heading inside its column when no spare page width is available', () => {
    const doc: DocDoc = {
      version: 1,
      pages: [
        page([
          {
            kind: 'row',
            box,
            cells: [
              { width: 500, blocks: [{ kind: 'paragraph', text: 'Body', box }] },
              {
                width: 500,
                blocks: [
                  {
                    kind: 'paragraph',
                    text: 'A heading which cannot fit',
                    heading: 2,
                    size: 45,
                    align: 'center',
                    box: { x: 500, y: 100, width: 500, height: 90 },
                  },
                ],
              },
            ],
          },
        ]),
      ],
    };
    const xml = unzip(writeDocx(doc)).text('word/document.xml');
    const widths = [...xml.matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].map((m) => Number(m[1]));
    expect(widths).toEqual([4819, 4819]);
    expect(xml).toContain('<w:sz w:val="90"/>');
  });

  it('uses spare row width for a single line at its exported font size, including cell padding', () => {
    const doc: DocDoc = {
      version: 1,
      pages: [
        {
          ...page([], 12),
          width: 1408,
          height: 2016,
          blocks: [
            {
              kind: 'row',
              box: { x: 105, y: 269, width: 844, height: 29 },
              cells: [
                {
                  width: 616,
                  blocks: [
                    {
                      kind: 'paragraph',
                      text: 'From: Northfield Studio',
                      box: { x: 105, y: 270, width: 270, height: 27 },
                    },
                  ],
                },
                {
                  width: 228,
                  blocks: [
                    {
                      kind: 'paragraph',
                      text: 'Bill to: Elena Martin',
                      box: { x: 721, y: 269, width: 228, height: 29 },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const xml = unzip(writeDocx(doc)).text('word/document.xml');
    const widths = [...xml.matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].map((m) => Number(m[1]));
    expect(widths[0]).toBe(Math.round((616 / 1408) * 11906));
    // An Arial 12 pt full line is about 103.3 pt, plus 4 pt padding on each side; do not use the text recognition bounding box as the available column width.
    expect(widths[1]! - 160).toBeGreaterThanOrEqual(103.3 * 20);
    expect(widths.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(9638);
    expect(xml).toContain('>Bill to: Elena Martin</w:t>');
  });

  it('keeps a short right-aligned page label on one line even when it contains a space', () => {
    const p: DocPage = {
      ...page(
        [
          {
            kind: 'row',
            box: { x: 80, y: 90, width: 1370, height: 34 },
            cells: [
              {
                width: 1295,
                blocks: [
                  {
                    kind: 'paragraph',
                    text: 'Form title',
                    size: 7.5,
                    box: { x: 80, y: 90, width: 140, height: 27 },
                  },
                ],
              },
              {
                width: 73,
                blocks: [
                  {
                    kind: 'paragraph',
                    text: 'Page 5',
                    align: 'right',
                    box: { x: 1377, y: 90, width: 73, height: 34 },
                  },
                ],
              },
            ],
          },
        ],
        12,
      ),
      width: 1536,
      height: 2016,
      paper: { width: 612, height: 792 },
      margins: { left: 33, right: 33, top: 34, bottom: 20 },
    };
    const xml = unzip(writeDocx({ version: 4, pages: [p] })).text('word/document.xml');
    const widths = [...xml.matchAll(/<w:gridCol w:w="(\d+)"/g)].map((m) => Number(m[1]));
    expect(widths.at(-1)).toBeGreaterThanOrEqual(Math.ceil(textEm('Page 5') * 12 * 20 + 160));
    expect(widths.reduce((n, w) => n + w, 0)).toBeLessThanOrEqual((612 - 66) * 20);
  });
  it('keeps a short right-aligned label unbroken when a prose row must shrink to the page', () => {
    const doc: DocDoc = {
      version: 1,
      pages: [
        {
          source: 's',
          width: 1408,
          height: 2016,
          bodySize: 12,
          blocks: [
            {
              kind: 'row',
              box: { x: 116, y: 847, width: 1177, height: 72 },
              cells: [
                {
                  width: 1126,
                  blocks: [
                    {
                      kind: 'paragraph',
                      text: 'Calculate the height reached by the object and explain the answer.',
                      box: { x: 116, y: 851, width: 1020, height: 30 },
                    },
                  ],
                },
                {
                  width: 51,
                  blocks: [
                    {
                      kind: 'paragraph',
                      text: '[6]',
                      align: 'right',
                      box: { x: 1242, y: 847, width: 51, height: 42 },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const zip = unzipSync(writeDocx(doc));
    const xml = strFromU8(zip['word/document.xml']!);
    const widths = [...xml.matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].map((m) => Number(m[1]));
    // [6] in Arial 12 pt is about 13.35 pt, plus 4 pt cell padding on each side.
    expect(widths[1]! - 160).toBeGreaterThanOrEqual(13.35 * 20);
    expect(widths.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(9638);
    expect(xml).toContain('[6]');
  });

  it('preserves a table’s horizontal position and keeps its width inside the page', () => {
    const at = { x: 435, y: 279, width: 487, height: 200 };
    const xml = unzip(
      writeDocx({
        version: 1,
        pages: [
          {
            ...page([]),
            width: 1408,
            height: 2016,
            blocks: [
              {
                kind: 'table',
                box: at,
                colWidths: [143, 106, 135, 104],
                table: {
                  kind: 'table',
                  box: at,
                  rows: 1,
                  cols: 4,
                  col: 0,
                  cells: ['项目名称', '数量', '单价', '金额'].map((text, col) => ({
                    row: 0,
                    col,
                    rowSpan: 1,
                    colSpan: 1,
                    text,
                  })),
                },
              },
            ],
          },
        ],
      }),
    ).text('word/document.xml');
    const indent = Number(xml.match(/<w:tblInd w:w="(\d+)" w:type="dxa"\/>/)?.[1] ?? 0);
    expect(indent).toBeGreaterThan(2500);
    expect(indent).toBeLessThan(2600);
    const width = [...xml.matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].reduce(
      (sum, m) => sum + Number(m[1]),
      0,
    );
    expect(indent + width).toBeLessThanOrEqual(9638);
  });

  it('writes a valid package with document, styles and numbering parts', () => {
    const zip = unzip(writeDocx({ version: 1, pages: [page([])] }));
    expect(zip.names).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'word/_rels/document.xml.rels',
      'word/document.xml',
      'word/fontTable.xml',
      'word/numbering.xml',
      'word/styles.xml',
    ]);
    expect(zip.text('[Content_Types].xml')).toContain(
      'PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"',
    );
    expect(zip.text('_rels/.rels')).toContain('Target="word/document.xml"');
    // A4 Portrait.
    expect(zip.text('word/document.xml')).toContain('<w:pgSz w:w="11906" w:h="16838"/>');
    // Body font size written into default style (half-points).
    expect(zip.text('word/styles.xml')).toContain('<w:sz w:val="22"/>');
  });

  it('writes headings, run styles, alignment, escaped text and line breaks', () => {
    const doc: DocDoc = {
      version: 1,
      pages: [
        page([
          { kind: 'paragraph', text: 'Titre', heading: 1, bold: true, box },
          {
            kind: 'paragraph',
            text: 'A < B & "C"\nsecond line',
            color: '172094',
            size: 14,
            align: 'center',
            spaced: true,
            box,
          },
          { kind: 'paragraph', text: 'body size', size: 11, box },
        ]),
      ],
    };
    const xml = unzip(writeDocx(doc)).text('word/document.xml');
    expect(xml).toContain('<w:pStyle w:val="Heading1"/>');
    // Every run writes font size (D-335: Apple's Preview does not read font sizes from default styles and treats everything as 12 pt); headings use heading style sizes.
    expect(xml).toContain(
      '<w:b/><w:bCs/><w:sz w:val="35"/><w:szCs w:val="35"/></w:rPr><w:t xml:space="preserve">Titre</w:t>',
    );
    expect(xml).toContain('<w:color w:val="172094"/><w:sz w:val="28"/>');
    expect(xml).toContain('<w:jc w:val="center"/>');
    expect(xml).toContain('<w:spacing w:before="160"/>');
    expect(xml).toContain('A &lt; B &amp; &quot;C&quot;');
    expect(xml).toContain('<w:br/><w:t xml:space="preserve">second line</w:t>');
    // Runs with the same size as body text also write body font size; do not draw underlines and strikethroughs.
    expect(xml).toMatch(
      /<w:rPr><w:rFonts [^>]*\/><w:sz w:val="22"\/><w:szCs w:val="22"\/><\/w:rPr><w:t xml:space="preserve">body size<\/w:t>/,
    );
    expect(xml).not.toMatch(/<w:u |<w:strike/);
  });

  it('writes lists with their own numbering, starting at the first item’s number', () => {
    const doc: DocDoc = {
      version: 1,
      pages: [
        page([
          { kind: 'list', ordered: true, format: '%1)', start: 3, items: ['three', 'four'], box },
          { kind: 'list', ordered: false, items: ['dot'], box },
        ]),
      ],
    };
    const zip = unzip(writeDocx(doc));
    const xml = zip.text('word/document.xml');
    expect(xml.match(/<w:numId w:val="1"\/>/g)).toHaveLength(2);
    expect(xml.match(/<w:numId w:val="2"\/>/g)).toHaveLength(1);
    const numbering = zip.text('word/numbering.xml');
    expect(numbering).toContain(
      '<w:start w:val="3"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1)"/>',
    );
    expect(numbering).toContain('<w:numFmt w:val="bullet"/><w:lvlText w:val="•"/>');
    expect(numbering).toContain('<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>');
  });

  it('writes tables with column widths, horizontal and vertical merges', () => {
    const doc: DocDoc = {
      version: 1,
      pages: [
        page([
          {
            kind: 'table',
            colWidths: [100, 200, 200],
            box,
            table: {
              kind: 'table',
              rows: 2,
              col: 0,
              cols: 3,
              box,
              cells: [
                { row: 0, col: 0, rowSpan: 2, colSpan: 1, text: 'tall' },
                { row: 0, col: 1, rowSpan: 1, colSpan: 2, text: 'wide' },
                { row: 1, col: 1, rowSpan: 1, colSpan: 1, text: '12', align: 'right' },
                { row: 1, col: 2, rowSpan: 1, colSpan: 1, text: '' },
              ],
            },
          },
        ]),
      ],
    };
    const xml = unzip(writeDocx(doc)).text('word/document.xml');
    // Original image width of 1000 pixels converted based on A4 width of 11906 twips.
    expect(xml).toContain('<w:gridCol w:w="1191"/><w:gridCol w:w="2381"/><w:gridCol w:w="2381"/>');
    const rows = xml.match(/<w:tr>.*?<\/w:tr>/g)!;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('<w:vMerge w:val="restart"/>');
    expect(rows[0]).toContain('<w:gridSpan w:val="2"/>');
    expect(rows[1]!.match(/<w:tc>/g)).toHaveLength(3);
    expect(rows[1]).toContain('<w:vMerge/>');
    expect(rows[1]).toContain('<w:jc w:val="right"/>');
  });

  it('scales table text with the table and shrinks the whole table until the longest word fits (D-335)', () => {
    const table = (colWidths: number[], texts: string[], size: number): DocDoc => ({
      version: 1,
      pages: [
        page([
          {
            kind: 'table',
            colWidths,
            size,
            box,
            table: {
              kind: 'table',
              rows: 1,
              col: 0,
              cols: texts.length,
              box,
              cells: texts.map((text, col) => ({ row: 0, col, rowSpan: 1, colSpan: 1, text })),
            },
          },
        ]),
      ],
    });
    const sizes = (doc: DocDoc) =>
      [
        ...unzip(writeDocx(doc))
          .text('word/document.xml')
          // Count font sizes only on runs (paragraph marks are counted separately).
          .matchAll(/<w:sz w:val="(\d+)"\/><w:szCs [^>]*><\/w:rPr><w:t /g),
      ].map((m) => Number(m[1]) / 2);
    // Full-page width tables are scaled down according to the content area (11906 -> 9638 twips, approx. 0.81): 10 pt text scales down to 8 pt accordingly.
    expect(sizes(table([500, 500], ['a', 'b'], 10))).toEqual([8, 8]);
    // Narrow column (approx. 48 pt wide, minus 40 pt cell padding) cannot fit "MARQUEUR": the entire table scales down together to 7 pt.
    expect(sizes(table([100, 900], ['MARQUEUR', 'b'], 10))).toEqual([7, 7]);
    // Even longer words are not smaller than 5 pt.
    expect(sizes(table([100, 900], ['REFRIGERATEURS', 'b'], 10))).toEqual([5, 5]);
    // The entire table scales down by at most a factor of 0.6 (a 14 pt table normally becomes 11 pt based on the content area, scaling down to at most 6.5 pt); only the cell that does not fit scales down to 5 pt.
    expect(sizes(table([100, 900], ['REFRIGERATEURS', 'b'], 14))).toEqual([5, 6.5]);
  });

  it('keeps a table readable when one very narrow column holds a short number (EU sample 020)', () => {
    const doc: DocDoc = {
      version: 1,
      pages: [
        page([
          {
            kind: 'table',
            colWidths: [855, 30, 115],
            size: 10,
            box,
            table: {
              kind: 'table',
              rows: 1,
              col: 0,
              cols: 3,
              box,
              cells: ['opłata za energię czynną pobraną w okresie', '23', '24,48'].map(
                (text, col) => ({ row: 0, col, rowSpan: 1, colSpan: 1, text }),
              ),
            },
          },
        ]),
      ],
    };
    const xml = unzip(writeDocx(doc)).text('word/document.xml');
    const sizes = [...xml.matchAll(/<w:sz w:val="(\d+)"\/><w:szCs [^>]*><\/w:rPr><w:t /g)].map(
      (m) => Number(m[1]) / 2,
    );
    // The column for "23" is about 14 pt wide: the old 8 pt cell padding takes up a major part,
    // causing the entire table to scale down to 5.5 pt. After the padding is scaled down with the
    // cell width, "23" fits, and the table scales down to 8 pt as usual based on the content area.
    expect(sizes).toEqual([8, 8, 8]);
    expect(xml).toMatch(/<w:tcMar><w:left w:w="\d+" w:type="dxa"\/><w:right w:w="\d+"/);
  });

  it('writes each page’s text at that page’s body size (D-335)', () => {
    const doc: DocDoc = {
      version: 1,
      pages: [
        page(
          [
            { kind: 'paragraph', text: 'form', box },
            {
              kind: 'table',
              colWidths: [100, 100],
              box,
              table: {
                kind: 'table',
                rows: 2,
                col: 0,
                cols: 2,
                box,
                cells: [
                  { row: 0, col: 0, rowSpan: 2, colSpan: 1, text: 'a' },
                  { row: 0, col: 1, rowSpan: 1, colSpan: 1, text: '' },
                  { row: 1, col: 1, rowSpan: 1, colSpan: 1, text: 'b' },
                ],
              },
            },
            {
              kind: 'row',
              box,
              cells: [{ width: 300, blocks: [{ kind: 'image', box }] }],
            },
          ],
          7,
        ),
        page([{ kind: 'paragraph', text: 'prose', box }], 10),
      ],
    };
    const xml = unzip(writeDocx(doc)).text('word/document.xml');
    expect(xml).toMatch(
      /<w:sz w:val="14"\/><w:szCs w:val="14"\/><\/w:rPr><w:t xml:space="preserve">form</,
    );
    expect(xml).toMatch(
      /<w:sz w:val="20"\/><w:szCs w:val="20"\/><\/w:rPr><w:t xml:space="preserve">prose</,
    );
    // Paragraph marks also write font size: empty paragraphs and empty cell line heights follow the font size, and Apple's Preview also calculates line height based on it.
    expect(xml).toContain('<w:pPr><w:rPr><w:sz w:val="14"/><w:szCs w:val="14"/></w:rPr></w:pPr>');
    // Empty paragraphs after tables, empty cells, and empty paragraphs in side-by-side rows all include font sizes (no bare <w:p/>).
    expect(xml).not.toContain('<w:p/>');
  });

  it('retains source picture size when even the smallest picture cannot fit overflowing editable text', () => {
    const image = {
      kind: 'image' as const,
      src: 'picture',
      box: { x: 50, y: 50, width: 600, height: 200 },
    };
    const images = new Map([
      ['picture', { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), width: 600, height: 200 }],
    ]);
    const extent = (blocks: DocPage['blocks']) =>
      Number(
        unzip(
          writeDocx(
            { version: 4, pages: [{ ...page(blocks), paper: { width: 600, height: 840 } }] },
            images,
          ),
        )
          .text('word/document.xml')
          .match(/<wp:extent cx="(\d+)"/)?.[1],
      );
    expect(
      extent([
        image,
        {
          kind: 'paragraph',
          box: { x: 50, y: 270, width: 800, height: 1000 },
          text: 'Editable body text '.repeat(2000),
        },
      ]),
    ).toBe(extent([image]));
  });
  it('shrinks flowing pictures only after source whitespace cannot fit normal editable text on the page', () => {
    const image = {
      kind: 'image' as const,
      src: 'picture',
      box: { x: 0, y: 0, width: 900, height: 1200 },
    };
    const images = new Map([
      ['picture', { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), width: 900, height: 1200 }],
    ]);
    const extent = (blocks: DocPage['blocks']) =>
      Number(
        unzip(
          writeDocx(
            { version: 4, pages: [{ ...page(blocks), paper: { width: 600, height: 840 } }] },
            images,
          ),
        )
          .text('word/document.xml')
          .match(/<wp:extent cx="(\d+)"/)?.[1],
      );
    expect(
      extent([
        image,
        {
          kind: 'paragraph',
          box: { x: 0, y: 1210, width: 900, height: 180 },
          text: 'Large editable heading spans several normal text lines',
          size: 48,
        },
      ]),
    ).toBeLessThan(extent([image]));
  });
  it('keeps inline image line metrics independent of the surrounding body font', () => {
    for (const bodySize of [8, 24]) {
      const xml = unzip(
        writeDocx(
          {
            version: 4,
            pages: [
              {
                ...page([{ kind: 'image', src: 'picture', box }], bodySize),
                paper: { width: 600, height: 840 },
              },
            ],
          },
          new Map([
            [
              'picture',
              { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), width: 400, height: 40 },
            ],
          ]),
        ),
      ).text('word/document.xml');
      expect(xml).toContain(
        '<w:rPr><w:sz w:val="2"/><w:szCs w:val="2"/></w:rPr><w:drawing><wp:inline',
      );
    }
  });
  it('embeds cropped images and skips image blocks without one; each page starts on a new page', () => {
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const doc: DocDoc = {
      version: 1,
      pages: [
        page([{ kind: 'image', box: { x: 0, y: 0, width: 500, height: 250 }, src: 'crop1' }]),
        page([
          { kind: 'paragraph', text: 'page two', box },
          { kind: 'image', box },
        ]),
      ],
    };
    const zip = unzip(
      writeDocx(doc, new Map([['crop1', { bytes: jpg, width: 400, height: 200 }]])),
    );
    expect(zip.names).toContain('word/media/image1.jpg');
    expect(Array.from(zip.bytes('word/media/image1.jpg'))).toEqual(Array.from(jpg));
    expect(zip.text('word/_rels/document.xml.rels')).toContain(
      'Id="rIdImg1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.jpg"',
    );
    const xml = zip.text('word/document.xml');
    // Half-page width (5953 twips) -> EMUs; height based on image aspect ratio.
    expect(xml).toContain('<wp:extent cx="3780155" cy="1890078"/>');
    expect(xml.match(/<w:drawing>/g)).toHaveLength(1);
    expect(xml).toMatch(
      /<w:pageBreakBefore\/>(<w:rPr>.*?<\/w:rPr>)?<\/w:pPr><w:r><w:rPr>.*?<\/w:rPr><w:t xml:space="preserve">page two/,
    );
  });

  it('uses sans-serif fonts by default and bold headings (D-330)', () => {
    const zip = unzip(writeDocx({ version: 1, pages: [page([])] }));
    const styles = zip.text('word/styles.xml');
    expect(styles).toContain(
      '<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Microsoft YaHei" w:cs="Arial"/>',
    );
    expect(styles).toMatch(/w:styleId="Heading1">.*<w:rPr><w:b\/><w:bCs\/>/);
    // Font table specifies sans-serif (computers lacking this font fall back to another sans-serif font).
    const fonts = zip.text('word/fontTable.xml');
    expect(fonts).toContain('<w:font w:name="Microsoft YaHei"><w:altName w:val="PingFang SC"/>');
    expect(fonts).toContain('<w:family w:val="swiss"/>');
    // Each run also writes font (Apple's Preview does not read fonts from default styles).
    const xml = unzip(
      writeDocx({ version: 1, pages: [page([{ kind: 'paragraph', text: 'x', box }])] }),
    ).text('word/document.xml');
    expect(xml).toContain('<w:r><w:rPr><w:rFonts w:ascii="Arial"');
    expect(zip.text('word/_rels/document.xml.rels')).toContain('Target="fontTable.xml"');
    expect(zip.text('[Content_Types].xml')).toContain('PartName="/word/fontTable.xml"');
  });

  it('writes the first-line indent in twips (D-330)', () => {
    const xml = unzip(
      writeDocx({ version: 1, pages: [page([{ kind: 'paragraph', text: 'p', indent: 50, box }])] }),
    ).text('word/document.xml');
    // Original image width of 1000 pixels = A4 width of 11906 twips.
    expect(xml).toContain('<w:ind w:firstLine="595"/>');
  });

  it('measures left indents from the text, not from a full-bleed picture at the paper edge (EU sample 036)', () => {
    // Full-page header color band starts at x = 0; text starts at the left page margin (95 pixels) and should not be indented right by 95 pixels.
    const band = {
      kind: 'image' as const,
      src: 'band',
      box: { x: 0, y: 0, width: 1000, height: 60 },
    };
    const images = new Map([
      ['band', { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), width: 1000, height: 60 }],
    ]);
    const doc: DocDoc = {
      version: 1,
      pages: [
        {
          ...page([
            band,
            {
              kind: 'paragraph',
              text: 'Voorwoord',
              heading: 1,
              box: { x: 95, y: 120, width: 200, height: 40 },
            },
            {
              kind: 'paragraph',
              text: 'Body text.',
              box: { x: 95, y: 180, width: 300, height: 30 },
            },
          ]),
          paper: { width: 595, height: 842 },
          margins: { left: 56.7, right: 56.7, top: 56.7, bottom: 56.7 },
        },
      ],
    };
    const xml = unzip(writeDocx(doc, images)).text('word/document.xml');
    const paras = xml.match(/<w:p>.*?<\/w:p>/g)!.filter((p) => /Voorwoord|Body text/.test(p));
    expect(paras).toHaveLength(2);
    for (const p of paras) expect(p).not.toMatch(/<w:ind w:left/);
  });

  it('gives a wide wrapped paragraph the same indent as a heading on its left edge (EU sample 053)', () => {
    // Letter body starts 25 pixels to the right of the page margin: title and entire body paragraph are left-aligned; the body would naturally wrap in Word, and indentation is not yielded to the remaining space.
    const at = (x: number, y: number, width: number, height = 30) => ({ x, y, width, height });
    const long = 'Herr Beispiel arbeitete stets sorgfältig, zuverlässig und selbstständig. '.repeat(
      4,
    );
    const doc: DocDoc = {
      version: 1,
      pages: [
        page([
          { kind: 'paragraph', text: 'Arbeitszeugnis', box: at(120, 100, 200) },
          { kind: 'paragraph', text: long.trim(), box: at(120, 160, 780, 110) },
        ]),
      ],
    };
    const xml = unzip(writeDocx(doc)).text('word/document.xml');
    const lefts = [...xml.matchAll(/<w:ind w:left="(\d+)"/g)].map((m) => m[1]);
    expect(lefts).toHaveLength(2);
    expect(lefts[1]).toBe(lefts[0]);
  });

  it('gives up the indent of wrapped paragraphs when keeping it would push a full page onto two (EU sample 038)', () => {
    // Single-page instructions: each paragraph takes two lines flush-left in Word, or three lines if keeping indentation. Keep indentation when paragraphs are few, and yield indentation when there are too many paragraphs to fit.
    let text = 'Vous devez indiquer';
    while (textEm(text) < 72) text += ' la date de début';
    const doc = (n: number): DocDoc => ({
      version: 1,
      pages: [
        {
          ...page(
            Array.from({ length: n }, (_, i) => ({
              kind: 'paragraph' as const,
              text,
              box: { x: 200, y: 100 + i * 60, width: 800, height: 40 },
            })),
          ),
          height: 1414,
          paper: { width: 595, height: 842 },
          margins: { left: 56.7, right: 56.7, top: 56.7, bottom: 56.7 },
        },
      ],
    });
    const lefts = (n: number) =>
      [
        ...unzip(writeDocx(doc(n)))
          .text('word/document.xml')
          .matchAll(/<w:p>.*?<\/w:p>/g),
      ].map((m) => /<w:ind w:left="(\d+)"/.exec(m[0])?.[1] ?? '0');
    expect(new Set(lefts(5))).not.toContain('0');
    expect(new Set(lefts(20))).toEqual(new Set(['0']));
  });

  it('places each paragraph at its left edge and keeps the vertical gaps, as plain paragraphs (D-463)', () => {
    // Original image width of 1000 pixels = A4 width of 11906 twips; left page margin 1134 twips = 95 pixels, left indentation is calculated from there.
    const at = (x: number, y: number, width: number) => ({ x, y, width, height: 30 });
    const doc: DocDoc = {
      version: 1,
      pages: [
        page([
          { kind: 'paragraph', text: 'CENTRE', align: 'center', box: at(400, 100, 200) },
          { kind: 'paragraph', text: 'Docteur', box: at(200, 140, 300) },
          {
            kind: 'paragraph',
            text: 'Titre',
            heading: 2,
            size: 16,
            underline: true,
            box: at(300, 600, 400),
          },
          { kind: 'paragraph', text: 'Pantin le 11/05/2026', box: at(700, 640, 290) },
        ]),
      ],
    };
    const xml = unzip(writeDocx(doc)).text('word/document.xml');
    const paras = xml.match(/<w:p>.*?<\/w:p>/g)!;
    expect(paras).toHaveLength(4);
    // Centered paragraphs are not indented; the first paragraph taking less than a line from the page margin is not padded.
    expect(paras[0]).not.toMatch(/<w:ind |<w:spacing /);
    // 200 pixels on the left: indentation (200 - 95) pixels; top distance to top 40 pixels (476 twips) minus the height of the previous line in Word (11 pt × 1.28).
    expect(paras[1]).toContain('<w:spacing w:before="190"/><w:ind w:left="1250"/>');
    // Large blocks of whitespace are preserved; titles do not use heading style before/after spacing; underline.
    expect(paras[2]).toContain('<w:spacing w:before="5200" w:after="0"/>');
    expect(paras[2]).toContain('<w:u w:val="single"/>');
    // A line near the right: indentation yields its own width (leaving 10% extra), without wrapping to the next line.
    expect(paras[3]).toContain(`<w:ind w:left="${Math.round((9638 - 3453 * 1.1) / 10) * 10}"/>`);
    // No text boxes, no absolute positioning.
    expect(xml).not.toMatch(/<w:framePr|<wp:anchor|<w:txbxContent/);
  });

  it('shrinks the gaps so that a one-page original stays one page, but not on a page of prose (D-463)', () => {
    // 22 lines of text, larger in Word than in the original image (24 pt): the text itself fits on a page, but adding the original whitespace exceeds it.
    const lines = (n: number, size: number): DocPage['blocks'] =>
      Array.from({ length: n }, (_, i) => ({
        kind: 'paragraph' as const,
        text: `line ${i}`,
        size,
        box: { x: 100, y: 100 + i * 60, width: 300, height: 30 },
      }));
    const total = (blocks: DocPage['blocks'], size: number) => {
      const xml = unzip(writeDocx({ version: 1, pages: [page(blocks)] })).text('word/document.xml');
      const gaps = [...xml.matchAll(/w:before="(\d+)"/g)].reduce((n, m) => n + Number(m[1]), 0);
      return { gaps, height: gaps + blocks.length * 1.28 * size * 20 };
    };
    // A4 content area height is 16838 - 2 × 1134 = 14570 twips.
    expect(total(lines(22, 24), 24).height).toBeLessThanOrEqual(14570);
    // Text itself exceeds one page: whitespace is still preserved.
    expect(total(lines(30, 24), 24).gaps).toBeGreaterThan(0);
  });

  it('keeps the plain spacing for blocks without usable positions (text to Word)', () => {
    const dummy = { x: 0, y: 0, width: 1, height: 1 };
    const xml = unzip(
      writeDocx({
        version: 1,
        pages: [
          page([
            { kind: 'paragraph', text: 'one', box: dummy },
            { kind: 'paragraph', text: 'two', spaced: true, box: dummy },
          ]),
        ],
      }),
    ).text('word/document.xml');
    expect(xml.match(/<w:spacing w:before="160"\/>/g)).toHaveLength(1);
    expect(xml).not.toContain('<w:ind ');
  });

  it('writes a row of side-by-side blocks as a borderless layout table with nested content (D-331)', () => {
    const table = {
      kind: 'table' as const,
      colWidths: [200, 200],
      box,
      table: {
        kind: 'table' as const,
        rows: 1,
        col: 0,
        cols: 2,
        box,
        cells: [
          { row: 0, col: 0, rowSpan: 1, colSpan: 1, text: 'x' },
          { row: 0, col: 1, rowSpan: 1, colSpan: 1, text: 'y' },
        ],
      },
    };
    const doc: DocDoc = {
      version: 1,
      pages: [
        page([
          {
            kind: 'row',
            box,
            cells: [
              { width: 400, blocks: [{ kind: 'paragraph', text: 'left', box }] },
              { width: 350, blocks: [table] },
            ],
          },
        ]),
      ],
    };
    const xml = unzip(writeDocx(doc)).text('word/document.xml');
    const tables = xml.match(/<w:tbl>/g)!;
    expect(tables).toHaveLength(2);
    // Outer table: no borders, two columns converted based on original image width (1000 pixels = 11906 twips).
    expect(xml).toMatch(
      /<w:body><w:tbl><w:tblPr><w:tblW [^>]*><w:tblBorders><w:top w:val="nil"\/>/,
    );
    expect(xml).toContain('<w:gridCol w:w="4762"/><w:gridCol w:w="4167"/>');
    // Inner table has borders as usual, scaled down according to its cell width (minus left/right padding): 2381 -> 2004.
    expect(xml).toContain('<w:gridCol w:w="2004"/><w:gridCol w:w="2004"/>');
    expect(xml).toContain('<w:top w:val="single"');
    // Each cell ends with a paragraph (required by Word).
    for (const cell of xml.match(/<w:tc>(?:(?!<w:tc>)[^])*?<\/w:tc>/g)!)
      expect(cell).toMatch(/(<w:p\/>|<\/w:p>)<\/w:tc>$/);
    expect(xml).toContain('>left</w:t>');
  });

  it('writes form label and value pairs as a borderless two-column table, one pair per row (D-332)', () => {
    const xml = unzip(
      writeDocx({
        version: 1,
        pages: [
          page([{ kind: 'paragraph', text: 'A\t1\nBB\t2', tab: 300, box: { ...box, width: 500 } }]),
        ],
      }),
    ).text('word/document.xml');
    // Label column goes to the left of the value (300 pixels), value column occupies the right side of the content area (9638 - 3572).
    expect(xml).toContain('<w:gridCol w:w="3572"/><w:gridCol w:w="6066"/>');
    expect(xml).toContain('<w:tblBorders><w:top w:val="nil"/>');
    const rows = xml.match(/<w:tr>.*?<\/w:tr>/g)!;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatch(/>A<\/w:t>.*<\/w:tc><w:tc>.*>1<\/w:t>/);
    expect(rows[1]).toMatch(/>BB<\/w:t>.*<\/w:tc><w:tc>.*>2<\/w:t>/);
  });
});

describe('writeDocx runs (D-465)', () => {
  it('writes each run with its own bold, italic, underline and size over the paragraph style', () => {
    const doc: DocDoc = {
      version: 1,
      pages: [
        page([
          {
            kind: 'paragraph',
            text: 'Hello big world',
            bold: true,
            runs: [
              { text: 'Hello ' },
              { text: 'big', size: 16, italic: true, underline: true },
              { text: ' world', bold: false },
            ],
            box,
          },
        ]),
      ],
    };
    const xml = unzip(writeDocx(doc)).text('word/document.xml');
    const runs = [...xml.matchAll(/<w:r>(.*?)<\/w:r>/g)].map((m) => m[1]!);
    const of = (text: string) => runs.find((r) => r.includes(`>${text}</w:t>`))!;
    expect(of('Hello ')).toContain('<w:b/>');
    expect(of('Hello ')).not.toContain('<w:i/>');
    expect(of('big')).toContain('<w:b/>');
    expect(of('big')).toContain('<w:i/>');
    expect(of('big')).toContain('<w:u w:val="single"/>');
    expect(of('big')).toContain('<w:sz w:val="32"/>');
    expect(of(' world')).not.toContain('<w:b/>');
  });

  it('writes list item runs and keeps form label runs', () => {
    const doc: DocDoc = {
      version: 1,
      pages: [
        page([
          {
            kind: 'list',
            ordered: false,
            items: ['one', 'two'],
            itemRuns: [null, [{ text: 'two', italic: true }]],
            box,
          },
          {
            kind: 'paragraph',
            text: 'Nom\tDupont',
            tab: 200,
            runs: [{ text: 'Nom', bold: true }, { text: '\tDupont' }],
            box: { ...box, y: 300 },
          },
        ]),
      ],
    };
    const xml = unzip(writeDocx(doc)).text('word/document.xml');
    const runs = [...xml.matchAll(/<w:r>(.*?)<\/w:r>/g)].map((m) => m[1]!);
    const of = (text: string) => runs.find((r) => r.includes(`>${text}</w:t>`))!;
    expect(of('one')).not.toContain('<w:i/>');
    expect(of('two')).toContain('<w:i/>');
    expect(of('Nom')).toContain('<w:b/>');
    expect(of('Dupont')).not.toContain('<w:b/>');
  });
});

describe('left alignment snap (D-473)', () => {
  it('writes the same left indent for paragraphs whose left edges differ by a few pixels', () => {
    const para = (text: string, x: number, y: number) => ({
      kind: 'paragraph' as const,
      text,
      box: { x, y, width: 400, height: 20 },
    });
    const page: DocPage = {
      source: 's',
      width: 1000,
      height: 1400,
      bodySize: 11,
      blocks: [para('a', 187, 100), para('b', 195, 140), para('c', 184, 180)],
    };
    const xml = strFromU8(
      unzipSync(writeDocx({ version: 1, pages: [page] }))['word/document.xml']!,
    );
    const lefts = [...xml.matchAll(/<w:ind w:left="(\d+)"/g)].map((m) => m[1]);
    expect(new Set(lefts).size).toBeLessThanOrEqual(1);
  });
});

describe('OOXML element order', () => {
  // ECMA-376 Part 1 order (listing only used types): Word reads according to schema order, and incorrect order may cause "Unreadable Content" errors or lost attributes.
  const ORDER: Record<string, string[]> = {
    pPr: [
      'pStyle',
      'keepNext',
      'keepLines',
      'pageBreakBefore',
      'framePr',
      'widowControl',
      'numPr',
      'suppressLineNumbers',
      'pBdr',
      'shd',
      'tabs',
      'suppressAutoHyphens',
      'kinsoku',
      'wordWrap',
      'overflowPunct',
      'topLinePunct',
      'autoSpaceDE',
      'autoSpaceDN',
      'bidi',
      'adjustRightInd',
      'snapToGrid',
      'spacing',
      'ind',
      'contextualSpacing',
      'mirrorIndents',
      'suppressOverlap',
      'jc',
      'textDirection',
      'textAlignment',
      'textboxTightWrap',
      'outlineLvl',
      'divId',
      'cnfStyle',
      'rPr',
      'sectPr',
      'pPrChange',
    ],
    rPr: [
      'rStyle',
      'rFonts',
      'b',
      'bCs',
      'i',
      'iCs',
      'caps',
      'smallCaps',
      'strike',
      'dstrike',
      'outline',
      'shadow',
      'emboss',
      'imprint',
      'noProof',
      'snapToGrid',
      'vanish',
      'webHidden',
      'color',
      'spacing',
      'w',
      'kern',
      'position',
      'sz',
      'szCs',
      'highlight',
      'u',
      'effect',
      'bdr',
      'shd',
      'fitText',
      'vertAlign',
      'rtl',
      'cs',
      'em',
      'lang',
      'eastAsianLayout',
      'specVanish',
      'oMath',
    ],
    tcPr: [
      'cnfStyle',
      'tcW',
      'gridSpan',
      'hMerge',
      'vMerge',
      'tcBorders',
      'shd',
      'noWrap',
      'tcMar',
      'textDirection',
      'tcFitText',
      'vAlign',
      'hideMark',
    ],
    tblPr: [
      'tblStyle',
      'tblpPr',
      'tblOverlap',
      'bidiVisual',
      'tblStyleRowBandSize',
      'tblStyleColBandSize',
      'tblW',
      'jc',
      'tblCellSpacing',
      'tblInd',
      'tblBorders',
      'shd',
      'tblLayout',
      'tblCellMar',
      'tblLook',
    ],
  };
  /** Direct child elements of each w:pPr / w:rPr / w:tcPr / w:tblPr, in order of appearance. */
  const childLists = (xml: string) => {
    const out: { parent: string; children: string[] }[] = [];
    const stack: { name: string; children: string[] }[] = [];
    for (const m of xml.matchAll(/<(\/?)w:([A-Za-z]+)[^>]*?(\/?)>/g)) {
      const [, close, name, self] = m;
      if (close) {
        const top = stack.pop()!;
        if (ORDER[top.name]) out.push({ parent: top.name, children: top.children });
        continue;
      }
      stack.at(-1)?.children.push(name!);
      if (!self) stack.push({ name: name!, children: [] });
    }
    return out;
  };
  const misordered = (xml: string) =>
    childLists(xml).flatMap(({ parent, children }) => {
      const order = ORDER[parent]!;
      const at = children.map((c) => order.indexOf(c));
      return at.some((v) => v < 0) || at.some((v, i) => i > 0 && v <= at[i - 1]!)
        ? [`${parent}: ${children.join(',')}`]
        : [];
    });

  it('writes every property element in schema order, on legacy and physical-paper pages', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const images = new Map([
      ['figure', { bytes: png, width: 300, height: 150 }],
      ['decoration', { bytes: png, width: 1000, height: 1400 }],
    ]);
    const cellBox = (x: number, y: number, width: number, height: number) => ({
      x,
      y,
      width,
      height,
    });
    const table: DocTable = {
      kind: 'table',
      box: cellBox(100, 500, 800, 120),
      colWidths: [300, 300, 200],
      table: {
        kind: 'table',
        box: cellBox(100, 500, 800, 120),
        col: 0,
        rows: 2,
        cols: 3,
        cells: [
          {
            row: 0,
            col: 0,
            rowSpan: 1,
            colSpan: 2,
            text: 'Header\tvalue',
            box: cellBox(100, 500, 600, 60),
          },
          {
            row: 0,
            col: 2,
            rowSpan: 2,
            colSpan: 1,
            text: 'Side',
            box: cellBox(700, 500, 200, 120),
          },
          { row: 1, col: 0, rowSpan: 1, colSpan: 1, text: 'a', box: cellBox(100, 560, 300, 60) },
          { row: 1, col: 1, rowSpan: 1, colSpan: 1, text: 'b', box: cellBox(400, 560, 300, 60) },
        ],
      },
      cellLayout: [
        {
          row: 0,
          col: 0,
          fill: 'FFCC00',
          lines: [{ ...cellBox(110, 510, 200, 20), fill: 'FFCC00', color: 'FF0000', tabs: [400] }],
        },
        { row: 0, col: 2, fill: 'CCCCCC', lines: [cellBox(710, 510, 50, 20)] },
      ],
    };
    const blocks: DocPage['blocks'] = [
      { kind: 'image', background: true, src: 'decoration', box: cellBox(0, 0, 1000, 1400) },
      {
        kind: 'paragraph',
        text: 'Heading',
        heading: 1,
        align: 'center',
        box: cellBox(300, 60, 400, 40),
      },
      {
        kind: 'paragraph',
        text: 'Banded body',
        fill: 'DDEEFF',
        color: '336699',
        bold: true,
        italic: true,
        underline: true,
        align: 'right',
        box: cellBox(200, 120, 600, 20),
      },
      { kind: 'list', ordered: true, items: ['one', 'two'], box: cellBox(150, 160, 400, 40) },
      { kind: 'image', src: 'figure', box: cellBox(400, 220, 300, 150) },
      { kind: 'space', box: cellBox(100, 380, 400, 30) },
      table,
      {
        kind: 'row',
        box: cellBox(100, 700, 800, 60),
        cells: [
          {
            width: 400,
            blocks: [{ kind: 'paragraph', text: 'Left', box: cellBox(100, 700, 300, 20) }],
          },
          {
            width: 400,
            blocks: [{ kind: 'paragraph', text: 'Right', box: cellBox(500, 700, 300, 20) }],
          },
        ],
      },
    ];
    const paper = { width: 595.3, height: 841.9 };
    for (const doc of [
      {
        version: 5 as const,
        pages: [
          { ...page(blocks), paper },
          { ...page(blocks), paper },
        ],
      },
      { version: 1 as const, pages: [page(blocks), page(blocks)] },
    ]) {
      const zip = unzip(writeDocx(doc, images));
      for (const part of ['word/document.xml', 'word/styles.xml', 'word/numbering.xml'])
        expect(misordered(zip.text(part)), part).toEqual([]);
    }
  });
});
