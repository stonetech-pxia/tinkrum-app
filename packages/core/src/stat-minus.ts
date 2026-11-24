import { DEFAULT_CALENDAR, type Calendar } from './calendar';
import { NUMERIC_FIELD_TYPES } from './components/define';
import { conditionProblems } from './conditions';
import { aggregateRecords, filterRecords, type DataRecord } from './data';
import { round } from './field-values';
import { hasRecordCurrency } from './money-currency';
import { expandCollection } from './related';
import type { Collection, ComponentOf, WorkspaceConfig } from './schema';

// Stat subtraction (D-337): "this total − another total", where the other can be in another table.
// For example, to-be-allocated = income − allocated funds, balance = income − expenses, net worth =
// assets − liabilities. Only counts and sums apply; subtraction for averages, minimums, and
// maximums is meaningless. The check is placed here instead of the number block definition: checks
// using filter conditions (conditions.ts) would cause circular loading if referenced by component
// definitions.

type NumberBlock = ComponentOf<'number'>;
export type StatMinus = NonNullable<NumberBlock['source']['minus']>;

/** Issues for number block source.minus (text sent to AI). collection is the number block's own table (after lookup/rollup replacement). */
export function statMinusProblems(
  c: NumberBlock,
  collection: Collection,
  config: WorkspaceConfig,
  /** Which table record the block's page is used for (D-342, page.of). */
  recordOf?: string,
): string[] {
  const { minus, aggregate, field, group, compare } = c.source;
  if (!minus) return [];
  const problems: string[] = [];
  if (aggregate !== 'count' && aggregate !== 'sum')
    problems.push(`source.minus only works with aggregate count or sum, not ${aggregate}`);
  if (group)
    problems.push(
      "source.minus can't be used with source.group: there is one total to subtract from",
    );
  if (compare) problems.push("source.minus can't be used with compare");
  const table = config.data.tables.find((x) => x.id === minus.table);
  if (!table) return [...problems, `minus: data table ${minus.table} does not exist`];
  const other = expandCollection(config.data.tables, table);
  if (minus.aggregate === 'sum') {
    const f = minus.field ? other.fields.find((x) => x.id === minus.field) : undefined;
    if (!f || !NUMERIC_FIELD_TYPES.includes(f.type)) {
      problems.push(
        `minus: sum needs field set to a number, money, rating, duration or formula field of ${other.id}`,
      );
    } else {
      if (hasRecordCurrency(f))
        problems.push(`minus: ${other.id}.${f.id} has its own currency on each entry`);
      const own = field ? collection.fields.find((x) => x.id === field) : undefined;
      if (own?.type === 'money' && f.type === 'money' && own.currency !== f.currency)
        problems.push(
          `minus: ${other.id}.${f.id} is in ${f.currency} but ${collection.id}.${own.id} is in ${own.currency}`,
        );
    }
  }
  problems.push(...conditionProblems(minus.filter, other, recordOf).map((p) => `minus: ${p}`));
  return problems;
}

/** Value after subtracting minus. Remains empty when value is empty (nothing to calculate); records are computed records of the minus table. */
export function minusValue(
  value: number | null,
  minus: StatMinus,
  collection: Collection,
  records: readonly DataRecord[],
  now: Date,
  cal: Calendar = DEFAULT_CALENDAR,
): number | null {
  if (value === null) return null;
  const matched = filterRecords(records, collection, minus.filter, now, cal);
  const other = aggregateRecords(matched, collection, minus.aggregate, minus.field) ?? 0;
  return round(value - other, 4);
}
