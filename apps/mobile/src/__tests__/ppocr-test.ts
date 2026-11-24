import { coversLanguage, createPpocr, type PpocrIo, type PpocrNative } from '../runtime/ppocr';

// PP-OCRv6 glue layer (D-269): tensors are written to temporary files and passed to the native
// module, which writes the results back to files and cleans them up after use. Here, in-memory
// "files" and a mock native module are used to verify file formats (little-endian float32 / int32)
// and cleanup.

function setup() {
  const disk = new Map<string, Uint8Array>();
  const dirs: { uri: string; removed: boolean }[] = [];
  const calls: string[] = [];
  let installed = true;
  const io: PpocrIo = {
    installed: async () => installed,
    modelUri: (file) => `file:///packs/ppocr/6.0.0/${file}`,
    readText: async () => JSON.stringify({ characters: ['你', '好'] }),
    tempDir() {
      const dir = { uri: `file:///cache/ocr/${dirs.length}`, removed: false };
      dirs.push(dir);
      return {
        uri: dir.uri,
        remove: () => {
          dir.removed = true;
          for (const key of [...disk.keys()]) if (key.startsWith(dir.uri)) disk.delete(key);
        },
      };
    },
    write: async (uri, bytes) => void disk.set(uri, bytes.slice()),
    read: async (uri) => disk.get(uri)!,
    // Required size for recognition (multiple of 32, shortest side at least 736).
    pixels: async () => {
      calls.push('decode');
      return { width: 736, height: 736, data: new Uint8Array(736 * 736 * 4) };
    },
  };
  const native: PpocrNative = {
    async ocrLoad(det, rec) {
      calls.push(`load ${det.split('/').pop()} ${rec.split('/').pop()}`);
    },
    async ocrDetect(input, width, height, output) {
      calls.push('detect');
      // Input is [1, 3, h, w] float32.
      expect(disk.get(input)!.byteLength).toBe(3 * width * height * 4);
      // A line of text: y 100–140, x 100–600.
      const prob = new Uint8Array(width * height);
      for (let y = 100; y < 140; y++) for (let x = 100; x < 600; x++) prob[y * width + x] = 240;
      disk.set(output, prob);
    },
    async ocrRecognize(input, count, width, output) {
      calls.push('recognize');
      expect(disk.get(input)!.byteLength).toBe(count * 3 * 48 * width * 4);
      // Two time steps: "you", "good", probability 0.9; first int32 category, then float32 probability (little-endian).
      const steps = 2;
      const buffer = new ArrayBuffer(count * steps * 8);
      const view = new DataView(buffer);
      for (let r = 0; r < count; r++) {
        view.setInt32(r * steps * 4, 1, true);
        view.setInt32((r * steps + 1) * 4, 2, true);
        view.setFloat32(count * steps * 4 + r * steps * 4, 0.9, true);
        view.setFloat32(count * steps * 4 + (r * steps + 1) * 4, 0.9, true);
      }
      disk.set(output, new Uint8Array(buffer));
      return steps;
    },
  };
  return {
    ppocr: createPpocr(native, io),
    disk,
    dirs,
    calls,
    uninstall: () => (installed = false),
  };
}

describe('PP-OCRv6 glue (D-269)', () => {
  it('runs both models through temporary files and removes them afterwards', async () => {
    const { ppocr, disk, dirs, calls } = setup();
    const result = await ppocr.recognize('file:///page.jpg');
    expect(result.width).toBe(736);
    expect(result.lines.map((l) => l.text)).toEqual(['你好']);
    expect(result.lines[0]!.score).toBeCloseTo(0.9);
    expect(calls).toEqual(['load det.onnx rec.onnx', 'decode', 'detect', 'recognize']);
    expect(dirs).toEqual([{ uri: 'file:///cache/ocr/0', removed: true }]);
    expect([...disk.keys()]).toEqual([]);
    // Approximate position of each character (D-272).
    expect(result.lines[0]!.chars?.map((c) => c.text)).toEqual(['你', '好']);
  });

  it('uses pixels that were already decoded instead of decoding the picture again (D-272)', async () => {
    const { ppocr, calls } = setup();
    const pixels = { width: 736, height: 736, data: new Uint8Array(736 * 736 * 4) };
    const result = await ppocr.recognize('file:///page.jpg', pixels);
    expect(result.lines.map((l) => l.text)).toEqual(['你好']);
    expect(calls).not.toContain('decode');
  });

  it('removes the temporary files when the model fails, and refuses without the model', async () => {
    const { ppocr, dirs, uninstall } = setup();
    const failing = createPpocr(
      {
        ocrLoad: async () => {},
        ocrDetect: async () => {
          throw new Error('out of memory');
        },
        ocrRecognize: async () => 0,
      },
      {
        installed: async () => true,
        modelUri: (f) => f,
        readText: async () => JSON.stringify({ characters: [] }),
        tempDir: () => {
          const dir = { uri: 'file:///cache/ocr/x', removed: false };
          dirs.push(dir);
          return { uri: dir.uri, remove: () => (dir.removed = true) };
        },
        write: async () => {},
        read: async () => new Uint8Array(),
        pixels: async () => ({ width: 736, height: 736, data: new Uint8Array(736 * 736 * 4) }),
      },
    );
    await expect(failing.recognize('file:///page.jpg')).rejects.toThrow('out of memory');
    expect(dirs.at(-1)!.removed).toBe(true);

    uninstall();
    await expect(ppocr.recognize('file:///page.jpg')).rejects.toThrow('not installed');
  });

  it('covers Chinese, Japanese and the Western European languages, not Korean, Russian or Vietnamese', () => {
    for (const code of [
      'zh-Hans',
      'zh-Hant',
      'ja-JP',
      'en-US',
      'fr-FR',
      'de-DE',
      'es-ES',
      'pt-BR',
      'it-IT',
    ])
      expect(coversLanguage(code)).toBe(true);
    for (const code of ['ko-KR', 'ru-RU', 'vi']) expect(coversLanguage(code)).toBe(false);
  });
});
