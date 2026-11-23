import { DRAWN_ICON_CANVAS, drawnIconId, type DrawnIcon, type DrawnIcons } from '@morph/core';
import { Canvas, Group, Path, Skia, type SkPath } from '@shopify/react-native-skia';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { Platform, View } from 'react-native';

// 画出来的图标（D-new-extensibility-2）：配置里 icons 的路径数据，用 Skia 按 24×24 的画布缩放画成一种颜色。
// 图标库从这里的 context 来，Icon 的调用处不用改；正在显示的配置（正式版本和草稿）由根布局放进来。

const DrawnIconsContext = createContext<DrawnIcons>({});

export function DrawnIconsProvider({
  icons,
  children,
}: {
  icons: DrawnIcons | undefined;
  children: ReactNode;
}) {
  return <DrawnIconsContext.Provider value={icons ?? {}}>{children}</DrawnIconsContext.Provider>;
}

/** 正在显示的配置里的图标库。 */
export const useDrawnIcons = (): DrawnIcons => useContext(DrawnIconsContext);

/** 图标值对应的定义：不是 my:<id>、或者库里没有，返回 null。 */
export function drawnIconOf(name: string, icons: DrawnIcons): DrawnIcon | null {
  const id = drawnIconId(name);
  return id !== null ? (icons[id] ?? null) : null;
}

/**
 * 把路径数据交给 Skia；有一条读不了就整个不画（Web 上没有加载 Skia，也不画）。填满的几条合成一条按 even-odd 画，
 * 一条里的形状套在另一条里也是挖空；只画线的各画各的。
 */
export function parseDrawnPaths(icon: DrawnIcon): SkPath[] | null {
  if (Platform.OS === 'web') return null;
  try {
    const paths = icon.paths.map((d) => Skia.Path.MakeFromSVGString(d));
    if (!paths.every((p): p is SkPath => p !== null)) return null;
    if (icon.stroke) return paths;
    const merged = Skia.PathBuilder.Make();
    for (const p of paths) merged.addPath(p);
    return [merged.build()];
  } catch {
    return null;
  }
}

/** my:<id> 图标。库里没有或画不出来时只占位，保持大小，布局不跳。 */
export function DrawnIconView({
  name,
  size,
  color,
}: {
  name: string;
  size: number;
  color: string;
}) {
  const icon = drawnIconOf(name, useDrawnIcons());
  const paths = useMemo(() => (icon ? parseDrawnPaths(icon) : null), [icon]);
  return (
    <View testID={`icon-${name}`} style={{ width: size, height: size }}>
      {paths ? (
        <Canvas testID="drawn-icon-canvas" style={{ width: size, height: size }}>
          <Group transform={[{ scale: size / DRAWN_ICON_CANVAS }]}>
            {paths.map((path, n) =>
              icon!.stroke ? (
                <Path
                  key={n}
                  path={path}
                  color={color}
                  style="stroke"
                  strokeWidth={2}
                  strokeCap="round"
                  strokeJoin="round"
                />
              ) : (
                <Path key={n} path={path} color={color} fillType="evenOdd" />
              ),
            )}
          </Group>
        </Canvas>
      ) : null}
    </View>
  );
}
