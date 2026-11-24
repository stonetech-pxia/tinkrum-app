import { minAreaRect, rectCorners, unclipRect, type Point } from './geometry';

// PP-OCRv6 text recognition pipeline (D-269), everything except running the model is here: text
// line input preparation (scaling to multiple of 32, BGR, normalization), probability map -> text
// boxes (DB post-processing), straightening and cropping each box into a 48-pixel-high strip, and
// decoding recognition results according to CTC rules. Running the model is provided by the
// platform (iOS and Android use ONNX Runtime, Node tests use onnxruntime-node), so these steps can
// be tested in Node.

/** RGBA pixels (4 bytes per pixel). */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Two models: text line detection and character recognition. */
export interface OcrModels {
  /** Input [1, 3, height, width], output probability that each pixel is text × 255 (width × height bytes). */
  detect(input: Float32Array, width: number, height: number): Promise<Uint8Array>;
  /**
   * Input [count, 3, 48, width]; output the highest probability category (0 is blank) and its
   * probability for each sequence and time step, ordered by [count, steps]. The entire
   * probability table is too large, so the platform only returns the maximum values.
   */
  recognize(
    input: Float32Array,
    count: number,
    width: number,
  ): Promise<{ steps: number; index: Int32Array; prob: Float32Array }>;
}

export interface OcrResultLine {
  text: string;
  /** Average confidence (0-1). */
  score: number;
  /** Four corners of the text box (top-left, top-right, bottom-right, bottom-left) in original image pixels. */
  quad: [Point, Point, Point, Point];
  /** Bounding axis-aligned rectangle in original image pixels, with origin at top-left. */
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * Approximate position of each character (D-272): at is the center of the CTC time step as a
   * proportion of the line width (0 for leftmost, 1 for rightmost). Used to split lines crossing
   * vertical lines when converting to Excel. Vertical lines (recognized after 90-degree rotation)
   * do not have this.
   */
  chars?: { text: string; at: number }[];
}

export interface OcrOptions {
  /** Minimum size for the short side when searching for text lines (upscaling small images), default 736. */
  limitSide?: number;
  /** Probability threshold for text, default 0.3. */
  threshold?: number;
  /** Discard boxes whose average inner probability is lower than this, default 0.6. */
  boxThreshold?: number;
  /** Ratio for expanding boxes outward, default 1.5. */
  unclipRatio?: number;
  /** Discard recognition results whose average confidence is lower than this, default 0.5. */
  textScore?: number;
  /** Number of strips sent to the recognition model in one batch, default 6. */
  batch?: number;
}

const DET_MEAN = [0.485, 0.456, 0.406];
const DET_STD = [0.229, 0.224, 0.225];
const REC_HEIGHT = 48;
const REC_MIN_WIDTH = 320;
const REC_MAX_WIDTH = 3200;
const MIN_BOX_SIDE = 3;

/** Bilinear sampling of a single channel (clamping to edge values outside edges); c is the channel number in RGBA. */
function sample(image: RgbaImage, x: number, y: number, c: number): number {
  const { width, height, data } = image;
  const fx = Math.min(Math.max(x, 0), width - 1);
  const fy = Math.min(Math.max(y, 0), height - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const ax = fx - x0;
  const ay = fy - y0;
  const top = data[(y0 * width + x0) * 4 + c]! * (1 - ax) + data[(y0 * width + x1) * 4 + c]! * ax;
  const bottom =
    data[(y1 * width + x0) * 4 + c]! * (1 - ax) + data[(y1 * width + x1) * 4 + c]! * ax;
  return top * (1 - ay) + bottom * ay;
}

/** Input size for text line detection: upscale if short side is less than limit, then round to the nearest multiple of 32. */
export function detectionSize(
  width: number,
  height: number,
  limit = 736,
): { width: number; height: number } {
  const ratio = Math.min(width, height) < limit ? limit / Math.min(width, height) : 1;
  return {
    width: Math.max(32, Math.round(Math.floor(width * ratio) / 32) * 32),
    height: Math.max(32, Math.round(Math.floor(height * ratio) / 32) * 32),
  };
}

/**
 * Input tensor for text line detection: BGR channels, subtract mean and divide by variance.
 * Directly convert if the image is already the requested size (already scaled by platform using
 * Skia), otherwise bilinear scale (pixel center aligned, same as OpenCV); JS on mobile lacks JIT
 * and pixel-by-pixel interpolation is very slow, so prefer the former.
 */
export function detectionInput(image: RgbaImage, limit = 736) {
  const size = detectionSize(image.width, image.height, limit);
  const plane = size.width * size.height;
  const tensor = new Float32Array(plane * 3);
  if (size.width === image.width && size.height === image.height) {
    const { data } = image;
    const k = [0, 1, 2].map((c) => 1 / 255 / DET_STD[c]!);
    const m = [0, 1, 2].map((c) => DET_MEAN[c]! / DET_STD[c]!);
    const [k0, k1, k2] = k as [number, number, number];
    const [m0, m1, m2] = m as [number, number, number];
    for (let o = 0, i = 0; o < plane; o++, i += 4) {
      tensor[o] = data[i + 2]! * k0 - m0;
      tensor[plane + o] = data[i + 1]! * k1 - m1;
      tensor[2 * plane + o] = data[i]! * k2 - m2;
    }
    return { tensor, ...size };
  }
  const sx = image.width / size.width;
  const sy = image.height / size.height;
  for (let y = 0; y < size.height; y++) {
    const srcY = (y + 0.5) * sy - 0.5;
    for (let x = 0; x < size.width; x++) {
      const srcX = (x + 0.5) * sx - 0.5;
      const o = y * size.width + x;
      // Channel 0 is B (RGBA index 2), 1 is G, 2 is R.
      for (let c = 0; c < 3; c++) {
        tensor[c * plane + o] =
          (sample(image, srcX, srcY, 2 - c) / 255 - DET_MEAN[c]!) / DET_STD[c]!;
      }
    }
  }
  return { tensor, ...size };
}

/**
 * Probability map -> text boxes (DB post-processing): pixels exceeding the threshold are grouped
 * into 8-connected components, components with too low average probability are discarded, minimum
 * bounding rectangle is found, expanded slightly, converted to original image size, and sorted
 * from top to bottom, left to right.
 */
export function textBoxes(
  prob: Uint8Array,
  width: number,
  height: number,
  dest: { width: number; height: number },
  options: OcrOptions = {},
): { quad: [Point, Point, Point, Point]; score: number }[] {
  const threshold = Math.round((options.threshold ?? 0.3) * 255);
  const boxThreshold = options.boxThreshold ?? 0.6;
  const unclip = options.unclipRatio ?? 1.5;
  const seen = new Uint8Array(width * height);
  const stack: number[] = [];
  // Leftmost and rightmost pixels for each row; reset after processing each component.
  const rowMin = new Int32Array(height).fill(width);
  const rowMax = new Int32Array(height).fill(-1);
  const boxes: { quad: [Point, Point, Point, Point]; score: number }[] = [];
  for (let start = 0; start < prob.length; start++) {
    if (seen[start] || prob[start]! <= threshold) continue;
    // Component: only leftmost and rightmost pixels are needed per row (convex hull only considers them).
    const firstRow = (start - (start % width)) / width;
    let lastRow = firstRow;
    let sum = 0;
    let count = 0;
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % width;
      const y = (p - x) / width;
      if (x < rowMin[y]!) rowMin[y] = x;
      if (x > rowMax[y]!) rowMax[y] = x;
      if (y > lastRow) lastRow = y;
      sum += prob[p]!;
      count++;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const q = ny * width + nx;
          if (!seen[q] && prob[q]! > threshold) {
            seen[q] = 1;
            stack.push(q);
          }
        }
      }
    }
    // The first pixel found by row scanning is in the topmost row, so the row indices for this component range from firstRow to lastRow.
    const points: Point[] = [];
    for (let y = firstRow; y <= lastRow; y++) {
      if (rowMax[y]! < 0) continue;
      points.push({ x: rowMin[y]!, y }, { x: rowMax[y]!, y });
      rowMin[y] = width;
      rowMax[y] = -1;
    }
    const rect = minAreaRect(points);
    if (Math.min(rect.w, rect.h) < MIN_BOX_SIDE) continue;
    // Score using the component's own pixels (PaddleOCR's score_mode=slow) instead of the bounding
    // rectangle: when photographing screens or book pages, text lines are curved, so half of the
    // rectangle is blank, dropping the average probability below the threshold and causing the
    // entire line to be lost.
    const score = sum / count / 255;
    if (score < boxThreshold) continue;
    const grown = unclipRect(rect, unclip);
    if (Math.min(grown.w, grown.h) < MIN_BOX_SIDE + 2) continue;
    const quad = rectCorners(grown).map((p) => ({
      x: Math.min(Math.max(Math.round((p.x / width) * dest.width), 0), dest.width),
      y: Math.min(Math.max(Math.round((p.y / height) * dest.height), 0), dest.height),
    })) as [Point, Point, Point, Point];
    boxes.push({ quad, score });
  }
  // From top to bottom, left to right; within the same line (top-left height difference less than 10 pixels), the one on the left comes first.
  boxes.sort((a, b) => a.quad[0].y - b.quad[0].y || a.quad[0].x - b.quad[0].x);
  for (let i = 0; i < boxes.length - 1; i++) {
    const a = boxes[i]!.quad[0];
    const b = boxes[i + 1]!.quad[0];
    if (Math.abs(b.y - a.y) < 10 && b.x < a.x)
      [boxes[i], boxes[i + 1]] = [boxes[i + 1]!, boxes[i]!];
  }
  return boxes;
}

/** Size of a box after straightening; tall boxes (height >= 1.5 times width) are rotated 90 degrees counter-clockwise. */
function cropShape(quad: readonly Point[]) {
  const d = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
  const [p0, p1, p2, p3] = quad as [Point, Point, Point, Point];
  const w = Math.max(1, Math.floor(Math.max(d(p0, p1), d(p2, p3))));
  const h = Math.max(1, Math.floor(Math.max(d(p0, p3), d(p1, p2))));
  const turned = h / w >= 1.5;
  return { w, h, turned, outW: turned ? h : w, outH: turned ? w : h };
}

/**
 * Straighten a batch of boxes and scale them to 48 pixels high, arranging them into recognition
 * input of shape [count, 3, 48, width] (BGR, normalized to -1 to 1, padded with 0 on the right).
 * used is the actual occupied width of each strip (the rest is padding), used to convert time
 * steps into character positions within the line.
 */
export function recognitionInput(image: RgbaImage, quads: readonly (readonly Point[])[]) {
  const shapes = quads.map(cropShape);
  const ratio = Math.max(...shapes.map((s) => s.outW / s.outH));
  const width = Math.min(REC_MAX_WIDTH, Math.max(REC_MIN_WIDTH, Math.floor(REC_HEIGHT * ratio)));
  const plane = REC_HEIGHT * width;
  const tensor = new Float32Array(quads.length * 3 * plane);
  const used: number[] = [];
  const { width: iw, height: ih, data: px } = image;
  for (const [n, quad] of quads.entries()) {
    const s = shapes[n]!;
    const [p0, p1, p2, p3] = quad as [Point, Point, Point, Point];
    const resized = Math.min(width, Math.ceil((REC_HEIGHT * s.outW) / s.outH));
    used.push(resized);
    for (let dy = 0; dy < REC_HEIGHT; dy++) {
      const oy = Math.max(0, ((dy + 0.5) * s.outH) / REC_HEIGHT - 0.5);
      for (let dx = 0; dx < resized; dx++) {
        const ox = Math.max(0, ((dx + 0.5) * s.outW) / resized - 0.5);
        // For 90-degree rotated ones: output (ox, oy) corresponds to straightened (w - 1 - oy, ox).
        const cx = s.turned ? s.w - 1 - oy : ox;
        const cy = s.turned ? ox : oy;
        const u = cx / s.w;
        const v = cy / s.h;
        // Perspective transformation of a rectangular box is bilinear interpolation of the four corners.
        const sx =
          (1 - u) * (1 - v) * p0.x + u * (1 - v) * p1.x + u * v * p2.x + (1 - u) * v * p3.x;
        const sy =
          (1 - u) * (1 - v) * p0.y + u * (1 - v) * p1.y + u * v * p2.y + (1 - u) * v * p3.y;
        // Bilinear sampling (inlined: JS on mobile lacks JIT, function calls are expensive).
        const fx = sx < 0 ? 0 : sx > iw - 1 ? iw - 1 : sx;
        const fy = sy < 0 ? 0 : sy > ih - 1 ? ih - 1 : sy;
        const x0 = fx | 0;
        const y0 = fy | 0;
        const x1 = x0 + 1 < iw ? x0 + 1 : x0;
        const y1 = y0 + 1 < ih ? y0 + 1 : y0;
        const ax = fx - x0;
        const ay = fy - y0;
        const i00 = (y0 * iw + x0) * 4;
        const i01 = (y0 * iw + x1) * 4;
        const i10 = (y1 * iw + x0) * 4;
        const i11 = (y1 * iw + x1) * 4;
        const w00 = (1 - ax) * (1 - ay);
        const w01 = ax * (1 - ay);
        const w10 = (1 - ax) * ay;
        const w11 = ax * ay;
        const o = n * 3 * plane + dy * width + dx;
        for (let c = 0; c < 3; c++) {
          const ch = 2 - c;
          const v =
            px[i00 + ch]! * w00 + px[i01 + ch]! * w01 + px[i10 + ch]! * w10 + px[i11 + ch]! * w11;
          tensor[o + c * plane] = v / 127.5 - 1;
        }
      }
    }
  }
  return { tensor, width, used };
}

/**
 * CTC decoding: remove blanks (0) and consecutive duplicates, category i corresponds to
 * dictionary character i - 1; confidence is the average probability of the remaining characters.
 * at is the time step index for each character (taking the middle of consecutive steps),
 * corresponding 1-to-1 with characters in text (categories outside the dictionary are not
 * counted).
 */
export function ctcDecode(
  index: ArrayLike<number>,
  prob: ArrayLike<number>,
  steps: number,
  row: number,
  dictionary: readonly string[],
): { text: string; score: number; at: number[] } {
  let text = '';
  let sum = 0;
  let count = 0;
  let previous = -1;
  const at: number[] = [];
  let start = 0;
  for (let t = 0; t <= steps; t++) {
    const k = t < steps ? index[row * steps + t]! : -1;
    // The consecutive steps of the previous character have ended.
    if (previous > 0 && k !== previous && dictionary[previous - 1] !== undefined) {
      at.push((start + t - 1) / 2);
    }
    if (t === steps) break;
    if (k !== 0 && k !== previous) {
      text += dictionary[k - 1] ?? '';
      sum += prob[row * steps + t]!;
      count++;
      start = t;
    }
    previous = k;
  }
  return { text, score: count > 0 ? sum / count : 0, at };
}

/** Single page image recognition: find text lines -> straighten each line -> recognize characters (batched and sorted by width, placing similar widths in a batch). */
export async function recognizePage(
  image: RgbaImage,
  models: OcrModels,
  dictionary: readonly string[],
  options: OcrOptions = {},
): Promise<OcrResultLine[]> {
  const det = detectionInput(image, options.limitSide ?? 736);
  const prob = await models.detect(det.tensor, det.width, det.height);
  const boxes = textBoxes(prob, det.width, det.height, image, options);
  const order = boxes
    .map((box, i) => ({ i, ratio: cropShape(box.quad).outW / cropShape(box.quad).outH }))
    .sort((a, b) => a.ratio - b.ratio)
    .map((e) => e.i);
  const texts: { text: string; score: number; chars?: { text: string; at: number }[] }[] =
    new Array(boxes.length);
  const batch = options.batch ?? 6;
  for (let start = 0; start < order.length; start += batch) {
    const ids = order.slice(start, start + batch);
    const input = recognitionInput(
      image,
      ids.map((i) => boxes[i]!.quad),
    );
    const out = await models.recognize(input.tensor, ids.length, input.width);
    for (const [row, i] of ids.entries()) {
      const decoded = ctcDecode(out.index, out.prob, out.steps, row, dictionary);
      // Time step -> position in the line: each step occupies 1 / steps of the input width, with only the first used pixels containing content.
      const step = input.width / out.steps;
      const used = input.used[row]!;
      const chars = cropShape(boxes[i]!.quad).turned
        ? undefined
        : Array.from(decoded.text).length === decoded.at.length
          ? Array.from(decoded.text).map((text, k) => ({
              text,
              at: Math.min(1, Math.max(0, ((decoded.at[k]! + 0.5) * step) / used)),
            }))
          : undefined;
      texts[i] = { text: decoded.text, score: decoded.score, ...(chars ? { chars } : {}) };
    }
  }
  const minScore = options.textScore ?? 0.5;
  const lines: OcrResultLine[] = [];
  for (const [i, box] of boxes.entries()) {
    const { text, score, chars } = texts[i]!;
    if (score < minScore || !text.trim()) continue;
    const xs = box.quad.map((p) => p.x);
    const ys = box.quad.map((p) => p.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    lines.push({
      text,
      score,
      quad: box.quad,
      x,
      y,
      width: Math.max(...xs) - x,
      height: Math.max(...ys) - y,
      ...(chars ? { chars } : {}),
    });
  }
  return lines;
}
