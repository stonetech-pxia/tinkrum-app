import type { DocBlock, DocDoc, DocLeaf, DocList, DocParagraph, DocRun } from './doc';

// Direct editing page modification (D-465, founder 2026-11-06: 'freely move cursors within
// documents... change font size, bold, underline, italic'): editing page returns modified block
// states (EditedPage), which are merged back into DocDoc here. Blocks map back to original blocks
// via ref, preserving original positions and layout info; new paragraphs created by carriage
// returns follow their preceding paragraph. Deleted blocks are removed.

const zeroBox = { x: 0, y: 0, width: 0, height: 0 };

/** Text run returned from the editing page: specifies attributes for each item (not relative to the entire paragraph). */
export interface EditedRun {
  text: string;
  size: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
}

export type EditedLeaf =
  | {
      kind: 'paragraph';
      /** Original block reference ('page-block' or 'page-block-cell-index'); new paragraphs created by carriage returns inherit the preceding paragraph's ref. */
      ref?: string;
      runs: EditedRun[];
      align?: 'left' | 'center' | 'right';
    }
  | { kind: 'list'; ref?: string; items: EditedRun[][] }
  | { kind: 'table'; ref: string; cells: { i: number; text: string }[] }
  | { kind: 'image' | 'space'; ref: string };

export type EditedBlock = EditedLeaf | { kind: 'row'; ref: string; cells: EditedLeaf[][] };

export interface EditedPage {
  blocks: EditedBlock[];
}

/** Split text run segments by separator (newlines, tabs), with each portion retaining its styling. */
export function splitRuns(runs: readonly DocRun[], sep: string): DocRun[][] {
  const out: DocRun[][] = [[]];
  for (const run of runs) {
    run.text.split(sep).forEach((part, i) => {
      if (i) out.push([]);
      if (part) out[out.length - 1]!.push({ ...run, text: part });
    });
  }
  return out;
}

/**
 * Appearance of the full block (title, bold, font size): sections returned by the edit page that
 * match are omitted. `size` is the font size rendered on the edit page (points, rounded to
 * integer, slightly differing from document font size); `docSize` is the document font size:
 * scaled runs apply the difference relative to `docSize`.
 */
export interface Base {
  size: number;
  docSize: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
}

/** Font size differences within this many points are treated as equal (edit page uses points, conversion back to points has minor variance). */
const SIZE_SNAP = 0.3;

function ownRuns(runs: readonly EditedRun[], base: Base): DocRun[] | undefined {
  const out: DocRun[] = [];
  for (const r of runs) {
    if (!r.text) continue;
    const run: DocRun = { text: r.text };
    if (Math.abs(r.size - base.size) >= SIZE_SNAP) {
      run.size = Math.max(1, Math.round((base.docSize + r.size - base.size) * 2) / 2);
    }
    if (r.bold !== base.bold) run.bold = r.bold;
    if (r.italic !== base.italic) run.italic = r.italic;
    if (r.underline !== base.underline) run.underline = r.underline;
    const last = out[out.length - 1];
    const { text: _a, ...a } = run;
    if (last) {
      const { text: _b, ...b } = last;
      if (sameValue(a, b)) {
        last.text += run.text;
        continue;
      }
    }
    out.push(run);
  }
  return out.some((r) => Object.keys(r).length > 1) ? out : undefined;
}

const textOf = (runs: readonly EditedRun[]) => runs.map((r) => r.text).join('');

function parseRef(ref: string | undefined) {
  const n = (ref ?? '').split('-').map(Number);
  if (n.length < 2 || n.some((v) => !Number.isInteger(v) || v < 0)) return null;
  return { page: n[0]!, block: n[1]!, cell: n[2], item: n[3] };
}

/**
 * Merge edited appearance back into the document. `baseOf` provides the rendered appearance of
 * each block on the edit page (font size, bold); matching sections returned are omitted. Returns
 * the original doc if unchanged (avoiding an extra undo step).
 */
export function mergeEdited(
  doc: DocDoc,
  edited: readonly EditedPage[],
  baseOf: (block: DocParagraph | DocList, page: number) => Base,
): DocDoc {
  const leafAt = (ref: string | undefined): DocLeaf | undefined => {
    const at = parseRef(ref);
    if (!at) return undefined;
    const block = doc.pages[at.page]?.blocks[at.block];
    if (at.cell === undefined) return block?.kind === 'row' ? undefined : block;
    return block?.kind === 'row' ? block.cells[at.cell]?.blocks[at.item ?? -1] : undefined;
  };

  const pages = doc.pages.map((page, p) => {
    const blocks = edited[p]?.blocks;
    if (!blocks) return page;
    // Most recent block: paragraphs split by newline without a ref follow this block.
    let previous: DocLeaf | undefined;
    const leaf = (e: EditedLeaf): DocLeaf | null => {
      const orig = leafAt(e.ref) ?? previous;
      if (e.kind === 'paragraph') {
        const text = textOf(e.runs);
        if (!text.trim()) return null;
        const like: DocParagraph =
          orig?.kind === 'paragraph'
            ? orig
            : { kind: 'paragraph', text: '', box: orig ? { ...orig.box } : zeroBox };
        const { runs: _r, align: _a, ...rest } = like;
        const runs = ownRuns(e.runs, baseOf(like, p));
        const align = e.align && e.align !== 'left' ? e.align : undefined;
        const next: DocParagraph = {
          ...rest,
          text,
          ...(runs ? { runs } : {}),
          ...(align ? { align } : {}),
        };
        previous = next;
        return next;
      }
      if (e.kind === 'list') {
        const items = e.items.filter((runs) => textOf(runs).trim());
        if (!items.length) return null;
        const like: DocList =
          orig?.kind === 'list'
            ? orig
            : { kind: 'list', ordered: false, items: [], box: orig ? { ...orig.box } : zeroBox };
        const base = baseOf(like, p);
        const own = items.map((runs) => ownRuns(runs, base) ?? null);
        const { itemRuns: _i, ...rest } = like;
        const next: DocList = {
          ...rest,
          items: items.map(textOf),
          ...(own.some(Boolean) ? { itemRuns: own } : {}),
        };
        previous = next;
        return next;
      }
      if (e.kind === 'table') {
        if (orig?.kind !== 'table') return null;
        const text = new Map(e.cells.map((c) => [c.i, c.text]));
        const cells = orig.table.cells.map((c, i) =>
          text.has(i) && text.get(i) !== c.text ? { ...c, text: text.get(i)! } : c,
        );
        previous = orig;
        return cells.every((c, i) => c === orig.table.cells[i])
          ? orig
          : { ...orig, table: { ...orig.table, cells } };
      }
      if (orig?.kind !== e.kind) return null;
      previous = orig;
      return orig;
    };
    const out: DocBlock[] = [];
    for (const e of blocks) {
      if (e.kind !== 'row') {
        const next = leaf(e);
        if (next) out.push(next);
        continue;
      }
      const at = parseRef(e.ref);
      const row = at ? doc.pages[at.page]?.blocks[at.block] : undefined;
      if (row?.kind !== 'row') continue;
      const cells = row.cells.map((cell, c) => ({
        ...cell,
        blocks: (e.cells[c] ?? []).map(leaf).filter((b): b is DocLeaf => b !== null),
      }));
      if (cells.some((c) => c.blocks.length)) out.push({ ...row, cells });
    }
    return { ...page, blocks: out };
  });
  const next = { ...doc, pages };
  return sameValue(next, doc) ? doc : next;
}

/** Checks if two values are equal (JSON-like values, ignoring key order). */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  return (
    ka.length === kb.length &&
    ka.every((k) => sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
  );
}
