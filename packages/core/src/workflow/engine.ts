import type { z } from 'zod';

import type { DataRecord } from '../data';
import type { Registry } from '../registry';
import type { Locale, Workflow, WorkflowStep } from '../schema';
import { actionAccepts, type ActionDefinition, type ValueType } from './contract';
import { handedInput, workflowProblems } from './check';

// Workflow executor (TOOLS_DESIGN §3): the sole place where actions are executed sequentially. The
// config contains only action IDs and parameters, with zero code. Action implementations
// (`ActionImpl`) and platform capabilities (`services`) are injected by the app, allowing this to
// be tested in Node.

export type FileValueType = Exclude<ValueType, 'text' | 'records'>;

/** A file in-flight: a temporary file in the cache directory, not a user file before saving (D-063). */
export interface RunItem {
  uri: string;
  /** Display name without file extension. */
  name: string;
  ext: string;
  mimeType: string;
  size: number;
  width?: number;
  height?: number;
  pageCount?: number;
  /** Paper size (points) preserved when rendering PDF to image, valid only for the current image pointed to by `for`. */
  pageSize?: { for: string; width: number; height: number };
  /** Native digital PDF drawing source; subsequent image modifications invalidate `for`, preventing reuse of the original layout. */
  pdfSource?: { for: string; uri: string; page: number };
  /** Duration of video or audio (milliseconds). */
  durationMs?: number;
  /** Photo capture timestamp (milliseconds). */
  takenAt?: number;
  /** File modification time (milliseconds): present on files selected from the "Files" app; used as capture time when filtering by date if capture time is unreadable (D-242). */
  modifiedAt?: number;
  /** Pages captured by system document camera: already edge-detected and straightened, `scan.detect` passes them through directly. */
  straightened?: boolean;
  /** File ID when already saved as a user file. */
  assetId?: string;
  /**
   * Image used for text recognition (D-267): `scan.enhance` records the image prior to
   * enhancement (enhancement does not help system recognition, and black-and-white removes faint
   * text). Valid only while `uri` still equals `for`: if any subsequent step generates a new
   * image, `uri` changes and recognition falls back to the current image. `width`/`height` are
   * dimensions before straightening during enhancement; `skew` is the straightening angle
   * (degrees) used to map recognition bounding boxes onto the enhanced image.
   */
  ocrSource?: { uri: string; for: string; width: number; height: number; skew: number };
  /**
   * TableDoc for Excel conversion (D-272): modified via "View and edit" on the result page, then
   * regenerates `xlsx`. Behaves like `ocrSource`, valid only while `uri` still equals `for`
   * (cannot be edited if a subsequent step generates a new file). `pagesWithoutTables`: pages
   * where the recognition scope was "table content only", but no lined tables were found, falling
   * back to outputting full content (1-indexed).
   */
  tableDoc?: { uri: string; for: string; pagesWithoutTables?: number[] };
  /** DocDoc for Word conversion (D-328): modified via "View and edit" on the result page, then regenerates `docx`. Behaves identically to `tableDoc`. */
  docDoc?: { uri: string; for: string };
}

export type RunValue =
  | { type: FileValueType; items: RunItem[] }
  /**
   * Text stays local (OCR, QR code recognition): copied or saved as a file, never sent to the AI.
   * `spoken`: text transcribed from an audio recording of user speech (D-575); "Log an expense"
   * fills forms directly using it.
   */
  | { type: 'text'; text: string; name: string; spoken?: boolean }
  /** Records in a data table (D-042): generated into PDFs/printed locally only, never sent to the AI. */
  | { type: 'records'; collectionId: string; records: DataRecord[]; name: string };

export type FileValue = Extract<RunValue, { items: RunItem[] }>;

export const isFileValue = (value: RunValue | null): value is FileValue =>
  value !== null && 'items' in value;

export type RunErrorCode =
  | 'tooFew'
  | 'tooMany'
  | 'wrongType'
  | 'tooLarge'
  | 'tooLargeTotal'
  | 'unreadable'
  | 'encrypted'
  | 'accessDenied'
  | 'saveFailed'
  | 'folderNotWritable'
  | 'noViewer'
  | 'previewFailed'
  | 'unsupportedAction'
  | 'invalidWorkflow'
  | 'cameraUnavailable'
  | 'permissionDenied'
  | 'packFailed'
  | 'targetNotMet'
  | 'unsupportedText'
  | 'badRange'
  | 'noFormFields'
  | 'badField'
  | 'notFound'
  | 'emptyText'
  | 'passwordMissing'
  | 'pdfRestricted'
  | 'pdfPasswordUnsupported'
  | 'textTooLong'
  | 'doesNotFit'
  | 'noRecords'
  /** No attachments provided by the container can be used (file no longer exists, or the first step does not accept such files, D-442). */
  | 'noFiles'
  /** When adding to an existing record, the record's attachment slots are full (D-443). */
  | 'recordFull'
  /** This quick action requires values supplied by a record page or list, which were absent in this run (D-428). */
  | 'needsRecord'
  /** This text is not an openable phone number, email address, or URL (D-428). */
  | 'badLink'
  /** Naming requires local text recognition, but this device lacks system built-in text recognition (Expo Go, D-244). */
  | 'needsRecognition'
  /** No files remain after filtering by conditions (`detail.count`: original count, D-242). */
  | 'noneMatched'
  /** Video and audio processing requires native modules, which are unavailable in Expo Go (D-141). */
  | 'needsFullApp'
  /** The system cannot open this video/audio (unsupported format or copyright protection). */
  | 'mediaUnsupported'
  | 'mergeUnsupported'
  | 'backgroundFailed'
  /** Insufficient free storage space on the phone (`detail.gb`: additional GB needed). */
  | 'notEnoughSpace'
  /** Target size is too small, resulting in unreadable output (`detail.mb`: minimum MB required). */
  | 'targetTooSmall'
  /** Switched to another app during video processing (iOS disallows background video encoders, D-148). */
  | 'interrupted'
  /** Compressing audio to the target size would make it unintelligible (`detail.mb`: minimum MB required, D-153). */
  | 'audioTooSmall'
  /** No audio track in the video (when extracting audio, D-155). */
  | 'noAudio'
  /** No speech detected in the recording (speech-to-text, D-150). */
  | 'noSpeech'
  /** This format is not supported by this phone (detail.format: MKV, etc., D-185). */
  | 'formatUnsupported'
  /** Video is too long to convert into a GIF (`detail.seconds`: maximum seconds, D-184). */
  | 'tooLong'
  /** This phone cannot locally recognize tables in this language (Excel conversion requires character bounding boxes per line, D-272). */
  | 'tableUnsupported'
  /** This phone cannot locally recognize documents in this language (Word conversion requires character bounding boxes per line, D-328). */
  | 'wordUnsupported'
  /** This phone cannot convert this document type to PDF (`detail.format`: XLSX, etc.; Android supports Word only, D-186). */
  | 'documentUnsupported'
  | 'unexpected';

export class RunError extends Error {
  constructor(
    readonly code: RunErrorCode,
    /** Contains specification numbers and file display names only, for user viewing; not written to execution logs. */
    readonly detail: Record<string, string | number> = {},
  ) {
    super(`${code} ${JSON.stringify(detail)}`);
  }
}

/** User cancelled (picker, local operation UI, runtime prompt, pack download confirmation). */
export class RunCancelled extends Error {}

export interface StepContext<S> {
  workflow: Workflow;
  step: WorkflowStep;
  index: number;
  action: ActionDefinition;
  locale: Locale;
  now(): Date;
  newId(): string;
  services: S;
  /** In-step progress, e.g., 3/10; when `unit` is 'percent', `done` is 0-100 (video processing). */
  progress(done: number, total: number, unit?: 'percent'): void;
  throwIfCancelled(): void;
  /** IDs of files saved as user files during this run (populated by `file.save`). */
  saved: string[];
  /** Passwords requested during this step (`secret` parameters): used only in this current run; key is absent if unrequested (no prompt UI or user left blank). */
  secrets: Readonly<Record<string, string>>;
}

export type ActionImpl<S> = (
  input: RunValue | null,
  params: Record<string, unknown>,
  ctx: StepContext<S>,
) => Promise<RunValue>;

/**
 * Connects an action's parameter schema with its implementation (R14): implementation parameter
 * types are inferred from the schema. The schema is exported in core; definition
 * (`ActionDefinition.params`) and implementation share the same schema. If a parameter name or
 * value is modified in core, implementation compilation errors immediately, preventing missed
 * updates. The schema is used solely for type inference; runtime parameters have already been
 * validated against it. When adding or modifying actions, write them this way preferentially
 * rather than manually casting `params as { ... }`.
 */
export function implOf<S, P extends Record<string, unknown>>(
  _schema: z.ZodType<P>,
  impl: (input: RunValue | null, params: P, ctx: StepContext<S>) => Promise<RunValue>,
): ActionImpl<S> {
  return (input, params, ctx) => impl(input, params as P, ctx);
}

export type RunEvent =
  /** `items`: number of files this step processes (when input is files); `images`: whether they are images; the run page displays "Image n/N" based on this (D-276). */
  | { kind: 'step'; index: number; items?: number; images?: boolean }
  | { kind: 'progress'; index: number; done: number; total: number; unit?: 'percent' };

export interface AskRequest {
  step: WorkflowStep;
  action: ActionDefinition;
  keys: readonly string[];
  params: Record<string, unknown>;
  input: RunValue | null;
}

export type RunResult =
  | {
      status: 'succeeded';
      value: RunValue | null;
      saved: string[];
      /** Total size of files obtained in the first step (input): result page displays "Original X -> Current Y". */
      inputSize: number;
    }
  | { status: 'cancelled' }
  | { status: 'failed'; error: RunError; stepIndex: number | null };

/** Pack required by a step; `optional`: step proceeds even without downloading (D-274). */
export interface PackNeed {
  pack: string;
  optional: boolean;
}

/** A pack required by this step on this device (see `RunOptions.devicePack`). */
export interface DevicePack {
  pack: string;
  optional?: boolean;
  extra?: boolean;
}

export interface RunOptions<S> {
  workflow: Workflow;
  registry: Registry;
  impls: Readonly<Record<string, ActionImpl<S>>>;
  services: S;
  locale: Locale;
  now: () => Date;
  newId: () => string;
  /** Asks for parameters at runtime; returns parameters used for this run, or `null` if the user cancelled. Not written back to config. */
  askParams?: (request: AskRequest) => Promise<Record<string, unknown> | null>;
  /**
   * Called when a step requires a pack: returns `true` if installed or user confirmed download
   * and completion; returns `false` if user refused (D-064). `optional`: step proceeds even
   * without downloading (D-274), which the UI communicates so users do not assume cancellation.
   */
  ensurePack?: (packId: string, options?: { optional?: boolean }) => Promise<boolean>;
  /**
   * When a pack is first needed by a step, prompts for all required packs for this step and
   * subsequent steps at once (D-299): the UI lists only uninstalled ones for a single download.
   * Returns optional packs not downloaded by the user; `null` indicates required packs were not
   * downloaded, cancelling the run. When absent, each step queries separately via `ensurePack`.
   * Subsequent steps estimate based on config parameters and current inputs; any missed
   * estimations (e.g., language selected at runtime) prompt via `ensurePack` when reached.
   */
  ensurePacks?: (needs: readonly PackNeed[]) => Promise<string[] | null>;
  /**
   * Returns `true` without calling `ensurePack` when this step requires no packs on this device
   * (D-085–D-087): system built-in recognition (iOS Vision, Android ML Kit), or input is already
   * a straightened page.
   */
  packNotNeeded?: (
    actionId: string,
    params: Record<string, unknown>,
    input: RunValue | null,
  ) => boolean;
  /**
   * Pack required by this step on this device (D-269, e.g., text recognition model); replaces the
   * action's own pack when present. `optional`: proceeds even if the user does not download
   * (e.g., searchable PDF without text layer), without cancelling the run. `extra`: does not
   * replace the action's own pack, but prompts additionally (D-274: scanning flattening model;
   * must be `optional`). Accepts an array when multiple are needed per step (D-328: Word
   * conversion requires text recognition model plus optional layout analysis model).
   */
  devicePack?: (
    actionId: string,
    params: Record<string, unknown>,
    input: RunValue | null,
  ) => DevicePack | readonly DevicePack[] | undefined;
  /**
   * Value handed over to the first step by the container (D-428): the current entry on a record
   * page, this field's value, or selected records from a list. Not used when the first step is an
   * input action. If the first step requires it but it is absent (reached from quick action list,
   * home screen, reminders), no steps are executed.
   */
  handed?: RunValue | null;
  /** Setting `cancelled` to `true` in the UI cancels execution. */
  signal?: { cancelled: boolean };
  onEvent?: (event: RunEvent) => void;
  /** Execution log (`tool_runs`): records metadata only, omitting content and file names. */
  record?: {
    start(): Promise<number>;
    finish(
      id: number,
      result: {
        status: 'succeeded' | 'failed' | 'cancelled';
        error?: string;
        outputAssetId?: string;
      },
    ): Promise<void>;
  };
}

/** Interval for checking cancellation. */
const CANCEL_POLL_MS = 200;

/** Core does not depend on DOM or Node types; timers are retrieved from the global object (available in both app and test environments). */
const timers = globalThis as unknown as {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
};

export async function runWorkflow<S>(opts: RunOptions<S>): Promise<RunResult> {
  const { workflow, registry } = opts;
  const runId = (await opts.record?.start()) ?? null;
  const finish = async (result: RunResult) => {
    if (runId !== null && opts.record) {
      await opts.record.finish(runId, {
        status: result.status,
        ...(result.status === 'failed' ? { error: result.error.code } : {}),
        ...(result.status === 'succeeded' && result.saved[0]
          ? { outputAssetId: result.saved[0] }
          : {}),
      });
    }
    return result;
  };

  // Packs needed for a step: action's own pack (or device fallback), plus other required optionals (D-274).
  const packNeeds = (
    action: ActionDefinition,
    params: Record<string, unknown>,
    input: RunValue | null,
  ): PackNeed[] => {
    const given = opts.devicePack?.(action.id, params, input);
    const devices: readonly DevicePack[] =
      given === undefined ? [] : 'pack' in given ? [given] : given;
    const replaces = devices.find((d) => !d.extra);
    const pack =
      replaces?.pack ??
      (opts.packNotNeeded?.(action.id, params, input)
        ? undefined
        : (action.packFor?.(params) ?? action.pack));
    return [
      ...(pack ? [{ pack, optional: replaces?.optional === true }] : []),
      ...devices.filter((d) => d.extra).map((d) => ({ pack: d.pack, optional: true })),
    ];
  };
  // Optional packs already installed in this run that the user does not need to download: do not prompt again.
  const ready = new Set<string>();
  const skipped = new Set<string>();
  let askedAll = false;

  // Validated before saving config; check again before execution (D-020 defense in depth).
  if (workflowProblems(workflow, registry).length > 0) {
    return finish({ status: 'failed', error: new RunError('invalidWorkflow'), stepIndex: null });
  }

  // Values handed by the container: do not start if types mismatch, values are missing, or empty (D-428). Files (D-442) are the kind received in the first step.
  const wanted = handedInput(workflow.steps, registry);
  const given = wanted !== null ? (opts.handed ?? null) : null;
  if (wanted !== null) {
    const fail = (error: RunError) => finish({ status: 'failed', error, stepIndex: null });
    if (given === null) return fail(new RunError('needsRecord'));
    if (wanted === 'files') {
      const first = registry.actions.get(workflow.steps[0]!.action)!;
      if (!isFileValue(given) || !actionAccepts(first, given.type))
        return fail(new RunError('needsRecord'));
      if (given.items.length === 0) return fail(new RunError('noFiles'));
    } else {
      if (given.type !== wanted) return fail(new RunError('needsRecord'));
      if (given.type === 'text' && given.text.trim() === '') return fail(new RunError('emptyText'));
      if (given.type === 'records' && given.records.length === 0)
        return fail(new RunError('noRecords', { name: given.name }));
    }
  }

  const saved: string[] = [];
  let value: RunValue | null = given;
  let index = 0;
  let inputSize = 0;
  const throwIfCancelled = () => {
    if (opts.signal?.cancelled) throw new RunCancelled();
  };
  // When the user taps "Stop", do not wait for suspended system UI (e.g., file pickers that failed to appear): every step races against the cancellation signal.
  let stopWatching = () => {};
  const whenCancelled = new Promise<never>((_, reject) => {
    if (!opts.signal) return;
    const timer = timers.setInterval(() => {
      if (opts.signal?.cancelled) {
        timers.clearInterval(timer);
        reject(new RunCancelled());
      }
    }, CANCEL_POLL_MS);
    stopWatching = () => timers.clearInterval(timer);
  });
  whenCancelled.catch(() => undefined);
  const orCancel = <T>(promise: Promise<T>) => Promise.race([promise, whenCancelled]);
  try {
    for (const [i, step] of workflow.steps.entries()) {
      index = i;
      throwIfCancelled();
      opts.onEvent?.({
        kind: 'step',
        index: i,
        ...(i > 0 && isFileValue(value)
          ? { items: value.items.length, images: value.type === 'images' }
          : {}),
      });
      const action = registry.actions.get(step.action)!;
      const impl = opts.impls[step.action];
      if (!impl) throw new RunError('unsupportedAction', { action: step.action });
      let params = action.params.parse(step.params);
      // Always prompt for passwords (D-194), asked alongside configuration prompts; answers are stored separately and do not enter parameters.
      const secretKeys = action.fields.filter((f) => f.kind === 'secret').map((f) => f.key);
      const keys = [...(step.ask ?? []), ...secretKeys.filter((k) => !step.ask?.includes(k))];
      const secrets: Record<string, string> = {};
      if (keys.length && opts.askParams) {
        const answered = await orCancel(
          opts.askParams({
            step,
            action,
            keys,
            params,
            input: value,
          }),
        );
        if (answered === null) throw new RunCancelled();
        const rest: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(answered)) {
          if (!secretKeys.includes(k)) rest[k] = v;
          else if (typeof v === 'string' && v !== '') secrets[k] = v;
        }
        params = action.params.parse({ ...params, ...rest });
      }
      for (const f of action.fields) {
        if (
          f.bindsInput &&
          typeof params[f.key] === 'string' &&
          (value?.type !== 'records' || value.collectionId !== params[f.key])
        )
          throw new RunError('invalidWorkflow');
      }
      // Prompt for parameters first, then confirm packs: OCR language packs are determined by the selected language.
      const needs = packNeeds(action, params, value);
      if (needs.length && opts.ensurePacks && !askedAll) {
        askedAll = true;
        const later = workflow.steps.slice(i + 1).flatMap((s) => {
          const a = registry.actions.get(s.action)!;
          return packNeeds(a, a.params.parse(s.params), value);
        });
        // List each pack only once; if any step requires it, it is required.
        const all: PackNeed[] = [];
        for (const need of [...needs, ...later]) {
          const seen = all.find((n) => n.pack === need.pack);
          if (!seen) all.push({ ...need });
          else if (!need.optional) seen.optional = false;
        }
        const left = await orCancel(opts.ensurePacks(all));
        if (left === null) throw new RunCancelled();
        for (const { pack } of all) (left.includes(pack) ? skipped : ready).add(pack);
      }
      for (const { pack, optional } of needs) {
        if (ready.has(pack) || (optional && skipped.has(pack)) || !opts.ensurePack) continue;
        const ok = await orCancel(opts.ensurePack(pack, optional ? { optional: true } : undefined));
        if (ok) ready.add(pack);
        // Optional packs still execute this step even if not downloaded.
        else if (optional) skipped.add(pack);
        else throw new RunCancelled();
      }
      throwIfCancelled();
      value = await orCancel(
        impl(value, params, {
          workflow,
          step,
          index: i,
          action,
          locale: opts.locale,
          now: opts.now,
          newId: opts.newId,
          services: opts.services,
          progress: (done, total, unit) =>
            opts.onEvent?.({
              kind: 'progress',
              index: i,
              done,
              total,
              ...(unit ? { unit } : {}),
            }),
          throwIfCancelled,
          saved,
          secrets,
        }),
      );
      if (i === 0) inputSize = totalSize(value);
    }
    return finish({ status: 'succeeded', value, saved, inputSize });
  } catch (e) {
    if (e instanceof RunCancelled) return finish({ status: 'cancelled' });
    const error = e instanceof RunError ? e : new RunError('unexpected', { detail: String(e) });
    return finish({ status: 'failed', error, stepIndex: index });
  } finally {
    stopWatching();
  }
}

/** Total size of all files in a value. */
export const totalSize = (value: RunValue | null) =>
  isFileValue(value) ? value.items.reduce((sum, item) => sum + item.size, 0) : 0;
