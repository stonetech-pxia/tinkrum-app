import {
  calendarOf,
  CHART_COLORS,
  matchesCondition,
  recordValue,
  type Collection,
  type DataRecord,
} from '@morph/core';
import { View } from 'react-native';

import type { RenderEnv } from './components';
import type { RecordBlock } from './data';

// 按值上色（show.color）和警示色（show.highlight，D-541），每种记录外观共用。
// 选项按顺序用分类色（和月历、饼图一样，第 8 个起是中性灰）；没选的不画。

export interface RecordMarks {
  /** 这一条的选项颜色；没设 show.color 或没选时没有。 */
  colorOf: (r: DataRecord) => string | undefined;
  /** 这一条满足 show.highlight 的全部条件。 */
  warns: (r: DataRecord) => boolean;
}

export function recordMarks(
  show: RecordBlock['show'],
  view: Collection,
  env: RenderEnv,
  now: Date,
): RecordMarks {
  const cal = calendarOf(env.config);
  const field = show.color ? view.fields.find((f) => f.id === show.color) : undefined;
  const options = field?.type === 'choice' ? field.options : [];
  const dark = env.palette.dark;
  const scheme = dark ? CHART_COLORS.dark : CHART_COLORS.light;
  const other = dark ? CHART_COLORS.other.dark : CHART_COLORS.other.light;
  const highlight = show.highlight;
  return {
    colorOf: (r) => {
      if (!field || options.length === 0) return undefined;
      const i = options.findIndex((o) => o.id === recordValue(r, view, field.id, now, cal));
      return i < 0 ? undefined : (scheme[i] ?? other);
    },
    warns: (r) =>
      highlight !== undefined && highlight.every((c) => matchesCondition(r, view, c, now, cal)),
  };
}

export function ColorDot({ color, recordId }: { color: string | undefined; recordId: string }) {
  if (!color) return null;
  return (
    <View
      testID={`color-dot-${recordId}`}
      style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }}
    />
  );
}
