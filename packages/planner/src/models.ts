import type { Localized } from '@morph/core';

// Optional models and pricing (USD per million tokens). Pricing is based on the official pricing page:
// https://platform.claude.com/docs/en/about-claude/pricing
// costPerChange is derived from the average measured in the 2026-10-22 evaluation set (system prompt is cached).

// Default Haiku (P-010, decided by founder 2026-10-23): passes all evaluations just like Opus, at about 1/25th the price.
export const DEFAULT_MODEL = 'claude-haiku-5-5';

export interface ModelInfo {
  id: string;
  name: string;
  price: { input: number; output: number; cacheRead: number };
  costPerChange: number;
  note: Localized;
}

export const MODELS: readonly ModelInfo[] = [
  {
    id: 'claude-opus-5-5',
    name: 'Claude Opus 5.5',
    price: { input: 4, output: 20, cacheRead: 0.2 },
    costPerChange: 0.005,
    note: { zh: '能力最强', en: 'Most capable', fr: 'Le plus performant' },
  },
  {
    id: 'claude-sonnet-5-5',
    name: 'Claude Sonnet 5.5',
    price: { input: 2, output: 10, cacheRead: 0.2 },
    costPerChange: 0.003,
    note: {
      zh: '速度与能力均衡',
      en: 'Balanced speed and capability',
      fr: 'Vitesse et performance équilibrées',
    },
  },
  {
    id: 'claude-haiku-5-5',
    name: 'Claude Haiku 5.5',
    price: { input: 0.1, output: 0.5, cacheRead: 0.01 },
    costPerChange: 0.0002,
    note: {
      zh: '最便宜（默认）',
      en: 'Lowest cost (default)',
      fr: 'Coût le plus bas (par défaut)',
    },
  },
];

/** Server refusal fallback: not supported by Haiku 5.5, enabled by default for other current models. */
export const supportsServerFallback = (model: string) => /^claude-(opus|sonnet|fable)-/.test(model);
