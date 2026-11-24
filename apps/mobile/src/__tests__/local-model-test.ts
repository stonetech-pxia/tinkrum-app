import { modelEngine, PREFILL_MODEL_PACK } from '@morph/core';
import * as Device from 'expo-device';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { PackStore } from '../packs/store';
import { MODEL_MIN_MEMORY, deviceFitsLocalModel, openLocalModel } from '../runtime/local-model';

// How on-device model is turned on and off on the phone (D-396): not loaded if uninstalled or
// memory is insufficient; released after use, and if generation is active, stops first before
// releasing. The llama.rn mock here is fake; real llama.rn can only be verified on simulators and
// real devices.

jest.mock('expo-device', () => ({ totalMemory: 8 * 1024 * 1024 * 1024 }));
jest.mock('../packs/expo-pack-fs', () => ({ expoPackFs: { uri: (p: string) => `file:///${p}` } }));

const order: string[] = [];
let finishCompletion: ((r: { text: string }) => void) | null = null;
const context = {
  completion: jest.fn(
    () =>
      new Promise<{ text: string }>((resolve) => {
        finishCompletion = resolve;
      }),
  ),
  stopCompletion: jest.fn(async () => {
    order.push('stop');
    finishCompletion?.({ text: '' });
  }),
  release: jest.fn(async () => {
    order.push('release');
  }),
};
const mockInit = jest.fn(async (_params: { model: string; n_ctx: number }) => context);
let mockNoNative = false;
const mockOcrUnload = jest.fn(async () => undefined);
jest.mock('../../modules/morph-vision', () => ({
  __esModule: true,
  default: { ocrUnload: () => mockOcrUnload() },
}));
jest.mock('llama.rn', () => ({
  get initLlama() {
    if (mockNoNative) throw new Error('no native module');
    return (p: { model: string; n_ctx: number }) => mockInit(p);
  },
}));

const store = (installed: boolean) =>
  ({
    isInstalled: async (id: string) => installed && id === PREFILL_MODEL_PACK,
    path: (id: string, file: string) => `${id}/1.0.0/${file}`,
  }) as unknown as PackStore;
const request = {
  prompt: 'p',
  grammar: 'g',
  temperature: 0,
  seed: 42,
  nPredict: 120,
  stop: ['\n'],
};
const setMemory = (bytes: number | null) => {
  (Device as { totalMemory: number | null }).totalMemory = bytes;
};

describe('Release OCR memory before loading the model', () => {
  it('Release OCR model first, then load on-device model', async () => {
    mockOcrUnload.mockClear();
    mockInit.mockClear();
    const session = await openLocalModel(store(true))(new AbortController().signal);
    expect(mockOcrUnload.mock.invocationCallOrder[0]).toBeLessThan(
      mockInit.mock.invocationCallOrder[0]!,
    );
    await session?.release();
  });

  it('Load anyway even if release fails', async () => {
    mockOcrUnload.mockImplementationOnce(() => Promise.reject(new Error('busy')));
    const session = await openLocalModel(store(true))(new AbortController().signal);
    expect(session).not.toBeNull();
    await session?.release();
  });

  it('Do not touch OCR when model is not installed', async () => {
    mockOcrUnload.mockClear();
    await openLocalModel(store(false))(new AbortController().signal);
    expect(mockOcrUnload).not.toHaveBeenCalled();
  });
});

describe('Recognized text does not enter system logs (invariants 1, 2)', () => {
  it('llama.rn does not print prompt tokens; Android compiled from source for patches to take effect', () => {
    const root = join(__dirname, '../../../..');
    const completion = readFileSync(
      join(root, 'node_modules/llama.rn/cpp/rn-completion.cpp'),
      'utf8',
    );
    expect(completion).not.toContain('": prompt_tokens = "');
    const app = readFileSync(join(root, 'apps/mobile/app.json'), 'utf8');
    expect(app).toContain('./plugins/with-llama-from-source');
  });
});

describe('On-device model (D-396)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    order.length = 0;
    finishCompletion = null;
    setMemory(8 * 1024 * 1024 * 1024);
  });

  it('Not downloaded: do not load, return null', async () => {
    await expect(openLocalModel(store(false))(new AbortController().signal)).resolves.toBeNull();
    expect(mockInit).not.toHaveBeenCalled();
  });

  it('Insufficient memory: do not load, return null', async () => {
    setMemory(MODEL_MIN_MEMORY - 1);
    expect(deviceFitsLocalModel()).toBe(false);
    await expect(openLocalModel(store(true))(new AbortController().signal)).resolves.toBeNull();
    expect(mockInit).not.toHaveBeenCalled();
  });

  it('Load files from pack, CPU only, context and core text truncation lengths are identical', async () => {
    const session = await openLocalModel(store(true))(new AbortController().signal);
    await session?.release();
    expect(mockInit.mock.calls[0]![0]).toMatchObject({
      model: `file:///${PREFILL_MODEL_PACK}/1.0.0/Qwen3.5-2B-Q4_K_M.gguf`,
      no_extra_bufts: true,
      n_ctx: 4096,
      n_gpu_layers: 0,
    });
  });

  it.each([
    ['内存大的手机：重排权重，快', 11 * 1024 * 1024 * 1024, false],
    ['正好 10 GB：重排', 10 * 1024 * 1024 * 1024, false],
    ['内存小的手机：不重排，省内存', 8 * 1024 * 1024 * 1024, true],
    ['拿不到内存：按小的算', null, true],
  ])('%s', async (_name, bytes, expected) => {
    setMemory(bytes);
    const session = await openLocalModel(store(true))(new AbortController().signal);
    await session?.release();
    expect(mockInit.mock.calls.at(-1)![0]).toMatchObject({ no_extra_bufts: expected });
    setMemory(8 * 1024 * 1024 * 1024);
  });

  it('StopCompletion not called while generating returns nothing (true for real llama.rn): released normally, can be loaded next time', async () => {
    context.stopCompletion.mockImplementationOnce(() => undefined as unknown as Promise<void>);
    const open = openLocalModel(store(true));
    const session = (await open(new AbortController().signal))!;
    await session.release();
    expect(context.release).toHaveBeenCalledTimes(1);
    const next = await open(new AbortController().signal);
    expect(next).not.toBeNull();
    await next?.release();
  });

  it('Release failure does not block next load', async () => {
    context.release.mockImplementationOnce(() => Promise.reject(new Error('busy')));
    const open = openLocalModel(store(true));
    const session = (await open(new AbortController().signal))!;
    await session.release();
    const next = await open(new AbortController().signal);
    expect(next).not.toBeNull();
    await next?.release();
  });

  it('Cancelled during load: release immediately after loading completes, returns null', async () => {
    const abort = new AbortController();
    mockInit.mockImplementationOnce(async () => {
      abort.abort();
      return context;
    });
    await expect(openLocalModel(store(true))(abort.signal)).resolves.toBeNull();
    expect(context.release).toHaveBeenCalledTimes(1);
  });

  it('Cancel: notify native to stop, Promise finishes', async () => {
    const session = (await openLocalModel(store(true))(new AbortController().signal))!;
    const abort = new AbortController();
    const run = session.generate(request, abort.signal);
    abort.abort();
    await expect(run).resolves.toBe('');
    expect(context.stopCompletion).toHaveBeenCalled();
    await session.release();
  });

  it('Release: stop first if still generating, then release; next load waits for release to finish', async () => {
    const open = openLocalModel(store(true));
    const session = (await open(new AbortController().signal))!;
    void session.generate(request, new AbortController().signal);
    const released = session.release();
    const next = open(new AbortController().signal);
    await released;
    const second = await next;
    expect(order).toEqual(['stop', 'release']);
    expect(mockInit).toHaveBeenCalledTimes(2);
    await second?.release();
  });

  describe('At most one model loading or in memory at any time', () => {
    // Fake loading: waits for test release; counts how many are active simultaneously (loading + unreleased).
    let live = 0;
    let peak = 0;
    let loads: (() => void)[] = [];
    const loadOne = async () => {
      live++;
      peak = Math.max(peak, live);
      await new Promise<void>((resolve) => loads.push(resolve));
      return {
        ...context,
        release: jest.fn(async () => {
          await Promise.resolve();
          live--;
        }),
      };
    };
    const settle = async () => {
      for (let i = 0; i < 20; i++) await Promise.resolve();
    };
    /** Allow ongoing loads to proceed until done finishes. */
    const finishLoads = async (done: Promise<unknown>) => {
      let over = false;
      void done.finally(() => {
        over = true;
      });
      for (let i = 0; i < 200 && !over; i++) {
        loads.shift()?.();
        await settle();
      }
      expect(over).toBe(true);
    };

    beforeEach(() => {
      live = 0;
      peak = 0;
      loads = [];
      mockInit.mockImplementation(loadOne as never);
    });
    afterEach(() => {
      mockInit.mockImplementation(async () => context);
    });

    it('Cancel while loading and restart: wait for previous load to finish and release before loading next', async () => {
      const open = openLocalModel(store(true));
      const a = new AbortController();
      const first = open(a.signal);
      await settle();
      expect(mockInit).toHaveBeenCalledTimes(1);
      a.abort();
      const second = open(new AbortController().signal);
      await settle();
      expect(mockInit).toHaveBeenCalledTimes(1);
      await finishLoads(Promise.all([first, second]));
      await expect(first).resolves.toBeNull();
      const session = await second;
      expect(session).not.toBeNull();
      expect(mockInit).toHaveBeenCalledTimes(2);
      expect(peak).toBe(1);
      await session?.release();
      expect(live).toBe(0);
    });

    it('Multiple consecutive toggles: cancelled intermediate ones do not load, keep only the last one, only one at a time', async () => {
      const open = openLocalModel(store(true));
      const runs: Promise<unknown>[] = [];
      for (let i = 0; i < 5; i++) {
        const stop = new AbortController();
        runs.push(open(stop.signal));
        await settle();
        stop.abort();
      }
      const lastRun = open(new AbortController().signal);
      await finishLoads(Promise.all([...runs, lastRun]));
      const session = await lastRun;
      expect(session).not.toBeNull();
      expect(peak).toBe(1);
      // First one is already loading, cancelled one's turn no longer loads, last one loads.
      expect(mockInit).toHaveBeenCalledTimes(2);
      await session?.release();
      expect(live).toBe(0);
    });

    it('Close form and immediately open new one: wait for previous one to finish releasing even if still generating', async () => {
      const open = openLocalModel(store(true));
      const opening = open(new AbortController().signal);
      await finishLoads(opening);
      const session = (await opening)!;
      void session.generate(request, new AbortController().signal);
      const released = session.release();
      const next = open(new AbortController().signal);
      await finishLoads(Promise.all([released, next]));
      expect(peak).toBe(1);
      await (await next)?.release();
    });

    it('Go through engine: cancel during load immediately returns result, new one waits for previous release, only one at a time', async () => {
      context.completion.mockImplementationOnce(async () => ({ text: 'null' }));
      const engine = modelEngine(openLocalModel(store(true)));
      const input = {
        // Company field rules also ask the model even if there are candidates (store name doesn't ask if there are candidates, D-404).
        fields: [{ id: 'merchant', name: 'Company', type: 'text' as const }],
        pages: [
          {
            width: 100,
            height: 100,
            lines: [{ text: 'Acme Coffee', x: 0, y: 0, width: 50, height: 10 }],
          },
        ],
        locale: 'en' as const,
      };
      const a = new AbortController();
      const first = engine(input, a.signal);
      await settle();
      a.abort();
      await first; // Cancellation must ensure the Promise finishes, without waiting for loading.
      const second = engine(input, new AbortController().signal);
      await settle();
      expect(mockInit).toHaveBeenCalledTimes(1);
      await finishLoads(second);
      await settle();
      expect(peak).toBe(1);
      expect(live).toBe(0);
    });

    it('Load failure does not block next one', async () => {
      mockInit.mockImplementationOnce(() => Promise.reject(new Error('no memory')));
      const open = openLocalModel(store(true));
      await expect(open(new AbortController().signal)).rejects.toThrow('no memory');
      const next = open(new AbortController().signal);
      await finishLoads(next);
      expect(await next).not.toBeNull();
      await (await next)?.release();
    });

    it('Native module failure to load (Expo Go) does not block next one', async () => {
      const open = openLocalModel(store(true));
      mockNoNative = true;
      await expect(open(new AbortController().signal)).rejects.toThrow('no native module');
      mockNoNative = false;
      const next = open(new AbortController().signal);
      await finishLoads(next);
      expect(await next).not.toBeNull();
      await (await next)?.release();
    });

    it('Releasing twice only releases once, does not let queued items in', async () => {
      const open = openLocalModel(store(true));
      const opening = open(new AbortController().signal);
      await finishLoads(opening);
      const session = (await opening)!;
      await Promise.all([session.release(), session.release()]);
      expect(live).toBe(0);
    });
  });
});
