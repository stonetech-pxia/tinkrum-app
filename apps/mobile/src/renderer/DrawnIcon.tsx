import { DRAWN_ICON_CANVAS, drawnIconId, type DrawnIcon, type DrawnIcons } from '@morph/core';
import { Canvas, Group, Path, Skia, type SkPath } from '@shopify/react-native-skia';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { Platform, View } from 'react-native';

// Rendered icons (D-625): path data for icons in config, scaled and rendered in a single color
// using Skia on a 24x24 canvas. The icon library comes from the context here, so Icon call sites do
// not need modification; displayed configs (official version and draft) are injected by the root
// layout.

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

/** Icon library in the currently displayed configuration. */
export const useDrawnIcons = (): DrawnIcons => useContext(DrawnIconsContext);

/** Definition corresponding to the icon value: returns null if not my:<id> or not found in the library. */
export function drawnIconOf(name: string, icons: DrawnIcons): DrawnIcon | null {
  const id = drawnIconId(name);
  return id !== null ? (icons[id] ?? null) : null;
}

/**
 * Passes path data to Skia; if any path fails to load, renders nothing (Skia is not loaded on
 * Web, so nothing is rendered). Multiple filled paths are combined using even-odd fill rules, and
 * nested shapes within a path create cutouts; line-only paths are rendered individually.
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

/** my:<id> icon. Renders a placeholder to maintain size and prevent layout jumps when missing from the library or failing to render. */
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
