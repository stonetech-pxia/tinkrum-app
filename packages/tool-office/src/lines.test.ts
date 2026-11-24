import { describe, expect, it } from 'vitest';

import { findLines, findTables } from './lines';
import { glyphs, gridRects, renderPage, type Rect } from './test-helpers';

const W = 1000;
const H = 1400;
const grey = (rects: readonly Rect[], shade: number) => rects.map((r) => ({ ...r, shade }));

describe('light rules (Word)', () => {
  // Light gray lines of digital templates (EU samples 001, 006): the darkest channel is about 0.8, while the Sauvola threshold on white paper is only 0.7.
  const lightGrid = grey(gridRects([100, 400, 900], [300, 360, 420, 480]), 205);

  it('finds a light grey grid only when asked for light rules', () => {
    const image = renderPage(W, H, [...lightGrid, ...glyphs(120, 320, 200)]);
    expect(findTables(findLines(image, { skew: 0 }))).toHaveLength(0);
    const tables = findTables(findLines(image, { skew: 0, light: true }));
    expect(tables).toHaveLength(1);
    expect(tables[0]!.hs).toHaveLength(4);
    expect(tables[0]!.vs).toHaveLength(3);
  });

  it('does not take light shading for lines, even with text on it', () => {
    const shading: Rect[] = [
      { x: 100, y: 200, width: 800, height: 120, shade: 215 },
      { x: 100, y: 600, width: 800, height: 6, shade: 215 },
      { x: 100, y: 700, width: 800, height: 40, shade: 225 },
    ];
    const text = [...glyphs(120, 230, 600), ...glyphs(120, 262, 600), ...glyphs(120, 712, 600)];
    const found = findLines(renderPage(W, H, [...shading, ...text]), { skew: 0, light: true });
    // Only the 6-pixel high segment flanked by white paper is considered a line.
    expect(found.horizontal.map((h) => Math.round(h.pos))).toEqual([603]);
    expect(found.vertical).toHaveLength(0);
  });

  it('ignores light rules on paper that is not white (photos)', () => {
    const paper: Rect = { x: 0, y: 0, width: W, height: H, shade: 200 };
    const image = renderPage(W, H, [...lightGrid.map((r) => ({ ...r, shade: 160 })), paper]);
    expect(findTables(findLines(image, { skew: 0, light: true }))).toHaveLength(0);
  });
});

describe('highlights touching a rule', () => {
  it('keeps a row rule with a highlighted word right under or over it (EU sample 067)', () => {
    // Bank statements: amounts and payees are highlighted with green fluorescent highlighter, with
    // color blocks abutting the line (above or below); when two blocks touch vertically within a
    // row, connect them from the top line to the bottom line of the row.
    const ys = [300, 360, 420, 480, 540];
    const rules = gridRects([100, 300, 760, 900], ys, { thickness: 2 });
    const marks: Rect[] = [
      { x: 790, y: 362, width: 90, height: 28, color: [0, 200, 0] },
      { x: 320, y: 422, width: 110, height: 27, color: [0, 200, 0] },
      { x: 320, y: 450, width: 110, height: 30, color: [0, 200, 0] },
      { x: 780, y: 482, width: 100, height: 30, color: [0, 200, 0] },
    ];
    const tables = findTables(findLines(renderPage(W, H, [...rules, ...marks]), { skew: 0 }));
    expect(tables).toHaveLength(1);
    expect(tables[0]!.hs.map((h) => Math.round(h.pos / 10) * 10)).toEqual(ys);
  });
});

describe('number badges on box corners', () => {
  it('does not cut a rule out of a box whose corner badge sits on its end (EU sample 068)', () => {
    // Accident report number box (cyan solid, 24 pixels square) attached to the top-left corner of the box: merges with the top edge and is not treated as a standalone line, as usual.
    const top: Rect = { x: 100, y: 300, width: 400, height: 2 };
    const badge: Rect = { x: 100, y: 300, width: 26, height: 26, color: [0, 170, 230] };
    const found = findLines(renderPage(W, H, [top, badge]), { skew: 0 });
    expect(found.horizontal.filter((h) => Math.abs(h.pos - 301) < 4)).toHaveLength(0);
  });
});

describe('colour-filled cells', () => {
  it('finds the rules around a yellow cell spanning all rows (EU sample 057)', () => {
    // Electricity bill price list: a yellow background cell on the left (#FFCB35, very dark darkest channel) spans three rows, surrounded by dark gray lines.
    const rules = gridRects([100, 330, 650, 900], [300, 360, 420, 480], {
      thickness: 3,
      skipH: [
        [1, 0],
        [2, 0],
      ],
    }).map((r) => ({ ...r, shade: 58 }));
    const fill: Rect = { x: 103, y: 303, width: 227, height: 177, color: [255, 203, 53] };
    const tables = findTables(findLines(renderPage(W, H, [...rules, fill]), { light: true }));
    expect(tables).toHaveLength(1);
    expect(tables[0]!.hs).toHaveLength(4);
    expect(tables[0]!.vs).toHaveLength(4);
  });
});

describe('pale coloured rules', () => {
  it('still finds rules in a pale blue that is bright but not a saturated fill (EU sample 040)', () => {
    // Light blue grid lines printed on old invoice paper: brightness 0.76, low saturation, still counted as lines based on the darkest channel; only bright and saturated yellow backgrounds are evaluated by brightness.
    const rules = gridRects([100, 400, 900], [300, 360, 420, 480]).map((r) => ({
      ...r,
      color: [170, 200, 235] as const,
    }));
    const tables = findTables(findLines(renderPage(W, H, rules), { skew: 0 }));
    expect(tables).toHaveLength(1);
    expect(tables[0]!.hs).toHaveLength(4);
  });
});

describe('boxes stacked a few pixels apart', () => {
  it('does not join an invoice item table with the tables a few pixels under it (EU sample 054)', () => {
    // A narrow white gap beneath the product table: a tax table on the left and a total box on the
    // right, each with its own box, whose left and right edges share vertical coordinates with the
    // product table's column lines.
    const items = gridRects([60, 560, 700, 820, 940], [300, 340, 380, 420]);
    const tax = gridRects([60, 260, 400], [428, 458, 488]);
    const totals = gridRects([700, 820, 940], [428, 458, 488, 518]);
    const tables = findTables(
      findLines(renderPage(W, H, [...items, ...tax, ...totals]), { skew: 0 }),
    );
    expect(tables.map((t) => [t.hs.length, t.vs.length])).toEqual([
      [4, 5],
      [3, 3],
      [4, 3],
    ]);
  });
});

describe('findTables: rules above a grid', () => {
  it('does not chain section underlines far above a grid into it', () => {
    // Meeting minutes: a horizontal line under each section title, separated from each other by full paragraphs of text; a grid appears beneath the final section.
    const underlines: Rect[] = [100, 340, 580].map((y) => ({ x: 100, y, width: 802, height: 2 }));
    const image = renderPage(W, H, [
      ...underlines,
      ...gridRects([100, 500, 900], [600, 640, 680, 720]),
    ]);
    // The three separator lines form a sequence on their own (consisting only of horizontal lines without column distinctions, which would be lost during table grouping); the grid starts from 600 and does not connect upward.
    const grid = findTables(findLines(image, { skew: 0 })).find((t) => t.vs.length > 0)!;
    expect(Math.abs(grid.box.y - 600)).toBeLessThan(4);
    expect(grid.hs).toHaveLength(4);
  });

  it('still chains header rules spaced like the grid rows', () => {
    // Several horizontal lines above the header match the height of the grid rows (IRS Schedule D header), belonging to the same table.
    const rules: Rect[] = [480, 520, 560].map((y) => ({ x: 100, y, width: 802, height: 2 }));
    const image = renderPage(W, H, [...rules, ...gridRects([100, 500, 900], [600, 640, 680, 720])]);
    const tables = findTables(findLines(image, { skew: 0 }));
    expect(tables).toHaveLength(1);
    expect(Math.abs(tables[0]!.box.y - 480)).toBeLessThan(4);
  });

  it('does not chain fill-in rules across a grid between them', () => {
    // A column of fill lines on the right side of the invoice: three on top, separated by the entire product section, and three on the bottom (EU sample 001), forming two separate vertical groups rather than a single tall table.
    const fills: Rect[] = [100, 160, 220, 600, 660, 720].map((y) => ({
      x: 700,
      y,
      width: 202,
      height: 2,
    }));
    const image = renderPage(W, H, [
      ...fills,
      ...gridRects([100, 400, 700, 900], [300, 360, 420, 480, 540]),
    ]);
    const tables = findTables(findLines(image, { skew: 0 }));
    for (const t of tables.filter((x) => !x.vs.length)) {
      expect(t.box.y + t.box.height < 300 || t.box.y > 540).toBe(true);
    }
  });
});

describe('findTables: stacked tables in one frame (Word)', () => {
  // Registration form (EU sample 004): two tables stacked vertically within a single outer box with differing column lines, where the numbering column lines are connected vertically.
  const rects = [
    ...gridRects([100, 160, 500, 900], [100, 140, 180, 220]),
    ...gridRects([100, 160, 300, 650, 900], [220, 260, 300, 340]),
  ];

  it('splits where the column lines change', () => {
    const page = findLines(renderPage(W, H, rects), { skew: 0 });
    expect(findTables(page)).toHaveLength(1);
    const parts = findTables(page, { splitStacked: true });
    expect(parts).toHaveLength(2);
    expect(parts.map((t) => [t.hs.length, t.vs.length])).toEqual([
      [4, 4],
      [4, 5],
    ]);
  });

  it('does not split a table under a title row that spans all columns', () => {
    const titled = [
      ...gridRects([100, 900], [60, 100]),
      ...gridRects([100, 300, 650, 900], [100, 140, 180, 220]),
    ];
    const page = findLines(renderPage(W, H, titled), { skew: 0 });
    expect(findTables(page, { splitStacked: true })).toHaveLength(1);
  });

  it('splits two tables side by side under a shared header band (EU sample 090)', () => {
    // Lab test request form: a full-page width header and the "Dati paziente" row at the top,
    // followed below by two side-by-side tables separated by a 30-pixel white gap, whose horizontal
    // lines terminate at the gap edges and whose rows do not align.
    const sideBySide = [
      ...gridRects([50, 950], [60, 120, 150]),
      ...gridRects([50, 100, 300, 420, 480], [150, 180, 210, 240, 270, 300, 330]),
      ...gridRects([510, 700, 820, 950], [150, 185, 220, 255, 290]),
    ];
    const page = findLines(renderPage(W, H, sideBySide), { skew: 0 });
    expect(findTables(page)).toHaveLength(1);
    const parts = findTables(page, { splitStacked: true });
    expect(
      parts.map((t) => [
        Math.round(t.box.x / 10) * 10,
        Math.round(t.box.y / 10) * 10,
        t.hs.length,
        t.vs.length,
      ]),
    ).toEqual([
      [50, 60, 3, 2],
      [50, 150, 7, 5],
      [510, 150, 5, 4],
    ]);
  });

  it('does not split a table whose rows have a gap only in one column', () => {
    // Table body horizontal lines are interrupted in the middle column (which is a merged large cell), while the left and right vertical lines remain connected: a single table.
    const gapped = [
      ...gridRects([50, 950], [60, 150]),
      ...gridRects([50, 480], [150, 180, 210, 240, 270]),
      ...gridRects([510, 950], [150, 180, 210, 240, 270]),
      { x: 480, y: 150, width: 32, height: 2 },
      { x: 480, y: 270, width: 32, height: 2 },
    ];
    const page = findLines(renderPage(W, H, gapped), { skew: 0 });
    expect(findTables(page, { splitStacked: true })).toHaveLength(1);
  });
});

describe('findTables: rules-only chains', () => {
  it('does not chain the bottom rules of stacked form frames into one table (EU sample 014)', () => {
    // Three section form boxes: the title interrupts the top line, preventing the box from forming a grid; three full-page-width bottom lines are separated by a full section each (each less than 40% of the page height).
    const bottoms: Rect[] = [300, 800, 1300].map((y) => ({ x: 60, y, width: 882, height: 2 }));
    const tables = findTables(findLines(renderPage(W, H, bottoms), { skew: 0 }));
    expect(tables).toHaveLength(0);
  });

  it('still takes a three-line table with a short header and a tall body', () => {
    // Three-line table: the top line and header line are separated by one row, and the table body is very tall.
    const rules: Rect[] = [300, 340, 900].map((y) => ({ x: 60, y, width: 882, height: 2 }));
    const tables = findTables(findLines(renderPage(W, H, rules), { skew: 0 }));
    expect(tables).toHaveLength(1);
    expect(tables[0]!.hs).toHaveLength(3);
  });

  it('does not chain evenly spaced answer lines across a large gap (EU sample 041)', () => {
    // Two groups of fill lines, 5 lines per group with a 60 spacing, separated by 240 in the middle (for titles and whitespace); another line follows a large gap further down.
    const ys = [200, 260, 320, 380, 440, 680, 740, 800, 860, 920, 1300];
    const rules: Rect[] = ys.map((y) => ({ x: 60, y, width: 882, height: 2 }));
    const tables = findTables(findLines(renderPage(W, H, rules), { skew: 0 }));
    expect(tables.map((t) => t.hs.length)).toEqual([5, 5]);
    expect(tables[1]!.box.y).toBeGreaterThan(600);
  });

  it('still chains evenly spaced header rules across a tall table body (EU sample 048)', () => {
    // Header row with four text blocks, followed by a row of subheadings, and further down by a tall table body and totals.
    const ys = [200, 240, 280, 560, 600];
    const rules: Rect[] = ys.map((y) => ({ x: 60, y, width: 882, height: 2 }));
    const text = [
      { x: 150, y: 210, width: 80, height: 20 },
      { x: 600, y: 210, width: 80, height: 20 },
      { x: 720, y: 210, width: 60, height: 20 },
      { x: 840, y: 210, width: 60, height: 20 },
      { x: 70, y: 250, width: 300, height: 20 },
    ];
    const tables = findTables(findLines(renderPage(W, H, rules), { skew: 0 }), { text });
    expect(tables.map((t) => t.hs.length)).toEqual([5]);
  });

  it('ends a three-line table at its bottom rule when a header pair follows a gap (EU sample 050)', () => {
    // Hotel bill: a three-line table (top line, header line, bottom line), followed below by a few total rows, and then two lines for the tax column (header line and bottom line).
    const ys = [200, 236, 560, 760, 790];
    const rules: Rect[] = ys.map((y) => ({ x: 60, y, width: 882, height: 2 }));
    const tables = findTables(findLines(renderPage(W, H, rules), { skew: 0 }));
    expect(tables.map((t) => t.hs.length)).toEqual([3]);
    expect(tables[0]!.box.y + tables[0]!.box.height).toBeLessThan(600);
  });

  it('does not chain underscore blanks inside sentences into a table (EU sample 095)', () => {
    // Contract template: fill-in lines like `(DNI/NIE ______),` lie on top of the text baseline, with the ends of several lines coincidentally aligned vertically.
    const ys = [300, 390, 900];
    const rules: Rect[] = ys.map((y) => ({ x: 700, y, width: 180, height: 2 }));
    const text = ys.flatMap((y) => [
      { x: 590, y: y - 20, width: 104, height: 24 },
      { x: 884, y: y - 20, width: 20, height: 24 },
    ]);
    const page = findLines(renderPage(W, H, rules), { skew: 0 });
    expect(findTables(page)).toHaveLength(1);
    expect(findTables(page, { text })).toHaveLength(0);
  });

  it('still chains a ruled table with uneven rows', () => {
    // One horizontal line per row, with varying row heights (some cells wrap into multiple lines): still treated as a single table.
    const ys = [200, 240, 280, 420, 460, 640, 680];
    const rules: Rect[] = ys.map((y) => ({ x: 60, y, width: 882, height: 2 }));
    const tables = findTables(findLines(renderPage(W, H, rules), { skew: 0 }));
    expect(tables).toHaveLength(1);
    expect(tables[0]!.hs).toHaveLength(7);
  });

  it('starts a rules-only table at the dark header bar on top of it, with its column rule (EU sample 024)', () => {
    // Timetable: a dark header bar (white text) placed directly above the first row with no horizontal line between them; below are only horizontal lines, with a vertical line to the right of the time column, and no outer border.
    const letters = glyphs(160, 310, 200).map((r) => ({ ...r, shade: 255 }));
    const bar: Rect = { x: 100, y: 300, width: 400, height: 36, shade: 60 };
    const rules: Rect[] = [368, 400, 432, 464, 496].map((y) => ({
      x: 100,
      y,
      width: 400,
      height: 2,
    }));
    const column: Rect = { x: 150, y: 336, width: 2, height: 162 };
    const image = renderPage(W, H, [...letters, bar, ...rules, column, ...glyphs(110, 344, 20)]);
    const tables = findTables(findLines(image, { skew: 0 }));
    expect(tables).toHaveLength(1);
    expect(Math.abs(tables[0]!.box.y - 300)).toBeLessThan(4);
    expect(tables[0]!.hs.some((h) => Math.abs(h.pos - 336) < 4)).toBe(true);
    expect(tables[0]!.vs.some((v) => Math.abs(v.pos - 151) < 4 && v.to > 490)).toBe(true);
  });
});

describe('filled boxes are not tables', () => {
  it('does not read a solid shaded blank in a sentence as a one-cell table (EU sample 082)', () => {
    // Fillable areas in contracts: a 72x25 solid cyan background block where all four edges are "lines", forming a 1x1 table.
    const box = {
      x: 400,
      y: 300,
      width: 72,
      height: 25,
      color: [0, 139, 139] as [number, number, number],
    };
    const page = findLines(renderPage(W, H, [box, ...glyphs(100, 304, 280, 18)]), {
      skew: 0,
      light: true,
    });
    expect(findTables(page)).toHaveLength(0);
  });
});

describe('skew next to a solid colour band', () => {
  it('measures the tilt of a scan whose top is a wide dark band, so its ruled table is found', () => {
    // The header of a scanned document (rotated 0.6°) is a dark blue block spanning the full page
    // width: dark points consist mostly of color blocks. Sampling every few pixels in scanning
    // order, the points sampled within the color block form a slanted grid whose projection is
    // cleanest at about 7°, leading to an estimated tilt error of -7°, which disrupts the lined
    // table below.
    const band: Rect = { x: 0, y: 0, width: 1413, height: 420, color: [34, 96, 154] };
    const xs = [170, 240, 440, 1290];
    const ys = Array.from({ length: 10 }, (_, i) => 560 + i * 56);
    const text = ys
      .slice(0, -1)
      .flatMap((y) => xs.slice(0, -1).map((x) => glyphs(x + 12, y + 18, 50)));
    const image = renderPage(1413, 2000, [band, ...gridRects(xs, ys), ...text.flat()], 0.6);
    const found = findLines(image);
    expect(Math.abs(Math.abs(found.skew) - 0.6)).toBeLessThan(0.2);
    const tables = findTables(found);
    expect(tables.some((t) => t.hs.length === 10 && t.vs.length === 4)).toBe(true);
  });
});

describe('page edges are not table rules', () => {
  it('keeps a ruled table apart from the fold of a photographed two-page leaflet (EU sample 100)', () => {
    // Two-page spread instruction manual: the gutter is a black line running from the top to the bottom of the page, and the left ends of the right page's table horizontal lines are only 4 pixels away from it.
    const fold: Rect = { x: 478, y: 5, width: 3, height: 1390 };
    const grid = gridRects([485, 600, 760, 900], [1000, 1050, 1100, 1150, 1200]);
    const tables = findTables(findLines(renderPage(W, H, [fold, ...grid]), { skew: 0 }));
    expect(tables).toHaveLength(1);
    expect(tables[0]!.box.y).toBeGreaterThan(990);
    expect(tables[0]!.box.height).toBeLessThan(220);
    expect(tables[0]!.vs).toHaveLength(4);
  });
});
