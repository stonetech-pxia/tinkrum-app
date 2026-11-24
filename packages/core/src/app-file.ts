import { drawnIconUses, renameDrawnIcons, type DrawnIcon } from './drawn-icons';
import { clearFileRefs } from './file-refs';
import { usesOf } from './file-uses';
import { homeScreenOp } from './home-screen';
import { applyOps, type Op } from './ops';
import { migrateWorkspace } from './migrate';
import { t } from './messages';
import type { Registry } from './registry';
import {
  CURRENT_SCHEMA_VERSION,
  HOME_PAGE_ID,
  type Collection,
  type Locale,
  type Page,
  type Tool,
  type WorkspaceConfig,
} from './schema';
import type { AppBarTarget, IconValue, Theme } from './schema-base';

// App file (D-485): Contains an app's entire content (pages, tables, quick actions, reminders,
// styles); merged into the existing workspace on import without replacing anything. Unlike "App
// config" (the entire workspace, D-484), IDs here already have the app's own prefix to avoid
// collisions; it does not include records, user files, packs, home screen menus, or calendars,
// which are workspace-wide. Older file versions are migrated via schemaVersion (using full config
// migration, invariant 12); import uses standard operations like addContainer, addData, and
// addTool: previewed first, taking effect only upon user confirmation, and undoable in change
// history (invariants 7, 18).

export const APP_FILE_FORMAT = 'tinkrum-app';
const FILE_VERSION = 1;

export interface AppFile {
  format: typeof APP_FILE_FORMAT;
  version: 1;
  exportedAt: string;
  schemaVersion: number;
  app: { id: string; name: string; icon?: IconValue; bar: AppBarTarget[]; theme: Theme };
  pages: Page[];
  tables: Collection[];
  tools: Tool[];
  /** Drawn icons used by the content (D-625); omitted if unused. */
  icons?: Record<string, DrawnIcon>;
}

/** Write an app file. Outer layer includes usage metadata (D-556), so readers can report missing dependencies; it is not part of the app itself and is not read into config during import. */
export function appFileText(file: Omit<AppFile, 'format' | 'version' | 'exportedAt'>, now: Date) {
  return JSON.stringify(
    {
      format: APP_FILE_FORMAT,
      version: FILE_VERSION,
      exportedAt: now.toISOString(),
      uses: usesOf(file),
      ...file,
    },
    null,
    2,
  );
}

/**
 * Turn an installed app into an app file (D-545, "Share this app"): Includes its pages, tables,
 * quick actions, reminders, along with name, icon, tab bar, and style. Structure only: records
 * are excluded by design (invariant 14); user file references (file slots, images, image
 * backgrounds) are cleared (invariant 3) and re-selected by the user after import. Returns null
 * if the app does not exist.
 */
export function appFileOfApp(
  config: WorkspaceConfig,
  appId: string,
): Omit<AppFile, 'format' | 'version' | 'exportedAt'> | null {
  const app = (config.nav.apps ?? []).find((a) => a.id === appId);
  if (!app) return null;
  const clean = clearFileRefs(config);
  const own = <T extends { app?: string | undefined }>(items: T[]): T[] =>
    items
      .filter((item) => item.app === appId)
      .map((item) => {
        const { app: _app, ...rest } = item;
        return rest as T;
      });
  const content = {
    schemaVersion: config.schemaVersion,
    app: {
      id: app.id,
      name: app.name,
      ...(app.icon !== undefined ? { icon: app.icon } : {}),
      bar: app.bar,
      theme: app.theme,
    },
    pages: own(clean.containers.pages),
    tables: own(clean.data.tables),
    tools: own(clean.tools),
  };
  return { ...content, ...withIcons(iconsUsedBy(content, config.icons)) };
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Get drawn icons used by the content from the icon library (D-625); returns an empty object if none are used, omitting the key. */
function iconsUsedBy(
  content: unknown,
  library: WorkspaceConfig['icons'],
): Record<string, DrawnIcon> {
  const out: Record<string, DrawnIcon> = {};
  for (const { id } of drawnIconUses(content)) if (library?.[id]) out[id] = library[id];
  return out;
}

const withIcons = (icons: Record<string, DrawnIcon>) =>
  Object.keys(icons).length > 0 ? { icons } : {};

/** Reuse the full config shell (restricted to the app's components), run migration, then split it apart. */
function wrap(file: AppFile): Record<string, unknown> {
  return {
    schemaVersion: file.schemaVersion,
    theme: file.app.theme,
    nav: { bar: ['page:home'], floating: [] },
    data: { tables: file.tables },
    containers: { pages: file.pages },
    tools: file.tools,
    packages: [],
  };
}

/**
 * Read an app file: returns null if the shape is invalid; migrates older versions to the current
 * version. Shape validation only; content validity is enforced by import-time validation
 * (invariants 12, 18).
 */
export function readAppFile(text: string): AppFile | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(data) || data.format !== APP_FILE_FORMAT) return null;
  const { app, pages, tables, tools, schemaVersion, icons } = data;
  if (
    (icons !== undefined && !isObject(icons)) ||
    !isObject(app) ||
    typeof app.id !== 'string' ||
    typeof app.name !== 'string' ||
    !Array.isArray(app.bar) ||
    !isObject(app.theme) ||
    !Array.isArray(pages) ||
    !Array.isArray(tables) ||
    !Array.isArray(tools) ||
    !Number.isInteger(schemaVersion)
  )
    return null;
  const file = data as unknown as AppFile;
  if (file.schemaVersion === CURRENT_SCHEMA_VERSION) return file;
  const migrated = migrateWorkspace(wrap(file));
  if (!migrated.ok) return null;
  const m = migrated.config as unknown as WorkspaceConfig;
  return {
    ...file,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    app: { ...file.app, theme: m.theme },
    pages: m.containers.pages,
    tables: m.data.tables,
    tools: m.tools,
  };
}

export type AppImport = { ok: true; ops: Op[]; name: string } | { ok: false; error: string };

/** Import mode (D-485): Create as a new app (adding a home screen entry point), or import into home (replacing home style, adding pages to navigation bar). */
export type ImportMode = 'app' | 'home';

/**
 * Operations for importing an app file. If the table ID already exists and belongs to home (e.g.,
 * the app was previously deleted and its tables transferred to home): reconnect them, fill in
 * missing fields, leave records untouched (invariant 5); reject if pages, quick actions,
 * reminders, or app IDs conflict, or if a table belongs to another app.
 */
export function appFileOps(
  file: AppFile,
  config: WorkspaceConfig,
  options: { mode?: ImportMode; update?: boolean } = {},
): AppImport {
  const mode = options.mode ?? 'app';
  const id = file.app.id;
  const existingTable = new Map(config.data.tables.map((t) => [t.id, t]));
  const taken = (what: string, ids: string[], have: Set<string>) => {
    const clash = ids.filter((x) => have.has(x));
    return clash.length > 0 ? `${what} ${clash.join(', ')} already exist` : null;
  };
  const clash =
    (mode === 'app'
      ? taken('app', [id], new Set((config.nav.apps ?? []).map((a) => a.id)))
      : null) ??
    taken(
      'page',
      file.pages.map((p) => p.id),
      new Set(config.containers.pages.map((p) => p.id)),
    ) ??
    taken(
      'table',
      file.tables.filter((t) => existingTable.get(t.id)?.app !== undefined).map((t) => t.id),
      new Set(config.data.tables.map((t) => t.id)),
    ) ??
    taken(
      'quick action or reminder',
      file.tools.map((t) => t.id),
      new Set(config.tools.map((t) => t.id)),
    );
  if (clash) return { ok: false, error: clash };
  const icons = importedIcons(file, config);
  if (!icons.ok) return icons;
  file = icons.file;
  const owner = mode === 'app' ? { app: id } : {};
  const ops: Op[] = [];
  // Add drawn icons to the icon library first (D-625) so subsequent tables, pages, and quick actions can reference them.
  if (Object.keys(icons.add).length > 0) ops.push({ op: 'setTheme', icons: icons.add });
  if (mode === 'app')
    ops.push({
      op: 'addContainer',
      app: {
        id,
        name: file.app.name,
        ...(file.app.icon !== undefined ? { icon: file.app.icon } : {}),
        bar: file.app.bar,
        theme: file.app.theme,
      },
    });
  for (const table of file.tables) {
    const have = existingTable.get(table.id);
    if (!have) {
      ops.push({ op: 'addData', table: { ...table, ...owner } as never });
      continue;
    }
    // Reconnect: belongs to this app, fill in missing fields, keep existing ones unchanged (updated according to file changes, see tableUpdateOps).
    if (mode === 'app')
      ops.push({ op: 'updateData', table: table.id, changes: { app: id } } as never);
    if (options.update) {
      ops.push(...tableUpdateOps(have, table));
      continue;
    }
    const fields = new Set(have.fields.map((f) => f.id));
    for (const field of table.fields)
      if (!fields.has(field.id)) ops.push({ op: 'addData', table: table.id, field } as never);
  }
  for (const tool of file.tools) ops.push({ op: 'addTool', tool: { ...tool, ...owner } as never });
  for (const page of file.pages)
    ops.push({ op: 'addContainer', page: { ...page, ...owner } as never });
  if (mode === 'app') {
    // Place an entry point on the home screen (deletable by the user at any time; still accessible via Settings -> My Apps).
    if (config.containers.pages.some((p) => p.id === HOME_PAGE_ID))
      ops.push({
        op: 'addContainer',
        page: HOME_PAGE_ID,
        block: { id: `go-${id}`.slice(0, 48), look: 'entry', opens: `app:${id}` },
      } as unknown as Op);
  } else {
    // Import into home: Switch to its style, and add its pages to the home navigation bar (where they fit); overflow items are handled by the entry point on the home screen.
    ops.push({ op: 'setTheme', reset: true });
    ops.push({ op: 'setTheme', ...file.app.theme } as unknown as Op);
    const wanted = file.app.bar.filter((t) => t.startsWith('page:'));
    const bar = [...config.nav.bar];
    const room = 5 - bar.length;
    if (room > 0 && wanted.length > 0) {
      const at = bar.findIndex((t) => t === 'ai' || t === 'settings');
      bar.splice(at < 0 ? bar.length : at, 0, ...wanted.slice(0, room));
      ops.push({ op: 'updateContainer', nav: { bar } });
    }
  }
  // No step limit (D-554): size is bounded by config limits; runs via prepareOps with fromAppFile.
  return { ok: true, ops, name: file.app.name };
}

/**
 * How file icons enter the icon library (D-625): Content-referenced my:<id> icons must exist in
 * the file; if the ID already exists and matches, reuse it; if it differs and is no longer used
 * elsewhere in the workspace, replace it with the file's icon (used when updating or restoring
 * the same app); if still in use elsewhere, rename the file's icon (-2, -3, etc.) and update
 * references in the file content accordingly.
 */
function importedIcons(
  file: AppFile,
  config: WorkspaceConfig,
): { ok: true; file: AppFile; add: Record<string, DrawnIcon> } | { ok: false; error: string } {
  const library = file.icons ?? {};
  const content = { app: file.app, pages: file.pages, tables: file.tables, tools: file.tools };
  const missing = drawnIconUses(content).filter((u) => !library[u.id]);
  if (missing.length > 0)
    return {
      ok: false,
      error: missing
        .map((u) => `${u.where}: icon my:${u.id} is not defined in the file's icons`)
        .join('; '),
    };
  const have = config.icons ?? {};
  // Tables to be reconnected by the file (matching IDs) are not considered in use by others: they originally belonged to this app.
  const retaken = new Set(file.tables.map((t) => t.id));
  const others = {
    ...config,
    data: { ...config.data, tables: config.data.tables.filter((t) => !retaken.has(t.id)) },
  };
  const used = new Set(drawnIconUses(others).map((u) => u.id));
  const taken = new Set([...Object.keys(have), ...Object.keys(library)]);
  const renames = new Map<string, string>();
  const add: Record<string, DrawnIcon> = {};
  for (const [iconId, icon] of Object.entries(library)) {
    const existing = have[iconId];
    if (existing && same(existing, icon)) continue;
    if (!existing || !used.has(iconId)) {
      add[iconId] = icon;
      continue;
    }
    const to = freeIconId(iconId, taken);
    taken.add(to);
    renames.set(iconId, to);
    add[to] = icon;
  }
  if (renames.size === 0) return { ok: true, file, add };
  return { ok: true, file: { ...file, ...renameDrawnIcons(content, renames) }, add };
}

/** Icon ID collision: Append -2, -3, etc., truncating if too long (IDs have a maximum of 24 characters). */
function freeIconId(base: string, taken: ReadonlySet<string>): string {
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const id = `${base.slice(0, 24 - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (!taken.has(id)) return id;
  }
}

/**
 * Restore an app to its initial state (D-485): Delete the current app (removing pages, quick
 * actions, reminders, and entry points together, transferring tables and records to home,
 * invariant 5), then reinstall using the original app file: reconnect tables, fill in missing
 * fields, and keep user-created tables on home. Restores items previously in the desktop menu.
 * Undoable in change history.
 */
export function appResetOps(file: AppFile, config: WorkspaceConfig, registry: Registry): AppImport {
  return reinstallOps(file, config, registry, false);
}

/**
 * Update an installed app using a modified app file (D-611, files returned by another AI):
 * Replaced and re-installed just like factory reset; pages, quick actions, reminders, name,
 * style, and tab bar are replaced with those in the file; tables are reconnected by ID and
 * updated per the file: table name, icon, and fields (added, modified, removed, reordered).
 * Values of removed fields remain in records; tables absent from the file along with their
 * records revert to home (invariant 5); field types can only be changed between compatible types,
 * others are rejected by operations with a "Add a new field" message (matching Tink
 * modifications). Undoable in change history.
 */
export function appUpdateOps(
  file: AppFile,
  config: WorkspaceConfig,
  registry: Registry,
): AppImport {
  return reinstallOps(file, config, registry, true);
}

function reinstallOps(
  file: AppFile,
  config: WorkspaceConfig,
  registry: Registry,
  update: boolean,
): AppImport {
  const id = file.app.id;
  if (!(config.nav.apps ?? []).some((a) => a.id === id))
    return { ok: false, error: `app ${id} is not installed` };
  const removal: Op = { op: 'removeContainer', app: id };
  const mid = applyOps(config, [removal], { registry, locale: 'en' });
  if (!mid.ok) return { ok: false, error: mid.error };
  const plan = appFileOps(file, mid.config, { update });
  if (!plan.ok) return plan;
  const onMenu = (config.nav.phoneHomeScreen ?? []).includes(`app:${id}`);
  // Restore home screen entry points to their original positions upon update (D-611): Removed during app deletion, and added at the end of home by default when re-installed.
  const home = config.containers.pages.find((p) => p.id === HOME_PAGE_ID);
  const at = update
    ? (home?.blocks.findIndex((b) => (b as { opens?: unknown }).opens === `app:${id}`) ?? -1)
    : -1;
  const placed = plan.ops.map((op) =>
    at >= 0 &&
    op.op === 'addContainer' &&
    op.page === HOME_PAGE_ID &&
    (op.block as { opens?: unknown } | undefined)?.opens === `app:${id}`
      ? ({ ...op, block: home!.blocks[at], index: at } as Op)
      : op,
  );
  const ops: Op[] = [
    removal,
    ...placed,
    ...(onMenu ? [homeScreenOp(mid.config, `app:${id}`, true)] : []),
  ];
  return { ok: true, ops, name: file.app.name };
}

/** Table properties that can be updated from the file (matching what updateData allows; app management is handled separately by import). */
const TABLE_KEYS = [
  'name',
  'icon',
  'readAttachments',
  'prefillRules',
  'recordRow',
  'form',
] as const;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Update an installed collection have to the file version next (D-611): Uses standard operations
 * only, ensuring every step undergoes the same checks as Tink modifications. Match fields by ID:
 * add new ones, replace modified ones entirely with file definitions (setting removed properties
 * to null), remove missing ones (retaining values in records), and finally sort according to the
 * file order.
 */
function tableUpdateOps(have: Collection, next: Collection): Op[] {
  const ops: Op[] = [];
  const changes: Record<string, unknown> = {};
  for (const key of TABLE_KEYS) {
    const before = (have as Record<string, unknown>)[key];
    const after = (next as Record<string, unknown>)[key];
    if (!same(before, after)) changes[key] = after ?? null;
  }
  if (Object.keys(changes).length > 0)
    ops.push({ op: 'updateData', table: have.id, changes } as never);
  const nextIds = new Set(next.fields.map((f) => f.id));
  for (const field of have.fields)
    if (!nextIds.has(field.id)) ops.push({ op: 'removeData', table: have.id, field: field.id });
  const order = have.fields.filter((f) => nextIds.has(f.id)).map((f) => f.id);
  for (const field of next.fields) {
    const old = have.fields.find((f) => f.id === field.id);
    if (!old) {
      ops.push({ op: 'addData', table: have.id, field } as never);
      order.push(field.id);
      continue;
    }
    if (same(old, field)) continue;
    const { id: _id, ...wanted } = field as unknown as Record<string, unknown>;
    const patch: Record<string, unknown> = { ...wanted };
    for (const key of Object.keys(old)) if (key !== 'id' && !(key in wanted)) patch[key] = null;
    ops.push({ op: 'updateData', table: have.id, field: field.id, changes: patch } as never);
  }
  next.fields.forEach((field, index) => {
    if (order[index] === field.id) return;
    ops.push({ op: 'moveData', table: have.id, field: field.id, toIndex: index });
    order.splice(order.indexOf(field.id), 1);
    order.splice(index, 0, field.id);
  });
  return ops;
}

/**
 * Preview items when updating an app with a file (D-611): Compares the app itself before and
 * after the update, reporting only genuine changes (pages, tables, fields, quick actions,
 * reminders, name, style). Since updates involve removal and re-installation, individual
 * operations would otherwise say "Remove app", confusing the user.
 */
export function describeAppUpdate(
  before: WorkspaceConfig,
  after: WorkspaceConfig,
  appId: string,
  locale: Locale,
): string[] {
  const lines: string[] = [];
  const strip = <T extends { app?: string | undefined }>(x: T) => {
    const { app: _app, ...rest } = x;
    return JSON.stringify(rest);
  };
  const own = <T extends { app?: string | undefined; id: string }>(items: T[]) =>
    new Map(items.filter((x) => x.app === appId).map((x) => [x.id, x]));
  const appBefore = (before.nav.apps ?? []).find((a) => a.id === appId);
  const appAfter = (after.nav.apps ?? []).find((a) => a.id === appId);
  if (appBefore && appAfter && appBefore.name !== appAfter.name)
    lines.push(t(locale, 'updateAppRenamed', { name: appAfter.name }));
  if (appBefore && appAfter && !same(appBefore.theme, appAfter.theme))
    lines.push(t(locale, 'updateStyle'));
  const pagesBefore = own(before.containers.pages);
  const pagesAfter = own(after.containers.pages);
  for (const [id, page] of pagesAfter) {
    const old = pagesBefore.get(id);
    if (!old) lines.push(t(locale, 'updatePageAdded', { page: page.title }));
    else if (strip(old) !== strip(page))
      lines.push(t(locale, 'updatePageChanged', { page: page.title }));
  }
  for (const [id, page] of pagesBefore)
    if (!pagesAfter.has(id)) lines.push(t(locale, 'updatePageRemoved', { page: page.title }));
  const tablesBefore = own(before.data.tables);
  const tablesAfter = own(after.data.tables);
  for (const [id, table] of tablesAfter) {
    const old = tablesBefore.get(id);
    if (!old) {
      lines.push(t(locale, 'updateTableAdded', { table: table.name }));
      continue;
    }
    if (old.name !== table.name)
      lines.push(t(locale, 'updateTableRenamed', { old: old.name, table: table.name }));
    for (const field of table.fields) {
      const was = old.fields.find((f) => f.id === field.id);
      if (!was) lines.push(t(locale, 'updateFieldAdded', { table: table.name, field: field.name }));
      else if (!same(was, field))
        lines.push(t(locale, 'updateFieldChanged', { table: table.name, field: field.name }));
    }
    for (const field of old.fields)
      if (!table.fields.some((f) => f.id === field.id))
        lines.push(t(locale, 'updateFieldRemoved', { table: table.name, field: field.name }));
  }
  for (const [id, table] of tablesBefore)
    if (!tablesAfter.has(id)) lines.push(t(locale, 'updateTableLeft', { table: table.name }));
  const toolsBefore = own(before.tools);
  const toolsAfter = own(after.tools);
  const toolName = (tool: Tool) => ('name' in tool ? tool.name : tool.title);
  for (const [id, tool] of toolsAfter) {
    const old = toolsBefore.get(id);
    if (!old) lines.push(t(locale, 'updateToolAdded', { tool: toolName(tool) }));
    else if (strip(old) !== strip(tool))
      lines.push(t(locale, 'updateToolChanged', { tool: toolName(tool) }));
  }
  for (const [id, tool] of toolsBefore)
    if (!toolsAfter.has(id)) lines.push(t(locale, 'updateToolRemoved', { tool: toolName(tool) }));
  return lines.length > 0 ? lines : [t(locale, 'updateNothing')];
}

// ---- Full config -> App file (for presets) ----

/**
 * Locations of ID references (corresponding to the structure of data tables, pages, and quick
 * actions): only modify these locations, leaving others (field IDs, block IDs, copy) untouched.
 * Omitted modifications will cause references to point to non-existent items, triggering
 * validator errors; therefore, validation is mandatory after conversion.
 */
function rename(
  node: unknown,
  key: string | null,
  map: { pages: Map<string, string>; tables: Map<string, string>; tools: Map<string, string> },
): unknown {
  if (Array.isArray(node)) return node.map((x) => rename(x, key, map));
  if (isObject(node)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) out[k] = rename(v, k, map);
    return out;
  }
  if (typeof node !== 'string') return node;
  if (key === 'table' || key === 'collectionId' || key === 'of')
    return map.tables.get(node) ?? node;
  if (key === 'tool') return map.tools.get(node) ?? node;
  if (key === 'opens') {
    if (node.startsWith('page:')) return `page:${map.pages.get(node.slice(5)) ?? node.slice(5)}`;
    if (node.startsWith('tool:')) return `tool:${map.tools.get(node.slice(5)) ?? node.slice(5)}`;
    // Record block opens refers to a page used for a single record (D-342).
    return map.pages.get(node) ?? node;
  }
  return node;
}

export interface ConvertMeta {
  /** App ID, also serving as the prefix for all page, table, and quick action IDs (<= 20 characters). */
  id: string;
  name: string;
  icon?: IconValue;
}

/**
 * Convert a full workspace configuration into an app file: Add prefixes to IDs and update
 * references, make home the app's first page, and restrict the bottom bar to pages and Tink.
 * Toolboxes, desktop menus, floating entry points, file desks, and calendars are workspace-wide
 * settings and are excluded.
 */
export function appFileFromWorkspace(
  config: WorkspaceConfig,
  meta: ConvertMeta,
): Omit<AppFile, 'format' | 'version' | 'exportedAt'> {
  const prefixed = (id: string) => `${meta.id}-${id}`;
  const pages = config.containers.pages.filter((p) => p.package === undefined);
  const map = {
    pages: new Map(pages.map((p) => [p.id, prefixed(p.id)])),
    tables: new Map(config.data.tables.map((t) => [t.id, prefixed(t.id)])),
    tools: new Map(
      config.tools.filter((t) => t.package === undefined).map((t) => [t.id, prefixed(t.id)]),
    ),
  };
  const withId = <T extends { id: string }>(item: T, to: Map<string, string>) => ({
    ...(rename(item, null, map) as T),
    id: to.get(item.id)!,
  });
  const bar = config.nav.bar.flatMap((target): AppBarTarget[] => {
    if (target === 'ai') return ['ai'];
    if (target.startsWith('page:')) {
      const id = map.pages.get(target.slice(5));
      return id ? [`page:${id}`] : [];
    }
    return [];
  });
  if (!bar.includes('ai') && bar.length < 5) bar.push('ai');
  const strip = <T extends { app?: string | undefined }>(item: T): T => {
    const { app: _app, ...rest } = item;
    return rest as T;
  };
  const content = {
    schemaVersion: config.schemaVersion,
    app: {
      id: meta.id,
      name: meta.name,
      ...(meta.icon !== undefined ? { icon: meta.icon } : {}),
      bar,
      theme: config.theme,
    },
    pages: pages.map((p) => strip(withId(p, map.pages))),
    tables: config.data.tables.map((t) => strip(withId(t, map.tables))),
    tools: config.tools
      .filter((t) => t.package === undefined)
      .map((t) => strip(withId(t, map.tools))),
  };
  return { ...content, ...withIcons(iconsUsedBy(content, config.icons)) };
}
