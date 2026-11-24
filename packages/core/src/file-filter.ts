import { DEFAULT_CALENDAR, type Calendar } from './calendar';
import { localDate, periodRange } from './data';
import { isOfficeFile, mediaKindOf } from './media';
import type { Period } from './schema';

// Filter files by conditions (file.filter, D-242): Conditions must be chosen from a fixed set
// (type, size, image orientation, date, duration), with at most one rule per kind, and all
// conditions must be satisfied. There are no arbitrary expressions; the AI can only choose
// conditions and numbers, and cannot see file contents.

export const FILTER_KINDS = ['any', 'images', 'pdf', 'video', 'audio', 'documents'] as const;
export const FILTER_ORIENTATIONS = ['any', 'landscape', 'portrait', 'square'] as const;

export interface FileFilter {
  kind: (typeof FILTER_KINDS)[number];
  size: 'any' | 'larger' | 'smaller';
  sizeMB?: number;
  orientation: (typeof FILTER_ORIENTATIONS)[number];
  date: 'any' | 'lastDays' | 'period' | 'between';
  days?: number;
  /** A calendar time span: this week, this month, this year, etc. (shares the same scheme as data table filters). */
  period?: Period;
  /** YYYY-MM-DD, inclusive of that day. */
  from?: string;
  to?: string;
  duration: 'any' | 'longer' | 'shorter';
  seconds?: number;
  /** Behavior when none remain: stop = stop execution and explain, skip = skip this step and pass files unchanged to the next step. */
  whenEmpty: 'stop' | 'skip';
}

/** File information used during filtering (part of RunItem). */
export interface FilterableItem {
  name: string;
  ext: string;
  mimeType: string;
  size: number;
  width?: number;
  height?: number;
  durationMs?: number;
  /** Photo capture timestamp (milliseconds). */
  takenAt?: number;
  /** File modification time in milliseconds (available for files selected from the Files app). */
  modifiedAt?: number;
}

/** Width and height differences within 2% are considered square (photos taken on phones often differ by a few pixels). */
const SQUARE_TOLERANCE = 0.02;

/** Checks whether there are any active conditions in this group (filters consisting entirely of 'Any' are meaningless). */
export const hasFileCondition = (
  f: Pick<FileFilter, 'kind' | 'size' | 'orientation' | 'date' | 'duration'>,
) =>
  f.kind !== 'any' ||
  f.size !== 'any' ||
  f.orientation !== 'any' ||
  f.date !== 'any' ||
  f.duration !== 'any';

/** Determining orientation requires dimensions, and determining duration requires duration: runtime populates these details first. */
export function fileFilterNeeds(f: FileFilter): { dimensions: boolean; duration: boolean } {
  return { dimensions: f.orientation !== 'any', duration: f.duration !== 'any' };
}

const localDay = (ms: number) => localDate(new Date(ms));

export function orientationOf(width: number, height: number): 'landscape' | 'portrait' | 'square' {
  if (Math.abs(width - height) <= SQUARE_TOLERANCE * Math.max(width, height)) return 'square';
  return width > height ? 'landscape' : 'portrait';
}

function kindMatches(kind: FileFilter['kind'], item: FilterableItem): boolean {
  const name = `${item.name}.${item.ext}`;
  switch (kind) {
    case 'any':
      return true;
    case 'images':
      return mediaKindOf(item.mimeType, name) === 'image';
    case 'pdf':
      return mediaKindOf(item.mimeType, name) === 'pdf';
    case 'video':
      return mediaKindOf(item.mimeType, name) === 'video';
    case 'audio':
      return mediaKindOf(item.mimeType, name) === 'audio';
    case 'documents':
      return isOfficeFile(item.mimeType, name);
  }
}

/**
 * Whether a file satisfies all conditions. Missing metadata (unknown capture/modification date,
 * missing dimensions, or non-video/audio files lacking duration) does not satisfy the condition:
 * "Photos from the last 7 days" will not include photos with unknown dates.
 */
export function matchesFileFilter(
  item: FilterableItem,
  f: FileFilter,
  now: Date,
  cal: Calendar = DEFAULT_CALENDAR,
): boolean {
  if (!kindMatches(f.kind, item)) return false;
  if (f.size !== 'any') {
    const limit = (f.sizeMB ?? 0) * 1024 * 1024;
    if (f.size === 'larger' ? !(item.size > limit) : !(item.size < limit)) return false;
  }
  if (f.orientation !== 'any') {
    if (!item.width || !item.height) return false;
    if (orientationOf(item.width, item.height) !== f.orientation) return false;
  }
  if (f.date !== 'any') {
    const at = item.takenAt ?? item.modifiedAt;
    if (at === undefined) return false;
    const day = localDay(at);
    if (f.date === 'lastDays') {
      const days = f.days ?? 1;
      const start = localDay(
        new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1)).getTime(),
      );
      if (day < start || day > localDay(now.getTime())) return false;
    } else if (f.date === 'period') {
      // A calendar time span based on "when a day or week begins" (D-286).
      const [start, end] = periodRange(f.period ?? 'today', now, cal);
      if (day < start || day > end) return false;
    } else if (day < (f.from ?? '') || day > (f.to ?? '9999-12-31')) return false;
  }
  if (f.duration !== 'any') {
    if (item.durationMs === undefined) return false;
    const limit = (f.seconds ?? 0) * 1000;
    if (f.duration === 'longer' ? !(item.durationMs > limit) : !(item.durationMs < limit))
      return false;
  }
  return true;
}

export function filterFiles<T extends FilterableItem>(
  items: readonly T[],
  f: FileFilter,
  now: Date,
  cal: Calendar = DEFAULT_CALENDAR,
) {
  return items.filter((item) => matchesFileFilter(item, f, now, cal));
}
