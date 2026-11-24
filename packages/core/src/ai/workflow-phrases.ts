import { CORE_ACTIONS } from '../registry';
import {
  quickActionsOf,
  type Locale,
  type Workflow,
  type WorkflowStep,
  type WorkspaceConfig,
} from '../schema';
import { BUILTIN_TOOLS } from '../tools';
import type { ActionDefinition } from '../workflow/contract';
import { WORKFLOW_PRESETS, type WorkflowPreset } from '../workflows/presets';

export { LANGUAGE_WORD, languageOf } from '../workflow/phrase-words';

// Mock AI workflow phrasing (docs/MOCK_AI_PHRASES.md W1–W7): translates phrases like "choose
// photos, compress to 500KB, share" into steps. Recognizes fixed phrasings only; unrecognized
// phrases return null, causing the caller to reject the entire sentence. Phrasings recognized by
// each action are written in action definitions (tools/*.ts); here, steps are simply chained by
// replacing the previous step with a compatible action and assembling them.

/** A step phrasing → action and parameters. */
export interface StepPhrase {
  action: string;
  params: Record<string, unknown>;
  /** Parameters asked for at runtime (e.g., "Enter text" requires asking for text). */
  ask?: string[] | undefined;
  /** Log an expense (D-187): table name mentioned in the sentence, replaced by the caller with collectionId based on current config; empty string indicates none specified. */
  table?: string;
}

/** Replace "date" in naming phrases with a template. */
export function nameTemplateOf(words: string): string {
  return words
    .replace(/日期|\bdate\b/gi, '{date:YYYY-MM-DD}')
    .replace(/原文件名|source name/gi, '{sourceName}');
}

/**
 * Actions that recognize step phrasings: all built-in actions, with phrasings written in their
 * respective definitions (D-265). Phrasings of different actions do not overlap, so the check
 * order of actions does not matter. Downloaded tools cannot add actions and do not need to be
 * looked up in the registry.
 */
const PHRASE_ACTIONS: readonly ActionDefinition[] = [
  ...CORE_ACTIONS,
  ...BUILTIN_TOOLS.flatMap((tool) => tool.actions),
].filter((a) => a.phrases?.length);

export function parseStepPhrase(text: string, locale: Locale): StepPhrase | null {
  const clean = text.replace(/^(?:再|然后|最后|先|接着|and then|then|and)\s*/i, '').trim();
  for (const action of PHRASE_ACTIONS) {
    for (const phrase of action.phrases!) {
      const m = clean.match(phrase.match);
      if (!m) continue;
      const step: StepPhrase = {
        action: action.id,
        ...(phrase.step?.(m, locale) ?? { params: {} }),
      };
      if (step.action === 'file.rename') {
        step.params = { template: nameTemplateOf(String(step.params.template)) };
      }
      return step;
    }
  }
  return null;
}

/** "choose photos, compress to 500 KB, then share" -> step phrases. */
export function splitStepPhrases(text: string): string[] {
  return text
    .split(/、|→|->|,|，|然后|\bthen\b|\band\b(?! (?:images|photos))/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** ID for a new step: second half of the action name, with a sequence number appended if duplicate. */
export function stepIdFor(action: string, taken: readonly { id: string }[]): string {
  const base = action
    .split('.')[1]!
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');
  const used = new Set(taken.map((s) => s.id));
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) if (!used.has(`${base}-${i}`)) return `${base}-${i}`;
}

/** Actions that output text: "Convert to PDF" below is text-to-PDF (D-174). */
const TEXT_OUTPUT = new Set([
  'in.text',
  'audio.transcribe',
  'ocr.recognize',
  'pdf.extractText',
  'translate.text',
  'qr.read',
  'text.copy',
]);

/**
 * Adapting to the previous step within the same sentence: "Extract text" after selecting a PDF
 * means extracting PDF text; "Convert to PDF" after text means text-to-PDF.
 */
function fitToPrevious(p: StepPhrase, previous: WorkflowStep | undefined): StepPhrase {
  if (
    p.action === 'ocr.recognize' &&
    previous?.action === 'in.files' &&
    previous.params.accept === 'pdf'
  ) {
    return { action: 'pdf.extractText', params: {} };
  }
  if (p.action === 'pdf.fromImages' && previous && TEXT_OUTPUT.has(previous.action)) {
    return { action: 'text.toPdf', params: { pageSize: 'a4', fontSize: 12 } };
  }
  // Format conversion (D-183–D-186): "Convert to PDF" after Word means document-to-PDF; "Convert to
  // GIF" after video means video-to-GIF, and "Convert to MP3" extracts audio from video.
  if (
    p.action === 'pdf.fromImages' &&
    previous?.action === 'in.files' &&
    previous.params.accept === 'documents'
  ) {
    return { action: 'pdf.fromDocument', params: { pageSize: 'a4' } };
  }
  if (previous && makesVideo(previous)) {
    if (p.action === 'image.toGif')
      return { action: 'video.toGif', params: { width: 480, fps: 12 } };
    if (p.action === 'audio.convert') return { action: 'audio.fromVideo', params: p.params };
  }
  return p;
}

/** The result of this step is a video. */
const makesVideo = (step: WorkflowStep) =>
  step.action === 'in.videos' ||
  (step.action !== 'video.subtitles' &&
    step.action.startsWith('video.') &&
    !['video.toGif', 'video.frame'].includes(step.action)) ||
  (step.action === 'in.files' && step.params.accept === 'videos');

/** Approximate value type after this step (used only to select actions for "Compress to N MB"). */
export type PhraseKind = 'images' | 'video' | 'audio' | 'pdf' | 'other';

function kindAfter(step: StepPhrase, before: PhraseKind | null): PhraseKind | null {
  if (step.action === 'in.photos' || step.action.startsWith('image.')) return 'images';
  if (step.action === 'audio.volume' || step.action === 'audio.denoise') return before;
  if (step.action === 'audio.transcribe') return 'other';
  if (step.action === 'in.audio' || step.action.startsWith('audio.')) return 'audio';
  if (step.action === 'video.subtitles') return 'other';
  if (step.action === 'video.frame') return 'images';
  if (step.action === 'video.toGif') return 'images';
  if (step.action === 'in.videos' || step.action.startsWith('video.')) return 'video';
  if (step.action === 'in.files') {
    const accept = step.params.accept;
    return accept === 'pdf'
      ? 'pdf'
      : accept === 'videos'
        ? 'video'
        : accept === 'audio'
          ? 'audio'
          : 'other';
  }
  if (step.action === 'pdf.toImages') return 'images';
  if (step.action.startsWith('pdf.')) return 'pdf';
  if (step.action === 'zip.create') return 'other';
  return before;
}

/**
 * "Compress to N MB" defaults to compressing images; changes to compressing video when preceded
 * by video, or compressing PDF when preceded by PDF (D-147). before: values prior to these steps
 * (when adding steps to an existing quick action).
 */
export function fitSizePhrases(
  phrases: readonly StepPhrase[],
  before: PhraseKind | null = null,
): StepPhrase[] {
  let kind = before;
  return phrases.map((p) => {
    let step = p;
    // Audio (D-157): "Compress to N MB" compresses audio, "Trim a clip" trims audio, and "Merge" combines clips into one.
    if (kind === 'audio') {
      if (p.action === 'image.compress') {
        const mb = Number(p.params.maxKB) / 1024;
        step = {
          action: 'audio.compress',
          params: {
            by: 'size',
            maxMB: Math.max(0.1, Math.round(mb * 10) / 10),
            quality: 'standard',
          },
        };
      } else if (p.action === 'video.trim') {
        step = { action: 'audio.trim', params: {} };
      } else if (p.action === 'pdf.merge') {
        step = { action: 'audio.merge', params: {} };
      }
    }
    if (p.action === 'image.compress' && (kind === 'video' || kind === 'pdf')) {
      const mb = Number(p.params.maxKB) / 1024;
      step =
        kind === 'video'
          ? {
              action: 'video.compress',
              params: { by: 'size', maxMB: Math.max(1, Math.round(mb)), quality: '720p' },
            }
          : {
              action: 'pdf.compress',
              params: { maxMB: Math.max(0.1, Math.round(mb * 10) / 10), whenTooBig: 'ask' },
            };
    }
    kind = kindAfter(step, kind);
    return step;
  });
}

/** Approximate value type following a sequence of existing steps. */
export function kindOfSteps(steps: readonly StepPhrase[]): PhraseKind | null {
  return steps.reduce<PhraseKind | null>((kind, step) => kindAfter(step, kind), null);
}

export function stepsFrom(phrases: readonly StepPhrase[]): WorkflowStep[] {
  const steps: WorkflowStep[] = [];
  for (const phrase of phrases) {
    const p = fitToPrevious(phrase, steps.at(-1));
    steps.push({
      id: stepIdFor(p.action, steps),
      action: p.action,
      params: p.params,
      ...(p.ask ? { ask: p.ask } : {}),
    });
  }
  return steps;
}

/** Preset names (words) are looked up in this order: those marked with wordsFirst are checked first, followed by the rest in preset order. */
const PRESETS_BY_WORDS = [
  ...WORKFLOW_PRESETS.filter((p) => p.words && p.wordsFirst),
  ...WORKFLOW_PRESETS.filter((p) => p.words && !p.wordsFirst),
];

export function findPreset(text: string): WorkflowPreset | undefined {
  const lower = text.toLowerCase();
  const byName = WORKFLOW_PRESETS.find(
    (p) => lower.includes(p.name.zh.toLowerCase()) || lower.includes(p.name.en.toLowerCase()),
  );
  if (byName) return byName;
  return PRESETS_BY_WORDS.find((p) => p.words!.test(text));
}

/** Find workflow by name (exact match preferred, containment second). */
export function findWorkflowByName(rawName: string, config: WorkspaceConfig): Workflow | undefined {
  const name = rawName
    .replace(/"/g, '')
    .replace(/(?:快捷操作|工作流|流程|workflow|quick action)$/i, '')
    .trim()
    .toLowerCase();
  if (!name) return undefined;
  const all = quickActionsOf(config);
  return (
    all.find((w) => w.name.toLowerCase() === name) ??
    all.find((w) => w.name.toLowerCase().includes(name) || name.includes(w.name.toLowerCase()))
  );
}
