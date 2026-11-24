import { z } from 'zod';

// Basic config primitives (languages, IDs, length-constrained text). Field definitions (`fields/`)
// depend only on this, allowing `schema-base.ts` to generate field structures from field
// definitions without circular references. Exported externally from `schema.ts`.

export type Locale = 'en' | 'zh' | 'fr';
export type Localized = Record<Locale, string>;

export const ID_PATTERN = /^[a-z][a-z0-9-]{0,47}$/;
/**
 * "This record" (D-342): Can only be used on pages dedicated to a single record of a table
 * (`page.recordOf`), referenced via `is` / `isNot` in relation field filters, or set as the
 * relation field value upon creation; replaced with the record's ID when opening the page
 * (`bindRecord` in `record-pages.ts`).
 */
export const RECORD_REF = '$record';
/**
 * The row targeted by a tool (v34): this row in a list, this block in a large circle block, the
 * record mentioned in a notification. Written as "row" in v33 (only on relation fields). `$group`
 * is the value of the column/segment dragged to, and `$here` is "the value of this segment +
 * equality conditions in list filters" when adding inline.
 */
export const ROW_REF = '$row';
export const GROUP_REF = '$group';
export const HERE_REF = '$here';

export const ID_MESSAGE = 'id must be lowercase letters, digits or -';
export const IdSchema = z.string().regex(ID_PATTERN, ID_MESSAGE);

/** Text trimmed of leading and trailing whitespace with length between `min` and `max`. */
export const boundedText = (min: number, max: number) => z.string().trim().min(min).max(max);

// The following definitions are placed here because field definitions (such as rollup field filters and time periods, D-288) also require them.

/** System fields present on every record. */
export const SYSTEM_FIELDS = ['createdAt', 'updatedAt'] as const;
export type SystemField = (typeof SYSTEM_FIELDS)[number];
export const FieldRefSchema = z.union([IdSchema, z.enum(SYSTEM_FIELDS)]);

/**
 * The offset value (negative for backward) when adding days or months to a date: a fixed integer
 * or a numeric field of this record. Shared by computed date fields (D-542) and dates written by
 * one-tap record tools (D-565).
 */
export const OffsetAddSchema = z.union([z.number().int().min(-36_500).max(36_500), IdSchema]);
export const OffsetUnitSchema = z.enum(['days', 'months']);
export type OffsetUnit = z.infer<typeof OffsetUnitSchema>;

/**
 * Time periods (shared by filters, `in.records`, and `file.filter`). Recent days have a few fixed
 * tiers (D-285); `thisTwoWeeks` spans 14-day intervals starting from the anchor date in "Settings
 * -> Date", and `thisHalfMonth` is days 1-15 or day 16 to the end of the month. Calculated based
 * on "today"; see `calendar.ts` for when today starts. Future days (D-537): today through today +
 * N - 1, including today just like recent N days (for contracts or documents about to expire).
 */
export const PERIODS = [
  'today',
  'thisWeek',
  'thisMonth',
  'thisYear',
  'last7days',
  'last30days',
  'last14days',
  'last90days',
  'last365days',
  'thisTwoWeeks',
  'thisHalfMonth',
  'next7days',
  'next30days',
  'next90days',
  // 'yesterday',
  'yesterday',
  'lastWeek',
  'lastMonth',
  'lastYear',
  'tomorrow',
  'nextWeek',
  'nextMonth',
] as const;
export type Period = (typeof PERIODS)[number];

/** Options that can be placed into a period block (all fixed calendar time periods calculated based on "today"). */
export const PAGE_PERIODS = [
  'today',
  'thisWeek',
  'thisMonth',
  'thisYear',
  'last7days',
  'last30days',
  'last90days',
  'last365days',
  // A fully elapsed time period (D-559). Future periods are excluded: ranges on pages view already recorded entries.
  'yesterday',
  'lastWeek',
  'lastMonth',
  'lastYear',
] as const;
export type PagePeriod = (typeof PAGE_PERIODS)[number];

/** Sequential aggregates (D-284, algorithm in `sequence.ts`): usable by all numeric blocks, whereas charts only support `distinctDays`. */
export const SEQUENCE_AGGREGATES = ['streak', 'daysSince', 'avgInterval', 'distinctDays'] as const;
export type SequenceAggregate = (typeof SEQUENCE_AGGREGATES)[number];
export const STREAK_UNITS = ['day', 'week', 'month'] as const;
export type StreakUnit = (typeof STREAK_UNITS)[number];

/** Filter condition: whitelist comparison, multiple conditions are combined with logical AND, no expressions. */
export const ConditionSchema = z.strictObject({
  field: FieldRefSchema,
  op: z.enum(['is', 'isNot', 'contains', 'gt', 'lt', 'isEmpty', 'isNotEmpty', 'inPeriod', 'due']),
  // The `is` operator for single-select fields can take 2-8 options, matching any one of them (D-538). Limited to this level: no cross-field OR operations, no nesting.
  value: z
    .union([
      z.string().max(200),
      z.number().finite(),
      z.boolean(),
      z.array(z.string().max(200)).min(2).max(8),
    ])
    .optional(),
});
export type Condition = z.infer<typeof ConditionSchema>;

/** Filter: multiple conditions are combined with logical AND (≤5; rollup fields ≤6, v33 period migrated to a single `inPeriod`, M3). */
export const filterSchema = (max = 5) => z.array(ConditionSchema).max(max);
export type Filter = Condition[];

/**
 * Aggregates (a single list in v34): allowed types per location are determined by validation—all
 * for numeric blocks (`latest` since D-618), `count` / `sum` / `avg` / `distinctDays` for charts,
 * and all for rollup fields.
 */
export const AGGREGATES = [
  'count',
  'sum',
  'avg',
  'min',
  'max',
  'latest',
  ...SEQUENCE_AGGREGATES,
] as const;
export type AggregateKind = (typeof AGGREGATES)[number];

/**
 * Date-based parameters (previously written separately as `dateField` / `unit` / `perUnit` /
 * `skipField` / `skipOption` on stat and rollup in v33). If `date` is omitted = the first date
 * field in the table, falling back to the first datetime field, then creation time; `unit`,
 * `perUnit`, and `skip` apply only to streak.
 */
export const DaysSchema = z.strictObject({
  date: FieldRefSchema.optional(),
  unit: z.enum(STREAK_UNITS).optional(),
  perUnit: z.number().int().min(1).max(50).optional(),
  skip: z.strictObject({ field: IdSchema, option: IdSchema }).optional(),
});
export type Days = z.infer<typeof DaysSchema>;

/** Time units for grouping (list sections, charts, monthly calendars). */
export const GROUP_UNITS = ['day', 'week', 'month'] as const;
export type GroupUnit = (typeof GROUP_UNITS)[number];

/**
 * Grouping (a unified representation in v34; v33 had six variations: `stat.groupBy`,
 * `chart.group` + `choiceField` / `dateField` + `periods`, `recordList.groupField` +
 * `groupFilter`, `recordList.groupBy` + `groupUnit` + `showEmpty`, and `calendar` + `dateField`).
 * `by`: groups by each option of single-select or relation fields (each referenced item); dates
 * grouped by `unit`; schedules grouped by next occurrence. Omitting `by` and specifying only
 * `unit` defaults to the first date field. `last`: restricted to charts, recent N periods
 * (formerly `chart.periods`). `showEmpty`: also lists groups without records for single-select
 * and relations. `filter`: filters the referenced table first when grouping by relations to
 * determine which groups to include (formerly `groupFilter`).
 */
export const GroupingSchema = z.strictObject({
  until: IdSchema.optional(),
  by: FieldRefSchema.optional(),
  unit: z.enum(GROUP_UNITS).optional(),
  last: z.number().int().min(2).max(31).optional(),
  showEmpty: z.literal(true).optional(),
  filter: filterSchema().optional(),
});
export type Grouping = z.infer<typeof GroupingSchema>;
