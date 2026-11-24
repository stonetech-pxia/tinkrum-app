import {
  t,
  FILE_ACCEPT,
  OFFICE_MIME_TYPES,
  RunCancelled,
  isOfficeFile,
  RunError,
  mediaKindOf,
  renderNameTemplate,
  templateReads,
  tidyOcrText,
  sanitizeFileName,
  shareFitsInput,
  uniqueFileName,
  fileFilterNeeds,
  filterFiles,
  type ActionImpl,
  type FileFilter,
  type Locale,
  type OcrLanguage,
  type FileValueType,
  type RunItem,
} from '@morph/core';

import { decodeQr, downscaleRgba } from '@morph/tool-qr';

import { saveRunItemSource } from '../../desk/saved-source-file';
import { indexAssetText } from '../../storage/asset-text';
import type { PickedFile } from '../platform';
import {
  baseName,
  checkSizes,
  displayName,
  extOf,
  fileItems,
  freshName,
  imageForPage,
  isImageMime,
  isMediaFile,
  mimeOf,
  type RunServices,
} from './helpers';
import { VISION_LANGUAGES } from './ocr';
import { SCAN_OUTPUT_SIDE } from './scan';

// Core I/O action implementations (TOOLS_DESIGN §5).

type Impl = ActionImpl<RunServices>;

const DOCUMENT_TYPES: Record<string, string[]> = {
  pdf: ['application/pdf'],
  images: ['image/*'],
  pdfOrImages: ['application/pdf', 'image/*'],
  videos: ['video/*'],
  audio: ['audio/*'],
  documents: [...OFFICE_MIME_TYPES],
  any: ['*/*'],
};

const KINDS: Record<string, string> = {
  pdf: 'PDF',
  images: 'image',
  videos: 'video',
  audio: 'audio',
  documents: 'document',
};
const kindOf = (accept: string) => KINDS[accept] ?? 'PDF/image';

function matches(accept: string, mime: string, name: string): boolean {
  switch (accept) {
    case 'pdf':
      return mime === 'application/pdf';
    case 'images':
      return isImageMime(mime);
    case 'pdfOrImages':
      return mime === 'application/pdf' || isImageMime(mime);
    case 'videos':
      return mediaKindOf(mime, name) === 'video';
    case 'audio':
      return mediaKindOf(mime, name) === 'audio';
    case 'documents':
      return isOfficeFile(mime, name);
    default:
      return true;
  }
}

/**
 * Copy selected files into the current run's temporary directory. keepSource: files in the inbox
 * batch (shared, selected in app, or from previous results) are used in place and not moved so
 * "try again" can still use them; files selected mid-run are moved in as usual and deleted
 * together at the end of the run.
 */
async function importPicked(
  services: RunServices,
  picked: readonly PickedFile[],
  ctx: Parameters<Impl>[2],
  keepSource = false,
): Promise<RunItem[]> {
  const items: RunItem[] = [];
  for (const [i, f] of picked.entries()) {
    ctx.throwIfCancelled();
    const clean = sanitizeFileName(f.name);
    const mimeType = mimeOf(clean, f.mimeType);
    const ext = extOf(clean) || (mimeType === 'application/pdf' ? 'pdf' : 'jpg');
    const name = baseName(clean);
    // Videos and audio can be several GBs in size: do not copy, move them in or use in place (D-142).
    const media = isMediaFile({ name: clean, mimeType });
    let stored;
    try {
      stored = media
        ? await services.files.adoptIntoRun(f.uri, services.runId, freshName(name, ext), keepSource)
        : await services.files.copyToRun(f.uri, services.runId, freshName(name, ext));
    } catch {
      throw new RunError('accessDenied', { name: f.name });
    }
    // Word documents on the desk containing intermediate format (D-466): saved into the current run, subsequent steps (document to PDF) lay them out accordingly.
    const docDoc = f.docDoc
      ? await services.files.writeRunFile(
          services.runId,
          freshName(name, 'json'),
          new TextEncoder().encode(JSON.stringify(f.docDoc)),
        )
      : null;
    items.push({
      uri: stored.uri,
      name,
      ext,
      mimeType,
      size: stored.size || f.size || 0,
      ...(docDoc ? { docDoc: { uri: docDoc.uri, for: stored.uri } } : {}),
      ...(f.width ? { width: f.width } : {}),
      ...(f.height ? { height: f.height } : {}),
      ...(f.takenAt !== undefined ? { takenAt: f.takenAt } : {}),
      ...(f.modifiedAt !== undefined ? { modifiedAt: f.modifiedAt } : {}),
      ...(f.straightened ? { straightened: true } : {}),
      ...(f.durationMs ? { durationMs: f.durationMs } : {}),
    });
    ctx.progress(i + 1, picked.length);
  }
  checkSizes(
    items.map((i) => ({ name: `${i.name}.${i.ext}`, size: i.size, mimeType: i.mimeType })),
  );
  return items;
}

/**
 * Results saved by this quick action previously (D-197): the most recent successful run that
 * saved a file. Returns null if the file has been deleted or authorization was revoked (§7G).
 */
async function lastResult(ctx: Parameters<Impl>[2]): Promise<PickedFile | null> {
  const { repo, files, grantee } = ctx.services;
  const run = (await repo.listToolRuns(200)).find(
    (r) => r.workflowId === ctx.workflow.id && r.status === 'succeeded' && r.outputAssetId,
  );
  const asset = run ? await repo.getAsset(run.outputAssetId!) : null;
  if (!asset || !(await repo.hasGrant(grantee, asset.id))) return null;
  return {
    uri: files.fileUri(asset.path),
    name: asset.name,
    size: asset.size,
    mimeType: asset.mimeType,
  };
}

function addExistingQuestion(locale: import('@morph/core').Locale, last: string | null) {
  return {
    title: t(locale, 'io_Add_which_existing_file_a4bbf'),
    message: t(locale, 'io_It_goes_together_with_this_run_s_files_03244'),
    options: [
      ...(last ? [t(locale, 'io_Last_one_15660', { v0: last })] : []),
      t(locale, 'io_Choose_one_in_Files_e6073'),
      t(locale, 'io_Start_a_new_one_this_time_6e970'),
    ],
  };
}

function checkCount(count: number, min: number, max: number, kind: string) {
  if (count < min) throw new RunError('tooFew', { min, kind });
  if (count > max) throw new RunError('tooMany', { max });
}

/**
 * Files shared from other apps (D-115): used only in the first step to replace the picker. Type,
 * count, size, and selector checks are performed similarly; the inbox page already filters for
 * compatible workflows, and this serves as a re-verification.
 */
async function importShared(
  ctx: Parameters<Impl>[2],
  params: Record<string, unknown>,
  kind: string,
): Promise<{ type: FileValueType; items: RunItem[] } | null> {
  const shared = ctx.index === 0 ? ctx.services.incoming : null;
  if (!shared) return null;
  const infos = shared.map((f) => ({ ...f, mimeType: mimeOf(f.name, f.mimeType) }));
  const fit = shareFitsInput(ctx.action.id, params, infos);
  if (!fit.ok) {
    if (fit.reason === 'tooFew') throw new RunError('tooFew', { min: fit.min, kind });
    if (fit.reason === 'tooMany') throw new RunError('tooMany', { max: fit.max });
    throw new RunError('wrongType', { name: shared[0]?.name ?? '', kind });
  }
  checkSizes(infos);
  return { type: fit.type, items: await importPicked(ctx.services, shared, ctx, true) };
}

/** Save temporary files as user files (shared by file.save step and result page "Save"). Skips files that are already saved. */
export async function saveItems(
  services: Pick<RunServices, 'files' | 'repo' | 'grantee'>,
  items: readonly RunItem[],
  ctx: { now(): Date; newId(): string; progress?(done: number, total: number): void },
): Promise<RunItem[]> {
  const { files, repo, grantee } = services;
  const existing = (await repo.listAssets()).map((a) => a.name);
  const saved: RunItem[] = [];
  const toIndex: { path: string; mimeType: string }[] = [];
  for (const [i, item] of items.entries()) {
    if (item.assetId) {
      saved.push(item);
      continue;
    }
    const name = uniqueFileName(item.name, item.ext, existing);
    existing.push(name);
    const id = ctx.newId();
    let stored;
    try {
      stored = await files.saveRunFile(item.uri, id, name);
    } catch (e) {
      throw new RunError('saveFailed', { detail: String(e) });
    }
    try {
      await repo.addAsset({
        id,
        name,
        mimeType: item.mimeType,
        size: stored.size,
        path: stored.path,
        source: 'generated',
        createdAt: ctx.now().getTime(),
      });
    } catch (e) {
      // Result file already saved to document library directory but failed to register: delete this new copy to avoid leaving orphan files (R10).
      await files.removeAssetFile(stored.path).catch(() => undefined);
      throw new RunError('saveFailed', { detail: String(e) });
    }
    // Grant authorization for workflow-generated files to the workflow (§7G).
    await repo.grantAsset(grantee, id);
    // Results of Excel and Word conversion: intermediate format and original images are saved alongside so they can later be restored from storage to the desk for editing (D-400).
    await saveRunItemSource(files, item, id);
    saved.push({ ...item, assetId: id, name: baseName(name) });
    toIndex.push({ path: stored.path, mimeType: item.mimeType });
    ctx.progress?.(i + 1, items.length);
  }
  // Text in files is read afterwards without blocking execution (D-455).
  void (async () => {
    for (const asset of toIndex) await indexAssetText(files, asset);
  })();
  return saved;
}

/** OCR language for naming: interface language (Chinese is Simplified), system recognition will supplement with English. */
const NAMING_OCR_LANGUAGE: Record<Locale, OcrLanguage> = { zh: 'chi_sim', en: 'eng', fr: 'fra' };

/**
 * Local recognition before naming a file (D-244): images only (PDFs and videos are not
 * recognized; falls back to original name if rules fail). OCR requires system capabilities (iOS
 * Vision, Android ML Kit), throws needsRecognition when unavailable (Expo Go); QR codes are pure
 * JS and readable anywhere.
 */
async function recognizeForName(
  ctx: Parameters<Impl>[2],
  item: RunItem,
  reads: { ocr: boolean; qr: boolean },
): Promise<{ ocr?: string; qr?: string }> {
  if (!isImageMime(item.mimeType)) return {};
  const out: { ocr?: string; qr?: string } = {};
  if (reads.ocr) {
    const languages = VISION_LANGUAGES[NAMING_OCR_LANGUAGE[ctx.locale]];
    const vision = ctx.services.files.vision;
    if (!vision?.supportsLanguage(languages[0]!)) throw new RunError('needsRecognition');
    const page = await imageForPage(ctx.services, item, 3500);
    try {
      out.ocr = tidyOcrText(await vision.recognizeText(page.uri, languages));
    } catch {
      out.ocr = '';
    }
  }
  if (reads.qr) {
    try {
      const pixels = await ctx.services.files.imagePixels(item.uri, 1600);
      out.qr = decodeQr(downscaleRgba(pixels, 1600)) ?? '';
    } catch {
      out.qr = '';
    }
  }
  return out;
}

export const IO_IMPLS: Record<string, Impl> = {
  async 'in.photos'(_input, params, ctx) {
    const shared = await importShared(ctx, params, 'image');
    if (shared) return shared;
    const { source, min, max } = params as { source: string; min: number; max: number };
    const { files, ui } = ctx.services;
    let picked: PickedFile[] = [];
    if (source === 'scanner' && files.vision?.documentCamera) {
      // System document camera (iOS VisionKit, Android ML Kit): real-time edge detection, auto-capture, multi-page, straightens images upon completion (D-086, D-087).
      const pages = await files.vision.scanDocuments(ctx.services.runId, SCAN_OUTPUT_SIDE);
      if (!pages || pages.length === 0) throw new RunCancelled();
      picked = pages;
    } else if (source === 'camera' || source === 'scanner') {
      // Fallback to standard camera when document camera is unavailable (Expo Go, simulator, Android without Google Play Services), with subsequent edge detection step straightening the image.

      while (picked.length < max) {
        const photo = await files.takePhoto();
        if (!photo) break;
        picked.push(photo);
        if (picked.length >= max) break;
        const more = await ui.confirm(
          t(ctx.locale, 'io_taken_af2cf', { v0: picked.length }),
          t(ctx.locale, 'io_Take_another_1b43d'),
          t(ctx.locale, 'io_Done_6f135'),
        );
        if (!more) break;
      }
      if (picked.length === 0) throw new RunCancelled();
    } else if (source === 'files') {
      // Pick from Files (D-184): downloaded or transferred images, including HEIC.
      const result = await files.pickDocuments(DOCUMENT_TYPES.images!, max > 1);
      if (!result) throw new RunCancelled();
      for (const f of result) {
        if (!isImageMime(mimeOf(f.name, f.mimeType))) {
          throw new RunError('wrongType', { name: f.name, kind: 'image' });
        }
      }
      picked = result;
    } else {
      const result = await files.pickPhotos(max);
      if (!result) throw new RunCancelled();
      picked = result;
    }
    checkCount(picked.length, min, max, 'image');
    checkSizes(picked);
    return { type: 'images', items: await importPicked(ctx.services, picked, ctx) };
  },

  async 'in.videos'(_input, params, ctx) {
    const shared = await importShared(ctx, params, 'video');
    if (shared) return shared;
    const { source, min, max } = params as { source?: string; min: number; max: number };
    // Pick from "Files" (D-185): Videos copied from a computer or downloaded are usually not in the photo library.
    const picked =
      source === 'files'
        ? await ctx.services.files.pickDocuments(DOCUMENT_TYPES.videos!, max > 1)
        : await ctx.services.files.pickVideos(max);
    if (!picked) throw new RunCancelled();
    checkCount(picked.length, min, max, 'video');
    for (const f of picked) {
      if (mediaKindOf(mimeOf(f.name, f.mimeType), f.name) !== 'video') {
        throw new RunError('wrongType', { name: f.name, kind: 'video' });
      }
    }
    checkSizes(picked.map((f) => ({ ...f, mimeType: mimeOf(f.name, f.mimeType) })));
    return { type: 'video', items: await importPicked(ctx.services, picked, ctx) };
  },

  // Audio (D-154): Pick from "Files", or open the recorder interface to record a clip now; recordings shared in are used directly.
  async 'in.audio'(_input, params, ctx) {
    const shared = await importShared(ctx, params, 'audio');
    if (shared) return shared;
    const { source, min, max, autoStart } = params as {
      source: 'files' | 'record';
      min: number;
      max: number;
      autoStart?: boolean;
    };
    if (source === 'record') {
      const name = renderNameTemplate(t(ctx.locale, 'io_Recording_1a04e'), {
        now: ctx.now(),
        index: 1,
        sourceName: '',
      });
      const recorded = await ctx.services.ui.open('record', {
        name,
        ...(autoStart === true ? { autoStart: true } : {}),
      });
      if (!recorded) throw new RunCancelled();
      return { type: 'audio', items: await importPicked(ctx.services, [recorded], ctx) };
    }
    const picked = await ctx.services.files.pickDocuments(DOCUMENT_TYPES.audio!, max > 1);
    if (!picked) throw new RunCancelled();
    checkCount(picked.length, min, max, 'audio');
    for (const f of picked) {
      if (mediaKindOf(mimeOf(f.name, f.mimeType), f.name) !== 'audio') {
        throw new RunError('wrongType', { name: f.name, kind: 'audio' });
      }
    }
    checkSizes(picked.map((f) => ({ ...f, mimeType: mimeOf(f.name, f.mimeType) })));
    return { type: 'audio', items: await importPicked(ctx.services, picked, ctx) };
  },

  async 'in.files'(_input, params, ctx) {
    const { accept, min, max } = params as { accept: string; min: number; max: number };
    const shared = await importShared(ctx, params, kindOf(accept));
    if (shared) return shared;
    const picked = await ctx.services.files.pickDocuments(DOCUMENT_TYPES[accept]!, max > 1);
    if (!picked) throw new RunCancelled();
    checkCount(picked.length, min, max, kindOf(accept));
    for (const f of picked) {
      if (!matches(accept, mimeOf(f.name, f.mimeType), f.name)) {
        throw new RunError('wrongType', { name: f.name, kind: kindOf(accept) });
      }
    }
    checkSizes(picked.map((f) => ({ ...f, mimeType: mimeOf(f.name, f.mimeType) })));
    const type = FILE_ACCEPT[accept] as FileValueType;
    return { type, items: await importPicked(ctx.services, picked, ctx) };
  },

  async 'file.rename'(input, params, ctx) {
    const { template } = params as { template: string };
    const items = fileItems(input);
    // D-244: When the template contains {ocr:...} or {qr:...}, recognize each file locally first. The text is used only for naming; it is neither retained nor sent to the AI.
    const reads = templateReads(template);
    const recognized: { ocr?: string; qr?: string }[] = [];
    if (reads.ocr || reads.qr) {
      for (const [i, item] of items.entries()) {
        ctx.throwIfCancelled();
        recognized.push(await recognizeForName(ctx, item, reads));
        ctx.progress(i + 1, items.length);
      }
    }
    const taken: string[] = [];
    const named = items.map((item, i) => {
      const base = renderNameTemplate(template, {
        now: ctx.now(),
        index: i + 1,
        sourceName: item.name,
        ...(item.takenAt !== undefined ? { takenAt: new Date(item.takenAt) } : {}),
        ...(recognized[i] ? { recognized: recognized[i], locale: ctx.locale } : {}),
      });
      // No duplicate names in the same batch: report, report-2, report-3.
      const name = baseName(uniqueFileName(base, item.ext, taken));
      taken.push(`${name}.${item.ext}`);
      return { ...item, name };
    });
    // Temporary files are also renamed to the new name (the shared file name becomes this).
    const renamed: RunItem[] = [];
    const { files, runId } = ctx.services;
    // Use the inbox batch in place (needed again for retries), without being renamed or moved.
    const incoming = new Set(ctx.services.incoming?.map((f) => f.uri));
    for (const item of named) {
      const fileName = freshName(item.name, item.ext);
      // Videos and audio are large: temporary files are directly renamed (moved), and only originals from the inbox page are copied (D-142).
      let uri: string | null = null;
      if (isMediaFile({ name: `${item.name}.${item.ext}`, mimeType: item.mimeType })) {
        const moved = await files.adoptIntoRun(item.uri, runId, fileName, incoming.has(item.uri));
        if (moved.uri !== item.uri) uri = moved.uri;
      }
      uri ??= (await files.copyToRun(item.uri, runId, fileName)).uri;
      renamed.push({ ...item, uri });
    }
    return { ...input!, items: renamed } as typeof input & { items: RunItem[] };
  },

  async 'file.order'(input, _params, ctx) {
    const items = fileItems(input);
    const order = await ctx.services.ui.open('reorder', { items });
    if (!order) throw new RunCancelled();
    if (order.length === 0) throw new RunError('tooFew', { min: 1, kind: 'file' });
    return { ...input!, items: order.map((i) => items[i]!) } as typeof input & {
      items: RunItem[];
    };
  },

  // D-242: Filter by fixed conditions. Orientation needs width/height, duration needs duration: if not provided by the selector, read them locally first (used only for this run).
  async 'file.filter'(input, params, ctx) {
    const items = fileItems(input);
    const filter = params as unknown as FileFilter;
    const needs = fileFilterNeeds(filter);
    const known: RunItem[] = [];
    for (const [i, item] of items.entries()) {
      ctx.throwIfCancelled();
      let next = item;
      const kind = mediaKindOf(item.mimeType, displayName(item));
      if (needs.dimensions && kind === 'image' && !(item.width && item.height)) {
        try {
          next = { ...next, ...(await ctx.services.files.imageSize(item.uri)) };
        } catch {
          // Cannot read dimensions: does not meet the orientation condition.
        }
      }
      const media = ctx.services.files.media;
      if (needs.duration && (kind === 'video' || kind === 'audio') && !item.durationMs && media) {
        try {
          next = { ...next, durationMs: (await media.probe(item.uri)).durationMs };
        } catch {
          // Cannot read duration: does not meet the duration condition.
        }
      }
      known.push(next);
      ctx.progress(i + 1, items.length);
    }
    const kept = filterFiles(known, filter, ctx.now(), ctx.services.calendar);
    if (kept.length > 0) return { ...input!, items: kept } as typeof input & { items: RunItem[] };
    if (filter.whenEmpty === 'skip') return input!;
    throw new RunError('noneMatched', { count: items.length });
  },

  async 'file.addExisting'(input, params, ctx) {
    const items = fileItems(input);
    const last = await lastResult(ctx);
    const q = addExistingQuestion(ctx.locale, last?.name ?? null);
    const answer = await ctx.services.ui.choose(q.title, q.message, q.options);
    if (answer === null) throw new RunCancelled();
    const choice = last ? answer : answer + 1;
    let picked: PickedFile[] | null;
    if (choice === 0) picked = [last!];
    else if (choice === 1) {
      picked = await ctx.services.files.pickDocuments(DOCUMENT_TYPES.pdfOrImages!, false);
      if (!picked) throw new RunCancelled();
      for (const f of picked) {
        if (!matches('pdfOrImages', mimeOf(f.name, f.mimeType), f.name)) {
          throw new RunError('wrongType', { name: f.name, kind: kindOf('pdfOrImages') });
        }
      }
    } else return { type: 'files', items };
    const added = await importPicked(ctx.services, picked, ctx);
    return {
      type: 'files',
      items: params.position === 'before' ? [...added, ...items] : [...items, ...added],
    };
  },

  async 'file.save'(input, _params, ctx) {
    const items = await saveItems(ctx.services, fileItems(input), ctx);
    for (const item of items) if (item.assetId) ctx.saved.push(item.assetId);
    return { ...input!, items } as typeof input & { items: RunItem[] };
  },

  async 'out.share'(input, _params, ctx) {
    await ctx.services.files.shareUris(fileItems(input));
    return input!;
  },

  async 'out.saveToFolder'(input, _params, ctx) {
    // If a remembered folder exists, save directly into it; prompt the user to choose only the
    // first time (D-123); each quick action remembers its own (D-196). Closing the selector is not
    // considered a failure (just like closing the share sheet), and saving can be done again on the
    // results page.
    await ctx.services.files.saveToFolder(fileItems(input), ctx.workflow.id);
    return input!;
  },

  async 'out.saveToPhotos'(input, _params, ctx) {
    await ctx.services.files.saveToPhotos(fileItems(input).map((i) => i.uri));
    return input!;
  },

  async 'out.print'(input, _params, ctx) {
    for (const item of fileItems(input)) await ctx.services.files.print(item);
    return input!;
  },
};
