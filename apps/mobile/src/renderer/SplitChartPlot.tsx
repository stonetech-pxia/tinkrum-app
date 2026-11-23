import { axisTickText, lineScale, type ChartPoint } from '@morph/core';
import { Canvas, Circle, Path } from '@shopify/react-native-skia';
import { useState, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { PLOT_HEIGHT } from './ChartPlot';
import type { Palette } from './theme';

/** 正负分别累加：正数从零向上，负数从零向下；折线的空周期不连线。 */
export function SplitChartPlot({
  kind,
  points,
  colors,
  palette,
  children,
}: {
  kind: 'bar' | 'line';
  points: ChartPoint[];
  colors: string[];
  palette: Palette;
  children: ReactNode;
}) {
  const [width, setWidth] = useState(0);
  const stacks = points.map((p) => {
    let positive = 0,
      negative = 0;
    return (p.parts ?? []).map((part) => {
      const from = part.value >= 0 ? positive : negative;
      if (part.value >= 0) positive += part.value;
      else negative += part.value;
      return { from, to: from + part.value, empty: part.empty };
    });
  });
  const values =
    kind === 'bar'
      ? stacks.flatMap((stack) => stack.flatMap((part) => [part.from, part.to]))
      : points.flatMap((p) => (p.parts ?? []).map((part) => part.value));
  const scale = lineScale(values, width, PLOT_HEIGHT, 8);
  const n = points.length;
  const x = (i: number) => ((i + 0.5) * width) / n;
  const max = Math.max(0, ...values),
    min = Math.min(0, ...values);
  return (
    <View style={{ height: PLOT_HEIGHT }} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      {width > 0 ? (
        <>
          <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
            {[min, 0, max].map((value, i) => (
              <Path
                key={`grid-${i}`}
                path={`M0 ${scale.y(value)} L${width} ${scale.y(value)}`}
                color={palette.border}
                style="stroke"
                strokeWidth={1}
              />
            ))}
            {kind === 'bar'
              ? stacks.flatMap((stack, i) =>
                  stack.map((part, j) => {
                    if (part.empty || part.to === part.from) return null;
                    const left = x(i) - (width / n) * 0.4,
                      right = x(i) + (width / n) * 0.4;
                    const top = scale.y(Math.max(part.from, part.to)),
                      bottom = scale.y(Math.min(part.from, part.to));
                    return (
                      <Path
                        key={`${i}-${j}`}
                        path={`M${left} ${top} L${right} ${top} L${right} ${bottom} L${left} ${bottom} Z`}
                        color={colors[j]!}
                      />
                    );
                  }),
                )
              : colors.map((color, j) => {
                  let path = '',
                    connected = false;
                  for (let i = 0; i < n; i++) {
                    const part = points[i]!.parts?.[j];
                    if (!part || part.empty) {
                      connected = false;
                      continue;
                    }
                    path += `${connected ? 'L' : 'M'}${x(i)} ${scale.y(part.value)} `;
                    connected = true;
                  }
                  return <Path key={j} path={path} color={color} style="stroke" strokeWidth={2} />;
                })}
            {kind === 'line'
              ? points.flatMap((p, i) =>
                  (p.parts ?? []).map((part, j) =>
                    part.empty ? null : (
                      <Circle
                        key={`${i}-${j}`}
                        cx={x(i)}
                        cy={scale.y(part.value)}
                        r={3}
                        color={colors[j]!}
                      />
                    ),
                  ),
                )
              : null}
          </Canvas>
          {[min, max].map((v, i) => (
            <Text
              pointerEvents="none"
              key={i}
              style={[
                { position: 'absolute', left: 0, top: scale.y(v) - 12, color: palette.caption },
                palette.font('body', 10),
              ]}>
              {axisTickText(v)}
            </Text>
          ))}
        </>
      ) : null}
      {children}
    </View>
  );
}
