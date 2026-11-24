import type { NumberSource } from './components/number';
import { formatNumber } from './field-values';
import { parseFormula, type FormulaNode } from './formula';
import { t, type StringKey } from './messages';
import type { Locale, WorkspaceConfig } from './schema';

const TOTAL_LABELS = {
  count: 'calcCount',
  sum: 'calcSum',
  avg: 'calcAvg',
  min: 'calcMin',
  max: 'calcMax',
  latest: 'calcLatest',
  distinctDays: 'calcDistinctDays',
} as const;
const FUNCTIONS = {
  min: 'calcFnMin',
  max: 'calcFnMax',
  round: 'calcFnRound',
  abs: 'calcFnAbs',
} as const;

/** Formula draft descriptions read structure only, replacing internal references with table names, field names, and aggregate labels without reading any records. */
export function totalFormulaText(
  source: NumberSource,
  config: WorkspaceConfig,
  locale: Locale,
): string | undefined {
  const calc = source.calc;
  if (!calc) return undefined;
  const parsed = parseFormula(calc.formula);
  if (!parsed.ok) return undefined;
  const label = (total: Pick<NumberSource, 'table' | 'aggregate' | 'field'>) => {
    const table = config.data.tables.find((t) => t.id === total.table);
    const key = TOTAL_LABELS[total.aggregate as keyof typeof TOTAL_LABELS];
    return key
      ? t(locale, key, {
          table: table?.name ?? total.table,
          field: table?.fields.find((f) => f.id === total.field)?.name ?? total.field ?? '',
        })
      : '';
  };
  const names = new Map([
    ['total', label(source)],
    ...calc.with.map((total) => [total.id, label(total)] as [string, string]),
  ]);
  const expression = (node: FormulaNode): string => {
    switch (node.kind) {
      case 'ref':
        return names.get(node.field) ?? node.field;
      case 'num':
        return formatNumber(node.value, undefined, locale);
      case 'neg':
        return `−${expression(node.arg)}`;
      case 'op':
        return `(${expression(node.left)} ${{ '+': '+', '-': '−', '*': '×', '/': '÷' }[node.op]} ${expression(node.right)})`;
      case 'if':
        return t(locale, 'calcIf', {
          left: expression(node.left),
          right: expression(node.right),
          comparison: node.cmp,
          yes: expression(node.then),
          no: expression(node.otherwise),
        });
      case 'fn': {
        const key = FUNCTIONS[node.fn as keyof typeof FUNCTIONS];
        return key
          ? `${t(locale, key as StringKey)}(${node.args.map(expression).join(t(locale, 'separatorList'))})`
          : '—';
      }
      default:
        return '—';
    }
  };
  const text = expression(parsed.node);
  return calc.as === 'percent' ? t(locale, 'calcAsPercent', { formula: text }) : text;
}
