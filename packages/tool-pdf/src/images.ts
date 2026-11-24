import {
  PDFDocument,
  type PDFFont,
  type PDFHexString,
  type PDFImage,
  type PDFName,
  type PDFPage,
  type PDFRef,
  PageSizes,
  StandardFonts,
  TextRenderingMode,
  beginText,
  clip,
  endPath,
  endText,
  moveText,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  setCharacterSqueeze,
  setFontAndSize,
  setTextRenderingMode,
  showText,
} from 'pdf-lib';

import { type MergeResult, PdfError, assertNumber } from './core';
import { embedGlyphlessFont, glyphlessText } from './glyphless';

// Image to PDF: one page per image, formatted and centered according to page options. When an image
// carries recognized text, an invisible text layer is drawn on top (D-195): the PDF looks
// unchanged, but is searchable, selectable, and copyable.

export type ImageKind = 'jpeg' | 'png';

/** A line of text recognized on an image: pixel coordinates, origin at top-left. */
export interface TextLine {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Text of an image: width / height are the pixel dimensions of the image during recognition (coordinates are scaled relative to this, independent of scaling during embedding). */
export interface TextLayer {
  width: number;
  height: number;
  lines: readonly TextLine[];
}

/**
 * width / height are for reference only: layout uses the image's own pixel dimensions. PDFs do
 * not recognize EXIF orientation; callers should upright photos before passing them in.
 */
export interface ImageInput {
  bytes: Uint8Array;
  kind: ImageKind;
  width?: number;
  height?: number;
  /** Recognized text; optionally draws an invisible text layer. */
  text?: TextLayer;
}

export interface ImagePageOptions {
  /** 'fit': page matches image dimensions (72 dpi, long edge not exceeding 1700 pt) plus margins. */
  pageSize: 'a4' | 'letter' | 'fit';
  /** 'auto': landscape images use landscape pages. Ignored when 'fit'. */
  orientation: 'auto' | 'portrait' | 'landscape';
  /** 0–30 millimeters. */
  marginMm: number;
  /** contain: display completely; cover: fill the area within margins, cropping any overflow. */
  fit: 'contain' | 'cover';
}

const PT_PER_MM = 72 / 25.4;
const FIT_MAX_PT = 1700;

/** Embed JPEG as-is (without re-encoding); reports badImage if it cannot be parsed. */
export async function embedImage(
  doc: PDFDocument,
  image: { bytes: Uint8Array; kind: ImageKind },
  name?: string,
): Promise<PDFImage> {
  try {
    return image.kind === 'jpeg'
      ? await doc.embedJpg(image.bytes)
      : await doc.embedPng(image.bytes);
  } catch {
    throw new PdfError('badImage', name);
  }
}

export function assertImagePageOptions(opts: ImagePageOptions): void {
  assertNumber(opts.marginMm, 0, 30);
}

/** The two fonts used by the text layer: Helvetica for Latin alphabet; other characters (CJK, Russian, etc.) use the glyph-less font (D-266). */
export interface TextFonts {
  latin: PDFFont;
  other: PDFRef;
}

/**
 * Invisible text layer (D-195): each line is drawn at the recognition box position using the
 * invisible text rendering mode, scaled horizontally to fit the box width. Lines renderable by
 * Helvetica use it as before; remaining lines use the glyph-less font written in UTF-16 (D-266,
 * replacing the "skip" behavior in P-028).
 */
function drawTextLayer(
  page: PDFPage,
  placement: { x: number; y: number; width: number; height: number },
  layer: TextLayer,
  fonts: TextFonts,
): void {
  const charset = new Set(fonts.latin.getCharacterSet());
  const latinKey = page.node.newFontDictionary(fonts.latin.name, fonts.latin.ref);
  let otherKey: PDFName | null = null;
  const sx = placement.width / layer.width;
  const sy = placement.height / layer.height;
  for (const line of layer.lines) {
    const text = line.text.trim();
    if (!text) continue;
    const size = line.height * sy;
    if (size <= 0) continue;
    const latin = [...text].every((c) => charset.has(c.codePointAt(0)!));
    let key: PDFName;
    let encoded: PDFHexString;
    let natural: number;
    if (latin) {
      key = latinKey;
      encoded = fonts.latin.encodeText(text);
      natural = fonts.latin.widthOfTextAtSize(text, size);
    } else {
      otherKey ??= page.node.newFontDictionary('GlyphLessFont', fonts.other);
      key = otherKey;
      const glyphless = glyphlessText(text);
      encoded = glyphless.hex;
      natural = glyphless.ems * size;
    }
    if (natural <= 0) continue;
    // The baseline is slightly above the bottom of the box (descenders account for approx. 0.2 character height).
    const x = placement.x + line.x * sx;
    const y = placement.y + placement.height - (line.y + line.height) * sy + size * 0.2;
    page.pushOperators(
      beginText(),
      setFontAndSize(key, size),
      setTextRenderingMode(TextRenderingMode.Invisible),
      setCharacterSqueeze(((line.width * sx) / natural) * 100),
      moveText(x, y),
      showText(encoded),
      endText(),
    );
  }
}

/** Add a new page for an embedded image; adds an invisible text layer when text and font are provided. */
export function addImagePage(
  doc: PDFDocument,
  image: PDFImage,
  opts: ImagePageOptions,
  text?: { layer: TextLayer; fonts: TextFonts },
): void {
  const margin = opts.marginMm * PT_PER_MM;
  const { width: iw, height: ih } = image;
  let pageW: number;
  let pageH: number;
  if (opts.pageSize === 'fit') {
    const s = Math.min(1, FIT_MAX_PT / Math.max(iw, ih));
    pageW = iw * s + 2 * margin;
    pageH = ih * s + 2 * margin;
  } else {
    const [w, h] = opts.pageSize === 'a4' ? PageSizes.A4 : PageSizes.Letter;
    const landscape = opts.orientation === 'landscape' || (opts.orientation === 'auto' && iw > ih);
    [pageW, pageH] = landscape ? [h, w] : [w, h];
  }
  const page = doc.addPage([pageW, pageH]);
  const boxW = pageW - 2 * margin;
  const boxH = pageH - 2 * margin;
  const scale = (opts.fit === 'cover' ? Math.max : Math.min)(boxW / iw, boxH / ih);
  const width = iw * scale;
  const height = ih * scale;
  const placement = { x: (pageW - width) / 2, y: (pageH - height) / 2, width, height };
  if (opts.fit === 'cover') {
    // Clip to the area within margins to prevent the image from covering the margins.
    page.pushOperators(
      pushGraphicsState(),
      rectangle(margin, margin, boxW, boxH),
      clip(),
      endPath(),
    );
    page.drawImage(image, placement);
    page.pushOperators(popGraphicsState());
  } else {
    page.drawImage(image, placement);
  }
  if (text) drawTextLayer(page, placement, text.layer, text.fonts);
}

/** Convert images to PDF in order, one per page. */
export async function imagesToPdf(
  images: readonly ImageInput[],
  opts: ImagePageOptions,
): Promise<MergeResult> {
  if (images.length < 1) throw new PdfError('tooFew');
  assertImagePageOptions(opts);
  const doc = await PDFDocument.create();
  const fonts: TextFonts | null = images.some((i) => i.text?.lines.length)
    ? { latin: await doc.embedFont(StandardFonts.Helvetica), other: embedGlyphlessFont(doc) }
    : null;
  for (const image of images) {
    const text = image.text && fonts ? { layer: image.text, fonts } : undefined;
    addImagePage(doc, await embedImage(doc, image), opts, text);
  }
  return { bytes: await doc.save(), pageCount: doc.getPageCount() };
}
