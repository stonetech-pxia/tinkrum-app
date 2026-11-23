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

// Android 桌面图标上的图（D-606；别的平台是 icon-image.ts，不画）：App 自己的图标画在它自己主色的底上。只画我们自己的固定内容：
// 内置图标的字形、自带图形的 PNG 或一个表情，都在本机画，不联网。
//
// 图是 Android 的自适应图标（108dp 见方，桌面只显示中间约 72dp，再按自己的形状裁）：底色铺满整张，
// 图标放在所有桌面都不会裁到的中间一块里。

/** 108dp × 4：最密的屏幕也够，系统按需要缩小。 */
const SIZE = 432;
/** 图标本身的边长。 */
const BOX = Math.round(SIZE * 0.36);

/** 打包进 App 的文件（字体、图片）读成数据。 */
function read(asset: number) {
  const source = Image.resolveAssetSource(asset);
  if (!source) throw new Error('asset missing');
  return Skia.Data.fromURI(source.uri);
}

const SYMBOLS = 'symbols';
let symbolFonts: Promise<SkTypefaceFontProvider> | null = null;

/** Material Symbols 的字体（App 里的系统图标用的同一个文件），读一次留着。 */
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
 * 一行字排成 BOX 高：行高等于字号、上下留白对半分，字形（或表情）就在这一行的正中。
 * 给了 fonts 时用图标字体：字体按名字把一串字母换成那个图标（rlig 连字）。
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
 * 配置里画出来的图标（D-new-extensibility-2）：24×24 的路径缩放到图标那一块（和别的图标同样大小、同一种颜色），
 * 填满的合成一条按 even-odd 画，只画线的 2 宽、圆头圆角。有一条读不了就抛错（调用方不带图）。
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

/** 画出来的 PNG（base64）。画不出来时抛错，调用方不带图，原生用 Tinkrum 的图标。 */
export async function drawHomeScreenIcon(art: HomeScreenArt): Promise<string> {
  const source = iconSource(art.icon);
  // 先把要读的东西读完再开画布。
  const fonts = source.symbol ? await loadSymbolFonts() : undefined;
  const picture = source.image ? Skia.Image.MakeImageFromEncoded(await read(source.image)) : null;
  if (source.image && !picture) throw new Error('icon image unreadable');

  const surface = Skia.Surface.MakeOffscreen(SIZE, SIZE);
  if (!surface) throw new Error('offscreen surface unavailable');
  const canvas = surface.getCanvas();
  canvas.drawColor(Skia.Color(art.background));
  if (isDrawnIconRef(art.icon)) {
    // 图标库里没有（不该发生，校验会拦）时只有底色，不把 my:<id> 当字画出来。
    if (art.drawn) drawPaths(canvas, art.drawn, art.foreground);
  } else if (picture) {
    // 单色 PNG：只用它的形状，染成图标色。
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
