import { axisTickText, chartYDomain } from '@morph/core';
import { Circle, DashPathEffect, useFont } from '@shopify/react-native-skia';
import { useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { Bar, CartesianChart, Line } from 'victory-native';

// Bar and line chart rendering (D-438): Victory Native XL (Skia) renders bars, lines, grids, and
// Y-axis ticks; tapping, screen reader labels, and values still use the transparent clickable area
// row (children) from Chart.tsx, so the X-axis is arranged with "one grid cell per point": point i
// is centered in cell i (x range -0.5 to n-0.5), with each clickable area cell directly overlying
// it. X-axis text is not rendered here (Skia fonts lack Chinese glyphs, and category names may be
// Chinese), and is instead labeled for the first and last segments by Chart.tsx using standard
// text.

const KARLA = require('@expo-google-fonts/karla/400Regular/Karla_400Regular.ttf');

export const PLOT_HEIGHT = 150;

export function ChartPlot({
  kind,
  values,
  previous,
  selected,
  color,
  mutedColor,
  gridColor,
  labelColor,
  children,
}: {
  kind: 'bar' | 'line';
  values: readonly (number | null)[];
  /** Previous period (D-439): corresponds one-to-one with values; lines are rendered dashed, and bar charts have light wide bars padded underneath. */
  previous?: readonly (number | null)[] | undefined;
  selected: number;
  color: string;
  mutedColor: string;
  gridColor: string;
  labelColor: string;
  /** A row of clickable areas overlaid on the chart (one cell per point). */
  children: ReactNode;
}) {
  const font = useFont(KARLA, 11);
  const [width, setWidth] = useState(0);
  const n = values.length;
  const data = values.map((v, i) => ({ i, v, p: previous?.[i] ?? null }));
  return (
    <View style={{ height: PLOT_HEIGHT }} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      {width > 0 && n > 0 ? (
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          <CartesianChart
            data={data}
            xKey="i"
            yKeys={previous ? ['v', 'p'] : ['v']}
            padding={{ top: 8, bottom: 0, left: 0, right: 0 }}
            domain={{
              x: [-0.5, n - 0.5],
              y: chartYDomain(
                (previous ? [...values, ...previous] : values).filter(
                  (v): v is number => v !== null,
                ),
              ),
            }}
            axisOptions={{
              font,
              tickCount: { x: 0, y: 4 },
              labelPosition: { x: 'outset', y: 'inset' },
              labelColor,
              lineColor: { grid: { x: 'transparent', y: gridColor }, frame: 'transparent' },
              lineWidth: { grid: { x: 0, y: StyleSheet.hairlineWidth }, frame: 0 },
              formatXLabel: () => '',
              formatYLabel: (v) => axisTickText(Number(v)),
            }}>
            {({ points, chartBounds }) =>
              kind === 'bar' ? (
                <>
                  {previous ? (
                    <Bar
                      points={points.p.filter((p) => p.y !== null)}
                      chartBounds={chartBounds}
                      color={mutedColor}
                      opacity={0.35}
                      barWidth={(width / n) * 0.9}
                      roundedCorners={{ topLeft: 4, topRight: 4 }}
                    />
                  ) : null}
                  <Bar
                    points={points.v.filter((p, i) => i !== selected && p.y !== null)}
                    chartBounds={chartBounds}
                    color={color}
                    opacity={0.55}
                    barWidth={(width / n) * (previous ? 0.62 : 0.8)}
                    roundedCorners={{ topLeft: 4, topRight: 4 }}
                  />
                  <Bar
                    points={points.v.filter((p, i) => i === selected && p.y !== null)}
                    chartBounds={chartBounds}
                    color={color}
                    barWidth={(width / n) * (previous ? 0.62 : 0.8)}
                    roundedCorners={{ topLeft: 4, topRight: 4 }}
                  />
                </>
              ) : (
                <>
                  {previous ? (
                    <Line
                      points={points.p}
                      color={mutedColor}
                      strokeWidth={2}
                      strokeJoin="round"
                      strokeCap="round"
                      connectMissingData={false}
                      curveType="linear">
                      <DashPathEffect intervals={[6, 6]} />
                    </Line>
                  ) : null}
                  <Line
                    points={points.v}
                    color={color}
                    strokeWidth={2}
                    strokeJoin="round"
                    strokeCap="round"
                    connectMissingData={false}
                    curveType="linear"
                  />
                  {/* When neither period has values, line charts have no segments: an isolated reading must draw a single point so it remains visible (D-631). */}
                  {points.v.map((p, i) =>
                    p.y != null && i !== selected ? (
                      <Circle key={i} cx={p.x} cy={p.y as number} r={3} color={color} />
                    ) : null,
                  )}
                  {points.v[selected]?.y != null ? (
                    <Circle
                      cx={points.v[selected]!.x}
                      cy={points.v[selected]!.y as number}
                      r={5}
                      color={color}
                    />
                  ) : null}
                </>
              )
            }
          </CartesianChart>
        </View>
      ) : null}
      {children}
    </View>
  );
}
