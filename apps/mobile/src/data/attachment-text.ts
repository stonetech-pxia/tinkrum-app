import type { PackNeed, TextPage } from '@morph/core';
import { decodeQr, downscaleRgba } from '@morph/tool-qr';

import type { PackRuntime } from '../packs/bridge';
import type { AssetRecord } from '../storage/types';
import type { FilePlatform } from '../runtime/platform';

// New record form candidate values (D-394): reads text from attachments (with coordinates),
// device-only, used solely for scoring candidate values, not stored, excluded from records, and
// never sent to AI (D-036). Photos use on-device OCR (PP-OCRv6, D-269); PDFs first check for a text
// layer, and if missing (scanned documents), render the first two pages as images for recognition.
// Reads at most 3 attachments, up to 2 pages each. Intermediate files are placed in a temporary run
// directory (`cache/runs/<runId>/`) and deleted on success, failure, or cancellation. Original
// files in user photo library and "Files" are untouched: attachments are Morph's own copies,
// read-only here.

/** Maximum number of attachments to read, and pages per attachment. */
export const MAX_READ_FILES = 3;
export const MAX_READ_PAGES = 2;
/** Longest side of image sent for recognition (matches PP-OCRv6 input size, D-269). */
const OCR_SIDE = 2000;
/** Longest side scaled down to before decoding QR codes (matches "Scan QR code"). */
const QR_SIDE = 1600;

export type ReadableKind = 'image' | 'pdf';

/** Whether text can be read from this attachment: photos (excluding videos and GIFs) and PDFs. */
export function readableKind(asset: Pick<AssetRecord, 'mimeType' | 'name'>): ReadableKind | null {
  const mime = asset.mimeType.toLowerCase();
  if (mime === 'application/pdf' || /\.pdf$/i.test(asset.name)) return 'pdf';
  if (mime.startsWith('image/') && mime !== 'image/gif') return 'image';
  return null;
}

export interface AttachmentTextDeps {
  files: FilePlatform;
  packs: { runtime: PackRuntime; isInstalled(id: string): Promise<boolean> } | null;
  /** Languages used for recognition (BCP 47, first is primary). */
  languages: readonly string[];
  newRunId: () => string;
}

/** Missing downloads required on this device to read these attachments (always prompts user first, D-064). */
export async function missingPacks(
  kinds: readonly ReadableKind[],
  deps: AttachmentTextDeps,
): Promise<PackNeed[]> {
  const out: PackNeed[] = [];
  const pack = ocrPack(deps);
  if (pack && kinds.includes('image') && !(await deps.packs?.isInstalled(pack)))
    out.push({ pack, optional: false });
  if (kinds.includes('pdf') && deps.packs && !(await deps.packs.isInstalled('pdfview')))
    out.push({ pack: 'pdfview', optional: false });
  return out;
}

/** OCR model required to download for recognizing this language (PP-OCRv6); null if supported by system out of the box. */
function ocrPack(deps: AttachmentTextDeps): string | null {
  const model = deps.files.vision?.ocrModel;
  const code = deps.languages[0]?.split('-')[0];
  return model && code && model.languages.includes(code) ? model.pack : null;
}

async function canRecognize(deps: AttachmentTextDeps): Promise<boolean> {
  const vision = deps.files.vision;
  if (!vision) return false;
  const pack = ocrPack(deps);
  if (pack) return (await deps.packs?.isInstalled(pack)) === true;
  return vision.supportsLanguage(deps.languages[0] ?? 'en');
}

/**
 * Reads QR codes from the first few photos (D-423, called only by business card table form):
 * scales down and decodes like "Scan QR code", pure JS, no download needed. Silently ignores
 * unreadable photos or missing codes; OCR continues normally. Content is used for candidates
 * only, never stored or sent to AI.
 */
export async function readAttachmentCodes(
  assets: readonly AssetRecord[],
  deps: Pick<AttachmentTextDeps, 'files'>,
  signal: AbortSignal,
): Promise<string[]> {
  const found: string[] = [];
  const images = assets.filter((a) => readableKind(a) === 'image').slice(0, MAX_READ_FILES);
  for (const asset of images) {
    if (signal.aborted) throw new ReadCancelled();
    try {
      const pixels = await deps.files.imagePixels(deps.files.fileUri(asset.path), QR_SIDE);
      const text = decodeQr(downscaleRgba(pixels, QR_SIDE));
      if (text) found.push(text);
    } catch {
      // Unreadable attachment: skipped.
    }
  }
  if (signal.aborted) throw new ReadCancelled();
  return found;
}

export class ReadCancelled extends Error {
  constructor() {
    super('cancelled');
  }
}

/**
 * Reads text from the first few attachments (one set of boxed lines per page). Skips unreadable
 * attachments without throwing; skips photos if OCR model not installed, and PDFs if PDF preview
 * not installed. Immediately finishes with ReadCancelled when signal aborts current step.
 */
export async function readAttachmentPages(
  assets: readonly AssetRecord[],
  deps: AttachmentTextDeps,
  signal: AbortSignal,
): Promise<TextPage[]> {
  return readPagesOf(
    assets.flatMap((asset) => {
      const kind = readableKind(asset);
      return kind ? [{ kind, uri: deps.files.fileUri(asset.path) }] : [];
    }),
    deps,
    signal,
  );
}

/** A file to be read: type and URI are already known (can be an attachment or a received uncommitted file). */
export interface ReadItem {
  kind: ReadableKind;
  uri: string;
}

/** Reads text from these files (shared by attachments and received files): read-only, intermediate files deleted after reading. */
export async function readPagesOf(
  items: readonly ReadItem[],
  deps: AttachmentTextDeps,
  signal: AbortSignal,
): Promise<TextPage[]> {
  const { files } = deps;
  const vision = files.vision;
  const check = () => {
    if (signal.aborted) throw new ReadCancelled();
  };
  const ocr = await canRecognize(deps);
  const pdf = deps.packs !== null && (await deps.packs.isInstalled('pdfview'));
  check();
  const runId = deps.newRunId();
  const pages: TextPage[] = [];
  try {
    const recognize = async (uri: string) => {
      const layer = await vision!.recognizeLines(uri, deps.languages);
      check();
      pages.push({ width: layer.width, height: layer.height, lines: layer.lines });
    };
    let n = 0;
    for (const { kind, uri } of items) {
      if (n >= MAX_READ_FILES) continue;
      n++;
      try {
        if (kind === 'image') {
          if (!ocr) continue;
          // Converts to JPG first (formats like HEIC may not be decodable during recognition), scales down if too large.
          const size = await files.imageSize(uri);
          check();
          const k = Math.min(1, OCR_SIDE / Math.max(size.width, size.height));
          const resize = {
            width: Math.max(1, Math.round(size.width * k)),
            height: Math.max(1, Math.round(size.height * k)),
          };
          const jpg = await files.transformImage(
            uri,
            k < 1 ? { resize } : {},
            { format: 'jpeg', quality: 0.92 },
            runId,
            `page-${n}.jpg`,
          );
          check();
          await recognize(jpg.uri);
          continue;
        }
        if (!pdf) continue;
        const layer = await deps.packs!.runtime.call<{ count: number; pages: TextPage[] }>(
          'pdfview',
          'lines',
          { file: 'input', pages: MAX_READ_PAGES },
          { input: uri },
        );
        check();
        const withText = layer.pages.filter((p) => p.lines.length > 0);
        if (withText.length > 0) {
          pages.push(...withText);
          continue;
        }
        // Scanned document: no text layer, renders first two pages as images before recognizing.
        if (!ocr) continue;
        const count = Math.min(layer.count, MAX_READ_PAGES);
        const images = await deps.packs!.runtime.call<{ index: number; data: string }[]>(
          'pdfview',
          'render',
          {
            file: 'input',
            pages: Array.from({ length: count }, (_, i) => i),
            maxSide: OCR_SIDE,
            quality: 0.9,
          },
          { input: uri },
        );
        check();
        for (const image of images) {
          const bytes = Uint8Array.from(atob(image.data), (c) => c.charCodeAt(0));
          const out = await files.writeRunFile(runId, `pdf-${n}-${image.index + 1}.jpg`, bytes);
          check();
          await recognize(out.uri);
        }
      } catch (e) {
        if (e instanceof ReadCancelled) throw e;
        // This one cannot be read: skipped, does not affect other attachments.
      }
    }
    return pages;
  } finally {
    await files.removeRun(runId).catch(() => undefined);
  }
}
