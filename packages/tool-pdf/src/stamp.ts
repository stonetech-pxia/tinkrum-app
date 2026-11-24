import { type PDFFont, type PDFPage, StandardFonts, rgb } from 'pdf-lib';

import { PdfError, assertNumber, assertPageIndices, canEncodeStandardText, loadPdf } from './core';
import { type ImageKind, embedImage } from './images';
import { type PageView, pageView, placeBox } from './view';

// Overlay content on existing pages: page numbers, text watermarks / stamps, images (signatures,
// Chinese seals). Positions are always calculated in the user-visible direction: on pages with
// /Rotate, content rotates accordingly to remain visually upright.

export type EdgePosition =
  'bottomCenter' | 'bottomRight' | 'bottomLeft' | 'topCenter' | 'topRight' | 'topLeft';
export type StampPosition = EdgePosition | 'center';

/** [horizontal, vertical] anchor: 0 = left / bottom, 0.5 = center, 1 = right / top. */
const ANCHORS: Record<StampPosition, [number, number]> = {
  bottomLeft: [0, 0],
  bottomCenter: [0.5, 0],
  bottomRight: [1, 0],
  topLeft: [0, 1],
  topCenter: [0.5, 1],
  topRight: [1, 1],
  center: [0.5, 0.5],
};

/** Position of the text box (baseline left end at p, q) in the view. */
function anchorRect(view: PageView, position: StampPosition, w: number, h: number, margin: number) {
  const anchor: [number, number] | undefined = ANCHORS[position];
  if (!anchor) throw new PdfError('badOption');
  const [ax, ay] = anchor;
  return {
    p: margin + ax * (view.width - 2 * margin - w),
    q: margin + ay * (view.height - 2 * margin - h),
    w,
    h,
  };
}

function drawLabel(
  page: PDFPage,
  font: PDFFont,
  text: string,
  opts: {
    position: StampPosition;
    fontSize: number;
    margin: number;
    color?: ReturnType<typeof rgb>;
    opacity?: number;
    rotateDeg?: number;
  },
): void {
  const view = pageView(page);
  const w = font.widthOfTextAtSize(text, opts.fontSize);
  const h = font.heightAtSize(opts.fontSize, { descender: false });
  const rect = anchorRect(view, opts.position, w, h, opts.margin);
  page.drawText(text, {
    ...placeBox(view, rect, opts.rotateDeg ?? 0),
    font,
    size: opts.fontSize,
    color: opts.color ?? rgb(0, 0, 0),
    opacity: opts.opacity ?? 1,
  });
}

export interface PageNumberOptions {
  position: EdgePosition;
  /** n："3"；nOfTotal："3 / 10"；pageNOfTotal："Page 3 of 10"。 */
  format: 'n' | 'nOfTotal' | 'pageNOfTotal';
  startAt: number;
  fontSize: number;
  marginPt: number;
  /**
   * Number only these pages (0-based); numbering increments starting from startAt in list order,
   * total = startAt + pageCount - 1. E.g. skipping cover: pages = [1..n-1], startAt = 1.
   */
  pages?: number[];
}

function formatNumber(format: PageNumberOptions['format'], n: number, total: number): string {
  if (format === 'n') return String(n);
  if (format === 'nOfTotal') return `${n} / ${total}`;
  return `Page ${n} of ${total}`;
}

/** Add page numbers using Helvetica in black. */
export async function addPageNumbers(
  bytes: Uint8Array,
  opts: PageNumberOptions,
): Promise<Uint8Array> {
  assertNumber(opts.fontSize, 1, 200);
  assertNumber(opts.marginPt, 0, 300);
  assertNumber(opts.startAt, 0, 1_000_000);
  if (!Number.isInteger(opts.startAt)) throw new PdfError('badOption');
  const doc = await loadPdf(bytes);
  const pages = doc.getPages();
  const targets = opts.pages ?? doc.getPageIndices();
  assertPageIndices(targets, pages.length);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const total = opts.startAt + targets.length - 1;
  targets.forEach((index, k) => {
    const page = pages[index];
    if (!page) return;
    drawLabel(page, font, formatNumber(opts.format, opts.startAt + k, total), {
      position: opts.position,
      fontSize: opts.fontSize,
      margin: opts.marginPt,
    });
  });
  return doc.save();
}

export interface StampTextOptions {
  /** Supports only single-line text encodable by standard fonts; see canEncodeStandardText. */
  text: string;
  position: StampPosition;
  fontSize: number;
  /** '#RRGGBB' */
  color: string;
  /** 0–1 */
  opacity: number;
  /** Rotate counter-clockwise around text center (user-visible direction), e.g. 45 for diagonal watermarks. */
  rotateDeg?: number;
  /** 0-based; defaults to all pages if omitted. */
  pages?: number[];
}

/** Fixed distance from text to page edge (half an inch). */
const STAMP_MARGIN_PT = 36;

function parseColor(hex: string): ReturnType<typeof rgb> {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) throw new PdfError('badOption');
  const n = Number.parseInt(hex.slice(1), 16);
  return rgb(((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255);
}

/** Stamp text using Helvetica; throws unsupportedText if standard fonts cannot encode it. */
export async function stampText(bytes: Uint8Array, opts: StampTextOptions): Promise<Uint8Array> {
  if (opts.text.length < 1) throw new PdfError('badOption');
  if (!canEncodeStandardText(opts.text)) throw new PdfError('unsupportedText');
  const color = parseColor(opts.color);
  assertNumber(opts.fontSize, 1, 500);
  assertNumber(opts.opacity, 0, 1);
  assertNumber(opts.rotateDeg ?? 0, -360, 360);
  const doc = await loadPdf(bytes);
  const pages = doc.getPages();
  const targets = opts.pages ?? doc.getPageIndices();
  assertPageIndices(targets, pages.length);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const index of targets) {
    const page = pages[index];
    if (!page) continue;
    drawLabel(page, font, opts.text, {
      position: opts.position,
      fontSize: opts.fontSize,
      margin: STAMP_MARGIN_PT,
      color,
      opacity: opts.opacity,
      rotateDeg: opts.rotateDeg ?? 0,
    });
  }
  return doc.save();
}

export interface StampImageOptions {
  image: { bytes: Uint8Array; kind: ImageKind };
  pageIndex: number;
  /** Top-left of the image as a proportion of page width / height (0–1, origin at user-visible top-left). */
  x: number;
  y: number;
  /** Image width as a proportion of page width; height is calculated based on the image aspect ratio. */
  width: number;
  /** Rotate counter-clockwise around image center (user-visible direction), e.g. 45 for diagonal watermarks. */
  rotateDeg?: number;
}

/** Place an image (signature, Chinese seal rendered with Skia) onto a page; rotated pages are placed in the direction seen by the user. */
export async function stampImage(bytes: Uint8Array, opts: StampImageOptions): Promise<Uint8Array> {
  assertNumber(opts.x, 0, 1);
  assertNumber(opts.y, 0, 1);
  assertNumber(opts.width, 0.001, 1);
  assertNumber(opts.rotateDeg ?? 0, -360, 360);
  const doc = await loadPdf(bytes);
  assertPageIndices([opts.pageIndex], doc.getPageCount());
  const page = doc.getPage(opts.pageIndex);
  const image = await embedImage(doc, opts.image);
  const view = pageView(page);
  const w = opts.width * view.width;
  const h = (w * image.height) / image.width;
  const rect = { p: opts.x * view.width, q: view.height * (1 - opts.y) - h, w, h };
  page.drawImage(image, { ...placeBox(view, rect, opts.rotateDeg ?? 0), width: w, height: h });
  return doc.save();
}

/**
 * Replace a page with an image (using the page size and orientation seen by the user). Redacted
 * or censored pages are handled this way: a covering image only blocks the view, and the text
 * underneath can still be selected and copied; after replacing with an image, the original text
 * is gone.
 */
export async function replacePageWithImage(
  bytes: Uint8Array,
  pageIndex: number,
  image: { bytes: Uint8Array; kind: ImageKind },
): Promise<Uint8Array> {
  const doc = await loadPdf(bytes);
  assertPageIndices([pageIndex], doc.getPageCount());
  const view = pageView(doc.getPage(pageIndex));
  const embedded = await embedImage(doc, image);
  const fresh = doc.insertPage(pageIndex, [view.width, view.height]);
  fresh.drawImage(embedded, { x: 0, y: 0, width: view.width, height: view.height });
  doc.removePage(pageIndex + 1);
  return doc.save();
}
