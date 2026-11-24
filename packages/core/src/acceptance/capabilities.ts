import { isSystemField } from '../components/define';
import { parseFormula } from '../formula';
import {
  isOpenUse,
  isCopyValue,
  isDateValue,
  isRecordToolUse,
  tapAlsoOf,
  type RecordTool,
  type RecordToolValues,
  type ToolUse,
  type ToolUseAs,
} from '../record-ops-schema';
import type { Registry } from '../registry';
import {
  RECORD_LOOKS,
  childrenOf,
  fieldDefinition,
  isKnownComponent,
  pageIdOf,
  quickActionsOf,
  remindersOf,
  tablesOf,
  toolTargetId,
  type BlockOf,
  type Collection,
  type Component,
  type Condition,
  type Field,
  type KnownComponent,
  type Page,
  type QuickAction,
  type RecordLook,
  type Reminder,
  type WorkspaceConfig,
} from '../schema';
import { GROUP_REF, HERE_REF, RECORD_REF, ROW_REF } from '../schema-primitives';
import { dateFieldOf } from '../sequence';
import { checkTools, type ToolCheckResult } from '../tool-check';
import { stepRefs } from '../workflow/refs';

// A block touchable by the user (AGENT_PLAN §3.2, founder 2026-11-03: The personal record features
// achievable by the app are limited, enabling stable acceptance testing). Each capability is a pure
// function predicate checking only config, independent of table names or field IDs: any
// construction satisfying it counts. Only counts what the user can touch: hidden blocks,
// inaccessible pages, and disabled reminders are excluded. Integrity guard in
// `capabilities.test.ts`: if registry and schema add an item while capabilities list drops one, the
// test fails.

/** A block touchable by the user. */
export interface PlacedBlock {
  page: Page;
  block: KnownComponent;
}

/** A write trigger touchable by the user. */
export interface PlacedWrite {
  tool: RecordTool;
  /** Appearance mode; `self` is the block itself being tapped (button), `done` is "Complete" on notifications. */
  as: ToolUseAs | 'self' | 'done';
  /** Which record row the tool acts upon (`$row`); absent means no pre-existing record is required. */
  rowOf?: string;
  block?: PlacedBlock;
  reminder?: Reminder;
  when: boolean;
}

/** Quick action passing files or text to a new record form (`out.addRecord`). */
export interface FileIntake {
  action: QuickAction;
  table: string;
  /** Placed on pages, mobile home screen, etc.; not only in "Settings -> Quick Actions". */
  placed: boolean;
  /** Linked, parameters complete, table contains a file-holding field. */
  ok: boolean;
  /** The first step is taking a photo or scanning. */
  camera: boolean;
  /** Input data consists of files (rather than text). */
  files: boolean;
}

export interface AppView {
  config: WorkspaceConfig;
  registry: Registry;
  health: ToolCheckResult;
  pages: Page[];
  blocks: PlacedBlock[];
  writes: PlacedWrite[];
  reminders: Reminder[];
  intakes: FileIntake[];
}

function visible(page: Page): KnownComponent[] {
  const walk = (list: readonly Component[]): KnownComponent[] =>
    list.flatMap((c) =>
      c.hidden || !isKnownComponent(c) ? [] : [c, ...walk(childrenOf(c) as Component[])],
    );
  return walk(page.blocks);
}

const toolsOf = (c: KnownComponent): ToolUse[] => (c as { tools?: ToolUse[] }).tools ?? [];

const isRecordLook = (c: KnownComponent) => (RECORD_LOOKS as readonly string[]).includes(c.look);

type RecordBlock = Extract<KnownComponent, { look: RecordLook }>;
type NumberBlock = Extract<KnownComponent, { look: 'number' }>;
type ChartBlock = Extract<KnownComponent, { look: 'chart' }>;

/** Config -> Things touchable by the user. Whether pages are accessible is determined by tool checks without recalculating. */
export function viewOf(config: WorkspaceConfig, registry: Registry): AppView {
  const health = checkTools(config, registry);
  const lost = new Set(
    health.issues.filter((i) => i.code === 'page-unreachable').map((i) => i.target),
  );
  const pages = config.containers.pages.filter((p) => !lost.has(`page:${p.id}`));
  const blocks = pages.flatMap((page) => visible(page).map((block) => ({ page, block })));
  const reminders = remindersOf(config).filter((r) => r.enabled);
  const writes: PlacedWrite[] = [];
  for (const placed of blocks) {
    const { block } = placed;
    const source = isRecordLook(block) ? (block as RecordBlock).source.table : undefined;
    for (const use of toolsOf(block)) {
      if (!isRecordToolUse(use)) continue;
      const { as, label: _label, when, ...tool } = use;
      writes.push({
        tool: tool as RecordTool,
        as: as ?? 'self',
        ...(source !== undefined && as !== 'addHere' ? { rowOf: source } : {}),
        block: placed,
        when: when !== undefined,
      });
    }
  }
  for (const r of reminders)
    if (r.done)
      writes.push({
        tool: r.done,
        as: 'done',
        ...('each' in r.when ? { rowOf: r.when.each.table } : {}),
        reminder: r,
        when: false,
      });
  const intakes: FileIntake[] = [];
  for (const action of quickActionsOf(config)) {
    const checked = health.tools.find((t) => t.kind === 'fileToRecord' && t.id === action.id);
    for (const ref of stepRefs(action, registry)) {
      if (ref.field !== undefined || !('receives' in ref)) continue;
      const first = action.steps[0];
      const source = first?.params.source;
      intakes.push({
        action,
        table: ref.table,
        placed:
          checked !== undefined && 'entry' in checked.checks && checked.checks.entry === 'placed',
        ok: checked?.ok === true,
        camera: first?.action === 'in.photos' && (source === 'camera' || source === 'scanner'),
        files: ref.receives !== 'text',
      });
    }
  }
  return { config, registry, health, pages, blocks, writes, reminders, intakes };
}

// ---- Helper functions for reading config (also used by scenario predicates) ----

export const tableOf = (v: AppView, id: string): Collection | undefined =>
  tablesOf(v.config).find((t) => t.id === id);

const fieldIn = (table: Collection | undefined, id: string): Field | undefined =>
  table?.fields.find((f) => f.id === id);

export const tableIds = (v: AppView): string[] => tablesOf(v.config).map((t) => t.id);

export const recordBlocks = (v: AppView, table?: string): RecordBlock[] =>
  v.blocks
    .map((x) => x.block)
    .filter(isRecordLook)
    .map((c) => c as RecordBlock)
    .filter((c) => table === undefined || c.source.table === table);

export const numberBlocks = (v: AppView, table?: string): NumberBlock[] =>
  v.blocks
    .map((x) => x.block)
    .filter((c): c is NumberBlock => c.look === 'number')
    .filter((c) => table === undefined || c.source.table === table);

export const chartBlocks = (v: AppView, table?: string): ChartBlock[] =>
  v.blocks
    .map((x) => x.block)
    .filter((c): c is ChartBlock => c.look === 'chart')
    .filter((c) => table === undefined || c.source.table === table);

const presetsOf = (w: PlacedWrite): string[] => {
  if (w.tool.do !== 'create') return [];
  const { values } = w.tool;
  if (values === HERE_REF) {
    const source = w.block && isRecordLook(w.block.block) && (w.block.block as RecordBlock).source;
    if (!source) return [];
    return [
      ...(source.group?.by ? [source.group.by] : []),
      ...(source.filter ?? [])
        .filter((c) => c.op === 'is' && !Array.isArray(c.value))
        .map((c) => c.field),
    ];
  }
  return Object.keys((values as RecordToolValues | undefined) ?? {});
};

/** Whether this new entry creation will prompt for this field (filled by the user). */
function asksField(w: PlacedWrite, field: string): boolean {
  if (w.tool.do !== 'create') return false;
  const { ask, smartDate } = w.tool;
  return ask === 'all' || (Array.isArray(ask) && ask.includes(field)) || smartDate?.to === field;
}

/** Whether this new entry creation provides a value for this field (prompted or preset). */
export const createCovers = (w: PlacedWrite, field: string): boolean =>
  asksField(w, field) || presetsOf(w).includes(field);

const isComputed = (f: Field) => fieldDefinition(f.type).inForm === false;

const hasDefault = (f: Field) =>
  ('default' in f && f.default !== undefined) || fieldDefinition(f.type).emptyNew !== undefined;

/** New creation can be saved: all required fields have values. */
function createSaves(w: PlacedWrite, table: Collection): boolean {
  return table.fields.every(
    (f) =>
      !('required' in f) ||
      !f.required ||
      isComputed(f) ||
      !fieldDefinition(f.type).write ||
      hasDefault(f) ||
      createCovers(w, f.id),
  );
}

export const createsOn = (v: AppView, table: string): PlacedWrite[] =>
  v.writes.filter((w) => w.tool.do === 'create' && w.tool.table === table);

/**
 * The table starts with zero records, and the user can add entries: via forms, buttons, inline
 * adding, quick actions, or buttons on each row of another table (where that table itself allows
 * adding). "Copy a row" on each row cannot be the starting point.
 */
export function canAdd(v: AppView, table: string, seen: ReadonlySet<string> = new Set()): boolean {
  if (seen.has(table)) return false;
  const t = tableOf(v, table);
  if (!t) return false;
  if (v.intakes.some((x) => x.table === table && x.ok)) return true;
  const next = new Set([...seen, table]);
  return createsOn(v, table).some(
    (w) =>
      createSaves(w, t) &&
      (w.rowOf === undefined || (w.rowOf !== table && canAdd(v, w.rowOf, next))),
  );
}

/** Write entry (asked during creation, preset, or per-row tool) can write to this field. Excludes default values and opening the edit page. */
export function entryWrites(v: AppView, table: string, field: string): boolean {
  if (v.intakes.some((x) => x.table === table && x.ok)) return true;
  return v.writes.some(
    (w) =>
      w.tool.table === table &&
      (w.tool.do === 'create'
        ? createCovers(w, field)
        : w.tool.do === 'createAll'
          ? Object.prototype.hasOwnProperty.call(w.tool.values, field)
          : w.tool.do !== 'remove' && w.tool.field === field),
  );
}

/** The user can select this field themselves at the write entry (form prompt). */
export const entryAsks = (v: AppView, table: string, field: string): boolean =>
  v.intakes.some((x) => x.table === table && x.ok) ||
  createsOn(v, table).some((w) => asksField(w, field));

/** The new record has a value for this field: system field, computed, has default value, or writable by a write entry. */
export function entryFills(v: AppView, table: string, field: string): boolean {
  if (isSystemField(field)) return true;
  const f = fieldIn(tableOf(v, table), field);
  if (!f) return false;
  return isComputed(f) || hasDefault(f) || entryWrites(v, table, field);
}

/** Which field to use when calculating by date for this table (defaults to dateFieldOf when not specified). */
export function dayField(v: AppView, table: string, date?: string): string {
  const t = tableOf(v, table);
  return t ? dateFieldOf(t, date) : 'createdAt';
}

/** A condition requires the field to have a value to possibly hold (isEmpty and isNot also hold when empty). */
const needsValue = (c: Condition) => c.op !== 'isEmpty' && c.op !== 'isNot';

/** Fields depended on by this statistic or chart (value, date, filter, grouping) all have values at the write entry: the statistic will not be permanently empty. */
export function statInputsFilled(v: AppView, block: NumberBlock | ChartBlock): boolean {
  const { table, field, filter, group, days, aggregate } = block.source;
  const needed = new Set<string>();
  if (field && aggregate !== 'count' && aggregate !== 'distinctDays') needed.add(field);
  for (const c of filter ?? []) if (needsValue(c)) needed.add(c.field);
  if (group?.by) needed.add(group.by);
  if (group?.unit) needed.add(dayField(v, table, group.by));
  if (['streak', 'daysSince', 'avgInterval', 'distinctDays'].includes(aggregate))
    needed.add(dayField(v, table, days?.date));
  return [...needed].every((id) => entryFills(v, table, id));
}

/** The new record has this field as soon as it is saved: default value, or asked during creation, or preset. Excludes subsequent per-row tools. */
export function createFills(v: AppView, table: string, field: string): boolean {
  const f = fieldIn(tableOf(v, table), field);
  if (!f) return false;
  return (
    hasDefault(f) ||
    v.intakes.some((x) => x.table === table && x.ok) ||
    createsOn(v, table).some((w) => createCovers(w, field))
  );
}

/** This field is displayed: list slots, number, or chart read values. */
export function displayed(v: AppView, table: string, field: string): boolean {
  const shownInRecords = recordBlocks(v, table).some(({ show }) =>
    [show.title, ...(show.subtitles ?? []), show.trailing, show.color].includes(field),
  );
  return (
    shownInRecords ||
    [...numberBlocks(v, table), ...chartBlocks(v, table)].some((b) => b.source.field === field)
  );
}

export interface PlacedRollup {
  host: string;
  field: Extract<Field, { type: 'rollup' }>;
}

/** Rollups over this table and whose fields are displayed. */
export const rollupsOver = (v: AppView, table: string): PlacedRollup[] =>
  tablesOf(v.config).flatMap((host) =>
    host.fields.flatMap((field) =>
      field.type === 'rollup' && field.table === table && displayed(v, host.id, field.id)
        ? [{ host: host.id, field }]
        : [],
    ),
  );

/** Fields depended on by rollups have values at the write entry. */
export function rollupInputsFilled(v: AppView, { field }: PlacedRollup): boolean {
  const needed = new Set([field.via]);
  if (field.field && field.aggregate !== 'count' && field.aggregate !== 'distinctDays')
    needed.add(field.field);
  for (const c of field.filter ?? []) if (needsValue(c)) needed.add(c.field);
  if (['streak', 'daysSince', 'avgInterval', 'distinctDays', 'latest'].includes(field.aggregate))
    needed.add(dayField(v, field.table, field.days?.date));
  return [...needed].every((id) => entryFills(v, field.table, id));
}

/** These aggregations can be calculated on records of this table (number blocks, or rollup fields displayed on another table). */
export function aggregatesOn(v: AppView, table: string, kinds: readonly string[]): boolean {
  return (
    numberBlocks(v, table).some(
      (b) => kinds.includes(b.source.aggregate) && statInputsFilled(v, b),
    ) ||
    rollupsOver(v, table).some((r) => kinds.includes(r.field.aggregate) && rollupInputsFilled(v, r))
  );
}

/** Requires no input, writes with a single tap. */
export const isOneTap = (w: PlacedWrite): boolean => {
  if (!['tap', 'button', 'check', 'self'].includes(w.as)) return false;
  if (w.tool.do === 'create') return w.tool.ask === undefined && w.tool.values !== HERE_REF;
  return w.tool.do !== 'setAll';
};

/** The row that this tool acts upon exists (if records are required first, that table must allow adding). */
export const rowExists = (v: AppView, w: PlacedWrite): boolean =>
  w.rowOf === undefined || canAdd(v, w.rowOf);

/** This new creation records the date: date field has a preset, default, or is simply the creation time. */
export function createKnowsDay(v: AppView, w: PlacedWrite): boolean {
  if (w.tool.do !== 'create') return false;
  const table = w.tool.table;
  const id = dayField(v, table);
  if (isSystemField(id)) return true;
  const f = fieldIn(tableOf(v, table), id);
  return f !== undefined && (hasDefault(f) || createCovers(w, id));
}

/** Create a new record with a single tap, remembering today: streak and calendar recognize only this type. */
export const oneTapCreateTables = (v: AppView): Set<string> =>
  new Set(
    v.writes
      .filter((w) => {
        const table = tableOf(v, w.tool.table);
        return (
          w.tool.do === 'create' &&
          isOneTap(w) &&
          table !== undefined &&
          createSaves(w, table) &&
          rowExists(v, w) &&
          createKnowsDay(v, w)
        );
      })
      .map((w) => w.tool.table),
  );

/** Considered logged with a single tap (creating a record, checking a box, incrementing by one, writing today, any kind). */
export const oneTapTables = (v: AppView): Set<string> =>
  new Set([
    ...oneTapCreateTables(v),
    ...v.writes
      .filter((w) => w.tool.do !== 'create' && isOneTap(w) && rowExists(v, w))
      .map((w) => w.tool.table),
  ]);

/** Blocks on this page read or write this table. */
export function pageTouches(v: AppView, pageId: string, table: string): boolean {
  return v.blocks.some(
    ({ page, block }) =>
      page.id === pageId &&
      ((block as { source?: { table?: string } }).source?.table === table ||
        toolsOf(block).some((u) => isRecordToolUse(u) && u.table === table)),
  );
}

/** Reminder time (after has no time). */
export const reminderTime = (r: Reminder): string | null => ('at' in r.when ? r.when.at : null);

/** Tapping this reminder can view or write to this table: opened pages touch this table, or quick actions use this table. */
export function reminderReaches(v: AppView, r: Reminder, table: string): boolean {
  const page = pageIdOf(r.opens);
  if (page !== null) return pageTouches(v, page, table);
  const tool = toolTargetId(r.opens);
  const wf = tool === null ? undefined : quickActionsOf(v.config).find((x) => x.id === tool);
  return wf !== undefined && stepRefs(wf, v.registry).some((ref) => ref.table === table);
}

/** After completion, the next one is scheduled later: schedule's lastDone is written by a tool on each row of this table (writing a date, or creating a new record in the completion table). */
/**
 * Tap on each row to create a new completion record: written to another table, reference field
 * points back to this row (Todoist-style completion table). Excludes those requiring input
 * ("Write a comment" connected back this way is also excluded).
 */
export function completionCreates(v: AppView, table: string): PlacedWrite[] {
  return v.writes.filter((w) => {
    if (w.tool.do !== 'create' || w.rowOf !== table || w.tool.table === table) return false;
    const target = tableOf(v, w.tool.table);
    if (!target || !isOneTap(w) || !createSaves(w, target) || !rowExists(v, w)) return false;
    const values = w.tool.values;
    return target.fields.some(
      (f) =>
        f.type === 'link' &&
        f.table === table &&
        values !== HERE_REF &&
        (values as RecordToolValues | undefined)?.[f.id] === '$row',
    );
  });
}

export function completionReschedules(v: AppView, table: string): boolean {
  const t = tableOf(v, table);
  for (const f of t?.fields ?? []) {
    if (f.type !== 'schedule' || !f.lastDone) continue;
    const last = fieldIn(t, f.lastDone);
    if (!last) continue;
    if (last.type !== 'rollup') {
      if (
        v.writes.some(
          (w) =>
            w.as !== 'done' &&
            w.tool.do === 'set' &&
            w.tool.table === table &&
            w.tool.field === last.id &&
            (w.tool.value === 'today' || w.tool.value === 'now') &&
            rowExists(v, w),
        )
      )
        return true;
      continue;
    }
    const via = last.via;
    if (
      v.writes.some(
        (w) =>
          w.as !== 'done' &&
          w.tool.do === 'create' &&
          w.tool.table === last.table &&
          w.rowOf === table &&
          presetsOf(w).includes(via) &&
          createKnowsDay(v, w),
      )
    )
      return true;
  }
  return false;
}

/** All filter conditions used in the config (blocks, rollup fields, button when without subdivision, reminder unless). */
function allConditions(v: AppView): Condition[] {
  const out: Condition[] = [];
  for (const { block } of v.blocks) {
    // Files blocks filter files, not records.
    if (block.look === 'files') continue;
    const source = (
      block as {
        source?: {
          filter?: Condition[];
          group?: { filter?: Condition[] };
          minus?: { filter?: Condition[] };
          calc?: { with: { filter?: Condition[] }[] };
        };
      }
    ).source;
    out.push(
      ...(source?.filter ?? []),
      ...(source?.group?.filter ?? []),
      ...(source?.minus?.filter ?? []),
      ...(source?.calc?.with.flatMap((t) => t.filter ?? []) ?? []),
    );
    for (const u of toolsOf(block)) out.push(...(u.when ?? []));
  }
  for (const t of tablesOf(v.config))
    for (const f of t.fields) if (f.type === 'rollup') out.push(...(f.filter ?? []));
  for (const r of v.reminders) out.push(...(r.unless?.filter ?? []));
  for (const w of v.writes) if (w.tool.do === 'setAll') out.push(...(w.tool.filter ?? []));
  return out;
}

function allFields(v: AppView): { table: Collection; field: Field }[] {
  return tablesOf(v.config).flatMap((table) => table.fields.map((field) => ({ table, field })));
}

function fieldUsed(v: AppView, type: Field['type']): boolean {
  return allFields(v).some((x) => x.field.type === type);
}

function aggregateUsed(v: AppView, kind: string): boolean {
  return (
    numberBlocks(v).some((b) => b.source.aggregate === kind) ||
    chartBlocks(v).some((b) => b.source.aggregate === kind) ||
    allFields(v).some((x) => x.field.type === 'rollup' && x.field.aggregate === kind)
  );
}

const blocksWithGroup = (v: AppView) =>
  v.blocks
    .map((x) => x.block as { source?: { group?: NonNullable<RecordBlock['source']['group']> } })
    .flatMap((b) => (b.source?.group ? [b.source.group] : []));

function groupByType(v: AppView, types: readonly string[]): boolean {
  return [...recordBlocks(v), ...numberBlocks(v), ...chartBlocks(v)].some((b) => {
    const by = b.source.group?.by;
    const f = by === undefined ? undefined : fieldIn(tableOf(v, b.source.table), by);
    return f !== undefined && types.includes(f.type);
  });
}

const whenIs = (v: AppView, key: 'each' | 'after') => v.reminders.some((r) => key in r.when);

const valueUsed = (v: AppView, value: unknown) =>
  v.writes.some((w) => {
    const { tool } = w;
    if (tool.do === 'create') {
      if (tool.values === value) return true;
      return Object.values((tool.values as RecordToolValues | undefined) ?? {}).includes(
        value as never,
      );
    }
    return (tool.do === 'set' || tool.do === 'setAll') && tool.value === value;
  });

/** Values written by all one-tap logging tools (used by object syntax in D-565). */
const valuesUsed = (v: AppView): unknown[] =>
  v.writes.flatMap(({ tool }) =>
    tool.do === 'create' || tool.do === 'createAll'
      ? Object.values(typeof tool.values === 'object' ? tool.values : {})
      : tool.do === 'set' || tool.do === 'setAll'
        ? [tool.value]
        : [],
  );

const usesOpen = (v: AppView) =>
  v.blocks.some(({ block }) => toolsOf(block).some((u) => isOpenUse(u) && u.opens === 'record'));

// ---- Capabilities Table ----

export type CapabilityGroup = 'field' | 'write' | 'read' | 'remind' | 'connect';

export interface Capability {
  id: string;
  group: CapabilityGroup;
  test: (v: AppView) => boolean;
}

const cap = (id: string, group: CapabilityGroup, test: Capability['test']): Capability => ({
  id,
  group,
  test,
});
const fieldCap = (type: Field['type']) => cap(`field.${type}`, 'field', (v) => fieldUsed(v, type));
const doCap = (kind: RecordTool['do']) =>
  cap(`write.do.${kind}`, 'write', (v) => v.writes.some((w) => w.tool.do === kind));
const asCap = (as: ToolUseAs) =>
  // as: "list" does not write records, runs quick actions (D-428).
  cap(`write.as.${as}`, 'write', (v) =>
    as === 'list'
      ? v.blocks.some((x) =>
          ((x.block as { tools?: ToolUse[] }).tools ?? []).some((u) => u.as === 'list'),
        )
      : v.writes.some((w) => w.as === as),
  );
const browseOf = (v: AppView) =>
  v.blocks.flatMap((x) => {
    const browse = (x.block as { show?: { browse?: BlockOf<'list'>['show']['browse'] } }).show
      ?.browse;
    return browse ? [browse] : [];
  });
const lookCap = (look: string) =>
  cap(`read.look.${look}`, 'read', (v) => v.blocks.some((x) => x.block.look === look));
const aggregateCap = (kind: string) =>
  cap(`read.aggregate.${kind}`, 'read', (v) => aggregateUsed(v, kind));
const opCap = (op: Condition['op']) =>
  cap(`read.op.${op}`, 'read', (v) => allConditions(v).some((c) => c.op === op));
const periodCap = (period: string) =>
  cap(`read.period.${period}`, 'read', (v) =>
    allConditions(v).some((c) => c.op === 'inPeriod' && c.value === period),
  );
const unitCap = (unit: string) =>
  cap(`read.group.unit.${unit}`, 'read', (v) => blocksWithGroup(v).some((g) => g.unit === unit));
const chartCap = (kind: 'bar' | 'line' | 'pie') =>
  cap(`read.chart.${kind}`, 'read', (v) => chartBlocks(v).some((b) => b.show.kind === kind));
const streakUnitCap = (unit: 'day' | 'week' | 'month') =>
  cap(`read.streak.unit.${unit}`, 'read', (v) =>
    [
      ...numberBlocks(v).map((b) => (b.source.aggregate === 'streak' ? b.source.days : undefined)),
      ...allFields(v).map((x) =>
        x.field.type === 'rollup' && x.field.aggregate === 'streak' ? x.field.days : undefined,
      ),
    ].some((d) => d?.unit === unit),
  );

/** All personal record capabilities. Hand-written items: when new things are added, guard tests prompt adding a predicate here. */
export const CAPABILITIES: readonly Capability[] = [
  // field
  fieldCap('text'),
  fieldCap('note'),
  fieldCap('number'),
  fieldCap('money'),
  fieldCap('checkbox'),
  fieldCap('date'),
  fieldCap('choice'),
  fieldCap('rating'),
  fieldCap('file'),
  fieldCap('link'),
  fieldCap('formula'),
  fieldCap('time'),
  fieldCap('datetime'),
  fieldCap('duration'),
  fieldCap('lookup'),
  fieldCap('rollup'),
  fieldCap('previous'),
  fieldCap('schedule'),
  fieldCap('tags'),
  fieldCap('dateOffset'),
  cap('field.schedule.lastDone', 'field', (v) =>
    allFields(v).some((x) => x.field.type === 'schedule' && x.field.lastDone !== undefined),
  ),
  cap('field.schedule.countEarly', 'field', (v) =>
    allFields(v).some((x) => x.field.type === 'schedule' && x.field.countEarly === true),
  ),
  // D-568: Numbers represented by options, option colors.
  cap('field.choice.optionValue', 'field', (v) =>
    allFields(v).some(
      (x) => x.field.type === 'choice' && x.field.options.some((o) => o.value !== undefined),
    ),
  ),
  cap('field.choice.optionColor', 'field', (v) =>
    allFields(v).some(
      (x) => x.field.type === 'choice' && x.field.options.some((o) => o.color !== undefined),
    ),
  ),
  // D-569: Formulas read checkboxes or choices.
  cap('field.formula.checkboxOrChoice', 'field', (v) =>
    allFields(v).some(({ table, field }) => {
      if (field.type !== 'formula') return false;
      const parsed = parseFormula(field.expression);
      return (
        parsed.ok &&
        parsed.refs.some((id) => {
          const ref = table.fields.find((f) => f.id === id);
          return ref?.type === 'checkbox' || ref?.type === 'choice';
        })
      );
    }),
  ),
  // D-570: Record form sections, conditional display, field entry tips and ranges.
  cap('field.table.form', 'field', (v) => tablesOf(v.config).some((t) => t.form !== undefined)),
  cap('field.table.form.when', 'field', (v) =>
    tablesOf(v.config).some((t) => (t.form?.sections ?? []).some((s) => s.when !== undefined)),
  ),
  cap('field.hint', 'field', (v) =>
    allFields(v).some(({ field }) => 'hint' in field && field.hint !== undefined),
  ),
  cap('field.range', 'field', (v) =>
    allFields(v).some(
      ({ field }) =>
        ('min' in field && field.min !== undefined) || ('max' in field && field.max !== undefined),
    ),
  ),
  cap('field.text.format', 'field', (v) =>
    allFields(v).some((x) => x.field.type === 'text' && x.field.format !== undefined),
  ),
  cap('field.table.readAttachments', 'field', (v) =>
    tablesOf(v.config).some((t) => t.readAttachments === true),
  ),
  cap('field.table.prefillRules', 'field', (v) =>
    tablesOf(v.config).some((t) => t.prefillRules !== undefined),
  ),

  // write
  doCap('create'),
  doCap('set'),
  doCap('toggle'),
  doCap('increment'),
  doCap('setAll'),
  doCap('createAll'),
  doCap('remove'),
  asCap('submit'),
  asCap('button'),
  asCap('check'),
  asCap('tap'),
  asCap('drag'),
  asCap('addHere'),
  asCap('list'),
  cap('write.look.form', 'write', (v) => v.blocks.some((x) => x.block.look === 'form')),
  cap('write.look.button', 'write', (v) => v.writes.some((w) => w.as === 'self')),
  cap('write.form.inline', 'write', (v) =>
    v.blocks.some((x) => x.block.look === 'form' && x.block.show.mode === 'inline'),
  ),
  cap('write.form.sheet', 'write', (v) =>
    v.blocks.some((x) => x.block.look === 'form' && x.block.show.mode === 'sheet'),
  ),
  cap('write.ask.all', 'write', (v) =>
    v.writes.some((w) => w.tool.do === 'create' && w.tool.ask === 'all'),
  ),
  cap('write.ask.fields', 'write', (v) =>
    v.writes.some((w) => w.tool.do === 'create' && Array.isArray(w.tool.ask)),
  ),
  cap('write.smartDate', 'write', (v) =>
    v.writes.some((w) => w.tool.do === 'create' && w.tool.smartDate !== undefined),
  ),
  cap('write.when', 'write', (v) => v.writes.some((w) => w.when)),
  cap('write.value.today', 'write', (v) => valueUsed(v, 'today')),
  cap('write.value.now', 'write', (v) => valueUsed(v, 'now')),
  cap('write.value.row', 'write', (v) => valueUsed(v, ROW_REF)),
  cap('write.value.record', 'write', (v) => valueUsed(v, RECORD_REF)),
  cap('write.value.group', 'write', (v) => valueUsed(v, GROUP_REF)),
  cap('write.value.here', 'write', (v) => valueUsed(v, HERE_REF)),
  // D-565: Dates calculated from today or this row's date, copying fields from this row, adding a number field from this row.
  cap('write.value.dateOffset', 'write', (v) => valuesUsed(v).some(isDateValue)),
  cap('write.value.copy', 'write', (v) => valuesUsed(v).some(isCopyValue)),
  cap('write.also', 'write', (v) =>
    v.blocks.some(({ block }) =>
      toolsOf(block).some((u) => isRecordToolUse(u) && tapAlsoOf(u).length > 0),
    ),
  ),
  // D-616: "Add" below the list checks several entries of another table, creating one for each.
  cap('write.createAll.pick', 'write', (v) =>
    v.writes.some((w) => w.tool.do === 'createAll' && w.tool.pick === true),
  ),
  cap('write.increment.byField', 'write', (v) =>
    v.writes.some((w) => w.tool.do === 'increment' && typeof w.tool.by === 'string'),
  ),
  cap('write.action.out.addRecord', 'write', (v) => v.intakes.length > 0),
  cap('write.fileInForm', 'write', (v) =>
    allFields(v).some(
      ({ table, field }) => field.type === 'file' && entryAsks(v, table.id, field.id),
    ),
  ),

  // read
  lookCap('dial'),
  lookCap('period'),
  lookCap('choices'),
  lookCap('callout'),
  lookCap('list'),
  lookCap('cards'),
  lookCap('checklist'),
  lookCap('tiles'),
  lookCap('board'),
  lookCap('calendar'),
  lookCap('table'),
  lookCap('gallery'),
  lookCap('grid'),
  lookCap('number'),
  lookCap('chart'),
  lookCap('single'),
  cap('read.single.record', 'read', (v) =>
    v.blocks.some((x) => x.block.look === 'single' && x.block.source.record !== undefined),
  ),
  cap('read.single.qr', 'read', (v) =>
    v.blocks.some((x) => x.block.look === 'single' && x.block.show.qr === true),
  ),
  cap('read.browse.search', 'read', (v) => browseOf(v).some((b) => b.search === true)),
  cap('read.browse.sort', 'read', (v) => browseOf(v).some((b) => b.sort !== undefined)),
  cap('read.browse.group', 'read', (v) => browseOf(v).some((b) => b.group !== undefined)),
  cap('read.showIf.some', 'read', (v) => v.blocks.some((x) => x.block.showIf?.has === 'some')),
  cap('read.showIf.none', 'read', (v) => v.blocks.some((x) => x.block.showIf?.has === 'none')),
  cap('connect.recordsToVCard', 'connect', (v) =>
    quickActionsOf(v.config).some((q) => q.steps.some((s) => s.action === 'records.toVCard')),
  ),
  // D-428: Containers pass values to tools.
  cap('connect.recordRow', 'connect', (v) =>
    v.config.data.tables.some((table) => (table.recordRow?.length ?? 0) > 0),
  ),
  cap('connect.singleTool', 'connect', (v) =>
    v.blocks.some((x) => x.block.look === 'single' && x.block.tools !== undefined),
  ),
  cap('connect.recordsToExcel', 'connect', (v) =>
    quickActionsOf(v.config).some((q) => q.steps.some((s) => s.action === 'records.toExcel')),
  ),
  cap('connect.printAttachments', 'connect', (v) =>
    quickActionsOf(v.config).some((q) =>
      q.steps.some((s) => s.action === 'print.records' && s.params.attachments === true),
    ),
  ),
  chartCap('bar'),
  chartCap('line'),
  chartCap('pie'),
  cap('read.filter', 'read', (v) =>
    [...recordBlocks(v), ...numberBlocks(v), ...chartBlocks(v)].some(
      (b) => (b.source.filter ?? []).length > 0,
    ),
  ),
  cap('read.sort', 'read', (v) => recordBlocks(v).some((b) => b.source.sort !== undefined)),
  cap('read.sort.many', 'read', (v) => recordBlocks(v).some((b) => Array.isArray(b.source.sort))),
  cap('read.group.choice', 'read', (v) => groupByType(v, ['choice'])),
  cap('read.group.link', 'read', (v) => groupByType(v, ['link'])),
  cap('read.group.schedule', 'read', (v) => groupByType(v, ['schedule'])),
  unitCap('day'),
  unitCap('week'),
  unitCap('month'),
  cap('read.group.last', 'read', (v) => blocksWithGroup(v).some((g) => g.last !== undefined)),
  cap('read.group.showEmpty', 'read', (v) => blocksWithGroup(v).some((g) => g.showEmpty === true)),
  cap('read.group.filter', 'read', (v) => blocksWithGroup(v).some((g) => g.filter !== undefined)),
  aggregateCap('count'),
  aggregateCap('sum'),
  aggregateCap('avg'),
  aggregateCap('min'),
  aggregateCap('max'),
  aggregateCap('latest'),
  aggregateCap('streak'),
  aggregateCap('daysSince'),
  aggregateCap('avgInterval'),
  aggregateCap('distinctDays'),
  streakUnitCap('day'),
  streakUnitCap('week'),
  streakUnitCap('month'),
  cap('read.streak.perUnit', 'read', (v) =>
    numberBlocks(v).some((b) => b.source.days?.perUnit !== undefined),
  ),
  cap('read.streak.skip', 'read', (v) =>
    numberBlocks(v).some((b) => b.source.days?.skip !== undefined),
  ),
  cap('read.number.goal', 'read', (v) => numberBlocks(v).some((b) => b.source.goal !== undefined)),
  cap('read.number.compare', 'read', (v) =>
    numberBlocks(v).some((b) => b.source.compare !== undefined),
  ),
  cap('read.number.period', 'read', (v) =>
    numberBlocks(v).some((b) => b.source.period !== undefined),
  ),
  cap('read.chart.compare', 'read', (v) =>
    chartBlocks(v).some((b) => b.source.compare !== undefined),
  ),
  cap('read.records.period', 'read', (v) =>
    recordBlocks(v).some((b) => b.source.period !== undefined),
  ),
  cap('read.chart.period', 'read', (v) =>
    chartBlocks(v).some((b) => b.source.period !== undefined),
  ),
  cap('read.records.choice', 'read', (v) =>
    recordBlocks(v).some((b) => b.source.choice !== undefined),
  ),
  cap('read.number.choice', 'read', (v) =>
    numberBlocks(v).some((b) => b.source.choice !== undefined),
  ),
  cap('read.chart.choice', 'read', (v) =>
    chartBlocks(v).some((b) => b.source.choice !== undefined),
  ),
  cap('read.number.calc', 'read', (v) => numberBlocks(v).some((b) => b.source.calc !== undefined)),
  cap('read.chart.running', 'read', (v) =>
    chartBlocks(v).some((b) => b.source.running !== undefined),
  ),
  cap('read.chart.split', 'read', (v) => chartBlocks(v).some((b) => b.source.split !== undefined)),
  cap('read.calendar.day', 'read', (v) =>
    recordBlocks(v).some((b) => b.look === 'calendar' && b.show.day !== undefined),
  ),
  cap('read.calendar.week', 'read', (v) =>
    recordBlocks(v).some((b) => b.look === 'calendar' && b.show.span === 'week'),
  ),
  cap('read.calendar.until', 'read', (v) =>
    recordBlocks(v).some((b) => b.look === 'calendar' && b.source.group?.until !== undefined),
  ),
  cap('read.number.minus', 'read', (v) =>
    numberBlocks(v).some((b) => b.source.minus !== undefined),
  ),
  opCap('is'),
  opCap('isNot'),
  opCap('contains'),
  opCap('gt'),
  opCap('lt'),
  opCap('isEmpty'),
  opCap('isNotEmpty'),
  opCap('inPeriod'),
  opCap('due'),
  periodCap('today'),
  periodCap('thisWeek'),
  periodCap('thisMonth'),
  periodCap('thisYear'),
  periodCap('last7days'),
  periodCap('last30days'),
  periodCap('last14days'),
  periodCap('last90days'),
  periodCap('last365days'),
  periodCap('thisTwoWeeks'),
  periodCap('thisHalfMonth'),
  periodCap('next7days'),
  periodCap('next30days'),
  periodCap('next90days'),
  periodCap('yesterday'),
  periodCap('lastWeek'),
  periodCap('lastMonth'),
  periodCap('lastYear'),
  periodCap('tomorrow'),
  periodCap('nextWeek'),
  periodCap('nextMonth'),
  cap('read.show.color', 'read', (v) => recordBlocks(v).some((b) => b.show.color !== undefined)),
  cap('read.format.elapsed', 'read', (v) =>
    recordBlocks(v).some((b) => b.show.format?.kind === 'elapsed'),
  ),
  cap('read.format.progress', 'read', (v) =>
    recordBlocks(v).some((b) => b.show.format?.kind === 'progress'),
  ),
  cap(
    'read.recordPage',
    'read',
    (v) =>
      v.pages.some((p) => p.of !== undefined) && recordBlocks(v).some((b) => b.opens !== undefined),
  ),
  cap('read.openEditor', 'read', usesOpen),
  cap('read.action.records.toExcel', 'read', (v) =>
    quickActionsOf(v.config).some((q) => q.steps.some((s) => s.action === 'records.toExcel')),
  ),
  cap('read.action.records.fill', 'read', (v) =>
    quickActionsOf(v.config).some((q) => q.steps.some((s) => s.action === 'records.fill')),
  ),
  cap('read.action.in.records', 'read', (v) =>
    quickActionsOf(v.config).some((q) => q.steps.some((s) => s.action === 'in.records')),
  ),

  // remind
  cap('remind.when.everyDay', 'remind', (v) =>
    v.reminders.some((r) => 'every' in r.when && r.when.every === 'day'),
  ),
  cap('remind.when.everyWeek', 'remind', (v) =>
    v.reminders.some((r) => 'every' in r.when && r.when.every === 'week'),
  ),
  cap('remind.when.everyMonth', 'remind', (v) =>
    v.reminders.some((r) => 'every' in r.when && r.when.every === 'month'),
  ),
  cap('remind.when.before', 'remind', (v) =>
    v.reminders.some((r) => 'before' in r.when && 'days' in r.when),
  ),
  cap('remind.when.beforeMinutes', 'remind', (v) =>
    v.reminders.some((r) => 'before' in r.when && 'minutes' in r.when),
  ),
  cap('remind.when.each', 'remind', (v) => whenIs(v, 'each')),
  cap('remind.when.after', 'remind', (v) => whenIs(v, 'after')),
  cap('remind.unless', 'remind', (v) => v.reminders.some((r) => r.unless !== undefined)),
  cap('remind.unless.repeating', 'remind', (v) =>
    v.reminders.some((r) => r.unless !== undefined && 'every' in r.when),
  ),
  cap('remind.done', 'remind', (v) => v.reminders.some((r) => r.done !== undefined)),
  cap('remind.snoozeMinutes', 'remind', (v) =>
    v.reminders.some((r) => r.snoozeMinutes !== undefined),
  ),

  // Connections between capabilities: individual items exist, but may not connect.
  cap('connect.writeReadSameTable', 'connect', (v) =>
    tableIds(v).some(
      (t) =>
        canAdd(v, t) &&
        (recordBlocks(v, t).length > 0 ||
          numberBlocks(v, t).length > 0 ||
          chartBlocks(v, t).length > 0),
    ),
  ),
  cap('connect.statInputsFilled', 'connect', (v) => {
    const stats = [...numberBlocks(v), ...chartBlocks(v)];
    return stats.length > 0 && stats.every((b) => statInputsFilled(v, b));
  }),
  cap('connect.calendarDayFilled', 'connect', (v) => {
    const calendars = recordBlocks(v).filter((b) => b.look === 'calendar');
    return (
      calendars.length > 0 &&
      calendars.every((b) =>
        entryFills(v, b.source.table, dayField(v, b.source.table, b.source.group?.by)),
      )
    );
  }),
  cap('connect.calendarColorFilled', 'connect', (v) =>
    recordBlocks(v).some(
      (b) =>
        b.look === 'calendar' &&
        b.show.color !== undefined &&
        entryWrites(v, b.source.table, b.show.color),
    ),
  ),
  cap('connect.tapReachesRows', 'connect', (v) => {
    const taps = v.writes.filter((w) => w.as === 'tap');
    return taps.length > 0 && taps.every((w) => rowExists(v, w));
  }),
  cap('connect.dragWritesGroupField', 'connect', (v) =>
    v.writes.some(
      (w) =>
        w.as === 'drag' &&
        w.tool.do === 'set' &&
        w.block !== undefined &&
        w.tool.field === (w.block.block as RecordBlock).source.group?.by,
    ),
  ),
  cap('connect.reminderReachesTable', 'connect', (v) =>
    v.reminders.some((r) => tableIds(v).some((t) => reminderReaches(v, r, t))),
  ),
  cap('connect.doneWritesCountedTable', 'connect', (v) =>
    v.reminders.some(
      (r) =>
        r.done !== undefined && aggregatesOn(v, r.done.table, ['streak', 'count', 'distinctDays']),
    ),
  ),
  cap('connect.rescheduleOnDone', 'connect', (v) =>
    tableIds(v).some((t) => completionReschedules(v, t)),
  ),
  cap('connect.fileIntakePlaced', 'connect', (v) =>
    v.intakes.some((x) => x.placed && x.ok && x.files),
  ),
];
