import {
  FLATTEN_PAD_GRAY,
  UVDOC_GRID,
  UVDOC_INPUT,
  flattenMesh,
  grayOf,
  padMargin,
  paddedSize,
  planRefinement,
  ruleLines,
  textLinesFromProb,
  uvdocInput,
  type Refinement,
  type RgbaImage,
  type Size,
  type WarpMesh,
} from '@morph/tool-image';
import { detectionInput, detectionSize } from '@morph/tool-ocr';

// Scan flattening (D-274): straightened page -> add dark borders around, downscale to 488x712 ->
// UVDoc estimates curvature (45x31 grid) -> when text recognition model is installed, draw a small
// image using UVDoc to detect text lines (PP-OCRv6 det) and table lines, calculate full-page
// straightening and per-line rectification -> combine three steps into a triangle mesh, drawn once
// on the original image via Skia's drawVertices. Geometric calculations reside in @morph/tool-image
// (flatten.ts). Model inputs and outputs use temporary files (same as text recognition), deleted
// upon completion regardless of success or failure.

/** Extension pack ID (PACKS in packages/core). */
export const DEWARP_PACK = 'dewarp';

/** Long side of the small image used for text line detection: experiments show 1280 is as neat as 2000 while being more than twice as fast. */
export const REFINE_DETECT_SIDE = 1280;

export interface FlattenNative {
  modelRun(model: string, input: string, shape: number[], output: string): Promise<number[]>;
  /** Text line detection (PP-OCRv6 det, shared with text recognition); when absent, only flattens without refinement. */
  ocrLoad?(det: string, rec: string): Promise<void>;
  ocrDetect?(input: string, width: number, height: number, output: string): Promise<void>;
}

/** Operations available after a page is opened in Skia (implemented by skia.ts in the app, mocked in tests). */
export interface FlattenPage {
  width: number;
  height: number;
  /** RGBA image scaled to 488×712 after padding. */
  uvdocPixels(margin: number, padded: Size, gray: number): RgbaImage;
  /** Draws to out size according to mesh, reads back RGBA (small image used for text line detection). */
  render(mesh: WarpMesh, out: Size): RgbaImage;
  /** Draws to original size according to mesh, encodes as JPG. */
  encode(mesh: WarpMesh, quality: number): Uint8Array;
  dispose(): void;
}

export interface FlattenIo {
  installed(pack: string): Promise<boolean>;
  /** file:// URI for a file inside a pack. */
  modelUri(pack: string, file: string): string;
  readFile(uri: string): Promise<Uint8Array>;
  /** Writes the output image, returns the byte count. */
  writeFile(uri: string, bytes: Uint8Array): Promise<number>;
  /** Creates a new temporary directory and returns its file:// URI (without trailing /) and a removal method. */
  tempDir(): { uri: string; remove(): void };
  open(bytes: Uint8Array): FlattenPage;
}

export interface FlattenOutcome {
  width: number;
  height: number;
  size: number;
  refined: boolean;
  timing: Record<string, number>;
}

const bytesOf = (array: Float32Array) =>
  new Uint8Array(array.buffer, array.byteOffset, array.byteLength);

export function createFlattener(
  native: FlattenNative,
  io: FlattenIo,
  options: { ocrPack: string; quality: number; now?: () => number },
) {
  const now = options.now ?? (() => Date.now());
  return {
    /** Flattens a page and writes to output; returns null if the flatten model is not installed (callers fall back to the original page). */
    async flatten(uri: string, output: string): Promise<FlattenOutcome | null> {
      if (!(await io.installed(DEWARP_PACK))) return null;
      const timing: Record<string, number> = {};
      let t = now();
      const lap = (key: string) => {
        const n = now();
        timing[key] = n - t;
        t = n;
      };
      const page = io.open(await io.readFile(uri));
      const dir = io.tempDir();
      try {
        const size = { width: page.width, height: page.height };
        const input = uvdocInput(
          page.uvdocPixels(padMargin(size), paddedSize(size), FLATTEN_PAD_GRAY),
        );
        lap('uvdocInput');
        const inFile = `${dir.uri}/uvdoc-in.bin`;
        const outFile = `${dir.uri}/uvdoc-out.bin`;
        await io.writeFile(inFile, bytesOf(input));
        const shape = await native.modelRun(
          io.modelUri(DEWARP_PACK, 'uvdoc.onnx'),
          inFile,
          [1, 3, UVDOC_INPUT.height, UVDOC_INPUT.width],
          outFile,
        );
        if (shape.join() !== [1, 2, UVDOC_GRID.height, UVDOC_GRID.width].join()) {
          throw new Error(`unexpected UVDoc output ${shape.join('×')}`);
        }
        // Make a copy: the read bytes do not necessarily start at a multiple of 4.
        const grid = new Float32Array((await io.readFile(outFile)).slice().buffer);
        const warp = { grid, page: size };
        lap('uvdoc');

        let refine: Refinement | null = null;
        if (native.ocrLoad && native.ocrDetect && (await io.installed(options.ocrPack))) {
          await native.ocrLoad(
            io.modelUri(options.ocrPack, 'det.onnx'),
            io.modelUri(options.ocrPack, 'rec.onnx'),
          );
          const k = Math.min(1, REFINE_DETECT_SIDE / Math.max(size.width, size.height));
          const det = detectionSize(Math.round(size.width * k), Math.round(size.height * k));
          const low = page.render(flattenMesh(size, warp, null, det), det);
          lap('lowRender');
          const tensor = detectionInput(low);
          const detIn = `${dir.uri}/det-in.bin`;
          const detOut = `${dir.uri}/det-out.bin`;
          await io.writeFile(detIn, bytesOf(tensor.tensor));
          await native.ocrDetect(detIn, tensor.width, tensor.height, detOut);
          const prob = await io.readFile(detOut);
          lap('detect');
          const text = textLinesFromProb(prob, tensor.width, tensor.height, size);
          const gray = grayOf(low);
          const rulesH = ruleLines(gray, low.width, low.height, size, false);
          const rulesV = ruleLines(gray, low.width, low.height, size, true);
          refine = planRefinement(size, text, rulesH, rulesV);
          lap('refine');
        }
        const mesh = flattenMesh(size, warp, refine);
        lap('mesh');
        const bytes = page.encode(mesh, options.quality);
        lap('render');
        const written = await io.writeFile(output, bytes);
        lap('write');
        return {
          ...size,
          size: written,
          refined: refine !== null && refine.lines > 0,
          timing,
        };
      } finally {
        page.dispose();
        dir.remove();
      }
    },
  };
}

export type Flattener = ReturnType<typeof createFlattener>;
