import { isSystemField } from './components/define';
import { parseFormula } from './formula';
import { workflowKinds } from './quick-actions';
import {
  isOpenUse,
  isRecordToolUse,
  tapWrites,
  isToolRefUse,
  type RecordTool,
  type ToolUse,
} from './record-ops-schema';
import { createRegistry, type Registry } from './registry';
import { sortList } from './schema-base';
import { reminderTable } from './reminders';
import { dateFieldOf } from './sequence';
import {
  RECORD_LOOKS,
  TOOLBOX_PAGE_ID,
  childrenOf,
  componentTarget,
  fieldDefinition,
  isKnownComponent,
  pageIdOf,
  quickActionsOf,
  remindersOf,
  toolTargetId,
  type Collection,
  type Component,
  type Condition,
  type Field,
  type KnownComponent,
  type Locale,
  type Page,
  type QuickAction,
  type Reminder,
  type WorkspaceConfig,
} from './schema';
import { BUILTIN_TOOLS } from './tools';
import { handedInput, workflowProblems } from './workflow/check';
import { missingPlace, stepRefs } from './workflow/refs';

// Tool check (AGENT_PLAN §3.1-§3.4, §3.8): uses code to determine whether tools in the app are
// usable. Validation (validate.ts) only checks if the config is valid, whereas this checks whether
// the user can "tap it, fill it, and see it". Pure function, read-only config; warns only, never
// rejects, never modifies config (invariants 15, 19). Tools are of three kinds: file tools (quick
// actions), record tools (table-based), and file-to-record (quick actions containing
// out.addRecord). blocker = this tool is currently unusable; warning = there may be an issue.
// Messages are in English, destined for the model in the future.
//
// Entry points are determined by the app's actual code, not guessed:
// - "Settings -> Quick Actions" (WorkflowsScreen) lists all quick actions in the config, so quick
// actions are always reachable: unplaced ones are merely warnings.
// - "Settings -> Data" (app/data.tsx) only supports export and restore, not addition, so it does
// not count as a record entry point.
// - "Table is ready" (TableReadyScreen) when the AI has just created a table appears only once, so
// it does not count.
// - Inbox "Save as record" (ShareScreen, D-392) lists tables with attachment fields, counts as an
// entry point, but requires files to be present first.
// - Pack pages are reachable via "Settings -> Tools"; pages have no master list, and other pages
// rely on navigation, entry points, and reminders.

export type ToolKind = 'file' | 'record' | 'fileToRecord';

/** When a table has just been created and the page is still in a subsequent step (next or later planned steps), these issues are expected and not considered incomplete. */
export const FIXED_BY_A_LATER_STEP: ReadonlySet<string> = new Set([
  'add-missing',
  'view-missing',
  'page-unreachable',
  'add-unreachable',
  'view-unreachable',
  'stat-input-missing',
]);
export type ToolIssueSeverity = 'blocker' | 'warning';

export interface ToolIssue {
  severity: ToolIssueSeverity;
  code: string;
  /** quickAction:<id>, table:<id>, page:<id>, reminder:<id>, block:<page>/<block>, field:<table.field>. */
  target: string;
  message: string;
}

export interface FileToolChecks {
  /** The first step is an input action. */
  firstStepIsInput: boolean;
  /** Adjacent step types are compatible. */
  chain: boolean;
  /** Actions are registered and parameters for each step are complete. */
  params: boolean;
  /** Placement: placed = reachable in a page, home screen, toolkit, or preset library; settings = only in "Settings -> Quick Actions". */
  entry: 'placed' | 'settings';
  entryVia: string[];
}

export interface RecordToolChecks {
  /** Where it is recorded: the table has a name and fillable fields. */
  where: boolean;
  /** How it is recorded: has an addition entry point, and mandatory fields can be filled. */
  add: boolean;
  addVia: string[];
  /** How it is viewed: has blocks reading this table, and the page is accessible. */
  view: boolean;
  viewVia: string[];
  /** How it is reminded: null when there is no reminder. */
  remind: boolean | null;
}

export interface FileToRecordChecks extends FileToolChecks {
  /** Target table exists. */
  target: boolean;
  /** Table has a field to store this value (file -> attachment, text -> text). */
  place: boolean;
  /** The record tool itself on the target table is usable (visible after user confirms save). */
  recordSide: boolean;
  tables: string[];
}

export type ToolChecks = FileToolChecks | RecordToolChecks | FileToRecordChecks;

export interface CheckedTool {
  kind: ToolKind;
  id: string;
  name: string;
  ok: boolean;
  checks: ToolChecks;
}

export interface ToolCheckResult {
  tools: CheckedTool[];
  issues: ToolIssue[];
}

// ---- Read/Write Relationships ----

/** A place where records can be added to a table. */
interface AddPath {
  via: string;
  reachable: boolean;
  /** Appears only when the source table already has records (buttons on each row, large circular block). */
  needsRowOf?: string;
}

interface TableUse {
  /** Blocks reading this table (on pages) and whether they are reachable in the app. */
  readers: { via: string; reachable: boolean }[];
  /** Other tables read it via relations, lookup, or rollup; quick actions read it (printing). */
  indirect: { via: string; host?: string }[];
  adds: AddPath[];
  /** Fields read by display, filtering, sorting, grouping, rollups, and formulas. */
  read: Set<string>;
  /** Fields requested by forms. */
  asked: Set<string>;
  /** Has a complete form (ask "all", out.addRecord): every field is requested. */
  askedAll: boolean;
  /** Fields written by tools (presets, set, toggle, increment, setAll, smartDate). */
  written: Set<string>;
  /** A block that opens the built-in edit page when tapped (on an accessible page). */
  editor: boolean;
  /** A reminder is monitoring this table. */
  watched: boolean;
  /** Table statistics and charts read on accessible pages, and the fields they depend on. */
  stats: StatUse[];
}

/** A field depended upon by a statistic or chart. soft: missing value just means a missing section (grouping all in "Unset", subtractor is 0), not empty. */
interface StatInput {
  table: string;
  field: string;
  soft?: true;
}

interface StatUse {
  via: string;
  target: string;
  inputs: StatInput[];
}

const newUse = (): TableUse => ({
  readers: [],
  indirect: [],
  adds: [],
  read: new Set(),
  asked: new Set(),
  askedAll: false,
  written: new Set(),
  editor: false,
  watched: false,
  stats: [],
});

/** Blocks actually displayed on the page (hidden blocks and their sub-blocks do not count). */
function visibleBlocks(page: Page): Component[] {
  const walk = (list: readonly Component[]): Component[] =>
    list.flatMap((c) => (c.hidden ? [] : [c, ...walk(childrenOf(c))]));
  return walk(page.blocks);
}

const usesOf = (c: KnownComponent): ToolUse[] => (c as { tools?: ToolUse[] }).tools ?? [];

const isRecordLook = (c: KnownComponent) => (RECORD_LOOKS as readonly string[]).includes(c.look);

/** Pages reachable by tapping this block. */
function pagesOpenedBy(c: Component): string[] {
  if (!isKnownComponent(c)) return [];
  const out: string[] = [];
  const target = componentTarget(c);
  const page = target === null ? null : pageIdOf(target);
  if (page !== null) out.push(page);
  if (isRecordLook(c)) {
    const opens = (c as { opens?: string }).opens;
    if (opens !== undefined) out.push(opens);
  }
  for (const u of usesOf(c)) if (isOpenUse(u) && u.opens !== 'record') out.push(u.opens);
  return out;
}

/** Pages reachable from navigation, reminders, and toolkit pages (entry points on other pages require their own reachability). */
function reachablePages(config: WorkspaceConfig): Set<string> {
  const pages = config.containers.pages;
  const seen = new Set<string>();
  const queue: string[] = [];
  const visit = (id: string | null) => {
    if (id === null || seen.has(id) || !pages.some((p) => p.id === id)) return;
    seen.add(id);
    queue.push(id);
  };
  for (const target of [...config.nav.bar, ...config.nav.floating]) visit(pageIdOf(target));
  // Each app's bottom bar is also a root (D-485); the app itself is accessed from home screen entry points and "My Apps" in settings.
  for (const app of config.nav.apps ?? []) for (const target of app.bar) visit(pageIdOf(target));
  for (const r of remindersOf(config)) visit(pageIdOf(r.opens));
  // Toolkit pages are under "Settings -> Tools"; the toolbox is a core system entry point (like page-entries.ts, not considered an isolated page).
  for (const p of pages) if (p.package || p.id === TOOLBOX_PAGE_ID) visit(p.id);
  while (queue.length > 0) {
    const id = queue.pop();
    const page = pages.find((p) => p.id === id)!;
    for (const c of visibleBlocks(page)) for (const next of pagesOpenedBy(c)) visit(next);
  }
  return seen;
}

/** This field can be saved even without a value (has default value or auto-populated for new records). */
function hasDefault(f: Field): boolean {
  return (
    ('default' in f && f.default !== undefined) || fieldDefinition(f.type).emptyNew !== undefined
  );
}

const isComputed = (f: Field) => fieldDefinition(f.type).inForm === false;

const requiredFields = (table: Collection) =>
  table.fields.filter(
    (f) => 'required' in f && f.required && !isComputed(f) && fieldDefinition(f.type).write,
  );

class Analysis {
  readonly reachable: Set<string>;
  private readonly uses = new Map<string, TableUse>();
  readonly issues: { key: string | null; issue: ToolIssue }[] = [];
  /** Where quick actions are placed (blocks, reminders, home screen, file desk). */
  readonly placed = new Map<string, Set<string>>();
  /** Quick actions placed only on inaccessible pages. */
  readonly placedUnreachable = new Map<string, string>();
  /** Tables read and written by each page (for reminder comparison). */
  readonly pageTables = new Map<string, Set<string>>();
  /** Has quick action library blocks or navigation entry points: all when kind is null. */
  readonly libraries: (string | null)[] = [];

  constructor(
    readonly config: WorkspaceConfig,
    readonly registry: Registry,
  ) {
    this.reachable = reachablePages(config);
    for (const table of config.data.tables) this.uses.set(table.id, newUse());
    for (const page of config.containers.pages) this.readPage(page);
    this.readNav();
    for (const wf of quickActionsOf(config)) this.readSteps(wf);
    for (const r of remindersOf(config)) this.readReminder(r);
    for (const table of config.data.tables) this.readFields(table);
  }

  use(table: string): TableUse | undefined {
    return this.uses.get(table);
  }

  table(id: string): Collection | undefined {
    return this.config.data.tables.find((t) => t.id === id);
  }

  report(
    key: string | null,
    severity: ToolIssueSeverity,
    code: string,
    target: string,
    message: string,
  ) {
    this.issues.push({ key, issue: { severity, code, target, message } });
  }

  private place(id: string, via: string) {
    const set = this.placed.get(id) ?? new Set<string>();
    set.add(via);
    this.placed.set(id, set);
  }

  private readNav() {
    const { nav, containers } = this.config;
    if ([...nav.bar, ...nav.floating].includes('quickActions')) this.libraries.push(null);
    for (const id of nav.phoneHomeScreen ?? [])
      if (!id.startsWith('app:')) this.place(id, 'phone home screen');
    // Buttons at the top of the record page (D-428).
    for (const table of this.config.data.tables)
      for (const item of table.recordRow ?? []) this.place(item.tool, `entry page of ${table.id}`);
    for (const r of remindersOf(this.config)) {
      const id = toolTargetId(r.opens);
      if (id !== null) this.place(id, `reminder ${r.id}`);
    }
    for (const groups of Object.values(containers.desk?.tools ?? {}))
      for (const group of groups ?? [])
        for (const item of group.items)
          if (typeof item === 'string') this.place(item, 'file desk toolbar');
  }

  private readPage(page: Page) {
    const reachable = this.reachable.has(page.id);
    const tables = new Set<string>();
    this.pageTables.set(page.id, tables);
    for (const c of visibleBlocks(page)) {
      if (!isKnownComponent(c)) continue;
      const where = `${c.look} ${c.id} on page ${page.id}`;
      this.readBlock(c, page, where, reachable, tables);
      const target = componentTarget(c);
      const toolId = target === null ? null : toolTargetId(target);
      if (toolId !== null) this.placeTool(toolId, where, reachable, page.id);
      for (const u of usesOf(c))
        if (isToolRefUse(u)) this.placeTool(u.tool, where, reachable, page.id);
    }
  }

  private placeTool(id: string, where: string, reachable: boolean, page: string) {
    if (reachable) this.place(id, where);
    else this.placedUnreachable.set(id, page);
  }

  private readBlock(
    c: KnownComponent,
    page: Page,
    where: string,
    reachable: boolean,
    tables: Set<string>,
  ) {
    if (c.look === 'catalog' && c.source.catalog === 'quickActions' && reachable)
      this.libraries.push(c.source.kind ?? null);
    if (isRecordLook(c)) {
      const block = c as Extract<KnownComponent, { look: 'list' }>;
      const { source, show } = block;
      const look: string = c.look;
      const use = this.uses.get(source.table);
      tables.add(source.table);
      if (use) {
        use.readers.push({ via: where, reachable });
        for (const id of [
          show.title,
          ...(show.subtitles ?? []),
          show.trailing,
          show.color,
          ...(show.columns ?? []),
          ...(show.browse?.sort ?? []),
          ...(show.browse?.group ?? []),
          ...(show.browse?.filter ?? []),
        ])
          if (id !== undefined) use.read.add(id);
        const format = show.format;
        if (format?.kind === 'elapsed' && format.until) use.read.add(format.until);
        // The target of a grid tile (D-610) is fields in the row's table (referenced table).
        const goalUse = look === 'grid' ? this.linkedUse(source) : use;
        if (format?.kind === 'progress' && typeof format.goal === 'string')
          goalUse?.read.add(format.goal);
        if (source.across)
          use.read.add(source.across.by ?? dateFieldOf(this.table(source.table)!, undefined));
        this.readFilter(use, source.filter);
        this.readFilter(use, show.highlight);
        for (const key of sortList(source.sort)) use.read.add(key.field);
        if (source.group?.by) use.read.add(source.group.by);
        const tapped = block.tools?.some((u) => u.as === 'tap');
        if (reachable && block.opens === undefined && !(look === 'tiles' && tapped))
          use.editor = true;
        if (reachable && block.tools?.some((u) => isOpenUse(u) && u.opens === 'record'))
          use.editor = true;
      }
    } else if (c.look === 'single') {
      const use = this.uses.get(c.source.table);
      tables.add(c.source.table);
      if (use) {
        use.readers.push({ via: where, reachable });
        for (const id of c.show.fields) use.read.add(id);
        // Block has "Edit".
        if (reachable) use.editor = true;
      }
    } else if (c.look === 'number' || c.look === 'chart') {
      const { source } = c;
      const use = this.uses.get(source.table);
      tables.add(source.table);
      if (use) {
        use.readers.push({ via: where, reachable });
        if (source.field) use.read.add(source.field);
        this.readFilter(use, source.filter);
        if (source.group?.by) use.read.add(source.group.by);
        if (source.days?.date) use.read.add(source.days.date);
        const skip = (source.days as { skip?: { field: string } } | undefined)?.skip;
        if (skip) use.read.add(skip.field);
        if (reachable)
          use.stats.push({
            via: where,
            target: `block:${page.id}/${c.id}`,
            inputs: this.statInputs(c),
          });
      }
      if (c.look === 'number')
        for (const total of c.source.calc?.with ?? []) {
          tables.add(total.table);
          const other = this.uses.get(total.table);
          if (other) {
            other.readers.push({ via: `${where} (calc)`, reachable });
            if (total.field) other.read.add(total.field);
            if (total.days?.date) other.read.add(total.days.date);
            this.readFilter(other, total.filter);
          }
        }
      if (c.look === 'chart' && c.source.split && use) use.read.add(c.source.split.by);
      const minus = c.look === 'number' ? c.source.minus : undefined;
      if (minus) {
        const other = this.uses.get(minus.table);
        tables.add(minus.table);
        if (other) {
          other.readers.push({ via: `${where} (minus)`, reachable });
          if (minus.field) other.read.add(minus.field);
          this.readFilter(other, minus.filter);
        }
      }
    }
    if (isRecordLook(c)) {
      const record = c as Extract<KnownComponent, { look: 'calendar' }>;
      const use = this.uses.get(record.source.table);
      if (record.source.group?.until) use?.read.add(record.source.group.until);
      if (record.show.day?.field) use?.read.add(record.show.day.field);
    }
    const sourceTable = isRecordLook(c) ? (c as { source: { table: string } }).source.table : null;
    for (const u of usesOf(c)) {
      if (u.when && sourceTable) {
        const use = this.uses.get(sourceTable);
        if (use) this.readFilter(use, u.when);
      }
      if (isToolRefUse(u) && reachable) {
        const wf = quickActionsOf(this.config).find((x) => x.id === u.tool);
        if (wf) for (const ref of stepRefs(wf, this.registry)) tables.add(ref.table);
      }
      if (!isRecordToolUse(u)) continue;
      // All tap locations (D-566) count as writes.
      for (const tool of tapWrites(u, sourceTable ?? u.table)) {
        tables.add(tool.table);
        this.readTool(tool, {
          via: u.as ? `${u.as} tool of ${where}` : where,
          reachable,
          target: `block:${page.id}/${c.id}`,
          // Grid tiles (D-610) do not require existing records in the table: rows come from options or referenced tables.
          ...(sourceTable !== null && u.as !== 'addHere' && c.look !== 'grid'
            ? { needsRowOf: sourceTable }
            : {}),
          herePresets: this.herePresets(c),
        });
      }
    }
  }

  /** Fields required to compute values for statistics or charts: calculated value, date field for days, equality conditions required for valid filters, grouping. */
  private statInputs(c: Extract<KnownComponent, { look: 'number' | 'chart' }>): StatInput[] {
    const { table: id, aggregate, field, filter, group, days } = c.source;
    const table = this.table(id);
    if (!table) return [];
    const of = (fieldId: string, soft?: true): StatInput => ({
      table: id,
      field: fieldId,
      ...(soft ? { soft } : {}),
    });
    const inputs: StatInput[] = [];
    if (field && aggregate !== 'count' && aggregate !== 'distinctDays') inputs.push(of(field));
    for (const x of filter ?? [])
      if (x.op !== 'isEmpty' && x.op !== 'isNot') inputs.push(of(x.field));
    if (group?.unit) inputs.push(of(dateFieldOf(table, group.by)));
    else if (group?.by) inputs.push(of(group.by, true));
    if (['streak', 'daysSince', 'avgInterval', 'distinctDays'].includes(aggregate))
      inputs.push(of(dateFieldOf(table, days?.date)));
    const minus = c.look === 'number' ? c.source.minus : undefined;
    if (minus?.field) inputs.push({ table: minus.table, field: minus.field, soft: true });
    if (c.look === 'number')
      for (const total of c.source.calc?.with ?? [])
        if (total.field) inputs.push({ table: total.table, field: total.field, soft: true });
    return inputs;
  }

  /** Usage of the referenced table when grid tiles (D-610) are grouped by a relation field. */
  private linkedUse(source: { table: string; group?: { by?: string | undefined } | undefined }) {
    const link = this.table(source.table)?.fields.find((f) => f.id === source.group?.by);
    return link?.type === 'link' ? this.uses.get(link.table) : undefined;
  }

  /** Fields included in local addition ("$here"): value of this segment and equality conditions in list filters; plus the current date for grid tiles (D-610). */
  private herePresets(c: KnownComponent): string[] {
    if (!isRecordLook(c)) return [];
    const { source } = c as Extract<KnownComponent, { look: 'list' }>;
    const table = this.table(source.table);
    return [
      ...(source.across && table ? [source.across.by ?? dateFieldOf(table, undefined)] : []),
      ...(source.group?.by ? [source.group.by] : []),
      ...(source.filter ?? [])
        .filter((x) => x.op === 'is' && !Array.isArray(x.value))
        .map((x) => x.field),
    ];
  }

  private readFilter(use: TableUse, filter: readonly Condition[] | undefined) {
    for (const x of filter ?? []) use.read.add(x.field);
  }

  private readTool(
    tool: RecordTool,
    at: {
      via: string;
      reachable: boolean;
      target: string;
      needsRowOf?: string;
      herePresets?: string[];
    },
  ) {
    const use = this.uses.get(tool.table);
    const table = this.table(tool.table);
    if (!use || !table) return;
    // Batch creation (D-567): reads source table filters, writes preset fields (mandatory field checks are in record-ops.ts).
    if (tool.do === 'createAll') {
      const from = this.uses.get(tool.from);
      if (from) this.readFilter(from, tool.filter);
      for (const id of Object.keys(tool.values)) use.written.add(id);
      // Checked creation (D-616) also writes values of this segment (equality conditions in list filters, grouping).
      if (tool.pick) for (const id of at.herePresets ?? []) use.written.add(id);
      return;
    }
    // Moving to "Recently Deleted" (D-610) does not write fields.
    if (tool.do === 'remove') return;
    if (tool.do !== 'create') {
      use.written.add(tool.field);
      if (tool.do === 'setAll') this.readFilter(use, tool.filter);
      return;
    }
    use.adds.push({
      via: at.via,
      reachable: at.reachable,
      ...(at.needsRowOf ? { needsRowOf: at.needsRowOf } : {}),
    });
    const presets =
      tool.values === '$here' ? (at.herePresets ?? []) : Object.keys(tool.values ?? {});
    for (const id of presets) use.written.add(id);
    if (tool.smartDate) use.written.add(tool.smartDate.to);
    if (tool.ask === 'all') {
      use.askedAll = true;
      return;
    }
    for (const id of tool.ask ?? []) use.asked.add(id);
    // Mandatory fields with no default value, unrequested by forms and without presets: this form (button) can never be saved.
    const covered = new Set([...presets, ...(tool.ask ?? [])]);
    if (tool.smartDate) covered.add(tool.smartDate.to);
    const missing = requiredFields(table).filter((f) => !covered.has(f.id) && !hasDefault(f));
    for (const f of missing)
      this.report(
        `table:${table.id}`,
        'blocker',
        'add-missing-required',
        at.target,
        `${at.via} adds to ${table.id} but never fills required field ${f.id}, so saving always fails; add ${f.id} to ask, or use ask: "all"`,
      );
  }

  private readSteps(wf: QuickAction) {
    for (const ref of stepRefs(wf, this.registry)) {
      const use = this.uses.get(ref.table);
      if (!use) continue;
      if (ref.field !== undefined) use.read.add(ref.field);
      else if ('receives' in ref) {
        // out.addRecord opens the complete new record form: every field is requested.
        use.adds.push({ via: `quick action ${wf.id}`, reachable: true });
        use.askedAll = true;
      } else use.indirect.push({ via: `quick action ${wf.id}` });
    }
  }

  private readReminder(r: Reminder) {
    const watched = reminderTable(r);
    const use = watched && this.uses.get(watched.table);
    if (use && watched) {
      use.watched = true;
      use.read.add(watched.field);
    }
    const unless = r.unless;
    const other = unless && this.uses.get(unless.table);
    if (unless && other) {
      this.readFilter(other, unless.filter);
      if (unless.date) other.read.add(unless.date);
      if (unless.link) other.read.add(unless.link);
    }
    if (r.done)
      this.readTool(r.done, {
        via: `"done" of reminder ${r.id}`,
        reachable: true,
        target: `reminder:${r.id}`,
        ...(watched ? { needsRowOf: watched.table } : {}),
      });
  }

  /** Formulas, rollups, lookups, previous record, and relation fields: counted in read/write relationships. */
  private readFields(table: Collection) {
    const use = this.uses.get(table.id)!;
    for (const f of table.fields) {
      if (f.type === 'formula') {
        const parsed = parseFormula(f.expression);
        if (parsed.ok) for (const id of parsed.refs) use.read.add(id);
      } else if (f.type === 'dateOffset') {
        use.read.add(f.from);
        if (typeof f.add === 'string') use.read.add(f.add);
      } else if (f.type === 'rollup') {
        const other = this.uses.get(f.table);
        if (other) {
          other.indirect.push({ via: `summary field ${table.id}.${f.id}`, host: table.id });
          other.read.add(f.via);
          if (f.field) other.read.add(f.field);
          this.readFilter(other, f.filter);
          if (f.days?.date) other.read.add(f.days.date);
          if (f.days?.skip) other.read.add(f.days.skip.field);
        }
      } else if (f.type === 'lookup') {
        use.read.add(f.via);
        const via = table.fields.find((x) => x.id === f.via);
        const other = via?.type === 'link' ? this.uses.get(via.table) : undefined;
        if (other) other.read.add(f.field);
      } else if (f.type === 'previous') {
        use.read.add(f.field);
        if (f.date) use.read.add(f.date);
        if (f.within) use.read.add(f.within);
      } else if (f.type === 'schedule') {
        if (f.lastDone) use.read.add(f.lastDone);
      } else if (f.type === 'link') {
        const other = this.uses.get(f.table);
        if (other && f.table !== table.id)
          other.indirect.push({ via: `link field ${table.id}.${f.id}`, host: table.id });
      }
    }
  }

  /** Related tables within one hop (relations, lookups, rollups, in both directions). */
  relatedTables(id: string): Set<string> {
    const out = new Set([id]);
    for (const t of this.config.data.tables)
      for (const f of t.fields)
        if ((f.type === 'link' || f.type === 'rollup') && (t.id === id || f.table === id)) {
          out.add(t.id);
          out.add(f.table);
        }
    return out;
  }
}

// ---- Record Tools ----

/**
 * Tables still in use by tools or blocks. Unused tables might be newly created and not yet
 * connected, or unwanted by the user while data is retained (invariant 5: after "stop
 * bookkeeping", records remain in "Settings -> Data"). Cannot distinguish solely from config, so
 * only warnings are issued, never forcing reconnection.
 */
function liveTables(a: Analysis): Set<string> {
  const live = new Set<string>();
  for (const t of a.config.data.tables) {
    const use = a.use(t.id)!;
    if (
      use.adds.length > 0 ||
      use.readers.length > 0 ||
      use.watched ||
      use.indirect.some((x) => x.host === undefined)
    )
      live.add(t.id);
  }
  // Tables referenced or summarized by in-use tables are also considered in use.
  for (let grew = true; grew;) {
    grew = false;
    for (const t of a.config.data.tables) {
      if (live.has(t.id) || !a.use(t.id)!.indirect.some((x) => x.host && live.has(x.host)))
        continue;
      live.add(t.id);
      grew = true;
    }
  }
  return live;
}

const FUNCTIONLESS = new Set(['header', 'text', 'notice', 'spacer', 'image']);

/** Inaccessible pages. Toolkit pages and the toolbox are excluded (have other entry points). */
function checkPages(a: Analysis) {
  for (const page of a.config.containers.pages) {
    if (a.reachable.has(page.id)) continue;
    const useful = page.blocks.some(
      (c) => isKnownComponent(c) && !c.hidden && !FUNCTIONLESS.has(c.look),
    );
    const how = page.of
      ? `a list of ${page.of} with opens: "${page.id}"`
      : 'a nav item, or an entry or button on a page that can be reached';
    a.report(
      null,
      useful ? 'blocker' : 'warning',
      'page-unreachable',
      `page:${page.id}`,
      `page ${page.id} ("${page.title}") can't be opened from anywhere; add ${how}`,
    );
  }
}

function checkTable(a: Analysis, table: Collection, live: Set<string>): RecordToolChecks {
  const key = `table:${table.id}`;
  const use = a.use(table.id)!;
  const fillable = table.fields.filter((f) => !isComputed(f));
  const where = table.name.trim().length > 0 && fillable.length > 0;
  if (!where)
    a.report(
      key,
      'blocker',
      'table-no-fields',
      key,
      `table ${table.id} has no field the user can fill in; add at least one`,
    );
  if (!live.has(table.id)) {
    a.report(
      key,
      'warning',
      'table-unused',
      key,
      `nothing uses table ${table.id}: no form or button adds to it and no block shows it. If the user still wants it, add a page for it; if they gave it up, its entries stay in Settings > Data`,
    );
    return { where, add: false, addVia: [], view: false, viewVia: [], remind: null };
  }

  // How to record. Buttons on each row require existing records: those writing to their own table (copy record) cannot serve as starters.
  const starters = use.adds.filter((p) => p.needsRowOf !== table.id);
  const reachableAdds = starters.filter((p) => p.reachable);
  const hasFileField = table.fields.some((f) => f.type === 'file');
  const addVia = reachableAdds.map((p) => p.via);
  // "Create in this table" on each row: button does not appear when there are zero rows, and the first row can never be added (occurred in S2).
  const selfRow = use.adds.find((p) => p.needsRowOf === table.id);
  if (reachableAdds.length === 0 && selfRow) {
    a.report(
      key,
      'blocker',
      'add-needs-existing-row',
      key,
      `the only button that adds to ${table.id} is ${selfRow.via}, which sits on each entry, so with no entries it never appears; use a form, a button block with {do: "create", table: "${table.id}", ask: "all"}, or as: "addHere"`,
    );
    if (hasFileField) addVia.push('inbox "save as record"');
  } else if (reachableAdds.length === 0 && hasFileField) {
    addVia.push('inbox "save as record"');
    a.report(
      key,
      'warning',
      'add-only-from-inbox',
      key,
      `entries of ${table.id} can only be added by sharing files into Morph; add a form or a button that creates an entry`,
    );
  } else if (reachableAdds.length === 0 && starters.length > 0) {
    a.report(
      key,
      'blocker',
      'add-unreachable',
      key,
      `the only way to add to ${table.id} is ${starters[0]!.via}, and that page can't be opened; give the page an entry`,
    );
  } else if (reachableAdds.length === 0) {
    a.report(
      key,
      'blocker',
      'add-missing',
      key,
      `nothing adds entries to ${table.id}; add a form, a button with {do: "create", table: "${table.id}", ask: "all"}, or a quick action ending in out.addRecord`,
    );
  }

  // How to view.
  const shown = use.readers.filter((r) => r.reachable);
  const hosted = use.indirect.filter(
    (x) => x.host === undefined || a.use(x.host)?.readers.some((r) => r.reachable),
  );
  const viewVia = [...shown.map((r) => r.via), ...hosted.map((x) => x.via)];
  if (viewVia.length === 0) {
    if (use.readers.length > 0)
      a.report(
        key,
        'blocker',
        'view-unreachable',
        key,
        `${use.readers[0]!.via} shows ${table.id}, but that page can't be opened; give the page an entry`,
      );
    else
      a.report(
        key,
        'blocker',
        'view-missing',
        key,
        `no block reads ${table.id}, so its entries are never shown; add a list, calendar, board, number or chart with source.table "${table.id}"`,
      );
  }

  const blockers = a.issues.some(
    (x) =>
      x.key === key && x.issue.severity === 'blocker' && x.issue.code !== 'add-missing-required',
  );
  // When no one writes or reads the table, field reminders are just noise.
  if (!blockers) checkFields(a, table);
  return {
    where,
    add:
      addVia.length > 0 &&
      !a.issues.some(
        (x) =>
          x.key === key &&
          (x.issue.code === 'add-missing-required' || x.issue.code === 'add-needs-existing-row'),
      ),
    addVia,
    view: viewVia.length > 0,
    viewVia,
    remind: null,
  };
}

function checkFields(a: Analysis, table: Collection) {
  const use = a.use(table.id)!;
  for (const f of table.fields) {
    const target = `field:${table.id}.${f.id}`;
    const seen = use.read.has(f.id) || use.asked.has(f.id) || use.written.has(f.id);
    const shownInForm = use.askedAll && !isComputed(f);
    if (!seen && !shownInForm)
      a.report(
        `table:${table.id}`,
        'warning',
        'field-unused',
        target,
        `field ${table.id}.${f.id} is not shown, not asked in any form and not used by a computed field; show it, add it to the form, or remove it`,
      );
  }
  for (const f of table.fields) {
    for (const dep of computedInputs(a, table, f)) {
      if (fieldHasInput(a, dep.table, dep.field)) continue;
      a.report(
        `table:${table.id}`,
        'warning',
        'computed-input-missing',
        `field:${table.id}.${f.id}`,
        `computed field ${table.id}.${f.id} needs ${dep.table}.${dep.field}, but nothing fills that field in, so it stays empty; add it to a form`,
      );
    }
  }
  checkStatInputs(a, table);
}

/**
 * Check whether fields required by statistics and charts can be populated (REPORT3: "Reading
 * chart stats by completion date, but the form does not ask for completion date"). Unfillable
 * with no default value: statistics are always empty, blocker. Fillable only by opening a single
 * record's edit page (or inbox form): fillable, but users won't fill it during entry, warning.
 * Affects only grouping or subtractions (soft): not empty, warning.
 */
function checkStatInputs(a: Analysis, table: Collection) {
  const key = `table:${table.id}`;
  for (const stat of a.use(table.id)!.stats)
    for (const { table: tableId, field, soft } of stat.inputs) {
      const input = statInputLevel(a, tableId, field);
      if (input === 'entry') continue;
      const name = `${tableId}.${field}`;
      if (input === 'edit')
        a.report(
          key,
          'warning',
          'stat-input-only-in-editor',
          stat.target,
          `${stat.via} needs ${name}, which can only be filled by opening an entry later, so it stays empty until then; add ${field} to the form, preset it or give it a default`,
        );
      else
        a.report(
          key,
          soft ? 'warning' : 'blocker',
          soft ? 'stat-input-unfilled' : 'stat-input-missing',
          stat.target,
          soft
            ? `${stat.via} uses ${name}, but nothing fills it in; add ${field} to the form or a button`
            : `${stat.via} needs ${name}, but nothing fills it in and it has no default, so it always stays empty; add ${field} to the form, preset it in a button, or give it a default`,
        );
    }
}

/** entry = has value upon entry (default value, form, tool writes); edit = can only be opened for editing afterwards; none = unfillable anywhere. */
function statInputLevel(a: Analysis, tableId: string, fieldId: string): 'entry' | 'edit' | 'none' {
  const table = a.table(tableId);
  const use = a.use(tableId);
  if (!table || !use || isSystemField(fieldId)) return 'entry';
  const f = table.fields.find((x) => x.id === fieldId);
  if (!f || isComputed(f) || hasDefault(f)) return 'entry';
  if (use.askedAll || use.asked.has(fieldId) || use.written.has(fieldId)) return 'entry';
  return use.editor || table.fields.some((x) => x.type === 'file') ? 'edit' : 'none';
}

/** Fields that computed fields depend on and that must be filled by someone. */
function computedInputs(a: Analysis, table: Collection, f: Field) {
  const here = (field: string) => ({ table: table.id, field });
  if (f.type === 'formula') {
    const parsed = parseFormula(f.expression);
    return parsed.ok ? parsed.refs.map(here) : [];
  }
  if (f.type === 'previous') return [here(f.field)];
  if (f.type === 'dateOffset')
    return [f.from, ...(typeof f.add === 'string' ? [f.add] : [])]
      .filter((id) => id !== 'createdAt' && id !== 'updatedAt')
      .map(here);
  if (f.type === 'lookup') {
    const via = table.fields.find((x) => x.id === f.via);
    return [here(f.via), ...(via?.type === 'link' ? [{ table: via.table, field: f.field }] : [])];
  }
  if (f.type === 'rollup')
    return [f.via, ...(f.field ? [f.field] : [])].map((field) => ({ table: f.table, field }));
  return [];
}

function fieldHasInput(a: Analysis, tableId: string, fieldId: string): boolean {
  const table = a.table(tableId);
  const use = a.use(tableId);
  if (!table || !use || isSystemField(fieldId)) return true;
  const f = table.fields.find((x) => x.id === fieldId);
  if (!f || isComputed(f) || hasDefault(f)) return true;
  return use.askedAll || use.editor || use.asked.has(fieldId) || use.written.has(fieldId);
}

// App runs on Hermes: this file does not use Unicode property escapes and lookbehind assertions (same as route.ts).
/** Whitespace and punctuation ignored in names (ASCII, general punctuation, Chinese punctuation, full-width punctuation). */
const NAME_PUNCTUATION = /[\s!-/:-@[-`{-~¡-¿‐-‧‰-⁞　-〿！-／：-＠［-｀｛-･]/g;

/** If names or fields are very similar, they represent two tables for the same purpose. */
function similarTables(a: Collection, b: Collection): boolean {
  const norm = (s: string) => s.toLowerCase().replace(NAME_PUNCTUATION, '');
  const [x, y] = [norm(a.name), norm(b.name)];
  if (x === y) return true;
  if (Math.min(x.length, y.length) >= 2 && (x.includes(y) || y.includes(x))) return true;
  const names = (t: Collection) => new Set(t.fields.map((f) => norm(f.name)));
  const [p, q] = [names(a), names(b)];
  if (Math.min(p.size, q.size) < 2) return false;
  const shared = [...p].filter((n) => q.has(n)).length;
  return shared / new Set([...p, ...q]).size >= 0.6;
}

/** Two tables for the same purpose where one is only written to and one is only read from: what is written cannot be seen, and what is seen is empty. */
function checkDuplicates(a: Analysis) {
  const tables = a.config.data.tables;
  const written = (t: Collection) => a.use(t.id)!.adds.length > 0;
  const read = (t: Collection) => a.use(t.id)!.readers.length > 0;
  for (const [i, x] of tables.entries())
    for (const y of tables.slice(i + 1)) {
      const [writer, reader] =
        written(x) && !read(x) && read(y) && !written(y)
          ? [x, y]
          : written(y) && !read(y) && read(x) && !written(x)
            ? [y, x]
            : [null, null];
      if (writer && reader && similarTables(x, y))
        a.report(
          null,
          'warning',
          'duplicate-table',
          `table:${writer.id}`,
          `tables ${writer.id} and ${reader.id} look like the same thing: tools write to ${writer.id} but blocks read ${reader.id}; use one table`,
        );
    }
}

// ---- Reminders ----

/** Pages reachable within one hop from this page's entry point. */
function nextPages(a: Analysis, pageId: string): string[] {
  const page = a.config.containers.pages.find((p) => p.id === pageId);
  return page ? visibleBlocks(page).flatMap(pagesOpenedBy) : [];
}

function checkReminder(a: Analysis, r: Reminder): Set<string> {
  const key = `reminder:${r.id}`;
  const watched = reminderTable(r)?.table;
  const related = watched ? a.relatedTables(watched) : null;
  const failed = new Set<string>();
  const toolId = toolTargetId(r.opens);
  const pageId = pageIdOf(r.opens);
  if (related && watched) {
    const hits = (tables: Iterable<string> | undefined) =>
      [...(tables ?? [])].some((t) => related.has(t));
    if (toolId !== null) {
      const wf = quickActionsOf(a.config).find((x) => x.id === toolId);
      if (wf && !hits(stepRefs(wf, a.registry).map((x) => x.table)))
        a.report(
          null,
          'warning',
          'reminder-opens-unrelated',
          key,
          `reminder ${r.id} watches ${watched} but opens quick action ${toolId}, which doesn't use that table`,
        );
    } else if (pageId === null || !hits(a.pageTables.get(pageId))) {
      const oneHop = pageId !== null && nextPages(a, pageId).some((p) => hits(a.pageTables.get(p)));
      if (oneHop)
        a.report(
          null,
          'warning',
          'reminder-opens-indirect',
          key,
          `reminder ${r.id} watches ${watched}, but page ${pageId} only links to a page that shows it; open that page directly`,
        );
      else if (pageId === 'home')
        // Rule 35 makes new table reminders open the home screen first, with page navigation following: since it is clickable, it is considered usable.
        a.report(
          null,
          'warning',
          'reminder-opens-unrelated',
          key,
          `reminder ${r.id} watches ${watched} but opens the home page, which doesn't show that table yet`,
        );
      else {
        failed.add(watched);
        a.report(
          `table:${watched}`,
          'blocker',
          'reminder-opens-unrelated',
          key,
          `reminder ${r.id} watches ${watched} but opens ${String(r.opens)}, where nothing shows that table; open a page that shows ${watched}`,
        );
      }
    }
  } else if (pageId !== null) {
    // Daily/weekly reminders are not bound to a table, making it unclear where to open: remind only when the page reads and writes nothing; cross-reference when the title clicks a table name.
    const tables = a.pageTables.get(pageId);
    const page = a.config.containers.pages.find((p) => p.id === pageId);
    const useful = page?.blocks.some(
      (c) => isKnownComponent(c) && !c.hidden && !FUNCTIONLESS.has(c.look),
    );
    if (!useful)
      a.report(
        null,
        'warning',
        'reminder-opens-empty',
        key,
        `reminder ${r.id} opens page ${pageId}, which has nothing to do or read`,
      );
    const named = a.config.data.tables.find(
      (t) => t.name.length >= 2 && r.title.toLowerCase().includes(t.name.toLowerCase()),
    );
    if (named && useful && !tables?.has(named.id))
      a.report(
        null,
        'warning',
        'reminder-opens-unrelated',
        key,
        `reminder ${r.id} is about ${named.id} ("${r.title}") but page ${pageId} doesn't show that table`,
      );
  }
  // The table written to by "Done" and the table read by "Don't remind again today" must be the same, otherwise clicking Done will still make it trigger tomorrow.
  if (r.done && r.unless && r.done.table !== r.unless.table && watched) {
    failed.add(watched);
    a.report(
      `table:${watched}`,
      'blocker',
      'reminder-done-wrong-table',
      key,
      `the "done" button of reminder ${r.id} writes to ${r.done.table}, but the reminder stops only when ${r.unless.table} has an entry; make them the same table`,
    );
  }
  return failed;
}

// ---- Quick actions ----

function checkQuickAction(
  a: Analysis,
  wf: QuickAction,
  tableOk: (id: string) => boolean,
): CheckedTool {
  const key = `quickAction:${wf.id}`;
  const problems = workflowProblems(wf, a.registry);
  for (const p of problems) a.report(key, 'blocker', `step-${p.code}`, key, p.message);
  const firstStepIsInput = !problems.some((p) => p.code === 'source');
  const chain = !problems.some((p) => p.code === 'binding');
  const params = !problems.some(
    (p) => p.code === 'params' || p.code === 'ask' || p.code === 'unknown-action',
  );

  const refs = stepRefs(wf, a.registry);
  const receiving = refs.filter((r) => r.field === undefined && 'receives' in r);
  let target = true;
  let place = true;
  for (const ref of refs) {
    const at = `${wf.id}/${wf.steps[ref.index]!.id}`;
    const table = a.table(ref.table);
    if (!table) {
      if (ref.field !== undefined) continue;
      target = false;
      a.report(
        key,
        'blocker',
        'step-table-missing',
        key,
        `${at}: table ${ref.table} does not exist`,
      );
    } else if (ref.field !== undefined) {
      if (!isSystemField(ref.field) && !table.fields.some((f) => f.id === ref.field))
        a.report(
          key,
          'blocker',
          'step-field-missing',
          key,
          `${at}: ${ref.field} is not a field of ${table.id}`,
        );
    } else if ('receives' in ref) {
      const missing = missingPlace(table, ref.receives);
      if (missing) {
        place = false;
        a.report(key, 'blocker', 'record-no-place', key, `${at}: ${table.id} needs ${missing}`);
      }
    }
  }

  const via = [...(a.placed.get(wf.id) ?? [])];
  if (wf.package) via.push(`tool package ${wf.package}`);
  if (wf.preset) via.push('quick action library');
  const kinds = workflowKinds(wf) as readonly string[];
  if (a.libraries.some((k) => k === null || kinds.includes(k))) via.push('library block');
  const entry = via.length > 0 ? 'placed' : 'settings';
  if (entry === 'settings') {
    const page = a.placedUnreachable.get(wf.id);
    a.report(
      key,
      'warning',
      'no-entry',
      key,
      page
        ? `quick action ${wf.id} is only on page ${page}, which can't be opened; it is left in Settings > Quick actions`
        : handedInput(wf.steps, a.registry)
          ? `quick action ${wf.id} takes a record, a value or attachments but sits nowhere that hands them over, so it can't run; put it in a table's recordRow or on a records block (rule 54)`
          : `quick action ${wf.id} is only in Settings > Quick actions; add a button or an action block on a page`,
    );
  }
  const base = { firstStepIsInput, chain, params, entry, entryVia: via } as const;
  const isOk = () => !a.issues.some((x) => x.key === key && x.issue.severity === 'blocker');
  if (receiving.length === 0)
    return {
      kind: 'file',
      id: wf.id,
      name: wf.name,
      ok: isOk(),
      checks: { ...base, entryVia: via },
    };
  const tables = receiving.map((r) => r.table);
  const recordSide = tables.every((t) => a.table(t) === undefined || tableOk(t));
  return {
    kind: 'fileToRecord',
    id: wf.id,
    name: wf.name,
    ok: isOk() && recordSide,
    checks: { ...base, entryVia: via, target, place, recordSide, tables },
  };
}

/** Can the user see this table's records in the app: there is a block reading it, and that page is reachable. */
export function tableIsShown(
  config: WorkspaceConfig,
  tableId: string,
  registry: Registry,
): boolean {
  const a = new Analysis(config, registry);
  return a.use(tableId)?.readers.some((r) => r.reachable) ?? false;
}

/**
 * Tool check: list tools in the config (quick actions, quick actions containing out.addRecord,
 * each table) and their issues. The config should already pass validateWorkspace; this does not
 * re-validate, only determines if they are usable.
 */
export function checkTools(config: WorkspaceConfig, registry: Registry): ToolCheckResult {
  const a = new Analysis(config, registry);
  checkPages(a);
  const live = liveTables(a);
  const records = new Map(config.data.tables.map((t) => [t.id, checkTable(a, t, live)]));
  checkDuplicates(a);
  for (const r of remindersOf(config)) {
    const failed = checkReminder(a, r);
    const watched = reminderTable(r)?.table;
    const checks = watched ? records.get(watched) : undefined;
    if (checks) checks.remind = (checks.remind ?? true) && !failed.has(watched!);
  }
  const blocked = (key: string) =>
    a.issues.some((x) => x.key === key && x.issue.severity === 'blocker');
  const tableOk = (id: string) => !blocked(`table:${id}`);
  const quick = quickActionsOf(config).map((wf) => checkQuickAction(a, wf, tableOk));
  const tables: CheckedTool[] = config.data.tables.map((t) => ({
    kind: 'record',
    id: t.id,
    name: t.name,
    ok: tableOk(t.id) && live.has(t.id),
    checks: records.get(t.id)!,
  }));
  return { tools: [...quick, ...tables], issues: a.issues.map((x) => x.issue) };
}

// ---- Numbers and words mentioned in the user's sentence: did they make it into this change? ----

// Check only high-confidence items: size, pixels, playback speed, page count, target language, ID
// photo background color, resolution. Not checked when the change doesn't touch quick action steps
// (not governed by this sentence); when there are two or more similar numbers ("compress a 500MB
// video to 20MB"), matching either one counts as a match; preceding negation words do not count.
// Prefer false negatives over false positives.

const CHECK_REGISTRY = createRegistry(BUILTIN_TOOLS);

interface ScopeStep {
  wf: QuickAction;
  step: QuickAction['steps'][number];
  fields: readonly {
    key: string;
    unit?: string;
    showIf?: { key: string; equals: readonly (string | number | boolean)[] };
  }[];
}

/** Quick actions touched by this change (newly added or whose steps changed). */
function touchedActions(before: WorkspaceConfig, after: WorkspaceConfig) {
  const old = new Map(quickActionsOf(before).map((w) => [w.id, JSON.stringify(w.steps)]));
  const touched = quickActionsOf(after).filter((w) => old.get(w.id) !== JSON.stringify(w.steps));
  return { touched, added: touched.filter((w) => !old.has(w.id)) };
}

function scopeSteps(actions: readonly QuickAction[]): ScopeStep[] {
  return actions.flatMap((wf) =>
    wf.steps.map((step) => ({
      wf,
      step,
      fields: CHECK_REGISTRY.actions.get(step.action)?.fields ?? [],
    })),
  );
}

/** Whether parameters currently take effect (e.g., quality does not count when "by size", showIf). */
function fieldActive(params: Record<string, unknown>, f: ScopeStep['fields'][number]): boolean {
  if (!f.showIf || params[f.showIf.key] === undefined) return true;
  return f.showIf.equals.includes(params[f.showIf.key] as string | number | boolean);
}

const NEGATED =
  /(?:不要|不是|别|不用|并非|not|no longer|n'est pas|pas|sans|instead of)\s*(?:再|压到|to|de)?\s*$/i;
const isNegated = (input: string, index: number) =>
  NEGATED.test(input.slice(Math.max(0, index - 12), index));

const ZH_DIGITS: Record<string, string> = {
  一: '1',
  二: '2',
  两: '2',
  三: '3',
  四: '4',
  五: '5',
  六: '6',
  七: '7',
  八: '8',
  九: '9',
};

/** Convert Chinese numbers before units into Arabic numerals ("two megs", "double speed"). */
function normalizeNumbers(input: string): string {
  return input
    .replace(/一点五(?=\s*倍)/g, '1.5')
    .replace(/零点五(?=\s*倍)/g, '0.5')
    .replace(/([一二两三四五六七八九])(?=\s*(?:mb|kb|兆|倍速|页))/gi, (d) => ZH_DIGITS[d] ?? d);
}

const num = (s: string) => Number(s.replace(',', '.'));

/** This number immediately follows another number (or decimal point, comma): it is the tail of a longer number and does not count (replaces lookbehind assertions). */
const afterNumber = (input: string, index: number, chars: string) =>
  index > 0 && chars.includes(input[index - 1]!);

/** Size mentioned in the sentence, converted to KB (1 MB = 1024 KB). */
function sizeMentions(input: string, locale: Locale): number[] {
  const out: number[] = [];
  const re =
    /(\d+(?:[.,]\d+)?)\s*(kib|mib|gib|kb|mb|gb|ko|mo|go|千字节|兆字节|兆|M(?![A-Za-z])|K(?![A-Za-z]))/gi;
  for (const m of input.matchAll(re)) {
    const unit = m[2]!;
    const low = unit.toLowerCase();
    const n = num(m[1]!);
    if (afterNumber(input, m.index, '0123456789.,') || isNegated(input, m.index)) continue;
    // "2 mo" in English means two months, "5 go" is a verb: when lowercase, recognize French only.
    if ((low === 'mo' || low === 'go' || low === 'ko') && unit === low && locale !== 'fr') continue;
    // When there is a single letter, it must be uppercase and immediately adjacent to the number (2M, 500K); 4K and 8K are resolutions.
    if (
      (low === 'm' || low === 'k') &&
      (unit !== unit.toUpperCase() || !m[0].endsWith(m[1]! + unit))
    )
      continue;
    if (low === 'k' && n < 10) continue;
    if (low === 'kb' || low === 'kib' || low === 'ko' || low === 'k' || unit === '千字节')
      out.push(n);
    else if (low === 'gb' || low === 'gib' || low === 'go') out.push(n * 1024 * 1024);
    else out.push(n * 1024);
  }
  return out;
}

const SIZE_LIMIT =
  /不超过|不大于|不要超过|别超过|以内|以下|之内|小于|低于|最多|最大|under|below|less than|at most|no more than|not more than|smaller than|up to|moins de|inférieur|en dessous|maximum|\bmax\b|pas plus de/i;

function checkSizes(
  input: string,
  locale: Locale,
  steps: readonly ScopeStep[],
  added: readonly QuickAction[],
): ToolIssue[] {
  const mentions = sizeMentions(input, locale);
  if (mentions.length === 0) return [];
  const values: number[] = [];
  for (const { step, fields } of steps)
    for (const f of fields) {
      const v = step.params[f.key];
      if (
        (f.unit !== 'KB' && f.unit !== 'MB') ||
        typeof v !== 'number' ||
        !fieldActive(step.params, f)
      )
        continue;
      values.push(f.unit === 'KB' ? v : v * 1024);
    }
  const said = mentions.map((kb) => (kb >= 1024 ? `${kb / 1024} MB` : `${kb} KB`)).join(', ');
  const target = `quickAction:${steps[0]!.wf.id}`;
  if (values.length === 0) {
    // No parameters on the entire chain can accommodate size: only newly created quick actions or when the sentence explicitly specifies a target size count as a loss.
    if (
      added.length === 0 ||
      !(SIZE_LIMIT.test(input) || /压|compress|shrink|réduire/i.test(input))
    )
      return [];
    return [
      {
        severity: 'blocker',
        code: 'param-size',
        target: `quickAction:${added[0]!.id}`,
        message: `the user asked for ${said}, but no step of quick action ${added[0]!.id} has a size limit; use a compress step with that limit`,
      },
    ];
  }
  // 1 MB calculated as either 1024 KB or 1000 KB is accepted (2.4% difference). Writing 900 KB for "no more than 1 MB" is also correct.
  const limit = SIZE_LIMIT.test(input);
  const matches = (kb: number) =>
    values.some((v) => Math.abs(v - kb) / Math.max(v, kb) <= 0.025 || (limit && v <= kb));
  if (mentions.some(matches)) return [];
  return [
    {
      severity: 'blocker',
      code: 'param-size',
      target,
      message: `the user asked for ${said}, but the quick action's size limit is ${values
        .map((v) => (v >= 1024 ? `${v / 1024} MB` : `${v} KB`))
        .join(', ')}; write the value they said into maxKB or maxMB (not just clear ask)`,
    },
  ];
}

const PIXEL_KEYS = /^(px|width|height|maxSide|sizePx)$/;

function checkPixels(input: string, steps: readonly ScopeStep[]): ToolIssue[] {
  const mentions = new Set<number>();
  for (const m of input.matchAll(/(\d{2,5})\s*(?:px|pixels?|像素)/gi))
    if (!afterNumber(input, m.index, '0123456789.') && !isNegated(input, m.index))
      mentions.add(Number(m[1]));
  for (const m of input.matchAll(
    /(\d{2,5})\s*[x×*]\s*(\d{2,5})(?!\d|\s*(?:cm|mm|in\b|英寸|寸|厘米|毫米))/gi,
  )) {
    if (afterNumber(input, m.index, '0123456789.')) continue;
    mentions.add(Number(m[1]));
    mentions.add(Number(m[2]));
  }
  if (mentions.size === 0) return [];
  // Dimensions for ID photos, print layouts, and cropping are determined by specifications (600x600 is us-passport), so mismatches are not necessarily incorrect.
  if (steps.some((s) => /^image\.(idPhoto|printSheet|crop)$/.test(s.step.action))) return [];
  const values: number[] = [];
  for (const { step, fields } of steps)
    for (const f of fields) {
      const v = step.params[f.key];
      if (!PIXEL_KEYS.test(f.key) || !fieldActive(step.params, f)) continue;
      const n = typeof v === 'string' ? Number(v) : v;
      if (typeof n === 'number' && !Number.isNaN(n)) values.push(n);
    }
  const percent = steps.some(
    (s) => s.step.action === 'image.resize' && s.step.params.mode === 'percent',
  );
  if (values.length === 0 && !percent) return [];
  if ([...mentions].some((n) => values.includes(n))) return [];
  const said = [...mentions].join(', ');
  return [
    {
      severity: 'blocker',
      code: 'param-pixels',
      target: `quickAction:${steps[0]!.wf.id}`,
      message: `the user asked for ${said} pixels, but the quick action uses ${values.join(', ') || 'a percentage'}; write the value they said`,
    },
  ];
}

function speedMentions(input: string): number[] {
  const out: number[] = [];
  const patterns = [
    /(\d+(?:\.\d+)?)\s*倍速/g,
    /倍速\s*(\d+(?:\.\d+)?)/g,
    /加速\s*(\d+(?:\.\d+)?)\s*倍/g,
    /(\d+(?:[.,]\d+)?)\s*[x×]\s*(?:speed|faster|vitesse)/gi,
    /(?:speed|vitesse)[^.。!?\d]{0,12}?[x×]\s*(\d+(?:[.,]\d+)?)/gi,
    /(\d+(?:[.,]\d+)?)\s*(?:times|fois)\s*(?:faster|plus vite)/gi,
    /(?:speed up|accélérer|accelerer)[^.。!?\d]{0,20}?(\d+(?:[.,]\d+)?)\s*(?:[x×]|times|fois)/gi,
  ];
  for (const re of patterns) for (const m of input.matchAll(re)) out.push(num(m[1]!));
  return out;
}

function checkSpeed(input: string, steps: readonly ScopeStep[]): ToolIssue[] {
  const mentions = speedMentions(input);
  if (mentions.length === 0) return [];
  const speed = steps.filter(
    (s) => s.step.action === 'video.speed' || s.step.action === 'audio.fromText',
  );
  if (speed.length === 0) return [];
  const values = speed.map((s) => Number(s.step.params.factor ?? s.step.params.rate));
  if (mentions.some((m) => values.includes(m))) return [];
  return [
    {
      severity: 'blocker',
      code: 'param-speed',
      target: `quickAction:${speed[0]!.wf.id}`,
      message: `the user asked for ${mentions.join(', ')}x speed, but the quick action uses ${values.join(', ')}x; write the value they said`,
    },
  ];
}

function checkPageCounts(input: string, steps: readonly ScopeStep[]): ToolIssue[] {
  const issues: ToolIssue[] = [];
  const every = /每\s*(\d+)\s*页|every\s+(\d+)\s+pages?|toutes les\s+(\d+)\s+pages/i.exec(input);
  const split = steps.filter((s) => s.step.action === 'pdf.split');
  if (every && split.length > 0) {
    const n = Number(every[1] ?? every[2] ?? every[3]);
    if (!split.some((s) => s.step.params.mode === 'every' && s.step.params.n === n))
      issues.push({
        severity: 'blocker',
        code: 'param-pages',
        target: `quickAction:${split[0]!.wf.id}`,
        message: `the user asked to split every ${n} pages, but pdf.split doesn't have mode "every" with n ${n}`,
      });
  }
  const range =
    /第\s*(\d+)\s*(?:[-–~到至]\s*(?:第\s*)?(\d+)\s*)?页|pages?\s+(\d+)\s*(?:-|–|to|à|through)\s*(\d+)/i.exec(
      input,
    );
  const ranged = steps.filter((s) => ['pdf.selectPages', 'pdf.rotate'].includes(s.step.action));
  if (range && ranged.length > 0) {
    const from = range[1] ?? range[3];
    const to = range[2] ?? range[4];
    // "Page 1" can be written as rule first; do not check.
    if (to !== undefined || from !== '1') {
      const has = (s: ScopeStep) => {
        const text = String(s.step.params.range ?? '');
        const tokens = text.split(/[^\d]+/);
        return (
          s.step.params.rule === 'range' &&
          tokens.includes(from!) &&
          (to === undefined || tokens.includes(to))
        );
      };
      if (!ranged.some(has))
        issues.push({
          severity: 'blocker',
          code: 'param-pages',
          target: `quickAction:${ranged[0]!.wf.id}`,
          message: `the user asked for pages ${from}${to ? `-${to}` : ''}, but ${ranged[0]!.step.action} doesn't have rule "range" with those pages`,
        });
    }
  }
  return issues;
}

/** Language designations -> translate.text's `to`. Both types of Chinese count (when traditional/simplified is unspecified). */
const LANGUAGE_WORDS: readonly [RegExp, readonly string[]][] = [
  [/^(?:繁体中文|繁体|繁體|traditional chinese|chinois traditionnel)/i, ['zh-Hant']],
  [/^(?:简体中文|简体|simplified chinese|chinois simplifié)/i, ['zh-Hans']],
  [/^(?:中文|汉语|chinese|chinois)/i, ['zh-Hans', 'zh-Hant']],
  [/^(?:英文|英语|english|anglais)/i, ['en']],
  [/^(?:法文|法语|french|français|francais)/i, ['fr']],
  [/^(?:日文|日语|japanese|japonais)/i, ['ja']],
  [/^(?:韩文|韩语|korean|coréen|coreen)/i, ['ko']],
  [/^(?:德文|德语|german|allemand)/i, ['de']],
  [/^(?:西班牙文|西班牙语|spanish|espagnol)/i, ['es']],
  [/^(?:葡萄牙文|葡萄牙语|portuguese|portugais)/i, ['pt']],
  [/^(?:意大利文|意大利语|italian|italien)/i, ['it']],
  [/^(?:俄文|俄语|russian|russe)/i, ['ru']],
  [/^(?:越南文|越南语|vietnamese|vietnamien)/i, ['vi']],
];

const TRANSLATE_TARGET =
  /(?:翻译|翻|译)\s*(?:成|为|到)\s*|translat\w*\b[^.。!?]{0,60}?\b(?:in)?to\s+|tradui\w*\b[^.。!?]{0,60}?\b(?:en|vers(?:\s+l['’]|\s+le\s+)?)\s*/gi;

/** Phrases omitting "translate" ("turn into an English PDF"): only counts if the plan already contains a translation step, otherwise "change to Chinese" might mean something else. */
const LOOSE_TARGET = /(?:变成|转成|换成|改成|做成)\s*/g;

/** Translation targets mentioned in the sentence (a group of accepted languages for each phrasing). */
function languageMentions(input: string, loose: boolean): (readonly string[])[] {
  const out: (readonly string[])[] = [];
  for (const m of [
    ...input.matchAll(TRANSLATE_TARGET),
    ...(loose ? input.matchAll(LOOSE_TARGET) : []),
  ]) {
    const rest = input.slice(m.index + m[0].length);
    const hit = LANGUAGE_WORDS.find(([re]) => re.test(rest));
    if (hit) out.push(hit[1]);
  }
  return out;
}

function checkLanguage(
  input: string,
  steps: readonly ScopeStep[],
  added: readonly QuickAction[],
): ToolIssue[] {
  const translate = steps.filter((s) => s.step.action === 'translate.text');
  const mentions = languageMentions(input, translate.length > 0);
  if (mentions.length === 0) return [];
  const said = mentions.map((m) => m[0]).join(', ');
  if (translate.length === 0) {
    if (added.length === 0) return [];
    return [
      {
        severity: 'blocker',
        code: 'param-language',
        target: `quickAction:${added[0]!.id}`,
        message: `the user asked for a translation to ${said}, but quick action ${added[0]!.id} has no translate.text step`,
      },
    ];
  }
  const values = translate.map((s) => String(s.step.params.to));
  if (mentions.some((m) => m.some((lang) => values.includes(lang)))) return [];
  return [
    {
      severity: 'blocker',
      code: 'param-language',
      target: `quickAction:${translate[0]!.wf.id}`,
      message: `the user asked for a translation to ${said}, but translate.text has to: ${values.join(', ')}; set to the language they said`,
    },
  ];
}

const BACKGROUND_WORDS: readonly [RegExp, string][] = [
  [/蓝色?(?:底|背景)|blue\s+(?:background|backdrop)|fond\s+bleu/i, 'blue'],
  [/白色?(?:底|背景)|white\s+(?:background|backdrop)|fond\s+blanc/i, 'white'],
  [/红色?(?:底|背景)|red\s+(?:background|backdrop)|fond\s+rouge/i, 'red'],
  [/灰色?(?:底|背景)|gr[ae]y\s+(?:background|backdrop)|fond\s+gris/i, 'gray'],
];

function checkBackground(input: string, steps: readonly ScopeStep[]): ToolIssue[] {
  const said = BACKGROUND_WORDS.filter(([re]) => re.test(input)).map(([, v]) => v);
  const photo = steps.filter((s) => s.step.action === 'image.idPhoto');
  if (said.length === 0 || photo.length === 0) return [];
  const values = photo.map((s) => s.step.params.background);
  if (values.includes('custom') || values.some((v) => said.includes(String(v)))) return [];
  return [
    {
      severity: 'blocker',
      code: 'param-background',
      target: `quickAction:${photo[0]!.wf.id}`,
      message: `the user asked for a ${said.join(' or ')} background, but image.idPhoto has background: ${values.map(String).join(', ')}`,
    },
  ];
}

function checkResolution(input: string, steps: readonly ScopeStep[]): ToolIssue[] {
  const mentions = [...input.matchAll(/(480|720|1080)\s*p\b/gi)]
    .filter((m) => !afterNumber(input, m.index, '0123456789'))
    .map((m) => `${m[1]}p`);
  const video = steps.filter((s) => s.step.action === 'video.compress');
  if (mentions.length === 0 || video.length === 0) return [];
  const hit = video.some(
    (s) => s.step.params.by === 'quality' && mentions.includes(String(s.step.params.quality)),
  );
  if (hit) return [];
  return [
    {
      severity: 'blocker',
      code: 'param-resolution',
      target: `quickAction:${video[0]!.wf.id}`,
      message: `the user asked for ${mentions.join(', ')}, but video.compress doesn't have by "quality" with that quality`,
    },
  ];
}

/**
 * Whether numbers and words explicitly mentioned in the user's sentence made it into this change.
 * `input` is the user's exact wording (used locally only, never sent out). Report high-confidence
 * matches only; a mismatch is a blocker; do not report if uncertain.
 */
export function checkRequestParams(
  input: string,
  locale: Locale,
  before: WorkspaceConfig,
  after: WorkspaceConfig,
): ToolIssue[] {
  const { touched, added } = touchedActions(before, after);
  if (touched.length === 0) return [];
  const steps = scopeSteps(touched);
  const text = normalizeNumbers(input);
  return [
    ...checkSizes(text, locale, steps, added),
    ...checkPixels(text, steps),
    ...checkSpeed(text, steps),
    ...checkPageCounts(text, steps),
    ...checkLanguage(text, steps, added),
    ...checkBackground(text, steps),
    ...checkResolution(text, steps),
  ];
}
