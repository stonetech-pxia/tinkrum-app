import type { IconName, Localized, Workflow } from './schema';
import { WORKFLOW_PRESETS, type WorkflowPreset } from './workflows/presets';

export const QUICK_ACTION_KINDS = ['image', 'video', 'audio', 'document', 'other'] as const;
export type QuickActionKind = (typeof QUICK_ACTION_KINDS)[number];
export const QUICK_ACTION_CATEGORIES: Record<
  QuickActionKind,
  {
    name: Localized;
    prefill: Localized;
    icon: IconName;
  }
> = {
  image: {
    name: { en: 'Photos', zh: '图片', fr: 'Photos' },
    prefill: {
      en: 'With my photos, I want to',
      zh: '我想要把图片',
      fr: 'Avec mes photos, je veux',
    },
    icon: 'photo',
  },
  video: {
    name: { en: 'Videos', zh: '视频', fr: 'Vidéos' },
    prefill: {
      en: 'With my videos, I want to',
      zh: '我想要把视频',
      fr: 'Avec mes vidéos, je veux',
    },
    icon: 'video',
  },
  audio: {
    name: { en: 'Audio', zh: '音频', fr: 'Audio' },
    prefill: {
      en: 'With my audio, I want to',
      zh: '我想要把音频',
      fr: 'Avec mes fichiers audio, je veux',
    },
    icon: 'audio',
  },
  document: {
    name: { en: 'Documents', zh: '文档', fr: 'Documents' },
    prefill: {
      en: 'With my documents, I want to',
      zh: '我想要把文档',
      fr: 'Avec mes documents, je veux',
    },
    icon: 'document',
  },
  other: {
    name: { en: 'Other', zh: '其他', fr: 'Autres' },
    prefill: { en: 'I want to', zh: '我想要', fr: 'Je veux' },
    icon: 'workflow',
  },
};

export function isQuickActionKind(value: unknown): value is QuickActionKind {
  return QUICK_ACTION_KINDS.includes(value as QuickActionKind);
}

/** First-step actions recognized by inferQuickActionKind; new input actions must be categorized here first (checked by tests). */
export const CATEGORIZED_INPUTS = [
  'in.photos',
  'in.videos',
  'in.audio',
  'in.files',
  'in.text',
  'in.wifi',
  'in.records',
] as const;

/** Categorize by actual input; scanning paper belongs to documents. */
export function inferQuickActionKind(workflow: Pick<Workflow, 'steps'>): QuickActionKind {
  const first = workflow.steps[0];
  switch (first?.action) {
    case 'in.photos':
      return first.params.source === 'scanner' ? 'document' : 'image';
    case 'in.videos':
      return 'video';
    case 'in.audio':
      return 'audio';
    case 'in.files':
      switch (first.params.accept) {
        case 'images':
          return 'image';
        case 'videos':
          return 'video';
        case 'audio':
          return 'audio';
        default:
          return 'document';
      }
    default:
      return 'other';
  }
}

export function presetKinds(preset: WorkflowPreset): readonly QuickActionKind[] {
  return preset.kinds?.length
    ? preset.kinds
    : [inferQuickActionKind({ steps: preset.steps('en') })];
}

/** Preserve cross-category classification when preset input type is unchanged; reclassify by actual type after input is modified. */
export function workflowKinds(workflow: Workflow): readonly QuickActionKind[] {
  const kind = inferQuickActionKind(workflow);
  const preset = WORKFLOW_PRESETS.find((p) => p.id === workflow.preset);
  return preset && inferQuickActionKind({ steps: preset.steps('en') }) === kind
    ? presetKinds(preset)
    : [kind];
}
