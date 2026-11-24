import { type Calendar } from './calendar';
import { NUMERIC_FIELD_TYPES } from './components/define';
import type { NumberSource } from './components/number';
import { conditionProblems } from './conditions';
import { aggregateRecords, filterRecords } from './data';
import { formatNumber, round } from './field-values';
import { t } from './messages';
import { evaluateFormula, formulaType, parseFormula, type FormulaNode } from './formula';
import { hasRecordCurrency } from './money-currency';
import { recordsInRange, type DayRange } from './page-period';
import { expandCollection, latestDate, latestValue } from './related';
import type { Collection, ComponentOf, WorkspaceConfig, Locale } from './schema';
import { dateFieldOf, isSequenceAggregate, sequenceValue } from './sequence';
import type { TableRead } from './source';

export type TotalSource = Pick<NumberSource, 'table' | 'aggregate' | 'field' | 'filter' | 'days'>;

/** Read-only: primary totals and other totals share filters, time ranges, and aggregates. */
export function numberTotal(
  source: TotalSource,
  read: TableRead,
  now: Date,
  cal: Calendar,
  range?: DayRange,
) {
  const filter = range ? source.filter?.filter((c) => c.op !== 'inPeriod') : source.filter;
  const based = filterRecords(read.records, read.view, filter, now, cal);
  const date =
    source.filter?.find((c) => c.op === 'inPeriod')?.field ??
    dateFieldOf(read.table, source.days?.date);
  const records = range ? recordsInRange(based, read.view, date, range, now, cal) : based;
  if (isSequenceAggregate(source.aggregate))
    return sequenceValue(records, read.view, source.aggregate, source.days, now, cal);
  if (source.aggregate === 'latest')
    return { value: latestNumber(records, read.table, read.view, source, now, cal) };
  return { value: aggregateRecords(records, read.view, source.aggregate, source.field) };
}

export function latestNumber(
  records: TableRead['records'],
  table: Collection,
  view: Collection,
  source: Pick<NumberSource, 'field' | 'days'>,
  now: Date,
  cal: Calendar,
): number | null {
  if (!source.field) return null;
  const value = latestValue(
    records,
    view,
    source.field,
    latestDate(table, source.days?.date),
    now,
    cal,
  );
  return typeof value === 'number' ? value : null;
}

/** Pages and desktop widgets use identical calculations; page options apply solely to the primary total's filter, while other totals do not follow. */
export function calculatedNumber(
  source: NumberSource,
  own: TableRead,
  other: (id: string) => TableRead | undefined,
  now: Date,
  cal: Calendar,
  range?: DayRange,
): { value: number | null; best?: number } {
  const main = numberTotal(source, own, now, cal, range);
  if (source.minus) {
    const read = other(source.minus.table);
    return {
      value:
        main.value === null || !read
          ? null
          : round(main.value - (numberTotal(source.minus, read, now, cal, range).value ?? 0), 4),
    };
  }
  if (!source.calc) return main;
  const parsed = parseFormula(source.calc.formula);
  if (!parsed.ok) return { value: null };
  const totals = new Map<string, number | null>([['total', main.value]]);
  for (const total of source.calc.with) {
    const read = other(total.table);
    totals.set(total.id, read ? numberTotal(total, read, now, cal, range).value : null);
  }
  // Empty operands are not silently ignored by unexecuted branches of if statements.
  if ([...totals.values()].some((v) => v === null)) return { value: null };
  return { value: evaluateFormula(parsed.node, (id) => totals.get(id) ?? undefined) ?? null };
}

/** Placed outside component definitions to avoid circular dependencies among conditions → schema → components. */
export function statCalcProblems(
  block: ComponentOf<'number'>,
  collection: Collection,
  config: WorkspaceConfig,
  recordOf?: string,
): string[] {
  const source = block.source,
    calc = source.calc;
  if (!calc) return [];
  const problems: string[] = [];
  if (source.minus || source.group || source.compare)
    problems.push('source.calc cannot combine with minus, group or compare');
  if (['streak', 'daysSince', 'avgInterval'].includes(source.aggregate))
    problems.push('source.calc needs numeric totals, not sequence aggregates');
  const ids = calc.with.map((t) => t.id);
  if (ids.includes('total') || new Set(ids).size !== ids.length)
    problems.push('calc.with ids must be unique; total is reserved');
  const parsed = parseFormula(calc.formula);
  if (!parsed.ok) problems.push(`calc.formula: ${parsed.error}`);
  else {
    const names = new Set(['total', ...ids]);
    if (parsed.refs.some((id) => !names.has(id)))
      problems.push('calc.formula references an unknown total');
    if (ids.some((id) => !parsed.refs.includes(id)))
      problems.push('calc.formula must use every with total');
    if (hasTimeNode(parsed.node))
      problems.push('calc.formula only accepts numbers and numeric functions');
    if (formulaType(parsed.node, () => 'number') !== 'number')
      problems.push('calc.formula must produce a number');
  }
  const currencies = new Set<string>();
  for (const total of [source, ...calc.with]) {
    const stored = config.data.tables.find((t) => t.id === total.table);
    if (!stored) {
      problems.push(`calc: table ${total.table} does not exist`);
      continue;
    }
    const table = total === source ? collection : expandCollection(config.data.tables, stored);
    const field = table.fields.find((f) => f.id === total.field);
    if (total.field && !field)
      problems.push(`calc: field ${total.field} does not exist in ${table.id}`);
    if (
      !['count', 'distinctDays'].includes(total.aggregate) &&
      (!field || !NUMERIC_FIELD_TYPES.includes(field.type))
    )
      problems.push(`calc: ${total.aggregate} needs a numeric field of ${table.id}`);
    if (hasRecordCurrency(field))
      problems.push('calc: a field with its own currency per entry cannot be used');
    if (field?.type === 'money') currencies.add(field.currency ?? '');
    const date = total.days?.date;
    if (
      date &&
      date !== 'createdAt' &&
      date !== 'updatedAt' &&
      !table.fields.some((f) => f.id === date && (f.type === 'date' || f.type === 'datetime'))
    )
      problems.push(`calc: ${date} must be a date field of ${table.id}`);
    if (total !== source)
      problems.push(...conditionProblems(total.filter, table, recordOf).map((p) => `calc: ${p}`));
  }
  if (currencies.size > 1) problems.push('calc: money totals must share one currency');
  return problems;
}

/** When no dedicated display option exists, formatted by the caller according to the primary field's format. */
export function calculatedText(
  value: number | null,
  calc: NumberSource['calc'],
  locale: Locale,
): string | undefined {
  if (!calc?.as) return undefined;
  if (value === null) return '—';
  // Floating-point inaccuracies (0.29 * 100 = 28.999999999999996) must not be displayed as 29.0000; displays up to four decimal places, rounding to six places first.
  const shown = (n: number) => Math.round(n * 1e6) / 1e6;
  return calc.as === 'percent'
    ? t(locale, 'statPercent', { value: formatNumber(shown(value * 100), undefined, locale) })
    : formatNumber(shown(value), undefined, locale);
}

function hasTimeNode(node: FormulaNode): boolean {
  switch (node.kind) {
    case 'today':
    case 'days':
      return true;
    case 'fn':
      return node.fn === 'hours' || node.fn === 'minutes' || node.args.some(hasTimeNode);
    case 'op':
      return hasTimeNode(node.left) || hasTimeNode(node.right);
    case 'neg':
      return hasTimeNode(node.arg);
    case 'if':
      return [node.left, node.right, node.then, node.otherwise].some(hasTimeNode);
    default:
      return false;
  }
}
