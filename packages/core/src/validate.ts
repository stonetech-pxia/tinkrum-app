import { COMPONENTS } from './components';
import {
  duplicates,
  isSystemField,
  valueAt,
  type CheckContext,
  type CheckProblem,
} from './components/define';
import { conditionProblems } from './conditions';
import { drawnIconUses } from './drawn-icons';
import { MULTIPLE_CHOICE_NOT_ONE } from './fields';
import { entryFormProblems } from './entry-form';
import { FILES_COLLECTION, FILES_TABLE } from './files-table';
import { gridDateField } from './grid-view';
import { filterPresets } from './list-groups';
import { attachmentField, fieldHandsTo } from './handed';
import { pageBrowseLists } from './page-zones';
import { recordToolUseProblems, toolLabelMax, type ToolWhere } from './record-ops';
import {
  PICK_TOOLS,
  isOpenUse,
  isRecordToolUse,
  isToolRefUse,
  type ToolUse,
} from './record-ops-schema';
import { dateFieldOf } from './sequence';
import { statCalcProblems } from './stat-calc';
import { statMinusProblems } from './stat-minus';
import { expandCollection, relatedProblems } from './related';
import type { Registry } from './registry';
import { reminderProblems } from './reminders';
import {
  HOME_PAGE_ID,
  MAX_HOME_SCREEN,
  PROTECTED_TARGETS,
  RECORD_REF,
  appTargetId,
  WorkspaceConfigSchema,
  BACKDROP_TYPES,
  allComponents,
  childrenOf,
  componentCollection,
  componentDefinition,
  fieldDefinition,
  isKnownComponent,
  isMultipleChoice,
  packageTargetId,
  pageIdOf,
  quickActionsOf,
  remindersOf,
  toolTargetId,
  type Collection,
  type Component,
  type Condition,
  type KnownComponent,
  type OpenTarget,
  type Page,
  type WorkspaceConfig,
} from './schema';
import { contrastProblems } from './theme';
import { findWorkflowTarget, presetById } from './workflows/presets';
import { handedInput, workflowProblems } from './workflow/check';
import type { HandedType } from './workflow/contract';
import { handedRecordProblems, stepRefProblems } from './workflow/refs';
import { issueLines } from './zod-issues';

// Change validation (§7D): structure → references → protected elements → readability → tools and
// permissions → quick action data flow. Any configuration must pass through here before saving or
// rendering. v34 "Data · Containers · Tools": block references are checked against registry paths
// (refs), and allowed tools on blocks are checked against registry tools (as, do, ref, open,
// count); see comments everywhere for relation rules 12–14.

export interface ValidationIssue {
  code: string;
  message: string;
}

export type ValidationResult =
  { ok: true; config: WorkspaceConfig } | { ok: false; issues: ValidationIssue[] };

export interface ValidateOptions {
  /**
   * Blocks unrecognized by this version (D-254, look added by a newer app version, or look
   * "$unknown" migrated from v33). Omitted: treated entirely as a structural error. 'keep':
   * preserved as-is (reading stored configurations, restoring historical versions). A
   * configuration: preserves only items present as-is in that configuration (configurations
   * before AI submission or long-press edit modification: modifications can move or delete them,
   * but cannot add or modify new ones).
   */
  unknownComponents?: 'keep' | WorkspaceConfig;
}

export function validateWorkspace(
  input: unknown,
  registry: Registry,
  options: ValidateOptions = {},
): ValidationResult {
  const unknown = setAsideUnknown(input, options.unknownComponents);
  const parsed = WorkspaceConfigSchema.safeParse(unknown.input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: issueLines(parsed.error).map((message) => ({ code: 'schema', message })),
    };
  }
  const config = unknown.restore(parsed.data as WorkspaceConfig);
  const issues: ValidationIssue[] = [];
  const issue = (code: string, message: string) => issues.push({ code, message });
  const pages = config.containers.pages;
  const tables = config.data.tables;

  // ---- Uniqueness ----
  const pageIds = new Set(pages.map((p) => p.id));
  for (const id of duplicates(pages.map((p) => p.id))) issue('duplicate', `page ${id}`);
  for (const page of pages) {
    for (const id of duplicates(allComponents(page).map((c) => c.id))) {
      issue('duplicate', `component ${id} on page ${page.id}`);
    }
  }
  for (const id of duplicates(config.packages.map((t) => t.id))) issue('duplicate', `tool ${id}`);
  // Quick actions and reminders share the same ID space (tools[], tool:<id> and run logs resolve by ID).
  for (const id of duplicates(config.tools.map((t) => t.id)))
    issue('duplicate', `quick action or reminder ${id}`);
  if (!pageIds.has(HOME_PAGE_ID)) issue('missing-home', 'home page is required');

  // ---- Drawn icons (D-625): referenced my:<id> must exist in the icon library (invariant 18) ----
  for (const use of drawnIconUses(config))
    if (!config.icons?.[use.id])
      issue('unknown-icon', `${use.where}: icon my:${use.id} is not in the icon library (icons)`);

  // ---- Navigation and protected elements (§5.1) ----
  const entries = [...config.nav.bar, ...config.nav.floating];
  for (const target of duplicates(entries)) issue('duplicate', `nav entry ${target}`);
  for (const target of entries) {
    const pageId = pageIdOf(target);
    if (pageId !== null && !pageIds.has(pageId)) issue('unknown-page', `nav entry ${target}`);
    const problem = recordPageTargetProblem(config, target);
    if (problem) issue('record-page', `nav entry ${problem}`);
    const tool = toolTargetId(target);
    if (tool !== null && handedBy(config, tool, registry))
      issue('needs-container', needsContainer(tool, `nav entry ${target}`));
  }
  // ---- App (D-485): self-consistent structure. Reference ownership (who can point to whom) is checked only during modification, not here, to allow opening old snapshots (invariant 12) ----
  const apps = config.nav.apps ?? [];
  const appIds = new Set(apps.map((a) => a.id));
  for (const id of duplicates(apps.map((a) => a.id))) issue('duplicate', `app ${id}`);
  for (const page of pages) {
    if (page.app === undefined) continue;
    if (!appIds.has(page.app))
      issue('unknown-app', `page ${page.id}: app ${page.app} does not exist`);
    if (page.id === HOME_PAGE_ID) issue('app-home', 'the home page cannot belong to an app');
  }
  for (const table of tables) {
    if (table.app !== undefined && !appIds.has(table.app))
      issue('unknown-app', `table ${table.id}: app ${table.app} does not exist`);
  }
  for (const tool of config.tools) {
    if (tool.app !== undefined && !appIds.has(tool.app))
      issue('unknown-app', `${tool.kind} ${tool.id}: app ${tool.app} does not exist`);
  }
  for (const target of entries) {
    const owner = pages.find((p) => p.id === pageIdOf(target))?.app;
    if (owner !== undefined)
      issue(
        'app-nav',
        `nav entry ${target} belongs to app ${owner}; the home bar only lists home pages`,
      );
  }
  for (const app of apps) {
    for (const target of duplicates(app.bar))
      issue('duplicate', `app ${app.id} bar entry ${target}`);
    for (const target of app.bar) {
      const pageId = pageIdOf(target);
      if (pageId === null) continue;
      const page = pages.find((p) => p.id === pageId);
      if (!page) issue('unknown-page', `app ${app.id} bar entry ${target}`);
      else if (page.app !== app.id)
        issue('app-nav', `app ${app.id} bar entry ${target} does not belong to this app`);
      const problem = recordPageTargetProblem(config, target);
      if (problem) issue('record-page', `app ${app.id} bar entry ${problem}`);
    }
    for (const problem of contrastProblems(app.theme))
      issue('contrast', `app ${app.id} theme: ${problem}`);
  }
  // ---- Page for a single record (D-342, page.of) ----
  for (const page of pages) {
    if (page.of === undefined) continue;
    if (page.id === HOME_PAGE_ID) issue('record-page', 'the home page cannot have of');
    const table = tables.find((c) => c.id === page.of);
    if (!table) issue('record-page', `page ${page.id}: of ${page.of} is not a data table`);
    else if (table.app !== page.app)
      issue('app-ref', `page ${page.id} and its table ${table.id} must belong to the same app`);
  }
  for (const target of PROTECTED_TARGETS) {
    if (!entries.includes(target)) {
      issue(
        'protected',
        `${target} must stay in the nav bar or a floating button (it holds the Tink and History entries)`,
      );
    }
  }

  // ---- Readability: the user must still be able to find settings if the theme is broken (§5.1) ----
  for (const problem of contrastProblems(config.theme)) issue('contrast', `theme: ${problem}`);

  // ---- Tool packs (called "Tools" in the UI): each tool pack owns its own page ----
  const installed = new Map(config.packages.map((t) => [t.id, t]));
  for (const pkg of config.packages) {
    if (!registry.tools.has(pkg.id)) issue('unknown-tool', `tool ${pkg.id}`);
    const page = pages.find((p) => p.id === pkg.page);
    if (!page || page.package !== pkg.id) {
      issue('tool-page', `tool ${pkg.id} must own page ${pkg.page}`);
    }
  }
  for (const page of pages) {
    if (page.package !== undefined && !installed.has(page.package)) {
      issue('tool-page', `page ${page.id} belongs to a tool that is not installed`);
    }
  }

  // ---- Blocks: references (refs in the registry), tools (tools in the registry), look-specific checks, read data ----
  const blockIssue = (c: Component, problem: CheckProblem) =>
    typeof problem === 'string'
      ? issue('data', `${c.id}: ${problem}`)
      : issue(problem.code, problem.message);
  const desk = config.containers.desk;
  const deskPage: Page | undefined =
    desk && (desk.above?.length || desk.below?.length)
      ? { id: '$desk', title: 'Desk', blocks: [...(desk.above ?? []), ...(desk.below ?? [])] }
      : undefined;
  for (const page of deskPage ? [...pages, deskPage] : pages) {
    for (const { block: c, parent } of withParents(page)) {
      // Unknown blocks (D-254) are preserved as-is with no checkable references.
      if (!isKnownComponent(c)) continue;
      const ctx: CheckContext = { config, registry, page, ...(parent ? { parent } : {}) };
      for (const p of blockProblems(c, ctx)) blockIssue(c, p);
    }
  }

  // ---- Table structure (docs/DATA_DESIGN.md) ----
  for (const id of duplicates(tables.map((c) => c.id))) issue('duplicate', `collection ${id}`);
  for (const collection of tables) {
    for (const id of duplicates(collection.fields.map((f) => f.id))) {
      issue('duplicate', `field ${id} in ${collection.id}`);
    }
    // Field-specific validation (formulas compute correctly, referenced tables exist, unique options, etc.) is in fields/<type>.ts.
    const view = expandCollection(tables, collection);
    for (const field of collection.fields) {
      for (const problem of fieldDefinition(field.type).check?.(field, {
        config,
        collection,
        view,
      }) ?? [])
        issue(problem.code, problem.message);
      // Lookup, rollup, previous entry (D-287–D-290): definition correctness, circular references, and excessive nesting depth.
      for (const problem of relatedProblems(field, { config, collection, view }))
        issue(problem.code, problem.message);
    }
    for (const message of recordRowProblems(collection, config, registry)) issue('data', message);
    // Record form sections and conditions (D-570).
    for (const message of entryFormProblems(collection)) issue('data', message);
  }

  // ---- Home Screen (D-271): The menu for long-pressing the Morph icon holds at most MAX_HOME_SCREEN quick actions ----
  const onHomeScreen = config.nav.phoneHomeScreen ?? [];
  const quickActions = quickActionsOf(config);
  const quickActionIds = new Set(quickActions.map((w) => w.id));
  if (onHomeScreen.length > MAX_HOME_SCREEN) {
    issue(
      'homeScreen',
      `at most ${MAX_HOME_SCREEN} quick actions and apps can be on the phone home screen (now ${onHomeScreen.join(', ')}); take one off first`,
    );
  }
  for (const id of duplicates(onHomeScreen))
    issue('duplicate', `nav.phoneHomeScreen lists ${id} twice`);
  for (const id of onHomeScreen) {
    const appId = id.startsWith('app:') ? id.slice('app:'.length) : null;
    if (appId !== null) {
      // Apps placed in the home screen menu (D-485): must exist.
      if (!(config.nav.apps ?? []).some((a) => a.id === appId))
        issue('unknown-app', `nav.phoneHomeScreen: ${id} is not an app`);
    } else if (!quickActionIds.has(id))
      issue(
        'homeScreen',
        `nav.phoneHomeScreen: ${id} is not a quick action in tools or an app:<id> (only quick actions and apps can be on the phone home screen)`,
      );
    else if (handedBy(config, id, registry))
      issue('needs-container', needsContainer(id, 'nav.phoneHomeScreen'));
  }

  // ---- Reminders (D-251) ----
  for (const r of remindersOf(config)) {
    for (const problem of reminderProblems(r, config)) issue('reminder', problem);
    // Reminders only open and do not execute (Relation Rule 14); quick actions requiring container values cannot run even if opened.
    const opened = toolTargetId(r.opens);
    if (opened !== null && handedBy(config, opened, registry))
      issue('needs-container', needsContainer(opened, `reminder ${r.id}`));
  }

  // ---- Quick actions: action registration, parameters, permissions, adjacent-step types (§7B, §7C, D-060) ----
  for (const wf of quickActions) {
    let toolDef = undefined;
    if (wf.package !== undefined) {
      toolDef = registry.tools.get(wf.package);
      if (!installed.has(wf.package) || !toolDef) {
        issue(
          'unknown-tool',
          `quick action ${wf.id} belongs to tool ${wf.package} which is not installed`,
        );
        continue;
      }
    }
    for (const id of duplicates(wf.steps.map((s) => s.id)))
      issue('duplicate', `step ${id} in ${wf.id}`);
    for (const problem of workflowProblems(wf, registry)) issue(problem.code, problem.message);
    for (const message of stepRefProblems(wf, config, registry)) issue('data', message);
    // Quick actions bundled with a pack can only use permissions declared by that pack; user quick actions are confirmed step by step by the user.
    if (!toolDef) continue;
    for (const step of wf.steps) {
      for (const permission of registry.actions.get(step.action)?.requires ?? []) {
        if (!toolDef.permissions.includes(permission)) {
          issue(
            'permission',
            `${wf.id}/${step.id}: tool ${wf.package} did not declare ${permission}`,
          );
        }
      }
    }
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, config };
}

/** Blocks on the page and their outer group containers (two levels, in display order). */
function withParents(page: Page): { block: Component; parent?: { id: string; look: 'group' } }[] {
  const walk = (list: readonly Component[], parent?: { id: string; look: 'group' }) =>
    list.flatMap((c): { block: Component; parent?: { id: string; look: 'group' } }[] => [
      parent ? { block: c, parent } : { block: c },
      ...walk(childrenOf(c), { id: c.id, look: 'group' }),
    ]);
  return walk(page.blocks);
}

/**
 * Block-level validation problems, in a fixed order (texts sent to AI): image background ->
 * target to open, pack -> data read (table, field, component-specific checks, filters) -> tools
 * on the block. Appearance checks for non-table blocks run before tools.
 */
function blockProblems(c: KnownComponent, ctx: CheckContext): CheckProblem[] {
  const { config, registry, page } = ctx;
  const def = componentDefinition(c.look);
  const problems: CheckProblem[] = [];
  if (c.style?.backdrop && !def.edit.backdrop) {
    problems.push({
      code: 'style',
      message: `component ${c.id} (${c.look}) can't have a picture background: style.backdrop is only for ${BACKDROP_TYPES.join(', ')}`,
    });
  }
  if (c.showIf && !config.data.tables.some((x) => x.id === c.showIf!.table))
    problems.push(`showIf: data table ${c.showIf.table} does not exist`);
  else if (c.showIf?.filter?.length) {
    // D-579: Filters read precomputed values (rollups, lookups) from this table, so fields are validated against the display table just like list filters.
    const table = config.data.tables.find((x) => x.id === c.showIf!.table)!;
    problems.push(
      ...conditionProblems(c.showIf.filter, expandCollection(config.data.tables, table)).map(
        (p) => `showIf.filter: ${p}`,
      ),
    );
  }
  // Pinned sections belong to the page (decided by founder 2026-11-04): blocks inside groups cannot be pinned.
  if (c.pin !== undefined && ctx.parent)
    problems.push(
      `a block inside group ${ctx.parent.id} can't have pin; pin only top-level blocks`,
    );
  if (c.pin !== undefined && page.id === '$desk')
    problems.push("a block on the file desk can't have pin; pin only blocks on a page");
  for (const [path, ref] of Object.entries(def.refs ?? {})) {
    const value = valueAt(c, path);
    if (!ref || value === undefined) continue;
    if (ref.to === 'target')
      problems.push(
        ...targetProblems(config, ctx.registry, value as OpenTarget, `component ${c.id}`, page.id),
      );
    else if (ref.to === 'package') {
      for (const id of [value].flat() as string[]) {
        if (ref.in === 'installed' && !config.packages.some((p) => p.id === id)) {
          problems.push({
            code: 'unknown-tool',
            message: `component ${c.id} shows tool ${id} which is not installed`,
          });
        } else if (ref.in === 'catalog' && !registry.tools.has(id)) {
          problems.push({
            code: 'unknown-tool',
            message: `component ${c.id} lists tool ${id} which is not in the catalog`,
          });
        }
      }
    }
  }
  const tableId = componentCollection(c);
  if (c.look === 'files') problems.push(...filesProblems(c));
  if (tableId === null) {
    problems.push(...(def.check?.(c, ctx) ?? []));
    problems.push(...toolUseProblems(c, ctx, undefined));
    return problems;
  }
  const table = config.data.tables.find((x) => x.id === tableId);
  if (!table) return [...problems, `data table ${tableId} does not exist`];
  // Lookup, rollup, and previous entry checked via their displayed field types (D-287–D-289).
  const collection = expandCollection(config.data.tables, table);
  let filter: Condition[] | undefined;
  for (const [path, ref] of Object.entries(def.refs ?? {})) {
    const value = valueAt(c, path);
    if (!ref || value === undefined) continue;
    if (ref.to === 'filter') filter = value as Condition[];
    if (ref.to !== 'field') continue;
    const role = ref.role ?? path;
    for (const id of [value].flat() as string[]) {
      const field = collection.fields.find((f) => f.id === id);
      if (ref.types) {
        const ok = isSystemField(id)
          ? ref.types.includes('date')
          : field !== undefined && ref.types.includes(field.type);
        if (!ok)
          problems.push(
            `${role} ${id} must be a ${ref.types.join(' or ')} field of ${collection.id}`,
          );
      } else if (!isSystemField(id) && !field) {
        problems.push(`${role} ${id} is not a field of ${collection.id}`);
      }
      if (ref.one && isMultipleChoice(field))
        problems.push(
          `${role} ${id} ${MULTIPLE_CHOICE_NOT_ONE}; use a choice field without multiple`,
        );
    }
  }
  problems.push(...(def.check?.(c, { ...ctx, collection }) ?? []));
  problems.push(...conditionProblems(filter, collection, page.of));
  // Record block highlight color conditions (D-541) are validated the same way as filters.
  const highlight = (c as { show?: { highlight?: Condition[] } }).show?.highlight;
  if (highlight)
    problems.push(
      ...conditionProblems(highlight, collection, page.of).map((p) => `show.highlight: ${p}`),
    );
  // Kanban split by reference (D-351): source.group.filter filters the referenced table.
  const group = (c as { source?: { group?: { by?: string; filter?: Condition[] } } }).source?.group;
  if (group?.filter && group.by !== undefined) {
    const link = collection.fields.find((f) => f.id === group.by);
    const other =
      link?.type === 'link' ? config.data.tables.find((x) => x.id === link.table) : undefined;
    if (other)
      problems.push(
        ...conditionProblems(
          group.filter,
          expandCollection(config.data.tables, other),
          page.of,
        ).map((p) => `source.group.filter: ${p}`),
      );
  }
  // Number subtraction (D-337): the subtracted table and its filter.
  if (c.look === 'number')
    problems.push(
      ...statMinusProblems(c, collection, config, page.of),
      ...statCalcProblems(c, collection, config, page.of),
    );
  // Tools on record blocks operate on a single row of the source table ($row); form submissions
  // write to their own table (Relation Rule 12). Forms (created on submit) and prompt cards (D-580,
  // buttons not bound to a specific row) do not operate on a specific row of the read table.
  problems.push(
    ...toolUseProblems(c, ctx, c.look === 'form' || c.look === 'callout' ? undefined : table),
  );
  return problems;
}

/** File lists read the system table $files (Q2): filters and sorting can only use its automatic fields. */
function filesProblems(c: Extract<KnownComponent, { look: 'files' }>): string[] {
  const problems = conditionProblems(c.source.filter, FILES_COLLECTION).map(
    (p) => `${FILES_TABLE} ${p}`,
  );
  const sort = c.source.sort?.field;
  if (sort !== undefined && !isSystemField(sort) && sort !== 'name' && sort !== 'size')
    problems.push(`${FILES_TABLE} can be sorted by name, size or createdAt, not ${sort}`);
  return problems;
}

/**
 * Opens target (navigation, Relation Rule 6): the page must exist and cannot be a page intended
 * for a single record; tool:<id> is a preset ID for a config quick action or built-in quick
 * action (display-only, not executable; reminders cannot be opened, Relation Rule 13);
 * package:<id> must be added.
 */
function targetProblems(
  config: WorkspaceConfig,
  registry: Registry,
  target: OpenTarget,
  who: string,
  pageId: string,
): CheckProblem[] {
  const problems: CheckProblem[] = [];
  const where = `${who} on page ${pageId}`;
  const page = pageIdOf(target);
  if (page !== null && !config.containers.pages.some((p) => p.id === page)) {
    problems.push({ code: 'unknown-page', message: `${where} opens missing ${String(target)}` });
  }
  const recordPage = recordPageTargetProblem(config, target);
  if (recordPage) problems.push({ code: 'record-page', message: `${where}: ${recordPage}` });
  const tool = toolTargetId(target);
  if (tool !== null) {
    const problem = quickActionRefProblem(config, tool);
    if (problem) problems.push({ code: 'unknown-workflow', message: `${where} opens ${problem}` });
    else if (handedBy(config, tool, registry))
      problems.push({ code: 'needs-container', message: needsContainer(tool, where) });
  }
  const app = appTargetId(target);
  if (app !== null && !(config.nav.apps ?? []).some((a) => a.id === app)) {
    problems.push({ code: 'unknown-app', message: `${where} opens missing ${String(target)}` });
  }
  const pkg = packageTargetId(target);
  if (pkg !== null && !config.packages.some((p) => p.id === pkg)) {
    problems.push({
      code: 'unknown-tool',
      message: `${where} opens tool ${pkg} which is not installed`,
    });
  }
  return problems;
}

/**
 * Quick actions referenced by blocks (opens tool:<id>, {tool: <id>}): quick actions in tools[] or
 * preset IDs of built-in quick actions (D-236, D-256, D-259, no need to add). Reminders are not
 * executable tools openable from blocks (Relation Rule 13). Null when there are no issues.
 */
function handedBy(config: WorkspaceConfig, id: string, registry: Registry): HandedType | null {
  const wf = findWorkflowTarget(quickActionsOf(config), id, 'en');
  return wf ? handedInput(wf.steps, registry) : null;
}

/** Quick action requires container values (D-428): can only be placed on record pages and record blocks; tapping elsewhere provides no values to pass. */
const needsContainer = (id: string, where: string) =>
  `${where}: ${id} takes a record, a value or attachments from where it sits, so it can't run from here; put it in a table's recordRow or on a records block`;

function quickActionRefProblem(config: WorkspaceConfig, id: string): string | null {
  const tool = config.tools.find((t) => t.id === id);
  if (tool?.kind === 'quickAction' || (!tool && presetById(id))) return null;
  return tool?.kind === 'reminder'
    ? `${id}, which is a reminder; only a quick action can be opened or run from a block (a reminder only fires at its time)`
    : `missing quick action ${id}`;
}

/** Buttons at the top of record pages (D-428, Invariant 18): quick action exists, first step receives values, record or file; value-receiving and file actions must target a field (files require an attachment field), record-receiving actions do not target a field. */
function recordRowProblems(
  table: Collection,
  config: WorkspaceConfig,
  registry: Registry,
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const item of table.recordRow ?? []) {
    const where = `table ${table.id} recordRow ${item.tool}`;
    const key = `${item.tool}/${item.field ?? ''}`;
    if (seen.has(key)) problems.push(`${where}: listed twice`);
    seen.add(key);
    const problem = quickActionRefProblem(config, item.tool);
    if (problem) {
      problems.push(`${where}: ${problem}`);
      continue;
    }
    const takes = handedBy(config, item.tool, registry);
    if (takes === null)
      problems.push(
        `${where}: this quick action chooses its own input; a button on the entry page must start with a step that takes text, records or files (e.g. out.call, records.toVCard, pdf.compress)`,
      );
    else if (takes === 'records') {
      const wf = findWorkflowTarget(quickActionsOf(config), item.tool, 'en');
      if (wf) problems.push(...handedRecordProblems(wf, table.id, registry));
      if (item.field !== undefined)
        problems.push(`${where}: its first step takes the whole entry: leave field out`);
    } else {
      // Text, files: pass a field value, requires a target field (D-442: field value type determines what is passed).
      const field = table.fields.find((f) => f.id === item.field);
      if (item.field === undefined)
        problems.push(`${where}: its first step takes ${takes}: name a field`);
      else if (!field) problems.push(`${where}: ${item.field} is not a field of ${table.id}`);
      else if (fieldHandsTo(field) !== takes)
        problems.push(
          takes === 'text'
            ? `${where}: ${item.field} is a ${field.type} field that doesn't hand over text; name a text, note, number, money, date, time, duration, rating, choice or tags field`
            : `${where}: ${item.field} is a ${field.type} field; its first step takes files: name an attachment field`,
        );
    }
  }
  return problems;
}

const AS_NAME = (as: ToolUse['as']) => (as === undefined ? 'without as' : `as "${as}"`);

/**
 * Tools on blocks (D-370 Rule 4): check appearance mode (as) against registration tools, one-tap
 * record types (do), independent tools referenced (ref), row-level opens (open), and counts
 * (button ≤3, tap ≤3, others ≤1 each); lists must have exactly one checkbox, kanban drag must
 * specify a grouping field, followed by individual in-situ tool checks (record-ops.ts). rowOf:
 * table read by the record block ($row is a row of this table).
 */
function toolUseProblems(
  c: KnownComponent,
  { config, page, registry }: CheckContext,
  rowOf: Collection | undefined,
): CheckProblem[] {
  const meta = componentDefinition(c.look).tools;
  const uses = ((c as { tools?: ToolUse[] }).tools ?? []) as ToolUse[];
  const problems: CheckProblem[] = [];
  // Button: opens a destination or executes a one-tap record tool (v33 target / action mutually exclusive).
  if (c.look === 'button' && c.opens === undefined && uses.length === 0)
    problems.push('a button needs opens (to open something) or tools (one record tool)');
  if (!meta) return problems;
  if (uses.length > meta.max)
    problems.push(`a ${c.look} block has at most ${meta.max} tools (now ${uses.length})`);
  const counts = new Map<string, number>();
  for (const u of uses) counts.set(u.as ?? 'self', (counts.get(u.as ?? 'self') ?? 0) + 1);
  for (const [as, n] of counts) {
    const max =
      c.look === 'dial' ? meta.max : as === 'button' || as === 'tap' || as === 'list' ? 3 : 1;
    if (n > max)
      problems.push(
        `a ${c.look} block has at most ${max} tool${max === 1 ? '' : 's'} ${as === 'self' ? 'without as' : `as "${as}"`} (now ${n})`,
      );
  }
  const group = (c as { source?: { group?: { by?: string } } }).source?.group;
  if (c.look === 'checklist' && (counts.get('check') ?? 0) !== 1)
    problems.push(
      'a checklist needs exactly one tool {as: "check", do: "toggle", table, field: <a checkbox field>}',
    );
  uses.forEach((u, i) => {
    const as = u.as ?? 'self';
    const label = `${c.look} ${c.id} ${u.as ?? 'tool'}${u.label ? ` "${u.label}"` : uses.length > 1 ? ` ${i + 1}` : ''}`;
    if (!(meta.as as readonly string[]).includes(as)) {
      problems.push(
        `${label}: ${AS_NAME(u.as)} doesn't fit a ${c.look} block (allowed: ${meta.as.map((a) => (a === 'self' ? 'no as' : a)).join(', ')})`,
      );
      return;
    }
    if (isToolRefUse(u)) {
      const pick = (PICK_TOOLS as readonly string[]).includes(u.tool);
      // On record blocks, only buttons above the list run quick actions (D-428); buttons on individual rows only perform one-tap records.
      const blockRuns = c.look === 'dial' || !meta.as.includes('list') || u.as === 'list';
      if (!meta.ref?.includes(pick ? 'pick' : 'quickAction') || !blockRuns) {
        problems.push(
          `${label}: a ${c.look} block can't ${pick ? `use ${u.tool}` : 'run a quick action'}`,
        );
        return;
      }
      if (!pick) {
        const problem = quickActionRefProblem(config, u.tool);
        if (problem)
          problems.push({
            code: 'unknown-workflow',
            message: `component ${c.id} runs ${problem}`,
          });
        else {
          // Lists pass their selected records, single-record blocks pass the current row (D-428); other blocks have no values to pass.
          const hands = u.as === 'list' || c.look === 'single';
          const takes = handedBy(config, u.tool, registry);
          if (hands && takes === 'records') {
            const wf = findWorkflowTarget(quickActionsOf(config), u.tool, 'en');
            const tableId =
              rowOf?.id ??
              (c.look === 'dial' ? pageBrowseLists(page)[0]?.source?.table : undefined);
            if (wf) problems.push(...handedRecordProblems(wf, tableId, registry));
          }
          if (hands && takes === 'files') {
            // File in the first attachment field of this table (D-442); standalone floating buttons have no table of their own and pass no files.
            if (c.look === 'dial' || !rowOf || !attachmentField(rowOf))
              problems.push(
                `${label}: ${u.tool} starts with a step that takes files, so the block must read a table with an attachment field${c.look === 'dial' ? ' (a dial has no table of its own)' : ''}`,
              );
          } else if (hands && takes !== 'records')
            problems.push(
              `${label}: ${u.tool} can't sit here: this block hands over its records (or the attachments of its table), so the quick action must start with a step that takes records or files, with no input step (e.g. records.toVCard, pdf.compress)`,
            );
          else if (!hands && takes !== null)
            problems.push({ code: 'needs-container', message: needsContainer(u.tool, label) });
          // Standalone floating buttons pass records currently selected in the page list: the page must have exactly one selectable list.
          if (c.look === 'dial' && u.as === 'list' && pageBrowseLists(page).length !== 1)
            problems.push(
              `${label}: as "list" hands over what a list on this page selects: page ${page.id} needs exactly one top-level list with show.browse`,
            );
        }
      }
      if (c.look === 'dial') {
        if (u.when !== undefined) problems.push(`${label}: a dial has no when`);
        if (u.label !== undefined && u.label.length > toolLabelMax(u.as))
          problems.push(`${label}: label can be at most ${toolLabelMax(u.as)} characters`);
      } else if (u.label !== undefined || u.when !== undefined)
        problems.push(`${label}: label and when only apply to tools on each entry`);
      return;
    }
    if (isOpenUse(u)) {
      if (!meta.open) {
        problems.push(`${label}: a ${c.look} block can't open an entry`);
        return;
      }
      if (c.look === 'dial') {
        // Standalone floating button opens a standard page (not a single-record page).
        const target = config.containers.pages.find((p) => p.id === u.opens);
        if (!target) problems.push(`${label}: opens ${u.opens} is not a page`);
        else if (target.of !== undefined)
          problems.push(`${label}: opens ${u.opens} is a page for one entry; a dial has no entry`);
        if (u.when !== undefined) problems.push(`${label}: a dial has no when`);
        if (u.label === undefined) problems.push(`${label}: needs a label`);
        else if (u.label.length > toolLabelMax(u.as))
          problems.push(`${label}: label can be at most ${toolLabelMax(u.as)} characters`);
        return;
      }
      if (u.as !== 'button' && u.as !== 'tap')
        problems.push(`${label}: opening an entry is a button or tap on each entry`);
      if (u.label === undefined)
        problems.push(`${label}: needs a label (shown on the button and read by screen readers)`);
      else if (u.label.length > toolLabelMax(u.as))
        problems.push(`${label}: label can be at most ${toolLabelMax(u.as)} characters`);
      if (u.opens !== 'record') {
        const target = config.containers.pages.find((p) => p.id === u.opens);
        if (!target) problems.push(`${label}: opens ${u.opens} is not a page`);
        else if (rowOf && target.of !== rowOf.id)
          problems.push(
            `${label}: opens ${u.opens} must be a page for one entry of ${rowOf.id} (of: "${rowOf.id}")`,
          );
      }
      if (u.when && rowOf)
        problems.push(
          ...conditionProblems(u.when, expandCollection(config.data.tables, rowOf), page.of).map(
            (x) => `${label} when: ${x}`,
          ),
        );
      return;
    }
    if (!isRecordToolUse(u)) return;
    if (u.as === 'list') {
      problems.push(`${label}: as "list" only runs a quick action: {as: "list", tool: <id>}`);
      return;
    }
    if (!meta.do?.includes(u.do)) {
      problems.push(
        `${label}: a ${c.look} block can't have a ${u.do} tool${meta.do ? ` (allowed: ${meta.do.join(', ')})` : ''}`,
      );
      return;
    }
    if (c.look === 'dial' && u.label === undefined)
      problems.push(`${label}: needs a label (shown next to the button)`);
    if (u.as === 'check' && u.do !== 'toggle') {
      problems.push(
        `${label}: the check of a checklist is {do: "toggle", field: <a checkbox field>}`,
      );
      return;
    }
    if (u.as === 'drag') {
      if (u.do !== 'set' || u.field !== group?.by || u.value !== '$group') {
        problems.push(
          `${label}: dragging a card to another column is {as: "drag", do: "set", table, field: ${group?.by ?? '<source.group.by>'}, value: "$group"}`,
        );
        return;
      }
    }
    const where: ToolWhere = {
      label,
      ...(rowOf ? { rowOf } : {}),
      ...(page.of !== undefined ? { recordOf: page.of } : {}),
      ...(c.look === 'form' ? { form: true } : {}),
      ...(u.as === 'drag' && group?.by !== undefined ? { dragField: group.by } : {}),
      ...(c.look === 'grid'
        ? { grid: true, hereFields: gridHereFields(c, rowOf) }
        : u.as === 'addHere' && rowOf
          ? listHere(c, rowOf)
          : {}),
    };
    problems.push(...recordToolUseProblems(u, config, where));
  });
  return problems;
}

/** Fields required for "$here" on a check-in grid (D-610): row-splitting field, column-splitting date field, and equality conditions in filters (gridHereValues in grid-view.ts). */
function gridHereFields(c: KnownComponent, table: Collection | undefined): string[] {
  const source = (c as Extract<KnownComponent, { look: 'grid' }>).source;
  if (!table || !source.across) return [];
  return [
    ...(source.group?.by ? [source.group.by] : []),
    gridDateField(table, source.across),
    ...Object.keys(filterPresets(table, source.filter)),
  ];
}

/**
 * Fields filled by "Add" ("$here", D-349) below a list (for check-in creation in D-616): equality
 * conditions in filters are always filled ("$record" is substituted with that row when opening
 * the page, D-342, treated as having a value here); section, grouping, and calendar date fields
 * are optional (some sections have no value).
 */
function listHere(
  c: KnownComponent,
  table: Collection,
): Pick<ToolWhere, 'hereFields' | 'hereGroup'> {
  const source = (c as Extract<KnownComponent, { look: 'list' | 'calendar' }>).source;
  const filter = (source.filter ?? []).map((x) =>
    x.value === RECORD_REF ? { ...x, value: RECORD_REF.slice(1) } : x,
  );
  const group = source.group as { by?: string } | undefined;
  const by = c.look === 'calendar' ? dateFieldOf(table, group?.by) : group?.by;
  return {
    hereFields: Object.keys(filterPresets(table, filter)),
    ...(by !== undefined ? { hereGroup: by } : {}),
  };
}

const KNOWN_LOOKS = new Set<string>(COMPONENTS.map((d) => d.look));

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isUnknownBlock = (v: unknown): v is Json & { look: string } =>
  isObject(v) && typeof v.look === 'string' && !KNOWN_LOOKS.has(v.look);

/** All unknown blocks in a configuration (D-254), represented by JSON text. */
function unknownBlockTexts(config: WorkspaceConfig): Set<string> {
  return new Set(
    config.containers.pages.flatMap((p) =>
      allComponents(p).flatMap((c) => (isKnownComponent(c) ? [] : [JSON.stringify(c)])),
    ),
  );
}

/**
 * Allowed unknown blocks (D-254) are temporarily replaced with dividers of the same ID for
 * structural validation (other problem texts and positions remain unchanged), then swapped back
 * to the original JSON upon passing. Disallowed ones are validated as usual and reported as
 * structural errors. Same for blocks inside groups or nested groups.
 */
function setAsideUnknown(
  input: unknown,
  allow: ValidateOptions['unknownComponents'],
): { input: unknown; restore: (config: WorkspaceConfig) => WorkspaceConfig } {
  const none = { input, restore: (config: WorkspaceConfig) => config };
  const containers = isObject(input) ? input.containers : undefined;
  if (allow === undefined || !isObject(containers) || !Array.isArray(containers.pages)) return none;
  const allowed = allow === 'keep' ? null : unknownBlockTexts(allow);
  const isAllowed = (c: unknown): c is Json =>
    isUnknownBlock(c) && (allowed === null || allowed.has(JSON.stringify(c)));
  /** Block location: page index, followed by a sequence of blocks / children indices. */
  const kept: { page: number; path: number[]; raw: Json }[] = [];
  const walk = (list: unknown[], page: number, path: number[]) =>
    list.forEach((c, i) => {
      if (isAllowed(c)) kept.push({ page, path: [...path, i], raw: c });
      else if (isObject(c) && c.look === 'group' && Array.isArray(c.children))
        walk(c.children as unknown[], page, [...path, i]);
    });
  (containers.pages as unknown[]).forEach((page, p) => {
    if (isObject(page) && Array.isArray(page.blocks)) walk(page.blocks as unknown[], p, []);
  });
  if (kept.length === 0) return none;
  type Pages = { blocks: Json[] }[];
  const slot = (pages: Pages, k: (typeof kept)[number]) => {
    let list = pages[k.page]!.blocks;
    for (const i of k.path.slice(0, -1)) list = list[i]!.children as Json[];
    return { list, at: k.path.at(-1)! };
  };
  const copy = JSON.parse(JSON.stringify(input)) as { containers: { pages: Pages } };
  for (const k of kept) {
    const { list, at } = slot(copy.containers.pages, k);
    const standIn: Json = { id: k.raw.id, look: 'divider' };
    if (k.raw.hidden !== undefined) standIn.hidden = k.raw.hidden;
    list[at] = standIn;
  }
  return {
    input: copy,
    restore: (config) => {
      const pages = config.containers.pages as unknown as Pages;
      for (const k of kept) {
        const { list, at } = slot(pages, k);
        list[at] = JSON.parse(JSON.stringify(k.raw)) as Json;
      }
      return config;
    },
  };
}

/**
 * Single-record pages (D-342, page.of) cannot be opened directly: the specific record is unknown.
 * Navigation bars, buttons, entry points, and reminders throw an error when trying to open them,
 * with text sent to the AI (use record block opens on this table instead).
 */
export function recordPageTargetProblem(
  config: WorkspaceConfig,
  target: OpenTarget,
): string | null {
  const pageId = pageIdOf(target);
  const page = pageId === null ? undefined : config.containers.pages.find((p) => p.id === pageId);
  if (!page?.of) return null;
  return `${String(target)} opens page ${page.id}, which shows one entry of ${page.of}; it can only be opened from a list of ${page.of} (the opens of a list, cards, board… block)`;
}
