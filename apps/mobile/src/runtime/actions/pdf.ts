import {
  localDate,
  FILE_LIMITS,
  RunCancelled,
  RunError,
  fixCjkRadicals,
  groupItems,
  polishOcrText,
  t,
  type ActionImpl,
  type GroupRule,
  type Locale,
  type RunItem,
} from '@morph/core';
import { boxesToEnhanced, searchSharedQuality } from '@morph/tool-image';
import {
  PdfError,
  addPageNumbers,
  canEncodeStandardText,
  fillForm,
  listFormFields,
  imagesToPdf,
  mergeDocuments,
  mergePdfs,
  pageInfo,
  resolvePageRule,
  rotatePages,
  selectPages,
  splitPdf,
  replacePageWithImage,
  stampImage,
  stampText,
  type DocumentInput,
  type ImageInput,
  type ImageKind,
  type ImagePageOptions,
  type PageRule,
  type TextLayer,
} from '@morph/tool-pdf';

import { deviceLanguageTags } from '../../i18n';
import { guard, pdfError } from '../pdf-errors';
import type { VisionPlatform } from '../platform';
import { scaleMarks, type ImageAnnotation } from '../annotations';
import { drawMarks } from './compose';
import { formatBytes } from './image';
import {
  fileItems,
  freshName,
  ocrSourceOf,
  readItem,
  writeItem,
  type RunServices,
} from './helpers';
import { OCR_IMPLS } from './ocr';

// Implementation of PDF actions: byte processing is entirely in packages/tool-pdf (pdf-lib), while this file only handles reading and writing temporary files.

type Impl = ActionImpl<RunServices>;
type Ctx = Parameters<Impl>[2];

const MB = 1024 * 1024;
const fileName = (item: RunItem) => `${item.name}.${item.ext}`;

// pdfError / guard are in ../pdf-errors (used by storage as well); exported here as usual, and other action files still import them from ./pdf.
export { guard, pdfError };

/** Errors occurring after the file is already open: explain PDF-specific issues as usual, and report others as they are (do not label them as "file may be corrupted"). */
function arrangeError(e: unknown): unknown {
  if (e instanceof PdfError || e instanceof RunError || e instanceof RunCancelled) return e;
  return new RunError('unexpected', { detail: String(e instanceof Error ? e.message : e) });
}

async function arranged(name: string, fn: () => Promise<Uint8Array>): Promise<Uint8Array> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof PdfError) return pdfError(e, name);
    throw arrangeError(e);
  }
}

/** Output a temporary PDF file. */
export async function writePdf(ctx: Ctx, bytes: Uint8Array, name: string): Promise<RunItem> {
  const pages = await pageInfo(bytes);
  return writeItem(ctx.services, bytes, {
    name,
    ext: 'pdf',
    mimeType: 'application/pdf',
    pageCount: pages.length,
  });
}

/** Perform the same operation on each PDF. */
type AnnotateTool = ImageAnnotation['kind'] | 'note';

async function eachPdf(
  input: Parameters<Impl>[0],
  ctx: Ctx,
  fn: (bytes: Uint8Array, item: RunItem) => Promise<Uint8Array>,
) {
  const items = fileItems(input);
  const out: RunItem[] = [];
  for (const [i, item] of items.entries()) {
    ctx.throwIfCancelled();
    const bytes = await readItem(ctx.services, item);
    out.push(await writePdf(ctx, await guard(fileName(item), () => fn(bytes, item)), item.name));
    ctx.progress(i + 1, items.length);
  }
  return { type: 'pdf' as const, items: out };
}

function ruleOf(params: Record<string, unknown>): PageRule {
  return params.rule === 'range' ? { range: String(params.range) } : (params.rule as PageRule);
}

/** JPEG / PNG bytes of images: pdf-lib can only embed these two formats; HEIC, WebP, and very large PNGs are first converted to JPEG. */
/** Western European languages used for text layer recognition (D-195). */
const LATIN_TEXT_LAYER = ['en-US', 'fr-FR', 'de-DE', 'es-ES', 'it-IT', 'pt-BR'] as const;

/**
 * Languages used for text layer recognition (D-266): if Chinese, Japanese, or Korean is present
 * in the device's language list or UI language, prioritize it (along with English, as these
 * recognizers also recognize Latin characters) and write to the PDF using a glyphless font;
 * otherwise, use Western European languages. The first language must be supported by the system.
 */
export function textLayerLanguages(
  locale: Locale,
  deviceTags: readonly string[],
): readonly string[] {
  for (const tag of [...deviceTags, ...(locale === 'zh' ? ['zh-Hans'] : [])]) {
    const [lang, ...rest] = tag.split('-');
    const tail = rest.join('-');
    if (lang === 'zh') return [/Hant|TW|HK|MO/.test(tail) ? 'zh-Hant' : 'zh-Hans', 'en-US'];
    if (lang === 'ja') return ['ja-JP', 'en-US'];
    if (lang === 'ko') return ['ko-KR', 'en-US'];
  }
  return LATIN_TEXT_LAYER;
}

async function imageBytes(
  ctx: Ctx,
  item: RunItem,
  quality = 0.9,
  scale = 1,
): Promise<{ bytes: Uint8Array; kind: ImageKind; width?: number; height?: number }> {
  const big = (item.width ?? 0) * (item.height ?? 0) > 4_000_000;
  if (scale === 1 && quality >= 0.9) {
    if (item.mimeType === 'image/jpeg')
      return { bytes: await readItem(ctx.services, item), kind: 'jpeg' };
    if (item.mimeType === 'image/png' && !big) {
      return { bytes: await readItem(ctx.services, item), kind: 'png' };
    }
  }
  const { files, runId } = ctx.services;
  const size =
    item.width && item.height
      ? { width: item.width, height: item.height }
      : await files.imageSize(item.uri);
  const resize =
    scale < 1
      ? {
          width: Math.max(1, Math.round(size.width * scale)),
          height: Math.max(1, Math.round(size.height * scale)),
        }
      : undefined;
  let out;
  try {
    out = await files.transformImage(
      item.uri,
      resize ? { resize } : {},
      { format: 'jpeg', quality },
      runId,
      freshName(item.name, 'jpg'),
    );
  } catch {
    throw new RunError('unreadable', { name: fileName(item) });
  }
  return {
    bytes: await files.readUri(out.uri),
    kind: 'jpeg',
    width: out.width,
    height: out.height,
  };
}

const isImage = (item: RunItem) => item.mimeType.startsWith('image/');

/** Position on page -> top-left proportional coordinates used by stampImage. */
function stampBox(
  position: string,
  page: { width: number; height: number },
  box: { width: number; height: number },
) {
  const margin = 36;
  const x = position.endsWith('Left')
    ? margin
    : position.endsWith('Right')
      ? page.width - margin - box.width
      : (page.width - box.width) / 2;
  const y = position.startsWith('top')
    ? margin
    : position.startsWith('bottom')
      ? page.height - margin - box.height
      : (page.height - box.height) / 2;
  return {
    x: Math.max(0, x / page.width),
    y: Math.max(0, y / page.height),
    width: box.width / page.width,
  };
}

/**
 * Actions using the PDF preview package (WebView + pdf.js) must fit the entire document into the
 * WebView: measured memory in the simulator is about 20–30x the file size (~49 MB is ~1.9 GB, ~99
 * MB is ~2.8 GB), which is much higher than actions using only pdf-lib. Therefore, it is still
 * capped at 50 MB rather than following the PDF limit of 100 MB (D-601).
 */
function checkViewSize(item: RunItem): void {
  if (item.size > FILE_LIMITS.maxFileBytes) {
    throw new RunError('tooLarge', { name: fileName(item), mb: FILE_LIMITS.maxFileBytes / MB });
  }
}

/** Render pages into JPEGs using the PDF preview package (WebView + pdf.js in the app). Returns temporary images for the current run. */
export async function renderPages(
  ctx: Ctx,
  item: RunItem,
  opts: { maxSide: number; quality: number; pages?: number[] },
): Promise<RunItem[]> {
  const packs = ctx.services.packs;
  if (!packs) throw new RunError('packFailed', { detail: 'pdfview' });
  checkViewSize(item);
  let pages: {
    index: number;
    width: number;
    height: number;
    data: string;
    paper?: { width: number; height: number };
  }[];
  try {
    pages = await packs.runtime.call(
      'pdfview',
      'render',
      { file: 'input', ...opts },
      { input: item.uri },
    );
  } catch (e) {
    throw new RunError('unreadable', { name: fileName(item), detail: String(e) });
  }
  const out: RunItem[] = [];
  for (const page of pages) {
    const bytes = Uint8Array.from(atob(page.data), (c) => c.charCodeAt(0));
    const image = await writeItem(ctx.services, bytes, {
      name: `${item.name}-${page.index + 1}`,
      ext: 'jpg',
      mimeType: 'image/jpeg',
      width: page.width,
      height: page.height,
    });
    image.pdfSource = { for: image.uri, uri: item.uri, page: page.index };
    if (page.paper) image.pageSize = { for: image.uri, ...page.paper };
    out.push(image);
  }
  return out;
}

/** Grouping (D-243): when ungrouped, treated as a single group named after the first file (same as before). */
function groupsOf(input: Parameters<Impl>[0], params: Record<string, unknown>, ctx: Ctx) {
  return groupItems(
    fileItems(input),
    params.group as GroupRule | undefined,
    params.groupSize as number | undefined,
    t(ctx.locale, 'groupUndated'),
  );
}

/** Merge a group of PDFs and images into a single PDF in order. */
async function mergeGroup(
  ctx: Ctx,
  items: RunItem[],
  params: Record<string, unknown>,
  name: string,
): Promise<RunItem> {
  const allPdf = items.every((i) => !isImage(i));
  const inputs: DocumentInput[] = [];
  for (const [i, item] of items.entries()) {
    ctx.throwIfCancelled();
    if (isImage(item)) {
      const image = await imageBytes(ctx, item);
      inputs.push({ name: fileName(item), ...image });
    } else {
      inputs.push({
        name: fileName(item),
        bytes: await readItem(ctx.services, item),
        kind: 'pdf' as const,
      });
    }
    ctx.progress(i + 1, items.length);
  }
  const pageOpts: ImagePageOptions = {
    pageSize: (params.imagePage as ImagePageOptions['pageSize'] | undefined) ?? 'a4',
    orientation: 'auto',
    marginMm: 0,
    fit: 'contain',
  };
  const result = await guard('', () =>
    // When only PDFs are present, retain the original merging behavior (at least 2).
    allPdf ? mergePdfs(inputs) : mergeDocuments(inputs, pageOpts),
  );
  return writePdf(ctx, result.bytes, name);
}

/**
 * Single-page text layer (D-267): recognize on the pre-enhanced image first (more accurate) and
 * map bounding boxes to this image; if the pre-enhanced image cannot be read or aspect ratios do
 * not match (e.g., different orientation), recognize on this image.
 */
/**
 * Lines recognized on the page preview (preview image points): when annotating, new text uses the
 * nearest line to determine font size, and signatures use it for height (2026-11-09 user test:
 * default text and signatures were several times larger than contract body text). Recognized
 * locally only, never stored or sent; empty if recognition fails or OCR is unavailable.
 */
function previewLines(ctx: Ctx, preview: RunItem) {
  const vision = ctx.services.files.vision;
  const { width, height } = preview;
  if (!vision || !width || !height) return Promise.resolve([]);
  return vision
    .recognizeLines(preview.uri, textLayerLanguages(ctx.locale, deviceLanguageTags()))
    .then(
      (layer) => {
        const kx = width / layer.width;
        const ky = height / layer.height;
        return layer.lines.map((l) => ({
          x: l.x * kx,
          y: l.y * ky,
          width: l.width * kx,
          height: l.height * ky,
        }));
      },
      () => [],
    );
}

async function pageTextLayer(
  vision: VisionPlatform,
  item: RunItem,
  languages: readonly string[],
): Promise<TextLayer> {
  const source = ocrSourceOf(item);
  if (source && item.width && item.height) {
    try {
      const layer = await vision.recognizeLines(source.uri, languages);
      const ratio = layer.width / layer.height / (source.width / source.height);
      if (Math.abs(ratio - 1) < 0.02) {
        const canvas = { width: item.width, height: item.height };
        return {
          ...canvas,
          lines: boxesToEnhanced(layer.lines, layer, source, source.skew, canvas),
        };
      }
    } catch {
      // Recognize using this image.
    }
  }
  return vision.recognizeLines(item.uri, languages);
}

/** Arrange a group of images into a PDF; size limit is calculated for this single PDF (D-073). */
async function imagesPdf(
  ctx: Ctx,
  items: RunItem[],
  params: Record<string, unknown>,
  name: string,
): Promise<RunItem> {
  const { maxMB, textLayer, ...rest } = params as unknown as ImagePageOptions & {
    maxMB: number;
    textLayer?: boolean;
  };
  const {
    group: _group,
    groupSize: _size,
    ...page
  } = rest as ImagePageOptions & {
    group?: string;
    groupSize?: number;
  };
  let images: ImageInput[] = [];
  if (maxMB > 0) {
    // "PDF <= X MB": all images share a single quality and scale setting, searched by total size prior to generation (D-073).
    const target = maxMB * MB;
    const result = await searchSharedQuality({
      targetBytes: target,
      overheadBytes: 2048 + items.length * 1024,
      maxQuality: 0.9,
      encodeAll: async (quality, scale) => {
        ctx.throwIfCancelled();
        images = [];
        for (const item of items) images.push(await imageBytes(ctx, item, quality, scale));
        return images.reduce((sum, i) => sum + i.bytes.length, 0);
      },
    });
    if (!result.met) {
      throw new RunError('targetNotMet', {
        name: 'PDF',
        target: formatBytes(target, ctx.locale),
        got: formatBytes(result.bytes, ctx.locale),
      });
    }
  } else {
    for (const [i, item] of items.entries()) {
      ctx.throwIfCancelled();
      images.push(await imageBytes(ctx, item));
      ctx.progress(i + 1, items.length);
    }
  }
  // Searchable PDF (D-195): recognize text and positions for each page. Omitted when system built-in recognition (Expo Go) is unavailable; failure on a specific page simply omits text for that page.
  const vision = textLayer ? ctx.services.files.vision : null;
  if (vision) {
    const languages = textLayerLanguages(ctx.locale, deviceLanguageTags());
    for (const [i, item] of items.entries()) {
      ctx.throwIfCancelled();
      // If CJK recognition fails (unsupported on old systems), retry with Western European languages; if it still fails, omit the text layer for this page.
      for (const attempt of languages === LATIN_TEXT_LAYER
        ? [languages]
        : [languages, LATIN_TEXT_LAYER]) {
        try {
          const layer = await pageTextLayer(vision, item, attempt);
          // Organize Chinese by recognized language (D-268): simplify any stray traditional characters, and use full-width punctuation for Chinese.
          const kind =
            attempt[0] === 'zh-Hans' ? 'zh-Hans' : attempt[0] === 'zh-Hant' ? 'zh-Hant' : 'other';
          const lines = layer.lines.map((l) => ({ ...l, text: polishOcrText(l.text, kind) }));
          images[i] = { ...images[i]!, text: { ...layer, lines } };
          break;
        } catch {
          // Move to the next language group.
        }
      }
      ctx.progress(i + 1, items.length);
    }
  }
  const result = await guard('', () => imagesToPdf(images, page));
  return writePdf(ctx, result.bytes, name);
}

export const PDF_IMPLS: Record<string, Impl> = {
  async 'pdf.merge'(input, params, ctx) {
    // D-243: when grouped, merge each group into a PDF; groups resulting in a single PDF are left as-is (merging requires at least 2 files; throws an error as usual when ungrouped).
    const grouped = params.group !== undefined && params.group !== 'none';
    const out: RunItem[] = [];
    for (const group of groupsOf(input, params, ctx)) {
      ctx.throwIfCancelled();
      const only = group.items[0]!;
      if (grouped && group.items.length === 1 && !isImage(only)) {
        const pages = await guard(fileName(only), async () =>
          pageInfo(await readItem(ctx.services, only)),
        );
        out.push({ ...only, name: group.name, pageCount: pages.length });
      } else out.push(await mergeGroup(ctx, group.items, params, group.name));
    }
    return { type: 'pdf', items: out };
  },

  async 'pdf.fromImages'(input, params, ctx) {
    const out: RunItem[] = [];
    for (const group of groupsOf(input, params, ctx)) {
      ctx.throwIfCancelled();
      out.push(await imagesPdf(ctx, group.items, params, group.name));
    }
    return { type: 'pdf', items: out };
  },

  async 'pdf.pages'(input, _params, ctx) {
    const out: RunItem[] = [];
    for (const [i, item] of fileItems(input).entries()) {
      ctx.throwIfCancelled();
      const bytes = await readItem(ctx.services, item);
      const pages = await guard(fileName(item), () => pageInfo(bytes));
      // Display thumbnails if the PDF preview package is installed; otherwise, organize by page number without triggering a download prompt.
      let thumbnails: string[] | undefined;
      if (ctx.services.packs && (await ctx.services.packs.isInstalled('pdfview'))) {
        try {
          thumbnails = (await renderPages(ctx, item, { maxSide: 240, quality: 0.7 })).map(
            (p) => p.uri,
          );
        } catch {
          thumbnails = undefined;
        }
      }
      // Errors from the organizing UI are not file corruption issues and are reported as-is (bypassing guard).
      let chosen;
      try {
        chosen = await ctx.services.ui.open('pages', {
          item,
          pages,
          ...(thumbnails ? { thumbnails } : {}),
        });
      } catch (e) {
        throw arrangeError(e);
      }
      if (!chosen) throw new RunCancelled();
      // If nothing changed (most common: tapping "Done" immediately after merging), leave it as-is without re-copying every page.
      const unchanged =
        chosen.length === pages.length && chosen.every((p, j) => p.index === j && !p.rotate);
      const result = unchanged
        ? bytes
        : await arranged(fileName(item), async () => {
            let next = bytes;
            for (const angle of [90, 180, 270] as const) {
              const indices = chosen.filter((p) => p.rotate === angle).map((p) => p.index);
              if (indices.length) next = await rotatePages(next, angle, indices);
            }
            return selectPages(
              next,
              chosen.map((p) => p.index),
            );
          });
      out.push(await writePdf(ctx, result, item.name));
      ctx.progress(i + 1, fileItems(input).length);
    }
    return { type: 'pdf' as const, items: out };
  },

  async 'pdf.selectPages'(input, params, ctx) {
    return eachPdf(input, ctx, async (bytes) => {
      const count = (await pageInfo(bytes)).length;
      return selectPages(bytes, resolvePageRule(ruleOf(params), count));
    });
  },

  async 'pdf.rotate'(input, params, ctx) {
    return eachPdf(input, ctx, async (bytes) => {
      const count = (await pageInfo(bytes)).length;
      return rotatePages(
        bytes,
        params.angle as 90 | 180 | 270,
        resolvePageRule(ruleOf(params), count),
      );
    });
  },

  async 'pdf.split'(input, params, ctx) {
    const out: RunItem[] = [];
    for (const item of fileItems(input)) {
      ctx.throwIfCancelled();
      const bytes = await readItem(ctx.services, item);
      const parts = await guard(fileName(item), async () => {
        if (params.mode === 'every') return splitPdf(bytes, { kind: 'every', n: Number(params.n) });
        const count = (await pageInfo(bytes)).length;
        const ranges = String(params.ranges)
          .split(/[;；]/)
          .map((r) => r.trim())
          .filter(Boolean)
          .map((range) => resolvePageRule({ range }, count));
        return splitPdf(bytes, { kind: 'ranges', ranges });
      });
      for (const [i, part] of parts.entries()) {
        out.push(await writePdf(ctx, part, `${item.name}-${i + 1}`));
        ctx.progress(i + 1, parts.length);
      }
    }
    return { type: 'pdf', items: out };
  },

  async 'pdf.pageNumbers'(input, params, ctx) {
    const { position, format, startAt, fontSize, skipFirst } = params as {
      position: 'bottomCenter';
      format: 'n';
      startAt: number;
      fontSize: number;
      skipFirst: boolean;
    };
    return eachPdf(input, ctx, async (bytes) => {
      const count = (await pageInfo(bytes)).length;
      const pages = skipFirst ? Array.from({ length: count - 1 }, (_, i) => i + 1) : undefined;
      if (pages && pages.length === 0) return bytes;
      return addPageNumbers(bytes, {
        position,
        format,
        startAt,
        fontSize,
        marginPt: 24,
        ...(pages ? { pages } : {}),
      });
    });
  },

  async 'pdf.toImages'(input, params, ctx) {
    const out: RunItem[] = [];
    for (const item of fileItems(input)) {
      ctx.throwIfCancelled();
      out.push(
        ...(await renderPages(ctx, item, { maxSide: Number(params.maxSide), quality: 0.88 })),
      );
    }
    return { type: 'images', items: out };
  },

  async 'pdf.extractText'(input, _params, ctx) {
    const [item] = fileItems(input);
    const packs = ctx.services.packs;
    if (!item || !packs) throw new RunError('packFailed', { detail: 'pdfview' });
    checkViewSize(item);
    let result: { pages: string[] };
    try {
      result = await packs.runtime.call('pdfview', 'text', { file: 'input' }, { input: item.uri });
    } catch (e) {
      throw new RunError('unreadable', { name: fileName(item), detail: String(e) });
    }
    const pages = result.pages.map((p) => fixCjkRadicals(p).trim());
    // Scans (or scanned pages) lacking a text layer: render these pages as images and read them using OCR (founder 2026-10-31).
    const blank = pages.flatMap((p, i) => (p ? [] : [i]));
    if (blank.length > 0) {
      try {
        const images = await renderPages(ctx, item, {
          maxSide: 2500,
          quality: 0.9,
          pages: blank,
        });
        for (const [k, image] of images.entries()) {
          ctx.throwIfCancelled();
          const read = await OCR_IMPLS['ocr.recognize']!(
            { type: 'images', items: [image] },
            { lang: 'auto' },
            ctx,
          ).catch(() => null);
          if (read?.type === 'text') pages[blank[k]!] = read.text;
        }
      } catch (e) {
        if (e instanceof RunCancelled) throw e;
        // If rendering or recognition fails, behave as usual: output only pages that have a text layer.
      }
    }
    const text = pages.filter(Boolean).join('\n\n');
    if (!text) throw new RunError('notFound', { name: fileName(item) });
    // Text remains strictly local and is never sent to the AI (D-036).
    return { type: 'text', text, name: item.name };
  },

  async 'pdf.annotate'(input, params, ctx) {
    return eachPdf(input, ctx, async (bytes, item) => {
      const previews = await renderPages(ctx, item, { maxSide: 1400, quality: 0.85 });
      const all = await ctx.services.ui.open('annotate', {
        items: previews,
        tool: params.start as AnnotateTool,
        document: true,
        lines: (i) => (previews[i] ? previewLines(ctx, previews[i]) : Promise.resolve([])),
      });
      if (!all) throw new RunCancelled();
      let out = bytes;
      for (const [i, marks] of all.entries()) {
        const preview = previews[i];
        if (!preview || marks.length === 0) continue;
        ctx.throwIfCancelled();
        if (marks.some((m) => m.kind === 'erase' || m.kind === 'mosaic')) {
          // Erase, redact: overlay a mask that simply blocks content, while underlying text can
          // still be selected and copied. Replace this page with a rendered image (page text is
          // removed), drawn at a higher resolution to prevent blurriness when zoomed in.
          const [big] = await renderPages(ctx, item, { maxSide: 2400, quality: 0.9, pages: [i] });
          if (!big) throw new RunError('unreadable', { name: fileName(item) });
          const k = big.width! / preview.width!;
          const flat = await drawMarks(
            ctx,
            big.name,
            { width: big.width!, height: big.height! },
            scaleMarks(marks, k),
            big,
            'jpeg',
          );
          out = await replacePageWithImage(out, i, {
            bytes: await readItem(ctx.services, flat),
            kind: 'jpeg',
          });
          continue;
        }
        // Other annotations: overlay a transparent layer of the same size as the page, leaving original text and page intact.
        const layer = await drawMarks(
          ctx,
          preview.name,
          { width: preview.width!, height: preview.height! },
          marks,
        );
        out = await stampImage(out, {
          image: { bytes: await readItem(ctx.services, layer), kind: 'png' },
          pageIndex: i,
          x: 0,
          y: 0,
          width: 1,
        });
      }
      return out;
    });
  },

  async 'pdf.sign'(input, _params, ctx) {
    return eachPdf(input, ctx, async (bytes, item) => {
      const previews = await renderPages(ctx, item, { maxSide: 1000, quality: 0.8 });
      const placed = await ctx.services.ui.open('sign', {
        item,
        pages: previews.map((p) => ({ uri: p.uri, width: p.width!, height: p.height! })),
        lines: (i) => (previews[i] ? previewLines(ctx, previews[i]) : Promise.resolve([])),
      });
      if (!placed) throw new RunCancelled();
      return stampImage(bytes, {
        image: { bytes: placed.png, kind: 'png' },
        pageIndex: placed.pageIndex,
        x: placed.x,
        y: placed.y,
        width: placed.width,
      });
    });
  },

  async 'pdf.fillForm'(input, params, ctx) {
    return eachPdf(input, ctx, async (bytes, item) => {
      const fields = await listFormFields(bytes);
      if (fields.filter((f) => !f.readOnly && f.type !== 'other').length === 0) {
        // Sign returning forms: some PDFs only require a signature; if there are no form fields, pass them to the next step as-is.
        if (params.whenNoFields === 'skip') return bytes;
        throw new RunError('noFormFields', { name: fileName(item) });
      }
      const values = await ctx.services.ui.open('fillForm', { item, fields });
      if (!values) throw new RunCancelled();
      return fillForm(bytes, values, { flatten: Boolean(params.flatten) });
    });
  },

  async 'pdf.stamp'(input, params, ctx) {
    const { position, fontSize, color, opacity, angle } = params as {
      position: 'center';
      fontSize: number;
      color: string;
      opacity: number;
      angle: 0 | 45 | -45;
    };
    const text = String(params.text).replace(/\{date\}/g, localDate(ctx.now()));
    return eachPdf(input, ctx, async (bytes) => {
      const info = await pageInfo(bytes);
      const pages = resolvePageRule(ruleOf(params), info.length);
      if (canEncodeStandardText(text)) {
        return stampText(bytes, {
          text,
          position,
          fontSize,
          color,
          opacity: opacity / 100,
          ...(angle ? { rotateDeg: angle } : {}),
          pages,
        });
      }
      // Standard fonts cannot render Chinese and emoji: render them into images using system fonts and overlay them (D-073).
      const scale = 3;
      const image = await ctx.services.files.renderText(text, {
        fontSize: fontSize * scale,
        color,
        opacity: opacity / 100,
      });
      let out = bytes;
      for (const index of pages) {
        const page = info[index]!;
        const box = stampBox(position, page, {
          width: image.width / scale,
          height: image.height / scale,
        });
        out = await stampImage(out, {
          image: { bytes: image.bytes, kind: 'png' },
          pageIndex: index,
          ...box,
          ...(angle ? { rotateDeg: angle } : {}),
        });
      }
      return out;
    });
  },
};
