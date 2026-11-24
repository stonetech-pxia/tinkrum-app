import { t, RunCancelled, RunError, type ActionImpl, type RunItem } from '@morph/core';

import { searchSharedQuality } from '@morph/tool-image';
import {
  openForCompression,
  pageInfo,
  picturePagesPdf,
  type PdfReplacement,
} from '@morph/tool-pdf';

import { formatBytes } from './image';
import { MB, fileItems, freshName, readItem, type RunServices } from './helpers';
import { guard, renderPages, writePdf } from './pdf';

// Compress PDF (D-145): Initially recompress internal images only (preserving text, links, and
// tables); when target size is not met, follow whenTooBig: ask the user ("Convert to images / Use
// current"), render each page as an image (requires PDF preview to download content), or preserve
// text. Image downscaling and encoding use the system encoder (expo-image-manipulator), sharing a
// single quality and scale across all images (D-073).

type Impl = ActionImpl<RunServices>;
type Ctx = Parameters<Impl>[2];

/** Initial limit for the long side of images: phone-captured scans are often 4000 pixels, which is unnecessary for screen viewing or printing. */
const MAX_PICTURE_SIDE = 2400;
/** Long side of each rendered page when converting to images. */
const PAGE_SIDE = 2000;
const MAX_QUALITY = 0.8;
/**
 * Maximum downscaling factor for images when preserving text (relative to 2400 long side, approx
 * 960 pixels, approx 115 dpi on A4, text still readable); smaller than this stops to ask the user
 * whether to convert to images.
 */
const MIN_PICTURE_SCALE = 0.4;
/** Maximum downscaling factor per page when converting to images (approx 600 pixels). */
const MIN_PAGE_SCALE = 0.3;

const fileName = (item: RunItem) => `${item.name}.${item.ext}`;

/** Prompt string used when target size cannot be reached (text is written here, not AI-generated). */
function tooBigQuestion(
  locale: import('@morph/core').Locale,
  name: string,
  target: string,
  got: string,
) {
  return {
    title: t(locale, 'pdfCompressionLimit', { name, target }),
    message: t(locale, 'pdfCompressionChoice', { got }),
    options: [t(locale, 'pdfTurnIntoPictures'), t(locale, 'pdfKeepCurrent', { got })],
  };
}

/** Preserve text and compress images only: returns the compressed PDF (which may still exceed the target). */
async function recompressPictures(
  ctx: Ctx,
  item: RunItem,
  bytes: Uint8Array,
  target: number,
): Promise<Uint8Array> {
  const { files, runId } = ctx.services;
  const compressor = await guard(fileName(item), () => openForCompression(bytes, fileName(item)));
  if (compressor.pictures.length === 0)
    return guard(fileName(item), () => compressor.build(new Map()));
  // Original images written as temporary files and passed to the system encoder.
  const sources: { id: number; uri: string; width: number; height: number; stored: number }[] = [];
  for (const p of compressor.pictures) {
    ctx.throwIfCancelled();
    const source = await guard(fileName(item), async () => p.source());
    const written = await files.writeRunFile(
      runId,
      freshName(`${item.name}-${p.id}`, source.kind === 'jpeg' ? 'jpg' : 'png'),
      source.bytes,
    );
    sources.push({
      id: p.id,
      uri: written.uri,
      width: p.width,
      height: p.height,
      stored: p.storedBytes,
    });
  }
  let chosen = new Map<number, PdfReplacement>();
  await searchSharedQuality({
    targetBytes: target,
    overheadBytes: compressor.otherBytes,
    maxQuality: MAX_QUALITY,
    minScale: MIN_PICTURE_SCALE,
    encodeAll: async (quality, scale) => {
      chosen = new Map();
      let total = 0;
      for (const s of sources) {
        ctx.throwIfCancelled();
        const k = Math.min(1, MAX_PICTURE_SIDE / Math.max(s.width, s.height)) * scale;
        const resize =
          k < 1
            ? {
                width: Math.max(1, Math.round(s.width * k)),
                height: Math.max(1, Math.round(s.height * k)),
              }
            : undefined;
        let out;
        try {
          out = await files.transformImage(
            s.uri,
            resize ? { resize } : {},
            { format: 'jpeg', quality },
            runId,
            freshName(`${item.name}-${s.id}`, 'jpg'),
          );
        } catch {
          // Images that the system cannot decode (uncommon color formats) are preserved as-is.
          total += s.stored;
          continue;
        }
        if (out.size < s.stored) {
          chosen.set(s.id, {
            bytes: await files.readUri(out.uri),
            width: out.width,
            height: out.height,
          });
          total += out.size;
        } else {
          total += s.stored;
        }
      }
      return total;
    },
  });
  // The final encoding search uses the selected parameters (guaranteed by size-search).
  return guard(fileName(item), () => compressor.build(chosen));
}

/** Render each page as an image, re-layout as PDF according to the original paper size, compressed within the target limit. */
async function picturePages(
  ctx: Ctx,
  item: RunItem,
  bytes: Uint8Array,
  target: number,
): Promise<Uint8Array> {
  const { files, runId } = ctx.services;
  if (!(await ctx.services.ensurePack?.('pdfview'))) throw new RunCancelled();
  const sizes = await guard(fileName(item), () => pageInfo(bytes));
  const rendered = await renderPages(ctx, item, { maxSide: PAGE_SIDE, quality: 0.9 });
  let jpegs: Uint8Array[] = [];
  const result = await searchSharedQuality({
    targetBytes: target,
    overheadBytes: 2048 + rendered.length * 1024,
    maxQuality: MAX_QUALITY,
    minScale: MIN_PAGE_SCALE,
    encodeAll: async (quality, scale) => {
      jpegs = [];
      let total = 0;
      for (const page of rendered) {
        ctx.throwIfCancelled();
        const w = page.width ?? PAGE_SIDE;
        const h = page.height ?? PAGE_SIDE;
        const out = await files.transformImage(
          page.uri,
          scale < 1
            ? {
                resize: {
                  width: Math.max(1, Math.round(w * scale)),
                  height: Math.max(1, Math.round(h * scale)),
                },
              }
            : {},
          { format: 'jpeg', quality },
          runId,
          freshName(page.name, 'jpg'),
        );
        jpegs.push(await files.readUri(out.uri));
        total += out.size;
      }
      return total;
    },
  });
  const pdf = await guard(fileName(item), () =>
    picturePagesPdf(
      jpegs.map((jpeg, i) => ({
        jpeg,
        width: sizes[i]?.width ?? 595,
        height: sizes[i]?.height ?? 842,
      })),
    ),
  );
  if (!result.met && pdf.bytes.length > target) {
    throw new RunError('targetNotMet', {
      name: fileName(item),
      target: formatBytes(target, ctx.locale),
      got: formatBytes(pdf.bytes.length, ctx.locale),
    });
  }
  return pdf.bytes;
}

export const PDF_COMPRESS_IMPLS: Record<string, Impl> = {
  async 'pdf.compress'(input, params, ctx) {
    const { maxMB, whenTooBig } = params as {
      maxMB: number;
      whenTooBig: 'ask' | 'images' | 'keepText';
    };
    const target = maxMB * MB;
    const items = fileItems(input);
    const out: RunItem[] = [];
    for (const [i, item] of items.entries()) {
      ctx.throwIfCancelled();
      ctx.progress(i, items.length);
      // Already small enough: pass as-is to the next step.
      if (item.size <= target) {
        out.push(item);
        continue;
      }
      const bytes = await readItem(ctx.services, item);
      let best = await recompressPictures(ctx, item, bytes, target);
      if (best.length > bytes.length) best = bytes;
      if (best.length > target) {
        let choice = whenTooBig;
        if (choice === 'ask') {
          const q = tooBigQuestion(
            ctx.locale,
            fileName(item),
            formatBytes(target, ctx.locale),
            formatBytes(best.length, ctx.locale),
          );
          const answer = await ctx.services.ui.choose(q.title, q.message, q.options);
          if (answer === null) throw new RunCancelled();
          choice = answer === 0 ? 'images' : 'keepText';
        }
        if (choice === 'images') best = await picturePages(ctx, item, bytes, target);
      }
      out.push(best === bytes ? item : await writePdf(ctx, best, item.name));
    }
    ctx.progress(items.length, items.length);
    return { type: 'pdf', items: out };
  },
};
