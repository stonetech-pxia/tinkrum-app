import type { OcrBox, RgbaImage } from './types';

// List bullet "•", hyphen "-" (EU samples 026, 027): OCR often fails to read this small mark,
// causing the line to start from the subsequent text. When no mark is present, list items collapse
// into regular paragraphs, merging two items into one or splitting a single item's wrapping. Look
// for this mark to the left of the line: a small solid ink blob (bullet) or a short horizontal
// stroke (hyphen) at the mid-height of the text, surrounded by whitespace; valid only if at least
// two lines on the page share the same mark at the same position. Prepend the found mark to the
// line ("• ", "- "), and format the remainder as a standard list.

/** Maximum and minimum distance of the mark from the text in line heights. */
const MARK_FAR = 2.5;
const MARK_NEAR = 0.15;
/** Bullet diameter: range in line heights. */
const DOT_MIN = 0.12;
const DOT_MAX = 0.5;
/** Hyphen: length range in line heights, thickness at most this many line heights. */
const DASH_MIN = 0.18;
const DASH_MAX = 1.1;
const DASH_THICK = 0.15;
/** A list requires at least this many lines of the same mark type with left alignments within this line-height threshold. */
const MARKS_MIN = 2;
const MARK_ALIGN = 0.5;
/** The center of the first character is approximately this many line heights from the left of the text; the first character must be at least this far from the left of the box for the box to contain a mark. */
const CHAR_HALF = 0.25;
const INSIDE_MIN = 0.6;

type Kind = 'dot' | 'dash';
interface Mark {
  kind: Kind;
  x: number;
}

const inkAt = (image: RgbaImage, x: number, y: number) => {
  const o = (y * image.width + x) * 4;
  return Math.min(image.data[o]!, image.data[o + 1]!, image.data[o + 2]!) < 128;
};

/**
 * True start position of the text: OCR boxes often start at the mark (e.g., box contains ■ but
 * text does not, EU sample 041); when the first character's position is more than half a line
 * height from the box's left edge, use the first character.
 */
function textStart(line: OcrBox): number {
  const first = line.chars?.length === [...line.text].length ? line.chars[0] : undefined;
  if (!first) return line.x;
  const x = line.x + first.at * line.width - CHAR_HALF * line.height;
  return x - line.x >= INSIDE_MIN * line.height ? x : line.x;
}

/** Small ink blob on the left of the line: return it if there is only a single blob whose size and position resemble a bullet or hyphen. */
function markOf(image: RgbaImage, line: OcrBox): Mark | null {
  const h = line.height;
  const start = textStart(line);
  const x0 = Math.max(0, Math.floor(line.x - MARK_FAR * h));
  const x1 = Math.min(image.width, Math.floor(start - MARK_NEAR * h));
  const y0 = Math.max(0, Math.floor(line.y));
  const y1 = Math.min(image.height, Math.ceil(line.y + h));
  if (x1 - x0 < 2 || y1 - y0 < 2) return null;
  const w = x1 - x0;
  const seen = new Uint8Array(w * (y1 - y0));
  let blob: { x0: number; y0: number; x1: number; y1: number; n: number } | null = null;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const k = (y - y0) * w + (x - x0);
      if (seen[k] || !inkAt(image, x, y)) continue;
      // Second ink blob: not an isolated single mark.
      if (blob) return null;
      const b = { x0: x, y0: y, x1: x, y1: y, n: 0 };
      const stack = [k];
      seen[k] = 1;
      while (stack.length) {
        const p = stack.pop()!;
        const px = (p % w) + x0;
        const py = Math.floor(p / w) + y0;
        b.n++;
        b.x0 = Math.min(b.x0, px);
        b.x1 = Math.max(b.x1, px);
        b.y0 = Math.min(b.y0, py);
        b.y1 = Math.max(b.y1, py);
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const nx = px + dx;
          const ny = py + dy;
          if (nx < x0 || nx >= x1 || ny < y0 || ny >= y1) continue;
          const q = (ny - y0) * w + (nx - x0);
          if (!seen[q] && inkAt(image, nx, ny)) {
            seen[q] = 1;
            stack.push(q);
          }
        }
      }
      blob = b;
    }
  }
  if (!blob) return null;
  const bw = blob.x1 - blob.x0 + 1;
  const bh = blob.y1 - blob.y0 + 1;
  // Touching the search boundary edge (other text on the left, or text from adjacent lines extending into the area): not an isolated mark.
  if (blob.x0 === x0 || blob.y0 === y0 || blob.y1 === y1 - 1) return null;
  const cy = (blob.y0 + blob.y1) / 2 - line.y;
  if (cy < 0.25 * h || cy > 0.8 * h) return null;
  if (
    bw >= DOT_MIN * h &&
    bw <= DOT_MAX * h &&
    bh >= DOT_MIN * h &&
    bh <= DOT_MAX * h &&
    bw <= 1.6 * bh &&
    bh <= 1.6 * bw &&
    blob.n >= 0.6 * bw * bh
  )
    return { kind: 'dot', x: blob.x0 };
  if (bw >= DASH_MIN * h && bw <= DASH_MAX * h && bh <= DASH_THICK * h && bw >= 2 * bh)
    return { kind: 'dash', x: blob.x0 };
  return null;
}

const TEXT = { dot: '•', dash: '-' } as const;

/**
 * Append markers to lines whose list markers were missed by OCR. Lines already starting with
 * markers or numbers are left unchanged. Returns new lines and a mapping of new lines to original
 * OCR lines.
 */
export function withBullets(
  image: RgbaImage,
  lines: readonly OcrBox[],
): { lines: OcrBox[]; source: Map<OcrBox, OcrBox> } {
  const found = new Map<OcrBox, Mark>();
  for (const l of lines) {
    if (/^\s*[•·*▪●○◦■□\-–—]/u.test(l.text) || !/^\s*\p{L}/u.test(l.text)) continue;
    const mark = markOf(image, l);
    if (mark) found.set(l, mark);
  }
  const source = new Map<OcrBox, OcrBox>();
  const out = lines.map((l) => {
    const mark = found.get(l);
    if (!mark) return l;
    // At least one other line has the same mark type and left alignment.
    const peers = [...found].filter(
      ([o, m]) => m.kind === mark.kind && Math.abs(m.x - mark.x) <= MARK_ALIGN * o.height,
    );
    if (peers.length < MARKS_MIN) return l;
    const x = Math.min(mark.x, l.x);
    const width = l.x + l.width - x;
    const head = `${TEXT[mark.kind]} `;
    const chars = l.chars?.length
      ? [
          { text: TEXT[mark.kind], at: (mark.x - x) / width },
          { text: ' ', at: (mark.x - x + textStart(l) - x) / 2 / width },
          ...l.chars.map((c) => ({ text: c.text, at: (l.x - x + c.at * l.width) / width })),
        ]
      : undefined;
    const next: OcrBox = {
      ...l,
      text: head + l.text.trimStart(),
      x,
      width,
      ...(chars && l.chars!.length === [...l.text].length && !/^\s/.test(l.text) ? { chars } : {}),
    };
    if (!next.chars || next.chars.length !== [...next.text].length) delete next.chars;
    source.set(next, l);
    return next;
  });
  return { lines: out, source };
}
