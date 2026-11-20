import type { AppFile } from './app-file';
import { fieldDefinition } from './fields';
import type { Collection, Component, Page } from './schema';

// 设计建议（D-599）：别的 AI 写的 App 文件能导入以后，再说哪里用起来不顺手。只是建议，不挡导入。
// 每一条都是创始人 2026-11-20 在对话里逐条同意的；证据是 49 份 AI 写的文件对比 9 个预设：
// AI 常这样写、预设里一处也没有（预设一条也不能触发，测试保证）。设计上的取舍（标题块的副标题、
// 一点就记的按钮和完整表单并存、日历和列表同页）是风格，不在这里。

/** 页面开头放超过这么多字段的内嵌表单，页面一打开就是一张表。 */
const FORM_FIRST_MAX = 3;
/** 不管放在哪，内嵌表单超过这么多字段。 */
const FORM_MAX = 6;
/** 读一张表的这些块列出一条条记录，点一条能打开它。 */
const RECORD_LOOKS: ReadonlySet<unknown> = new Set([
  'list',
  'cards',
  'calendar',
  'board',
  'tiles',
  'checklist',
  'table',
]);
/** 不算页面内容的块：标题、时间段、提示。 */
const NOT_CONTENT: ReadonlySet<unknown> = new Set(['header', 'period', 'notice']);

type Tool = { do?: string; table?: string; ask?: unknown };

const toolsOf = (b: Component) => ((b as { tools?: Tool[] }).tools ?? []) as Tool[];
const childrenOf = (b: Component) =>
  ((b as { children?: Component[] }).children ?? []) as Component[];

/** 表单问几个字段：ask "all" 是这张表里表单能填的全部（算出来的字段不问）。 */
function formFields(b: Component, tables: ReadonlyMap<string, Collection>): number {
  let most = 0;
  for (const t of toolsOf(b)) {
    if (t.do !== 'create') continue;
    const table = t.table ? tables.get(t.table) : undefined;
    const n =
      t.ask === 'all'
        ? (table?.fields.filter((f) => fieldDefinition(f.type)?.inForm !== false).length ?? 0)
        : Array.isArray(t.ask)
          ? t.ask.length
          : 0;
    most = Math.max(most, n);
  }
  return most;
}

const sourceTable = (b: Component) => (b as { source?: { table?: string } }).source?.table;

export function designHints(file: AppFile): string[] {
  const hints: string[] = [];
  const tables = new Map(file.tables.map((t) => [t.id, t]));
  const inBar = new Set(
    file.app.bar.flatMap((x) =>
      typeof x === 'string' && x.startsWith('page:') ? [x.slice(5)] : [],
    ),
  );

  file.pages.forEach((page: Page, p) => {
    const blocks = page.blocks as Component[];
    // 1. 内嵌表单太长，或者一打开页面先是一张表：换成一个「添加」按钮，内容放前面。
    const first = blocks.findIndex((b) => !NOT_CONTENT.has(b.look));
    const flagged = new Set<Component>();
    if (first >= 0 && blocks[first]!.look === 'form') {
      const n = formFields(blocks[first]!, tables);
      if (n > FORM_FIRST_MAX) {
        flagged.add(blocks[first]!);
        hints.push(
          `pages.${p}.blocks.${first} (block "${blocks[first]!.id}"): the page opens with a form of ${n} fields before anything else; use one add button instead (a "button" block whose tool is {"do": "create", "table": …, "ask": "all"}) and put what the page shows first`,
        );
      }
    }
    const walk = (list: Component[], base: string) =>
      list.forEach((b, i) => {
        const path = `${base}.${i}`;
        if (b.look === 'form' && !flagged.has(b)) {
          const n = formFields(b, tables);
          if (n > FORM_MAX)
            hints.push(
              `${path} (block "${b.id}"): an inline form with ${n} fields is long to fill on a phone; use one add button instead (a "button" block whose tool is {"do": "create", "table": …, "ask": "all"}), or ask only the fields people fill every time`,
            );
        }
        walk(childrenOf(b), `${path}.children`);
      });
    walk(blocks, `pages.${p}.blocks`);

    // 3. 不在底栏的页面上面有标题栏，写着页名；标题块再写一遍就重复了。给一条记录用的页面标题栏是那条记录，不算。
    if (!inBar.has(page.id) && page.of === undefined) {
      blocks.forEach((b, i) => {
        const title = (b as { show?: { title?: unknown } }).show?.title;
        if (
          b.look === 'header' &&
          typeof title === 'string' &&
          title.trim().toLowerCase() === page.title.trim().toLowerCase()
        )
          hints.push(
            `pages.${p}.blocks.${i} (block "${b.id}"): this page is not in the bar, so its title "${page.title}" is already shown at the top; remove this header or give it other text`,
          );
      });
    }
  });

  // 2. 一张表被别的表关联（书 ← 阅读记录），却没有「一条记录的页面」：点开一本书看不到它的记录（内置的编辑页不列关联的记录）。
  const listed = new Set<string>();
  const allBlocks = (list: Component[]): Component[] =>
    list.flatMap((b) => [b, ...allBlocks(childrenOf(b))]);
  for (const page of file.pages)
    for (const b of allBlocks(page.blocks as Component[])) {
      const t = sourceTable(b);
      if (t && RECORD_LOOKS.has(b.look)) listed.add(t);
    }
  const withPage = new Set(file.pages.flatMap((p) => (p.of ? [p.of] : [])));
  file.tables.forEach((parent, i) => {
    if (withPage.has(parent.id) || !listed.has(parent.id)) return;
    const links = file.tables.flatMap((child) =>
      child.id === parent.id
        ? []
        : child.fields
            .filter((f) => f.type === 'link' && (f as { table?: string }).table === parent.id)
            .map((f) => ({ child: child.id, field: f.id })),
    );
    if (links.length === 0) return;
    const { child, field } = links[0]!;
    hints.push(
      `tables.${i} ("${parent.id}"): ${list(links.map((l) => l.child))} link to its entries, but there is no page for one ${parent.id} entry, so tapping one cannot show its ${child} entries; add a page with "of": "${parent.id}" that lists ${child} filtered by {"field": "${field}", "op": "is", "value": "$record"}, and set "opens" to that page on the blocks that list ${parent.id}`,
    );
  });
  return hints;
}

const list = (items: readonly string[]) => [...new Set(items)].join(', ');
