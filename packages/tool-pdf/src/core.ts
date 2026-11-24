import { PDFDocument } from 'pdf-lib';

// Common types, errors, and loading logic shared by all PDF functions.

export type PdfErrorCode =
  | 'tooFew'
  | 'encrypted'
  | 'unreadable'
  /** Page number out of bounds, duplicate, or page rule unparseable. */
  | 'badRange'
  /** Numeric parameter out of bounds or invalid format (margins, font size, color, etc.). */
  | 'badOption'
  /** Image bytes cannot be embedded according to the declared format. */
  | 'badImage'
  /** Text unencodable in standard fonts (WinAnsi), such as Chinese. */
  | 'unsupportedText'
  /** Form field does not exist, or value does not match field type. */
  | 'badField';

export class PdfError extends Error {
  constructor(
    readonly code: PdfErrorCode,
    readonly fileName?: string,
    readonly fieldName?: string,
  ) {
    super([code, fileName, fieldName].filter(Boolean).join(': '));
  }
}

export interface PdfInput {
  name: string;
  bytes: Uint8Array;
}

export interface MergeResult {
  bytes: Uint8Array;
  pageCount: number;
}

/** Note: pdf-lib's error classes are ES5 build outputs, so `instanceof EncryptedPDFError` is always false, so switch to ignoring encryption during initial parsing and checking isEncrypted afterwards. */
// Load PDF; throws PdfError (with filename, if any) if encrypted or corrupted.
export async function loadPdf(bytes: Uint8Array, name?: string): Promise<PDFDocument> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  } catch {
    throw new PdfError('unreadable', name);
  }
  if (doc.isEncrypted) throw new PdfError('encrypted', name);
  return doc;
}

/** Numeric value must be a finite number within [min, max], otherwise treated as a parameter error. */
export function assertNumber(value: number, min: number, max: number): void {
  if (!Number.isFinite(value) || value < min || value > max) throw new PdfError('badOption');
}

/** Page list cannot be empty, indices must be integers within [0, pageCount), and must not contain duplicates. */
export function assertPageIndices(indices: readonly number[], pageCount: number): void {
  if (indices.length < 1) throw new PdfError('badRange');
  for (const i of indices) {
    if (!Number.isInteger(i) || i < 0 || i >= pageCount) throw new PdfError('badRange');
  }
  if (new Set(indices).size !== indices.length) throw new PdfError('badRange');
}

// WinAnsi (pdf-lib standard font encoding) = printable ASCII, Latin-1 supplement, plus the following 27 characters.
const WIN_ANSI_EXTRA = new Set([
  0x152, 0x153, 0x160, 0x161, 0x178, 0x17d, 0x17e, 0x192, 0x2c6, 0x2dc, 0x2013, 0x2014, 0x2018,
  0x2019, 0x201a, 0x201c, 0x201d, 0x201e, 0x2020, 0x2021, 0x2022, 0x2026, 0x2030, 0x2039, 0x203a,
  0x20ac, 0x2122,
]);

/**
 * Whether text can be rendered using standard fonts (such as Helvetica). When it cannot (e.g.,
 * Chinese, emoji, newlines), the app should instead use Skia to render the text to a PNG and use
 * stampImage.
 */
export function canEncodeStandardText(text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    const ok = (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff) || WIN_ANSI_EXTRA.has(cp);
    if (!ok) return false;
  }
  return true;
}

/** Standard Error thrown by pdf-lib when a standard font cannot encode the text. */
export function isEncodingError(e: unknown): boolean {
  return e instanceof Error && e.message.includes('cannot encode');
}
