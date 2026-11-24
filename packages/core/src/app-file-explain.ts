import type { AppFile } from './app-file';
import type { Registry } from './registry';
import type { Collection } from './schema';
import { didYouMean } from './suggest';

// Issues reported by import validation (validateWorkspace, prepareOps) are meant for Tink: they
// speak in block IDs and table IDs, and Tink holds the entire configuration. Other AIs hold only
// this file (D-597): translate issues into positions within the file (pages.1.blocks.3) and append
// fix instructions—what fields this table has, what tables and pages are in the file, and whether X
// was intended. Translates descriptions only, does not change judgment logic: unrecognized issues
// are reported as-is.

interface BlockAt {
  path: string;
  pageId: string;
  json: string;
  table: string | undefined;
}

/** Reference name in validation → notation in file (components' refs.role). */
const ROLE_PATH: Record<string, string> = {
  subtitleField: 'show.subtitles',
  trailingField: 'show.trailing',
  colorField: 'show.color',
  choiceField: 'source.field',
  groupBy: 'source.group.by',
  dateField: 'source.days.date',
  skipField: 'source.days.skip.field',
};

const list = (items: readonly string[]) => items.join(', ');
const quoted = (s: string) => JSON.stringify(s);

export function explainProblems(
  problems: readonly string[],
  file: AppFile,
  registry: Registry,
): string[] {
  const blocks = new Map<string, BlockAt[]>();
  const walk = (items: readonly unknown[], base: string, pageId: string) =>
    items.forEach((item, i) => {
      const b = item as {
        id: string;
        source?: { table?: string };
        tools?: { table?: string }[];
        children?: unknown[];
      };
      const at: BlockAt = {
        path: `${base}.${i}`,
        pageId,
        json: JSON.stringify(b),
        table: b.source?.table ?? b.tools?.find((t) => t.table)?.table,
      };
      blocks.set(b.id, [...(blocks.get(b.id) ?? []), at]);
      if (b.children) walk(b.children, `${at.path}.children`, pageId);
    });
  file.pages.forEach((page, i) => walk(page.blocks, `pages.${i}.blocks`, page.id));
  const tableIds = file.tables.map((t) => t.id);
  const tableOf = (id: string): Collection | undefined => file.tables.find((t) => t.id === id);
  const fieldIds = (table: Collection) => table.fields.map((f) => f.id);

  /** Fix instructions appended after issues: state what exists in the file, guessing if possible. */
  function fix(body: string, blockTable?: string): string {
    let m = /(\S+) is not a field of (\S+)/.exec(body);
    if (m) {
      const table = tableOf(m[2]!);
      if (table)
        return `${body}; fields of ${table.id}: ${list(fieldIds(table))}${didYouMean(m[1]!, fieldIds(table))}`;
    }
    m = /must be an? (.+) field of (\S+)$/.exec(body);
    if (m) {
      const table = tableOf(m[2]!);
      const types = m[1]!.split(' or ');
      const fitting = table?.fields.filter((f) => types.includes(f.type)).map((f) => f.id) ?? [];
      if (table)
        return `${body}; ${fitting.length ? `fitting fields of ${table.id}: ${list(fitting)}` : `${table.id} has no ${m[1]} field`}`;
    }
    m = /(?:data table|missing table) (\S+)/.exec(body);
    if (m) return `${body}; tables in this file: ${list(tableIds)}${didYouMean(m[1]!, tableIds)}`;
    m = /form field (\S+) does not exist/.exec(body);
    const formTable = blockTable ? tableOf(blockTable) : undefined;
    if (m && formTable)
      return `${body}; fields of ${formTable.id}: ${list(fieldIds(formTable))}${didYouMean(m[1]!, fieldIds(formTable))}`;
    m = /action (\S+) is not registered/.exec(body);
    if (m) {
      const space = m[1]!.split('.')[0]!;
      const near = [...registry.actions.keys()].filter((a) => a.startsWith(`${space}.`));
      if (near.length) return `${body}; ${space} actions: ${list(near)}`;
    }
    return body;
  }

  /** Change reference names in validation to the file format style: "subtitleField x" -> "show.subtitles x". */
  const plain = (body: string) =>
    body.replace(/^(\w+) /, (all, role: string) => (ROLE_PATH[role] ? `${ROLE_PATH[role]} ` : all));

  /** When the same block ID appears across multiple pages, pick the one whose content matches the query terms the most. */
  function where(id: string, body: string): BlockAt[] {
    const all = blocks.get(id) ?? [];
    if (all.length < 2) return all;
    const words = body.split(/[\s,;:]+/).filter((w) => w.length > 1);
    const score = (b: BlockAt) => words.filter((w) => b.json.includes(quoted(w))).length;
    const best = Math.max(...all.map(score));
    return best > 0 ? all.filter((b) => score(b) === best) : all;
  }

  function explain(problem: string): string {
    let m = /^app (\S+) bar entry (\S+)( does not belong to this app)?$/.exec(problem);
    if (m) {
      const entry = m[2]!;
      const at = file.app.bar.indexOf(entry as never);
      if (file.app.bar.filter((x) => x === entry).length > 1)
        return `app.bar: ${quoted(entry)} is listed twice; list each page once`;
      if (m[3]) return `app.bar.${at}: ${quoted(entry)} is a page of another app`;
      const pages = file.pages.map((p) => `page:${p.id}`);
      return `app.bar.${at}: ${quoted(entry)} is not a page in this file; pages in this file: ${list(pages)}${didYouMean(entry, pages)}`;
    }
    m = /^component (\S+) on page (\S+)$/.exec(problem);
    if (m) {
      const same = (blocks.get(m[1]!) ?? []).filter((b) => b.pageId === m![2]);
      if (same.length > 1)
        return `${list(same.map((b) => b.path))}: these blocks on page ${m[2]} all have the id ${quoted(m[1]!)}; give each block its own id`;
    }
    m = /^(?:component )?([^\s:/]+):? (.*)$/.exec(problem);
    if (m && blocks.has(m[1]!)) {
      const at = where(m[1]!, m[2]!);
      const body = plain(m[2]!);
      return `${list(at.map((b) => b.path))} (block ${quoted(m[1]!)}): ${fix(body, at[0]?.table)}`;
    }
    m = /^([^\s:/]+)\/([^\s:/]+): (.*)$/.exec(problem);
    if (m) {
      const t = file.tools.findIndex((x) => x.id === m![1]);
      const tool = file.tools[t];
      const s = tool?.kind === 'quickAction' ? tool.steps.findIndex((x) => x.id === m![2]) : -1;
      if (s >= 0) return `tools.${t}.steps.${s} (step ${quoted(m[2]!)}): ${fix(m[3]!)}`;
    }
    m = /^([^\s:/.]+)\.([^\s:/]+): (.*)$/.exec(problem);
    if (m) {
      const t = file.tables.findIndex((x) => x.id === m![1]);
      const f = t >= 0 ? file.tables[t]!.fields.findIndex((x) => x.id === m![2]) : -1;
      if (f >= 0) {
        const field = file.tables[t]!.fields[f]!;
        const options =
          'options' in field && Array.isArray(field.options) && /is not an option/.test(m[3]!)
            ? `; options: ${list(field.options.map((o: { id: string }) => o.id))}`
            : '';
        return `tables.${t}.fields.${f} (field ${quoted(field.id)} of ${file.tables[t]!.id}): ${fix(m[3]!)}${options}`;
      }
    }
    return fix(problem);
  }

  return problems.map(explain);
}
