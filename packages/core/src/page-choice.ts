import type { Collection, Condition } from './schema';

// 页面上的一排选项（D-573，创始人 2026-11-16 决定 ② 第二步「按一个单选字段选」）：页面上放一个 choices 块，
// 列出一张表一个单选字段的选项（加「全部」）；同一页里读这张表、source.choice 是 "page" 的记录块、数字和图表
// 只显示这个字段是选中那一项的记录。选了什么只在页面画着的时候有，什么都不写（底线 15）；选项 ID 是配置不是内容。
// 这里是纯逻辑：显示哪些选项、现在选的是哪个、跟着它的块多一个什么条件。

/** choices 块里和逻辑有关的部分（schema 在 components/choices.ts）。 */
export interface ChoiceRow {
  show: {
    options?: readonly string[] | undefined;
    all?: false | undefined;
    default?: string | undefined;
  };
  source: { table: string; field: string };
}

/** 页面上现在选的：哪张表的哪个字段，选的选项（null = 全部）。 */
export interface PageChoiceState {
  table: string;
  field: string;
  option: string | null;
}

/** 这一排显示的选项：写了 show.options 的按它的顺序（只留字段里还有的），没写是字段的全部选项。 */
export function choiceRowOptions(
  row: ChoiceRow,
  table: Collection | undefined,
): { id: string; label: string }[] {
  const field = table?.fields.find((f) => f.id === row.source.field);
  if (field?.type !== 'choice') return [];
  const ids = row.show.options;
  return ids ? ids.flatMap((id) => field.options.filter((o) => o.id === id)) : field.options;
}

/**
 * 现在选的选项：用户点过的（还在这一排里），不然是 show.default，再不然是「全部」（show.all 是 false 时是第一个选项）。
 * picked 是 undefined 表示用户还没点过，null 是点了「全部」。
 */
export function resolvePageChoice(
  row: ChoiceRow,
  table: Collection | undefined,
  picked: string | null | undefined,
): string | null {
  const shown = choiceRowOptions(row, table).map((o) => o.id);
  const all = row.show.all !== false;
  if (picked === null && all) return null;
  if (typeof picked === 'string' && shown.includes(picked)) return picked;
  if (row.show.default !== undefined && shown.includes(row.show.default)) return row.show.default;
  return all ? null : (shown[0] ?? null);
}

/**
 * 跟着这一排的块用的筛选：自己的筛选再加「这个字段是选中的那一项」（放在最后，就地添加的 "$here" 按它预设）。
 * 不跟着、读的不是这张表、选的是「全部」时就是自己的筛选。
 */
export function followedFilter(
  source: { table: string; filter?: Condition[] | undefined; choice?: 'page' | undefined },
  picked: PageChoiceState | undefined,
): Condition[] | undefined {
  if (source.choice !== 'page' || !picked || picked.option === null) return source.filter;
  if (picked.table !== source.table) return source.filter;
  return [...(source.filter ?? []), { field: picked.field, op: 'is', value: picked.option }];
}
