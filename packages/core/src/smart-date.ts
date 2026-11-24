import { DEFAULT_CALENDAR, dateOfDayNumber, type Calendar } from './calendar';
import { findDatePhrase, type DatePhrase, type DatePhraseValue } from './date-phrases';
import { dayNumber } from './formula';
import { scheduleText, shortDate, type ScheduleRule } from './schedule';
import { t } from './messages';
import type { Field, Locale } from './schema';

// smartDate for the quick add form (D-344): recognizes dates mentioned in text locally, converts
// them into form inputs for the target field type (date, date-time, event). Bypasses AI (D-113).
// Recognized dates that cannot be filled into such fields (e.g., "every Monday" for a date field)
// are treated as unrecognized. Event fields fill time and date together (D-346).

export interface SmartDate {
  phrase: DatePhrase;
  /** Form input, passed to prepareRecordValues. */
  input: unknown;
  /** Shown to the user: what it will be filled as (tomorrow, Nov 5 15:00, every Monday). */
  preview: string;
}

function inputFor(value: DatePhraseValue, field: Field, today: number): unknown {
  const date = value.kind === 'time' ? dateOfDayNumber(today) : 'date' in value ? value.date : '';
  switch (field.type) {
    case 'date':
      return value.kind === 'date' ? value.date : undefined;
    case 'datetime':
      // Date-time must include time: left blank when only a date is mentioned (user selects time manually).
      return value.kind !== 'repeat' && value.time ? `${date} ${value.time}` : undefined;
    case 'schedule': {
      // Time included as well (D-346): "Friday 3pm" -> once, Friday 15:00; only time mentioned defaults to today.
      const at = value.time ? { time: value.time } : {};
      if (value.kind === 'repeat') return { ...value.rule, ...at };
      return { repeat: 'once', date, ...at };
    }
    default:
      return undefined;
  }
}

function previewOf(input: unknown, field: Field, today: number, locale: Locale): string {
  if (field.type === 'schedule') {
    const rule = input as ScheduleRule;
    if (rule.repeat !== 'once') return scheduleText(rule, locale);
    const day = shortDate(dayNumber(rule.date!)!, today, locale);
    return rule.time ? t(locale, 'scheduleAtTime', { rule: day, time: rule.time }) : day;
  }
  const text = String(input);
  const day = shortDate(dayNumber(text.slice(0, 10))!, today, locale);
  return text.length > 10 ? `${day} ${text.slice(11)}` : day;
}

/** Date phrasing in text that can be filled into this field; undefined if none or unfillable. */
export function smartDateOf(
  text: string,
  field: Field,
  today: number,
  locale: Locale,
  cal: Calendar = DEFAULT_CALENDAR,
): SmartDate | undefined {
  const phrase = findDatePhrase(text, today, cal);
  if (!phrase) return undefined;
  const input = inputFor(phrase.value, field, today);
  if (input === undefined) return undefined;
  return { phrase, input, preview: previewOf(input, field, today, locale) };
}
