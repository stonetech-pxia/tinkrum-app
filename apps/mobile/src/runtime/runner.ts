import {
  HANDED_FILES_MAX,
  RunCancelled,
  RunError,
  stepLabel,
  isFileValue,
  sanitizeFileName,
  ocrPackId,
  runWorkflow,
  templateReads,
  type AskRequest,
  type Calendar,
  type DevicePack,
  type HandedFiles,
  type RunItem,
  type Locale,
  type OcrLanguage,
  type PackNeed,
  type Registry,
  type RunEvent,
  type RunResult,
  type RunValue,
  type Workflow,
} from '@morph/core';

import { t } from '../i18n';
import type { WorkspaceRepo } from '../storage/types';
import {
  baseName,
  checkSizes,
  extOf,
  freshName,
  isMediaFile,
  mimeOf,
  type RunServices,
} from './actions/helpers';
import { ACTION_IMPLS } from './actions';
import { VISION_LANGUAGES } from './actions/ocr';
import { resolveOcrLanguage } from './ocr-language';
import type { LocalUi } from './local';
import type { FilePlatform, PickedFile } from './platform';

// App-side execution entry point: connects the core executor (workflow/engine.ts) to local storage,
// platform capabilities, and runtime pages. This is the sole place where actions are executed;
// configuration contains only action IDs and parameters, with zero code.

export type { FilePlatform, PickedFile } from './platform';

export interface RunContext {
  workflow: Workflow;
  revisionId: number;
  repo: WorkspaceRepo;
  files: FilePlatform;
  registry: Registry;
  locale: Locale;
  now: () => Date;
  newId: () => string;
  ui: LocalUi;
  /** Data tables in the current configuration (for reading records). */
  collections?: RunServices['collections'];
  calendar?: Calendar;
  packs?: RunServices['packs'];
  askParams?: (request: AskRequest) => Promise<Record<string, unknown> | null>;
  ensurePack?: (packId: string, options?: { optional?: boolean }) => Promise<boolean>;
  /** Queries all extension packs required for this run upfront (D-299): returns optional packs that are not yet downloaded, or null if cancelled. */
  ensurePacks?: (needs: readonly PackNeed[]) => Promise<string[] | null>;
  signal?: { cancelled: boolean };
  onEvent?: (event: RunEvent) => void;
  /** Files shared into the app (D-115): passed directly to the first step, bypassing the file picker and prompt for parameters. */
  incoming?: readonly PickedFile[] | null;
  /**
   * Values passed from a container (D-428): the current record page entry, field value, or
   * records selected in a list. Present only when triggered via a button. Attachments (D-442)
   * pass only file IDs, with copies duplicated into the temporary directory for this run via
   * startRun.
   */
  handed?: RunValue | HandedFiles | null;
}

export interface Run {
  result: RunResult;
  /** Temporary file ID for the current run; deleted via dispose when the results page is closed. */
  runId: string;
  dispose(): Promise<void>;
}

/** Long-running actions (video, audio): runs containing these steps continue even if switched to another app (D-160). */
const BACKGROUND_ACTIONS: ReadonlySet<string> = new Set([
  'video.speed',
  'video.crop',
  'video.rotate',
  'video.audio',
  'video.mute',
  'video.merge',
  'video.compress',
  'video.convert',
  'video.trim',
  'video.toGif',
  'audio.volume',
  'audio.denoise',
  'audio.transcribe',
  'video.subtitles',
  'audio.compress',
  'audio.convert',
  'audio.trim',
  'audio.merge',
  'audio.fromVideo',
]);

export const isBackgroundAction = (actionId: string) => BACKGROUND_ACTIONS.has(actionId);

/** Maximum frequency of progress notifications (in milliseconds). */
const NOTIFY_MS = 1000;

/**
 * Runs containing long steps: kept alive from start (when the user taps and the app is in the
 * foreground; starting in background is prohibited on Android 12+) until completion, allowing
 * subsequent naming and saving steps to finish in the background. Prompts for notification
 * permissions on first use (D-161), and sends a completion notification if not in the foreground
 * upon finishing (D-162).
 */
async function keepAlive(ctx: RunContext) {
  const background = ctx.files.background;
  const { workflow, locale, registry } = ctx;
  if (!background || !workflow.steps.some((step) => isBackgroundAction(step.action))) return null;
  await background.ensureNotificationPermission();
  if (!background.begin(workflow.name, t(locale, 'bgPreparing'))) return null;
  let notifiedAt = 0;
  return {
    onEvent(e: RunEvent) {
      const now = ctx.now().getTime();
      if (e.kind === 'progress' && now - notifiedAt < NOTIFY_MS) return;
      notifiedAt = now;
      const step = workflow.steps[e.index]!;
      const text = t(locale, 'bgStep', {
        n: e.index + 1,
        total: workflow.steps.length,
        step: stepLabel(registry.actions.get(step.action), step.params, locale) ?? step.action,
      });
      if (e.kind === 'step' || e.total <= 0) {
        background.update(text, null);
        return;
      }
      const amount = t(locale, e.unit === 'percent' ? 'runPercent' : 'runProgress', {
        done: e.done,
        total: e.total,
      });
      background.update(
        `${text} · ${amount}`,
        e.unit === 'percent' ? e.done / 100 : e.done / e.total,
      );
    },
    end(result: RunResult | null) {
      const notify = result !== null && result.status !== 'cancelled' && !background.isForeground();
      const ok = result?.status === 'succeeded';
      background.end(
        notify
          ? {
              title: t(locale, ok ? 'bgDoneTitle' : 'bgFailedTitle', { name: workflow.name }),
              body: t(locale, ok ? 'bgDoneBody' : 'bgFailedBody'),
            }
          : null,
      );
    },
  };
}

/** Grantee for saved files: tool-bundled workflows grant files to the tool, while user workflows grant them to the user. */
export const granteeOf = (workflow: Workflow) => workflow.package ?? `workflow:${workflow.id}`;

/**
 * Whether this step does not require an extension pack on this device (D-085-D-087): the system
 * recognizes the language; the system can detect edges, or the input consists entirely of
 * document-camera straightened pages (scan.detect passes through directly).
 */
export function packNotNeeded(
  files: FilePlatform,
  actionId: string,
  params: Record<string, unknown>,
  input: RunValue | null,
  locale: Locale = 'en',
): boolean {
  const { vision } = files;
  // Speech-to-text (D-150, D-151): iOS uses system recognition without downloading content; reports an error directly if native modules are missing rather than downloading unnecessarily.
  if (actionId === 'audio.transcribe' || actionId === 'video.subtitles')
    return files.speech?.engine !== 'whisper';
  if (actionId === 'ocr.recognize') {
    const languages = VISION_LANGUAGES[resolveOcrLanguage(params.lang, locale)];
    return !!vision && !!languages && vision.supportsLanguage(languages[0]!);
  }
  if (actionId === 'scan.detect') {
    if (vision?.canFindPaper) return true;
    return isFileValue(input) && input.items.every((item) => item.straightened);
  }
  return false;
}

/**
 * OCR model required on this device for this step (D-269): required when recognizing languages
 * supported by PP-OCRv6; text layers for searchable PDFs and naming by recognized text can work
 * without downloading (falling back to original names if no text layer exists), making it
 * optional.
 */
export function devicePack(
  files: FilePlatform,
  actionId: string,
  params: Record<string, unknown>,
  locale: Locale = 'en',
): DevicePack | DevicePack[] | undefined {
  // Flattening model for scanning (D-274): queried separately from the scanning pack, enabling scanning to function normally without downloading.
  const flatten = files.vision?.flattenModel;
  if (actionId === 'scan.detect') {
    return flatten && params.flatten !== false
      ? { pack: flatten.pack, optional: true, extra: true }
      : undefined;
  }
  const model = files.vision?.ocrModel;
  // Word (D-328) and Excel (D-272) conversions require line positions, using native recognition
  // (PP-OCRv6 or system) without OCR packs; layout analysis model is optional (conversion works
  // without downloading: Word omits headers/titles and images, Excel omits images, D-520).
  if (actionId === 'ocr.toWord' || actionId === 'ocr.toExcel') {
    const lang = resolveOcrLanguage(params.lang, locale);
    const code = VISION_LANGUAGES[lang]?.[0];
    const ocr =
      model && code && model.languages.includes(code.split('-')[0]!)
        ? ({ pack: model.pack } as DevicePack)
        : undefined;
    const layout = files.vision?.layoutModel;
    const extra = layout ? [{ pack: layout.pack, optional: true, extra: true }] : [];
    return ocr || extra.length ? [...(ocr ? [ocr] : []), ...extra] : undefined;
  }
  if (actionId === 'ocr.recognize') {
    const lang = resolveOcrLanguage(params.lang, locale);
    const code = VISION_LANGUAGES[lang]?.[0];
    if (model && code && model.languages.includes(code.split('-')[0]!)) return { pack: model.pack };
    // Auto-selection (D-278) resolves to a language unrecognized by the system (such as Russian or Vietnamese on Android): requires the OCR pack for that language.
    if (params.lang === 'auto' && !(code && files.vision?.supportsLanguage(code))) {
      return { pack: ocrPackId(lang) };
    }
    return undefined;
  }
  if (!model) return undefined;
  if (actionId === 'pdf.fromImages' && params.textLayer === true) {
    return { pack: model.pack, optional: true };
  }
  if (
    actionId === 'file.rename' &&
    typeof params.template === 'string' &&
    templateReads(params.template).ocr
  ) {
    return { pack: model.pack, optional: true };
  }
  return undefined;
}

/** Extension packs truly required for download on this device (used for workflow page prompts; preset scans start from the document camera). */
export function packsNeeded(packIds: readonly string[], files: FilePlatform): string[] {
  const { vision } = files;
  const speechNeeded = (id: string) =>
    !id.startsWith('speech-') || files.speech?.engine === 'whisper';
  if (!vision) return packIds.filter(speechNeeded);
  return packIds
    .filter((id) => {
      if (id === 'scan') return !vision.canFindPaper && !vision.documentCamera;
      if (id === 'ocr') return false;
      if (id.startsWith('speech-')) return speechNeeded(id);
      if (id.startsWith('ocr-')) {
        const languages = VISION_LANGUAGES[id.slice(4).replace('-', '_') as OcrLanguage];
        return !languages || !vision.supportsLanguage(languages[0]!);
      }
      return true;
    })
    .concat(
      // Languages recognized by PP-OCRv6 do not need language packs, but do require the OCR model (D-269).
      vision.ocrModel &&
        packIds.some((id) => {
          const code = VISION_LANGUAGES[id.slice(4).replace('-', '_') as OcrLanguage]?.[0];
          return (
            id.startsWith('ocr-') &&
            !!code &&
            vision.ocrModel!.languages.includes(code.split('-')[0]!)
          );
        })
        ? [vision.ocrModel.pack]
        : [],
    );
}

/** When the first step uses shared-in files, its "ask on each run" configuration (source, count) is meaningless and is therefore skipped. */
function askUnlessShared(
  ctx: RunContext,
  ask: NonNullable<RunContext['askParams']>,
): NonNullable<RunContext['askParams']> {
  if (!ctx.incoming) return ask;
  return async (request) => (request.step === ctx.workflow.steps[0] ? {} : ask(request));
}

/**
 * Steps entirely unsupported on this device (iOS below 17, or background removal without Google
 * Play Services): reported upfront rather than waiting until the user selects photos and reaches
 * that step.
 */
function unsupportedStep(ctx: RunContext): RunResult | null {
  const index = ctx.workflow.steps.findIndex((s) => s.action === 'image.removeBackground');
  if (index < 0 || ctx.files.vision?.backgroundRemovalSupported) return null;
  return {
    status: 'failed',
    stepIndex: index,
    error: new RunError('unsupportedAction', { action: t(ctx.locale, 'backgroundNeedsSystem') }),
  };
}

/**
 * Copies attachments (user files) passed from containers into the temporary directory for this
 * run (D-442): operates on copies while leaving user files untouched (invariant 4). Video and
 * audio files potentially gigabytes in size are not copied (D-142): user files are outside the
 * cache directory, and adoptIntoRun uses them in place without moving. Files no longer present on
 * this device are skipped; if copying fails halfway or is cancelled, the caller deletes the
 * entire run directory.
 */
export async function copyHandedFiles(
  ctx: Pick<RunContext, 'repo' | 'files' | 'signal'>,
  runId: string,
  handed: HandedFiles,
): Promise<RunValue> {
  if (handed.assetIds.length > HANDED_FILES_MAX)
    throw new RunError('tooMany', { max: HANDED_FILES_MAX });
  const assets = [];
  for (const id of handed.assetIds) {
    const asset = await ctx.repo.getAsset(id);
    if (asset) assets.push(asset);
  }
  // Checks sizes before copying to avoid unnecessary duplication of oversized files.
  checkSizes(assets.map((a) => ({ name: a.name, size: a.size, mimeType: a.mimeType })));
  const items: RunItem[] = [];
  for (const asset of assets) {
    if (ctx.signal?.cancelled) throw new RunCancelled();
    const clean = sanitizeFileName(asset.name);
    const mimeType = mimeOf(clean, asset.mimeType);
    const ext = extOf(clean) || (mimeType === 'application/pdf' ? 'pdf' : 'jpg');
    const name = baseName(clean);
    const uri = ctx.files.fileUri(asset.path);
    const media = isMediaFile({ name: clean, mimeType });
    let stored;
    try {
      stored = media
        ? await ctx.files.adoptIntoRun(uri, runId, freshName(name, ext), true)
        : await ctx.files.copyToRun(uri, runId, freshName(name, ext));
    } catch {
      throw new RunError('accessDenied', { name: asset.name });
    }
    items.push({ uri: stored.uri, name, ext, mimeType, size: stored.size || asset.size });
  }
  return { type: handed.fileType, items };
}

export async function startRun(ctx: RunContext): Promise<Run> {
  const runId = ctx.newId();
  const blocked = unsupportedStep(ctx);
  if (blocked) return { result: blocked, runId, dispose: async () => undefined };
  let handed: RunValue | null;
  if (ctx.handed?.type === 'attachments') {
    try {
      handed = await copyHandedFiles(ctx, runId, ctx.handed);
    } catch (e) {
      // If copying fails or is cancelled midway, deletes any already copied copies in the run directory (required for both success and failure).
      await ctx.files.removeRun(runId);
      const dispose = async () => undefined;
      if (e instanceof RunCancelled) return { result: { status: 'cancelled' }, runId, dispose };
      if (e instanceof RunError)
        return { result: { status: 'failed', stepIndex: null, error: e }, runId, dispose };
      throw e;
    }
  } else handed = ctx.handed ?? null;
  const alive = await keepAlive(ctx);
  const onEvent = alive
    ? (e: RunEvent) => {
        alive.onEvent(e);
        ctx.onEvent?.(e);
      }
    : ctx.onEvent;
  const result = await runWorkflow({
    workflow: ctx.workflow,
    registry: ctx.registry,
    impls: ACTION_IMPLS,
    services: {
      runId,
      files: ctx.files,
      repo: ctx.repo,
      grantee: granteeOf(ctx.workflow),
      ui: ctx.ui,
      collections: ctx.collections ?? [],
      ...(ctx.calendar ? { calendar: ctx.calendar } : {}),
      packs: ctx.packs ?? null,
      incoming: ctx.incoming ?? null,
      ...(ctx.ensurePack ? { ensurePack: ctx.ensurePack } : {}),
    },
    locale: ctx.locale,
    now: ctx.now,
    newId: ctx.newId,
    handed,
    ...(ctx.askParams ? { askParams: askUnlessShared(ctx, ctx.askParams) } : {}),
    ...(ctx.ensurePack ? { ensurePack: ctx.ensurePack } : {}),
    ...(ctx.ensurePacks ? { ensurePacks: ctx.ensurePacks } : {}),
    packNotNeeded: (actionId, params, input) =>
      packNotNeeded(ctx.files, actionId, params, input, ctx.locale),
    devicePack: (actionId, params) => devicePack(ctx.files, actionId, params, ctx.locale),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    ...(onEvent ? { onEvent } : {}),
    record: {
      start: () =>
        ctx.repo.startToolRun({
          toolId: ctx.workflow.package ?? 'workflow',
          workflowId: ctx.workflow.id,
          revisionId: ctx.revisionId,
        }),
      finish: (id, outcome) => ctx.repo.finishToolRun(id, outcome),
    },
  }).then(
    (done) => {
      alive?.end(done);
      return done;
    },
    (e: unknown) => {
      alive?.end(null);
      throw e;
    },
  );
  const dispose = () => ctx.files.removeRun(runId);
  // Cleans up temporary files immediately when there is no result to display.
  if (result.status !== 'succeeded') await dispose();
  return { result, runId, dispose };
}

export { newAssetId } from './ids';
