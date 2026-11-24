import type { AppFile } from './app-file';
import { fieldDefinition } from './fields';
import type { Collection, Component, Page } from './schema';

// Design suggestions (D-602): Once AI-generated app files can be imported, we will address
// usability issues. This is a recommendation only and does not block imports. Every rule was
// established by the founder on 2026-11-20 after reviewing before-and-after comparison screenshots
// in the simulator in conversation; evidence is the 69 AI-written files and 9 presets
// (side-session-notes/design-hints-2026-11-20). Conditions are written logically without narrowing
// to bypass presets; if a preset hits it, update the preset. Design trade-offs (subtitles on header
// blocks, one-tap record buttons coexisting with full forms, calendars and lists on the same page,
// summaries on the home screen) are stylistic choices and do not belong here.

/** Inline forms at the beginning of a page exceeding this many fields result in the page opening directly to a table. */
const FORM_FIRST_MAX = 3;
/** Regardless of placement, inline forms exceeding this many fields. */
const FORM_MAX = 6;
/** These blocks reading a table list individual records, and tapping one opens it. */
const RECORD_LOOKS: ReadonlySet<unknown> = new Set([
  'list',
  'cards',
  'calendar',
  'board',
  'tiles',
  'checklist',
  'table',
]);
/** Monotonous lists of identical items: two adjacent lists without a subheading become indistinguishable (calendars, circular blocks, and kanban boards are visually distinct at a glance). */
const PLAIN_LISTS: ReadonlySet<unknown> = new Set(['list', 'cards', 'checklist', 'table']);
/** Blocks not counted as page content: headers, time periods, notices. */
const NOT_CONTENT: ReadonlySet<unknown> = new Set(['header', 'period', 'notice']);

type Tool = { as?: string; do?: string; table?: string; ask?: unknown; values?: unknown };
type Show = { title?: unknown; subtitles?: unknown; trailing?: unknown; format?: unknown };

const toolsOf = (b: Component) => ((b as { tools?: Tool[] }).tools ?? []) as Tool[];
const childrenOf = (b: Component) =>
  ((b as { children?: Component[] }).children ?? []) as Component[];

/** Number of fields asked by a form: ask "all" means all fillable fields in this table (computed fields are not asked). */
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
/** Computed fields: there is no such thing as "optional". */
const COMPUTED = new Set(['formula', 'rollup', 'lookup', 'previous', 'dateOffset']);

export function designHints(file: AppFile): string[] {
  const hints: string[] = [];
  const tables = new Map(file.tables.map((t) => [t.id, t]));

  file.pages.forEach((page: Page, p) => {
    const blocks = page.blocks as Component[];
    // 1. Inline form is too long, or page opens with a table first: replace with an "Add" button, moving content to the front.
    const first = blocks.findIndex((b) => !NOT_CONTENT.has(b.look));
    const flagged = new Set<Component>();
    if (first >= 0 && blocks[first]!.look === 'form') {
      const n = formFields(blocks[first]!, tables);
      if (n > FORM_FIRST_MAX) {
        flagged.add(blocks[first]!);
        hints.push(
          `pages.${p}.blocks.${first} (block "${blocks[first]!.id}"): the page opens with a form of ${n} fields before anything else; use one add button instead (a "button" block whose tool is {"do": "create", "table": …, "ask": "all"}) and put what the page shows first${see(1)}`,
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
              `${path} (block "${b.id}"): an inline form with ${n} fields is long to fill on a phone; use one add button instead (a "button" block whose tool is {"do": "create", "table": …, "ask": "all"}), or ask only the fields people fill every time${see(1)}`,
            );
        }
        walk(childrenOf(b), `${path}.children`);
      });
    walk(blocks, `pages.${p}.blocks`);

    // 5. Two identical lists placed side by side without a subsection heading: impossible to tell which segment belongs to which table (regardless of whether they are the same table).
    let previous = false;
    blocks.forEach((b, i) => {
      if (PLAIN_LISTS.has(b.look)) {
        if (previous)
          hints.push(
            `pages.${p}.blocks.${i} (block "${b.id}"): this list comes right after another list with no header between them, so people cannot tell the two apart; put a header block before each list${see(8)}`,
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
      // 4. A row action that creates a new entry for the same table without containing that row: every row has a dangling "New" button.
      for (const tool of toolsOf(b))
        if (
          tool.as === 'button' &&
          tool.do === 'create' &&
          tool.table === t &&
          !JSON.stringify(tool.values ?? null).includes('$row')
        )
          hints.push(
            `${path} (block "${b.id}"): every row gets a button that adds a new ${t} entry; put one add button below the list instead (a "button" block whose tool is {"do": "create", "table": "${t}", "ask": "all"}), or use {"as": "addHere", "do": "create", "table": "${t}", "ask": "all", "values": "$here"}${see(1)}`,
          );
      // 3. Row title is an optional field: rows without a value filled show the table name and the entry date instead of the record itself.
      const title = field(show.title);
      if (
        title &&
        !(title as { required?: boolean }).required &&
        !('default' in title) &&
        !COMPUTED.has(title.type)
      )
        hints.push(
          `${path} (block "${b.id}"): the row title "${title.id}" is optional, so entries without it show the table's name and the day they were added instead; use a field that is always filled as the title (a required field, or a date with a default) and move "${title.id}" to subtitles${see(3)}`,
        );
      // 2. Displaying a summary value side by side with another number (e.g., target vs. budget) in a single row: if it is a target or cap, a progress bar makes the gap instantly clear.
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
            `${path} (block "${b.id}"): it shows "${total.id}" and "${other.id}" side by side; if "${other.id}" is the goal or limit for "${total.id}", show the progress instead: "trailing": "${total.id}", "format": {"kind": "progress", "goal": "${other.id}", "style": "bar"} (it reads "${total.id} / ${other.id}" with a bar)${see(2, 3)}`,
          );
      }
    }
  });

  // 1. A table is related to another table (e.g., books <- reading records) but lacks a dedicated record detail page: opening a book does not show its related records (the built-in edit page does not list related records).
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
      `tables.${i} ("${parent.id}"): ${list(links.map((l) => l.child))} link to its entries, but there is no page for one ${parent.id} entry, so tapping one cannot show its ${child} entries; add a page with "of": "${parent.id}" that lists ${child} filtered by {"field": "${field}", "op": "is", "value": "$record"}, and set "opens" to that page on the blocks that list ${parent.id}${see(8)}`,
    );
  });
  return hints;
}

/** Each suggestion points to the exact pattern in the structure patterns that can be followed to write it correctly (D-603, tinkrum-app-patterns.md). */
const see = (...n: number[]) =>
  `; see ${n.length > 1 ? 'patterns' : 'pattern'} ${n.join(' and ')} in tinkrum-app-patterns.md`;

const list = (items: readonly string[]) => [...new Set(items)].join(', ');

function allWithPaths(blocks: Component[], base: string): [Component, string][] {
  return blocks.flatMap((b, i): [Component, string][] => [
    [b, `${base}.${i}`],
    ...allWithPaths(childrenOf(b), `${base}.${i}.children`),
  ]);
}
