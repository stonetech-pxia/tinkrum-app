import jsQRModule from 'jsqr';
import { correction, generate, mode } from 'lean-qr';

// QR code generation and recognition (T1). Depends solely on byte arrays, without DOM/Canvas:
// generation yields a module matrix and RGBA pixels (encoded into PNG by the app via Skia), and
// recognition directly consumes RGBA pixels. The lean-qr main entry is pure ESM, using only
// TextEncoder at the top level (built into Hermes).

export type QrErrorCode = 'empty' | 'tooLong';

export class QrError extends Error {
  constructor(readonly code: QrErrorCode) {
    super(code);
  }
}

export type QrEcc = 'L' | 'M' | 'Q' | 'H';

export interface QrMatrix {
  /** Number of modules per side (excluding quiet zone). */
  size: number;
  /** size*size modules, stored row by row, 1 = dark. */
  modules: Uint8Array;
}

export interface RgbaImage {
  width: number;
  height: number;
  /** width*height*4 bytes, RGBA order. */
  data: Uint8Array;
}

export const MAX_TEXT_LENGTH = 1000;

// Avoid lean-qr's default shift_jis mode: it calls TextDecoder('sjis'), which is unsupported by
// Hermes. Non-ASCII text uses UTF-8 (ECI 26), which can be correctly recognized by jsQR and
// mainstream QR scanners.
const MODES = [mode.numeric, mode.alphaNumeric, mode.ascii, mode.utf8];

/** Generate a QR code matrix. ecc is the minimum error correction level; lean-qr automatically increases it if the version has capacity headroom. */
export function qrMatrix(text: string, { ecc = 'M' }: { ecc?: QrEcc } = {}): QrMatrix {
  const length = [...text].length;
  if (length === 0) throw new QrError('empty');
  if (length > MAX_TEXT_LENGTH) throw new QrError('tooLong');
  let code;
  try {
    code = generate(text, { minCorrectionLevel: correction[ecc], modes: MODES });
  } catch {
    // The only possible failure is content exceeding the capacity of the maximum version (40), such as 1000 Chinese characters.
    throw new QrError('tooLong');
  }
  const { size } = code;
  const modules = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) modules[y * size + x] = code.get(x, y) ? 1 : 0;
  }
  return { size, modules };
}

export interface QrRgbaOptions {
  /** Number of pixels per module (positive integer). */
  scale: number;
  /** Number of quiet zone modules around the perimeter, specification requires at least 4. */
  marginModules?: number;
  /** `#RGB`, `#RRGGBB`, or `#RRGGBBAA`. */
  dark?: string;
  light?: string;
}

function parseColor(hex: string): [number, number, number, number] {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex);
  if (!m?.[1]) throw new RangeError(`invalid color: ${hex}`);
  let digits = m[1];
  if (digits.length === 3) digits = [...digits].map((c) => c + c).join('');
  if (digits.length === 6) digits += 'ff';
  const channel = (i: number) => parseInt(digits.slice(i * 2, i * 2 + 2), 16);
  return [channel(0), channel(1), channel(2), channel(3)];
}

/** Rasterize the matrix into RGBA pixels. */
export function qrToRgba(
  matrix: QrMatrix,
  { scale, marginModules = 4, dark = '#000000', light = '#FFFFFF' }: QrRgbaOptions,
): RgbaImage {
  if (!Number.isInteger(scale) || scale < 1) throw new RangeError(`invalid scale: ${scale}`);
  if (!Number.isInteger(marginModules) || marginModules < 0) {
    throw new RangeError(`invalid margin: ${marginModules}`);
  }
  const on = parseColor(dark);
  const off = parseColor(light);
  const { size, modules } = matrix;
  const width = (size + marginModules * 2) * scale;
  const height = width;
  const data = new Uint8Array(width * height * 4);
  // Draw a row of pixels for each module row first, then replicate the row scale times.
  const row = new Uint8Array(width * 4);
  for (let my = -marginModules; my < size + marginModules; my++) {
    for (let mx = -marginModules; mx < size + marginModules; mx++) {
      const isDark = my >= 0 && my < size && mx >= 0 && mx < size && modules[my * size + mx] === 1;
      const color = isDark ? on : off;
      const start = (mx + marginModules) * scale * 4;
      for (let p = 0; p < scale; p++) row.set(color, start + p * 4);
    }
    const top = (my + marginModules) * scale;
    for (let r = 0; r < scale; r++) data.set(row, (top + r) * width * 4);
  }
  return { width, height, data };
}

/**
 * Downscale the image using box averaging so the long side does not exceed maxSide (default 1600
 * px), returning as-is if already small enough. Downscale before recognition: passing large
 * photos directly to jsQR is both slow and memory-intensive.
 */
export function downscaleRgba(image: RgbaImage, maxSide = 1600): RgbaImage {
  const { width, height, data } = image;
  const longSide = Math.max(width, height);
  if (longSide <= maxSide) return image;
  const ratio = maxSide / longSide;
  const tw = Math.max(1, Math.round(width * ratio));
  const th = Math.max(1, Math.round(height * ratio));
  const out = new Uint8Array(tw * th * 4);
  for (let ty = 0; ty < th; ty++) {
    const y0 = Math.floor((ty * height) / th);
    const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * height) / th));
    for (let tx = 0; tx < tw; tx++) {
      const x0 = Math.floor((tx * width) / tw);
      const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * width) / tw));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * width + x) * 4;
          r += data[i] ?? 0;
          g += data[i + 1] ?? 0;
          b += data[i + 2] ?? 0;
          a += data[i + 3] ?? 0;
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (ty * tw + tx) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = a / n;
    }
  }
  return { width: tw, height: th, data: out };
}

// jsqr is a CommonJS package: Metro/Babel will pick .default, while Node native ESM gets the entire exports object.
const jsQR: typeof jsQRModule =
  typeof jsQRModule === 'function'
    ? jsQRModule
    : (jsQRModule as unknown as { default: typeof jsQRModule }).default;

/** Recognize QR codes in the image, returning null if none are found. Also tries inverted colors (dark background, light code). */
export function decodeQr({ data, width, height }: RgbaImage): string | null {
  if (data.length !== width * height * 4) {
    throw new RangeError(`expected ${width * height * 4} bytes, got ${data.length}`);
  }
  const pixels = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
  return jsQR(pixels, width, height, { inversionAttempts: 'attemptBoth' })?.data ?? null;
}
export interface WifiNetwork {
  name: string;
  security: 'WPA' | 'WEP' | 'none';
  password: string;
  hidden: boolean;
}

/** Issues with text in the Wi-Fi QR code: network name (empty, exceeds 32 bytes) or password (missing, WPA not 8–63 characters). */
export type WifiProblem = 'name' | 'passwordMissing' | 'password';

/** Prepend backslashes to \\, ;, ,, :, and " in the network name and password (escaping for Wi-Fi QR code format). */
const wifiEscape = (s: string) => s.replace(/[\\;,:"]/g, (c) => `\\${c}`);

/** UTF-8 byte length (TextEncoder is not present in this package's types). */
function utf8Length(s: string): number {
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return n;
}

/** Validate first, returning the problem if any, otherwise null. */
export function wifiProblem(net: WifiNetwork): WifiProblem | null {
  if (!net.name.trim() || utf8Length(net.name) > 32) return 'name';
  if (net.security === 'none') return null;
  if (!net.password) return 'passwordMissing';
  if (net.security === 'WPA' && (net.password.length < 8 || net.password.length > 63)) {
    return 'password';
  }
  return null;
}

/**
 * Text recognized by phone cameras when scanning Wi-Fi QR codes (D-199):
 * WIFI:T:WPA;S:network_name;P:password;H:true;; T:nopass and no P when there is no password.
 * Validate with wifiProblem first.
 */
export function wifiText(net: WifiNetwork): string {
  const type = net.security === 'none' ? 'nopass' : net.security;
  const password = net.security === 'none' ? '' : `P:${wifiEscape(net.password)};`;
  return `WIFI:T:${type};S:${wifiEscape(net.name)};${password}${net.hidden ? 'H:true;' : ''};`;
}

export { encodePng } from './png';
