import {
  OFFICE_MIME_BY_EXT,
  RunError,
  joinOcrParagraph,
  layoutOcrLines,
  polishOcrText,
  renderNameTemplate,
  t,
  tidyOcrText,
  type ActionImpl,
  type OcrLanguage,
  type RunItem,
} from '@morph/core';
import { boxesToEnhanced } from '@morph/tool-image';
import {
  applyNativeGraphics,
  canUseNativeGraphics,
  buildDocPage,
  buildSheetPage,
  leafBlocks,
  pagesWithoutTables,
  writeDocx,
  writeXlsx,
  type NativeGraphics,
  type DocDoc,
  type DocPage,
  type DocxImage,
  type Box,
  type LayoutRegion,
  type OcrBox,
  type TableDoc,
  type TablePage,
} from '@morph/tool-office';

import type { Pixels, RecognizedLine, VisionPlatform } from '../platform';
import {
  displayName,
  fileItems,
  freshName,
  imageForPage,
  ocrSourceItem,
  ocrSourceOf,
  writeItem,
  type RunServices,
} from './helpers';
import { resolveOcrLanguage } from '../ocr-language';

// OCR (T5): Use system OCR when the system supports the language (iOS Vision, D-085; Android ML
// Kit, D-087); otherwise, send each image to the OCR pack page (tesseract.js). Results stay
// on-device only (D-036).

type Impl = ActionImpl<RunServices>;

/** Long side of the image sent for OCR: larger sizes do not improve recognition rate, only slow it down. */
const OCR_INPUT_SIDE = 3500;

/**
 * Recognition language -> Vision language code (BCP 47). The first is the user's selected
 * language; add English when CJK or other scripts often contain English (brands, URLs, model
 * numbers).
 */
export const VISION_LANGUAGES: Record<OcrLanguage, readonly string[]> = {
  eng: ['en-US'],
  chi_sim: ['zh-Hans', 'en-US'],
  chi_tra: ['zh-Hant', 'en-US'],
  jpn: ['ja-JP', 'en-US'],
  kor: ['ko-KR', 'en-US'],
  fra: ['fr-FR', 'en-US'],
  deu: ['de-DE', 'en-US'],
  spa: ['es-ES', 'en-US'],
  por: ['pt-BR', 'en-US'],
  ita: ['it-IT', 'en-US'],
  rus: ['ru-RU', 'en-US'],
  vie: ['vi', 'en-US'],
};

/** Format OCR results by language (D-268): Convert incorrectly introduced traditional Chinese characters back to simplified Chinese in simplified Chinese, and use full-width punctuation for Chinese. */
function polish(text: string, lang: OcrLanguage): string {
  const kind = lang === 'chi_sim' ? 'zh-Hans' : lang === 'chi_tra' ? 'zh-Hant' : 'other';
  return polishOcrText(tidyOcrText(text), kind);
}

/** Scale bounding boxes proportionally to the size of another image (character positions are relative proportions within the line, so no conversion is needed). */
function scaleLines(
  lines: readonly RecognizedLine[],
  from: { width: number; height: number },
  to: { width: number; height: number },
): OcrBox[] {
  const kx = to.width / from.width;
  const ky = to.height / from.height;
  return lines.map((l) => ({
    ...l,
    x: l.x * kx,
    y: l.y * ky,
    width: l.width * kx,
    height: l.height * ky,
  }));
}

/**
 * Convert OCR results for a page to Excel. Coordinates belong to the line-detection image
 * (pixels): when an unenhanced image is available, perform recognition on it (D-267, more
 * accurate) and map boxes to the enhanced image; when unreadable or aspect ratio mismatches,
 * recognize on this image directly using pixels decoded during line detection.
 */
async function tableLines(
  vision: VisionPlatform,
  item: RunItem,
  pixels: Pixels,
  languages: readonly string[],
): Promise<{ lines: OcrBox[]; enhanced: boolean }> {
  const source = ocrSourceOf(item);
  if (source && item.width && item.height) {
    try {
      const layer = await vision.recognizeLines(source.uri, languages);
      const ratio = layer.width / layer.height / (source.width / source.height);
      if (Math.abs(ratio - 1) < 0.02) {
        const canvas = { width: item.width, height: item.height };
        const lines = boxesToEnhanced(layer.lines, layer, source, source.skew, canvas);
        return { lines: scaleLines(lines, canvas, pixels), enhanced: true };
      }
    } catch {
      // Recognize using this image.
    }
  }
  const layer = await vision.recognizeLines(item.uri, languages, pixels);
  return { lines: scaleLines(layer.lines, layer, pixels), enhanced: source !== null };
}

/**
 * Crop image regions from the original image (shared between Word and Excel conversion, D-328,
 * D-520): map boxes proportionally to the original, crop to JPG (file for the current run),
 * record path in the image block's src, put bytes in images. Uncropable images are not written to
 * files (blocks remain, and their position in the original image can be seen in the editor). page
 * is the size of the box's source image (line-detection image).
 */
async function cropPictures(
  services: RunServices,
  item: RunItem,
  page: { width: number; height: number },
  pictures: readonly { box: Box; src?: string }[],
  images: Map<string, DocxImage>,
  name: (k: number) => string,
): Promise<void> {
  if (!pictures.length) return;
  const { files } = services;
  const size =
    item.width && item.height
      ? { width: item.width, height: item.height }
      : await files.imageSize(item.uri);
  const kx = size.width / page.width;
  const ky = size.height / page.height;
  for (const [k, block] of pictures.entries()) {
    if (block.src && images.has(block.src)) continue;
    const x = Math.max(0, Math.round(block.box.x * kx));
    const y = Math.max(0, Math.round(block.box.y * ky));
    const crop = {
      x,
      y,
      width: Math.max(1, Math.min(size.width - x, Math.round(block.box.width * kx))),
      height: Math.max(1, Math.min(size.height - y, Math.round(block.box.height * ky))),
    };
    try {
      const out = await files.transformImage(
        item.uri,
        { crop },
        { format: 'jpeg', quality: 0.85 },
        services.runId,
        name(k),
      );
      block.src = out.uri;
      images.set(out.uri, {
        bytes: await files.readUri(out.uri),
        width: out.width,
        height: out.height,
      });
    } catch {
      // Uncropable images are not written to files.
    }
  }
}

/** Machine-generated name: UUID or a long hex string. */
const MACHINE_NAME = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16}/i;

/** Fraction of a's area that falls within b. */
function shareIn(a: Box, b: Box): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? (w * h) / (a.width * a.height || 1) : 0;
}

export const OCR_IMPLS: Record<string, Impl> = {
  // Scanned document to Excel (D-272): Find table lines, recognize text, and build tables for each
  // image, producing an xlsx file (one worksheet per page), alongside a TableDoc stored for the
  // result page's "Put on desk" and file room editing (D-366). Recognized text stays on-device.
  async 'ocr.toExcel'(input, params, ctx) {
    const items = fileItems(input);
    // "Auto" chooses based on phone language (D-278).
    const lang = resolveOcrLanguage(params.lang, ctx.locale);
    const scope = params.scope === 'tables' ? 'tables' : 'all';
    const languages = VISION_LANGUAGES[lang];
    const vision = ctx.services.files.vision;
    // Requires line positions: tesseract only provides text and cannot be used.
    if (!vision?.tablePixels || !vision.supportsLanguage(languages[0]!)) {
      throw new RunError('tableUnsupported');
    }
    const pages: TablePage[] = [];
    const images = new Map<string, DocxImage>();
    for (const [i, item] of items.entries()) {
      ctx.throwIfCancelled();
      let pixels: Pixels;
      try {
        pixels = await vision.tablePixels(item.uri);
      } catch {
        throw new RunError('unreadable', { name: displayName(item) });
      }
      let found: Awaited<ReturnType<typeof tableLines>>;
      try {
        found = await tableLines(vision, item, pixels, languages);
      } catch (e) {
        throw new RunError('unexpected', { detail: String(e instanceof Error ? e.message : e) });
      }
      ctx.throwIfCancelled();
      // Layout analysis (D-520): Image regions are cropped into pictures; forms and text region grids are not treated as tables. Errors do not cause the entire run to fail: continue recognizing tables and text as usual.
      let regions: LayoutRegion[] | null = null;
      try {
        regions = (await vision.detectLayout?.(pixels)) ?? null;
      } catch {
        regions = null;
      }
      ctx.throwIfCancelled();
      const page = buildSheetPage(
        {
          image: pixels,
          lines: found.lines,
          ...(regions ? { regions } : {}),
          name: t(ctx.locale, 'tableSheetName', { n: i + 1 }),
          source: item.uri,
          // Enhanced images have already been straightened via findSkew; unenhanced photos estimate skew here.
          ...(found.enhanced ? { skew: 0 } : {}),
        },
        { joinLines: (lines) => polish(layoutOcrLines(lines), lang) },
      );
      await cropPictures(
        ctx.services,
        item,
        page,
        page.blocks.filter((b) => b.kind === 'image'),
        images,
        (k) => `excel/${i + 1}-${k + 1}.jpg`,
      );
      pages.push(page);
      ctx.progress(i + 1, items.length);
    }
    if (pages.every((p) => p.blocks.length === 0)) {
      throw new RunError('notFound', { name: displayName(items[0]!) });
    }
    const doc: TableDoc = { version: 3, scope, pages };
    // Name: if it's a photo with a user-provided name, use it; if the name is a series of numbers
    // (common for shared-in photos) or multiple pages merged into one file, use "Table-Date",
    // matching scanned "Scan-Date".
    const name =
      items.length === 1 && !MACHINE_NAME.test(items[0]!.name)
        ? items[0]!.name
        : renderNameTemplate(t(ctx.locale, 'tableFileName'), { now: ctx.now() });
    const xlsx = await writeItem(ctx.services, writeXlsx(doc, images), {
      name,
      ext: 'xlsx',
      mimeType: OFFICE_MIME_BY_EXT.xlsx!,
    });
    const stored = await ctx.services.files.writeRunFile(
      ctx.services.runId,
      freshName(name, 'json'),
      new TextEncoder().encode(JSON.stringify(doc)),
    );
    const missing = pagesWithoutTables(doc);
    return {
      type: 'files',
      items: [
        {
          ...xlsx,
          tableDoc: {
            uri: stored.uri,
            for: xlsx.uri,
            ...(missing.length ? { pagesWithoutTables: missing } : {}),
          },
        },
      ],
    };
  },

  // Scanned document to Word (D-328): Recognize text for each image, perform layout analysis
  // (segment by position only when models are not installed), find lined tables, crop image regions
  // from the original image, and create a docx file (one page per image), alongside a DocDoc stored
  // for the result page's "Put on desk" and file room editing (D-366). Recognized text stays
  // on-device.
  async 'ocr.toWord'(input, params, ctx) {
    const items = fileItems(input);
    // "Auto" chooses based on phone language (D-278).
    const lang = resolveOcrLanguage(params.lang, ctx.locale);
    const languages = VISION_LANGUAGES[lang];
    const { files } = ctx.services;
    const vision = files.vision;
    // Requires line positions: tesseract only provides text and cannot be used.
    if (!vision?.tablePixels || !vision.supportsLanguage(languages[0]!)) {
      throw new RunError('wordUnsupported');
    }
    const pages: DocPage[] = [];
    const images = new Map<string, DocxImage>();
    for (const [i, item] of items.entries()) {
      ctx.throwIfCancelled();
      let pixels: Pixels;
      try {
        pixels = await vision.tablePixels(item.uri);
      } catch {
        throw new RunError('unreadable', { name: displayName(item) });
      }
      let found: Awaited<ReturnType<typeof tableLines>>;
      try {
        found = await tableLines(vision, item, pixels, languages);
      } catch (e) {
        throw new RunError('unexpected', { detail: String(e instanceof Error ? e.message : e) });
      }
      ctx.throwIfCancelled();
      // Layout analysis errors do not cause the entire run to fail: segment by position only.
      let regions: LayoutRegion[] | null = null;
      try {
        regions = (await vision.detectLayout?.(pixels)) ?? null;
      } catch {
        regions = null;
      }
      ctx.throwIfCancelled();
      const pageInput = {
        image: pixels,
        lines: found.lines,
        ...(regions ? { regions } : {}),
        source: item.uri,
        ...(item.pageSize?.for === item.uri
          ? { paper: { width: item.pageSize.width, height: item.pageSize.height } }
          : {}),
        // Enhanced images have already been straightened via findSkew; unenhanced photos estimate skew here.
        ...(found.enhanced ? { skew: 0 } : {}),
      };
      const buildOptions: Parameters<typeof buildDocPage>[1] = {
        joinLines: (lines) => polish(layoutOcrLines(lines), lang),
        joinParagraph: (lines) => polish(joinOcrParagraph(lines), lang),
      };
      let page = buildDocPage(pageInput, buildOptions);
      // PDF source drawing reads only source files explicitly authorized for this run; if images are modified, forces don't match, falling back to the scan path.
      const pdf = item.pdfSource;
      const runtime = ctx.services.packs?.runtime;
      if (pdf?.for === item.uri && runtime && canUseNativeGraphics(page)) {
        try {
          // Native drawing uses PDF's own point coordinates; Word pages may already be scaled (pages larger than A3, fitPaper).
          const paper = pageInput.paper ?? page.paper!;
          const toPoints = (box: Box) => ({
            x: (box.x / page.width) * paper.width,
            y: (box.y / page.height) * paper.height,
            width: (box.width / page.width) * paper.width,
            height: (box.height / page.height) * paper.height,
          });
          const native = await runtime.call<
            NativeGraphics & {
              applicable: boolean;
              width: number;
              height: number;
              crops: { png: string; width: number; height: number }[];
              backgroundPng?: string;
              watermarks?: Box[];
              watermarkInk?: number[];
            }
          >(
            'pdfview',
            'graphics',
            {
              file: 'input',
              index: pdf.page,
              maxSide: Math.max(pixels.width, pixels.height),
              figures: leafBlocks(page)
                .filter((b) => b.kind === 'image')
                .map((b) => toPoints(b.box)),
              candidates: (regions ?? [])
                .filter((r) => r.kind === 'image')
                .map((r) => toPoints(r.box)),
              lines: found.lines.map((l) => ({
                ...toPoints(l),
                chars: l.text.replace(/\s/g, '').length,
              })),
            },
            { input: pdf.uri },
          );
          ctx.throwIfCancelled();
          if (native.applicable && native.crops?.length === native.owned.length) {
            const store = async (
              data: { png: string; width: number; height: number },
              suffix: string,
            ) => {
              const bytes = Uint8Array.from(atob(data.png), (c) => c.charCodeAt(0));
              const stored = await files.writeRunFile(
                ctx.services.runId,
                `word/${i + 1}-${suffix}.png`,
                bytes,
              );
              images.set(stored.uri, { bytes, width: data.width, height: data.height });
              return stored.uri;
            };
            const sources: string[] = [];
            for (const [k, crop] of native.crops.entries())
              sources.push(await store(crop, `figure-${k}`));
            const background = native.backgroundPng
              ? await store(
                  { png: native.backgroundPng, width: native.width, height: native.height },
                  'decoration',
                )
              : undefined;
            const toPixels = (b: Box) => ({
              x: (b.x / paper.width) * pixels.width,
              y: (b.y / paper.height) * pixels.height,
              width: (b.width / paper.width) * pixels.width,
              height: (b.height / paper.height) * pixels.height,
            });
            page = buildDocPage(
              {
                ...pageInput,
                // Watermarks ("MUSTER" in EU sample 071) are not graphics: ignore image regions found there by the layout model, and text recognized from watermark strokes is not body text.
                lines: found.lines.filter((_, k) => !native.watermarkInk?.includes(k)),
                ...(regions
                  ? {
                      regions: regions.filter(
                        (r) =>
                          r.kind !== 'image' ||
                          !native.watermarks?.some((w) => shareIn(r.box, toPixels(w)) >= 0.5),
                      ),
                    }
                  : {}),
                prior: page,
                nativeFigures: native.owned.map(toPixels),
                // Native text not rendered into crops (colors lists only these): overlapping recognized lines in the image are kept as body text.
                nativeText: native.colors.map((c) => toPixels(c.box)),
              },
              buildOptions,
            );
            page = applyNativeGraphics(page, native, sources, background);
          }
        } catch {
          // Unsupported font cropping, scanned pages, or drawing failures preserve the original editable OCR results.
          ctx.throwIfCancelled();
        }
      }
      // Image regions: map proportionally to the original and crop (JPG, file for the current run). Images in side-by-side rows (D-331) must also be cropped.
      await cropPictures(
        ctx.services,
        item,
        page,
        leafBlocks(page).filter((b) => b.kind === 'image' && !b.background),
        images,
        (k) => `word/${i + 1}-${k + 1}.jpg`,
      );
      pages.push(page);
      ctx.progress(i + 1, items.length);
    }
    if (pages.every((p) => p.blocks.length === 0)) {
      throw new RunError('notFound', { name: displayName(items[0]!) });
    }
    const doc: DocDoc = { version: 5, pages };
    // File names are the same as Excel conversion (D-298): Use user-provided name for a photo if available, otherwise "Document-Date".
    const name =
      items.length === 1 && !MACHINE_NAME.test(items[0]!.name)
        ? items[0]!.name
        : renderNameTemplate(t(ctx.locale, 'wordFileName'), { now: ctx.now() });
    const docx = await writeItem(ctx.services, writeDocx(doc, images), {
      name,
      ext: 'docx',
      mimeType: OFFICE_MIME_BY_EXT.docx!,
    });
    const stored = await files.writeRunFile(
      ctx.services.runId,
      freshName(name, 'json'),
      new TextEncoder().encode(JSON.stringify(doc)),
    );
    return { type: 'files', items: [{ ...docx, docDoc: { uri: stored.uri, for: docx.uri } }] };
  },

  async 'ocr.recognize'(input, params, ctx) {
    const items = fileItems(input);
    // "Auto" chooses based on phone language (D-278).
    const lang = resolveOcrLanguage(params.lang, ctx.locale);
    const { packs } = ctx.services;
    // Languages unsupported by system recognition (e.g., Russian on Android ML Kit) fall back to the OCR pack.
    const native = ctx.services.files.vision;
    const vision = native?.supportsLanguage(VISION_LANGUAGES[lang][0]!) ? native : null;
    if (!vision && !packs) throw new RunError('packFailed', { detail: 'ocr' });
    const texts: string[] = [];
    for (const [i, original] of items.entries()) {
      ctx.throwIfCancelled();
      // System recognition uses the unenhanced image (D-267: enhancement offers no help, and
      // black-and-white erases faint text); use this image when unreadable. Tesseract recognizes
      // more accurately on enhanced images as before.
      const source = vision ? ocrSourceOf(original) : null;
      if (source) {
        try {
          const page = await imageForPage(
            ctx.services,
            ocrSourceItem(original, source),
            OCR_INPUT_SIDE,
          );
          const text = polish(await vision!.recognizeText(page.uri, VISION_LANGUAGES[lang]), lang);
          if (text) texts.push(text);
          ctx.progress(i + 1, items.length);
          continue;
        } catch {
          // Fall back to using the enhanced image.
        }
      }
      const item = await imageForPage(ctx.services, original, OCR_INPUT_SIDE);
      let raw: string;
      try {
        raw = vision
          ? await vision.recognizeText(item.uri, VISION_LANGUAGES[lang])
          : (
              await packs!.runtime.call<{ text: string }>(
                'ocr',
                'recognize',
                { file: 'input', lang },
                { input: item.uri },
              )
            ).text;
      } catch (e) {
        const detail = String(e instanceof Error ? e.message : e);
        throw new RunError(vision ? 'unexpected' : 'packFailed', { detail });
      }
      const text = polish(raw, lang);
      if (text) texts.push(text);
      ctx.progress(i + 1, items.length);
    }
    if (texts.length === 0) throw new RunError('notFound', { name: displayName(items[0]!) });
    // Text stays on-device only: results can be copied on the result page, subsequent steps can save as files or generate PDFs, and it is never sent to the AI.
    return { type: 'text', text: texts.join('\n\n'), name: items[0]!.name };
  },
};
