import type { FilePlatform } from '../runtime/platform';

/** Maximum retained text length (even a very long PDF retains only this leading portion, which is sufficient for searching). */
const MAX_TEXT = 200_000;

/**
 * Text within files (D-455, exception to invariant 14): when a user scans, shares, opens, saves a
 * file, or stores a file into the document library, PDFs have their text layer read and images
 * are recognized on-device. This text is stored alongside the file and deleted together with it.
 * Local only, never enters configuration and never sent to the AI. If unreadable or OCR package
 * is not installed (no download triggered for this), no text is stored and no error is thrown.
 */
export async function indexAssetText(
  files: FilePlatform,
  asset: { path: string; mimeType: string },
): Promise<void> {
  if (!files.saveAssetText || !files.vision) return;
  const uri = files.fileUri(asset.path);
  let text: string | null = null;
  try {
    if (asset.mimeType === 'application/pdf') text = (await files.vision.pdfText?.(uri)) ?? null;
    // PP-OCRv6 recognizes Chinese, English, Japanese, French, German, Spanish, Portuguese, and Italian using a single model (D-269): language is used solely to select the engine.
    else if (asset.mimeType.startsWith('image/'))
      text = await files.vision.recognizeText(uri, ['en']);
  } catch {
    text = null;
  }
  const clean = text?.trim();
  if (clean) await files.saveAssetText(asset.path, clean.slice(0, MAX_TEXT)).catch(() => undefined);
}
