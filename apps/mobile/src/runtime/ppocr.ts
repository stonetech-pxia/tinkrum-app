import { recognizePage, type OcrModels, type OcrResultLine, type RgbaImage } from '@morph/tool-ocr';

// Recognizes an image using PP-OCRv6 (D-269): preprocessing and post-processing are in
// @morph/tool-ocr (JS), with the model executed by native modules. Tensors and results pass through
// temporary files (a few MB to tens of MB, avoiding parameter conversion between JS and native) and
// are deleted after recognition regardless of success or failure.

/** Languages supported by PP-OCRv6 (BCP 47 language subtags): Chinese (Simplified/Traditional), Japanese, English, French, German, Spanish, Portuguese, Italian. Korean, Russian, and Vietnamese are not recognized. */
export const PPOCR_LANGUAGES = ['zh', 'ja', 'en', 'fr', 'de', 'es', 'pt', 'it'] as const;

/** Extension pack ID (PACKS in packages/core). */
export const PPOCR_PACK = 'ppocr';

/** Long side of the image sent for recognition: benchmarks show this size is most accurate (character height approx. 25-35 pixels); larger sizes are slower without improving accuracy. */
export const PPOCR_INPUT_SIDE = 2000;

export interface PpocrNative {
  ocrLoad(det: string, rec: string): Promise<void>;
  ocrDetect(input: string, width: number, height: number, output: string): Promise<void>;
  ocrRecognize(input: string, count: number, width: number, output: string): Promise<number>;
}

export interface PpocrIo {
  /** Whether the extension pack is installed. */
  installed(): Promise<boolean>;
  /** file:// URI for a file inside a pack. */
  modelUri(file: 'det.onnx' | 'rec.onnx' | 'dictionary.json'): string;
  readText(uri: string): Promise<string>;
  /** Creates a new temporary directory and returns its file:// URI (without trailing /) and a removal method. */
  tempDir(): { uri: string; remove(): void };
  write(uri: string, bytes: Uint8Array): Promise<void>;
  read(uri: string): Promise<Uint8Array>;
  /** Decodes an image to the size required for recognition (ocrPixels). */
  pixels(uri: string, maxSide: number): Promise<RgbaImage>;
}

export const coversLanguage = (code: string) =>
  (PPOCR_LANGUAGES as readonly string[]).includes(code.split('-')[0]!.toLowerCase());

const bytesOf = (array: Float32Array) =>
  new Uint8Array(array.buffer, array.byteOffset, array.byteLength);

export function createPpocr(native: PpocrNative, io: PpocrIo) {
  let dictionary: readonly string[] | null = null;
  return {
    /**
     * Recognizes an image: returns the image size at recognition time and each line (pixels,
     * origin at top-left). pixels are the pre-decoded pixels of this image according to io.pixels
     * (decoded when finding lines for Excel conversion, D-272), skipping re-decoding if provided.
     */
    async recognize(
      uri: string,
      pixels?: RgbaImage,
    ): Promise<{ width: number; height: number; lines: OcrResultLine[] }> {
      if (!(await io.installed())) throw new Error('text recognition model is not installed');
      dictionary ??= JSON.parse(await io.readText(io.modelUri('dictionary.json'))).characters;
      await native.ocrLoad(io.modelUri('det.onnx'), io.modelUri('rec.onnx'));
      const image = pixels ?? (await io.pixels(uri, PPOCR_INPUT_SIDE));
      const dir = io.tempDir();
      try {
        let n = 0;
        const models: OcrModels = {
          async detect(input, width, height) {
            const inFile = `${dir.uri}/det-in.bin`;
            const outFile = `${dir.uri}/det-out.bin`;
            await io.write(inFile, bytesOf(input));
            await native.ocrDetect(inFile, width, height, outFile);
            return io.read(outFile);
          },
          async recognize(input, count, width) {
            const inFile = `${dir.uri}/rec-${n}-in.bin`;
            const outFile = `${dir.uri}/rec-${n++}-out.bin`;
            await io.write(inFile, bytesOf(input));
            const steps = await native.ocrRecognize(inFile, count, width, outFile);
            // Make a copy: the read bytes do not necessarily start at a multiple of 4.
            const bytes = (await io.read(outFile)).slice();
            const cells = count * steps;
            return {
              steps,
              index: new Int32Array(bytes.buffer, 0, cells),
              prob: new Float32Array(bytes.buffer, cells * 4, cells),
            };
          },
        };
        const lines = await recognizePage(image, models, dictionary!);
        return { width: image.width, height: image.height, lines };
      } finally {
        dir.remove();
      }
    },
  };
}

export type Ppocr = ReturnType<typeof createPpocr>;
