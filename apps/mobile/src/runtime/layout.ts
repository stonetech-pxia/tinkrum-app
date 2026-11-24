import {
  LAYOUT_INPUT,
  layoutInput,
  parseLayout,
  type LayoutRegion,
  type RgbaImage,
} from '@morph/tool-office';

// Word conversion layout analysis (D-328): PP-DocLayout-S resides in the layout pack, run via the
// same native modelRun method as flattening (one float32 input, one float32 output, D-274), with
// pre/post-processing in @morph/tool-office. Inputs and outputs use temporary files, deleted on
// completion regardless of success or failure.

/** Extension pack ID (PACKS in packages/core). */
export const LAYOUT_PACK = 'layout';

export interface LayoutNative {
  modelRun(model: string, input: string, shape: number[], output: string): Promise<number[]>;
}

export interface LayoutIo {
  installed(pack: string): Promise<boolean>;
  /** file:// URI for a file inside a pack. */
  modelUri(pack: string, file: string): string;
  readFile(uri: string): Promise<Uint8Array>;
  writeFile(uri: string, bytes: Uint8Array): Promise<unknown>;
  /** Creates a new temporary directory and returns its file:// URI (without trailing /) and a removal method. */
  tempDir(): { uri: string; remove(): void };
}

const bytesOf = (array: Float32Array) =>
  new Uint8Array(array.buffer, array.byteOffset, array.byteLength);

export function createLayoutDetector(native: LayoutNative, io: LayoutIo) {
  return {
    /** Layout regions of a page (coordinates match pixels); returns null if the model is not installed (segments by position only). */
    async detect(pixels: RgbaImage): Promise<LayoutRegion[] | null> {
      if (!(await io.installed(LAYOUT_PACK))) return null;
      const dir = io.tempDir();
      try {
        const inFile = `${dir.uri}/layout-in.bin`;
        const outFile = `${dir.uri}/layout-out.bin`;
        await io.writeFile(inFile, bytesOf(layoutInput(pixels)));
        const shape = await native.modelRun(
          io.modelUri(LAYOUT_PACK, 'layout.onnx'),
          inFile,
          [1, 3, LAYOUT_INPUT, LAYOUT_INPUT],
          outFile,
        );
        if (shape.length !== 2 || shape[1] !== 6) {
          throw new Error(`unexpected layout output ${shape.join('×')}`);
        }
        // Make a copy: the read bytes do not necessarily start at a multiple of 4.
        const out = new Float32Array((await io.readFile(outFile)).slice().buffer);
        return parseLayout(out.subarray(0, shape[0]! * 6), pixels);
      } finally {
        dir.remove();
      }
    },
  };
}
