import { type Degrees, type PDFPage, degrees } from 'pdf-lib';

// "User-perspective" geometry of a page: PDF pages may have /Rotate, displayed by readers after
// clockwise rotation. Here, view coordinates (bottom-left origin, y upwards, i.e., the direction
// seen by the user) are used uniformly for layout, then converted back to PDF user space so text
// and images appear upright on rotated pages.

export type Rotation = 0 | 90 | 180 | 270;

export function normalizeRotation(angle: number): Rotation {
  return ((((Math.round(angle / 90) * 90) % 360) + 360) % 360) as Rotation;
}

export interface PageView {
  /** Dimensions seen by the user (swapped with CropBox dimensions at 90° / 270°). */
  width: number;
  height: number;
  rotation: Rotation;
  /** Visible area (CropBox, defaults to MediaBox). */
  box: { x: number; y: number; width: number; height: number };
}

export function pageView(page: PDFPage): PageView {
  const box = page.getCropBox();
  const rotation = normalizeRotation(page.getRotation().angle);
  const swap = rotation === 90 || rotation === 270;
  return {
    width: swap ? box.height : box.width,
    height: swap ? box.width : box.height,
    rotation,
    box,
  };
}

/** View coordinates → PDF user space coordinates (i.e., rotated counter-clockwise by rotation degrees around the page center, then translated). */
export function toPdfPoint(view: PageView, p: number, q: number): { x: number; y: number } {
  const { x, y, width: w, height: h } = view.box;
  switch (view.rotation) {
    case 0:
      return { x: x + p, y: y + q };
    case 90:
      return { x: x + w - q, y: y + p };
    case 180:
      return { x: x + w - p, y: y + h - q };
    case 270:
      return { x: x + q, y: y + h - p };
  }
}

/**
 * Rectangle in view (bottom-left at p, q, width w, height h, rotated counter-clockwise by angle
 * degrees around the center) → origin and rotation angle needed by pdf-lib drawText / drawImage.
 */
export function placeBox(
  view: PageView,
  rect: { p: number; q: number; w: number; h: number },
  angle = 0,
): { x: number; y: number; rotate: Degrees } {
  const rad = (angle * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const hw = rect.w / 2;
  const hh = rect.h / 2;
  const origin = toPdfPoint(
    view,
    rect.p + hw - (cos * hw - sin * hh),
    rect.q + hh - (sin * hw + cos * hh),
  );
  return { ...origin, rotate: degrees(view.rotation + angle) };
}
