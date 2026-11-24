import { classifyImageWith, tidyLabels } from '../runtime/classify-image';

// JS part of native image classification: ensures the Promise always settles on cancellation (since the native side might never respond), and standardizes results across both platforms.

/** Mock native module: classifyImage hangs until the test explicitly resolves or rejects it. */
function hangingNative() {
  const pending: {
    taskId: string;
    resolve: (v: {
      labels: { id: string; confidence: number }[];
      width: number;
      height: number;
    }) => void;
    reject: (e: unknown) => void;
  }[] = [];
  const cancelled: string[] = [];
  const options: unknown[] = [];
  return {
    pending,
    cancelled,
    options,
    native: {
      classifyImage: (
        taskId: string,
        _uri: string,
        o: { maxResults: number; minConfidence: number },
      ) =>
        new Promise<{
          labels: { id: string; confidence: number }[];
          width: number;
          height: number;
        }>((resolve, reject) => {
          options.push(o);
          pending.push({ taskId, resolve, reject });
        }),
      cancelClassify: (taskId: string) => {
        cancelled.push(taskId);
      },
    },
  };
}

describe('classifyImageWith', () => {
  it('passes the defaults and returns tidy labels', async () => {
    const fake = hangingNative();
    const result = classifyImageWith(fake.native, 'file:///cache/runs/r1/photo.jpg');
    expect(fake.options).toEqual([{ maxResults: 10, minConfidence: 0.1 }]);
    fake.pending[0]!.resolve({
      labels: [
        { id: 'Paper', confidence: 0.4 },
        { id: 'Selfie', confidence: 0.92 },
      ],
      width: 768,
      height: 1024,
    });
    expect(await result).toEqual([
      { id: 'Selfie', confidence: 0.92 },
      { id: 'Paper', confidence: 0.4 },
    ]);
  });

  it('ends the promise as soon as the signal aborts, even if the native task never answers', async () => {
    const fake = hangingNative();
    const controller = new AbortController();
    const result = classifyImageWith(fake.native, 'file:///photo.heic', {
      signal: controller.signal,
    });
    controller.abort();
    await expect(result).rejects.toMatchObject({ code: 'cancelled' });
    // Also notifies the native side to stop, using the current taskId.
    expect(fake.cancelled).toEqual([fake.pending[0]!.taskId]);
    // A late native error is ignored and does not become an unhandled Promise rejection.
    fake.pending[0]!.reject(
      Object.assign(new Error('Cancelled'), { code: 'ERR_VISION_CANCELLED' }),
    );
  });

  it('does not start the native task when the signal is already aborted', async () => {
    const fake = hangingNative();
    const controller = new AbortController();
    controller.abort();
    await expect(
      classifyImageWith(fake.native, 'file:///photo.jpg', { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(fake.pending).toHaveLength(0);
  });

  it('turns the native cancelled code into cancelled and keeps other errors', async () => {
    const fake = hangingNative();
    const first = classifyImageWith(fake.native, 'file:///a.jpg');
    fake.pending[0]!.reject(
      Object.assign(new Error('Cancelled'), { code: 'ERR_VISION_CANCELLED' }),
    );
    await expect(first).rejects.toMatchObject({ code: 'cancelled' });

    const second = classifyImageWith(fake.native, 'content://media/external/images/1');
    fake.pending[1]!.reject(new Error('Vision failed: unreadable image'));
    await expect(second).rejects.toThrow('unreadable image');
  });

  it('gives every task its own id, and an abort after the answer changes nothing', async () => {
    const fake = hangingNative();
    const controller = new AbortController();
    const a = classifyImageWith(fake.native, 'file:///a.jpg', { signal: controller.signal });
    const b = classifyImageWith(fake.native, 'file:///b.jpg');
    expect(fake.pending[0]!.taskId).not.toBe(fake.pending[1]!.taskId);
    fake.pending[0]!.resolve({ labels: [], width: 1, height: 1 });
    expect(await a).toEqual([]);
    controller.abort();
    expect(fake.cancelled).toEqual([]);
    fake.pending[1]!.resolve({ labels: [], width: 1, height: 1 });
    await b;
  });
});

describe('tidyLabels', () => {
  it('clamps, drops bad values, keeps the best of duplicates, sorts and limits', () => {
    expect(
      tidyLabels(
        [
          { id: 'document', confidence: 0.5 },
          { id: 'document', confidence: 0.7 },
          { id: 'people', confidence: 1.3 },
          { id: 'food', confidence: Number.NaN },
          { id: '', confidence: 0.9 },
          { id: 'sky', confidence: 0.05 },
          { id: 'screenshot', confidence: 0.3 },
        ],
        2,
        0.1,
      ),
    ).toEqual([
      { id: 'people', confidence: 1 },
      { id: 'document', confidence: 0.7 },
    ]);
  });
});
