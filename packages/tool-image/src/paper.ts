import type { Size } from './geometry';
import { defaultQuad, quadArea, type Point, type Quad } from './quad';

// Pick out paper from candidate quadrilaterals for edge finding (D-326). Candidates often contain
// large boxes on the paper (such as table outer frames): when paper fills the screen, paper edges
// are not closed contours, and the largest closed contour becomes the table frame. Rule: measure
// luminance (median) along a narrow strip inside and outside each edge. If the outside is not much
// darker than the inside (≥ 80%), it indicates the paper continues past this edge. If more than
// half of the measured edges (excluding those adhering to photo edges where the outside cannot be
// measured) are like this, the candidate is a box on the paper and should be discarded. Among the
// remaining ones, pick the largest. If all candidates are considered boxes on the paper, the paper
// likely fills the screen, so return the whole photo; return null if there were no candidates
// initially (the four-corner UI uses an inset default box).

/** Grayscale image (one byte per pixel), can be smaller than the original image: coordinates are scaled proportionally by size. */
export interface GrayImage {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Distance offsets outside and inside the edge to measure luminance (proportion of photo's short side): avoids the edge line itself. */
const BAND = [0.015, 0.025, 0.035];
/**
 * If outside luminance is no less than this proportion of the inside, consider the paper
 * continuing. Paper shadows are generally above 80%, while desks (dark, wood grain, book
 * backgrounds) across 20 tested photos are all below 60%.
 */
const SAME_PAPER = 0.8;

type Side = 'border' | 'edge' | 'continues';

function median(values: number[]): number {
  values.sort((a, b) => a - b);
  return values[values.length >> 1]!;
}

/** An edge: whether outside cannot be measured (adhering to photo edge), is a paper edge (outside is significantly darker), or paper continues. */
function sideOf(a: Point, b: Point, center: Point, gray: GrayImage, k: number): Side {
  const { width, height, data } = gray;
  const at = (x: number, y: number) => {
    const px = Math.round(x * k);
    const py = Math.round(y * k);
    return px >= 0 && py >= 0 && px < width && py < height ? data[py * width + px]! : null;
  };
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  let nx = (b.y - a.y) / len;
  let ny = -(b.x - a.x) / len;
  // Normal points outward (facing away from the center).
  if ((center.x - (a.x + b.x) / 2) * nx + (center.y - (a.y + b.y) / 2) * ny > 0) {
    nx = -nx;
    ny = -ny;
  }
  const short = Math.min(width, height) / k;
  const inside: number[] = [];
  const outside: number[] = [];
  let total = 0;
  // Measure only the middle 80%, avoiding the corners.
  for (let t = 0.1; t <= 0.9; t += 0.02) {
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    for (const band of BAND) {
      const d = band * short;
      total++;
      const i = at(x - nx * d, y - ny * d);
      const o = at(x + nx * d, y + ny * d);
      if (i !== null) inside.push(i);
      if (o !== null) outside.push(o);
    }
  }
  if (outside.length * 2 <= total || inside.length === 0) return 'border';
  return median(outside) >= SAME_PAPER * median(inside) ? 'continues' : 'edge';
}

/** Box on paper: more than half of the measured edges have paper continuing past them. */
export function isFrameOnPaper(q: Quad, size: Size, gray: GrayImage): boolean {
  const pts = [q.tl, q.tr, q.br, q.bl];
  const center = {
    x: pts.reduce((s, p) => s + p.x, 0) / 4,
    y: pts.reduce((s, p) => s + p.y, 0) / 4,
  };
  const k = gray.width / size.width;
  const sides = pts.map((p, i) => sideOf(p, pts[(i + 1) % 4]!, center, gray, k));
  const measured = sides.filter((s) => s !== 'border').length;
  const continues = sides.filter((s) => s === 'continues').length;
  return measured > 0 && continues * 2 > measured;
}

/** Pick paper from candidates (which are already convex and sufficiently large quadrilaterals), following the rules at the top of the file. */
export function pickPaper(candidates: readonly Quad[], size: Size, gray: GrayImage): Quad | null {
  const papers = candidates.filter((q) => !isFrameOnPaper(q, size, gray));
  if (papers.length === 0) return candidates.length > 0 ? defaultQuad(size, 0) : null;
  return papers.reduce((best, q) => (quadArea(q) > quadArea(best) ? q : best));
}
