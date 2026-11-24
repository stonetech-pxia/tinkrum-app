import {
  AlphaType,
  BlendMode,
  ClipOp,
  ColorType,
  FilterMode,
  ImageFormat,
  MipmapMode,
  Skia,
  TileMode,
  VertexMode,
} from '@shopify/react-native-skia';
import { Platform } from 'react-native';

import {
  MAX_SURFACE_SIDE,
  SAUVOLA_K,
  SCAN_KNEE,
  SCAN_MIDTONE_GAMMA,
  despeckle,
  planScanEnhance,
  rotatedSize,
  surfaceScale,
  type RgbaImage,
  type ScanLook,
  type ScanOutput,
  UVDOC_INPUT,
  type Size,
  type WarpMesh,
} from '@morph/tool-image';
import { detectionSize } from '@morph/tool-ocr';

import { annotationSvg } from './annotations';
import type { FlattenPage } from './flatten';
import type { DrawOp } from './platform';

/** Off-screen canvases exceeding Metal texture limits cause immediate app crashes (rather than JS errors), so they are intercepted in JS first. */
function makeSurface(width: number, height: number) {
  if (width > MAX_SURFACE_SIDE || height > MAX_SURFACE_SIDE || width < 1 || height < 1) {
    throw new Error(`canvas ${width}×${height} is too large`);
  }
  const surface = Skia.Surface.MakeOffscreen(width, height);
  if (!surface) throw new Error('offscreen surface unavailable');
  return surface;
}

// Skia off-screen drawing (built-in to Expo Go). Renders only our own fixed content, executing zero configuration code.

/** System fonts: PingFang on iOS (including Chinese), default sans-serif on Android (missing characters—Chinese, Japanese, emoji—are substituted by the system font fallback). */
const FONT_FAMILY = Platform.select({ ios: ['PingFang SC'], default: ['sans-serif'] });

/**
 * Layout for label text: shared between preview and export. Uses Skia paragraph layout instead of
 * single-font drawing: paragraphs query the system for fonts containing each character (Android
 * default fonts lack Chinese, and drawing directly results in blocks). Padding scales
 * proportionally with font size.
 */
export function textLayout(text: string, fontSize: number, color = '#000000') {
  const build = (size: number) => {
    const builder = Skia.ParagraphBuilder.Make({});
    builder
      .pushStyle({
        color: Skia.Color(color),
        fontFamilies: FONT_FAMILY,
        fontSize: size,
        fontStyle: { weight: 700 },
      })
      .addText(text)
      .pop();
    const paragraph = builder.build();
    paragraph.layout(1e5);
    return paragraph;
  };
  let size = fontSize;
  let paragraph = build(size);
  // Very long lines exceeding canvas limits: scales down font size proportionally (callers use aspect ratio only).
  const natural = paragraph.getLongestLine() + size * 0.4;
  if (natural > MAX_SURFACE_SIDE) {
    size = Math.max(8, Math.floor((size * (MAX_SURFACE_SIDE - 16)) / natural));
    paragraph = build(size);
  }
  const pad = Math.round(size * 0.2);
  return {
    paragraph,
    pad,
    width: Math.ceil(paragraph.getLongestLine()) + 2 * pad,
    height: Math.ceil(paragraph.getHeight()) + 2 * pad,
  };
}

export function renderTextPng(
  text: string,
  style: { fontSize: number; color: string; opacity: number; background?: string },
): { bytes: Uint8Array; width: number; height: number } {
  const { paragraph, pad, width, height } = textLayout(text, style.fontSize, style.color);
  const surface = makeSurface(width, height);
  const canvas = surface.getCanvas();
  if (style.background) canvas.drawColor(Skia.Color(style.background));
  if (style.opacity < 1) {
    const layer = Skia.Paint();
    layer.setAlphaf(style.opacity);
    canvas.saveLayer(layer);
    paragraph.paint(canvas, pad, pad);
    canvas.restore();
  } else {
    paragraph.paint(canvas, pad, pad);
  }
  surface.flush();
  const bytes = surface.makeImageSnapshot().encodeToBytes(ImageFormat.PNG, 100);
  return { bytes, width, height };
}

/** Long side of the analysis image: background, black/white points, color vs. grayscale, and skew angle are computed on an image of this size (D-266). */
const ENHANCE_ANALYSIS_SIDE = 800;

// Full-resolution per-pixel operations (D-266): divide by paper background (per channel, rendering
// paper neutral white) -> stretch between black and white points (soft knee near white point,
// D-275) -> color / grayscale / black-and-white (Sauvola local thresholding based on the darkest
// channel; mean and standard deviation derived from the analysis image). Background and statistics
// images are very small and linearly interpolated from grid centers.
const ENHANCE_SKSL = `
uniform shader image;
uniform shader background;
uniform shader stats;
uniform float lo;
uniform float hi;
uniform float mode;
uniform float k;
uniform float gamma;
uniform float knee;

half4 main(float2 p) {
  float3 c = float3(image.eval(p).rgb);
  float3 b = max(float3(background.eval(p).rgb), float3(0.04));
  // Soft knee (scanTone, D-275): light text close to the paper color is not bluntly cut off to white, and the paper remains pure white. Not used in black-and-white mode.
  float3 u = min((c / b - lo) / (hi - lo), float3(1.0 + knee));
  float3 kn = u - (u - (1.0 - knee)) * (u - (1.0 - knee)) / (4.0 * knee);
  float3 n = clamp(mix(u, kn, step(float3(1.0 - knee), u)), 0.0, 1.0);
  float y = dot(n, float3(0.299, 0.587, 0.114));
  if (mode < 1.5) {
    // Darken midtones slightly (\u03b3 = SCAN_MIDTONE_GAMMA): paper stays white and black stays black, making faint text clearer. Not used in black-and-white mode (threshold is calculated based on unmodified brightness).
    float3 d = pow(n, float3(gamma));
    float dy = pow(y, gamma);
    if (mode > 0.5) return half4(half3(dy), 1.0);
    // Remove color from pixels close to gray (noise on paper, screen moire patterns); preserve pixels with saturated colors (red text, stamps).
    float chroma = max(n.r, max(n.g, n.b)) - min(n.r, min(n.g, n.b));
    return half4(half3(mix(float3(dy), d, smoothstep(0.08, 0.2, chroma))), 1.0);
  }
  // Black and white: first take the 3x3 average (suppressing screen moire patterns and paper
  // texture; strokes are 3-4 pixels wide so impact is small), then evaluate based on the darkest of
  // the three channels (red and blue text are also treated as dark, consistent with leveledInk in
  // analysis graphics).
  float3 sum = float3(0.0);
  for (int dx = -1; dx <= 1; dx++) {
    for (int dy = -1; dy <= 1; dy++) sum += float3(image.eval(p + float2(dx, dy)).rgb);
  }
  float3 m3 = clamp((sum / 9.0 / b - lo) / (hi - lo), 0.0, 1.0);
  float ink = min(m3.r, min(m3.g, m3.b));
  // stats: R is mean, G is standard deviation \u00d7 2, so s / 0.5 equals G.
  float2 ms = float2(stats.eval(p).rg);
  float t = ms.x * (1.0 + k * (ms.y - 1.0));
  float v = ink < t ? 0.0 : 1.0;
  return half4(half3(v), 1.0);
}
`;

let enhanceEffect: ReturnType<typeof Skia.RuntimeEffect.Make> | undefined;

/** Creates Skia images from RGBA pixels (background grids, statistical charts). */
function imageFromRgba(img: RgbaImage) {
  const out = Skia.Image.MakeImage(
    {
      width: img.width,
      height: img.height,
      colorType: ColorType.RGBA_8888,
      alphaType: AlphaType.Unpremul,
    },
    Skia.Data.fromBytes(img.data),
    img.width * 4,
  );
  if (!out) throw new Error('image could not be created');
  return out;
}

/** Reads an image into RGBA pixels: downscales to width × height (linear interpolation, using mipmaps when downscaling to prevent moiré patterns from interfering with analysis). */
function readScaled(image: SkImageLike, width: number, height: number): RgbaImage {
  const surface = makeSurface(width, height);
  const canvas = surface.getCanvas();
  canvas.drawColor(Skia.Color('#FFFFFF'));
  canvas.drawImageRectOptions(
    image,
    Skia.XYWHRect(0, 0, image.width(), image.height()),
    Skia.XYWHRect(0, 0, width, height),
    FilterMode.Linear,
    MipmapMode.Linear,
  );
  surface.flush();
  return { width, height, data: readRgba(surface.makeImageSnapshot(), width, height) };
}

function readRgba(image: SkImageLike, width: number, height: number): Uint8Array {
  const data = image.readPixels(0, 0, {
    width,
    height,
    colorType: ColorType.RGBA_8888,
    alphaType: AlphaType.Unpremul,
  });
  if (!(data instanceof Uint8Array)) throw new Error('pixels could not be read');
  return data;
}

/**
 * Scanned document enhancement (D-266, replacing the color matrix of D-078): computes background,
 * black/white endpoints, skew angle, and color/grayscale mode on the analysis image, then draws
 * in a single pass using a shader at full resolution (along with skew correction, expanding the
 * canvas to fit the four rotated corners with blank areas filled in white). Black-and-white mode
 * removes isolated noise pixels at full resolution as a final step. Outputs a JPG.
 */
export function enhanceJpeg(
  bytes: Uint8Array,
  look: ScanLook,
): {
  bytes: Uint8Array;
  width: number;
  height: number;
  output: ScanOutput;
  skew: number;
  /** Pre-rotation dimensions (canvas is scaled outside of it, used for converting OCR bounding boxes in D-267). */
  base: { width: number; height: number };
} {
  const image = Skia.Image.MakeImageFromEncoded(Skia.Data.fromBytes(bytes));
  if (!image) throw new Error('image could not be decoded');
  const iw = image.width();
  const ih = image.height();
  const a = Math.min(1, ENHANCE_ANALYSIS_SIDE / Math.max(iw, ih));
  const analysis = readScaled(
    image,
    Math.max(1, Math.round(iw * a)),
    Math.max(1, Math.round(ih * a)),
  );
  const plan = planScanEnhance(analysis, look);

  // Post-rotation canvas must not exceed limits: calculates scaling based on post-rotation dimensions.
  const k = surfaceScale(rotatedSize({ width: iw, height: ih }, plan.skew));
  const width = Math.max(1, Math.floor(iw * k));
  const height = Math.max(1, Math.floor(ih * k));
  const canvasSize = rotatedSize({ width, height }, plan.skew);

  enhanceEffect ??= Skia.RuntimeEffect.Make(ENHANCE_SKSL);
  if (!enhanceEffect) throw new Error('enhance shader could not be compiled');
  const shaderOf = (img: SkImageLike, w: number, h: number, fm: FilterMode) =>
    img.makeShaderOptions(
      TileMode.Clamp,
      TileMode.Clamp,
      fm,
      MipmapMode.None,
      Skia.Matrix().scale(width / w, height / h),
    );
  const background = imageFromRgba(plan.background);
  const stats = plan.stats ? imageFromRgba(plan.stats) : background;
  const mode = plan.output === 'color' ? 0 : plan.output === 'gray' ? 1 : 2;
  const shader = enhanceEffect.makeShaderWithChildren(
    [plan.lo, plan.hi, mode, SAUVOLA_K, SCAN_MIDTONE_GAMMA, SCAN_KNEE],
    [
      shaderOf(image, iw, ih, FilterMode.Linear),
      shaderOf(background, plan.background.width, plan.background.height, FilterMode.Linear),
      shaderOf(stats, stats.width(), stats.height(), FilterMode.Linear),
    ],
  );

  const surface = makeSurface(canvasSize.width, canvasSize.height);
  const canvas = surface.getCanvas();
  canvas.drawColor(Skia.Color('#FFFFFF'));
  canvas.save();
  canvas.translate(canvasSize.width / 2, canvasSize.height / 2);
  canvas.rotate(-plan.skew, 0, 0);
  canvas.translate(-width / 2, -height / 2);
  const paint = Skia.Paint();
  paint.setShader(shader);
  canvas.drawRect(Skia.XYWHRect(0, 0, width, height), paint);
  canvas.restore();
  surface.flush();
  let result = surface.makeImageSnapshot();

  if (plan.output === 'bw') {
    // Gray edges interpolated during rotation must also be binarized: thresholded at 128 prior to denoising (despeckle uses this threshold as well).
    const px = {
      width: canvasSize.width,
      height: canvasSize.height,
      data: readRgba(result, canvasSize.width, canvasSize.height),
    };
    for (let i = 0; i < px.data.length; i += 4) {
      const v = px.data[i]! < 128 ? 0 : 255;
      px.data[i] = px.data[i + 1] = px.data[i + 2] = v;
    }
    // At approximately 200 dpi: black dots where neither width nor height exceeds 3 pixels and no characters exist within a 9-pixel radius are treated as noise.
    const maxSide = Math.max(2, Math.round(Math.max(canvasSize.width, canvasSize.height) / 800));
    despeckle(px, { maxSide, reach: maxSide * 3 });
    result = imageFromRgba(px);
  }
  const out = result.encodeToBytes(ImageFormat.JPEG, 90);
  return {
    bytes: out,
    width: canvasSize.width,
    height: canvasSize.height,
    output: plan.output,
    skew: plan.skew,
    base: { width, height },
  };
}

type SkImageLike = NonNullable<ReturnType<typeof Skia.Image.MakeImageFromEncoded>>;

/**
 * Off-screen composition (D-079): executes fixed drawing operations in sequence. Caches only the
 * most recently decoded image, avoiding simultaneous memory occupancy across all images when
 * stitching many large graphics.
 */
export async function composeOnSurface(
  canvasSpec: { width: number; height: number; background: string },
  ops: readonly DrawOp[],
  save: { format: 'jpeg' | 'png'; quality: number },
  readUri: (uri: string) => Promise<Uint8Array>,
): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  const { width, height } = canvasSpec;
  const surface = makeSurface(width, height);
  const canvas = surface.getCanvas();
  canvas.drawColor(Skia.Color(canvasSpec.background));
  let cached: { key: string; image: SkImageLike } | null = null;
  const decode = async (source: { uri: string } | { bytes: Uint8Array }) => {
    const key = 'uri' in source ? source.uri : '';
    if (cached && key && cached.key === key) return cached.image;
    const bytes = 'uri' in source ? await readUri(source.uri) : source.bytes;
    const image = Skia.Image.MakeImageFromEncoded(Skia.Data.fromBytes(bytes));
    if (!image) throw new Error('image could not be decoded');
    cached?.image.dispose?.();
    cached = { key, image };
    return image;
  };
  for (const op of ops) {
    switch (op.kind) {
      case 'image': {
        const image = await decode(op.source);
        const src = op.src ?? { x: 0, y: 0, width: image.width(), height: image.height() };
        const paint = Skia.Paint();
        paint.setAntiAlias(true);
        if (op.opacity !== undefined) paint.setAlphaf(op.opacity);
        canvas.save();
        if (op.angleDeg) {
          canvas.rotate(op.angleDeg, op.dst.x + op.dst.width / 2, op.dst.y + op.dst.height / 2);
        }
        canvas.drawImageRect(
          image,
          Skia.XYWHRect(src.x, src.y, src.width, src.height),
          Skia.XYWHRect(op.dst.x, op.dst.y, op.dst.width, op.dst.height),
          paint,
        );
        canvas.restore();
        break;
      }
      case 'rect': {
        const paint = Skia.Paint();
        paint.setColor(Skia.Color(op.color));
        canvas.drawRect(Skia.XYWHRect(op.rect.x, op.rect.y, op.rect.width, op.rect.height), paint);
        break;
      }
      case 'blur': {
        // Flushes previously drawn content to a snapshot before drawing its blurred version within that region.
        surface.flush();
        const snapshot = surface.makeImageSnapshot();
        const paint = Skia.Paint();
        paint.setImageFilter(Skia.ImageFilter.MakeBlur(op.sigma, op.sigma, TileMode.Clamp, null));
        canvas.save();
        canvas.clipRect(
          Skia.XYWHRect(op.rect.x, op.rect.y, op.rect.width, op.rect.height),
          ClipOp.Intersect,
          true,
        );
        canvas.drawImage(snapshot, 0, 0, paint);
        canvas.restore();
        snapshot.dispose?.();
        break;
      }
      case 'path': {
        if (!op.points.length) break;
        const paint = Skia.Paint();
        paint.setAntiAlias(true);
        paint.setColor(Skia.Color(op.color));
        paint.setStyle(1);
        paint.setStrokeWidth(op.width);
        paint.setStrokeCap(1);
        paint.setStrokeJoin(1);
        const path = Skia.Path.MakeFromSVGString(annotationSvg(op.points));
        if (path) canvas.drawPath(path, paint);
        break;
      }
      case 'line': {
        const paint = Skia.Paint();
        paint.setColor(Skia.Color(op.color));
        paint.setStyle(1); // Stroke
        paint.setStrokeWidth(op.width);
        canvas.drawLine(op.x1, op.y1, op.x2, op.y2, paint);
        break;
      }
    }
  }
  (cached as { image: SkImageLike } | null)?.image.dispose?.();
  surface.flush();
  const out = surface.makeImageSnapshot();
  const bytes = out.encodeToBytes(
    save.format === 'png' ? ImageFormat.PNG : ImageFormat.JPEG,
    Math.round(save.quality * 100),
  );
  out.dispose?.();
  return { bytes, width, height };
}

/**
 * Input for text recognition (D-269): restricts the long side to maxSide first, then scales to
 * the size required for text line detection (multiple of 32, short side at least 736), scaled
 * entirely within Skia (linear interpolation, using mipmaps when downscaling) to eliminate
 * per-pixel interpolation in JS.
 */
export function ocrPixels(bytes: Uint8Array, maxSide: number): RgbaImage {
  const image = Skia.Image.MakeImageFromEncoded(Skia.Data.fromBytes(bytes));
  if (!image) throw new Error('image could not be decoded');
  const k = Math.min(1, maxSide / Math.max(image.width(), image.height()));
  const size = detectionSize(
    Math.max(1, Math.round(image.width() * k)),
    Math.max(1, Math.round(image.height() * k)),
  );
  return readScaled(image, size.width, size.height);
}

/** RGBA pixels of the image (with the long side scaled down to within maxSide). */
export function pixelsOf(
  bytes: Uint8Array,
  maxSide: number,
): { width: number; height: number; data: Uint8Array } {
  const image = Skia.Image.MakeImageFromEncoded(Skia.Data.fromBytes(bytes));
  if (!image) throw new Error('image could not be decoded');
  const k = Math.min(1, maxSide / Math.max(image.width(), image.height()));
  const width = Math.max(1, Math.round(image.width() * k));
  const height = Math.max(1, Math.round(image.height() * k));
  const surface = makeSurface(width, height);
  const canvas = surface.getCanvas();
  canvas.drawColor(Skia.Color('#FFFFFF'));
  canvas.drawImageRect(
    image,
    Skia.XYWHRect(0, 0, image.width(), image.height()),
    Skia.XYWHRect(0, 0, width, height),
    Skia.Paint(),
  );
  surface.flush();
  const snapshot = surface.makeImageSnapshot();
  const data = snapshot.readPixels(0, 0, {
    width,
    height,
    colorType: ColorType.RGBA_8888,
    alphaType: AlphaType.Unpremul,
  });
  if (!(data instanceof Uint8Array)) throw new Error('pixels could not be read');
  return { width, height, data };
}

/**
 * A page used for scan flattening (D-274): padding/shrinking for UVDoc, drawing small images on a
 * grid to find text lines, and drawing full-size results on a grid. The result is drawn once on
 * the original image using drawVertices (UVDoc, straightening, and line-by-line unslanting are
 * already composited into a single grid).
 */
export function openFlattenPage(bytes: Uint8Array): FlattenPage {
  const image = Skia.Image.MakeImageFromEncoded(Skia.Data.fromBytes(bytes));
  if (!image) throw new Error('image could not be decoded');
  const width = image.width();
  const height = image.height();
  /** Draw the original image onto the out-sized canvas according to the mesh. */
  const draw = (mesh: WarpMesh, out: Size, mip: boolean) => {
    const surface = makeSurface(out.width, out.height);
    const canvas = surface.getCanvas();
    canvas.drawColor(Skia.Color('#FFFFFF'));
    const point = (a: Float32Array) => {
      const pts = new Array<{ x: number; y: number }>(a.length / 2);
      for (let i = 0; i < pts.length; i++) pts[i] = { x: a[i * 2]!, y: a[i * 2 + 1]! };
      return pts;
    };
    const vertices = Skia.MakeVertices(
      VertexMode.Triangles,
      point(mesh.positions),
      point(mesh.texcoords),
      undefined,
      Array.from(mesh.indices),
    );
    const paint = Skia.Paint();
    paint.setShader(
      image.makeShaderOptions(
        TileMode.Clamp,
        TileMode.Clamp,
        FilterMode.Linear,
        mip ? MipmapMode.Linear : MipmapMode.None,
      ),
    );
    // No vertex colors: Dst means using only the shader (original image) color.
    canvas.drawVertices(vertices, BlendMode.Dst, paint);
    surface.flush();
    return surface.makeImageSnapshot();
  };
  return {
    width,
    height,
    uvdocPixels(margin, padded, gray) {
      const { width: iw, height: ih } = UVDOC_INPUT;
      const surface = makeSurface(iw, ih);
      const canvas = surface.getCanvas();
      canvas.drawColor(Skia.Color(`rgb(${gray}, ${gray}, ${gray})`));
      const kx = iw / padded.width;
      const ky = ih / padded.height;
      // Use bilinear filtering and no mipmaps, same as the scaling in the model.
      canvas.drawImageRectOptions(
        image,
        Skia.XYWHRect(0, 0, width, height),
        Skia.XYWHRect(margin * kx, margin * ky, width * kx, height * ky),
        FilterMode.Linear,
        MipmapMode.None,
      );
      surface.flush();
      return { width: iw, height: ih, data: readRgba(surface.makeImageSnapshot(), iw, ih) };
    },
    render(mesh, out) {
      return { ...out, data: readRgba(draw(mesh, out, true), out.width, out.height) };
    },
    encode(mesh, quality) {
      return draw(mesh, { width, height }, false).encodeToBytes(
        ImageFormat.JPEG,
        Math.round(quality * 100),
      );
    },
    dispose() {
      image.dispose?.();
    },
  };
}
