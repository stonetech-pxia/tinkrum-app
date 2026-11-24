// Auto-scroll speed during dragging when the finger is close to the top or bottom edge of the visible area, and maximum scroll speed per frame (pt).

/** How close the finger must be to the top or bottom edge of the visible area to trigger auto-scroll, and the maximum scroll speed per frame (pt). */
const EDGE = 80;
const MAX_SPEED = 14;

/** Auto-scroll speed during dragging: closer to the edge means faster; negative values mean upward. */
export function edgeSpeed(pageY: number, top: number, bottom: number): number {
  if (pageY < top + EDGE) return -MAX_SPEED * Math.min(1, (top + EDGE - pageY) / EDGE);
  if (pageY > bottom - EDGE) return MAX_SPEED * Math.min(1, (pageY - (bottom - EDGE)) / EDGE);
  return 0;
}
