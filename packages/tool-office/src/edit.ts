import type { Block, TableBlock, TableCell, TableDoc, TablePage, TableScope } from './types';

// TableDoc modifications in the edit page (D-272): modifying cells, inserting and deleting
// rows/columns (with merged regions updating accordingly), toggling recognition scope. Column
// layout is shared across all tables on a page, so inserting and deleting columns applies to the
// entire page: every table passing through that column updates accordingly. Each operation returns
// a new TableDoc (leaving the original unchanged), and undo/redo simply switches among instances,
// retaining up to 100 steps.

/** Position of a table within a TableDoc. */
export interface TableRef {
  page: number;
  block: number;
}

/** Cell ownership for each position (r * cols + c -> index in cells). */
export function cellOwners(table: TableBlock): Int32Array {
  const owner = new Int32Array(table.rows * table.cols).fill(-1);
  table.cells.forEach((cell, i) => {
    for (let r = cell.row; r < cell.row + cell.rowSpan; r++) {
      for (let c = cell.col; c < cell.col + cell.colSpan; c++) owner[r * table.cols + c] = i;
    }
  });
  return owner;
}

const sortCells = (cells: TableCell[]) => cells.sort((a, b) => a.row - b.row || a.col - b.col);

function updateTable(doc: TableDoc, at: TableRef, fn: (t: TableBlock) => TableBlock): TableDoc {
  const block = doc.pages[at.page]?.blocks[at.block];
  if (!block || block.kind !== 'table') return doc;
  const next = fn(block);
  if (next === block) return doc;
  return {
    ...doc,
    pages: doc.pages.map((p, i) =>
      i === at.page ? { ...p, blocks: p.blocks.map((b, j) => (j === at.block ? next : b)) } : p,
    ),
  };
}

/**
 * Modify cell text. Cells with explicitly specified text formats (numbers and dates from external
 * xlsx files, D-509) will no longer be written using their original values after text
 * modification: like scanned cells, text is guessed (pure numbers written as numbers), otherwise
 * the saved output would revert to the pre-modification number.
 */
export function setCellText(doc: TableDoc, at: TableRef, cell: number, text: string): TableDoc {
  return updateTable(doc, at, (t) =>
    t.cells[cell] && t.cells[cell]!.text !== text
      ? {
          ...t,
          cells: t.cells.map((c, i) => {
            if (i !== cell) return c;
            const { write: _write, ...rest } = c;
            return { ...rest, text };
          }),
        }
      : t,
  );
}

/**
 * Insert a row at row index at (0 to rows). Merged cells spanning the insertion point increase in
 * height; other positions receive new blank cells.
 */
export function insertRow(doc: TableDoc, at: TableRef, row: number): TableDoc {
  return updateTable(doc, at, (t) => {
    if (row < 0 || row > t.rows) return t;
    const covered = new Set<number>();
    const cells = t.cells.map((c) => {
      if (c.row >= row) return { ...c, row: c.row + 1 };
      if (c.row + c.rowSpan > row) {
        for (let k = c.col; k < c.col + c.colSpan; k++) covered.add(k);
        return { ...c, rowSpan: c.rowSpan + 1 };
      }
      return c;
    });
    for (let col = 0; col < t.cols; col++) {
      if (!covered.has(col)) cells.push({ row, col, rowSpan: 1, colSpan: 1, text: '' });
    }
    return { ...t, rows: t.rows + 1, cells: sortCells(cells) };
  });
}

/** Delete a row (at least one row must remain). Cells belonging only to this row are deleted, and spanning merged cells become shorter. */
export function deleteRow(doc: TableDoc, at: TableRef, row: number): TableDoc {
  return updateTable(doc, at, (t) => {
    if (t.rows <= 1 || row < 0 || row >= t.rows) return t;
    const cells: TableCell[] = [];
    for (const c of t.cells) {
      if (c.row > row) cells.push({ ...c, row: c.row - 1 });
      else if (c.row + c.rowSpan > row) {
        if (c.rowSpan > 1) cells.push({ ...c, rowSpan: c.rowSpan - 1 });
      } else cells.push(c);
    }
    return { ...t, rows: t.rows - 1, cells: sortCells(cells) };
  });
}

/** Insert a column at index col (from 0 to cols): spanning merged cells become wider, and other rows get new empty cells. */
function insertTableColumn(t: TableBlock, col: number): TableBlock {
  const covered = new Set<number>();
  const cells = t.cells.map((c) => {
    if (c.col >= col) return { ...c, col: c.col + 1 };
    if (c.col + c.colSpan > col) {
      for (let k = c.row; k < c.row + c.rowSpan; k++) covered.add(k);
      return { ...c, colSpan: c.colSpan + 1 };
    }
    return c;
  });
  for (let row = 0; row < t.rows; row++) {
    if (!covered.has(row)) cells.push({ row, col, rowSpan: 1, colSpan: 1, text: '' });
  }
  return { ...t, cols: t.cols + 1, cells: sortCells(cells) };
}

/** Delete column at index col: cells belonging solely to this column are deleted, and spanning merged cells become narrower. */
function deleteTableColumn(t: TableBlock, col: number): TableBlock {
  const cells: TableCell[] = [];
  for (const c of t.cells) {
    if (c.col > col) cells.push({ ...c, col: c.col - 1 });
    else if (c.col + c.colSpan > col) {
      if (c.colSpan > 1) cells.push({ ...c, colSpan: c.colSpan - 1 });
    } else cells.push(c);
  }
  return { ...t, cols: t.cols - 1, cells: sortCells(cells) };
}

function updatePage(doc: TableDoc, page: number, next: TablePage): TableDoc {
  return { ...doc, pages: doc.pages.map((p, i) => (i === page ? next : p)) };
}

/**
 * Insert a column at index col (0 to column count) on this page, with the same width as the
 * column to its left. If this position is inside or on the edge of a table, that table gets one
 * extra column; if it is to the left of a table, the entire table shifts right by one column.
 */
export function insertColumn(doc: TableDoc, page: number, col: number): TableDoc {
  const p = doc.pages[page];
  if (!p || col < 0 || col > p.colWidths.length) return doc;
  const blocks = p.blocks.map((b): Block => {
    // When text or images have a column range (D-520, D-522): shifting right from this position
    // widens only the column spanning this position (inserting a column at the boundary between two
    // side-by-side blocks, preventing both blocks from widening and covering the same column).
    if (b.kind !== 'table') {
      if (b.col === undefined) return b;
      if (col <= b.col) return { ...b, col: b.col + 1 };
      if (col < b.col + (b.cols ?? 0)) return { ...b, cols: (b.cols ?? 0) + 1 };
      return b;
    }
    if (col < b.col) return { ...b, col: b.col + 1 };
    if (col <= b.col + b.cols) return insertTableColumn(b, col - b.col);
    return b;
  });
  const width = p.colWidths[Math.max(0, col - 1)] ?? 100;
  const colWidths = [...p.colWidths.slice(0, col), width, ...p.colWidths.slice(col)];
  return updatePage(doc, page, { ...p, colWidths, blocks });
}

/** Whether column col on this page can be deleted: at least one column must remain, and tables intersecting it must also retain at least one column (tables cannot be deleted entirely). */
export function canDeleteColumn(page: TablePage, col: number): boolean {
  if (page.colWidths.length <= 1 || col < 0 || col >= page.colWidths.length) return false;
  return page.blocks.every((b) => {
    if (b.kind !== 'table' && b.col === undefined) return true;
    const cols = b.kind === 'table' || b.kind === 'image' ? b.cols : (b.cols ?? 1);
    return cols > 1 || col < b.col! || col >= b.col! + cols;
  });
}

/** Delete column col on this page. */
export function deleteColumn(doc: TableDoc, page: number, col: number): TableDoc {
  const p = doc.pages[page];
  if (!p || !canDeleteColumn(p, col)) return doc;
  const blocks = p.blocks.map((b): Block => {
    if (b.kind !== 'table') {
      if (b.col === undefined) return b;
      if (col < b.col) return { ...b, col: b.col - 1 };
      if (col < b.col + (b.cols ?? 0)) return { ...b, cols: (b.cols ?? 1) - 1 };
      return b;
    }
    if (col < b.col) return { ...b, col: b.col - 1 };
    if (col < b.col + b.cols) return deleteTableColumn(b, col - b.col);
    return b;
  });
  const colWidths = p.colWidths.filter((_, i) => i !== col);
  return updatePage(doc, page, { ...p, colWidths, blocks });
}

/** Modify a text block outside of tables. */
export function setTextBlock(doc: TableDoc, page: number, block: number, text: string): TableDoc {
  const b = doc.pages[page]?.blocks[block];
  if (!b || b.kind !== 'text' || b.text === text) return doc;
  return {
    ...doc,
    pages: doc.pages.map((p, i) =>
      i === page ? { ...p, blocks: p.blocks.map((x, j) => (j === block ? { ...b, text } : x)) } : p,
    ),
  };
}

/** Delete a text block outside of tables (such as recognized headers or page numbers). Tables cannot be deleted entirely. */
export function deleteTextBlock(doc: TableDoc, page: number, block: number): TableDoc {
  if (doc.pages[page]?.blocks[block]?.kind !== 'text') return doc;
  return {
    ...doc,
    pages: doc.pages.map((p, i) =>
      i === page ? { ...p, blocks: p.blocks.filter((_, j) => j !== block) } : p,
    ),
  };
}

/** Delete an image block (D-520). */
export function deleteImageBlock(doc: TableDoc, page: number, block: number): TableDoc {
  if (doc.pages[page]?.blocks[block]?.kind !== 'image') return doc;
  return {
    ...doc,
    pages: doc.pages.map((p, i) =>
      i === page ? { ...p, blocks: p.blocks.filter((_, j) => j !== block) } : p,
    ),
  };
}

/** Toggle recognition scope (only affects whether out-of-table text is written when exporting to XLSX). */
export function setScope(doc: TableDoc, scope: TableScope): TableDoc {
  return doc.scope === scope ? doc : { ...doc, scope };
}

/** Undo and redo: in-memory only (shared by TableDoc for Excel and DocDoc for Word). */
export interface History<T> {
  past: readonly T[];
  present: T;
  future: readonly T[];
}

export type TableHistory = History<TableDoc>;

export const HISTORY_LIMIT = 100;

export const startHistory = <T>(doc: T): History<T> => ({
  past: [],
  present: doc,
  future: [],
});

/** Record a modification (skipped if unchanged). */
export function pushHistory<T>(h: History<T>, next: T): History<T> {
  if (next === h.present) return h;
  return { past: [...h.past, h.present].slice(-HISTORY_LIMIT), present: next, future: [] };
}

export function undo<T>(h: History<T>): History<T> {
  const prev = h.past.at(-1);
  return prev !== undefined
    ? { past: h.past.slice(0, -1), present: prev, future: [h.present, ...h.future] }
    : h;
}

export function redo<T>(h: History<T>): History<T> {
  const next = h.future[0];
  return next !== undefined
    ? { past: [...h.past, h.present], present: next, future: h.future.slice(1) }
    : h;
}

/** Total cell count of a page (read-only if editing page exceeds 2000 cells). */
export const pageCellCount = (doc: TableDoc, page: number) =>
  (doc.pages[page]?.blocks ?? []).reduce(
    (n, b) => n + (b.kind === 'table' ? b.rows * b.cols : 0),
    0,
  );

export const EDITABLE_CELLS = 2000;

/**
 * Check the approximate shape of TableDoc when loading from JSON (files are self-authored,
 * protects against corrupted files only). Version 2 files (lacking image blocks, text column
 * ranges, and font sizes, D-520-D-522) are upgraded to 3: new fields are optional, so old files
 * require no field modifications, making the upgrade purely a version number bump (invariant 12).
 */
export function parseTableDoc(json: string): TableDoc | null {
  try {
    const doc = JSON.parse(json) as { version?: number; scope?: string; pages?: unknown };
    if ((doc?.version !== 2 && doc?.version !== 3) || !Array.isArray(doc.pages)) return null;
    if (doc.scope !== 'all' && doc.scope !== 'tables') return null;
    return { ...doc, version: 3 } as TableDoc;
  } catch {
    return null;
  }
}
