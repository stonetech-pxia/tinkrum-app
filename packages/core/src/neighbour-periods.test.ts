import { describe, expect, it } from 'vitest';

import { DEFAULT_CALENDAR, type Calendar } from './calendar';
import { previousLabel, previousPeriodRange } from './compare';
import { conditionProblems } from './conditions';
import { periodRange } from './data';
import { usesOf } from './file-uses';
import { t } from './messages';
import { choiceRange, previousFullRange, previousToDateRange } from './page-period';
import { PAGE_PERIODS, PERIODS, type Collection, type Locale, type Period } from './schema';
import { registry } from './test-helpers';

// 日历上前后的时间段（D-559）：昨天、上周、上月、去年、明天、下周、下月。和已有的一样按「设置 → 日期」（D-286）算。

const NEIGHBOURS = [
  'yesterday',
  'lastWeek',
  'lastMonth',
  'lastYear',
  'tomorrow',
  'nextWeek',
  'nextMonth',
] as const;

// 2026-11-04 是星期三；默认一周从周一开始、一天从 0 点开始。
const now = new Date(2026, 10, 4, 12);
const range = (p: string, at = now, cal: Calendar = DEFAULT_CALENDAR) =>
  periodRange(p as Period, at, cal);

describe('periods before and after the current one (D-559)', () => {
  it('are periods everywhere a period is accepted', () => {
    expect(PERIODS).toEqual(expect.arrayContaining([...NEIGHBOURS]));
    const table: Collection = {
      id: 'bills',
      name: 'Bills',
      fields: [{ id: 'due', name: 'Due', type: 'date' }],
    };
    for (const value of NEIGHBOURS)
      expect(conditionProblems([{ field: 'due', op: 'inPeriod', value }], table)).toEqual([]);
  });

  it('cover whole calendar days, weeks, months and years', () => {
    expect(range('yesterday')).toEqual(['2026-11-03', '2026-11-03']);
    expect(range('tomorrow')).toEqual(['2026-11-05', '2026-11-05']);
    expect(range('lastWeek')).toEqual(['2026-10-26', '2026-11-01']);
    expect(range('nextWeek')).toEqual(['2026-11-09', '2026-11-15']);
    expect(range('lastMonth')).toEqual(['2026-10-01', '2026-10-31']);
    expect(range('nextMonth')).toEqual(['2026-12-01', '2026-12-31']);
    expect(range('lastYear')).toEqual(['2025-01-01', '2025-12-31']);
  });

  it('cross the year and follow the shorter months', () => {
    const jan = new Date(2026, 0, 31, 12);
    expect(range('lastMonth', jan)).toEqual(['2025-12-01', '2025-12-31']);
    expect(range('nextMonth', jan)).toEqual(['2026-02-01', '2026-02-28']);
    const dec = new Date(2026, 11, 31, 12);
    expect(range('nextMonth', dec)).toEqual(['2027-01-01', '2027-01-31']);
    expect(range('tomorrow', dec)).toEqual(['2027-01-01', '2027-01-01']);
    expect(range('yesterday', new Date(2027, 0, 1, 12))).toEqual(['2026-12-31', '2026-12-31']);
  });

  it('follow when a week and a day start (D-286)', () => {
    const sunday: Calendar = { ...DEFAULT_CALENDAR, weekStart: 'sunday' };
    expect(range('lastWeek', now, sunday)).toEqual(['2026-10-25', '2026-10-31']);
    expect(range('nextWeek', now, sunday)).toEqual(['2026-11-08', '2026-11-14']);
    // 一天从 2 点开始：11 月 1 日 1:30 还算 10 月 31 日，所以「上个月」是 9 月。
    const twoAm: Calendar = { ...DEFAULT_CALENDAR, dayStartHour: 2 };
    expect(range('lastMonth', new Date(2026, 10, 1, 1, 30), twoAm)).toEqual([
      '2026-09-01',
      '2026-09-30',
    ]);
    expect(range('yesterday', new Date(2026, 10, 4, 1, 30), twoAm)).toEqual([
      '2026-11-02',
      '2026-11-02',
    ]);
  });

  it('compare with the whole period before (a past period is already complete)', () => {
    const prev = (p: string) => previousPeriodRange(p as Period, now, DEFAULT_CALENDAR);
    expect(prev('yesterday')).toEqual(['2026-11-02', '2026-11-02']);
    expect(prev('lastWeek')).toEqual(['2026-10-19', '2026-10-25']);
    expect(prev('lastMonth')).toEqual(['2026-09-01', '2026-09-30']);
    expect(prev('lastYear')).toEqual(['2024-01-01', '2024-12-31']);
    expect(prev('tomorrow')).toEqual(['2026-11-04', '2026-11-04']);
    expect(prev('nextWeek')).toEqual(['2026-11-02', '2026-11-08']);
    expect(prev('nextMonth')).toEqual(['2026-11-01', '2026-11-30']);
    // 31 天的月份前面是 30 天的月份，不是往前数 31 天。
    expect(
      previousPeriodRange('lastMonth' as Period, new Date(2026, 7, 10), DEFAULT_CALENDAR),
    ).toEqual(['2026-06-01', '2026-06-30']);
  });

  it.each(['en', 'zh', 'fr'] as Locale[])('say what they are compared with in %s', (locale) => {
    for (const p of NEIGHBOURS) {
      const text = previousLabel(p as Period, '12', locale);
      expect(text).toContain('12');
      expect(text).not.toMatch(/compare_/);
    }
  });

  it('can be read by a quick action (in.records) with a name in every language', () => {
    const action = registry.actions.get('in.records')!;
    for (const value of NEIGHBOURS)
      expect(action.params.safeParse({ collectionId: 't', period: value }).success).toBe(true);
    const field = action.fields.find((f) => f.key === 'period') as unknown as {
      options: { value: string; label: Record<Locale, string> }[];
    };
    for (const value of NEIGHBOURS) {
      const option = field.options.find((o) => o.value === value);
      expect(option?.label.en && option.label.zh && option.label.fr).toBeTruthy();
    }
  });

  it('a file lists them as a feature', () => {
    expect(
      usesOf({ filter: [{ field: 'due', op: 'inPeriod', value: 'lastMonth' }] }).features,
    ).toEqual(['periodNeighbours']);
    expect(
      usesOf({ step: { action: 'in.records', params: { period: 'yesterday' } } }).features,
    ).toEqual(['periodNeighbours']);
    expect(
      usesOf({ id: 'r', look: 'period', show: { options: ['thisMonth', 'lastMonth'] } }).features,
    ).toEqual(['periodNeighbours']);
    expect(
      usesOf({ filter: [{ field: 'due', op: 'inPeriod', value: 'thisMonth' }] }).features,
    ).toBeUndefined();
  });
});

describe('the past ones on a page period block (D-559)', () => {
  const past = ['yesterday', 'lastWeek', 'lastMonth', 'lastYear'] as const;

  it('are choices of the period block, the future ones are not', () => {
    expect(PAGE_PERIODS).toEqual(expect.arrayContaining([...past]));
    expect(PAGE_PERIODS).not.toContain('tomorrow');
    for (const p of past) expect(t('fr', `periodOpt_${p}`)).not.toMatch(/periodOpt/);
  });

  it('charts compare with the whole period before, numbers too', () => {
    const full = (p: string) => previousFullRange({ period: p as (typeof past)[number] }, now);
    expect(full('lastMonth')).toEqual({ start: '2026-09-01', end: '2026-09-30' });
    expect(full('lastYear')).toEqual({ start: '2024-01-01', end: '2024-12-31' });
    expect(full('lastWeek')).toEqual({ start: '2026-10-19', end: '2026-10-25' });
    expect(full('yesterday')).toEqual({ start: '2026-11-02', end: '2026-11-02' });
    expect(previousToDateRange({ period: 'lastMonth' }, now)).toEqual({
      start: '2026-09-01',
      end: '2026-09-30',
    });
    expect(choiceRange({ period: 'lastMonth' }, now)).toEqual({
      start: '2026-10-01',
      end: '2026-10-31',
    });
  });
});
