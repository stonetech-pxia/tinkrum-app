import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import Anthropic from '@anthropic-ai/sdk';
import { DEFAULT_MODEL, MODELS } from '@morph/planner';

import { createBatchRelay, createSdkRelay } from './claude-provider';
import type { Price, Relay } from './server';

// Read `.env` from repository root (see `docs/API_KEY_SETUP.md`). Key enters process environment only, never printed.
export function loadRootEnv(): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const file = resolve(root, '.env');
  if (existsSync(file)) process.loadEnvFile(file);
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type Effort = (typeof EFFORTS)[number];

export interface RelayRuntime {
  /** Null when `ANTHROPIC_API_KEY` is not configured. */
  relay: Relay | null;
  model: string;
  price: Price;
  /** Maximum output tokens per model forwarding; server reserves fees for in-flight requests based on this (R03). */
  maxOutputTokens: number;
}

/** Batch is for evaluation use only: requests go through Batch API (see `createBatchRelay`). */
export function createRelayRuntime(
  env: NodeJS.ProcessEnv,
  { batch = false }: { batch?: boolean } = {},
): RelayRuntime {
  const model = env.MORPH_AI_MODEL?.trim() || DEFAULT_MODEL;
  // Limits are calculated by amount, so only models with known prices can be used.
  const price = MODELS.find((m) => m.id === model)?.price;
  if (!price) throw new Error(`不知道 ${model} 的价格，请在 packages/planner/src/models.ts 里加上`);
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  const maxOutputTokens = Number(env.MORPH_MAX_OUTPUT_TOKENS ?? 16_000);
  if (!apiKey) return { relay: null, model, price, maxOutputTokens };
  const effortEnv = env.MORPH_AI_EFFORT?.trim();
  const effort = EFFORTS.includes(effortEnv as Effort) ? (effortEnv as Effort) : undefined;
  const client = new Anthropic({ apiKey, timeout: 60_000, maxRetries: 1 });
  const options = { model, maxTokens: maxOutputTokens, effort };
  const relay = batch
    ? createBatchRelay(client, options, { log: console.log })
    : createSdkRelay(client, options);
  return { relay, model, price, maxOutputTokens };
}
