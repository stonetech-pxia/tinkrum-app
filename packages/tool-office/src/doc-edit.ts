import {
  leafBlocks,
  type DocBlock,
  type DocDoc,
  type DocImage,
  type DocLeaf,
  type DocTable,
} from './doc';
import type { Box, TableBlock, TableDoc } from './types';

// Word conversion editing (D-328): DocDoc is modified immutably, returning a new instance each time
// (undo/redo uses edit.ts History). Modify paragraph text; lists have one item per line; tables are
// delegated to the Excel-conversion editing page (replaced with a TableDoc containing only this
// table, then swapped back upon completion); any block can be deleted. Blocks inside side-by-side
// layouts (D-331) are specified using cell and item, edited just like other blocks; entire rows
// cannot be edited directly, and if all cells are empty, the row is deleted.

export interface DocRef {
  page: number;
  block: number;
  /** Cell index and item index within a side-by-side layout (D-331); refers to the entire block when omitted. */
  cell?: number;
  item?: number;
}

const inRow = (at: DocRef) => at.cell !== undefined && at.item !== undefined;

/** Target block: a block within a page, or a block inside a side-by-side layout cell. */
export function blockAt(doc: DocDoc, at: DocRef): DocBlock | undefined {
  const block = doc.pages[at.page]?.blocks[at.block];
  if (!inRow(at)) return block;
  return block?.kind === 'row' ? block.cells[at.cell!]?.blocks[at.item!] : undefined;
}

function replaceBlock(doc: DocDoc, at: DocRef, next: DocBlock | null): DocDoc {
  const page = doc.pages[at.page]!;
  const row = page.blocks[at.block];
  let value: DocBlock | null = next;
  if (inRow(at) && row?.kind === 'row') {
    const cells = row.cells.map((cell, c) =>
      c !== at.cell
        ? cell
        : {
            ...cell,
            blocks:
              next === null
                ? cell.blocks.filter((_, i) => i !== at.item)
                : cell.blocks.map((b, i) => (i === at.item ? (next as DocLeaf) : b)),
          },
    );
    value = cells.some((c) => c.blocks.length) ? { ...row, cells } : null;
  }
  return {
    ...doc,
    pages: doc.pages.map((pg, p) =>
      p !== at.page
        ? pg
        : {
            ...pg,
            blocks:
              value === null
                ? pg.blocks.filter((_, b) => b !== at.block)
                : pg.blocks.map((block, b) => (b === at.block ? value : block)),
          },
    ),
  };
}

/** Text of a block in the editor: paragraphs return their text, lists return one item per line; tables and images have none. */
export function blockText(block: DocBlock): string | null {
  if (block.kind === 'paragraph') return block.text;
  if (block.kind === 'list') return block.items.join('\n');
  return null;
}

/** Modify the text of a paragraph or list (lists are split into items by line, empty lines removed; empty text deletes the block). Returns original doc when unchanged. */
export function setBlockText(doc: DocDoc, at: DocRef, text: string): DocDoc {
  const block = blockAt(doc, at);
  if (!block || blockText(block) === text) return doc;
  if (block.kind === 'paragraph') {
    // Text of the entire paragraph changed: character-based styles (D-465) no longer match and are discarded.
    const { runs: _runs, ...rest } = block;
    return replaceBlock(doc, at, text.trim() ? { ...rest, text } : null);
  }
  if (block.kind === 'list') {
    const items = text
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const { itemRuns: _runs, ...rest } = block;
    return replaceBlock(doc, at, items.length ? { ...rest, items } : null);
  }
  return doc;
}

/** Extra margin (in original image pixels) left around text bounding boxes when cropping original images: signature and stamp strokes are often larger than the recognized text bounding box. */
export function originalBox(box: Box, page: { width: number; height: number }): Box {
  const pad = Math.max(8, Math.round(box.height * 0.25));
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  return {
    x,
    y,
    width: Math.min(page.width - x, box.width + 2 * pad),
    height: Math.min(page.height - y, box.height + 2 * pad),
  };
}

const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

const union = (a: Box, b: Box): Box => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
};

const sameBox = (a: Box, b: Box) =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/**
 * Range to crop for 'Use original image' (D-467, D-468): union of bounding boxes of these text
 * blocks with extra padding around; if an image block is encountered (previously replaced with
 * original image, or cropped seal), include it as well to crop into a single image: when a
 * signature is recognized across multiple text lines, successive replacements yield a single
 * image (2026-11-06 Samsung physical device: signature split into multiple parts).
 */
export function originalArea(doc: DocDoc, page: number, boxes: readonly Box[]): Box | null {
  const pg = doc.pages[page];
  if (!pg || !boxes.length) return null;
  let area = boxes.map((b) => originalBox(b, pg)).reduce(union);
  const images = leafBlocks(pg).filter((b) => b.kind === 'image' && !b.background);
  for (let grew = true; grew;) {
    grew = false;
    for (const image of images) {
      const next = overlaps(image.box, area) ? union(area, image.box) : area;
      if (!sameBox(next, area)) {
        area = next;
        grew = true;
      }
    }
  }
  return area;
}

/**
 * Replace paragraphs and list blocks whose bounding boxes are boxes on this page, along with any
 * image blocks overlapping image.box, with a single cropped original image (placed at the
 * position of the first block among them). Returns original doc if none found.
 */
export function swapToOriginal(
  doc: DocDoc,
  page: number,
  boxes: readonly Box[],
  image: { src: string; box: Box },
): DocDoc {
  const pg = doc.pages[page];
  if (!pg) return doc;
  const picture: DocImage = { kind: 'image', box: image.box, src: image.src };
  let placed = false;
  const goes = (leaf: DocLeaf) =>
    ((leaf.kind === 'paragraph' || leaf.kind === 'list') &&
      boxes.some((b) => sameBox(b, leaf.box))) ||
    (leaf.kind === 'image' && !leaf.background && overlaps(leaf.box, image.box));
  const keep = (leaves: readonly DocLeaf[]): DocLeaf[] =>
    leaves.flatMap((leaf) => {
      if (!goes(leaf)) return [leaf];
      if (placed) return [];
      placed = true;
      return [picture];
    });
  const blocks: DocBlock[] = pg.blocks.flatMap((block): DocBlock[] => {
    if (block.kind !== 'row') return keep([block]);
    const cells = block.cells.map((cell) => ({ ...cell, blocks: keep(cell.blocks) }));
    return cells.some((c) => c.blocks.length) ? [{ ...block, cells }] : [];
  });
  if (!placed) return doc;
  return { ...doc, pages: doc.pages.map((p, i) => (i === page ? { ...p, blocks } : p)) };
}

export function deleteBlock(doc: DocDoc, at: DocRef): DocDoc {
  if (!blockAt(doc, at)) return doc;
  return replaceBlock(doc, at, null);
}

/** Convert a table block into a TableDoc (single page, containing only this table) openable by the Excel-conversion editing page. */
export function tableDocOf(doc: DocDoc, at: DocRef, name: string): TableDoc | null {
  const page = doc.pages[at.page];
  const block = blockAt(doc, at);
  if (!page || block?.kind !== 'table') return null;
  return {
    version: 3,
    scope: 'tables',
    pages: [
      {
        name,
        source: page.source,
        width: page.width,
        height: page.height,
        lineHeight: Math.round(page.height / 60),
        colWidths: block.colWidths,
        blocks: [block.table],
      },
    ],
  };
}

/** Convert a TableDoc edited in the editing page back into a table block; delete the block if the table is completely emptied. */
export function setTableFrom(doc: DocDoc, at: DocRef, edited: TableDoc): DocDoc {
  const block = blockAt(doc, at);
  const page = edited.pages[0];
  if (block?.kind !== 'table' || !page) return doc;
  const table = page.blocks.find((b): b is TableBlock => b.kind === 'table');
  if (!table) return replaceBlock(doc, at, null);
  const next: DocTable = {
    ...block,
    table: { ...table, col: 0 },
    colWidths: page.colWidths.slice(table.col, table.col + table.cols),
  };
  const geometry = (t: TableBlock) =>
    JSON.stringify([
      t.rows,
      t.cols,
      t.cells.map((c) => [c.row, c.col, c.rowSpan, c.colSpan, c.box]),
    ]);
  if (
    geometry(block.table) !== geometry(table) ||
    JSON.stringify(block.colWidths) !== JSON.stringify(next.colWidths)
  )
    delete next.cellLayout;
  return replaceBlock(doc, at, next);
}

/**
 * Directly edit a table within a document (file-room R2, D-366): replace the table block with a
 * TableDoc containing only this table, delegate to Excel-conversion editing functions (edit
 * cells, insert/delete rows/cols, edit.ts), and swap back; avoids popping up a separate
 * single-table editing page. Returns original doc when unchanged.
 */
export function editDocTable(doc: DocDoc, at: DocRef, fn: (table: TableDoc) => TableDoc): DocDoc {
  const before = tableDocOf(doc, at, '');
  if (!before) return doc;
  const after = fn(before);
  return after === before ? doc : setTableFrom(doc, at, after);
}

/** Validate general structure of DocDoc JSON upon reading (files are self-written, guards against corrupted files only). */
export function parseDocDoc(json: string): DocDoc | null {
  try {
    const doc = JSON.parse(json) as DocDoc;
    if (
      (doc?.version !== 1 &&
        doc?.version !== 2 &&
        doc?.version !== 3 &&
        doc?.version !== 4 &&
        doc?.version !== 5) ||
      !Array.isArray(doc.pages)
    )
      return null;
    if (!doc.pages.every((p) => Array.isArray(p?.blocks))) return null;
    if (
      !doc.pages.every((p) =>
        leafBlocks(p).every((b) => {
          if (
            (b.kind === 'paragraph' || b.kind === 'list') &&
            b.fill !== undefined &&
            !/^[0-9A-F]{6}$/i.test(b.fill)
          )
            return false;
          if (b.kind !== 'table' || b.cellLayout === undefined) return true;
          return (
            Array.isArray(b.cellLayout) &&
            b.cellLayout.every(
              (c) =>
                Number.isInteger(c.row) &&
                c.row >= 0 &&
                c.row < b.table.rows &&
                Number.isInteger(c.col) &&
                c.col >= 0 &&
                c.col < b.table.cols &&
                (c.fill === undefined || /^[0-9A-F]{6}$/i.test(c.fill)) &&
                Array.isArray(c.lines) &&
                c.lines.every(
                  (l) =>
                    [l.x, l.y, l.width, l.height].every(Number.isFinite) &&
                    l.width > 0 &&
                    l.height > 0 &&
                    [l.color, l.fill].every(
                      (color) => color === undefined || /^[0-9A-F]{6}$/i.test(color),
                    ) &&
                    (l.tabs === undefined ||
                      (Array.isArray(l.tabs) &&
                        l.tabs.every(
                          (x, i) => Number.isFinite(x) && (i === 0 || x > l.tabs![i - 1]!),
                        ))),
                ),
            )
          );
        }),
      )
    )
      return null;
    if (
      !doc.pages.every(
        (p) =>
          !p.paper || [p.paper.width, p.paper.height].every((v) => Number.isFinite(v) && v > 0),
      )
    )
      return null;
    if (
      !doc.pages.every(
        (p) =>
          !p.margins ||
          ([p.margins.top, p.margins.right, p.margins.bottom, p.margins.left].every(
            (v) => Number.isFinite(v) && v >= 0,
          ) &&
            p.margins.left + p.margins.right < (p.paper?.width ?? 595.3) &&
            p.margins.top + p.margins.bottom < (p.paper?.height ?? 841.9)),
      )
    )
      return null;
    // Older versions only increment version number without adding paper properties: pages without
    // paper (text-to-word, imported docx, legacy scans) retain original A4 formatting rules so they
    // reopen and save identically as before (placeholder boxes rely on spaced paragraphs; adding
    // paper would lose space-before).
    return doc.version !== 5 ? { ...doc, version: 5 } : doc;
  } catch {
    return null;
  }
}
