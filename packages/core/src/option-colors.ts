// 单选选项的颜色（D-568）：选项可以写一个有名字的颜色，而不是色值；没写的选项照旧按顺序用分类色（chart.ts）。
// 每个颜色一浅一深：浅色界面上的那一个在 Clay 的页面底色和卡片色上、深色的在深色底上，对比度都达到
// 主题检查用的 MIN_TEXT_CONTRAST（option-colors.test.ts）。只在这里定义一次，按值上色、月历、饼图都从这里取。

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
 * 分类色（chart.ts 的 CHART_COLORS，同一顺序，浅色深色一样）每一色属于哪些色系（D-571）：同一个单选字段里有选项写了
 * 某个颜色时，没写颜色的选项不拿这个色系的分类色（青绿算绿，橙红也算红，靛蓝也算蓝、紫）。
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
