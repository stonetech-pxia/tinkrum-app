import { COMPONENTS, RECORD_LOOKS } from './components';
import { FIELDS } from './fields';
import type { Registry } from './registry';
import { ICON_NAMES } from './schema-base';

// 导出的文件「用到了什么」（D-556）：App 文件和 App 配置文件在外层（format、version 旁边，不在配置里面）带一份清单，
// 导出时从内容算出来，从不存进本机的配置（不改配置格式，不升版本号）。读文件的版本拿它和自己认识的比，
// 缺什么就准确地说出来，而不是笼统地「用不了」。没有这一份的文件（旧版本导出的）和以前一样。
// 外观、字段类型、动作、图标从登记表来，以后加的自动算进去；v39 以后在已有的键上加的键或取值一样一样写在
// USES_FEATURES 里（以后再加这样的东西，要在这里加一项）。

export interface FileUses {
  looks?: string[];
  fieldTypes?: string[];
  actions?: string[];
  icons?: string[];
  features?: string[];
}

/** v39 以后加的、更早的版本会拒绝的键和取值（不是新外观、新字段类型、新动作、新图标的那些）。 */
export const USES_FEATURES = [
  /** 筛选条件 is 的值是几个选项（D-538）。 */
  'filterAnyOf',
  /** 时间段 next7days / next30days / next90days（D-537）。 */
  'periodNextDays',
  /** 表格样子的 show.columns（D-539）。 */
  'showColumns',
  /** 记录块的 show.highlight（D-541）。 */
  'showHighlight',
  /** 日历以外的记录块上的 show.color（D-541）。 */
  'showColorAnyLook',
  /** 提醒属于一个 App（D-485 补充）。 */
  'reminderInApp',
  /** 手机桌面菜单里放 App（app:<id>，D-485 补充）。 */
  'appOnPhoneHomeScreen',
  /** single 块的 source.record "$record"：给一条记录用的页面上显示打开的那一条（D-558）。 */
  'singleOpenedRecord',
  /** 时间段 yesterday / lastWeek / lastMonth / lastYear / tomorrow / nextWeek / nextMonth（D-559）。 */
  'periodNeighbours',
  /** 记录块的 source.sort 是几个字段的列表（D-560）。 */
  'sortMany',
  /** 记录块的 source.period "page"：跟着页面上的时间范围（D-561）。 */
  'recordsFollowPagePeriod',
] as const;

const NEXT_DAYS = new Set(['next7days', 'next30days', 'next90days']);
const NEIGHBOURS = new Set([
  'yesterday',
  'lastWeek',
  'lastMonth',
  'lastYear',
  'tomorrow',
  'nextWeek',
  'nextMonth',
]);
const RECORD_LOOK_SET = new Set<string>(RECORD_LOOKS);
const ICON_NAME = /^[a-z][a-z0-9-]*$/;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** 算一份内容（整份配置，或 App 文件去掉外层的部分）用到了什么；排好序、不重复，空的不写。 */
export function usesOf(content: unknown): FileUses {
  const found = {
    looks: new Set<string>(),
    fieldTypes: new Set<string>(),
    actions: new Set<string>(),
    icons: new Set<string>(),
    features: new Set<string>(),
  };
  const walk = (node: unknown, key: string | null) => {
    if (Array.isArray(node)) {
      for (const item of node) {
        if (key === 'fields' && isObject(item) && typeof item.type === 'string')
          found.fieldTypes.add(item.type);
        if (key === 'phoneHomeScreen' && typeof item === 'string' && item.startsWith('app:'))
          found.features.add('appOnPhoneHomeScreen');
        walk(item, key);
      }
      return;
    }
    if (!isObject(node)) return;
    // 块：有 id 和 look 的（页面、分组里的，包括这个版本不认识的外观）。
    if (typeof node.look === 'string' && typeof node.id === 'string') {
      found.looks.add(node.look);
      const show = node.show;
      if (isObject(show)) {
        // period 块的选项和默认（D-559）。
        if (
          node.look === 'period' &&
          [show.options, show.default]
            .flat()
            .some((p) => typeof p === 'string' && NEIGHBOURS.has(p))
        )
          found.features.add('periodNeighbours');
        if (show.columns !== undefined) found.features.add('showColumns');
        if (show.highlight !== undefined) found.features.add('showHighlight');
        if (show.color !== undefined && RECORD_LOOK_SET.has(node.look) && node.look !== 'calendar')
          found.features.add('showColorAnyLook');
      }
      const source = node.source;
      if (isObject(source)) {
        if (node.look === 'single' && source.record !== undefined)
          found.features.add('singleOpenedRecord');
        if (Array.isArray(source.sort)) found.features.add('sortMany');
        if (RECORD_LOOK_SET.has(node.look) && source.period !== undefined)
          found.features.add('recordsFollowPagePeriod');
      }
    }
    // 快捷操作的步骤、工具栏上的动作。
    if (typeof node.action === 'string') found.actions.add(node.action);
    // 筛选条件（块、汇总、提醒、快捷操作里的都是这个形状）。
    if (typeof node.field === 'string' && typeof node.op === 'string') {
      if (Array.isArray(node.value)) found.features.add('filterAnyOf');
      if (node.op === 'inPeriod' && typeof node.value === 'string' && NEXT_DAYS.has(node.value))
        found.features.add('periodNextDays');
      if (node.op === 'inPeriod' && typeof node.value === 'string' && NEIGHBOURS.has(node.value))
        found.features.add('periodNeighbours');
    }
    if (typeof node.period === 'string' && NEXT_DAYS.has(node.period))
      found.features.add('periodNextDays');
    if (typeof node.period === 'string' && NEIGHBOURS.has(node.period))
      found.features.add('periodNeighbours');
    if (node.kind === 'reminder' && node.app !== undefined) found.features.add('reminderInApp');
    for (const [k, v] of Object.entries(node)) {
      // 图标：白名单里的名字（emoji 不算，哪个版本都认）。
      if (k === 'icon' && typeof v === 'string' && ICON_NAME.test(v)) found.icons.add(v);
      walk(v, k);
    }
  };
  walk(content, null);
  const out: FileUses = {};
  for (const [k, set] of Object.entries(found))
    if (set.size > 0) out[k as keyof FileUses] = [...set].sort();
  return out;
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/**
 * 文件外层的清单里这个版本没有的（按外观、字段类型、动作、图标、其他的顺序）。没有清单、清单不对、
 * 文件读不了的都返回空：那样的文件照以前的路走。
 */
export function missingUses(text: string, registry: Registry): string[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  if (!isObject(data) || !isObject(data.uses)) return [];
  const uses = data.uses;
  const looks = new Set<string>(COMPONENTS.map((c) => c.look));
  const types = new Set<string>(FIELDS.map((f) => f.type));
  const icons = new Set<string>(ICON_NAMES);
  const features = new Set<string>(USES_FEATURES);
  return [
    ...strings(uses.looks).filter((x) => !looks.has(x)),
    ...strings(uses.fieldTypes).filter((x) => !types.has(x)),
    ...strings(uses.actions).filter((x) => !registry.actions.has(x)),
    ...strings(uses.icons).filter((x) => !icons.has(x)),
    ...strings(uses.features).filter((x) => !features.has(x)),
  ];
}
