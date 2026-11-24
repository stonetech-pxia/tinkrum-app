import { z } from 'zod';

import { ScheduleRuleSchema, readSchedule, scheduleText, type ScheduleRule } from '../schedule';
import { IdSchema } from '../schema-primitives';
import { defineField, fieldBase, type FieldDefinitionOf } from './define';

/**
 * Which fields in the same table can serve as "Last done" (D-293): date, datetime, or rollup
 * fields (D-288, using all dates of the aggregated records, see data.ts rollupDays).
 */
export const SCHEDULE_LAST_DONE_TYPES: readonly string[] = ['date', 'datetime', 'rollup'];

const schema = z.strictObject({
  ...fieldBase,
  type: z.literal('schedule'),
  default: ScheduleRuleSchema.optional(),
  lastDone: IdSchema.optional(),
  /** Doing things early counts as completion for this instance (D-341), used for todos and chores; not used for bills (paying early still requires paying next month). */
  countEarly: z.literal(true).optional(),
});

/**
 * D-292: Schedule, storing a recurrence rule per record (set by the user in the form, default is
 * the rule for new records). Displayed as "rule · next due"; filtering (due, inPeriod, gt / lt),
 * sorting, and formulas use the calculated next due date (D-294, D-295). lastDone is the date or
 * datetime field recording "Last done" in the same table (D-293); without it, calculations are
 * based solely on the rule itself.
 */
export const scheduleField: FieldDefinitionOf<'schedule', typeof schema> = defineField({
  type: 'schedule',
  schema,
  label: ['日程', 'schedule'],
  read: (_f, raw) => readSchedule(raw),
  write: (_f, input) => {
    const rule = readSchedule(input);
    return rule ? { value: rule } : { issue: 'invalid' };
  },
  initial: (f) => f.default,
  // Rules only; the "· next due" on records is appended by data.ts formatRef (requires the full record to calculate).
  format: (_f, v, locale) => scheduleText(v as ScheduleRule, locale),
  formula: 'date',
  filter: { is: () => false, compare: 'date', period: true, schedule: true },
  check: (f, { collection }) => {
    if (f.lastDone === undefined) return [];
    const source = collection.fields.find((x) => x.id === f.lastDone);
    if (source && SCHEDULE_LAST_DONE_TYPES.includes(source.type)) return [];
    return [
      {
        code: 'data',
        message: `${collection.id}.${f.id}: lastDone ${f.lastDone} must be a date, datetime or rollup field of ${collection.id}`,
      },
    ];
  },
  ai: {
    doc: '{default?: Rule, lastDone?: fieldId of a date, datetime or rollup field, countEarly?: true} (a repeat rule each entry keeps; rule 43; once and countEarly: rule 47; a time on a rule: rule 50)',
  },
  example: {
    id: 'plan',
    name: 'Plan',
    type: 'schedule',
    default: { repeat: 'interval', every: 7 },
  },
  exampleValue: { repeat: 'weekdays', days: [1, 3, 5] },
});
