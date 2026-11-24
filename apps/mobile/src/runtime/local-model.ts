import {
  PREFILL_MODEL_FILE,
  PREFILL_MODEL_PACK,
  type ModelSession,
  type OpenModel,
} from '@morph/core';
import * as Device from 'expo-device';
import { Platform } from 'react-native';

import MorphVision from '../../modules/morph-vision';
import { expoPackFs } from '../packs/expo-pack-fs';
import type { PackStore } from '../packs/store';

// How the local model for new record forms (D-396) runs on mobile: llama.rn, CPU-only, released
// after use, non-resident. Model results go into candidates only; no network access here (downloads
// go through packs, triggered by user in Settings -> Data). Returns null or errors when
// uninstalled, low on memory, or failed to load, and the engine silently falls back to rules-only.

/**
 * Minimum total device memory required to load. 2B on an 11 GB Samsung showed a measured process
 * peak of 3.2–4.5 GB (including memory left by OCR, which is now released prior to loading);
 * smaller phones have not been tested. The iOS single-app limit is also roughly half of total
 * memory; 8 GB devices often report slightly under 8, so set to 7 (provisional, D-401).
 */
export const MODEL_MIN_MEMORY = 7 * 1024 * 1024 * 1024;

/**
 * Total memory threshold required to repack weights (D-402). Repacking copies weights into
 * anonymous memory: the model is about twice as fast on Samsung, with process peak increasing by
 * ~1.2 GB. Without repacking, weights remain in system-reclaimable file mappings. Treated as low
 * memory if total memory is unavailable.
 */
export const REPACK_MIN_MEMORY = 10 * 1024 * 1024 * 1024;
const noRepack = () => Device.totalMemory === null || Device.totalMemory < REPACK_MIN_MEMORY;

/** Context length: matches real-device measurements for 2B and 4B; text is truncated to this length by core. */
const CONTEXT = 4096;
/** Tested with 6 threads on Samsung. iPhones have fewer performance cores and are untested, default to 4. */
const threads = () => (Platform.OS === 'android' ? 6 : 4);

/** Assumed sufficient when total memory cannot be retrieved (Expo Go, some simulators): loading failures simply fall back to rules. */
export const deviceFitsLocalModel = () =>
  Device.totalMemory === null || Device.totalMemory >= MODEL_MIN_MEMORY;

/** Native calls may throw, reject, or return nothing (when stopCompletion is not during generation): all ignored. */
async function quietly(call: () => unknown): Promise<void> {
  try {
    await call();
  } catch {
    // Continue execution even if an error occurs during release.
  }
}

// At most one model is loading or in memory at any time (one 2B model is ~3 GB, two will trigger OS
// termination): queued sequentially, waiting for the previous model to fully release before the
// next starts, including models still loading that discover cancellation upon completion (triggered
// rapidly when users switch attachments or open/close forms).
let last: Promise<void> = Promise.resolve();

export function openLocalModel(store: PackStore): OpenModel {
  return async (signal) => {
    if (!(await store.isInstalled(PREFILL_MODEL_PACK)) || !deviceFitsLocalModel()) return null;
    const previous = last;
    let finish!: () => void;
    last = new Promise<void>((resolve) => {
      finish = resolve;
    });
    await previous;
    if (signal.aborted) {
      finish();
      return null;
    }
    // OCR model and memory pool remain in memory immediately after use (large images require 1+ GB), release them first; reload on next recognition.
    await quietly(() => MorphVision?.ocrUnload?.());
    let context: Awaited<ReturnType<typeof import('llama.rn').initLlama>>;
    try {
      // Native modules are loaded only when actually needed: absent in Expo Go, errors here fall back to rules.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { initLlama } = require('llama.rn') as typeof import('llama.rn');
      context = await initLlama({
        model: expoPackFs.uri(store.path(PREFILL_MODEL_PACK, PREFILL_MODEL_FILE)),
        n_ctx: CONTEXT,
        n_threads: threads(),
        n_gpu_layers: 0,
        devices: ['CPU'],
        no_gpu_devices: true,
        no_extra_bufts: noRepack(),
        use_mlock: false,
      });
    } catch (e) {
      finish();
      throw e;
    }
    if (signal.aborted) {
      await quietly(() => context.release());
      finish();
      return null;
    }
    let running: Promise<unknown> = Promise.resolve();
    let released: Promise<void> | null = null;
    const session: ModelSession = {
      async generate(request, stop) {
        const onAbort = () => void quietly(() => context.stopCompletion());
        stop.addEventListener('abort', onAbort);
        try {
          const work = context.completion({
            prompt: request.prompt,
            grammar: request.grammar,
            temperature: request.temperature,
            seed: request.seed,
            n_predict: request.nPredict,
            stop: [...request.stop],
          });
          running = work.catch(() => undefined);
          return (await work).text;
        } finally {
          stop.removeEventListener('abort', onAbort);
        }
      },
      release() {
        // Stop generation if active and wait for completion before releasing, otherwise native side is still using this memory. Proceed to the next only after release.
        released ??= (async () => {
          await quietly(() => context.stopCompletion());
          await running;
          await quietly(() => context.release());
          finish();
        })();
        return released;
      },
    };
    return session;
  };
}
