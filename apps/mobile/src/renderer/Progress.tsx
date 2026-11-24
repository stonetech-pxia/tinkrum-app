import { ringPath } from '@morph/core';
import { Canvas, Path } from '@shopify/react-native-skia';
import { StyleSheet, View } from 'react-native';

import type { Palette } from './theme';

// Progress rings and progress bars (progress from D-306, goals stats from D-307). Ratios come from
// core's progressOf (0-1), ring arcs from core's ringPath (SVG path, directly recognized by Skia);
// bottom ring is border color, screen readers read adjacent text.

export function ProgressRing({
  ratio,
  size,
  stroke,
  palette,
  testID,
}: {
  ratio: number;
  size: number;
  stroke: number;
  palette: Palette;
  testID?: string;
}) {
  const r = (size - stroke) / 2;
  const c = size / 2;
  const arc = ringPath(c, c, r, ratio);
  return (
    <View testID={testID} style={{ width: size, height: size }} pointerEvents="none">
      <Canvas style={StyleSheet.absoluteFill}>
        <Path
          path={ringPath(c, c, r, 1)}
          style="stroke"
          strokeWidth={stroke}
          color={palette.border}
        />
        {arc ? (
          <Path
            path={arc}
            style="stroke"
            strokeWidth={stroke}
            strokeCap="round"
            color={palette.primary}
          />
        ) : null}
      </Canvas>
    </View>
  );
}

export function ProgressBar({
  ratio,
  palette,
  testID,
}: {
  ratio: number;
  palette: Palette;
  testID?: string;
}) {
  return (
    <View testID={testID} style={[styles.track, { backgroundColor: palette.border }]}>
      <View
        style={[
          styles.fill,
          { width: `${Math.round(ratio * 100)}%`, backgroundColor: palette.primary },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  track: { height: 6, borderRadius: 3, overflow: 'hidden', alignSelf: 'stretch' },
  fill: { height: 6, borderRadius: 3 },
});
