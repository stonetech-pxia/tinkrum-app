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

// App 文件（D-485）：一个 App 的全部内容（页面、表、快捷操作、提醒、风格），导入时加到现有的工作区里，
// 不替换任何东西。和「App 配置」（整份工作区，D-484）不同：这里的 ID 已经带了 App 自己的前缀，不会和别的
// App 撞；不含记录、用户文件、工具包、桌面菜单、日历这类整个工作区才有的设置。
// 旧版本的文件靠 schemaVersion 迁移（借整份配置的迁移，底线 12）；导入走 addContainer / addData / addTool 这些
// 普通操作：先预览，用户确认才生效，改动记录里能撤销（底线 7、18）。

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
  /** 内容用到的画出来的图标（D-new-extensibility-2）；没用到就不写。 */
  icons?: Record<string, DrawnIcon>;
}

/** 写 App 文件。外层带「用到了什么」（D-556），读的版本能说出自己缺什么；它不是 App 的一部分，导入时不读进配置。 */
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
 * 把装好的一个 App 做成 App 文件（D-545，「分享这个 App」）：它的页面、表、快捷操作、提醒，加上名字、图标、
 * 底栏和风格。只有结构：记录本来就不在配置里（底线 14）；指向用户文件的地方（文件位、图片、图片背景）
 * 先清空（底线 3），导入后由用户自己选。没有这个 App 返回 null。
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

/** 内容用到的画出来的图标，从图标库里取（D-new-extensibility-2）；一个都没有返回空对象，调用的人不写这个键。 */
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

/** 借整份配置的外壳（只有 App 的这几样），走一遍迁移，再拆开。 */
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
 * 读 App 文件：形状不对返回 null；旧版本迁移到当前版本。只认形状，内容合不合法由导入时的校验管（底线 12、18）。
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

/** 怎么导入（D-485）：做成一个新 App（主页多一个入口），或者导入主页（换主页风格，页面加进导航栏）。 */
export type ImportMode = 'app' | 'home';

/**
 * 导入一个 App 文件的操作。表的 ID 已经在、并且在主页手里（例如之前删过这个 App，表转给了主页）：
 * 接回来，缺的字段补上，记录不动（底线 5）；页面、快捷操作、提醒、App 的 ID 重名，或表属于别的 App 时拒绝。
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
  // 画出来的图标先加进图标库（D-new-extensibility-2）：后面的表、页面、快捷操作要用。
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
    // 接回来：属于这个 App，缺的字段补上，已有的不改（更新时照文件改，见 tableUpdateOps）。
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
    // 主页上放一个入口（用户随时能删；设置 → 我的 App 照样进得去）。
    if (config.containers.pages.some((p) => p.id === HOME_PAGE_ID))
      ops.push({
        op: 'addContainer',
        page: HOME_PAGE_ID,
        block: { id: `go-${id}`.slice(0, 48), look: 'entry', opens: `app:${id}` },
      } as unknown as Op);
  } else {
    // 导入主页：换成它的风格，它的页面加进主页的导航栏（放得下的）；放不下的由主页上的入口接住。
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
  // 步数不设上限（D-554）：大小由配置的上限管，用的时候带 fromAppFile 走 prepareOps。
  return { ok: true, ops, name: file.app.name };
}

/**
 * 文件里的图标怎么进图标库（D-new-extensibility-2）：内容用到的 my:<id> 文件里必须有；ID 已经在而且一样的直接用；
 * 不一样的，工作区里别处已经没人用就换成文件里的（更新、恢复同一个 App 时就是这样），还有人用就给文件里的改名
 * （-2、-3…），文件内容里的引用一起改。
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
  // 文件要接回去的表（同 ID）不算别人在用：它们本来就是这个 App 的。
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

/** 图标 ID 撞了：加 -2、-3…，太长先截短（ID 最多 24 个字符）。 */
function freeIconId(base: string, taken: ReadonlySet<string>): string {
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const id = `${base.slice(0, 24 - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (!taken.has(id)) return id;
  }
}

/**
 * 恢复这个 App 的初始样子（D-485）：把现在的 App 删掉（页面、快捷操作、提醒、入口一起去掉，表和记录转给主页，
 * 底线 5），再用原来的 App 文件装回来：表接回来、缺的字段补上，用户自己建的表留在主页。
 * 在桌面菜单里的还放回去。能在改动记录里撤销。
 */
export function appResetOps(file: AppFile, config: WorkspaceConfig, registry: Registry): AppImport {
  return reinstallOps(file, config, registry, false);
}

/**
 * 用改过的 App 文件更新装好的同一个 App（D-611，别的 AI 改完交回来的文件）：和恢复初始样子一样先移除再装回，
 * 页面、快捷操作、提醒、名字、风格、底栏都换成文件里的；表按 ID 接回来后照文件改：表名、图标，字段加、改、去、
 * 排序。去掉的字段记录里的值留着，文件里没有的表连同记录归主页（底线 5）；字段类型只能在能互换的类型之间换，
 * 别的由操作拒绝，说「加一个新字段」（和 Tink 改的时候一样）。能在改动记录里撤销。
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
  // 更新时主页上的入口放回原来的位置（D-611）：移除 App 时它被去掉，装回时默认加在主页最后。
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

/** 表上能照文件改的属性（和 updateData 允许的一样，app 由导入自己管）。 */
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
 * 把装好的表 have 改成文件里的 next（D-611）：只用普通操作，所以每一步都有和 Tink 改的时候一样的检查。
 * 字段按 ID 对：新的加、变了的整个换成文件里的（去掉的属性写 null）、文件里没有的去掉（值留在记录里），
 * 最后按文件的顺序排。
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
 * 用文件更新 App 时预览里列的（D-611）：比较更新前后这个 App 自己的东西，只说真正变了的（页面、表、字段、
 * 快捷操作和提醒、名字、风格）。更新是先移除再装回，逐个操作的说法会说「移除 App」，用户看了会误会。
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

// ---- 整份配置 → App 文件（做预设用）----

/**
 * 引用 ID 的位置（和数据表、页面、快捷操作的结构对应）：只改这些位置，别的（字段 ID、块 ID、文案）不动。
 * 漏改的位置会让引用指向不存在的东西，校验器会报出来，所以转换后一定要校验。
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
    // 记录块的 opens 是给一条记录用的页面（D-342）。
    return map.pages.get(node) ?? node;
  }
  return node;
}

export interface ConvertMeta {
  /** App 的 ID，也是所有页面、表、快捷操作 ID 的前缀（≤ 20 个字符）。 */
  id: string;
  name: string;
  icon?: IconValue;
}

/**
 * 把一份整份工作区的配置做成一个 App 文件：ID 加前缀并改好引用，主页变成 App 的第一页，底栏只留页面和 Tink。
 * 工具包、桌面菜单、浮动入口、文件桌面、日历是整个工作区的设置，不带。
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
