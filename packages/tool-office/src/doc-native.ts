import { leafBlocks, type DocLeaf, type DocPage } from './doc';
import type { Box } from './types';

export interface NativeGraphics {
  /** PDF point coordinates; app only reads user-selected originals copies. */
  owned: Box[];
  colors: { box: Box; color: string }[];
  fills?: { box: Box; color: string }[];
  /** PDF page size (in points) where these boxes are located; Word paper fit (fitPaper) differs from page.paper. */
  paper?: { width: number; height: number };
}
/** Ownership of the entire image containing rotated text cannot be reliably inferred yet; continue using existing text direction / cropping paths. */
export function canUseNativeGraphics(page: DocPage): boolean {
  return !leafBlocks(page).some((b) => b.kind === 'table' && b.direction !== undefined);
}

const area = (b: Box) => Math.max(0, b.width) * Math.max(0, b.height);
const overlap = (a: Box, b: Box) =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

/**
 * Total area covered by multiple boxes within box, counting overlapping regions only once: PDFs
 * often draw the same thick border multiple times (segmenting each grid cell, then drawing a
 * segment for the entire table), and boxes are also expanded outward by several pixels. Summing
 * areas directly causes a single border to 'fully cover' a very narrow adjacent cell (EU sample
 * 016 full-column black grid).
 */
function coveredArea(box: Box, rects: readonly Box[]): number {
  const parts = rects
    .map((r) => {
      const x = Math.max(box.x, r.x);
      const y = Math.max(box.y, r.y);
      return {
        x,
        y,
        right: Math.min(box.x + box.width, r.x + r.width),
        bottom: Math.min(box.y + box.height, r.y + r.height),
      };
    })
    .filter((r) => r.right > r.x && r.bottom > r.y);
  const xs = [...new Set(parts.flatMap((r) => [r.x, r.right]))].sort((a, b) => a - b);
  let total = 0;
  for (let i = 0; i + 1 < xs.length; i++) {
    const [x0, x1] = [xs[i]!, xs[i + 1]!];
    const spans = parts
      .filter((r) => r.x <= x0 && r.right >= x1)
      .map((r) => [r.y, r.bottom] as const)
      .sort((a, b) => a[0] - b[0]);
    let length = 0;
    let end = -Infinity;
    for (const [y0, y1] of spans) {
      if (y1 <= end) continue;
      length += y1 - Math.max(y0, end);
      end = y1;
    }
    total += (x1 - x0) * length;
  }
  return total;
}

/** Minimum contrast difference between background and text (WCAG contrast: 1 is identical, 21 is black and white). */
const MIN_FILL_CONTRAST = 2;
/** If the text box is taller than this multiplier relative to the text line, it is treated as large text placed on the page (watermark) rather than the text's own content. */
const WATERMARK_HEIGHT = 3;

/** Contrast ratio between two colors (six-digit hex). */
function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, b] = [0, 2, 4].map((i) => {
      const v = parseInt(hex.slice(i, i + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** Attach native clipping to isolated full images participating in body layout; only pure decorations may remain at the page footer. */
export function applyNativeGraphics(
  page: DocPage,
  graphics: NativeGraphics,
  sources: readonly string[],
  background?: string,
): DocPage {
  const paper = graphics.paper ?? page.paper;
  const kx = page.width / (paper?.width ?? 595.3);
  const ky = page.height / (paper?.height ?? 841.9);
  const pixel = (b: Box): Box => ({
    x: b.x * kx,
    y: b.y * ky,
    width: b.width * kx,
    height: b.height * ky,
  });
  const owned = graphics.owned.map(pixel);
  const colors = graphics.colors
    .filter((c) => /^[0-9A-F]{6}$/i.test(c.color))
    .map((c) => ({ ...c, box: pixel(c.box) }));
  const fills = (graphics.fills ?? [])
    .filter((c) => /^[0-9A-F]{6}$/i.test(c.color))
    .map((c) => ({ ...c, box: pixel(c.box) }));
  // Vote by overlapping area. A text box significantly taller than the text line (a large watermark
  // text 'PROJET' skewed across the page, EU sample 080) overlapping a short text line has an
  // overlap area larger than the text line's own size, but it is almost entirely elsewhere:
  // calculate only based on the portion present here, preventing this text line from inheriting the
  // watermark's light gray. Standard text boxes spanning two lines are calculated normally (EU
  // sample 068).
  const colorOf = (box: Box) => {
    const votes = new Map<string, number>();
    for (const c of colors) {
      const n = overlap(box, c.box);
      const weight = c.box.height > WATERMARK_HEIGHT * box.height ? n / (area(c.box) || 1) : 1;
      if (n > 0) votes.set(c.color, (votes.get(c.color) ?? 0) + n * weight);
    }
    const entries = [...votes].sort((a, b) => b[1] - a[1]);
    return entries[0] && entries[0][1] >= entries.reduce((n, c) => n + c[1], 0) * 0.8
      ? entries[0][0]
      : undefined;
  };
  // Accumulate area covered by each color from smallest to largest: colors covering 80% first are
  // on top. When a text segment spans multiple cards of the same color, calculate them combined
  // (otherwise it might fall onto the dark background of the entire page beneath the cards, making
  // dark text invisible on dark backgrounds).
  const bySize = [...fills].sort((a, b) => area(a.box) - area(b.box));
  const fillOf = (box: Box) => {
    const covered = new Map<string, Box[]>();
    for (const f of bySize) {
      if (overlap(box, f.box) <= 0) continue;
      const rects = [...(covered.get(f.color) ?? []), f.box];
      if (coveredArea(box, rects) >= area(box) * 0.8) return f.color;
      covered.set(f.color, rects);
    }
    return undefined;
  };
  // When background color and text color are too similar (e.g., black text falling on borders drawn
  // with solid black PDF boxes, EU sample 062): text would become invisible, so omit the background
  // color rather than risking it. Fall back to normal when text color is unknown.
  const legibleFill = (fill: string | undefined, color: string | undefined) =>
    fill && fill !== 'FFFFFF' && (!color || contrast(fill, color) >= MIN_FILL_CONTRAST)
      ? fill
      : undefined;
  const convert = (block: DocLeaf): DocLeaf => {
    if (block.kind === 'image') {
      const i = owned.findIndex(
        (b) => overlap(block.box, b) >= Math.max(area(block.box), area(b)) * 0.98,
      );
      return i >= 0 && sources[i] ? { ...block, src: sources[i] } : block;
    }
    if (block.kind === 'table')
      return {
        ...block,
        cellLayout: block.table.cells.map((cell) => {
          const previous = block.cellLayout?.find((c) => c.row === cell.row && c.col === cell.col);
          const found = cell.box ? fillOf(cell.box) : undefined;
          const fill = cell.text.trim() && cell.box ? legibleFill(found, colorOf(cell.box)) : found;
          return {
            ...previous,
            row: cell.row,
            col: cell.col,
            ...(fill && fill !== 'FFFFFF' ? { fill } : {}),
            lines: (previous?.lines ?? []).map((line) => {
              const color = colorOf(line);
              const fill = legibleFill(fillOf(line), color);
              return {
                ...line,
                ...(color && (color !== 'FFFFFF' || fill) ? { color } : {}),
                ...(fill ? { fill } : {}),
              };
            }),
          };
        }),
      };
    if (block.kind !== 'paragraph' && block.kind !== 'list') return block;
    const color = colorOf(block.box);
    const fill = legibleFill(fillOf(block.box), color);
    return {
      ...block,
      ...(color ? { color: color === 'FFFFFF' && !fill && !background ? '000000' : color } : {}),
      ...(fill && fill !== 'FFFFFF' ? { fill } : {}),
    };
  };
  const blocks = page.blocks.map((b) =>
    b.kind === 'row'
      ? { ...b, cells: b.cells.map((c) => ({ ...c, blocks: c.blocks.map(convert) })) }
      : convert(b),
  );
  return {
    ...page,
    blocks: [
      ...(background
        ? [
            {
              kind: 'image' as const,
              background: true as const,
              src: background,
              box: { x: 0, y: 0, width: page.width, height: page.height },
            },
          ]
        : []),
      ...blocks,
    ],
  };
}
