import { localize } from './localization';
import { t } from './messages';
import type { Op, OpOf } from './ops-schema';
import {
  HOME_PAGE_ID,
  MAX_PAGE_BLOCKS,
  MAX_RECORD_REMINDERS,
  MAX_REMINDERS,
  MAX_WORKFLOWS,
  allComponents,
  quickActionsOf,
  remindersOf,
  type IconValue,
  type Collection,
  type Locale,
  type Localized,
  type QuickAction,
  type Reminder,
  type WorkspaceConfig,
} from './schema';
import { draftTable, entryOps, templateTableName, type NewPreset } from './templates';
import { newWorkflowId, presetById, presetWorkflow } from './workflows/presets';
import babyGrowth from './samples/baby-growth.json';
import businessCards from './samples/business-cards.json';
import expenseHelper from './samples/expense-helper.json';
import receipts from './samples/receipts.json';
import shopOrders from './samples/shop-orders.json';
import studyHelper from './samples/study-helper.json';
import visaDocs from './samples/visa-docs.json';

// Sample Apps (D-260): The final step of onboarding lets users apply a complete set at once to see
// what kind of app Morph can become, and modify it from there. A sample is defined in
// samples/<id>.json (v34 format), extending page templates (D-255) with: data tables, pages, quick
// actions, home screen entries, and reminders.
//
// - ids: placeholders → base IDs. Placeholders are written as $table.<name>, $page.<name>,
// $tool.<name> (quick actions and reminders share tools[], forming a single ID set); if tables with
// the same name already exist in the config, append -2, -3, etc. (preset quick action IDs match
// user-added ones, see below). References use the placeholder itself (source.table, inline tool
// table, {tool}), or page:$page.x, tool:$tool.x (opens).
// - tables, pages: contents of addData {table}, addContainer {page}; inter-table reference fields
// (D-250) also use placeholders. Tables must be ordered by reference dependency: referenced tables
// come first.
// - tools: quick actions and reminders. {id, preset, params?} expand into preset copies per D-259,
// identical to user-added ones; quick actions not in presets are written fully as {id, kind:
// "quickAction", name, icon?, steps}; reminders are written fully as {kind: "reminder", …}.
// - main: sample main page. entry: nav = place main page in nav bar, if full add quick entry on
// home screen (same as templates, entryOps).
// - home: additional blocks placed on home screen (at the end of home screen).
// - User-facing text is written as { en, zh, fr }, selected by UI language. Theme is unmodified:
// user's chosen appearance remains unchanged.

export const SAMPLE_APPS = [
  'expense-helper',
  'visa-docs',
  'study-helper',
  'shop-orders',
  'baby-growth',
  'business-cards',
  'receipts',
] as const;
export type SampleApp = (typeof SAMPLE_APPS)[number];

interface SampleJson {
  icon: IconValue;
  name: Localized;
  /** Summary: Localized; a one-sentence description of what it contains (displayed in the step 3 onboarding list). */
  summary: Localized;
  ids: Record<string, string>;
  tables: unknown[];
  tools: SampleToolJson[];
  pages: unknown[];
  main: string;
  entry: 'nav';
  home?: unknown[];
}

type SampleToolJson =
  | { id: string; preset: string; params?: Record<string, Record<string, unknown>> }
  | { id: string; kind: 'quickAction'; name: Localized; icon?: string; steps: unknown[] }
  | { id: string; kind: 'reminder'; when: object; [key: string]: unknown };

const isPreset = (tool: SampleToolJson): tool is Extract<SampleToolJson, { preset: string }> =>
  'preset' in tool;
const isReminderJson = (tool: SampleToolJson) => 'kind' in tool && tool.kind === 'reminder';

const SAMPLES: Record<SampleApp, SampleJson> = {
  'expense-helper': expenseHelper as SampleJson,
  'visa-docs': visaDocs as SampleJson,
  'study-helper': studyHelper as SampleJson,
  'shop-orders': shopOrders as SampleJson,
  'baby-growth': babyGrowth as SampleJson,
  'business-cards': businessCards as SampleJson,
  receipts: receipts as SampleJson,
};

/** Configuration limits (WorkspaceConfigSchema in schema.ts; PageSchema blocks). */
const LIMITS = { tables: 20, pages: 20, workflows: MAX_WORKFLOWS, reminders: MAX_REMINDERS };

export type SampleProblem = 'tables' | 'pages' | 'workflows' | 'reminders' | 'home';

export type SampleResult =
  | {
      ok: true;
      ops: Op[];
      /** Main page ID of the sample after application: returns here after applying. */
      mainPageId: string;
    }
  | { ok: false; problem: SampleProblem; message: string };

/** Displayed in the step 3 onboarding list: icon, name, one-sentence description. */
export function sampleInfo(
  sample: SampleApp,
  locale: Locale,
): { id: SampleApp; icon: IconValue; name: string; summary: string } {
  const json = SAMPLES[sample];
  return {
    id: sample,
    icon: json.icon,
    name: localize(json.name, locale),
    summary: localize(json.summary, locale),
  };
}

const PLACEHOLDER = /^(page:|tool:)?(\$(?:table|page|tool)\.[a-zA-Z0-9]+)$/;

const isLocalized = (v: object) => {
  const keys = Object.keys(v).sort();
  return keys.length === 3 && keys.join() === 'en,fr,zh';
};

/** Replace placeholders and select text by language (template fill plus page: / tool: prefix). Placeholders not replaced by IDs indicate a sample authoring error. */
function fill(value: unknown, locale: Locale, ids: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') {
    const m = PLACEHOLDER.exec(value);
    if (!m) return value;
    const id = ids.get(m[2]!);
    if (id === undefined) throw new Error(`sample placeholder ${m[2]} has no id`);
    return `${m[1] ?? ''}${id}`;
  }
  if (Array.isArray(value)) return value.map((v) => fill(v, locale, ids));
  if (typeof value === 'object' && value !== null) {
    if (isLocalized(value)) return localize(value as Localized, locale);
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, fill(v, locale, ids)] as const),
    );
  }
  return value;
}

function uniqueId(base: string, taken: Set<string>): string {
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

/**
 * Convert a sample into a set of modification operations: remap to unique IDs against current
 * config, update references accordingly, and provide an entry point for the main page. If tables,
 * pages, quick actions, reminders, or home slots overflow, application is aborted and a reason
 * (user-facing sentence) is returned. appId: executed within this app (D-485): leaves home screen
 * bottom bar and home screen untouched; main page is placed in this app's bottom bar by
 * prepareOps (addMissingPageEntries); pages, tables, and quick actions belonging to this app are
 * written by the caller (opsForApp).
 */
export function sampleOps(
  sample: SampleApp,
  config: WorkspaceConfig,
  locale: Locale,
  appId?: string,
): SampleResult {
  const json = SAMPLES[sample];
  const name = localize(json.name, locale);
  const pages = config.containers.pages;
  const home = appId === undefined ? pages.find((p) => p.id === HOME_PAGE_ID) : undefined;
  const homeCount =
    appId === undefined ? (json.home?.length ?? 0) + (config.nav.bar.length < 5 ? 0 : 1) : 0;
  const sampleReminders = json.tools.filter(isReminderJson) as unknown as Reminder[];
  const byEntry = (list: readonly Reminder[]) => list.filter((r) => 'each' in r.when).length;
  const reminders = remindersOf(config);
  const tooMany = (
    [
      ['tables', config.data.tables.length + json.tables.length > LIMITS.tables],
      ['pages', pages.length + json.pages.length > LIMITS.pages],
      [
        'workflows',
        quickActionsOf(config).length + json.tools.length - sampleReminders.length >
          LIMITS.workflows,
      ],
      [
        'reminders',
        reminders.length - byEntry(reminders) + sampleReminders.length - byEntry(sampleReminders) >
          LIMITS.reminders || byEntry(reminders) + byEntry(sampleReminders) > MAX_RECORD_REMINDERS,
      ],
      ['home', homeCount > 0 && (!home || home.blocks.length + homeCount > MAX_PAGE_BLOCKS)],
    ] as const
  ).find(([, over]) => over);
  if (tooMany) {
    const problem = tooMany[0];
    return { ok: false, problem, message: t(locale, SAMPLE_PROBLEM_MESSAGES[problem], { name }) };
  }

  // Determine all IDs first before filling in contents (buttons and reminders may reference subsequent pages and quick actions).
  const ids = new Map<string, string>();
  const tables = new Set(config.data.tables.map((c) => c.id));
  const pageIds = new Set(pages.map((p) => p.id));
  for (const [placeholder, base] of Object.entries(json.ids)) {
    if (placeholder.startsWith('$table.')) ids.set(placeholder, uniqueId(base, tables));
    else if (placeholder.startsWith('$page.')) ids.set(placeholder, uniqueId(base, pageIds));
  }
  // Tools (quick actions and reminders share an ID set): quick actions are assigned first (their
  // IDs are referenced more heavily by run logs, M1). Preset IDs match user-added ones (preset IDs,
  // append -2 if taken, newWorkflowId); custom ones also avoid name collisions with built-in quick
  // action preset IDs to prevent overriding built-in ones (D-236).
  const taken: { id: string }[] = [...config.tools];
  for (const tool of json.tools) {
    if (isReminderJson(tool)) continue;
    const base = isPreset(tool) ? tool.preset : (json.ids[tool.id] ?? 'workflow');
    const id = newWorkflowId(
      base,
      isPreset(tool) || !presetById(base) ? taken : [...taken, { id: base }],
    );
    taken.push({ id });
    ids.set(tool.id, id);
  }
  const takenIds = new Set(taken.map((x) => x.id));
  for (const tool of json.tools)
    if (isReminderJson(tool)) ids.set(tool.id, uniqueId(json.ids[tool.id] ?? 'reminder', takenIds));

  const ops: Op[] = [];
  for (const table of json.tables)
    ops.push({ op: 'addData', table: fill(table, locale, ids) as OpOf<'addData'>['table'] });

  // Presets expanded per D-259: uses the same function as user additions (presetWorkflow), merging params into parameters by step ID.
  for (const tool of json.tools) {
    if (isReminderJson(tool)) continue;
    let quickAction: QuickAction;
    if (isPreset(tool)) {
      const preset = presetById(tool.preset);
      if (!preset) throw new Error(`sample ${sample}: unknown preset ${tool.preset}`);
      quickAction = presetWorkflow(preset, locale, ids.get(tool.id)!);
      for (const [stepId, params] of Object.entries(tool.params ?? {})) {
        const step = quickAction.steps.find((x) => x.id === stepId);
        if (!step) throw new Error(`sample ${sample}: preset ${tool.preset} has no step ${stepId}`);
        step.params = { ...step.params, ...(fill(params, locale, ids) as object) };
      }
    } else quickAction = fill(tool, locale, ids) as QuickAction;
    ops.push({ op: 'addTool', tool: quickAction });
  }

  for (const page of json.pages)
    ops.push({ op: 'addContainer', page: fill(page, locale, ids) as AddPage['page'] });

  const mainPageId = ids.get(json.main)!;
  const main = ops.find(
    (op): op is AddPage => op.op === 'addContainer' && isNewPage(op) && op.page.id === mainPageId,
  )!;
  if (appId === undefined)
    ops.push(...entryOps(config, mainPageId, main.page.title, main.page.icon));

  if (json.home?.length && home) {
    const used = new Set([
      ...allComponents(home).map((c) => c.id),
      ...ops.flatMap((op) =>
        op.op === 'addContainer' && op.page === HOME_PAGE_ID && op.block ? [op.block.id] : [],
      ),
    ]);
    for (const block of json.home) {
      const filled = fill(block, locale, ids) as NonNullable<OpOf<'addContainer'>['block']>;
      ops.push({
        op: 'addContainer',
        page: HOME_PAGE_ID,
        block: { ...filled, id: uniqueId(filled.id, used) } as typeof filled,
      });
    }
  }

  for (const tool of json.tools)
    if (isReminderJson(tool))
      ops.push({ op: 'addTool', tool: fill(tool, locale, ids) as Reminder });

  return { ok: true, ops, mainPageId };
}

/**
 * When 'shopping voucher' is selected in the new form page and neither fields nor table name were
 * modified, build the full 'Receipts' sample template (D-479): single table with views for
 * search, time, sorting, category filtering, expense chart, scanning, and export. Returns
 * modifications and the created table (ID remapped to current config, records placed here). If
 * fields or table name were modified, another preset was selected, or sample overflows limits
 * (tables, pages, quick actions exceeded): returns null, building via default preset pages
 * instead.
 */
export function draftReceiptSample(
  table: Collection,
  preset: NewPreset,
  config: WorkspaceConfig,
  locale: Locale,
): { ops: Op[]; table: Collection } | null {
  if (preset !== 'purchase') return null;
  const base = draftTable('purchase', config, locale);
  const same =
    table.fields.length === base.fields.length &&
    base.fields.every((f, i) => table.fields[i]?.id === f.id && table.fields[i]?.name === f.name);
  const names = [templateTableName('purchase', locale), sampleInfo('receipts', locale).name];
  if (!same || !names.includes(table.name)) return null;
  const result = sampleOps('receipts', config, locale);
  if (!result.ok) return null;
  const added = result.ops.find((op): op is OpOf<'addData'> => op.op === 'addData');
  if (!added || !('table' in added)) return null;
  // Currency of amount follows the draft (D-548: determined by symbol on the file when creating a table from a file).
  const currency = new Map(
    table.fields.flatMap((f) => (f.type === 'money' ? [[f.id, f.currency] as const] : [])),
  );
  const sampleTable = added.table as unknown as Collection;
  const made: Collection = {
    ...sampleTable,
    fields: sampleTable.fields.map((f) =>
      f.type === 'money' && currency.has(f.id) ? { ...f, currency: currency.get(f.id)! } : f,
    ),
  };
  const ops = result.ops.map((op) => (op === added ? ({ ...added, table: made } as Op) : op));
  return { ops, table: made };
}

type AddPage = OpOf<'addContainer'> & {
  page: Exclude<NonNullable<OpOf<'addContainer'>['page']>, string>;
};
const isNewPage = (op: OpOf<'addContainer'>): op is AddPage =>
  typeof op.page === 'object' && op.page !== null;

const SAMPLE_PROBLEM_MESSAGES = {
  tables: 'sampleTooManyTables',
  pages: 'sampleTooManyPages',
  workflows: 'sampleTooManyWorkflows',
  reminders: 'sampleTooManyReminders',
  home: 'sampleHomeFull',
} as const;
