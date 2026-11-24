import { LAYOUT_LABELS } from '@morph/tool-office';

import { createLayoutDetector, type LayoutIo } from '../runtime/layout';

// Word conversion layout analysis (D-328): does not run when the pack is not installed; inputs and
// outputs use temporary files and are deleted regardless of success or failure; output bounding
// boxes are scaled back according to the line detection image size.

function setup(output: number[], shape: number[], installed = true) {
  const disk = new Map<string, Uint8Array>();
  const calls: string[] = [];
  let removed = 0;
  const io: LayoutIo = {
    installed: async (pack) => (calls.push(`installed ${pack}`), installed),
    modelUri: (pack, file) => `file:///packs/${pack}/${file}`,
    readFile: async (uri) => disk.get(uri)!,
    writeFile: async (uri, bytes) => void disk.set(uri, bytes.slice()),
    tempDir: () => ({ uri: 'file:///tmp/layout-1', remove: () => void removed++ }),
  };
  const detector = createLayoutDetector(
    {
      async modelRun(model, input, inShape, out) {
        calls.push(`modelRun ${model.split('/').pop()} ${inShape.join('×')}`);
        // Input is a 1x3x480x480 float32.
        expect(disk.get(input)!.byteLength).toBe(3 * 480 * 480 * 4);
        // Bytes read back from native might not start at a multiple of 4: placed in an offset buffer.
        const raw = new Uint8Array(new Float32Array(output).buffer);
        const shifted = new Uint8Array(raw.length + 1);
        shifted.set(raw, 1);
        disk.set(out, shifted.subarray(1));
        return shape;
      },
    },
    io,
  );
  return { detector, calls, removed: () => removed };
}

const pixels = { width: 960, height: 1440, data: new Uint8Array(960 * 1440 * 4).fill(255) };

describe('layout detector (D-328)', () => {
  it('runs the pack’s model and maps the boxes to the picture', async () => {
    const text = LAYOUT_LABELS.indexOf('text');
    const { detector, calls, removed } = setup([text, 0.9, 48, 48, 240, 96], [1, 6]);
    const regions = await detector.detect(pixels);
    expect(calls).toEqual(['installed layout', 'modelRun layout.onnx 1×3×480×480']);
    expect(regions).toEqual([
      {
        kind: 'text',
        label: 'text',
        score: expect.closeTo(0.9, 5),
        box: { x: 96, y: 144, width: 384, height: 144 },
      },
    ]);
    expect(removed()).toBe(1);
  });

  it('returns null without running anything when the pack is not installed', async () => {
    const { detector, calls } = setup([], [0, 6], false);
    expect(await detector.detect(pixels)).toBeNull();
    expect(calls).toEqual(['installed layout']);
  });

  it('throws on an unexpected output and still removes the temporary files', async () => {
    const { detector, removed } = setup([0, 0, 0], [1, 3]);
    await expect(detector.detect(pixels)).rejects.toThrow('unexpected layout output 1×3');
    expect(removed()).toBe(1);
  });
});
