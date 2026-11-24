import {
  BlendMode,
  FillType,
  FilterMode,
  ImageFormat,
  MipmapMode,
  PaintStyle,
  Skia,
  StrokeCap,
  StrokeJoin,
  type SkCanvas,
  type SkTypefaceFontProvider,
} from '@shopify/react-native-skia';
import { DRAWN_ICON_CANVAS, isDrawnIconRef, type DrawnIcon } from '@morph/core';
import symbolFont from 'expo-symbols/androidWeights/regular';
import { Image } from 'react-native';

import { iconSource } from '../renderer/Icon';
import type { HomeScreenArt } from './platform';

// Graphic on Android desktop icon (D-606; other platforms use icon-image.ts, which doesn't draw):
// App's own icon drawn on its primary color background. Only draws our own fixed content: glyphs of
// built-in icons, PNG of bundled graphics, or an emoji, all drawn locally without networking.
//
// Graphic is an Android adaptive icon (108dp square, desktop only shows the middle ~72dp and crops
// to its own shape): background color fills entirely, icon is placed in the middle area guaranteed
// not to be cropped on any desktop.

/** 108dp × 4: enough for densest screens, system scales down as needed. */
const SIZE = 432;
/** Side length of the icon itself. */
const BOX = Math.round(SIZE * 0.36);

/** Reads files bundled into the app (fonts, images) into data. */
function read(asset: number) {
  const source = Image.resolveAssetSource(asset);
  if (!source) throw new Error('asset missing');
  return Skia.Data.fromURI(source.uri);
}

const SYMBOLS = 'symbols';
let symbolFonts: Promise<SkTypefaceFontProvider> | null = null;

/** Material Symbols font (same file used by system icons in the app), read once and kept. */
function loadSymbolFonts(): Promise<SkTypefaceFontProvider> {
  symbolFonts ??= read(symbolFont.font)
    .then((data) => {
      const typeface = Skia.Typeface.MakeFreeTypeFaceFromData(data);
      if (!typeface) throw new Error('symbol font unreadable');
      const fonts = Skia.TypefaceFontProvider.Make();
      fonts.registerFont(typeface, SYMBOLS);
      return fonts;
    })
    .catch((error: unknown) => {
      symbolFonts = null;
      throw error;
    });
  return symbolFonts;
}

/**
 * Lays out a line of text to BOX height: line height equals font size, top and bottom margins
 * split evenly, glyph (or emoji) is centered in the line. When fonts are provided, uses icon
 * fonts: font maps a string of letters to that icon by name (rlig ligature).
 */
function line(text: string, color: string, fonts?: SkTypefaceFontProvider) {
  const builder = fonts ? Skia.ParagraphBuilder.Make({}, fonts) : Skia.ParagraphBuilder.Make({});
  builder
    .pushStyle({
      color: Skia.Color(color),
      fontFamilies: [fonts ? SYMBOLS : 'sans-serif'],
      fontSize: BOX,
      heightMultiplier: 1,
      halfLeading: true,
    })
    .addText(text)
    .pop();
  const paragraph = builder.build();
  paragraph.layout(SIZE);
  return paragraph;
}

/**
 * Icon drawn from config (D-625): 24x24 path scaled to the icon area (same size and color as
 * other icons), filled paths combined into one drawn with even-odd rule, line-only drawn with
 * width 2 and round caps/joins. Throws an error if any path cannot be read (caller supplies no
 * icon).
 */
function drawPaths(canvas: SkCanvas, icon: DrawnIcon, color: string) {
  const paths = icon.paths.map((d) => Skia.Path.MakeFromSVGString(d));
  if (paths.some((p) => p === null)) throw new Error('icon path unreadable');
  const paint = Skia.Paint();
  paint.setAntiAlias(true);
  paint.setColor(Skia.Color(color));
  const at = (SIZE - BOX) / 2;
  canvas.save();
  canvas.translate(at, at);
  canvas.scale(BOX / DRAWN_ICON_CANVAS, BOX / DRAWN_ICON_CANVAS);
  if (icon.stroke) {
    paint.setStyle(PaintStyle.Stroke);
    paint.setStrokeWidth(2);
    paint.setStrokeCap(StrokeCap.Round);
    paint.setStrokeJoin(StrokeJoin.Round);
    for (const path of paths) canvas.drawPath(path!, paint);
  } else {
    const merged = Skia.PathBuilder.Make().setFillType(FillType.EvenOdd);
    for (const path of paths) merged.addPath(path!);
    canvas.drawPath(merged.build(), paint);
  }
  canvas.restore();
}

/** Drawn PNG (base64). Throws an error if unable to draw, caller supplies no icon, native uses Tinkrum's icon. */
export async function drawHomeScreenIcon(art: HomeScreenArt): Promise<string> {
  const source = iconSource(art.icon);
  // Read everything that needs to be read before opening the canvas.
  const fonts = source.symbol ? await loadSymbolFonts() : undefined;
  const picture = source.image ? Skia.Image.MakeImageFromEncoded(await read(source.image)) : null;
  if (source.image && !picture) throw new Error('icon image unreadable');

  const surface = Skia.Surface.MakeOffscreen(SIZE, SIZE);
  if (!surface) throw new Error('offscreen surface unavailable');
  const canvas = surface.getCanvas();
  canvas.drawColor(Skia.Color(art.background));
  if (isDrawnIconRef(art.icon)) {
    // When not found in the icon library (should not happen, validation catches it), only the background color is used, without drawing my:<id> as text.
    if (art.drawn) drawPaths(canvas, art.drawn, art.foreground);
  } else if (picture) {
    // Monochrome PNG: uses only its shape, tinted to the icon color.
    const paint = Skia.Paint();
    paint.setColorFilter(Skia.ColorFilter.MakeBlend(Skia.Color(art.foreground), BlendMode.SrcIn));
    const at = (SIZE - BOX) / 2;
    canvas.drawImageRectOptions(
      picture,
      Skia.XYWHRect(0, 0, picture.width(), picture.height()),
      Skia.XYWHRect(at, at, BOX, BOX),
      FilterMode.Linear,
      MipmapMode.None,
      paint,
    );
  } else {
    const paragraph = line(source.symbol ?? art.icon, art.foreground, fonts);
    paragraph.paint(
      canvas,
      (SIZE - paragraph.getLongestLine()) / 2,
      (SIZE - paragraph.getHeight()) / 2,
    );
  }
  surface.flush();
  return surface.makeImageSnapshot().encodeToBase64(ImageFormat.PNG, 100);
}
