import {
  GIF_MAX_FRAMES,
  GIF_MAX_SECONDS,
  RunError,
  type ActionImpl,
  type RunItem,
} from '@morph/core';

import type { GifOutput, MediaPlatform } from '../platform';
import { displayName, fileItems, freshName, type RunServices } from './helpers';
import { mediaError } from './video';

// GIFs (D-184): video to GIF, multiple images to animated GIF. Encoding is handled in the native
// module morph-media (iOS ImageIO, custom Android GifEncoder); unavailable in Expo Go, throws
// needsFullApp.

type Impl = ActionImpl<RunServices>;
type Ctx = Parameters<Impl>[2];

/** Allow duration slightly exceeding the upper limit (minor frame discrepancies during trimming). */
const GIF_SLACK_MS = 500;

function mediaOf(ctx: Ctx): MediaPlatform {
  const media = ctx.services.files.media;
  if (!media) throw new RunError('needsFullApp');
  return media;
}

function jobFor(ctx: Ctx, index: number, total: number) {
  return {
    progress: (f: number) =>
      ctx.progress(Math.round(((index + Math.min(1, f)) / total) * 100), 100, 'percent'),
    isCancelled: () => {
      try {
        ctx.throwIfCancelled();
        return false;
      } catch {
        return true;
      }
    },
  };
}

const gifItem = (name: string, out: GifOutput): RunItem => ({
  uri: out.uri,
  name,
  ext: 'gif',
  mimeType: 'image/gif',
  size: out.size,
  width: out.width,
  height: out.height,
});

export const GIF_IMPLS: Record<string, Impl> = {
  async 'video.toGif'(input, params, ctx) {
    const { width, fps } = params as { width: number; fps: number };
    const media = mediaOf(ctx);
    const items = fileItems(input);
    const out: RunItem[] = [];
    for (const [i, item] of items.entries()) {
      ctx.throwIfCancelled();
      try {
        const info = await media.probe(item.uri);
        if (!info.hasVideo) throw new RunError('mediaUnsupported', { name: displayName(item) });
        if (info.durationMs > GIF_MAX_SECONDS * 1000 + GIF_SLACK_MS) {
          throw new RunError('tooLong', { name: displayName(item), seconds: GIF_MAX_SECONDS });
        }
        const gif = await media.videoGif(
          item.uri,
          { width, fps },
          ctx.services.runId,
          freshName(item.name, 'gif'),
          jobFor(ctx, i, items.length),
        );
        out.push(gifItem(item.name, gif));
      } catch (e) {
        throw mediaError(e, item);
      }
    }
    ctx.progress(100, 100, 'percent');
    return { type: 'images', items: out };
  },

  async 'image.toGif'(input, params, ctx) {
    const { delayMs, maxSide } = params as { delayMs: number; maxSide: number };
    const media = mediaOf(ctx);
    const items = fileItems(input);
    if (items.length > GIF_MAX_FRAMES) throw new RunError('tooMany', { max: GIF_MAX_FRAMES });
    const first = items[0]!;
    try {
      const gif = await media.imagesGif(
        items.map((item) => item.uri),
        { delayMs, maxSide },
        ctx.services.runId,
        freshName(first.name, 'gif'),
        jobFor(ctx, 0, 1),
      );
      ctx.progress(100, 100, 'percent');
      return { type: 'images', items: [gifItem(first.name, gif)] };
    } catch (e) {
      throw mediaError(e, first);
    }
  },
};
