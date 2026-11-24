// v33 to v34 migration (D-368, decided by founder 2026-10-30): "Data · Containers · Tools". IDs are
// never changed (tables, fields, options, pages, blocks, quick actions; reminders are changed only
// when colliding with quick actions, M1). Accepts only v33 structure (M13: earlier versions pass
// through prior migrations first). Pure JSON in and out, independent of v34 structure definitions,
// allowing downloadable tool packages (tool-download.ts), templates, and samples (templates/,
// samples/) to use the same conversion logic.

type Json = Record<string, any>;

const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Remove keys whose values are undefined (making migration output as clean as hand-written JSON). */
function clean<T extends Json>(o: T): T {
  const out: Json = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as T;
}

const nonEmpty = <T>(list: T[] | undefined): T[] | undefined =>
  list && list.length > 0 ? list : undefined;

/** v33 component types (D-254: all others were added in newer app versions and are migrated to look "$unknown"). */
const V33_TYPES = new Set([
  'header',
  'text',
  'notice',
  'divider',
  'spacer',
  'image',
  'group',
  'button',
  'shortcut',
  'catalogLink',
  'toolCard',
  'fileSlot',
  'fileList',
  'filePick',
  'workflowRunner',
  'quickActionList',
  'toolGrid',
  'recordList',
  'recordForm',
  'stat',
  'chart',
]);

/** Table structure required during migration ("row" is replaced with "$row" only on reference fields, and rollup date filtering field). */
export interface V33Tables {
  find(id: string): Json | undefined;
}

export const v33Tables = (collections: readonly Json[]): V33Tables => ({
  find: (id) => collections.find((c) => c.id === id),
});

/** workflow:<id> -> tool:<id> (opens quick action, displayed without running). */
const target = (t: unknown): unknown =>
  typeof t === 'string' && t.startsWith('workflow:') ? `tool:${t.slice('workflow:'.length)}` : t;

/** A single value: v33 "row" (this row) becomes "$row" only on reference fields; single-choice row options remain unchanged (M5). */
function value(v: unknown, table: Json | undefined, fieldId: string): unknown {
  if (v !== 'row') return v;
  const field = (table?.fields as Json[] | undefined)?.find((f) => f.id === fieldId);
  return field?.type === 'link' ? '$row' : v;
}

function values(vs: unknown, table: Json | undefined): Json | undefined {
  if (!isObject(vs)) return undefined;
  return Object.fromEntries(Object.entries(vs).map(([k, v]) => [k, value(v, table, k)]));
}

/** Rollup date field (rollupDate = dateFieldOf in related.ts): dateField, first date/datetime field, or creation time. */
function defaultDate(table: Json | undefined, dateField: unknown): string {
  if (typeof dateField === 'string') return dateField;
  const fields = (table?.fields as Json[] | undefined) ?? [];
  return (
    fields.find((f) => f.type === 'date')?.id ??
    fields.find((f) => f.type === 'datetime')?.id ??
    'createdAt'
  );
}

/** Day-based parameters (5 parameters duplicated across stat and rollup) -> days block. */
function days(o: Json): Json | undefined {
  const skip =
    o.skipField !== undefined || o.skipOption !== undefined
      ? clean({ field: o.skipField, option: o.skipOption })
      : undefined;
  const d = clean({ date: o.dateField, unit: o.unit, perUnit: o.perUnit, skip });
  return Object.keys(d).length > 0 ? d : undefined;
}

/** Fields (unified key names, Q5; rollup period migrated to an inPeriod condition at the end of filter, M3). */
export function migrateFieldV33(f: Json, tables: V33Tables): Json {
  switch (f.type) {
    case 'link': {
      const { collectionId, ...rest } = f;
      return { ...rest, table: collectionId };
    }
    case 'lookup': {
      const { linkField, fieldId, ...rest } = f;
      return { ...rest, via: linkField, field: fieldId };
    }
    case 'previous': {
      const { fieldId, dateField, groupBy, ...rest } = f;
      return clean({ ...rest, field: fieldId, date: dateField, within: groupBy });
    }
    case 'rollup': {
      const {
        collectionId,
        linkField,
        fieldId,
        filter,
        period,
        dateField,
        unit,
        perUnit,
        skipField,
        skipOption,
        ...rest
      } = f;
      const conditions = [...((filter as Json[] | undefined) ?? [])];
      if (period !== undefined)
        conditions.push({
          field: defaultDate(tables.find(collectionId), dateField),
          op: 'inPeriod',
          value: period,
        });
      return clean({
        ...rest,
        table: collectionId,
        via: linkField,
        field: fieldId,
        filter: nonEmpty(conditions),
        days: days({ dateField, unit, perUnit, skipField, skipOption }),
      });
    }
    default:
      return f;
  }
}

export function migrateTableV33(c: Json, tables: V33Tables): Json {
  return { ...c, fields: (c.fields as Json[]).map((f) => migrateFieldV33(f, tables)) };
}

/** One-tap record actions -> in-place one-tap record tools (v33 create / set / toggle / increment / setAll / open). */
function recordTool(a: Json, listTable: string | undefined, tables: V33Tables): Json {
  switch (a.do) {
    case 'create': {
      const table = tables.find(a.collectionId);
      return clean({
        do: 'create',
        table: a.collectionId,
        values: values(a.values, table),
        ask: a.form ? 'all' : undefined,
      });
    }
    case 'open':
      // open on a button = new record form (open on a row is navigation, see rowTool).
      return { do: 'create', table: a.collectionId, ask: 'all' };
    case 'setAll': {
      const table = tables.find(a.collectionId);
      return clean({
        do: 'setAll',
        table: a.collectionId,
        filter: a.filter,
        field: a.fieldId,
        value: value(a.value, table, a.fieldId),
      });
    }
    case 'set':
      return {
        do: 'set',
        table: listTable,
        field: a.fieldId,
        value: value(a.value, tables.find(listTable ?? ''), a.fieldId),
      };
    case 'toggle':
      return { do: 'toggle', table: listTable, field: a.fieldId };
    case 'increment':
      return { do: 'increment', table: listTable, field: a.fieldId, by: a.by };
    default:
      return a;
  }
}

/** Row actions -> in-place tools: tap on tiles, button elsewhere; open navigates to the edit page for that entry. */
function rowTool(a: Json, as: 'tap' | 'button', listTable: string, tables: V33Tables): Json {
  const use = clean({ as, label: a.label, when: a.when });
  if (a.do === 'open') return { ...use, opens: 'record' };
  const { label: _l, when: _w, ...action } = a;
  return { ...use, ...recordTool(action, listTable, tables) };
}

function block(base: Json, rest: Json): Json {
  return clean({ ...base, ...rest });
}

/** A v33 component -> v34 block (table in docs/ARCHITECTURE.md §11). Unrecognized components are wrapped as look "$unknown" (M8). */
export function migrateComponentV33(c: Json, tables: V33Tables): Json {
  if (!isObject(c) || typeof c.type !== 'string' || !V33_TYPES.has(c.type)) {
    return clean({ id: c?.id, look: '$unknown', hidden: c?.hidden, raw: c });
  }
  const base = clean({ id: c.id, hidden: c.hidden, style: c.style });
  const p = (c.props ?? {}) as Json;
  switch (c.type) {
    case 'header':
    case 'text':
    case 'notice':
    case 'spacer':
      return block(base, { look: c.type, show: p });
    case 'divider':
      return block(base, { look: 'divider' });
    case 'image': {
      const { assetId, ...show } = p;
      return block(base, { look: 'image', show: clean({ asset: assetId, ...show }) });
    }
    case 'group':
      return block(base, {
        look: 'group',
        show: p,
        children: ((c.children as Json[] | undefined) ?? []).map((x) =>
          migrateComponentV33(x, tables),
        ),
      });
    case 'button': {
      const { target: opens, action, ...show } = p;
      return block(base, {
        look: 'button',
        show,
        opens: target(opens),
        tools: action ? [recordTool(action, undefined, tables)] : undefined,
      });
    }
    case 'shortcut':
      return block(base, {
        look: 'entry',
        show: clean({ title: p.title, subtitle: p.subtitle, icon: p.icon, shape: p.look }),
        opens: target(p.target),
      });
    case 'catalogLink':
      // The renderer draws catalogLink with a primary-color title, plus icon, and default large block (M7).
      return block(base, {
        look: 'entry',
        show: { title: p.title, icon: 'plus', shape: p.look ?? 'tile', accent: true },
        opens: 'tools',
      });
    case 'toolCard':
      // Title, icon, and description are retrieved dynamically from the tool package (updating with language changes); default is a large block (ToolCard look ?? 'tile').
      return block(base, {
        look: 'entry',
        show: { shape: p.look ?? 'tile' },
        opens: `package:${p.toolId}`,
      });
    case 'fileSlot':
      return block(base, {
        look: 'entry',
        show: clean({ title: p.title, hint: p.hint, icon: p.icon, shape: p.look }),
        opens: { file: p.assetId ?? null },
      });
    case 'fileList': {
      // FileList.tsx: When mimeType is a broad category, filter by prefix; when omitted, list non-image files.
      const kind: Record<string, Json> = {
        'application/pdf': { field: 'kind', op: 'is', value: 'pdf' },
        'image/*': { field: 'kind', op: 'is', value: 'image' },
        'video/*': { field: 'kind', op: 'is', value: 'video' },
        'audio/*': { field: 'kind', op: 'is', value: 'audio' },
      };
      const condition = p.mimeType
        ? kind[p.mimeType as string]
        : { field: 'kind', op: 'isNot', value: 'image' };
      return block(base, {
        look: 'files',
        show: { title: p.title },
        source: { table: '$files', filter: [condition], limit: p.limit },
      });
    }
    case 'filePick':
      return block(base, {
        look: 'picker',
        tools: [{ tool: p.source === 'files' ? '$pick.files' : '$pick.media' }],
      });
    case 'workflowRunner':
      return block(base, {
        look: 'action',
        show: p.look ? { shape: p.look } : undefined,
        tools: [{ tool: p.workflowId }],
      });
    case 'quickActionList':
      return block(base, {
        look: 'library',
        show: p.title ? { title: p.title } : undefined,
        source: clean({ catalog: 'quickActions', kind: p.kind }),
      });
    case 'toolGrid':
      return block(base, {
        look: 'packages',
        show: p.title ? { title: p.title } : undefined,
        source: clean({ catalog: 'packages', ids: p.toolIds }),
      });
    case 'recordList':
      return block(base, recordList(p, tables));
    case 'recordForm': {
      const table = tables.find(p.collectionId);
      if (p.mode === 'button') {
        // v33 button mode ignores values (openEditor in data.tsx has no prefills), whereas v34
        // prefills them (Q6, treated as bug fix). fieldIds and smartDate are ignored in button mode
        // anyway (since they open the full form), so they are discarded.
        return block(base, {
          look: 'button',
          show: { label: p.submitLabel, variant: 'filled' },
          tools: [
            clean({
              do: 'create',
              table: p.collectionId,
              ask: 'all',
              values: values(p.values, table),
            }),
          ],
        });
      }
      return block(base, {
        look: 'form',
        show: { mode: p.mode },
        tools: [
          clean({
            as: 'submit',
            label: p.submitLabel,
            do: 'create',
            table: p.collectionId,
            ask: p.fieldIds,
            values: values(p.values, table),
            smartDate: p.smartDate,
          }),
        ],
      });
    }
    case 'stat': {
      const minus = isObject(p.minus)
        ? clean({
            table: p.minus.collectionId,
            aggregate: p.minus.aggregate,
            field: p.minus.fieldId,
            filter: p.minus.filter,
          })
        : undefined;
      return block(base, {
        look: 'number',
        show: { label: p.label },
        source: clean({
          table: p.collectionId,
          aggregate: p.aggregate,
          field: p.fieldId,
          filter: p.filter,
          days: days(p),
          group: p.groupBy !== undefined ? { by: p.groupBy } : undefined,
          goal: p.goal,
          compare: p.compare,
          minus,
        }),
      });
    }
    case 'chart': {
      const byChoice = p.group === 'choice';
      const group = byChoice
        ? clean({ by: p.choiceField })
        : clean({ by: p.dateField, unit: p.group, last: p.periods });
      return block(base, {
        look: 'chart',
        show: { kind: p.kind, title: p.title },
        source: clean({
          table: p.collectionId,
          aggregate: p.aggregate,
          field: p.fieldId,
          filter: p.filter,
          // When grouped by single choice, distinctDays still counts days using dateField.
          days: byChoice && p.dateField !== undefined ? { date: p.dateField } : undefined,
          group,
        }),
      });
    }
    default:
      return c;
  }
}

function recordList(p: Json, tables: V33Tables): Json {
  const table = p.collectionId as string;
  const tools: Json[] = [];
  let group: Json | undefined;
  if (p.display === 'checklist' && p.checkField !== undefined)
    tools.push({ as: 'check', do: 'toggle', table, field: p.checkField });
  // checkField renderers on non-checklist components are unused (data.tsx line 1035) and discarded (B6 #24).
  if (p.display === 'board' && p.groupField !== undefined) {
    group = clean({ by: p.groupField, filter: p.groupFilter });
    // v33 kanban boards are always draggable: dragging is a set operation updating the grouping field.
    tools.push({ as: 'drag', do: 'set', table, field: p.groupField, value: '$group' });
  } else if (p.display === 'calendar') {
    group = clean({ by: p.dateField, unit: 'day' });
  } else if (p.groupBy !== undefined) {
    group = clean({ by: p.groupBy, unit: p.groupUnit, showEmpty: p.showEmpty });
  }
  const as = p.display === 'tiles' ? 'tap' : 'button';
  for (const a of (p.rowActions as Json[] | undefined) ?? [])
    tools.push(rowTool(a, as, table, tables));
  if (p.addHere) tools.push({ as: 'addHere', do: 'create', table, ask: 'all', values: '$here' });
  return {
    look: p.display,
    source: clean({ table, filter: p.filter, sort: p.sort, limit: p.limit, group }),
    show: clean({
      title: p.titleField,
      subtitles: p.subtitleFields,
      trailing: p.trailingField,
      format: p.trailingFormat,
      color: p.colorField,
      emptyText: p.emptyText,
    }),
    tools: nonEmpty(tools),
    opens: p.opens,
  };
}

/** v33 page -> v34 page (toolId -> package, recordOf -> of, components -> blocks). */
export function migratePageV33(page: Json, tables: V33Tables): Json {
  const { toolId, recordOf, components, ...rest } = page;
  return clean({
    ...rest,
    package: toolId,
    of: recordOf,
    blocks: ((components as Json[] | undefined) ?? []).map((c) => migrateComponentV33(c, tables)),
  });
}

/** v33 workflow -> v34 quick action (toolId -> package, presetId -> preset; homeScreen moved into nav). */
export function migrateWorkflowV33(w: Json): Json {
  const { toolId, presetId, homeScreen: _home, id, name, icon, steps, ...rest } = w;
  return clean({
    id,
    kind: 'quickAction',
    name,
    icon,
    package: toolId,
    preset: presetId,
    ...rest,
    steps,
  });
}

/** v33 reminder -> v34 reminder (schedule + time + weekdays + collectionId + fieldId + daysBefore -> when). */
export function migrateReminderV33(r: Json, tables: V33Tables): Json {
  const at = r.time;
  const on = { table: r.collectionId, field: r.fieldId };
  const when =
    r.schedule === 'daily'
      ? { every: 'day', at }
      : r.schedule === 'weekly'
        ? { every: 'week', days: r.weekdays, at }
        : r.schedule === 'dateField'
          ? { before: on, days: r.daysBefore ?? 0, at }
          : { each: on, at };
  const table = tables.find(r.collectionId);
  const done = isObject(r.done)
    ? r.done.do === 'create'
      ? clean({
          do: 'create',
          table: r.done.collectionId,
          values: values(r.done.values, tables.find(r.done.collectionId)),
        })
      : r.done.do === 'set'
        ? {
            do: 'set',
            table: r.collectionId,
            field: r.done.fieldId,
            value: value(r.done.value, table, r.done.fieldId),
          }
        : { do: 'increment', table: r.collectionId, field: r.done.fieldId, by: r.done.by }
    : undefined;
  const unless = isObject(r.unless)
    ? clean({
        table: r.unless.collectionId,
        within: r.unless.within,
        filter: r.unless.filter,
        date: r.unless.dateField,
        link: r.unless.link,
      })
    : undefined;
  return clean({
    id: r.id,
    kind: 'reminder',
    title: r.title,
    enabled: r.enabled,
    when,
    opens: target(r.opens),
    done,
    snoozeMinutes: r.snoozeMinutes,
    unless,
  });
}

/** Room layout: top and bottom components converted block by block, toolbar {workflowId} -> quick action ID. */
function desk(d: unknown, tables: V33Tables): Json | undefined {
  if (!isObject(d)) return undefined;
  const slot = (list: unknown) =>
    Array.isArray(list) ? list.map((c) => migrateComponentV33(c as Json, tables)) : undefined;
  const tools = isObject(d.tools)
    ? Object.fromEntries(
        Object.entries(d.tools).map(([kind, groups]) => [
          kind,
          (groups as Json[]).map((g) => ({
            ...g,
            items: (g.items as Json[]).map((i) =>
              isObject(i) && 'workflowId' in i ? i.workflowId : i,
            ),
          })),
        ]),
      )
    : undefined;
  return clean({ ...d, above: slot(d.above), below: slot(d.below), tools });
}

/** Assign a unique replacement ID to colliding reminders (M1: quick action IDs are referenced more heavily by run records, last results, and usage habits). */
function uniqueReminderId(id: string, taken: Set<string>): string {
  if (!taken.has(id)) return id;
  for (let n = 2; ; n++) {
    const next = `${id}-reminder${n === 2 ? '' : `-${n}`}`.slice(0, 48);
    if (!taken.has(next)) return next;
  }
}

export function migrateV33toV34(config: Json): Json {
  const collections = ((config.collections as Json[] | undefined) ?? []) as Json[];
  const tables = v33Tables(collections);
  const workflows = ((config.workflows as Json[] | undefined) ?? []) as Json[];
  const taken = new Set(workflows.map((w) => w.id as string));
  const reminders = ((config.reminders as Json[] | undefined) ?? []).map((r) => {
    const id = uniqueReminderId(r.id as string, taken);
    taken.add(id);
    return migrateReminderV33({ ...r, id }, tables);
  });
  const shell = (config.shell ?? {}) as Json;
  const homeScreen = workflows.filter((w) => w.homeScreen === true).map((w) => w.id as string);
  const data = clean({
    tables: collections.map((c) => migrateTableV33(c, tables)),
    calendar: config.calendar,
  });
  return {
    schemaVersion: 34,
    theme: config.theme,
    nav: clean({
      bar: shell.nav,
      floating: shell.floating,
      phoneHomeScreen: nonEmpty(homeScreen),
    }),
    data,
    containers: clean({
      pages: ((config.pages as Json[] | undefined) ?? []).map((p) => migratePageV33(p, tables)),
      desk: desk(config.desk, tables),
    }),
    tools: [...workflows.map(migrateWorkflowV33), ...reminders],
    packages: ((config.tools as Json[] | undefined) ?? []).map((t) => ({
      id: t.toolId,
      version: t.version,
      page: t.pageId,
    })),
  };
}
