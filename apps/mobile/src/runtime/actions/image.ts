import {
  formatFileSize,
  type Locale,
  RunCancelled,
  RunError,
  aspectRatio,
  type ActionImpl,
  type RunItem,
} from '@morph/core';

import {
  readExif,
  resizeDimensions,
  searchForTargetSize,
  stripJpegMetadata,
  type ResizeSpec,
} from '@morph/tool-image';

import { t } from '../../i18n';
import type { ImageFormat, ImageOps, VisionPlatform } from '../platform';
import { fileItems, freshName, readItem, writeItem, type RunServices } from './helpers';

// Image action implementation. Pixel processing delegated to platform (expo-image-manipulator), algorithms in packages/tool-image.

type Impl = ActionImpl<RunServices>;
type Ctx = Parameters<Impl>[2];

const EXT: Record<ImageFormat, string> = { jpeg: 'jpg', png: 'png', webp: 'webp' };
const MIME: Record<ImageFormat, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

/** Preserve original format; unsupported formats like HEIC are converted to JPG (D-047: never output HEIC by default). */
function keepFormat(item: RunItem): ImageFormat {
  if (item.mimeType === 'image/png') return 'png';
  if (item.mimeType === 'image/webp') return 'webp';
  return 'jpeg';
}

export const formatBytes = (bytes: number, locale: Locale = 'en') =>
  formatFileSize(bytes, locale, true);

export async function sizeOf(ctx: Ctx, item: RunItem) {
  if (item.width && item.height) return { width: item.width, height: item.height };
  try {
    return await ctx.services.files.imageSize(item.uri);
  } catch {
    throw new RunError('unreadable', { name: `${item.name}.${item.ext}` });
  }
}

/** Process an image, outputting a new temporary file in the current run. */
export async function encode(
  ctx: Ctx,
  item: RunItem,
  ops: ImageOps,
  format: ImageFormat,
  quality: number,
): Promise<RunItem> {
  let out;
  try {
    out = await ctx.services.files.transformImage(
      item.uri,
      ops,
      { format, quality },
      ctx.services.runId,
      freshName(item.name, EXT[format]),
    );
  } catch {
    throw new RunError('unreadable', { name: `${item.name}.${item.ext}` });
  }
  const { takenAt } = item;
  return {
    uri: out.uri,
    name: item.name,
    ext: EXT[format],
    mimeType: MIME[format],
    size: out.size,
    width: out.width,
    height: out.height,
    ...(takenAt !== undefined ? { takenAt } : {}),
  };
}

/** Process images one by one, with progress tracking and cancellation support. */
export async function eachImage(
  input: Parameters<Impl>[0],
  ctx: Ctx,
  fn: (item: RunItem) => Promise<RunItem>,
) {
  const items = fileItems(input);
  const out: RunItem[] = [];
  for (const [i, item] of items.entries()) {
    ctx.throwIfCancelled();
    out.push(await fn(item));
    ctx.progress(i + 1, items.length);
  }
  return { type: 'images' as const, items: out };
}

/**
 * System models required for background removal and ID photo background replacement: explains
 * reason when unsupported; on Android, prompts user on first use before letting Google Play
 * Services download the model.
 */
export async function backgroundModel(ctx: Ctx): Promise<VisionPlatform> {
  const vision = ctx.services.files.vision;
  if (!vision?.backgroundRemovalSupported)
    throw new RunError('unsupportedAction', { action: t(ctx.locale, 'backgroundNeedsSystem') });
  let status;
  try {
    status = await vision.backgroundStatus();
  } catch {
    throw new RunError('packFailed', { detail: t(ctx.locale, 'backgroundDownloadFailed') });
  }
  if (status === 'unsupported')
    throw new RunError('unsupportedAction', { action: t(ctx.locale, 'backgroundNeedsSystem') });
  if (status === 'download') {
    const ok = await ctx.services.ui.confirm(
      t(ctx.locale, 'backgroundDownloadAsk'),
      t(ctx.locale, 'backgroundDownload'),
      t(ctx.locale, 'cancel'),
      t(ctx.locale, 'backgroundDownloadBody'),
    );
    if (!ok) throw new RunCancelled();
    ctx.throwIfCancelled();
    try {
      await vision.downloadBackgroundModel();
    } catch {
      throw new RunError('packFailed', { detail: t(ctx.locale, 'backgroundDownloadFailed') });
    }
  }
  return vision;
}

export const IMAGE_IMPLS: Record<string, Impl> = {
  async 'image.adjust'(input, params, ctx) {
    const vision = ctx.services.files.vision;
    if (!vision)
      throw new RunError('unsupportedAction', { action: t(ctx.locale, 'imageAdjustmentNeedsApp') });
    return eachImage(input, ctx, async (item) => {
      const format =
        item.mimeType === 'image/png' || item.mimeType === 'image/webp' ? 'png' : 'jpeg';
      try {
        const result = await vision.adjustImage(
          item.uri,
          {
            mode: params.mode as 'auto' | 'manual',
            brightness: Number(params.brightness),
            contrast: Number(params.contrast),
            saturation: Number(params.saturation),
          },
          format,
          ctx.services.runId,
          freshName(item.name, format === 'png' ? 'png' : 'jpg'),
        );
        ctx.throwIfCancelled();
        return {
          ...item,
          ...result,
          ext: format === 'png' ? 'png' : 'jpg',
          mimeType: MIME[format],
        };
      } catch (error) {
        if (error instanceof RunCancelled) throw error;
        throw new RunError('unreadable', { name: item.name });
      }
    });
  },
  async 'image.removeBackground'(input, params, ctx) {
    const vision = await backgroundModel(ctx);
    const background = params.background === 'transparent' ? 'transparent' : String(params.color);
    return eachImage(input, ctx, async (item) => {
      try {
        ctx.throwIfCancelled();
        const result = await vision.removeBackground(
          item.uri,
          background,
          ctx.services.runId,
          freshName(item.name, 'png'),
        );
        ctx.throwIfCancelled();
        return { ...item, ...result, ext: 'png', mimeType: 'image/png' };
      } catch (error) {
        if (error instanceof RunCancelled) throw error;
        throw new RunError('backgroundFailed', { name: item.name });
      }
    });
  },
  async 'image.convert'(input, params, ctx) {
    const { format, quality } = params as { format: ImageFormat; quality: number };
    return eachImage(input, ctx, (item) => encode(ctx, item, {}, format, quality / 100));
  },

  async 'image.resize'(input, params, ctx) {
    const spec = params as unknown as ResizeSpec;
    return eachImage(input, ctx, async (item) => {
      const size = await sizeOf(ctx, item);
      const target = resizeDimensions(size, spec);
      const format = keepFormat(item);
      return encode(ctx, item, { resize: target }, format, 0.9);
    });
  },

  async 'image.compress'(input, params, ctx) {
    const { maxKB, format } = params as { maxKB: number; format: ImageFormat };
    const target = maxKB * 1024;
    return eachImage(input, ctx, async (item) => {
      const size = await sizeOf(ctx, item);
      let last: RunItem | null = null;
      const result = await searchForTargetSize({
        targetBytes: target,
        // Minimum scale down to a 64-pixel long side to prevent compression into illegible thumbnails.
        minScale: Math.min(1, 64 / Math.max(size.width, size.height)),
        encode: async (quality, scale) => {
          ctx.throwIfCancelled();
          const resize =
            scale < 1
              ? {
                  width: Math.max(1, Math.round(size.width * scale)),
                  height: Math.max(1, Math.round(size.height * scale)),
                }
              : undefined;
          last = await encode(ctx, item, resize ? { resize } : {}, format, quality);
          return last.size;
        },
      });
      if (!result.met || !last) {
        throw new RunError('targetNotMet', {
          name: `${item.name}.${item.ext}`,
          target: formatBytes(target, ctx.locale),
          got: formatBytes(result.bytes, ctx.locale),
        });
      }
      return last;
    });
  },

  async 'image.crop'(input, params, ctx) {
    const items = fileItems(input);
    const sized: RunItem[] = [];
    for (const item of items) sized.push({ ...item, ...(await sizeOf(ctx, item)) });
    const rects = await ctx.services.ui.open('crop', {
      items: sized,
      aspect: aspectRatio(String(params.aspect)),
    });
    if (!rects) throw new RunCancelled();
    let i = 0;
    return eachImage({ type: 'images', items: sized }, ctx, (item) =>
      encode(ctx, item, { crop: rects[i++]! }, keepFormat(item), 0.92),
    );
  },

  async 'image.rotate'(input, params, ctx) {
    const { angle, flip } = params as { angle: 0 | 90 | 180 | 270; flip: string };
    const ops: ImageOps = {
      ...(angle ? { rotate: angle } : {}),
      ...(flip !== 'none' ? { flip: flip as 'horizontal' | 'vertical' } : {}),
    };
    return eachImage(input, ctx, (item) => encode(ctx, item, ops, keepFormat(item), 0.92));
  },

  async 'image.stripMetadata'(input, _params, ctx) {
    return eachImage(input, ctx, async (item) => {
      if (item.mimeType === 'image/jpeg') {
        const bytes = await readItem(ctx.services, item);
        const { orientation } = readExif(bytes);
        // Losslessly strip orientation when it is 1 (or absent); otherwise straighten according to orientation before re-encoding to prevent image rotation issues.
        if (orientation === null || orientation === 1) {
          try {
            const stripped = stripJpegMetadata(bytes).bytes;
            const { uri: _uri, size: _size, ...rest } = item;
            return await writeItem(ctx.services, stripped, rest);
          } catch {
            // Not standard JPEG: fallback to re-encoding.
          }
        }
      }
      return encode(ctx, item, {}, 'jpeg', 0.92);
    });
  },
};
