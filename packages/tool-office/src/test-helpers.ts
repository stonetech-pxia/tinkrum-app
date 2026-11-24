import type { DocPage } from './doc';
import { leafBlocks } from './doc';
import { lineShareIn } from './layout';
import type { OcrBox, RgbaImage } from './types';

// Synthetic test page: black rectangles (lines, character strokes) drawn on a white background, the entire page can be rotated by an angle (simulating a crooked scan).

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Grayscale (0 black - 255 white), defaults to 20 (black) if not provided. */
  shade?: number;
  /** Color (RGB, 0-255): if provided, shade is ignored. */
  color?: readonly [number, number, number];
}

/** Draw a page: rects are coordinates before rotation, deg is the clockwise rotation angle around the page center (y pointing down). */
export function renderPage(
  width: number,
  height: number,
  rects: readonly Rect[],
  deg = 0,
): RgbaImage {
  const data = new Uint8Array(width * height * 4).fill(255);
  const a = (deg * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const cx = width / 2;
  const cy = height / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Rotate back to see which rectangle it falls into.
      const u = cx + (x + 0.5 - cx) * cos + (y + 0.5 - cy) * sin;
      const v = cy - (x + 0.5 - cx) * sin + (y + 0.5 - cy) * cos;
      for (const r of rects) {
        if (u >= r.x && u < r.x + r.width && v >= r.y && v < r.y + r.height) {
          const o = (y * width + x) * 4;
          if (r.color) [data[o], data[o + 1], data[o + 2]] = r.color;
          else data[o] = data[o + 1] = data[o + 2] = r.shade ?? 20;
          break;
        }
      }
    }
  }
  return { width, height, data };
}

/** The position of a point after rotation by deg degrees. */
export function rotatePoint(x: number, y: number, width: number, height: number, deg: number) {
  const a = (deg * Math.PI) / 180;
  const cx = width / 2;
  const cy = height / 2;
  return {
    x: cx + (x - cx) * Math.cos(a) - (y - cy) * Math.sin(a),
    y: cy + (x - cx) * Math.sin(a) + (y - cy) * Math.cos(a),
  };
}

/** Grid lines: horizontal lines at ys, vertical lines at xs, line width 2; edges in skip are not drawn (merged cells). */
export function gridRects(
  xs: readonly number[],
  ys: readonly number[],
  options: {
    thickness?: number;
    /** Vertical line segments not to draw: [vertical line index, row index]. */
    skipV?: readonly [number, number][];
    /** Horizontal line segments not to draw: [horizontal line index, column index]. */
    skipH?: readonly [number, number][];
    /** Break width on each line (pixel width). */
    breakEvery?: number;
  } = {},
): Rect[] {
  const t = options.thickness ?? 2;
  const out: Rect[] = [];
  const pushBroken = (r: Rect, horizontal: boolean) => {
    if (!options.breakEvery) return void out.push(r);
    // Break by 6 pixels every breakEvery pixels (broken lines in photocopies).
    const length = horizontal ? r.width : r.height;
    for (let s = 0; s < length; s += options.breakEvery) {
      const piece = Math.min(options.breakEvery - 6, length - s);
      if (piece <= 0) continue;
      out.push(
        horizontal
          ? { x: r.x + s, y: r.y, width: piece, height: r.height }
          : { x: r.x, y: r.y + s, width: r.width, height: piece },
      );
    }
  };
  for (const [i, y] of ys.entries()) {
    for (let c = 0; c < xs.length - 1; c++) {
      if (options.skipH?.some(([a, b]) => a === i && b === c)) continue;
      pushBroken({ x: xs[c]!, y, width: xs[c + 1]! - xs[c]! + t, height: t }, true);
    }
  }
  for (const [i, x] of xs.entries()) {
    for (let r = 0; r < ys.length - 1; r++) {
      if (options.skipV?.some(([a, b]) => a === i && b === r)) continue;
      pushBroken({ x, y: ys[r]!, width: t, height: ys[r + 1]! - ys[r]! + t }, false);
    }
  }
  return out;
}

/** Character-like strokes: a row of vertical bars (every 7 pixels, width 2, height h), not to be mistaken for lines. */
export function glyphs(x: number, y: number, width: number, h = 16): Rect[] {
  const out: Rect[] = [];
  for (let s = 0; s + 2 <= width; s += 7) out.push({ x: x + s, y, width: 2, height: h });
  return out;
}

/** Fake recognition result: pre-rotation boxes replaced with post-rotation positions (size unchanged); chars gives even positions for each character. */
export function fakeLine(
  text: string,
  box: Rect,
  page: { width: number; height: number; deg?: number },
  withChars = false,
): OcrBox {
  const c = rotatePoint(
    box.x + box.width / 2,
    box.y + box.height / 2,
    page.width,
    page.height,
    page.deg ?? 0,
  );
  const chars = Array.from(text);
  return {
    text,
    x: c.x - box.width / 2,
    y: c.y - box.height / 2,
    width: box.width,
    height: box.height,
    ...(withChars
      ? { chars: chars.map((ch, i) => ({ text: ch, at: (i + 0.5) / chars.length })) }
      : {}),
  };
}

/**
 * Text conservation: each recognized word appears exactly once in Word's editable text (missing
 * words and duplicates are considered errors). Lines with more than half falling inside image
 * blocks can stay solely in the image (appearing 0 or 1 time is fine). Counted by words,
 * unaffected by segmentation or grid splitting.
 */
export function textConservation(
  page: Pick<DocPage, 'blocks'>,
  lines: readonly OcrBox[],
): { missing: string[]; extra: string[] } {
  const leaves = leafBlocks(page);
  const images = leaves.filter((b) => b.kind === 'image').map((b) => b.box);
  // List numbers are written into Word's automatic numbering, not in the item text: words resembling numbers are counted on neither side.
  const marker = /^(?:[(（]?[\p{N}\p{L}]{1,3}[.)）、:]|[•·\-–*])$/u;
  const words = (s: string) => s.split(/\s+/).filter((w) => w && !marker.test(w));
  const count = (list: readonly string[]) => {
    const m = new Map<string, number>();
    for (const w of list) m.set(w, (m.get(w) ?? 0) + 1);
    return m;
  };
  const inImage = (l: OcrBox) => images.some((box) => lineShareIn(l, box) >= 0.5);
  const expected = count(lines.filter((l) => !inImage(l)).flatMap((l) => words(l.text)));
  const optional = count(lines.filter(inImage).flatMap((l) => words(l.text)));
  const actual = count(
    leaves.flatMap((b) =>
      words(
        b.kind === 'paragraph'
          ? b.text
          : b.kind === 'list'
            ? b.items.join(' ')
            : b.kind === 'table'
              ? b.table.cells.map((c) => c.text).join(' ')
              : '',
      ),
    ),
  );
  const missing: string[] = [];
  const extra: string[] = [];
  for (const [w, n] of expected) {
    const got = actual.get(w) ?? 0;
    for (let i = got; i < n; i++) missing.push(w);
  }
  for (const [w, got] of actual) {
    const allowed = (expected.get(w) ?? 0) + (optional.get(w) ?? 0);
    for (let i = allowed; i < got; i++) extra.push(w);
  }
  return { missing, extra };
}
