import { z } from 'zod';

import { localDate } from './data';
import type { ParamField } from './workflow/contract';

// Produce individual files per group (D-243): operations like convert images to PDF, merge PDFs, or
// archive to ZIP can group files according to rules, producing one output file per group. Rules are
// limited to a fixed set of options (every N items, same day, same month) without loops or
// expressions: it remains a step-by-step action sequence, simply yielding multiple output files for
// that step.

export const GROUP_RULES = ['none', 'count', 'day', 'month'] as const;
export type GroupRule = (typeof GROUP_RULES)[number];

export const MAX_GROUP_SIZE = 50;

/** Two keys added to action parameters (absent in older configurations, treated as ungrouped). */
export const groupParams = {
  group: z.enum(GROUP_RULES).optional(),
  groupSize: z.number().int().min(1).max(MAX_GROUP_SIZE).optional(),
};

export const groupNeedsSize = (p: {
  group?: GroupRule | undefined;
  groupSize?: number | undefined;
}) => p.group !== 'count' || p.groupSize !== undefined;

export const GROUP_FIELDS: readonly ParamField[] = [
  {
    key: 'group',
    label: { en: 'Split into', zh: '分成几份', fr: 'Répartir' },
    kind: 'choice',
    options: [
      { value: 'none', label: { en: 'One file', zh: '一份', fr: 'Un seul fichier' } },
      {
        value: 'count',
        label: { en: 'Every N files', zh: '每 N 个一份', fr: 'Tous les N fichiers' },
      },
      {
        value: 'day',
        label: { en: 'One per day taken', zh: '按拍摄日期，每天一份', fr: 'Un par jour' },
      },
      { value: 'month', label: { en: 'One per month', zh: '每个月一份', fr: 'Un par mois' } },
    ],
  },
  {
    key: 'groupSize',
    label: { en: 'Files per group', zh: '每份几个', fr: 'Fichiers par groupe' },
    kind: 'number',
    min: 1,
    max: MAX_GROUP_SIZE,
    step: 1,
    showIf: { key: 'group', equals: ['count'] },
  },
];

export interface GroupableItem {
  name: string;
  takenAt?: number;
  modifiedAt?: number;
}

export interface FileGroup<T> {
  /** Name of the output file (excluding extension): date when grouped by date, or the name of the first file otherwise. */
  name: string;
  items: T[];
}

/**
 * Group items according to rules. count: groups every N items in their original order. day /
 * month: groups by local date based on capture time (falling back to modification time if
 * absent), ordered chronologically by group date while preserving original item order within each
 * group; items with unparseable dates are placed in a final group named "undated".
 */
export function groupItems<T extends GroupableItem>(
  items: readonly T[],
  rule: GroupRule | undefined,
  size: number | undefined,
  undated: string,
): FileGroup<T>[] {
  if (items.length === 0) return [];
  if (!rule || rule === 'none') return [{ name: items[0]!.name, items: [...items] }];
  if (rule === 'count') {
    const n = Math.max(1, size ?? 1);
    const groups: FileGroup<T>[] = [];
    for (let i = 0; i < items.length; i += n) {
      const chunk = items.slice(i, i + n);
      groups.push({ name: chunk[0]!.name, items: chunk });
    }
    return groups;
  }
  const byKey = new Map<string, T[]>();
  const noDate: T[] = [];
  for (const item of items) {
    const at = item.takenAt ?? item.modifiedAt;
    if (at === undefined) {
      noDate.push(item);
      continue;
    }
    const day = localDate(new Date(at));
    const key = rule === 'day' ? day : day.slice(0, 7);
    byKey.set(key, [...(byKey.get(key) ?? []), item]);
  }
  const groups = [...byKey.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, list]) => ({ name, items: list }));
  if (noDate.length) groups.push({ name: undated, items: noDate });
  return groups;
}
