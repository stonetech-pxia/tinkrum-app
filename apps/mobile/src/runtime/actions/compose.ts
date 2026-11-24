import {
  ID_PHOTO_BACKGROUND_COLORS,
  RunCancelled,
  RunError,
  aspectRatio,
  type ActionImpl,
  type RunItem,
} from '@morph/core';
import {
  ID_PHOTO_SPECS,
  centeredCropForAspect,
  layoutGrid,
  layoutPrintSheet,
  layoutStitch,
  layoutWatermark,
  MAX_SURFACE_SIDE,
  searchForTargetSize,
  surfaceScale,
  type Rect,
  DEFAULT_HEAD_RATIO,
  HEAD_RATIO,
  faceCrop,
  mainFace,
} from '@morph/tool-image';

import { annotationPaths, markRect, type ImageAnnotation } from '../annotations';
import type { DrawOp } from '../platform';
import { displayName, fileItems, freshName, type RunServices } from './helpers';
import { t } from '../../i18n';
import { backgroundModel, eachImage, encode, formatBytes, sizeOf } from './image';

// T6 Image Composition (D-079): layout calculated in packages/tool-image, pixels rendered off-screen by Skia (platform.composeImage).

type Impl = ActionImpl<RunServices>;
type Ctx = Parameters<Impl>[2];

/** Maximum side length for a single stitched long image: GPU off-screen canvas limit. Exceeds this and it splits into multiple images. */
const STITCH_MAX_SIDE = MAX_SURFACE_SIDE;
/** Stitched long image width capped at this value (mobile screenshots are around 1290) to control memory usage. */
const STITCH_MAX_CROSS = 1600;
/** Minimum width constraint when stitching into a single image (narrower than this makes text illegible). */
const STITCH_MIN_CROSS = 720;
/** Grid output width. */
const GRID_WIDTH = 2400;
/** Print DPI of 300. */
const PRINT_DPI = 300;

const SHEETS: Record<string, { widthIn: number; heightIn: number }> = {
  '4x6': { widthIn: 4, heightIn: 6 },
  '5x7': { widthIn: 5, heightIn: 7 },
  a4: { widthIn: 8.27, heightIn: 11.69 },
  letter: { widthIn: 8.5, heightIn: 11 },
};

async function compose(
  ctx: Ctx,
  name: string,
  canvas: { width: number; height: number; background: string },
  ops: DrawOp[],
  format: 'jpeg' | 'png' = 'jpeg',
): Promise<RunItem> {
  // Canvases exceeding GPU limits will crash the app directly: scale down proportionally overall (large photos with watermarks/censorship, or multi-image grids).
  const k = surfaceScale(canvas);
  if (k < 1) {
    canvas = {
      ...canvas,
      width: Math.max(1, Math.floor(canvas.width * k)),
      height: Math.max(1, Math.floor(canvas.height * k)),
    };
    ops = ops.map((op) => scaleOp(op, k));
  }
  let out;
  try {
    out = await ctx.services.files.composeImage(
      canvas,
      ops,
      { format, quality: 0.9 },
      ctx.services.runId,
      freshName(name, format === 'png' ? 'png' : 'jpg'),
    );
  } catch (e) {
    throw new RunError('unexpected', { detail: String(e instanceof Error ? e.message : e) });
  }
  return {
    uri: out.uri,
    name,
    ext: format === 'png' ? 'png' : 'jpg',
    mimeType: format === 'png' ? 'image/png' : 'image/jpeg',
    size: out.size,
    width: out.width,
    height: out.height,
  };
}

const scaleBox = (b: Rect, k: number): Rect => ({
  x: b.x * k,
  y: b.y * k,
  width: b.width * k,
  height: b.height * k,
});

function scaleOp(op: DrawOp, k: number): DrawOp {
  switch (op.kind) {
    case 'image':
      return { ...op, dst: scaleBox(op.dst, k) };
    case 'rect':
      return { ...op, rect: scaleBox(op.rect, k) };
    case 'blur':
      return { ...op, rect: scaleBox(op.rect, k), sigma: op.sigma * k };
    case 'path':
      return {
        ...op,
        points: op.points.map((p) => ({ x: p.x * k, y: p.y * k })),
        width: Math.max(1, op.width * k),
      };
    case 'line':
      return {
        ...op,
        x1: op.x1 * k,
        y1: op.y1 * k,
        x2: op.x2 * k,
        y2: op.y2 * k,
        width: Math.max(1, op.width * k),
      };
  }
}

/** Scale image to cover the cell proportionally: center and crop excess portions. */
const cover = (size: { width: number; height: number }, cell: Rect): Rect =>
  centeredCropForAspect(size, cell.width / cell.height);

/**
 * Inputs Skia can draw directly: PNGs are used as is (screenshots, no orientation info); other
 * formats (HEIC, JPGs with orientation) are first converted to JPG using the system encoder,
 * which also straightens them according to capture orientation. Skia cannot decode HEIC and does
 * not necessarily render according to EXIF orientation.
 */
async function drawable(ctx: Ctx, item: RunItem): Promise<RunItem> {
  if (item.mimeType === 'image/png') return { ...item, ...(await sizeOf(ctx, item)) };
  return encode(ctx, item, {}, 'jpeg', 0.95);
}

async function withSizes(ctx: Ctx, items: RunItem[]) {
  const ready: RunItem[] = [];
  for (const item of items) {
    ctx.throwIfCancelled();
    ready.push(await drawable(ctx, item));
  }
  return ready;
}

/** ID photo background replacement (D-252): keep the person, replace the rest with a solid color. iOS uses portrait segmentation; Android uses subject segmentation, requiring model download confirmation on first use. */
async function replaceBackgrounds(ctx: Ctx, items: RunItem[], color: string): Promise<RunItem[]> {
  const system = ctx.services.files.vision;
  if (!system?.replaceBackground)
    throw new RunError('unsupportedAction', { action: t(ctx.locale, 'backgroundNeedsSystem') });
  const vision = system.personSegmentation ? system : await backgroundModel(ctx);
  const out: RunItem[] = [];
  for (const [i, item] of items.entries()) {
    ctx.throwIfCancelled();
    try {
      const result = await vision.replaceBackground!(
        item.uri,
        color,
        ctx.services.runId,
        freshName(item.name, 'png'),
      );
      out.push({ ...item, ...result, ext: 'png', mimeType: 'image/png' });
    } catch {
      throw new RunError('backgroundFailed', { name: item.name });
    }
    ctx.progress(i + 1, items.length);
  }
  return out;
}

/** Each photo is framed according to the largest face; returns null (centered) if no face is found or system face detection is unavailable (Expo Go). */
async function faceFrames(
  ctx: Ctx,
  items: RunItem[],
  specId: string,
  aspect: number,
): Promise<(Rect | null)[] | undefined> {
  const vision = ctx.services.files.vision;
  if (!vision?.detectFaces) return undefined;
  const ratio = HEAD_RATIO[specId] ?? DEFAULT_HEAD_RATIO;
  const frames: (Rect | null)[] = [];
  for (const item of items) {
    ctx.throwIfCancelled();
    try {
      const found = await vision.detectFaces(item.uri);
      // The image used for detection may have been scaled down (Android): revert to the photo's actual pixel dimensions.
      const kx = item.width! / found.width;
      const ky = item.height! / found.height;
      const face = mainFace(
        found.faces.map((f) => ({
          x: f.x * kx,
          y: f.y * ky,
          width: f.width * kx,
          height: f.height * ky,
        })),
      );
      frames.push(
        face ? faceCrop({ width: item.width!, height: item.height! }, face, aspect, ratio) : null,
      );
    } catch {
      frames.push(null);
    }
  }
  return frames;
}

/** Mosaic an area: sample the average color of the original image per grid cell, and draw it as a grid of solid color blocks. */
async function mosaicOps(
  ctx: Ctx,
  base: RunItem,
  size: { width: number; height: number },
  rect: { x: number; y: number; width: number; height: number },
): Promise<DrawOp[]> {
  const px = await ctx.services.files.imagePixels(base.uri, Math.max(size.width, size.height));
  const sx = px.width / size.width;
  const sy = px.height / size.height;
  // Grid cell size follows the box dimensions (1/8 of the shorter side, at least 8 points) so that original text is illegible.
  const cell = Math.max(8, Math.min(rect.width, rect.height) / 8);
  const ops: DrawOp[] = [];
  for (let y = rect.y; y < rect.y + rect.height; y += cell) {
    for (let x = rect.x; x < rect.x + rect.width; x += cell) {
      const w = Math.min(cell, rect.x + rect.width - x);
      const h = Math.min(cell, rect.y + rect.height - y);
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      const x0 = Math.floor(x * sx);
      const y0 = Math.floor(y * sy);
      const x1 = Math.min(px.width, Math.max(x0 + 1, Math.ceil((x + w) * sx)));
      const y1 = Math.min(px.height, Math.max(y0 + 1, Math.ceil((y + h) * sy)));
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * px.width + xx) * 4;
          r += px.data[i]!;
          g += px.data[i + 1]!;
          b += px.data[i + 2]!;
          n++;
        }
      }
      const hex = (v: number) =>
        Math.round(n ? v / n : 255)
          .toString(16)
          .padStart(2, '0');
      ops.push({
        kind: 'rect',
        rect: { x, y, width: w, height: h },
        color: `#${hex(r)}${hex(g)}${hex(b)}`,
      });
    }
  }
  return ops;
}

/**
 * Render a page's annotations: when there is no base, it is a transparent PNG (overlaid on the
 * PDF page); when there is a base, it is drawn directly onto this image (erasing or redacting
 * replaces the page, see pdf.annotate). Shared between image and PDF annotations.
 */
export async function drawMarks(
  ctx: Ctx,
  name: string,
  size: { width: number; height: number },
  marks: readonly ImageAnnotation[],
  base?: RunItem,
  format: 'png' | 'jpeg' = 'png',
): Promise<RunItem> {
  const ops: DrawOp[] = base
    ? [{ kind: 'image', source: { uri: base.uri }, dst: { x: 0, y: 0, ...size } }]
    : [];
  // Draw erasures and redactions first (on the original image), with text and brush strokes drawn on top of them.
  for (const mark of marks) {
    if (mark.kind === 'erase') ops.push({ kind: 'rect', rect: markRect(mark), color: '#FFFFFF' });
    if (mark.kind === 'mosaic' && base)
      ops.push(...(await mosaicOps(ctx, base, size, markRect(mark))));
  }
  for (const mark of marks) {
    if (mark.kind === 'text') {
      const text = await ctx.services.files.renderText(mark.text, {
        fontSize: mark.fontSize,
        color: mark.color,
        opacity: 1,
        ...(mark.fill ? { background: mark.fill } : {}),
      });
      ops.push({
        kind: 'image',
        source: { bytes: text.bytes },
        dst: { ...mark.point, width: text.width, height: text.height },
        ...(mark.rotation ? { angleDeg: mark.rotation } : {}),
      });
    } else if (mark.kind !== 'erase' && mark.kind !== 'mosaic') {
      for (const points of annotationPaths(mark))
        ops.push({ kind: 'path', points, width: mark.width, color: mark.color });
    }
  }
  return compose(ctx, name, { ...size, background: '#00000000' }, ops, format);
}

export const COMPOSE_IMPLS: Record<string, Impl> = {
  async 'image.annotate'(input, _params, ctx) {
    const items: RunItem[] = [];
    for (const original of fileItems(input)) {
      ctx.throwIfCancelled();
      items.push(
        await encode(
          ctx,
          original,
          {},
          original.mimeType === 'image/png' || original.mimeType === 'image/webp' ? 'png' : 'jpeg',
          0.95,
        ),
      );
    }
    const all = await ctx.services.ui.open('annotate', { items });
    if (!all) throw new RunCancelled();
    if (all.length !== items.length)
      throw new RunError('unexpected', { detail: 'Missing annotation page' });
    const out: RunItem[] = [];
    for (const [i, item] of items.entries()) {
      ctx.throwIfCancelled();
      out.push(
        await drawMarks(
          ctx,
          item.name,
          { width: item.width!, height: item.height! },
          all[i]!,
          item,
        ),
      );
      ctx.progress(i + 1, items.length);
    }
    return { type: 'images', items: out };
  },
  async 'image.stitch'(input, params, ctx) {
    const { direction, gapPx, background } = params as {
      direction: 'vertical' | 'horizontal';
      gapPx: number;
      background: string;
    };
    const items = await withSizes(ctx, fileItems(input));
    const sizes = items.map((i) => ({ width: i.width!, height: i.height! }));
    const vertical = direction === 'vertical';
    let across = Math.min(STITCH_MAX_CROSS, ...sizes.map((s) => (vertical ? s.width : s.height)));
    // When total length exceeds canvas limits, narrow the width first (not below STITCH_MIN_CROSS) to fit into a single image as much as possible; split into segments only if it still doesn't fit.
    const length =
      sizes.reduce(
        (sum, s) =>
          sum + ((vertical ? s.height : s.width) * across) / (vertical ? s.width : s.height),
        0,
      ) +
      gapPx * (sizes.length - 1);
    if (length > STITCH_MAX_SIDE) {
      across = Math.max(STITCH_MIN_CROSS, Math.floor((across * STITCH_MAX_SIDE) / length));
    }
    const { segments } = layoutStitch(sizes, {
      direction,
      gapPx,
      maxSide: STITCH_MAX_SIDE,
      ...(vertical ? { outputWidth: across } : { outputHeight: across }),
    });
    const out: RunItem[] = [];
    for (const [s, segment] of segments.entries()) {
      ctx.throwIfCancelled();
      const ops: DrawOp[] = segment.placements.map((p) => {
        const size = sizes[p.index]!;
        const src = {
          x: p.srcX ?? 0,
          y: p.srcY ?? 0,
          width: p.srcWidth ?? size.width,
          height: p.srcHeight ?? size.height,
        };
        return {
          kind: 'image',
          source: { uri: items[p.index]!.uri },
          src,
          dst: { x: p.x, y: p.y, width: p.width, height: p.height },
        };
      });
      const name = segments.length > 1 ? `${items[0]!.name}-${s + 1}` : items[0]!.name;
      out.push(
        await compose(ctx, name, { width: segment.width, height: segment.height, background }, ops),
      );
      ctx.progress(s + 1, segments.length);
    }
    return { type: 'images', items: out };
  },

  async 'image.grid'(input, params, ctx) {
    const { columns, cell, gapPx, background } = params as {
      columns: number;
      cell: string;
      gapPx: number;
      background: string;
    };
    const items = await withSizes(ctx, fileItems(input));
    const layout = layoutGrid(items.length, {
      columns,
      cellAspect: aspectRatio(cell) ?? 1,
      gapPx,
      paddingPx: gapPx,
      outputWidth: GRID_WIDTH,
    });
    const ops: DrawOp[] = layout.cells.map((dst, i) => {
      const item = items[i]!;
      return {
        kind: 'image',
        source: { uri: item.uri },
        src: cover({ width: item.width!, height: item.height! }, dst),
        dst,
      };
    });
    const out = await compose(ctx, items[0]!.name, { ...layout, background }, ops);
    return { type: 'images', items: [out] };
  },

  async 'image.redact'(input, params, ctx) {
    const items = await withSizes(ctx, fileItems(input));
    const boxes = await ctx.services.ui.open('redact', { items });
    if (!boxes) throw new RunCancelled();
    const style = params.style as 'blur' | 'black';
    const out: RunItem[] = [];
    for (const [i, item] of items.entries()) {
      ctx.throwIfCancelled();
      const size = { width: item.width!, height: item.height! };
      const marks = boxes[i] ?? [];
      // Blur intensity scales with image size: 2% of the shorter side, at least 12 pixels, so original text is illegible.
      const sigma = Math.max(12, Math.min(size.width, size.height) * 0.02);
      const ops: DrawOp[] = [
        { kind: 'image', source: { uri: item.uri }, dst: { x: 0, y: 0, ...size } },
        ...marks.map((rect): DrawOp =>
          style === 'black'
            ? { kind: 'rect', rect, color: '#000000' }
            : { kind: 'blur', rect, sigma },
        ),
      ];
      // Reason for redaction is privacy: always re-encode, discarding original image metadata.
      out.push(await compose(ctx, item.name, { ...size, background: '#FFFFFF' }, ops));
      ctx.progress(i + 1, items.length);
    }
    return { type: 'images', items: out };
  },

  async 'image.watermark'(input, params, ctx) {
    const { text, mode, corner, sizePercent, opacity, color } = params as {
      text: string;
      mode: 'corner' | 'tile';
      corner: 'bottomRight';
      sizePercent: number;
      opacity: number;
      color: string;
    };
    // Draw as a transparent PNG using system fonts (supports CJK characters and emojis), then paste onto the image according to layout.
    const mark = await ctx.services.files.renderText(text, { fontSize: 160, color, opacity: 1 });
    return eachImage(input, ctx, async (original) => {
      const item = await drawable(ctx, original);
      const size = { width: item.width!, height: item.height! };
      const layout = layoutWatermark(size, {
        mode,
        corner,
        relativeSize: sizePercent / 100,
        markAspect: mark.width / mark.height,
      });
      const ops: DrawOp[] = [
        { kind: 'image', source: { uri: item.uri }, dst: { x: 0, y: 0, ...size } },
        ...layout.rects.map((dst): DrawOp => ({
          kind: 'image',
          source: { bytes: mark.bytes },
          dst,
          angleDeg: layout.angleDeg,
          opacity: opacity / 100,
        })),
      ];
      return compose(ctx, item.name, { ...size, background: '#FFFFFF' }, ops);
    });
  },

  async 'image.idPhoto'(input, params, ctx) {
    const spec = ID_PHOTO_SPECS.find((s) => s.id === params.spec);
    if (!spec) throw new RunError('unexpected', { detail: String(params.spec) });
    const maxKB = Number(params.maxKB);
    // Cropping and scaling are performed by the system encoder (which understands HEIC and capture orientation), avoiding the need for prior conversion.
    const aspect = spec.widthMm / spec.heightMm;
    const background = params.background as string | undefined;
    const color =
      background && background !== 'keep'
        ? background === 'custom'
          ? String(params.color)
          : ID_PHOTO_BACKGROUND_COLORS[background]!
        : null;
    let items: RunItem[] = [];
    for (const item of fileItems(input)) items.push({ ...item, ...(await sizeOf(ctx, item)) });
    // D-252: background replacement is done before cropping (for more accurate segmentation of the whole photo), outputting a PNG, which is then cropped and encoded to JPG as usual.
    if (color) items = await replaceBackgrounds(ctx, items, color);
    // Automatic face framing: first find faces locally, set up the frame according to spec head proportions; users can review and readjust in the crop interface.
    const initial =
      params.autoCenter === true ? await faceFrames(ctx, items, spec.id, aspect) : undefined;
    const rects = await ctx.services.ui.open('crop', {
      items,
      aspect,
      ...(initial ? { initial } : {}),
    });
    if (!rects) throw new RunCancelled();
    let i = 0;
    return eachImage({ type: 'images', items }, ctx, async (item) => {
      const ops = { crop: rects[i++]!, resize: { width: spec.widthPx, height: spec.heightPx } };
      let last = await encode(ctx, item, ops, 'jpeg', 0.92);
      if (maxKB > 0 && last.size > maxKB * 1024) {
        // Pixel dimensions are required by specifications and cannot be downscaled: reduce quality only.
        const result = await searchForTargetSize({
          targetBytes: maxKB * 1024,
          minScale: 1,
          encode: async (quality) => {
            ctx.throwIfCancelled();
            last = await encode(ctx, item, ops, 'jpeg', quality);
            return last.size;
          },
        });
        if (!result.met) {
          throw new RunError('targetNotMet', {
            name: displayName(item),
            target: formatBytes(maxKB * 1024, ctx.locale),
            got: formatBytes(result.bytes, ctx.locale),
          });
        }
      }
      return last;
    });
  },

  async 'image.printSheet'(input, params, ctx) {
    const sheet = SHEETS[String(params.sheet)]!;
    const guides = Boolean(params.guides);
    return eachImage(input, ctx, async (original) => {
      const item = await drawable(ctx, original);
      const size = { width: item.width!, height: item.height! };
      // Calculate actual physical size of photos based on 300 dpi (ID photo step outputs specification pixels at 300 dpi).
      const photo = {
        widthMm: (size.width / PRINT_DPI) * 25.4,
        heightMm: (size.height / PRINT_DPI) * 25.4,
      };
      const layout = layoutPrintSheet({
        sheet,
        dpi: PRINT_DPI,
        photo,
        // Print shop approach: photos are packed tightly together, separated by crop lines (6 photos fit exactly on a 4x6 inch page for 2x2 inch size).
        gapMm: 0,
        marginMm: 0,
        guides,
      });
      if (layout.placements.length === 0) {
        throw new RunError('doesNotFit', { name: displayName(item) });
      }
      const ops: DrawOp[] = [
        ...layout.placements.map((dst): DrawOp =>
          layout.rotated
            ? // Photo rotated 90 degrees to fit into a horizontal grid cell: rotate around the cell center, swapping width and height when drawing.
              {
                kind: 'image',
                source: { uri: item.uri },
                dst: {
                  x: dst.x + (dst.width - dst.height) / 2,
                  y: dst.y + (dst.height - dst.width) / 2,
                  width: dst.height,
                  height: dst.width,
                },
                angleDeg: 90,
              }
            : { kind: 'image', source: { uri: item.uri }, dst },
        ),
        ...layout.guides.map((g): DrawOp => ({ kind: 'line', ...g, color: '#BBBBBB', width: 2 })),
      ];
      return compose(
        ctx,
        `${item.name}-${String(params.sheet)}`,
        { width: layout.width, height: layout.height, background: '#FFFFFF' },
        ops,
      );
    });
  },
};
