import {
  calendarOf,
  matchesCondition,
  optionColor,
  recordValue,
  type Collection,
  type DataRecord,
} from '@morph/core';
import { View } from 'react-native';

import type { RenderEnv } from './components';
import type { RecordBlock } from './data';

// Coloring by value (show.color) and highlight color (show.highlight, D-541), shared across record
// appearances. Options with a specified color use that color (D-568); unassigned options use
// categorical colors in order (same as calendar and pie charts, neutral gray starting from the
// 8th); unselected ones are not rendered.

export interface RecordMarks {
  /** The option color for this entry; undefined if show.color is not set or no option is selected. */
  colorOf: (r: DataRecord) => string | undefined;
  /** Whether this entry satisfies all conditions of show.highlight. */
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
  const highlight = show.highlight;
  return {
    colorOf: (r) => {
      if (!field || options.length === 0) return undefined;
      const i = options.findIndex((o) => o.id === recordValue(r, view, field.id, now, cal));
      return i < 0 ? undefined : optionColor(options[i], i, dark, options);
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
