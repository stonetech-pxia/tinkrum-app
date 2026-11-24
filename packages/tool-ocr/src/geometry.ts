// Geometric calculations for finding text lines (D-269): convex hull, minimum bounding rectangle
// (rotating calipers), expanding rectangles, sorting four corners. Consistent with PaddleOCR's DB
// post-processing (OpenCV's minAreaRect, pyclipper's offset) results without depending on them.

export interface Point {
  x: number;
  y: number;
}

/** Rotated rectangle: center, two axes (unit vectors), and lengths along the two axes directions. */
export interface RotatedRect {
  cx: number;
  cy: number;
  u: Point;
  v: Point;
  w: number;
  h: number;
}

const cross = (o: Point, a: Point, b: Point) =>
  (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

/** Convex hull (Andrew's monotone chain), counter-clockwise, excluding collinear points. */
export function convexHull(points: readonly Point[]): Point[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length <= 2) return pts;
  const lower: Point[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower.at(-2)!, lower.at(-1)!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Point[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    while (upper.length >= 2 && cross(upper.at(-2)!, upper.at(-1)!, p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** Minimum area bounding rectangle: the minimum rectangle must share an edge with an edge of the convex hull; test edge by edge. */
export function minAreaRect(points: readonly Point[]): RotatedRect {
  const hull = convexHull(points);
  if (hull.length === 0) return { cx: 0, cy: 0, u: { x: 1, y: 0 }, v: { x: 0, y: 1 }, w: 0, h: 0 };
  let best: RotatedRect | null = null;
  let bestArea = Infinity;
  const n = hull.length;
  for (let i = 0; i < Math.max(1, n); i++) {
    const a = hull[i]!;
    const b = hull[(i + 1) % n]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const u = len > 0 ? { x: (b.x - a.x) / len, y: (b.y - a.y) / len } : { x: 1, y: 0 };
    const v = { x: -u.y, y: u.x };
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const p of hull) {
      const pu = p.x * u.x + p.y * u.y;
      const pv = p.x * v.x + p.y * v.y;
      if (pu < minU) minU = pu;
      if (pu > maxU) maxU = pu;
      if (pv < minV) minV = pv;
      if (pv > maxV) maxV = pv;
    }
    const area = (maxU - minU) * (maxV - minV);
    if (area < bestArea - 1e-9) {
      bestArea = area;
      const mu = (minU + maxU) / 2;
      const mv = (minV + maxV) / 2;
      best = {
        cx: mu * u.x + mv * v.x,
        cy: mu * u.y + mv * v.y,
        u,
        v,
        w: maxU - minU,
        h: maxV - minV,
      };
    }
  }
  return best!;
}

/** Four corners of the rectangle, ordered as top-left, top-right, bottom-right, bottom-left (PaddleOCR's get_mini_boxes: sort by x first, then split each left/right pair into top/bottom by y). */
export function rectCorners(rect: RotatedRect): [Point, Point, Point, Point] {
  const { cx, cy, u, v, w, h } = rect;
  const corner = (su: number, sv: number) => ({
    x: cx + (su * w * u.x) / 2 + (sv * h * v.x) / 2,
    y: cy + (su * w * u.y) / 2 + (sv * h * v.y) / 2,
  });
  const pts = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)].sort(
    (a, b) => a.x - b.x,
  );
  const [l0, l1, r0, r1] = pts as [Point, Point, Point, Point];
  const [tl, bl] = l1.y > l0.y ? [l0, l1] : [l1, l0];
  const [tr, br] = r1.y > r0.y ? [r0, r1] : [r1, r0];
  return [tl, tr, br, bl];
}

/**
 * Expanding text regions outward (DB's unclip): expansion distance = area × ratio ÷ perimeter.
 * After expanding the rectangle by rounded corners, the minimum bounding rectangle is each side
 * plus this distance.
 */
export function unclipRect(rect: RotatedRect, ratio: number): RotatedRect {
  const perimeter = 2 * (rect.w + rect.h);
  const d = perimeter > 0 ? (rect.w * rect.h * ratio) / perimeter : 0;
  return { ...rect, w: rect.w + 2 * d, h: rect.h + 2 * d };
}
