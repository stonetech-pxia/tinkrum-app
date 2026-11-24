// Regression checks: write several assertions for each case about what the conversion output should
// look like, verifying the generated DocDoc (used by the editor) and the docx itself. Text is
// normalized before comparison (lowercased, whitespace and most punctuation stripped, full-width
// characters converted to half-width), so assertions can just use text visible in the original.
import JSZip from 'jszip';

import type {
  DocBlock,
  DocDoc,
  DocLeaf,
  DocPage,
  DocTable,
} from '../../../packages/tool-office/src';

export const norm = (s: string) =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s '’"“”«».,:;!?·•_\-–—()[\]{}|/\\*]+/g, '');

/** A paragraph (w:p) in docx, in document order; paragraphs inside tables record their table index, row index, and cell index. */
export interface DocxPara {
  text: string;
  table?: { index: number; row: number; col: number };
  /** Nested inside a text box (w:txbxContent). */
  textbox?: boolean;
  /** w:jc value in w:pPr of this paragraph. */
  jc?: string;
}

export async function readDocx(
  bytes: Uint8Array,
): Promise<{ xml: string; paras: DocxPara[]; media: DocxMedia[]; contentTypes: string }> {
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file('word/document.xml')!.async('string');
  const paras: DocxPara[] = [];
  const open: DocxPara[] = [];
  const tables: { index: number; row: number; col: number }[] = [];
  let tableCount = 0;
  let textbox = 0;
  const tag = /<(\/?)(w:p|w:tbl|w:tr|w:tc|w:t|w:tab|w:br|w:txbxContent|w:jc)\b([^>]*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(xml))) {
    const [, close, name, attrs, self] = m as unknown as [string, string, string, string, string];
    const top = open[open.length - 1];
    if (name === 'w:p') {
      if (close) {
        const p = open.pop();
        if (p) paras.push(p);
      } else if (!self) {
        const t = tables[tables.length - 1];
        open.push({
          text: '',
          ...(t ? { table: { ...t } } : {}),
          ...(textbox ? { textbox: true } : {}),
        });
      }
    } else if (name === 'w:tbl') {
      if (close) tables.pop();
      else tables.push({ index: tableCount++, row: -1, col: -1 });
    } else if (name === 'w:tr' && !close) {
      const t = tables[tables.length - 1]!;
      t.row++;
      t.col = -1;
    } else if (name === 'w:tc' && !close) tables[tables.length - 1]!.col++;
    else if (name === 'w:txbxContent') textbox += close ? -1 : self ? 0 : 1;
    else if (name === 'w:jc' && top && !close) {
      const v = /w:val="([^"]+)"/.exec(attrs);
      if (v) top.jc = v[1];
    } else if (name === 'w:t' && !close && !self && top) {
      const end = xml.indexOf('</w:t>', tag.lastIndex);
      top.text += decodeXml(xml.slice(tag.lastIndex, end));
      tag.lastIndex = end;
    } else if ((name === 'w:tab' || name === 'w:br') && top)
      top.text += name === 'w:tab' ? '\t' : '\n';
  }
  const media: DocxMedia[] = [];
  for (const name of Object.keys(zip.files).filter((n) => n.startsWith('word/media/'))) {
    media.push({ name, head: [...(await zip.file(name)!.async('uint8array')).slice(0, 8)] });
  }
  const contentTypes = (await zip.file('[Content_Types].xml')?.async('string')) ?? '';
  return { xml, paras, media, contentTypes };
}

const decodeXml = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

/** A media file in docx: path and first few bytes (for format verification). */
export interface DocxMedia {
  name: string;
  head: number[];
}

export interface Converted {
  doc: DocDoc;
  paras: DocxPara[];
  xml: string;
  /** Files in word/media/ (optional for legacy callers). */
  media?: DocxMedia[];
  /** Raw content of [Content_Types].xml. */
  contentTypes?: string;
  /** All recognized lines (page by page in recognition order). */
  ocr: string[];
  /** Recognized lines and their bounding boxes (page matches the image size used for recognition, position can be compared only when matching pixel coordinates of the editor view). */
  ocrBoxes?: {
    text: string;
    x: number;
    y: number;
    width: number;
    height: number;
    page: { width: number; height: number };
  }[];
}

export interface Check {
  name: string;
  /** null on success, otherwise a sentence explaining what went wrong. */
  run(c: Converted): string | null;
}

/** Leaf blocks, in page and block order; blocks inside side-by-side layouts record their row and cell indices. */
export function leaves(doc: DocDoc) {
  const out: { leaf: DocLeaf; page: number; row?: { block: DocBlock; cell: number } }[] = [];
  doc.pages.forEach((p: DocPage, page) => {
    for (const b of p.blocks) {
      if (b.kind === 'row') {
        b.cells.forEach((c, cell) => {
          for (const leaf of c.blocks) out.push({ leaf, page, row: { block: b, cell } });
        });
      } else out.push({ leaf: b, page });
    }
  });
  return out;
}

const tableText = (t: DocTable) => t.table.cells.map((c) => c.text).join(' ');
const leafText = (b: DocLeaf): string =>
  b.kind === 'paragraph'
    ? b.text
    : b.kind === 'list'
      ? b.items.join('\n')
      : b.kind === 'table'
        ? tableText(b)
        : '';

/** Full text of the docx (newlines between paragraphs), before normalization. */
const fullText = (c: Converted) => c.paras.map((p) => p.text).join('\n');

const count = (hay: string, needle: string) => {
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
};

const paraIndex = (c: Converted, text: string) =>
  c.paras.findIndex((p) => norm(p.text).includes(norm(text)));

// ── Assertions ───────────────────────────────────────────────

/** These texts appear in docx in this exact order (each appearing at least once; spanning paragraphs or tables is allowed). */
export const order = (...texts: string[]): Check => ({
  name: `order ${texts.map((t) => JSON.stringify(t)).join(' < ')}`,
  run(c) {
    const all = norm(fullText(c));
    let at = 0;
    for (const t of texts) {
      const i = all.indexOf(norm(t), at);
      if (i < 0) {
        return all.includes(norm(t)) ? `"${t}" comes too early` : `"${t}" is missing`;
      }
      at = i + norm(t).length;
    }
    return null;
  },
});

/** These text snippets are in the same paragraph (the same w:p) in docx. */
export const together = (...texts: string[]): Check => ({
  name: `same paragraph ${texts.map((t) => JSON.stringify(t)).join(' + ')}`,
  run(c) {
    const p = c.paras.find((p) => texts.every((t) => norm(p.text).includes(norm(t))));
    if (p) return null;
    return `not in one paragraph: ${texts.map((t) => `"${t}"→#${paraIndex(c, t)}`).join(', ')}`;
  },
});

/** These text snippets are in different paragraphs (no single paragraph contains both). */
export const apart = (a: string, b: string): Check => ({
  name: `separate paragraphs ${JSON.stringify(a)} / ${JSON.stringify(b)}`,
  run(c) {
    if (paraIndex(c, a) < 0) return `"${a}" is missing`;
    if (paraIndex(c, b) < 0) return `"${b}" is missing`;
    const p = c.paras.find((p) => norm(p.text).includes(norm(a)) && norm(p.text).includes(norm(b)));
    return p ? `merged into one paragraph: "${p.text.slice(0, 120)}"` : null;
  },
});

/** This text appears exactly n times in docx (prevents duplicates and missing content). */
export const times = (text: string, n: number): Check => ({
  name: `${JSON.stringify(text)} appears ${n}×`,
  run(c) {
    const k = count(norm(fullText(c)), norm(text));
    return k === n ? null : `appears ${k}×`;
  },
});

export interface TableShape {
  /** Text required to be present in the table (each falling within some cell). */
  containing?: string[];
  rows?: number;
  cols?: number;
  minRows?: number;
  minCols?: number;
  maxRows?: number;
  maxCols?: number;
  /** Text of a specific cell (0-indexed). */
  cells?: { row: number; col: number; text: string }[];
}

const shapeOf = (t: DocTable) => {
  const cols = Math.max(0, ...t.table.cells.map((c) => c.col + c.colSpan)) - t.table.col;
  return { rows: t.table.rows, cols: Math.max(cols, t.table.cols) };
};

const describeTable = (t: DocTable) => {
  const s = shapeOf(t);
  return `${s.rows}×${s.cols} "${tableText(t).slice(0, 60)}"`;
};

function matches(t: DocTable, want: TableShape): boolean {
  const s = shapeOf(t);
  const text = norm(tableText(t));
  if (want.containing && !want.containing.every((x) => text.includes(norm(x)))) return false;
  if (want.rows !== undefined && s.rows !== want.rows) return false;
  if (want.cols !== undefined && s.cols !== want.cols) return false;
  if (want.minRows !== undefined && s.rows < want.minRows) return false;
  if (want.minCols !== undefined && s.cols < want.minCols) return false;
  if (want.maxRows !== undefined && s.rows > want.maxRows) return false;
  if (want.maxCols !== undefined && s.cols > want.maxCols) return false;
  for (const cell of want.cells ?? []) {
    const found = t.table.cells.find((x) => x.row === cell.row && x.col - t.table.col === cell.col);
    if (!found || !norm(found.text).includes(norm(cell.text))) return false;
  }
  return true;
}

const tablesOf = (c: Converted) =>
  leaves(c.doc)
    .map((l) => l.leaf)
    .filter((b): b is DocTable => b.kind === 'table');

/** A table with this shape exists (tables in the editor view, not side-by-side layout rows). */
export const table = (want: TableShape): Check => ({
  name: `table ${JSON.stringify(want)}`,
  run(c) {
    const all = tablesOf(c);
    if (all.some((t) => matches(t, want))) return null;
    return all.length ? `tables: ${all.map(describeTable).join('; ')}` : 'no table';
  },
});

/** A table row has these texts from left to right, each in a different cell (the item's name and amount are in the same row). */
export const inRow = (...texts: string[]): Check => ({
  name: `one table row ${texts.map((t) => JSON.stringify(t)).join(' | ')}`,
  run(c) {
    for (const t of tablesOf(c)) {
      for (let r = 0; r < t.table.rows; r++) {
        const cells = t.table.cells
          .filter((x) => x.row === r)
          .sort((a, b) => a.col - b.col)
          .map((x) => norm(x.text));
        let at = 0;
        const ok = texts.every((want) => {
          const i = cells.findIndex((x, k) => k >= at && x.includes(norm(want)));
          if (i < 0) return false;
          at = i + 1;
          return true;
        });
        if (ok) return null;
      }
    }
    const t = tablesOf(c).find((t) => norm(tableText(t)).includes(norm(texts[0]!)));
    return t ? `not in one row of ${describeTable(t)}` : `"${texts[0]}" is in no table`;
  },
});

/** a and b are each in a table, but not the same table (two originally separate tables were not joined into one). */
export const differentTables = (a: string, b: string): Check => ({
  name: `different tables ${JSON.stringify(a)} / ${JSON.stringify(b)}`,
  run(c) {
    const all = tablesOf(c);
    const x = all.findIndex((t) => norm(tableText(t)).includes(norm(a)));
    const y = all.findIndex((t) => norm(tableText(t)).includes(norm(b)));
    if (x < 0) return `"${a}" is in no table`;
    if (y < 0) return `"${b}" is in no table`;
    return x === y ? `both in ${describeTable(all[x]!)}` : null;
  },
});

/** This text is not inside any table (it is a body paragraph). */
export const notInTable = (text: string): Check => ({
  name: `${JSON.stringify(text)} is not in a table`,
  run(c) {
    const t = tablesOf(c).find((t) => norm(tableText(t)).includes(norm(text)));
    return t ? `inside table ${describeTable(t)}` : null;
  },
});

/** The entire page has no tables. */
export const noTables = (): Check => ({
  name: 'no tables',
  run(c) {
    const all = tablesOf(c);
    return all.length ? `tables: ${all.map(describeTable).join('; ')}` : null;
  },
});

/** The number of image blocks (excluding the full-page background image) is within the range; src needs to be cropped out. */
export const images = (range: { min?: number; max?: number }): Check => ({
  name: `images ${JSON.stringify(range)}`,
  run(c) {
    const all = leaves(c.doc)
      .map((l) => l.leaf)
      .filter((b) => b.kind === 'image' && !b.background);
    const n = all.length;
    if (range.min !== undefined && n < range.min) return `${n} images`;
    if (range.max !== undefined && n > range.max) return `${n} images`;
    if (all.some((b) => b.kind === 'image' && !b.src)) return 'an image was not cropped';
    return null;
  },
});

/** a and b are in different cells of the same side-by-side row (left/right columns, side-by-side label and value). */
export const sideBySide = (a: string, b: string): Check => ({
  name: `side by side ${JSON.stringify(a)} | ${JSON.stringify(b)}`,
  run(c) {
    const ls = leaves(c.doc);
    const where = (t: string) => ls.find((l) => norm(leafText(l.leaf)).includes(norm(t)));
    const x = where(a);
    const y = where(b);
    if (!x) return `"${a}" is missing from the blocks`;
    if (!y) return `"${b}" is missing from the blocks`;
    if (x.row && y.row && x.row.block === y.row.block && x.row.cell !== y.row.cell) return null;
    return 'not in different cells of one row';
  },
});

/** The paragraph (or table) containing this text has this alignment. */
export const aligned = (text: string, align: 'left' | 'center' | 'right'): Check => ({
  name: `${JSON.stringify(text)} aligned ${align}`,
  run(c) {
    const l = leaves(c.doc).find((l) => norm(leafText(l.leaf)).includes(norm(text)));
    if (!l) return 'missing';
    const got = 'align' in l.leaf && l.leaf.align ? l.leaf.align : 'left';
    return got === align ? null : `aligned ${got}`;
  },
});

/** This text is a heading (heading 1/2), or explicitly not one. */
export const heading = (text: string, is = true): Check => ({
  name: `${JSON.stringify(text)} ${is ? 'is' : 'is not'} a heading`,
  run(c) {
    const l = leaves(c.doc).find((l) => norm(leafText(l.leaf)).includes(norm(text)));
    if (!l) return 'missing';
    const h = l.leaf.kind === 'paragraph' && !!l.leaf.heading;
    return h === is ? null : h ? 'is a heading' : 'is not a heading';
  },
});

/** This text is a list item. */
export const listItem = (text: string): Check => ({
  name: `${JSON.stringify(text)} is a list item`,
  run(c) {
    const l = leaves(c.doc).find((l) => norm(leafText(l.leaf)).includes(norm(text)));
    if (!l) return 'missing';
    return l.leaf.kind === 'list' ? null : `is a ${l.leaf.kind}`;
  },
});

/** The visible number for this text is n: list items are calculated based on the list's starting number and position, and regular paragraphs look at the leading 'n.'. */
export const numbered = (text: string, n: number): Check => ({
  name: `${JSON.stringify(text)} is numbered ${n}`,
  run(c) {
    const l = leaves(c.doc).find((l) => norm(leafText(l.leaf)).includes(norm(text)));
    if (!l) return 'missing';
    const leaf = l.leaf;
    const shown =
      leaf.kind === 'list'
        ? leaf.ordered
          ? (leaf.start ?? 1) + leaf.items.findIndex((t) => norm(t).includes(norm(text)))
          : undefined
        : leaf.kind === 'paragraph'
          ? Number(/^\s*(\d+)[.)]/.exec(leaf.text)?.[1] ?? NaN)
          : undefined;
    return shown === n ? null : `is numbered ${shown}`;
  },
});

/**
 * Labels and values are paired one per row: each [label, value] pair is in the same row and
 * different cells of the same docx table, and each pair occupies its own row (side-by-side rows
 * where an entire column of labels is crammed into one cell and an entire column of values into
 * another are not included).
 */
export const pairedRows = (...pairs: [string, string][]): Check => ({
  name: `one row per pair ${pairs.map(([a, b]) => `${JSON.stringify(a)}|${JSON.stringify(b)}`).join(', ')}`,
  run(c) {
    const cell = (t: string) => c.paras.find((p) => norm(p.text).includes(norm(t)))?.table;
    const rows = new Set<string>();
    for (const [a, b] of pairs) {
      const x = cell(a);
      const y = cell(b);
      if (!x || !y) return `"${x ? b : a}" is missing or not in a table`;
      if (x.index !== y.index || x.row !== y.row || x.col === y.col) {
        return `"${a}" and "${b}" are not in different cells of one row`;
      }
      rows.add(`${x.index}:${x.row}`);
    }
    return rows.size === pairs.length ? null : 'several pairs share one row';
  },
});

/** A paragraph's (w:p) text matches these exactly (no more, no less). */
export const exactParagraph = (text: string): Check => ({
  name: `a paragraph is exactly ${JSON.stringify(text)}`,
  run(c) {
    if (c.paras.some((p) => norm(p.text) === norm(text))) return null;
    const p = c.paras[paraIndex(c, text)];
    return p ? `inside "${p.text.slice(0, 120)}"` : 'missing';
  },
});

/** This text is not in a side-by-side row (it is a top-to-bottom block, not a cell in a left/right split). */
export const notInRow = (text: string): Check => ({
  name: `${JSON.stringify(text)} is not in a side-by-side row`,
  run(c) {
    const l = leaves(c.doc).find((l) => norm(leafText(l.leaf)).includes(norm(text)));
    if (!l) return 'missing';
    return l.row ? `in cell ${l.row.cell} of a row` : null;
  },
});

/** Raw XML of the paragraph (w:p) containing this text in docx. */
const paraXml = (c: Converted, text: string) =>
  (c.xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? []).find((p) =>
    norm(
      decodeXml([...p.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1] ?? '').join('')),
    ).includes(norm(text)),
  );

/** The paragraph containing this text has a first-line indent (w:ind w:firstLine > 0). */
export const firstLineIndent = (text: string): Check => ({
  name: `${JSON.stringify(text)} has a first-line indent`,
  run(c) {
    const p = paraXml(c, text);
    if (!p) return 'missing';
    const v = /<w:ind\b[^>]*\bw:firstLine="(\d+)"/.exec(p);
    return v && Number(v[1]) > 0 ? null : 'no w:firstLine';
  },
});

/** The paragraph containing this text has no forced line breaks (w:br) and is not a numbered list (w:numPr). */
export const flowing = (text: string): Check => ({
  name: `${JSON.stringify(text)} flows without line breaks or numbering`,
  run(c) {
    const p = paraXml(c, text);
    if (!p) return 'missing';
    if (/<w:br\b/.test(p)) return 'has w:br';
    if (/<w:numPr\b/.test(p)) return 'has w:numPr';
    return null;
  },
});

/** Custom check written as-is. */
export const custom = (name: string, run: (c: Converted) => string | null): Check => ({
  name,
  run,
});

// ── General checks run for every test case ─────────────────────────────

/** Words shorter than or equal to this length (after normalization) are not supplemented by substring matching. */
const SHORT_WORD = 3;

const words = (s: string) =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .split(/[\s ]+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter((w) => w.length > 1 || /\p{N}/u.test(w));

/**
 * All recognized words are still present and none are extra: at least minRecall of recognized
 * words are in docx (by frequency), and extra occurrences of the same word in docx do not exceed
 * maxExtra of the recognition count (repeated text in layout lines or paragraphs written twice
 * will cause this to fail).
 */
export function textKept(minRecall = 0.97, maxExtra = 0.02): Check {
  return {
    name: `text kept (recall ≥ ${minRecall}, extra ≤ ${maxExtra})`,
    run(c) {
      const want = new Map<string, number>();
      for (const w of c.ocr.flatMap(words)) want.set(w, (want.get(w) ?? 0) + 1);
      // Words remaining in images (lines whose center is in an image block that is not a background): words present in the image but lacking editable text in Word are not considered lost.
      const pictured = new Map<string, number>();
      const shots = leaves(c.doc).flatMap((l) =>
        l.leaf.kind === 'image' && !l.leaf.background
          ? [{ box: l.leaf.box, page: c.doc.pages[l.page]! }]
          : [],
      );
      for (const line of c.ocrBoxes ?? []) {
        const cx = line.x + line.width / 2;
        const cy = line.y + line.height / 2;
        const inside = shots.some(
          ({ box, page }) =>
            page.width === line.page.width &&
            page.height === line.page.height &&
            cx >= box.x &&
            cx <= box.x + box.width &&
            cy >= box.y &&
            cy <= box.y + box.height,
        );
        if (inside) for (const w of words(line.text)) pictured.set(w, (pictured.get(w) ?? 0) + 1);
      }
      const got = new Map<string, number>();
      // Line-wrap hyphens and hyphenated words in docx are joined: two recognized words might be a single word in docx, so substring matching is used to compensate.
      for (const w of words(fullText(c))) got.set(w, (got.get(w) ?? 0) + 1);
      const glued = norm(fullText(c));
      const docWords = [...got.keys()];
      let total = 0;
      let kept = 0;
      let extra = 0;
      const lost: string[] = [];
      const dup: string[] = [];
      for (const [w, n] of want) {
        total += n;
        const k = got.get(w) ?? 0;
        // Short words ('n.a.', '2/2', 'Art') can almost always find the exact same letters in other
        // words, and substring matching would mask their loss: only recognize those attached to the
        // beginning or end of a word in docx (line-wrap hyphens and joined hyphenated words behave
        // this way).
        const loose =
          norm(w).length <= SHORT_WORD
            ? docWords
                .filter((d) => d !== w && (d.startsWith(w) || d.endsWith(w)))
                .reduce((sum, d) => sum + got.get(d)!, k)
            : count(glued, norm(w));
        const found = Math.min(n, k >= n ? n : Math.max(k, loose));
        // Instances that remain unfound are excused if they are left inside images.
        const excused = Math.min(n - found, pictured.get(w) ?? 0);
        total -= excused;
        kept += found;
        if (found + excused < n) lost.push(w);
        if (k > n) {
          extra += k - n;
          dup.push(`${w}×${k}/${n}`);
        }
      }
      const recall = total ? kept / total : 1;
      const extraRatio = total ? extra / total : 0;
      const problems: string[] = [];
      if (recall < minRecall) {
        problems.push(`recall ${recall.toFixed(3)}; lost: ${lost.slice(0, 12).join(' ')}`);
      }
      if (extraRatio > maxExtra) {
        problems.push(`extra ${extraRatio.toFixed(3)}; repeated: ${dup.slice(0, 12).join(' ')}`);
      }
      return problems.length ? problems.join(' | ') : null;
    },
  };
}

// ── Images, background images, and native PDF drawings (added by graphics / native suites) ────────────

type Region = { x: number; y: number; width: number; height: number };

/** Image blocks excluding background images, with their page dimensions. */
const pictures = (c: Converted) =>
  leaves(c.doc).flatMap((l) =>
    l.leaf.kind === 'image' && !l.leaf.background
      ? [{ ...l, box: l.leaf.box, size: c.doc.pages[l.page]! }]
      : [],
  );

const coverOf = (a: Region, b: Region) =>
  (Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))) /
  Math.max(1, a.width * a.height);

/**
 * This region on the original page (given as ratios of page width and height, 0–1) is covered by
 * an image block by at least min: the graphic was cropped out in full (not lost, not cut into
 * strips).
 */
export const imageCovers = (region: Region, min = 0.8): Check => ({
  name: `an image covers ${JSON.stringify(region)} (≥ ${min})`,
  run(c) {
    const all = pictures(c);
    const best = Math.max(
      0,
      ...all.map((p) =>
        coverOf(
          {
            x: region.x * p.size.width,
            y: region.y * p.size.height,
            width: region.width * p.size.width,
            height: region.height * p.size.height,
          },
          p.box,
        ),
      ),
    );
    return best >= min ? null : `best cover ${best.toFixed(2)} (${all.length} images)`;
  },
});

/** There is an image taking up at least minWidth of the page width, ordered before this text in the editing page's block sequence (the image precedes captions and body text). */
export const imageBefore = (text: string, minWidth = 0.5): Check => ({
  name: `a wide image comes before ${JSON.stringify(text)}`,
  run(c) {
    const ls = leaves(c.doc);
    const at = ls.findIndex((l) => norm(leafText(l.leaf)).includes(norm(text)));
    if (at < 0) return 'text missing';
    const img = ls.findIndex(
      (l) =>
        l.leaf.kind === 'image' &&
        !l.leaf.background &&
        l.leaf.box.width >= minWidth * c.doc.pages[l.page]!.width,
    );
    if (img < 0) return 'no wide image';
    return img < at ? null : 'the image comes after it';
  },
});

/** At least n images are in different cells of the same side-by-side row (side-by-side images are not stacked vertically). */
export const imagesSideBySide = (n = 2): Check => ({
  name: `${n} images side by side`,
  run(c) {
    const rows = new Map<DocBlock, Set<number>>();
    for (const p of pictures(c)) {
      if (!p.row) continue;
      const cells = rows.get(p.row.block) ?? new Set<number>();
      cells.add(p.row.cell);
      rows.set(p.row.block, cells);
    }
    const most = Math.max(0, ...[...rows.values()].map((s) => s.size));
    return most >= n ? null : `at most ${most} images in one row`;
  },
});

/**
 * Two images whose vertical extents largely overlap and horizontal extents barely overlap (a
 * side-by-side row of images) are both in different cells of the same side-by-side row: neither
 * image is pulled out of this row to be placed alone above or below.
 */
export const picturesInRows = (): Check => ({
  name: 'pictures beside each other share one row',
  run(c) {
    const all = pictures(c);
    for (const a of all) {
      for (const b of all) {
        if (a === b || a.page !== b.page) continue;
        const y =
          Math.min(a.box.y + a.box.height, b.box.y + b.box.height) - Math.max(a.box.y, b.box.y);
        const x =
          Math.min(a.box.x + a.box.width, b.box.x + b.box.width) - Math.max(a.box.x, b.box.x);
        if (y < 0.5 * Math.min(a.box.height, b.box.height)) continue;
        if (x > 0.2 * Math.min(a.box.width, b.box.width)) continue;
        if (a.row && b.row && a.row.block === b.row.block && a.row.cell !== b.row.cell) continue;
        const at = (p: typeof a) => `(${Math.round(p.box.x)}, ${Math.round(p.box.y)})`;
        return `pictures at ${at(a)} and ${at(b)} are not in one row`;
      }
    }
    return null;
  },
});

/** The number of full-page background images (DocImage.background) is within the range. */
export const backgrounds = (range: { min?: number; max?: number }): Check => ({
  name: `background images ${JSON.stringify(range)}`,
  run(c) {
    const n = leaves(c.doc).filter((l) => l.leaf.kind === 'image' && l.leaf.background).length;
    if (range.min !== undefined && n < range.min) return `${n} backgrounds`;
    if (range.max !== undefined && n > range.max) return `${n} backgrounds`;
    return null;
  },
});

/** Floating images in docx (wp:anchor) do not exceed max, are all behind text (behindDoc), and are not inside table cells. */
export const anchoredDrawings = (max: number): Check => ({
  name: `≤ ${max} anchored drawings, behind the text and outside table cells`,
  run(c) {
    const anchors = [...c.xml.matchAll(/<wp:anchor\b([^>]*)>/g)];
    if (anchors.length > max) return `${anchors.length} anchored drawings`;
    if (anchors.some((a) => !/behindDoc="1"/.test(a[1]!))) return 'an anchored drawing is in front';
    for (const tc of c.xml.matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)) {
      if (tc[0].includes('<wp:anchor')) return 'an anchored drawing sits inside a table cell';
    }
    return null;
  },
});

/** Presence or absence of images (PNGs) cropped from native PDF drawings: scanned or fallback-recognized pages should not have these. */
export const nativeGraphics = (expected: boolean): Check => ({
  name: expected ? 'native PDF graphics used' : 'no native PDF graphics',
  run(c) {
    const native = leaves(c.doc).some(
      (l) => l.leaf.kind === 'image' && /\.png$/i.test(l.leaf.src ?? ''),
    );
    return native === expected ? null : native ? 'native crops present' : 'no native crops';
  },
});

const MAGIC: [string, number[]][] = [
  ['png', [0x89, 0x50, 0x4e, 0x47]],
  ['jpg', [0xff, 0xd8, 0xff]],
  ['gif', [0x47, 0x49, 0x46]],
  ['bmp', [0x42, 0x4d]],
];

/** The file extension and actual format of every media file match, and [Content_Types].xml also declares this extension (D-509). */
export const mediaTypesMatch = (): Check => ({
  name: 'media extensions match their bytes and content types',
  run(c) {
    if (!c.media) return 'no media list';
    for (const m of c.media) {
      const kind = MAGIC.find(([, sig]) => sig.every((b, i) => m.head[i] === b))?.[0];
      const ext = m.name.split('.').pop()!.toLowerCase().replace('jpeg', 'jpg');
      if (kind && kind !== ext) return `${m.name} holds ${kind} bytes`;
      const declared = new RegExp(`Extension="${m.name.split('.').pop()}"`, 'i');
      if (!declared.test(c.contentTypes ?? '')) return `${m.name}: extension not declared`;
    }
    return null;
  },
});

const luminance = (hex: string) => {
  const [r, g, b] = [0, 2, 4].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};

/**
 * No invisible text: in paragraphs with a background color (w:shd on paragraphs or cells), the
 * contrast between the text color and background color is at least minContrast (dark text written
 * on an equally dark background is present but invisible).
 */
export const textVisible = (minContrast = 2): Check => ({
  name: `text contrasts with its shading (≥ ${minContrast}:1)`,
  run(c) {
    const bad: string[] = [];
    const scan = (xml: string, outerFill?: string) => {
      for (const p of xml.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)) {
        const fill = /<w:pPr>[\s\S]*?w:fill="([0-9A-Fa-f]{6})"/.exec(p[0])?.[1] ?? outerFill;
        if (!fill) continue;
        for (const r of p[0].matchAll(/<w:r>[\s\S]*?<\/w:r>/g)) {
          const text = [...r[0].matchAll(/<w:t[^>]*>([^<]*)/g)].map((m) => m[1]).join('');
          if (!text.trim()) continue;
          const color = /<w:color w:val="([0-9A-Fa-f]{6})"/.exec(r[0])?.[1] ?? '000000';
          const [hi, lo] = [luminance(color), luminance(fill)].sort((a, b) => b - a);
          if ((hi! + 0.05) / (lo! + 0.05) < minContrast)
            bad.push(`"${text.slice(0, 30)}" ${color}/${fill}`);
        }
      }
    };
    for (const tc of c.xml.matchAll(/<w:tc>([\s\S]*?)<\/w:tc>/g)) {
      const fill = /<w:tcPr>[\s\S]*?w:fill="([0-9A-Fa-f]{6})"[\s\S]*?<\/w:tcPr>/.exec(tc[1]!)?.[1];
      scan(tc[1]!, fill);
    }
    scan(c.xml.replace(/<w:tc>[\s\S]*?<\/w:tc>/g, ''));
    return bad.length ? `invisible: ${bad.slice(0, 5).join('; ')}` : null;
  },
});
