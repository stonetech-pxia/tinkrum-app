// Single-choice option colors (D-568): options can specify a named color instead of a color value;
// uncolored options continue to use category colors sequentially (chart.ts). Each color has a light
// and dark variant: light variant sits on Clay page backgrounds and card colors, dark variant sits
// on dark backgrounds, both meeting MIN_TEXT_CONTRAST required for theme checks
// (option-colors.test.ts). Defined here once; value coloring, calendars, and pie charts all source
// from it.

export const OPTION_COLORS = {
  red: { light: '#c0352b', dark: '#ef6b5e' },
  orange: { light: '#b04e0f', dark: '#e88a4a' },
  yellow: { light: '#8a6700', dark: '#d9a92c' },
  green: { light: '#2a7a3b', dark: '#5cb870' },
  blue: { light: '#2865b8', dark: '#5e9be8' },
  purple: { light: '#7a4fc9', dark: '#a88ae8' },
  pink: { light: '#b8396f', dark: '#e57aa8' },
  grey: { light: '#6f6a64', dark: '#a39d96' },
} as const;

export type OptionColor = keyof typeof OPTION_COLORS;
export const OPTION_COLOR_NAMES = Object.keys(OPTION_COLORS) as [OptionColor, ...OptionColor[]];

/**
 * Category colors (CHART_COLORS in chart.ts, matching order, identical in light/dark variants)
 * and their respective color families (D-571): when any option in a single-choice field specifies
 * a color, uncolored options do not use category colors from that family (teal counts as green,
 * orange-red counts as red, indigo counts as blue and purple).
 */
export const CHART_COLOR_FAMILIES: readonly (readonly OptionColor[])[] = [
  ['blue'],
  ['orange', 'red'],
  ['green'],
  ['yellow', 'orange'],
  ['pink'],
  ['green'],
  ['purple', 'blue'],
];
