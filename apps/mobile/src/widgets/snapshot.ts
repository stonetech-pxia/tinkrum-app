import {
  allComponents,
  MAX_TILES,
  calendarOf,
  changeLabel,
  compareChange,
  componentLabel,
  filterRecords,
  formatRef,
  linkedCollectionIds,
  loadComputedRecords,
  loadLinkResolver,
  previousLabel,
  progressOf,
  recordProgress,
  resolveColors,
  shownRowAction,
  sortRecords,
  isKnownComponent,
  readNumber,
  calculatedText,
  type BlockOf,
  type Calendar,
  type Component,
  type Locale,
  type Registry,
  type Theme,
  type WorkspaceConfig,
  fieldForRecord,
} from '@morph/core';

import { t } from '../i18n';
import {
  amountText,
  isRecordBlock as isRecordLook,
  statText,
  type RecordBlock,
} from '../renderer/data';
import { iosSymbolName } from '../renderer/Icon';
import {
  actionHash,
  applyInMemory,
  buttonOpKey,
  findComponent,
  planWidgetOp,
  rowOpKey,
  widgetButtonAction,
  widgetRowAction,
  type RecordsByTable,
} from './ops';
import type {
  PlacedWidget,
  WidgetOpRef,
  WidgetPalette,
  WidgetRow,
  WidgetSnapshot,
  WidgetState,
  WidgetView,
  WidgetViews,
} from './types';

// Widget views (D-321, D-322): shares the same configuration, algorithms (filtering, aggregation,
// targets, previous period comparison, sorting, row action conditions), and text rendering as page
// components on the device. Renders official versions only (drafts excluded) and only for
// user-placed home screen components. Precalculates views for 1...REPEATS consecutive taps for each
// interactive operation so widgets update immediately on tap without waiting for app execution.

/** Number of consecutive taps to precalculate per operation. */
export const REPEATS = 4;
/** Maximum number of rows/circles rendered by a widget (large size). */
const MAX_ROWS = 7;
const WIDGET_TILES = Math.min(8, MAX_TILES);

/**
 * Whether a component resides on a record-specific page (D-342): widgets cannot determine the
 * specific record, so they cannot be placed on the home screen.
 */
export function onRecordPage(c: Component, config: WorkspaceConfig): boolean {
  return config.containers.pages.some(
    (p) => p.of !== undefined && allComponents(p).some((x) => x.id === c.id),
  );
}

/** Components eligible for home screen placement: stats, buttons, and record lists (excluding calendars and kanban boards). */
export function widgetSupported(c: Component): boolean {
  return ['list', 'cards', 'checklist', 'tiles', 'number', 'button'].includes(c.look as string);
}

/** Names for widgets and "Edit Widget" lists: stats and buttons use their custom text, lists use table names, and others use component descriptions. */
export function widgetName(
  c: Component,
  config: WorkspaceConfig,
  registry: Registry,
  locale: Locale,
): string {
  if (!isKnownComponent(c)) return componentLabel(c, config, { registry, locale, now: new Date() });
  if (c.look === 'number' || c.look === 'button') return c.show.label;
  if (isRecordLook(c)) {
    const table = config.data.tables.find((x) => x.id === c.source.table);
    if (table) return table.name;
  }
  return componentLabel(c, config, { registry, locale, now: new Date() });
}

/** Opens the app on tap: the component's page or button target (routed via app/widget/[componentId]). */
export const componentLink = (componentId: string) =>
  `morph://widget/${encodeURIComponent(componentId)}`;
const recordLink = (collectionId: string, recordId?: string) =>
  `morph://record/${encodeURIComponent(collectionId)}${recordId ? `?recordId=${encodeURIComponent(recordId)}` : ''}`;

interface Ctx {
  config: WorkspaceConfig;
  locale: Locale;
  registry: Registry;
  cal: Calendar;
  now: Date;
  records: RecordsByTable;
  /** Collects interactive operations available on the widget. */
  ops: Record<string, WidgetOpRef>;
}

const lister = (records: RecordsByTable) => async (id: string) => [...(records.get(id) ?? [])];

async function statView(c: BlockOf<'number'>, ctx: Ctx): Promise<WidgetView | null> {
  const { config, locale, cal, now } = ctx;
  const source = c.source;
  // Uses the same read logic as numeric blocks on pages (core's readNumber).
  const read = readNumber(source, { config, records: ctx.records, now, cal, locale });
  if (!read) return null;
  const field = source.field ? read.view.fields.find((f) => f.id === source.field) : undefined;
  const text = (v: number | null) =>
    calculatedText(v, source.calc, locale) ??
    statText(v, source.aggregate, field, locale, source.days?.unit);
  const goal = (v: number | null) => {
    const p = source.goal === undefined ? undefined : progressOf(v ?? 0, source.goal);
    return (
      p && {
        ratio: p.ratio,
        label: t(locale, 'progressOfGoal', { value: text(v), goal: text(p.goal) }),
      }
    );
  };
  const base = { kind: 'stat' as const, title: c.show.label, link: componentLink(c.id) };
  if (read.groups) {
    return {
      ...base,
      value: '',
      rows: read.groups.map((g) => {
        const p = goal(g.value);
        return {
          id: g.optionId ?? '-',
          title: g.label,
          trailing: p?.label ?? g.text ?? text(g.value),
          ...(p ? { ratio: p.ratio } : {}),
        };
      }),
    };
  }
  const p = goal(read.value);
  let note: string | undefined;
  if (read.best !== undefined) note = t(locale, 'seqBest', { value: text(read.best) });
  else if (read.previous) {
    const change = changeLabel(compareChange(read.value, read.previous.value), locale);
    note = [previousLabel(read.previous.period, text(read.previous.value), locale), change]
      .filter(Boolean)
      .join(' · ');
  }
  return {
    ...base,
    value: p ? p.label : (read.text ?? text(read.value)),
    ...(p
      ? { ratio: p.ratio, percent: t(locale, 'progressPercent', { n: Math.round(p.ratio * 100) }) }
      : {}),
    ...(note ? { note } : {}),
  };
}

function buttonView(c: BlockOf<'button'>, ctx: Ctx): WidgetView {
  const icon = c.show.icon ? iosSymbolName(c.show.icon) : undefined;
  const base = { kind: 'button' as const, title: c.show.label, ...(icon ? { icon } : {}) };
  const action = widgetButtonAction(c);
  if (action) {
    const key = buttonOpKey(c.id);
    ctx.ops[key] = { component: c.id, hash: actionHash(action) };
    return { ...base, op: key };
  }
  // Open form (preset values filled in the app, Q6), filtered batch changes (require confirmation), and open page: executed inside the app.
  return { ...base, link: componentLink(c.id) };
}

async function listView(c: RecordBlock, ctx: Ctx): Promise<WidgetView | null> {
  const { config, locale, cal, now } = ctx;
  const { source, show } = c;
  const table = config.data.tables.find((x) => x.id === source.table);
  if (!table) return null;
  const { view, records } = await loadComputedRecords(
    lister(ctx.records),
    config.data.tables,
    table,
    now,
    cal,
  );
  const targets = linkedCollectionIds(view);
  const links = targets.length
    ? await loadLinkResolver(lister(ctx.records), config.data.tables, targets, locale)
    : undefined;
  const tiles = c.look === 'tiles';
  const sorted = sortRecords(
    filterRecords(records, view, source.filter, now, cal),
    view,
    source.sort,
    now,
    cal,
  );
  const shown = sorted.slice(0, Math.min(source.limit, tiles ? WIDGET_TILES : MAX_ROWS));
  const format = show.format;
  const trailingField = view.fields.find((f) => f.id === show.trailing);
  const rows = shown.map((r): WidgetRow => {
    const title = formatRef(r, view, show.title, locale, links, now, cal) || '—';
    const progress =
      format?.kind === 'progress' && show.trailing
        ? recordProgress(r, view, show.trailing, format.goal, now, cal)
        : undefined;
    const amountField = trailingField && fieldForRecord(trailingField, r.values, view);
    const trailing = progress
      ? t(locale, 'progressOfGoal', {
          value: amountText(progress.value, amountField, locale),
          goal: amountText(progress.goal, amountField, locale),
        })
      : show.trailing
        ? formatRef(r, view, show.trailing, locale, links, now, cal)
        : '';
    const row: WidgetRow = { id: r.id, title, ...(trailing ? { trailing } : {}) };
    if (!tiles) return { ...row, link: recordLink(table.id, r.id) };
    const action = widgetRowAction(shownRowAction(c.tools, r, view, now, cal));
    const extra = progress ? { ratio: progress.ratio, full: progress.ratio >= 1 } : {};
    if (!action) return { ...row, ...extra, link: recordLink(table.id, r.id) };
    const key = rowOpKey(c.id, r.id);
    ctx.ops[key] = { component: c.id, record: r.id, hash: actionHash(action) };
    return { ...row, ...extra, op: key };
  });
  return {
    kind: 'list',
    title: widgetName(c, config, ctx.registry, locale),
    display: tiles ? 'tiles' : 'list',
    rows,
    empty: show.emptyText ?? t(locale, 'noRecords'),
    link: componentLink(c.id),
  };
}

async function viewOf(c: Component | undefined, ctx: Ctx, name: string): Promise<WidgetView> {
  const gone: WidgetView = { kind: 'message', title: name, note: t(ctx.locale, 'widgetGone') };
  if (!c) return gone;
  if (!widgetSupported(c) || onRecordPage(c, ctx.config))
    return {
      kind: 'message',
      title: name,
      note: t(ctx.locale, 'widgetUnsupported'),
      link: componentLink(c.id),
    };
  const view = !isKnownComponent(c)
    ? null
    : c.look === 'number'
      ? await statView(c, ctx)
      : c.look === 'button'
        ? buttonView(c, ctx)
        : isRecordLook(c)
          ? await listView(c, ctx)
          : null;
  return view ?? gone;
}

async function viewsAt(
  placed: readonly PlacedWidget[],
  names: Map<string, string>,
  ctx: Ctx,
): Promise<WidgetViews> {
  const views: WidgetViews = {};
  for (const p of placed) {
    views[p.componentId] = await viewOf(
      findComponent(ctx.config, p.componentId),
      ctx,
      names.get(p.componentId) ?? p.componentId,
    );
  }
  return views;
}

const startOfDay = (d: Date, plusDays = 0) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate() + plusDays);

/** Renders views and post-tap states for each operation over a given time range (starting from). */
async function stateFor(
  from: Date,
  until: Date,
  at: Date,
  placed: readonly PlacedWidget[],
  names: Map<string, string>,
  base: Omit<Ctx, 'now' | 'records' | 'ops'>,
  records: RecordsByTable,
  ops: Record<string, WidgetOpRef>,
): Promise<WidgetState> {
  const here: Record<string, WidgetOpRef> = {};
  const views = await viewsAt(placed, names, { ...base, now: at, records, ops: here });
  Object.assign(ops, here);
  const after: Record<string, WidgetViews[]> = {};
  for (const [key, ref] of Object.entries(here)) {
    const list: WidgetViews[] = [];
    let current = records;
    for (let k = 1; k <= REPEATS; k++) {
      const time = new Date(at.getTime() + k);
      const write = planWidgetOp(base.config, ref, current, time, base.cal);
      if (!write) break;
      current = applyInMemory(current, write, time, `widget-preview-${k}`);
      const next = await viewsAt(placed, names, { ...base, now: time, records: current, ops: {} });
      // Displays "Recorded" below tapped buttons.
      for (const v of Object.values(next))
        if (v.kind === 'button' && v.op === key) v.note = t(base.locale, 'widgetAdded');
      list.push(next);
    }
    if (list.length) after[key] = list;
  }
  return { from: from.getTime(), until: until.getTime(), views, after };
}

const HEX = /^#[0-9a-fA-F]{6}$/;
// Widget background color follows system light/dark mode (app style may be fixed light), so both are calculated directly using style colors.
function paletteOf(theme: Theme, dark: boolean): WidgetPalette {
  const p = resolveColors(theme, dark);
  const hex = (c: string, fallback: string) => (HEX.test(c) ? c : fallback);
  return {
    primary: hex(p.primary, '#C2603A'),
    tint: hex(p.primaryTint, dark ? '#3A2A22' : '#F6E3D9'),
    onPrimary: hex(p.onPrimary, '#FFFFFF'),
  };
}

export interface SnapshotInput {
  config: WorkspaceConfig;
  placed: readonly PlacedWidget[];
  locale: Locale;
  registry: Registry;
  now: Date;
  /** Records stored in all tables. */
  records: RecordsByTable;
}

/** Full screen layout: one for today, one for tomorrow (D-322). When no widgets are placed on the desktop, items is empty, and the widget shows how to add them. */
export async function buildWidgetSnapshot(input: SnapshotInput): Promise<WidgetSnapshot> {
  const { config, placed, locale, registry, now, records } = input;
  const cal = calendarOf(config);
  const base = { config, locale, registry, cal };
  const names = new Map<string, string>();
  for (const p of placed) {
    const c = findComponent(config, p.componentId);
    names.set(p.componentId, c ? widgetName(c, config, registry, locale) : p.componentId);
  }
  const ops: Record<string, WidgetOpRef> = {};
  const tomorrow = startOfDay(now, 1);
  const states = [
    await stateFor(startOfDay(now), tomorrow, now, placed, names, base, records, ops),
    await stateFor(tomorrow, startOfDay(now, 2), tomorrow, placed, names, base, records, ops),
  ];
  return {
    v: 1,
    strings: { stale: t(locale, 'widgetStale') },
    colors: { light: paletteOf(config.theme, false), dark: paletteOf(config.theme, true) },
    items: placed.map((p) => ({ id: p.componentId, name: names.get(p.componentId)! })),
    ops,
    states,
  };
}
