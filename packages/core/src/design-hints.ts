import type { AppFile } from './app-file';
import { fieldDefinition } from './fields';
import type { Collection, Component, Page } from './schema';

// 设计建议（D-599）：别的 AI 写的 App 文件能导入以后，再说哪里用起来不顺手。只是建议，不挡导入。
// 每一条都是创始人 2026-11-20 在对话里看过模拟器里的前后对比图后定的；证据是 AI 写的 69 份文件和 9 个预设
// （side-session-notes/design-hints-2026-11-20）。条件按道理写，不为了避开预设收窄；预设碰到了就改预设。
// 设计上的取舍（标题块的副标题、一点就记的按钮和完整表单并存、日历和列表同页、首页放一份摘要）是风格，不在这里。

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
/** 长得一样的一条条列表：两个挨着、中间没有小标题就分不清（日历、圆块、看板一眼看得出不同）。 */
const PLAIN_LISTS: ReadonlySet<unknown> = new Set(['list', 'cards', 'checklist', 'table']);
/** 不算页面内容的块：标题、时间段、提示。 */
const NOT_CONTENT: ReadonlySet<unknown> = new Set(['header', 'period', 'notice']);

type Tool = { as?: string; do?: string; table?: string; ask?: unknown; values?: unknown };
type Show = { title?: unknown; subtitles?: unknown; trailing?: unknown; format?: unknown };

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
const showOf = (b: Component) => ((b as { show?: Show }).show ?? {}) as Show;
/** 算出来的字段：没有「选填」一说。 */
const COMPUTED = new Set(['formula', 'rollup', 'lookup', 'previous', 'dateOffset']);

export function designHints(file: AppFile): string[] {
  const hints: string[] = [];
  const tables = new Map(file.tables.map((t) => [t.id, t]));

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

    // 5. 两个长得一样的列表挨着，中间没有小标题：分不清哪段是哪个（不管是不是同一张表）。
    let previous = false;
    blocks.forEach((b, i) => {
      if (PLAIN_LISTS.has(b.look)) {
        if (previous)
          hints.push(
            `pages.${p}.blocks.${i} (block "${b.id}"): this list comes right after another list with no header between them, so people cannot tell the two apart; put a header block before each list`,
          );
        previous = true;
      } else if (b.look === 'header' || (b.look === 'group' && showOf(b).title)) previous = false;
    });

    for (const [b, path] of allWithPaths(blocks, `pages.${p}.blocks`)) {
      const t = sourceTable(b);
      const table = t ? tables.get(t) : undefined;
      if (!table || !RECORD_LOOKS.has(b.look)) continue;
      const show = showOf(b);
      const field = (id: unknown) => table.fields.find((f) => f.id === id);
      // 4. 行上的按钮新建同一张表的一条、又不带这一行：每一行都挂一个「新建」。
      for (const tool of toolsOf(b))
        if (
          tool.as === 'button' &&
          tool.do === 'create' &&
          tool.table === t &&
          !JSON.stringify(tool.values ?? null).includes('$row')
        )
          hints.push(
            `${path} (block "${b.id}"): every row gets a button that adds a new ${t} entry; put one add button below the list instead (a "button" block whose tool is {"do": "create", "table": "${t}", "ask": "all"}), or use {"as": "addHere", "do": "create", "table": "${t}", "ask": "all", "values": "$here"}`,
          );
      // 6. 行标题是选填字段：没填的那几行显示的是表名和录入那天，不是这条记录。
      const title = field(show.title);
      if (
        title &&
        !(title as { required?: boolean }).required &&
        !('default' in title) &&
        !COMPUTED.has(title.type)
      )
        hints.push(
          `${path} (block "${b.id}"): the row title "${title.id}" is optional, so entries without it show the table's name and the day they were added instead; use a field that is always filled as the title (a required field, or a date with a default) and move "${title.id}" to subtitles`,
        );
      // 3. 一行里并排显示一个汇总（已存、已花）和另一个数字（目标、预算）：如果是目标或上限，进度条一眼看出差多少。
      if (show.format === undefined && (b.look === 'list' || b.look === 'cards')) {
        const shown = [
          show.title,
          ...(Array.isArray(show.subtitles) ? show.subtitles : []),
          show.trailing,
        ]
          .map(field)
          .filter((f) => f !== undefined);
        const total = shown.find(
          (f) =>
            f.type === 'rollup' &&
            ['sum', 'count'].includes((f as { aggregate?: string }).aggregate ?? ''),
        );
        const other = shown.find((f) => f !== total && (f.type === 'money' || f.type === 'number'));
        if (total && other)
          hints.push(
            `${path} (block "${b.id}"): it shows "${total.id}" and "${other.id}" side by side; if "${other.id}" is the goal or limit for "${total.id}", show the progress instead: "trailing": "${total.id}", "format": {"kind": "progress", "goal": "${other.id}", "style": "bar"} (it reads "${total.id} / ${other.id}" with a bar)`,
          );
      }
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

function allWithPaths(blocks: Component[], base: string): [Component, string][] {
  return blocks.flatMap((b, i): [Component, string][] => [
    [b, `${base}.${i}`],
    ...allWithPaths(childrenOf(b), `${base}.${i}.children`),
  ]);
}
