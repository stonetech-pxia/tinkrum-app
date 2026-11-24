import { DEFAULT_CALENDAR, type Calendar } from './calendar';
import { fieldOf, recordValue, type DataRecord } from './data';
import { formatDuration } from './field-values';
import type { Collection } from './schema';

// Display format for fields on the right side of record lists (D-306, recordList's trailingFormat):
// - elapsed: time elapsed from a datetime (or creation time) until now, or until another datetime
// field. Items without an end time are running timers.
// - progress: ratio of a value to a target (fixed number or another field in this record), rendered
// as a ring or bar. Display-only, not stored, excluded from exports; pure logic resides here, while
// the App handles second-by-second refreshing and rendering the ring.

const pad = (n: number) => String(n).padStart(2, '0');

/** Datetime (local, YYYY-MM-DDTHH:mm) or creation/modification time -> milliseconds. */
function instantOf(record: DataRecord, collection: Collection, ref: string): number | undefined {
  if (ref === 'createdAt' || ref === 'updatedAt') return record[ref];
  const field = fieldOf(collection, ref);
  if (field?.type !== 'datetime') return undefined;
  const v = recordValue(record, collection, ref);
  if (typeof v !== 'string') return undefined;
  const [y, m, d] = v.slice(0, 10).split('-').map(Number) as [number, number, number];
  const [h, mi] = v.slice(11, 16).split(':').map(Number) as [number, number];
  return new Date(y, m - 1, d, h, mi).getTime();
}

export interface Elapsed {
  seconds: number;
  /** No end time: currently running, App refreshes every second. */
  running: boolean;
}

/** Elapsed time from `from` until `until` (or `now` if value is absent); returns nothing if start time is absent. Times prior to start evaluate to 0. */
export function elapsedOf(
  record: DataRecord,
  collection: Collection,
  from: string,
  until: string | undefined,
  now: Date,
): Elapsed | undefined {
  const start = instantOf(record, collection, from);
  if (start === undefined) return undefined;
  const end = until === undefined ? undefined : instantOf(record, collection, until);
  const running = end === undefined;
  const seconds = Math.max(0, Math.floor(((end ?? now.getTime()) - start) / 1000));
  return { seconds, running };
}

/** Running timers are formatted as h:mm:ss (2:15:30), finished ones and duration fields are formatted as h:mm (8:30). */
export function formatElapsed(e: Elapsed): string {
  if (!e.running) return formatDuration(Math.floor(e.seconds / 60));
  const h = Math.floor(e.seconds / 3600);
  return `${h}:${pad(Math.floor((e.seconds % 3600) / 60))}:${pad(e.seconds % 60)}`;
}

export interface Progress {
  value: number;
  goal: number;
  /** Ratio used for drawing rings and bars, 0–1 (exceeding target caps at 1). */
  ratio: number;
  done: boolean;
}

/** Value and target; absent if value is missing or target is not positive. */
export function progressOf(value: number | null | undefined, goal: number | null | undefined) {
  if (typeof value !== 'number' || typeof goal !== 'number' || !(goal > 0)) return undefined;
  const ratio = Math.min(1, Math.max(0, value / goal));
  return { value, goal, ratio: Math.round(ratio * 10_000) / 10_000, done: value >= goal };
}

/** Progress on a record: goal is a fixed number or a numeric field on this record (aggregates and formulas are also supported). */
export function recordProgress(
  record: DataRecord,
  collection: Collection,
  fieldId: string,
  goal: number | string,
  now: Date,
  cal: Calendar = DEFAULT_CALENDAR,
): Progress | undefined {
  const value = recordValue(record, collection, fieldId, now, cal);
  const target = typeof goal === 'number' ? goal : recordValue(record, collection, goal, now, cal);
  return progressOf(
    typeof value === 'number' ? value : null,
    typeof target === 'number' ? target : null,
  );
}

const num = (n: number) => String(Math.round(n * 100) / 100);

/** Arc of the progress ring (clockwise from 12 o'clock, SVG path string, directly recognized by Skia's Path); full circle when complete, empty when 0. */
export function ringPath(cx: number, cy: number, r: number, ratio: number): string {
  if (!(ratio > 0)) return '';
  const top = `M${num(cx)} ${num(cy - r)}`;
  if (ratio >= 1)
    return `${top} A${num(r)} ${num(r)} 0 1 1 ${num(cx)} ${num(cy + r)} A${num(r)} ${num(r)} 0 1 1 ${num(cx)} ${num(cy - r)}`;
  const angle = -Math.PI / 2 + ratio * Math.PI * 2;
  const large = ratio > 0.5 ? 1 : 0;
  return `${top} A${num(r)} ${num(r)} 0 ${large} 1 ${num(cx + r * Math.cos(angle))} ${num(cy + r * Math.sin(angle))}`;
}
