import {
  buttonKind,
  isChoiceTabs,
  isTimeTabs,
  type ButtonKind,
  type ChoiceTabs,
} from './components';
import { MULTIPLE_CHOICE_NOT_ONE } from './fields';
import { addMissingEntryForms } from './entry-forms';
import type { BlockChanges, Op, OpOf } from './ops-schema';
import { THEME_PRESETS } from './presets';
import {
  isRecordToolUse,
  isOpenUse,
  isToolRefUse,
  tapWrites,
  toolEntryFields,
  valueEntryFields,
  type RecordTool,
  type ToolUse,
} from './record-ops-schema';
import type { Registry } from './registry';
import { reminderProblems } from './reminders';
import {
  FIELDS,
  HOME_PAGE_ID,
  MAX_RECORD_REMINDERS,
  MAX_REMINDERS,
  PROTECTED_TARGETS,
  allComponents,
  appTarget,
  childrenOf,
  componentCollection,
  componentTarget,
  isKnownComponent,
  isRecordReminder,
  packageTarget,
  packageTargetId,
  pageTarget,
  patchBackdrop,
  quickActionsOf,
  toolGridToolIds,
  toolTarget,
  type App,
  type AppBarTarget,
  type BackdropPatch,
  type Collection,
  type Component,
  type KnownComponent,
  type Locale,
  type NavTarget,
  type Page,
  type QuickAction,
  type Reminder,
  type Theme,
  type ThemeColors,
  type Tool,
  type WorkflowStep,
  type WorkspaceConfig,
} from './schema';
import { DEFAULT_THEME } from './theme';
import { pageBrowseLists } from './page-zones';
import { handedInput, workflowProblems } from './workflow/check';
import { REDACTED_TEXT } from './workflow/redact';
import { missingPlace, stepRefs } from './workflow/refs';
import { presetById } from './workflows/presets';

export * from './ops-schema';

// Execution of semantic modification operations (§7D, 14 total in v34, structures defined in
// ops-schema.ts). applyOps is a pure function that does not mutate the input; it handles execution
// and reference checks only, while full validity is determined by validateWorkspace. Cascading
// cleanup on deletion (D-371) is performed here and recorded as ApplyNotes to inform the user in
// the preview.

/** Adjustments automatically made by the system during the apply process, which need to be communicated to the user in the preview. */
export type ApplyNote =
  | { kind: 'movedToFloating'; target: NavTarget }
  /** When a page is removed, buttons and entry points opening it are also removed. */
  | { kind: 'removedLinks'; pageId: string; count: number }
  /** When a table is removed, blocks reading it (lists, forms, numbers, charts, and associated summary numbers) are removed as well. */
  | { kind: 'removedDataComponents'; table: string; count: number }
  /** When a quick action is removed, blocks running it (actions) are also removed. */
  | { kind: 'removedRunners'; tool: string; count: number }
  /** Buttons and entry points opening this quick action (D-256), as well as this item on the file room toolbar. */
  | { kind: 'removedWorkflowLinks'; tool: string; count: number }
  /** If the quick action/page to be opened, table, or field required by a reminder is removed, the reminder is also removed (D-251). */
  | { kind: 'removedReminders'; titles: string[] }
  /**
   * When deleting a field or table, local one-tap record tools using it (D-304) are cleaned up:
   * buttons are removed, tools on record blocks are stripped, checklist tools fall back to lists
   * when check tools are removed, and boards become view-only when drag tools are removed.
   */
  | { kind: 'removedRecordActions'; count: number }
  /** When a table is removed, its dedicated record page (page.of, D-342) is also removed. */
  | { kind: 'removedRecordPages'; titles: string[] }
  /** Block settings (fields selectable in lists, fields displayed in single records, filter conditions by table) referencing deleted items are cleared (D-424). */
  | { kind: 'clearedBlockRefs'; count: number }
  /**
   * When deleting tables or fields, steps in quick actions referencing them (CHAIN_AUDIT A3):
   * steps are removed steps, trimmed are steps with only this field removed (action ID); removed:
   * remaining steps cannot function, so the entire quick action is removed.
   */
  | { kind: 'prunedSteps'; name: string; steps: string[]; trimmed: string[]; removed: boolean }
  /** If the table belonging to a newly added record block has no location to add records, an "Add" button is added above it (D-310). */
  | { kind: 'addedEntryForm'; table: string }
  | { kind: 'addedPageEntry'; page: string }
  /** A new app was put into the menu of the Tinkrum icon on the phone (D-647). */
  | { kind: 'appOnHomeScreen'; name: string }
  /** Removing an app (D-485): its tables are moved to the home page (records preserved); buttons and entry points opening it are removed. */
  | { kind: 'removedApp'; tables: string[]; links: boolean }
  /** Tool package upgraded to the current version, adding these quick actions. */
  | { kind: 'updatedTool'; package: string; tools: string[] };

/** Field types can only be converted between these compatible types, and existing values remain readable (field definition convertGroup). */
export const COMPATIBLE_FIELD_TYPES: readonly (readonly string[])[] = [
  ...new Set(FIELDS.flatMap((d) => (d.convertGroup ? [d.convertGroup] : []))),
].map((group) => FIELDS.filter((d) => d.convertGroup === group).map((d) => d.type));

export type ApplyResult =
  { ok: true; config: WorkspaceConfig; notes: ApplyNote[] } | { ok: false; error: string };

export interface ApplyContext {
  registry: Registry;
  /** Language used by the tool package pages and quick actions when adding a tool package. */
  locale: Locale;
}

class OpError extends Error {}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Merge patch: null removes the key, undefined leaves it untouched. */
function merge(target: Record<string, unknown>, changes: Record<string, unknown>) {
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) delete target[key];
    else if (value !== undefined) target[key] = value;
  }
  return target;
}

/** Changes can only contain these keys. */
function onlyKeys(changes: object, allowed: readonly string[], what: string): void {
  const extra = Object.keys(changes).filter((k) => !allowed.includes(k));
  if (extra.length > 0)
    throw new OpError(`${what} can change ${allowed.join(', ')}; not ${extra.join(', ')}`);
}

// ---- Containers: pages and blocks ----

function getPage(config: WorkspaceConfig, id: string): Page {
  const page = config.containers.pages.find((p) => p.id === id);
  if (!page) throw new OpError(`page ${id} not found`);
  return page;
}

interface Located {
  list: Component[];
  index: number;
  block: Component;
  /** Parent container; top level is null. */
  parent: Component | null;
}

/** Search within a list of blocks (including two levels deep inside groups). */
function findIn(list: Component[], id: string, parent: Component | null = null): Located | null {
  const index = list.findIndex((c) => c.id === id);
  if (index >= 0) return { list, index, block: list[index]!, parent };
  for (const c of list) {
    const found = findIn(childrenOf(c), id, c);
    if (found) return found;
  }
  return null;
}

const findBlock = (page: Page, id: string) => findIn(page.blocks, id);

function getBlock(page: Page, id: string): Located {
  const found = findBlock(page, id);
  if (!found) throw new OpError(`block ${id} not found on page ${page.id}`);
  return found;
}

/** Target block to modify: blocks unrecognized by this version (D-254) can only be moved or deleted. */
function known(block: Component): KnownComponent {
  if (!isKnownComponent(block)) {
    throw new OpError(
      `block ${block.id} needs a newer version of the app; it can only be moved or removed`,
    );
  }
  return block;
}

const isGroup = (c: Component) => isKnownComponent(c) && c.look === 'group';

/**
 * List where the block should be placed: top level of the page or child blocks of a group. Groups
 * support at most two levels (Q3): the inner level cannot contain further groups, and groups
 * containing groups can only reside at the top level of the page.
 */
function targetList(page: Page, parentId: string | undefined, moving: Component): Component[] {
  if (parentId === undefined) return page.blocks;
  if (parentId === moving.id) throw new OpError('a group cannot contain itself');
  if (findIn(childrenOf(moving), parentId)) throw new OpError('a group cannot contain itself');
  const { block: parent, parent: outer } = getBlock(page, parentId);
  if (!isGroup(parent)) throw new OpError(`block ${parentId} is not a group`);
  if (isGroup(moving)) {
    if (outer !== null)
      throw new OpError(
        `block ${parentId} is already inside a group; groups nest two levels at most`,
      );
    if (childrenOf(moving).some(isGroup))
      throw new OpError(
        `group ${moving.id} holds a group; it can only sit at the top of the page (groups nest two levels at most)`,
      );
  }
  return childrenOf(parent);
}

/** Blocks above and below the file room preview (D-358). */
function deskBlocks(config: WorkspaceConfig): Component[] {
  const desk = config.containers.desk;
  return [...(desk?.above ?? []), ...(desk?.below ?? [])] as Component[];
}

/** All blocks in the configuration: every page (including those inside groups), plus those above and below the file room preview. */
function everyBlock(config: WorkspaceConfig): Component[] {
  return [...config.containers.pages.flatMap(allComponents), ...deskBlocks(config)];
}

/** Delete blocks matching the predicate from all pages (including inside groups) and above/below the file room preview, returning the count of deleted blocks. */
function removeEverywhere(config: WorkspaceConfig, pred: (c: Component) => boolean): number {
  let count = 0;
  const prune = (list: Component[]): Component[] =>
    list.filter((c) => {
      if (pred(c)) {
        count++;
        return false;
      }
      if (isGroup(c)) (c as { children: Component[] }).children = prune(childrenOf(c));
      return true;
    });
  for (const page of config.containers.pages) page.blocks = prune(page.blocks);
  const desk = config.containers.desk;
  if (desk) {
    for (const slot of ['above', 'below'] as const) {
      if (!desk[slot]) continue;
      const kept = prune(desk[slot] as Component[]);
      if (kept.length > 0) desk[slot] = kept as never;
      else delete desk[slot];
    }
  }
  return count;
}

/** Position of the first non-header block; placed after the page title when "place at the very top" is requested. */
export function topIndex(page: Page): number {
  const i = page.blocks.findIndex((c) => !isKnownComponent(c) || c.look !== 'header');
  return i < 0 ? page.blocks.length : i;
}

/** Position for tool package entry points on the home page: after the last tool package entry point; if none, before the "Add tool" entry point, and otherwise after the title. */
function packageEntryIndex(home: Page): number {
  const isEntry = (c: Component, kind: ButtonKind) =>
    isKnownComponent(c) && c.look === 'button' && buttonKind(c) === kind;
  let last = -1;
  home.blocks.forEach((c, i) => {
    if (isEntry(c, 'package')) last = i;
  });
  if (last >= 0) return last + 1;
  const catalog = home.blocks.findIndex((c) => isEntry(c, 'link'));
  return catalog >= 0 ? catalog : topIndex(home);
}

/** The tool grid (a catalog of packages) on a page already displays this tool package (D-181): no need to add an entry point to the home page again when adding. */
export function shownInToolGrid(
  config: WorkspaceConfig,
  packageId: string,
  catalog: readonly string[],
): boolean {
  return config.containers.pages.some((page) =>
    allComponents(page).some(
      (c) =>
        isKnownComponent(c) &&
        c.look === 'catalog' &&
        c.source.catalog === 'packages' &&
        toolGridToolIds(c.source, page, catalog).includes(packageId),
    ),
  );
}

/** When a protected element is neither in the navigation bar nor in a floating entry point, automatically convert it to a floating entry point (§5.1). */
function keepProtectedReachable(config: WorkspaceConfig, notes: ApplyNote[]): void {
  for (const target of PROTECTED_TARGETS) {
    if (!config.nav.bar.includes(target) && !config.nav.floating.includes(target)) {
      config.nav.floating.push(target);
      notes.push({ kind: 'movedToFloating', target });
    }
  }
}

/** Remove this page from the navigation bar and floating entry points; if the navigation bar becomes empty, restore it to the home page. */
function removeFromNav(config: WorkspaceConfig, target: NavTarget): void {
  config.nav.bar = config.nav.bar.filter((t) => t !== target);
  config.nav.floating = config.nav.floating.filter((t) => t !== target);
  if (config.nav.bar.length === 0) config.nav.bar = [pageTarget(HOME_PAGE_ID)];
}

/** Remove this page from each app's bottom bar; if the bottom bar becomes empty, leave only Tink (D-485). */
function removeFromAppBars(config: WorkspaceConfig, target: NavTarget): void {
  for (const app of config.nav.apps ?? []) {
    app.bar = app.bar.filter((t) => t !== target);
    if (app.bar.length === 0) app.bar = ['ai'];
  }
}

// ---- app（D-485）----

function getApp(config: WorkspaceConfig, id: string): App {
  const app = config.nav.apps?.find((a) => a.id === id);
  if (!app) throw new OpError(`app ${id} not found`);
  return app;
}

function addApp(config: WorkspaceConfig, op: OpOf<'addContainer'>): void {
  const spec = op.app!;
  if ((config.nav.apps ?? []).some((a) => a.id === spec.id))
    throw new OpError(`app ${spec.id} already exists`);
  const app: App = {
    id: spec.id,
    name: spec.name,
    ...(spec.icon !== undefined ? { icon: spec.icon } : {}),
    bar: [...new Set<AppBarTarget>(spec.bar ?? ['ai'])],
    // The new app's style is cloned from the home page (imported App files carry their own style), after which they are edited independently without inheritance.
    theme: clone(spec.theme ?? config.theme),
  };
  (config.nav.apps ??= []).push(app);
}

function updateApp(config: WorkspaceConfig, op: OpOf<'updateContainer'>): void {
  const { id, name, icon, bar } = op.app!;
  const app = getApp(config, id);
  if (name !== undefined) app.name = name;
  if (icon === null) delete app.icon;
  else if (icon !== undefined) app.icon = icon;
  if (bar !== undefined) app.bar = [...new Set(bar)];
}

/**
 * Remove an app: its pages and quick actions are removed together (reusing page and quick action
 * removal cleanup), and entry points opening it are removed; its tables and records remain
 * completely untouched, simply reassigned to the home page (Invariant 5).
 */
function removeApp(config: WorkspaceConfig, id: string, notes: ApplyNote[]): void {
  const app = getApp(config, id);
  for (const page of config.containers.pages.filter((p) => p.app === id)) {
    removePage(config, page.id, notes);
  }
  const target = appTarget(id);
  const links = removeEverywhere(config, (c) => componentTarget(c) === target) > 0;
  for (const tool of config.tools.filter((t) => t.app === id)) {
    removeTool(config, { op: 'removeTool', tool: tool.id }, notes);
  }
  const moved = config.data.tables.filter((t) => t.app === id);
  for (const table of moved) delete table.app;
  config.nav.apps = config.nav.apps!.filter((a) => a.id !== app.id);
  if (config.nav.apps.length === 0) delete config.nav.apps;
  // Remove this App from the desktop menu as well (Invariant 18).
  const homeScreen = config.nav.phoneHomeScreen?.filter((x) => x !== target);
  if (homeScreen && homeScreen.length > 0) config.nav.phoneHomeScreen = homeScreen;
  else delete config.nav.phoneHomeScreen;
  if (moved.length > 0 || links)
    notes.push({ kind: 'removedApp', tables: moved.map((t) => t.name), links });
}

// ---- Tools ----

function getTool(config: WorkspaceConfig, id: string): Tool {
  const tool = config.tools.find((t) => t.id === id);
  if (!tool) throw new OpError(`tool ${id} not found`);
  return tool;
}

function getQuickAction(config: WorkspaceConfig, id: string): QuickAction {
  const tool = getTool(config, id);
  if (tool.kind !== 'quickAction')
    throw new OpError(`tool ${id} is a reminder, not a quick action`);
  return tool;
}

function getStepIndex(wf: QuickAction, stepId: string): number {
  const index = wf.steps.findIndex((s) => s.id === stepId);
  if (index < 0) throw new OpError(`step ${stepId} not found in ${wf.id}`);
  return index;
}

/**
 * After a quick action is removed, places using it are cleaned up: blocks running it (actions),
 * buttons and entry points opening it (D-256), and this item on the file room toolbar. If a
 * built-in quick action with the same ID still exists (when removing a preset copy), these blocks
 * remain valid and are not removed. Always removed from the mobile desktop menu.
 */
function removeQuickActionUses(
  config: WorkspaceConfig,
  ids: readonly string[],
): Map<string, { runners: number; links: number }> {
  const counts = new Map(ids.map((id) => [id, { runners: 0, links: 0 }]));
  const home = config.nav.phoneHomeScreen?.filter((id) => !ids.includes(id));
  if (home && home.length > 0) config.nav.phoneHomeScreen = home;
  else delete config.nav.phoneHomeScreen;
  const gone = ids.filter((id) => !presetById(id));
  if (gone.length === 0) return counts;
  // Buttons at the top of the record page (D-428, Invariant 18).
  for (const table of config.data.tables) {
    const row = table.recordRow?.filter((item) => {
      if (!gone.includes(item.tool)) return true;
      counts.get(item.tool)!.runners++;
      return false;
    });
    if (row && row.length > 0) table.recordRow = row;
    else delete table.recordRow;
  }
  // Buttons above lists and on single record blocks (D-428): blocks are kept, buttons are removed.
  for (const c of everyBlock(config)) {
    if (!isKnownComponent(c) || (c.look === 'button' && buttonKind(c) === 'run')) continue;
    const block = c as { tools?: ToolUse[] };
    if (!block.tools?.some((u) => isToolRefUse(u) && gone.includes(u.tool))) continue;
    const kept = block.tools.filter((u) => {
      if (!isToolRefUse(u) || !gone.includes(u.tool)) return true;
      counts.get(u.tool)!.runners++;
      return false;
    });
    if (kept.length > 0) block.tools = kept;
    else delete block.tools;
  }
  const runs = (c: Component) => {
    if (!isKnownComponent(c) || c.look !== 'button' || buttonKind(c) !== 'run') return undefined;
    const use = c.tools?.[0];
    return use && isToolRefUse(use) && gone.includes(use.tool) ? use.tool : undefined;
  };
  const opens = (c: Component) => {
    const target = componentTarget(c);
    return gone.find((id) => target === toolTarget(id));
  };
  removeEverywhere(config, (c) => {
    const ran = runs(c);
    if (ran) counts.get(ran)!.runners++;
    const opened = ran ? undefined : opens(c);
    if (opened) counts.get(opened)!.links++;
    // Remove the block as well when no floating action buttons are left (invariant 18).
    const emptyDial = isKnownComponent(c) && c.look === 'dial' && !c.tools?.length;
    return ran !== undefined || opened !== undefined || emptyDial;
  });
  const tools = config.containers.desk?.tools;
  if (tools) {
    for (const kind of Object.keys(tools) as (keyof typeof tools)[]) {
      const groups = (tools[kind] ?? [])
        .map((g) => ({
          ...g,
          items: g.items.filter((item) => {
            if (typeof item !== 'string' || !gone.includes(item)) return true;
            counts.get(item)!.links++;
            return false;
          }),
        }))
        .filter((g) => g.items.length > 0);
      if (groups.length > 0) tools[kind] = groups;
      else delete tools[kind];
    }
    if (Object.keys(tools).length === 0) delete config.containers.desk!.tools;
  }
  return counts;
}

// ---- Data ----

function getTable(config: WorkspaceConfig, id: string): Collection {
  const table = config.data.tables.find((c) => c.id === id);
  if (!table) throw new OpError(`table ${id} not found`);
  return table;
}

function getFieldIndex(table: Collection, id: string): number {
  const index = table.fields.findIndex((f) => f.id === id);
  if (index < 0) throw new OpError(`field ${id} not found in ${table.id}`);
  return index;
}

/** Deleted table (fields omitted) or field. */
interface Gone {
  table: string;
  field?: string;
}

const hasKey = (o: object | undefined, key: string) =>
  o !== undefined && Object.prototype.hasOwnProperty.call(o, key);

/** A standalone one-tap record tool references a deleted table or field. */
function recordToolUses(use: RecordTool, gone: Gone): boolean {
  // Batch creation (D-567): source table, its filters, and value expressions reading source fields are also included.
  if (use.do === 'createAll' && use.from === gone.table) {
    const id = gone.field;
    if (
      id === undefined ||
      (use.filter ?? []).some((c) => c.field === id) ||
      Object.values(use.values).some((v) => valueEntryFields(v).includes(id))
    )
      return true;
  }
  if (use.table !== gone.table) return false;
  const id = gone.field;
  if (id === undefined) return true;
  switch (use.do) {
    case 'create':
      return (
        (typeof use.values === 'object' && hasKey(use.values, id)) ||
        (Array.isArray(use.ask) && use.ask.includes(id)) ||
        use.smartDate?.from === id ||
        use.smartDate?.to === id
      );
    case 'setAll':
      return use.field === id || (use.filter ?? []).some((c) => c.field === id);
    case 'createAll':
      return hasKey(use.values, id);
    // Moving to "Recently Deleted" (D-610) does not use fields; table deletion is already accounted for above.
    case 'remove':
      return false;
    default:
      return use.field === id;
  }
}

/**
 * A tool on a block (reading table) references a deleted table or field: the tool's own
 * configuration, condition in `when` (reading this entry), or values reading fields of "this
 * entry" (entry table, D-565) including copied fields, date start, and addend.
 */
function toolUses(use: ToolUse, table: string | null, gone: Gone, entry = table): boolean {
  if (
    gone.field !== undefined &&
    table === gone.table &&
    (use.when ?? []).some((c) => c.field === gone.field)
  )
    return true;
  if (!isRecordToolUse(use)) return false;
  // Check every one-tap action (D-566).
  return tapWrites(use, table ?? use.table).some(
    (tool) =>
      (gone.field !== undefined &&
        entry === gone.table &&
        toolEntryFields(tool).includes(gone.field)) ||
      recordToolUses(tool, gone),
  );
}

/**
 * After deleting a field or table, handle referencing standalone one-tap record tools (D-304):
 * remove the button; strip the tool from record blocks (leaving the block); if checked tools are
 * gone, downgrade checklists to regular lists; if dragged tools are gone, convert kanban boards
 * to view-only. Entry forms are left untouched: validator points out missing fields for AI to fix
 * together (same as v33).
 */
function pruneRecordTools(config: WorkspaceConfig, gone: Gone, notes: ApplyNote[]): void {
  // When a button is on a record page, "this entry" refers to that page's entry (D-565).
  const pageOf = new Map<Component, string>();
  for (const page of config.containers.pages)
    if (page.of !== undefined) for (const c of allComponents(page)) pageOf.set(c, page.of);
  let count = removeEverywhere(config, (c) => {
    if (!isKnownComponent(c) || c.look !== 'button' || !c.tools) return false;
    return c.tools.some((u) => toolUses(u, null, gone, pageOf.get(c) ?? null));
  });
  for (const c of everyBlock(config)) {
    if (!isKnownComponent(c) || c.look === 'button' || c.look === 'form') continue;
    const block = c as { look: string; tools?: ToolUse[] };
    if (!block.tools) continue;
    const table = componentCollection(c);
    const removed = block.tools.filter((u) => toolUses(u, table, gone));
    if (removed.length === 0) continue;
    count += removed.length;
    block.tools = block.tools.filter((u) => !removed.includes(u));
    if (block.look === 'checklist' && removed.some((u) => u.as === 'check')) block.look = 'list';
    if (block.tools.length === 0) delete block.tools;
  }
  if (count > 0) notes.push({ kind: 'removedRecordActions', count });
}

/**
 * Clean up standalone floating action buttons (invariant 18): remove the item handing over list
 * records when no selectable list remains on the page; remove the item if its target page is
 * gone; remove the block entirely when zero items remain. Keep the remaining items.
 */
function pruneDials(config: WorkspaceConfig, notes: ApplyNote[]): void {
  let count = 0;
  for (const page of config.containers.pages) {
    for (const c of page.blocks) {
      if (!isKnownComponent(c) || c.look !== 'dial' || !Array.isArray(c.tools)) continue;
      const lists = pageBrowseLists(page).length === 1;
      const kept = c.tools.filter(
        (u) =>
          !(u.as === 'list' && !lists) &&
          !(isOpenUse(u) && !config.containers.pages.some((p) => p.id === u.opens)),
      );
      count += c.tools.length - kept.length;
      c.tools = kept;
    }
  }
  count += removeEverywhere(
    config,
    (c) => isKnownComponent(c) && c.look === 'dial' && !c.tools?.length,
  );
  count += prunePagePeriod(config);
  count += prunePageChoice(config);
  if (count > 0) notes.push({ kind: 'clearedBlockRefs', count });
}

/**
 * When there are no time tabss left on a page (deleted or originally absent), strip
 * `source.period` from its charts, metric cards, and record blocks (D-561), reverting to the
 * block's own configured range (invariant 18, D-440). Hidden time tabss are still
 * considered present (validators treat them as such).
 */
function prunePagePeriod(config: WorkspaceConfig): number {
  let count = 0;
  for (const page of config.containers.pages) {
    if (page.blocks.some(isTimeTabs)) continue;
    for (const c of allComponents(page)) {
      if (!isKnownComponent(c) || !('source' in c)) continue;
      const source = c.source as { period?: string } | undefined;
      if (source?.period === undefined) continue;
      delete source.period;
      count++;
    }
  }
  return count;
}

/**
 * When there is no choice bar left on a page (deleted or originally absent), strip
 * `source.choice` from its blocks, reverting to their own filters (invariant 18, D-573). Hidden
 * choice bars are still considered present (validators treat them as such).
 */
function prunePageChoice(config: WorkspaceConfig): number {
  let count = 0;
  for (const page of config.containers.pages) {
    if (page.blocks.some(isChoiceTabs)) continue;
    for (const c of allComponents(page)) {
      if (!isKnownComponent(c) || !('source' in c)) continue;
      const source = c.source as { choice?: string } | undefined;
      if (source?.choice === undefined) continue;
      delete source.choice;
      count++;
    }
  }
  return count;
}

/**
 * Clean up choice bars associated with a single-choice field (invariant 18, D-573): if the field
 * is deleted, remove the choice bar (its blocks will subsequently be cleaned up by
 * `prunePageChoice`); if an option is deleted, remove it from the choice bar's listed options and
 * default selection (reverting to show all options if none remain).
 */
function pruneChoiceRows(config: WorkspaceConfig, gone: Gone, notes: ApplyNote[]): void {
  const rows = (c: Component): c is ChoiceTabs =>
    isKnownComponent(c) && isChoiceTabs(c) && c.source.table === gone.table;
  if (gone.field !== undefined) {
    const count = removeEverywhere(config, (c) => rows(c) && c.source.field === gone.field);
    if (count > 0) notes.push({ kind: 'clearedBlockRefs', count });
    return;
  }
  const table = config.data.tables.find((x) => x.id === gone.table);
  for (const c of everyBlock(config)) {
    if (!rows(c)) continue;
    const row = c;
    const field = table?.fields.find((f) => f.id === row.source.field);
    if (field?.type !== 'choice') continue;
    const ids = field.options.map((o) => o.id);
    const left = row.show.options?.filter((id) => ids.includes(id));
    if (left && left.length > 0) row.show.options = left;
    else delete row.show.options;
    if (row.show.default !== undefined && !(row.show.options ?? ids).includes(row.show.default))
      delete row.show.default;
  }
}

/** After deleting a field, remove buttons at the top of record pages that submit to this field (invariant 18, D-428). */
function pruneRecordRow(table: Collection, field: string, notes: ApplyNote[]): void {
  const row = table.recordRow?.filter((item) => item.field !== field);
  if (!table.recordRow || !row || row.length === table.recordRow.length) return;
  notes.push({ kind: 'removedRecordActions', count: table.recordRow.length - row.length });
  if (row.length > 0) table.recordRow = row;
  else delete table.recordRow;
}

/**
 * After deleting a field, adjust entry form sections (D-570, invariant 18): remove the field from
 * sections, and remove empty sections; remove visibility conditions referencing it (the section
 * will always be displayed henceforth, keeping all other fields and values). Remove the form
 * entirely if zero sections remain.
 */
function pruneEntryForm(table: Collection, field: string): void {
  if (!table.form) return;
  const sections = table.form.sections.flatMap((s) => {
    const fields = s.fields.filter((id) => id !== field);
    if (fields.length === 0) return [];
    const when = s.when?.filter((c) => c.field !== field);
    const { when: _when, ...rest } = s;
    return [{ ...rest, fields, ...(when && when.length > 0 ? { when } : {}) }];
  });
  if (sections.length > 0) table.form = { sections };
  else delete table.form;
}

/**
 * After deleting a field, remove it from list swappable fields, table columns, and single-record
 * display fields (invariant 18, D-424). Remove the block entirely when zero fields remain for a
 * single record.
 */
function pruneBrowseFields(
  config: WorkspaceConfig,
  gone: Required<Gone>,
  notes: ApplyNote[],
): void {
  let count = 0;
  const without = (list: readonly string[]) => list.filter((id) => id !== gone.field);
  for (const c of everyBlock(config)) {
    if (!isKnownComponent(c) || componentCollection(c) !== gone.table) continue;
    if (c.look === 'single') {
      if (!c.show.fields.includes(gone.field) || c.show.fields.length === 1) continue;
      c.show.fields = without(c.show.fields);
      count++;
      continue;
    }
    const show = (
      c as {
        show?: {
          columns?: string[];
          highlight?: { field: string }[];
          browse?: {
            search?: true;
            sort?: string[];
            group?: string[];
            filter?: string[];
            period?: string;
          };
        };
      }
    ).show;
    // Table columns (D-539): revert to subtitle and right-side fields when the last column is also removed.
    if (show?.columns?.includes(gone.field)) {
      count++;
      const left = without(show.columns);
      if (left.length > 0) show.columns = left;
      else delete show.columns;
    }
    // Highlight condition reads this field (D-541): remove it entirely (removing only a single rule would cause more rows to trigger highlight).
    if (show?.highlight?.some((x) => x.field === gone.field)) {
      count++;
      delete show.highlight;
    }
    const browse = show?.browse;
    if (!show || !browse) continue;
    for (const key of ['sort', 'group', 'filter'] as const) {
      const list = browse[key];
      if (!list?.includes(gone.field)) continue;
      count++;
      const left = without(list);
      if (left.length > 0) browse[key] = left;
      else delete browse[key];
    }
    if (browse.period === gone.field) {
      count++;
      delete browse.period;
    }
    if (!browse.search && !browse.sort && !browse.group && !browse.filter && !browse.period)
      delete show.browse;
  }
  count += removeEverywhere(
    config,
    (c) =>
      isKnownComponent(c) &&
      c.look === 'single' &&
      c.source.table === gone.table &&
      c.show.fields.length === 1 &&
      c.show.fields[0] === gone.field,
  );
  if (count > 0) notes.push({ kind: 'clearedBlockRefs', count });
}

/** After deleting a table, remove "show for this table" conditions on other blocks (invariant 18, D-424): keep the block and always display it. */
function pruneShowIf(config: WorkspaceConfig, table: string, notes: ApplyNote[]): void {
  let count = 0;
  for (const c of everyBlock(config)) {
    if (!isKnownComponent(c) || c.showIf?.table !== table) continue;
    delete c.showIf;
    count++;
  }
  if (count > 0) notes.push({ kind: 'clearedBlockRefs', count });
}

/** These aggregate types read `source.field`; others (count, date-based) do not, and validators do not require it. */
const READS_FIELD = ['sum', 'avg', 'min', 'max', 'latest'];

/**
 * After deleting a field, remove `field` declarations from metric blocks, charts, and minuses
 * that do not require an underlying field (invariant 18). Aggregates requiring a field (such as
 * sum) are left untouched: validators will flag them as before.
 */
function pruneAggregateFields(config: WorkspaceConfig, gone: Required<Gone>): void {
  const prune = (source: { table: string; aggregate: string; field?: string | undefined }) => {
    if (
      source.table === gone.table &&
      source.field === gone.field &&
      !READS_FIELD.includes(source.aggregate)
    )
      delete source.field;
  };
  for (const c of everyBlock(config)) {
    if (!isKnownComponent(c) || (c.look !== 'number' && c.look !== 'chart')) continue;
    prune(c.source);
    if (c.look === 'number' && c.source.minus) prune(c.source.minus);
    if (c.look === 'number') for (const total of c.source.calc?.with ?? []) prune(total);
  }
}

// ---- Each operation ----

function addData(config: WorkspaceConfig, op: OpOf<'addData'>): void {
  if (typeof op.table !== 'string') {
    if (config.data.tables.some((c) => c.id === (op.table as Collection).id))
      throw new OpError(`table ${op.table.id} already exists`);
    config.data.tables.push(clone(op.table));
    return;
  }
  const table = getTable(config, op.table);
  const field = op.field!;
  if (table.fields.some((f) => f.id === field.id))
    throw new OpError(`field ${field.id} already exists in ${table.id}`);
  const index = Math.min(op.index ?? table.fields.length, table.fields.length);
  table.fields.splice(index, 0, clone(field));
}

function updateData(config: WorkspaceConfig, op: OpOf<'updateData'>): void {
  if (op.calendar !== undefined) {
    const next = merge({ ...config.data.calendar }, op.calendar);
    if (Object.keys(next).length > 0) config.data.calendar = next as never;
    else delete config.data.calendar;
    return;
  }
  const table = getTable(config, op.table!);
  const changes = op.changes!;
  if (op.field === undefined) {
    onlyKeys(
      changes,
      ['name', 'icon', 'readAttachments', 'prefillRules', 'recordRow', 'app', 'form'],
      `table ${table.id}`,
    );
    if (changes.name === null) throw new OpError(`table ${table.id} needs a name`);
    merge(table as unknown as Record<string, unknown>, changes);
    return;
  }
  const index = getFieldIndex(table, op.field);
  const old = table.fields[index]!;
  if ('id' in changes) throw new OpError('a field id cannot change');
  const newType = changes.type;
  let next: Record<string, unknown>;
  if (newType !== undefined && newType !== old.type) {
    const compatible = COMPATIBLE_FIELD_TYPES.some(
      (pair) => pair.includes(old.type) && pair.includes(String(newType)),
    );
    if (!compatible) {
      throw new OpError(
        `field ${old.id} cannot change from ${old.type} to ${String(newType)}; add a new field instead`,
      );
    }
    // Preserve only common properties when changing types; type-specific properties are provided by `changes` (e.g., currency for money).
    next = {
      id: old.id,
      name: old.name,
      ...('required' in old && old.required ? { required: true } : {}),
      ...('hint' in old && old.hint !== undefined ? { hint: old.hint } : {}),
    };
  } else {
    next = { ...old };
  }
  // Reverting multi-select to single-select (D-607): records might store multiple options while single-select accepts only one, so reject (invariants 5, 12); require a new field if multiple values are needed.
  if (old.type === 'choice' && old.multiple && changes.multiple === null)
    throw new OpError(
      `field ${old.id} ${MULTIPLE_CHOICE_NOT_ONE} and entries may already have several; it can't go back to one option; add a new choice field instead`,
    );
  // Validity checks (such as unique option IDs or existence of default values) are performed by `validateWorkspace`.
  table.fields[index] = merge(next, changes) as never;
  // Remove deleted options from page choice bars (D-573).
  pruneChoiceRows(config, { table: table.id }, []);
}

/**
 * After deleting tables or fields, handle quick action steps referencing them (with parameters
 * referencing tables and fields per action directory declarations in workflow/refs.ts): remove
 * steps referencing this table; for steps listing only this field, strip the field from the list
 * (and remove the step if its parameters become invalid). If the remaining steps are unusable
 * (empty, first step is not an input action, or type mismatch), remove the entire quick action
 * just like blocks reading this table; quick action packs cannot be removed, so reject in that
 * case.
 */
function pruneSteps(
  config: WorkspaceConfig,
  gone: Gone,
  registry: Registry,
  notes: ApplyNote[],
): void {
  const removedIds: string[] = [];
  for (const wf of config.tools) {
    if (wf.kind !== 'quickAction') continue;
    // When deleting a field, steps that store values into this table (log an expense) are also considered to reference it if they lack their value-storing field.
    const table = config.data.tables.find((c) => c.id === gone.table);
    const refs = stepRefs(wf, registry)
      .filter(
        (r) =>
          r.table === gone.table &&
          (gone.field === undefined ||
            r.field === gone.field ||
            (r.field === undefined &&
              table !== undefined &&
              missingPlace(table, r.receives) !== null)),
      )
      .map((r) => (r.field === gone.field ? r : { ...r, field: undefined }));
    if (refs.length === 0) continue;
    const dropped = new Set<number>();
    const trimmed = new Set<number>();
    const steps = wf.steps.map((step, index) => {
      const mine = refs.filter((r) => r.index === index);
      if (mine.length === 0) return step;
      if (mine.some((r) => r.field === undefined)) {
        dropped.add(index);
        return step;
      }
      const params = { ...step.params };
      for (const r of mine)
        params[r.key] = (params[r.key] as unknown[]).filter((id) => id !== r.field);
      if (!registry.actions.get(step.action)!.params.safeParse(params).success) {
        dropped.add(index);
        return step;
      }
      trimmed.add(index);
      return { ...step, params };
    });
    const left = steps.filter((_, i) => !dropped.has(i));
    // After removing input steps, the quick action cannot become a container input-providing action (D-428): it originally selected its own input and has nowhere to source it from.
    const works =
      left.length > 0 &&
      workflowProblems({ ...wf, steps: left }, registry).length === 0 &&
      handedInput(left, registry) === handedInput(wf.steps, registry);
    const ids = (set: Set<number>) => [...set].map((i) => wf.steps[i]!.action);
    if (!works && wf.package !== undefined) {
      const what =
        gone.field === undefined ? `table ${gone.table}` : `field ${gone.table}.${gone.field}`;
      throw new OpError(`${wf.id} belongs to tool ${wf.package} and its steps need ${what}`);
    }
    notes.push({
      kind: 'prunedSteps',
      name: wf.name,
      steps: works ? ids(dropped) : [],
      trimmed: works ? ids(trimmed) : [],
      removed: !works,
    });
    if (works) wf.steps = left;
    else removedIds.push(wf.id);
  }
  if (removedIds.length === 0) return;
  config.tools = config.tools.filter((t) => !removedIds.includes(t.id));
  for (const [id, { runners, links }] of removeQuickActionUses(config, removedIds)) {
    if (runners > 0) notes.push({ kind: 'removedRunners', tool: id, count: runners });
    if (links > 0) notes.push({ kind: 'removedWorkflowLinks', tool: id, count: links });
  }
}

function removeData(
  config: WorkspaceConfig,
  op: OpOf<'removeData'>,
  registry: Registry,
  notes: ApplyNote[],
): void {
  const table = getTable(config, op.table);
  if (op.field !== undefined) {
    // D-429: if a currency field is removed, every entry would fall back to the amount field's default currency, yielding incorrect figures, so reject (invariant 18).
    const usedBy = table.fields.find((f) => f.type === 'money' && f.currencyField === op.field);
    if (usedBy)
      throw new OpError(
        `field ${op.field} holds the currency of ${usedBy.id}; set currencyField of ${usedBy.id} to null first`,
      );
    // Remove the field from the schema: old values in records are preserved and restored when rolling back to an older version.
    table.fields.splice(getFieldIndex(table, op.field), 1);
    pruneRecordTools(config, { table: op.table, field: op.field }, notes);
    pruneRecordRow(table, op.field, notes);
    pruneEntryForm(table, op.field);
    pruneAggregateFields(config, { table: op.table, field: op.field });
    pruneBrowseFields(config, { table: op.table, field: op.field }, notes);
    pruneChoiceRows(config, { table: op.table, field: op.field }, notes);
    pruneSteps(config, { table: op.table, field: op.field }, registry, notes);
    pruneDials(config, notes);
    return;
  }
  // D-250: cannot remove a table while other tables still reference it; remove those reference fields first (preventing reference fields from pointing to non-existent tables).
  const linking = config.data.tables.flatMap((c) =>
    c.id === op.table
      ? []
      : c.fields
          .filter((f) => f.type === 'link' && f.table === op.table)
          .map((f) => `${c.id}.${f.id}`),
  );
  if (linking.length > 0) {
    throw new OpError(
      `table ${op.table} is linked from ${linking.join(', ')}; remove those fields (and the blocks that show them) first`,
    );
  }
  // D-342: remove pages dedicated to entries of this table (Plan B decided by founder on 2026-10-30), cleaning up references to them just like page removal.
  const recordPages = config.containers.pages.filter((p) => p.of === op.table);
  for (const p of recordPages) removePage(config, p.id, notes);
  if (recordPages.length > 0)
    notes.push({ kind: 'removedRecordPages', titles: recordPages.map((p) => p.title) });
  // Move data table out of the UI: records are preserved and can be exported in Settings -> Data or permanently deleted by the user.
  config.data.tables = config.data.tables.filter((c) => c.id !== op.table);
  // Remove associated sum totals (D-337): leaving only the first half would display incorrect figures.
  const count = removeEverywhere(
    config,
    (c) =>
      componentCollection(c) === op.table ||
      (isKnownComponent(c) &&
        c.look === 'number' &&
        (c.source.minus?.table === op.table ||
          (c.source.calc?.with.some((total) => total.table === op.table) ?? false))),
  );
  if (count > 0) notes.push({ kind: 'removedDataComponents', table: op.table, count });
  pruneRecordTools(config, { table: op.table }, notes);
  pruneSteps(config, { table: op.table }, registry, notes);
  pruneShowIf(config, op.table, notes);
  pruneDials(config, notes);
}

function moveData(config: WorkspaceConfig, op: OpOf<'moveData'>): void {
  const table = getTable(config, op.table);
  const [field] = table.fields.splice(getFieldIndex(table, op.field), 1);
  table.fields.splice(Math.min(op.toIndex, table.fields.length), 0, field!);
}

function addContainer(config: WorkspaceConfig, op: OpOf<'addContainer'>): void {
  if (op.app !== undefined) return addApp(config, op);
  if (op.desk !== undefined) {
    const block = clone(op.block!) as Component;
    const desk = (config.containers.desk ??= {});
    if (deskBlocks(config).some((c) => c.id === block.id))
      throw new OpError(`block ${block.id} already exists in the file room`);
    const list = (desk[op.desk] ??= []) as Component[];
    list.splice(Math.min(op.index ?? list.length, list.length), 0, block);
    return;
  }
  if (typeof op.page !== 'string') {
    const page = op.page!;
    if (config.containers.pages.some((p) => p.id === page.id))
      throw new OpError(`page ${page.id} already exists`);
    config.containers.pages.push(clone(page) as Page);
    return;
  }
  const page = getPage(config, op.page);
  const block = clone(op.block!) as Component;
  if (findBlock(page, block.id))
    throw new OpError(`block ${block.id} already exists on page ${page.id}`);
  for (const child of allComponents({ ...page, blocks: childrenOf(block) }))
    if (findBlock(page, child.id))
      throw new OpError(`block ${child.id} already exists on page ${page.id}`);
  const list = targetList(page, op.parent, block);
  list.splice(Math.min(op.index ?? list.length, list.length), 0, block);
}

const PAGE_CHANGES = ['title', 'icon', 'backdrop'] as const;
const BLOCK_CHANGES = [
  'style',
  'hidden',
  'showIf',
  'pin',
  'show',
  'source',
  'tools',
  'opens',
] as const;
const DESK_CHANGES = ['toolbar', 'preview', 'strip', 'tools'] as const;

function updateBlock(block: KnownComponent, changes: BlockChanges): void {
  const b = block as unknown as Record<string, unknown>;
  if (changes.style !== undefined) {
    const style: Record<string, unknown> = { ...block.style };
    for (const [key, value] of Object.entries(changes.style)) {
      if (value === null) delete style[key];
      else if (key === 'backdrop')
        style.backdrop = patchBackdrop(block.style?.backdrop, value as BackdropPatch);
      else if (value !== undefined) style[key] = value;
    }
    if (Object.keys(style).length === 0) delete block.style;
    else block.style = style;
  }
  if (changes.hidden === true) block.hidden = true;
  else if (changes.hidden === false) delete block.hidden;
  if (changes.showIf === null) delete block.showIf;
  else if (changes.showIf !== undefined) block.showIf = changes.showIf;
  if (changes.pin === null) delete block.pin;
  else if (changes.pin !== undefined) block.pin = changes.pin;
  // Merge `show` and `source` only (null strips an item); appearance cannot be modified via this operation. Validity is checked by `validateWorkspace`.
  for (const key of ['show', 'source'] as const) {
    const patch = changes[key];
    if (patch === undefined) continue;
    const next = merge({ ...(b[key] as Record<string, unknown> | undefined) }, patch);
    if (Object.keys(next).length > 0) b[key] = next;
    else delete b[key];
  }
  for (const key of ['tools', 'opens'] as const) {
    const value = changes[key];
    if (value === null) delete b[key];
    else if (value !== undefined) b[key] = clone(value);
  }
}

function updateContainer(
  config: WorkspaceConfig,
  op: OpOf<'updateContainer'>,
  notes: ApplyNote[],
): void {
  if (op.app !== undefined) return updateApp(config, op);
  if (op.nav !== undefined) {
    const { bar, floating, phoneHomeScreen } = op.nav;
    if (bar !== undefined) {
      const items = [...new Set(bar)];
      config.nav.bar = items;
      config.nav.floating = config.nav.floating.filter((t) => !items.includes(t));
    }
    if (floating !== undefined) {
      const items = [...new Set(floating)];
      config.nav.floating = items;
      config.nav.bar = config.nav.bar.filter((t) => !items.includes(t));
    }
    if (bar !== undefined) keepProtectedReachable(config, notes);
    if (phoneHomeScreen !== undefined) {
      // Add to phone home screen (long-press Morph icon menu, D-271): tool pack built-in quick actions are also supported.
      const ids = [...new Set(phoneHomeScreen)];
      for (const id of ids) {
        // app:<id> (D-485): tap to navigate into that App.
        if (id.startsWith('app:')) getApp(config, id.slice('app:'.length));
        else getQuickAction(config, id);
      }
      if (ids.length > 0) config.nav.phoneHomeScreen = ids;
      else delete config.nav.phoneHomeScreen;
    }
    return;
  }
  if (op.desk !== undefined) {
    // Room layout (D-358, Q7): preview blocks above/below using `addContainer` / `removeContainer {desk}`.
    onlyKeys(op.desk, DESK_CHANGES, 'the file room');
    const { tools, ...layout } = op.desk;
    const next = merge({ ...config.containers.desk }, layout);
    // Merge toolbars by file type (Rule 52): replace provided types entirely, null restores defaults, omitted ones remain unchanged; invalid syntax is left to validators.
    if (tools === null) delete next.tools;
    else if (typeof tools === 'object') {
      const kinds = merge({ ...(next.tools as object) }, tools as Record<string, unknown>);
      if (Object.keys(kinds).length > 0) next.tools = kinds as never;
      else delete next.tools;
    } else if (tools !== undefined) next.tools = tools as never;
    if (Object.keys(next).length > 0) config.containers.desk = next;
    else delete config.containers.desk;
    return;
  }
  const page = getPage(config, op.page!);
  const changes = op.changes!;
  if (op.block === undefined) {
    onlyKeys(changes, PAGE_CHANGES, `page ${page.id}`);
    const c = changes as { title?: string; icon?: string | null; backdrop?: BackdropPatch | null };
    if (c.title !== undefined) page.title = c.title;
    if (c.icon === null) delete page.icon;
    else if (c.icon !== undefined) page.icon = c.icon;
    if (c.backdrop === null) delete page.backdrop;
    else if (c.backdrop !== undefined) page.backdrop = patchBackdrop(page.backdrop, c.backdrop);
    return;
  }
  onlyKeys(changes, BLOCK_CHANGES, `block ${op.block}`);
  updateBlock(known(getBlock(page, op.block).block), changes as BlockChanges);
}

function removePage(config: WorkspaceConfig, pageId: string, notes: ApplyNote[]): void {
  if (pageId === HOME_PAGE_ID) throw new OpError('the home page cannot be removed');
  const page = getPage(config, pageId);
  if (page.package !== undefined)
    throw new OpError(`page ${pageId} belongs to tool ${page.package}; remove the tool`);
  config.containers.pages = config.containers.pages.filter((p) => p.id !== pageId);
  const target = pageTarget(pageId);
  removeFromNav(config, target);
  removeFromAppBars(config, target);
  const count = removeEverywhere(config, (c) => componentTarget(c) === target);
  if (count > 0) notes.push({ kind: 'removedLinks', pageId, count });
  // D-342: record blocks that tap to open this page or row buttons opening this page are reverted to opening the edit page.
  for (const c of everyBlock(config)) {
    if (!isKnownComponent(c)) continue;
    const block = c as { opens?: unknown; tools?: ToolUse[] };
    if (componentCollection(c) !== null && block.opens === pageId) delete block.opens;
    if (c.look === 'dial') continue;
    block.tools?.forEach((u) => {
      if ('opens' in u && u.opens === pageId) u.opens = 'record';
    });
  }
  pruneDials(config, notes);
}

function removeContainer(
  config: WorkspaceConfig,
  op: OpOf<'removeContainer'>,
  notes: ApplyNote[],
): void {
  if (op.app !== undefined) return removeApp(config, op.app, notes);
  if (op.desk !== undefined) {
    const desk = config.containers.desk;
    const list = desk?.[op.desk] as Component[] | undefined;
    const index = list?.findIndex((c) => c.id === op.block) ?? -1;
    if (!desk || !list || index < 0)
      throw new OpError(`block ${op.block} not found ${op.desk} the preview in the file room`);
    list.splice(index, 1);
    if (list.length === 0) delete desk[op.desk];
    if (Object.keys(desk).length === 0) delete config.containers.desk;
    return;
  }
  if (op.block === undefined) return removePage(config, op.page!, notes);
  const { list, index } = getBlock(getPage(config, op.page!), op.block);
  list.splice(index, 1);
  pruneDials(config, notes);
}

function moveContainer(config: WorkspaceConfig, op: OpOf<'moveContainer'>): void {
  const page = getPage(config, op.page);
  const from = getBlock(page, op.block);
  const to = targetList(page, op.parent, from.block);
  from.list.splice(from.index, 1);
  to.splice(Math.min(op.toIndex, to.length), 0, from.block);
}

function addTool(config: WorkspaceConfig, op: OpOf<'addTool'>): void {
  if (typeof op.tool === 'string') {
    const wf = getQuickAction(config, op.tool);
    const step = op.step!;
    if (wf.steps.some((s) => s.id === step.id))
      throw new OpError(`step ${step.id} already exists in ${wf.id}`);
    const at = Math.min(op.index ?? wf.steps.length, wf.steps.length);
    wf.steps.splice(at, 0, clone(step));
    return;
  }
  const tool = clone(op.tool) as Tool;
  if (config.tools.some((t) => t.id === tool.id))
    throw new OpError(`tool ${tool.id} already exists`);
  if (tool.kind === 'reminder') {
    // Per-record reminders are tracked separately and do not count toward the 20-item limit (D-316).
    const perRecord = isRecordReminder(tool);
    const max = perRecord ? MAX_RECORD_REMINDERS : MAX_REMINDERS;
    const same = config.tools.filter(
      (t) => t.kind === 'reminder' && isRecordReminder(t) === perRecord,
    );
    if (same.length >= max)
      throw new OpError(
        perRecord
          ? `at most ${MAX_RECORD_REMINDERS} reminders for each entry (when.each)`
          : `at most ${MAX_REMINDERS} reminders`,
      );
    config.tools.push(tool);
    return;
  }
  addQuickActions(config, [tool]);
}

/** Quick actions are listed before reminders (matching migrated order: workflows first, then reminders). */
function addQuickActions(config: WorkspaceConfig, list: readonly QuickAction[]): void {
  config.tools.splice(quickActionsOf(config).length, 0, ...list);
}

/** Replace steps globally (saving quick action edit page, restoring presets). AI sees placeholders (D-065): writing back the exact same placeholder indicates keeping original text. */
function replaceSteps(wf: QuickAction, steps: unknown): WorkflowStep[] {
  if (!Array.isArray(steps) || steps.length === 0)
    throw new OpError(`steps of ${wf.id} must be a list of at least one step`);
  const ids = new Set<string>();
  const old = new Map(wf.steps.map((s) => [s.id, s]));
  return (steps as WorkflowStep[]).map((s) => {
    if (typeof s !== 'object' || s === null || typeof s.params !== 'object' || s.params === null)
      throw new OpError(`each step of ${wf.id} needs {id, action, params}`);
    if (ids.has(s.id)) throw new OpError(`step ${s.id} appears twice in ${wf.id}`);
    ids.add(s.id);
    const params = Object.fromEntries(
      Object.entries(s.params)
        .map(([k, v]) => [k, v === REDACTED_TEXT ? old.get(s.id)?.params[k] : v] as const)
        .filter(([, v]) => v !== undefined),
    );
    return clone({ ...s, params });
  });
}

function updateTool(config: WorkspaceConfig, op: OpOf<'updateTool'>): void {
  const tool = getTool(config, op.tool);
  const changes = op.changes;
  if (op.step !== undefined) {
    const wf = getQuickAction(config, op.tool);
    const step = wf.steps[getStepIndex(wf, op.step)]!;
    onlyKeys(changes, ['params', 'ask'], `step ${op.step}`);
    if (changes.params !== undefined) {
      if (typeof changes.params !== 'object' || changes.params === null)
        throw new OpError(`params of step ${op.step} must be an object`);
      // AI sees placeholders (D-065): writing back the exact same placeholder indicates leaving this parameter unchanged.
      const params = Object.entries(changes.params).filter(([, v]) => v !== REDACTED_TEXT);
      step.params = { ...step.params, ...Object.fromEntries(params) };
    }
    if (changes.ask !== undefined) {
      if (!Array.isArray(changes.ask) || changes.ask.some((k) => typeof k !== 'string'))
        throw new OpError(`ask of step ${op.step} must be a list of parameter names`);
      if (changes.ask.length === 0) delete step.ask;
      else step.ask = [...new Set(changes.ask as string[])];
    }
    return;
  }
  if (tool.kind === 'quickAction') {
    onlyKeys(changes, ['name', 'icon', 'steps'], `quick action ${tool.id}`);
    if (changes.name === null) throw new OpError(`quick action ${tool.id} needs a name`);
    if (typeof changes.name === 'string') tool.name = changes.name;
    if (changes.icon === null) delete tool.icon;
    else if (changes.icon !== undefined) tool.icon = changes.icon as string;
    if (changes.steps !== undefined) tool.steps = replaceSteps(tool, changes.steps);
    return;
  }
  for (const key of ['id', 'kind', 'package', 'preset'])
    if (key in changes) throw new OpError(`a reminder's ${key} cannot change`);
  // Merge into reminder; null strips optional keys. Validity is checked by `validateWorkspace`.
  const next = merge({ ...tool }, changes) as unknown as Reminder;
  config.tools = config.tools.map((t) => (t.id === tool.id ? next : t));
}

function removeTool(config: WorkspaceConfig, op: OpOf<'removeTool'>, notes: ApplyNote[]): void {
  const tool = getTool(config, op.tool);
  if (op.step !== undefined) {
    const wf = getQuickAction(config, op.tool);
    wf.steps.splice(getStepIndex(wf, op.step), 1);
    return;
  }
  if (tool.package !== undefined) {
    throw new OpError(
      `${tool.id} belongs to tool ${tool.package}; remove the tool${tool.kind === 'quickAction' ? ' or remove steps instead' : ''}`,
    );
  }
  config.tools = config.tools.filter((t) => t.id !== op.tool);
  if (tool.kind !== 'quickAction') return;
  const { runners, links } = removeQuickActionUses(config, [op.tool]).get(op.tool)!;
  if (runners > 0) notes.push({ kind: 'removedRunners', tool: op.tool, count: runners });
  if (links > 0) notes.push({ kind: 'removedWorkflowLinks', tool: op.tool, count: links });
}

function moveTool(config: WorkspaceConfig, op: OpOf<'moveTool'>): void {
  const wf = getQuickAction(config, op.tool);
  const [step] = wf.steps.splice(getStepIndex(wf, op.step), 1);
  wf.steps.splice(Math.min(op.toIndex, wf.steps.length), 0, step!);
}

function setTheme(config: WorkspaceConfig, op: OpOf<'setTheme'>): void {
  // If `app` is undefined, modify home theme; otherwise modify that app's own theme (D-485).
  const holder: { theme: Theme } = op.app === undefined ? config : getApp(config, op.app);
  // Icon library (D-625): shared across the entire workspace regardless of whether `app` is specified; omitted if empty.
  if (op.icons) {
    const icons = { ...config.icons };
    for (const [id, icon] of Object.entries(op.icons)) {
      if (icon === null) delete icons[id];
      else icons[id] = clone(icon);
    }
    if (Object.keys(icons).length > 0) config.icons = icons;
    else delete config.icons;
  }
  if (op.reset) {
    holder.theme = clone(DEFAULT_THEME);
    return;
  }
  if (op.preset !== undefined) {
    holder.theme = clone(THEME_PRESETS[op.preset].theme);
    return;
  }
  const {
    op: _,
    app: _a,
    preset: _p,
    reset: _r,
    icons: _i,
    colors,
    darkColors,
    card,
    ...tokens
  } = op;
  for (const [key, value] of Object.entries(tokens)) {
    if (value !== undefined) (holder.theme as Record<string, unknown>)[key] = value;
  }
  // Custom cards (D-624): null removes it; also strip it when changing `cardStyle` alone so the chosen style takes effect.
  if (card) holder.theme.card = card;
  else if (card === null || op.cardStyle !== undefined) delete holder.theme.card;
  const setColors = (target: ThemeColors, changes: typeof colors) => {
    for (const [key, value] of Object.entries(changes ?? {})) {
      const k = key as keyof ThemeColors;
      if (value === null) delete target[k];
      else if (value !== undefined) target[k] = value;
    }
  };
  setColors(holder.theme.colors, colors);
  if (darkColors) {
    const dark = (holder.theme.darkColors ??= {});
    setColors(dark, darkColors);
    if (Object.keys(dark).length === 0) delete holder.theme.darkColors;
  }
}

function addPackage(config: WorkspaceConfig, id: string, ctx: ApplyContext): void {
  if (config.packages.some((t) => t.id === id)) throw new OpError(`tool ${id} is already added`);
  const def = ctx.registry.tools.get(id);
  if (!def) throw new OpError(`tool ${id} is not in the catalog`);
  const page = def.createPage(ctx.locale);
  if (config.containers.pages.some((p) => p.id === page.id))
    throw new OpError(`page ${page.id} exists`);
  const tools = def.createWorkflows(ctx.locale);
  for (const wf of tools)
    if (config.tools.some((w) => w.id === wf.id)) throw new OpError(`tool ${wf.id} exists`);
  config.containers.pages.push(page);
  addQuickActions(config, tools);
  config.packages.push({ id: def.id, version: def.version, page: page.id });
  if (shownInToolGrid(config, def.id, [...ctx.registry.tools.keys()])) return;
  const home = getPage(config, HOME_PAGE_ID);
  // Same as v33 toolCard: title and icon fetched from the tool pack, defaulting to a large block.
  home.blocks.splice(packageEntryIndex(home), 0, {
    id: `card-${def.id}`,
    look: 'button',
    show: { shape: 'tile' },
    opens: packageTarget(def.id),
  });
}

function removePackage(config: WorkspaceConfig, id: string): void {
  const installed = config.packages.find((t) => t.id === id);
  if (!installed) throw new OpError(`tool ${id} is not added`);
  // Remove entry points, pages, quick actions, and reminders only; user files are not in config and remain unaffected (§7G).
  const target = pageTarget(installed.page);
  config.packages = config.packages.filter((t) => t.id !== id);
  config.containers.pages = config.containers.pages.filter((p) => p.package !== id);
  const own = config.tools.filter((t) => t.package === id);
  config.tools = config.tools.filter((t) => t.package !== id);
  removeQuickActionUses(
    config,
    own.filter((t) => t.kind === 'quickAction').map((t) => t.id),
  );
  removeEverywhere(config, (c) => {
    const opens = componentTarget(c);
    return opens === target || (opens !== null && packageTargetId(opens) === id);
  });
  removeFromNav(config, target);
}

function updatePackage(
  config: WorkspaceConfig,
  id: string,
  ctx: ApplyContext,
  notes: ApplyNote[],
): void {
  const installed = config.packages.find((t) => t.id === id);
  if (!installed) throw new OpError(`tool ${id} is not added`);
  const def = ctx.registry.tools.get(id);
  if (!def) throw new OpError(`tool ${id} is not in the catalog`);
  if (installed.version === def.version) throw new OpError(`tool ${id} is up to date`);
  const page = getPage(config, installed.page);
  const added = def
    .createWorkflows(ctx.locale)
    .filter((wf) => !config.tools.some((w) => w.id === wf.id));
  addQuickActions(config, added);
  // Place new entry points before the file list (or at the end if no file list exists).
  const files = page.blocks.findIndex((c) => isKnownComponent(c) && c.look === 'files');
  let at = files >= 0 ? files : page.blocks.length;
  for (const wf of added) {
    let blockId = `${wf.id}-runner`;
    for (let i = 2; findBlock(page, blockId); i++) blockId = `${wf.id}-runner-${i}`;
    page.blocks.splice(at++, 0, { id: blockId, look: 'button', tools: [{ tool: wf.id }] });
  }
  installed.version = def.version;
  notes.push({ kind: 'updatedTool', package: id, tools: added.map((w) => w.id) });
}

function applyOne(config: WorkspaceConfig, op: Op, ctx: ApplyContext, notes: ApplyNote[]): void {
  switch (op.op) {
    case 'addData':
      return addData(config, op);
    case 'updateData':
      return updateData(config, op);
    case 'removeData':
      return removeData(config, op, ctx.registry, notes);
    case 'moveData':
      return moveData(config, op);
    case 'addContainer':
      return addContainer(config, op);
    case 'updateContainer':
      return updateContainer(config, op, notes);
    case 'removeContainer':
      return removeContainer(config, op, notes);
    case 'moveContainer':
      return moveContainer(config, op);
    case 'addTool':
      return addTool(config, op);
    case 'updateTool':
      return updateTool(config, op);
    case 'removeTool':
      return removeTool(config, op, notes);
    case 'moveTool':
      return moveTool(config, op);
    case 'setTheme':
      return setTheme(config, op);
    case 'setPackage':
      if (op.do === 'add') return addPackage(config, op.package, ctx);
      if (op.do === 'remove') return removePackage(config, op.package);
      return updatePackage(config, op.package, ctx, notes);
  }
}

export function applyOps(
  config: WorkspaceConfig,
  ops: readonly Op[],
  ctx: ApplyContext,
): ApplyResult {
  const next = clone(config);
  const notes: ApplyNote[] = [];
  try {
    for (const op of ops) applyOne(next, op, ctx, notes);
  } catch (e) {
    if (e instanceof OpError) return { ok: false, error: e.message };
    throw e;
  }
  for (const table of addMissingEntryForms(config, next, ctx.locale))
    notes.push({ kind: 'addedEntryForm', table });
  pruneReminders(config, next, notes);
  return { ok: true, config: next, notes };
}

/**
 * Reminders that were previously valid but became broken because this batch of modifications
 * removed their targeted quick action/page, table, or field: remove them and document it in notes
 * (removing quick actions, pages, tables, fields, or tool packs will trigger this). Reminders
 * added or modified in this batch are untouched; any issues with them are rejected by the
 * validator.
 */
function pruneReminders(before: WorkspaceConfig, after: WorkspaceConfig, notes: ApplyNote[]) {
  const removed: string[] = [];
  after.tools = after.tools.filter((r) => {
    if (r.kind !== 'reminder') return true;
    const old = before.tools.find((x) => x.id === r.id);
    const unchanged = old !== undefined && JSON.stringify(old) === JSON.stringify(r);
    if (!unchanged || reminderProblems(r, after).length === 0) return true;
    removed.push(r.title);
    return false;
  });
  if (removed.length > 0) notes.push({ kind: 'removedReminders', titles: removed });
}
