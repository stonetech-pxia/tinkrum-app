import { t } from './messages';
import {
  SEQUENCE_AGGREGATES,
  type Locale,
  type SequenceAggregate,
  type StreakUnit,
} from './schema-primitives';

// Display text for sequential aggregates (D-284): shared by statistics and summary fields (D-288). Does not depend on record reader implementation; field definitions can use it directly.

export const isSequenceAggregate = (a: string): a is SequenceAggregate =>
  (SEQUENCE_AGGREGATES as readonly string[]).includes(a);

/** Text displayed in statistics (with units, singular/plural determined by isSingular); displays "—" when there is no value. */
export function sequenceText(
  aggregate: SequenceAggregate,
  unit: StreakUnit | undefined,
  value: number | null,
  locale: Locale,
): string {
  if (value === null) return '—';
  switch (aggregate) {
    case 'streak':
      return t(locale, unit === 'week' ? 'seqWeeks' : unit === 'month' ? 'seqMonths' : 'seqDays', {
        n: value,
      });
    case 'daysSince':
      return value === 0 ? t(locale, 'seqToday') : t(locale, 'seqDaysAgo', { n: value });
    case 'avgInterval':
      return t(locale, 'seqAvgDays', { n: value });
    case 'distinctDays':
      return t(locale, 'seqDays', { n: value });
  }
}
