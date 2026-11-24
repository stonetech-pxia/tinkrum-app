import { RunCancelled, RunError, type ActionImpl, type RunItem } from '@morph/core';
import {
  clampQuad,
  isConvexQuad,
  orderQuad,
  pickPaper,
  quadArea,
  warpSize,
  type GrayImage,
  type Point,
  type Quad,
} from '@morph/tool-image';

import type { EnhanceMode } from '../platform';
import {
  displayName,
  fileItems,
  freshName,
  fromBase64,
  imageForPage,
  writeItem,
  type RunServices,
} from './helpers';

// Scan (T5): edge detection -> user confirms or drags four corners locally -> perspective
// correction; enhancement uses Skia. Edge detection and correction use system Vision / Core Image
// on iOS (D-086), and the scan package page (OpenCV.js) on other platforms; both provide
// candidates, and selection uses the same pickPaper logic (D-327). System document camera pages are
// already straightened and passed through directly.

type Impl = ActionImpl<RunServices>;

/** Long side of the photo sent for edge detection (12 MP photos at 4032 px passed as-is, corrected on original image). */
const SCAN_INPUT_SIDE = 4096;
/** Long side of straightened page: A4 at ~200 dpi. Document camera pages are also scaled down to this size. */
export const SCAN_OUTPUT_SIDE = 2400;
/** Treat paper as undetected if found area is less than 1/10 of the photo (likely noise). */
const MIN_PAPER_SHARE = 0.1;

/** Quadrilateral valid as paper: convex, not less than 1/10 of the photo area. */
function usableQuad(quad: Quad, size: { width: number; height: number }): boolean {
  return isConvexQuad(quad) && quadArea(quad) >= size.width * size.height * MIN_PAPER_SHARE;
}

/** Scan package page edge detection result: candidates (four points each) and a small grayscale image, selected by pickPaper (D-326). */
interface PackDetect {
  candidates: Point[][];
  gray: { width: number; height: number; data: string };
}

/**
 * Flatten straightened pages (D-274, performed unless flatten parameter is false): returns as-is
 * if flattening model is not installed (user hasn't downloaded it), scanning normally. Failure on
 * a single page only skips flattening for that page without failing the entire scan.
 */
async function flattenPages(
  items: RunItem[],
  params: Record<string, unknown>,
  ctx: Parameters<Impl>[2],
): Promise<RunItem[]> {
  const vision = ctx.services.files.vision;
  if (params.flatten === false || !vision?.flatten) return items;
  const out: RunItem[] = [];
  for (const [i, item] of items.entries()) {
    ctx.throwIfCancelled();
    let page;
    try {
      page = await vision.flatten(item.uri, ctx.services.runId, freshName(item.name, 'jpg'));
    } catch {
      out.push(item);
      continue;
    }
    // Model not installed: subsequent pages behave similarly and return as-is.
    if (!page) return [...out, ...items.slice(i)];
    const { takenAt } = item;
    out.push({
      uri: page.uri,
      name: item.name,
      ext: 'jpg',
      mimeType: 'image/jpeg',
      size: page.size,
      width: page.width,
      height: page.height,
      ...(takenAt !== undefined ? { takenAt } : {}),
    });
    ctx.progress(i + 1, items.length);
  }
  return out;
}

export const SCAN_IMPLS: Record<string, Impl> = {
  async 'scan.detect'(input, params, ctx) {
    const items = fileItems(input);
    // Document camera pages are already straightened; edge detection and corner adjustment UI are skipped when all pages are of this type (flattening still runs).
    const todo = items.filter((item) => !item.straightened);
    if (todo.length === 0) return { type: 'images', items: await flattenPages(items, params, ctx) };
    const { packs } = ctx.services;
    // Android ML Kit cannot perform edge detection on photos, fallback to scan package.
    const native = ctx.services.files.vision;
    const vision = native?.canFindPaper ? native : null;
    if (!vision && !packs) throw new RunError('packFailed', { detail: 'scan' });
    const found: { item: RunItem; quad: Quad | null }[] = [];
    for (const [i, original] of todo.entries()) {
      ctx.throwIfCancelled();
      const item = await imageForPage(ctx.services, original, SCAN_INPUT_SIDE);
      const size = { width: item.width!, height: item.height! };
      let detected: Quad | null;
      try {
        // Edge detection supplies only candidates and grayscale image; both platforms use pickPaper for selection (D-326, D-327).
        let paper: { candidates: Point[][]; gray: GrayImage };
        if (vision) {
          paper = await vision.findPaper(item.uri);
        } else {
          const { candidates, gray } = await packs!.runtime.call<PackDetect>(
            'scan',
            'detect',
            { file: 'input', maxSide: 1000 },
            { input: item.uri },
          );
          paper = { candidates, gray: { ...gray, data: fromBase64(gray.data) } };
        }
        const quads = paper.candidates
          .map((pts) => clampQuad(orderQuad(pts), size))
          .filter((q) => usableQuad(q, size));
        detected = pickPaper(quads, size, paper.gray);
      } catch (e) {
        const detail = String(e instanceof Error ? e.message : e);
        throw new RunError(vision ? 'unexpected' : 'packFailed', { detail });
      }
      const quad = detected ? clampQuad(detected, size) : null;
      const usable = quad && usableQuad(quad, size);
      found.push({ item, quad: usable ? quad : null });
      ctx.progress(i + 1, todo.length);
    }
    // Edge detection can fail on cluttered backgrounds or when paper extends past edges, so require user confirmation of the four corners for every image (mandatory).
    const quads = await ctx.services.ui.open('corners', { items: found });
    if (!quads) throw new RunCancelled();
    const straightened: RunItem[] = [];
    for (const [i, { item }] of found.entries()) {
      ctx.throwIfCancelled();
      const quad = clampQuad(quads[i]!, { width: item.width!, height: item.height! });
      const size = warpSize(quad, SCAN_OUTPUT_SIDE);
      const { takenAt } = todo[i]!;
      const meta = {
        name: item.name,
        ext: 'jpg',
        mimeType: 'image/jpeg',
        ...(takenAt !== undefined ? { takenAt } : {}),
      };
      try {
        if (vision) {
          const page = await vision.straighten(
            item.uri,
            quad,
            size,
            ctx.services.runId,
            freshName(item.name, 'jpg'),
          );
          straightened.push({ ...meta, uri: page.uri, size: page.size, ...size });
        } else {
          const page = await packs!.runtime.call<{ width: number; height: number; data: string }>(
            'scan',
            'warp',
            { file: 'input', quad, ...size, quality: 0.9 },
            { input: item.uri },
          );
          straightened.push(
            await writeItem(ctx.services, fromBase64(page.data), {
              ...meta,
              width: page.width,
              height: page.height,
            }),
          );
        }
      } catch {
        throw new RunError('unreadable', { name: displayName(todo[i]!) });
      }
      ctx.progress(i + 1, found.length);
    }
    // Restore in original order (already straightened pages are kept as-is).
    const out = items.map((item) => (item.straightened ? item : straightened.shift()!));
    return { type: 'images', items: await flattenPages(out, params, ctx) };
  },

  async 'scan.enhance'(input, params, ctx) {
    const items = fileItems(input);
    const mode = params.mode as EnhanceMode | 'none';
    if (mode === 'none') return { type: 'images', items };
    const out: RunItem[] = [];
    for (const [i, item] of items.entries()) {
      ctx.throwIfCancelled();
      let encoded;
      try {
        encoded = await ctx.services.files.enhanceImage(
          item.uri,
          mode,
          ctx.services.runId,
          freshName(item.name, 'jpg'),
        );
      } catch {
        throw new RunError('unreadable', { name: displayName(item) });
      }
      const { takenAt } = item;
      out.push({
        uri: encoded.uri,
        name: item.name,
        ext: 'jpg',
        mimeType: 'image/jpeg',
        size: encoded.size,
        width: encoded.width,
        height: encoded.height,
        ...(takenAt !== undefined ? { takenAt } : {}),
        // Use pre-enhanced image for OCR (D-267).
        ocrSource: {
          uri: item.uri,
          for: encoded.uri,
          width: encoded.base.width,
          height: encoded.base.height,
          skew: encoded.skew,
        },
      });
      ctx.progress(i + 1, items.length);
    }
    return { type: 'images', items: out };
  },
};
