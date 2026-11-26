import { z } from 'zod';

import { ComponentSchema, componentRefs, isKnownComponent, type Component } from './components';
import { DeskLayoutSchema } from './desk/layout';
import { DrawnIconsSchema } from './drawn-icons';
import { RecordToolSchema } from './record-ops-schema';
import {
  BackdropSchema,
  CalendarSchema,
  CollectionSchema,
  IconValueSchema,
  IdSchema,
  NavSchema,
  ThemeSchema,
  boundedText,
  openTargetSchema,
  type OpenTarget,
} from './schema-base';
import { ConditionSchema, FieldRefSchema } from './schema-primitives';

// The sole definition of the mutable layer (handoff doc §5.2): v34 "Data . Containers . Tools"
// (D-368, established by the founder on 2026-10-30). `data` (table schemas, date settings),
// `containers` (pages -> blocks, file room layout) and `nav` (navigation bar, floating entry
// points, phone home screen menu), `tools` (quick actions, reminders), `packages` (called "tools"
// in the UI), and `theme`. Block appearances are defined in `components/` (one file per type, see
// `docs/COMPONENTS.md`), fields in `fields/`, and the rest in `schema-base.ts`. When modifying
// existing structures (including adding keys to existing appearances), `CURRENT_SCHEMA_VERSION`
// must be incremented and a migration added in `migrate.ts`; adding only a new appearance does not
// require incrementing it (D-254: legacy configs can still be read, and old apps retain new
// appearances as-is).

export const CURRENT_SCHEMA_VERSION = 41;

export * from './schema-base';
export {
  BACKDROP_TYPES,
  COMPONENTS,
  ComponentSchema,
  ComponentStyleSchema,
  EntryLookSchema,
  GROUP_MAX_CHILDREN,
  RECORD_LOOKS,
  RECORD_LOOK_DOC,
  ShowIfSchema,
  PinSchema,
  UNKNOWN_LOOK,
  BUTTON_SHAPES,
  CatalogSourceSchema,
  catalogOf,
  blockEdit,
  buttonEdit,
  buttonKind,
  buttonShape,
  componentDefinition,
  componentRefs,
  isChoiceTabs,
  isKnownComponent,
  isTimeTabs,
  type ButtonKind,
  type ButtonShape,
  type CatalogSource,
  type ChoiceTabs,
  type TabsBlock,
  type TimeTabs,
  type BlockOf,
  type Component,
  type ComponentAI,
  type ComponentDefinition,
  type ComponentEdit,
  type ComponentOf,
  type ComponentRef,
  type ComponentStyle,
  type ComponentType,
  type EditableText,
  type EntryLook,
  type GroupComponent,
  type InnerGroupComponent,
  type KnownComponent,
  type LeafComponent,
  type Look,
  type NewComponent,
  type RecordLook,
  type ShowIf,
  type StyleKey,
  type UnknownComponent,
} from './components';

// ---- Containers: Pages ----

/** Maximum number of top-level blocks per page. */
export const MAX_PAGE_BLOCKS = 30;
/** Total number of pages and tables (shared across all apps, D-485, previously 20 each). */
export const MAX_PAGES = 60;
export const MAX_TABLES = 40;

export const PageSchema = z.strictObject({
  id: IdSchema,
  title: boundedText(1, 40),
  /** Which app it belongs to (D-485); defaults to the home page when omitted. */
  app: IdSchema.optional(),
  /** Icon displayed in the navigation bar. */
  icon: IconValueSchema.optional(),
  /** Page created by a tool package (formerly `toolId`); removed together when the tool package is removed. */
  package: IdSchema.optional(),
  /** Background image for the entire page (D-258, schemaVersion 18), with blocks floating on top. */
  backdrop: BackdropSchema.optional(),
  /**
   * Page dedicated to a single record of a table (D-342, formerly `recordOf`): opened by tapping
   * an entry in a record block (`opens`) of that table, where "$record" refers to that record.
   * Cannot be placed in the navigation bar, nor opened directly from buttons, entry points, or
   * reminders.
   */
  of: IdSchema.optional(),
  blocks: z.array(ComponentSchema).max(MAX_PAGE_BLOCKS),
});
/** Page; blocks may contain types unrecognized by this version (D-254, see `UnknownComponent`). */
export type Page = Omit<z.infer<typeof PageSchema>, 'blocks'> & { blocks: Component[] };

export const ContainersSchema = z.strictObject({
  pages: z.array(PageSchema).min(1).max(MAX_PAGES),
  /** File room layout (D-358); defaults to the standard layout when absent (preview centered, toolbar at the bottom). AI modifications and other R3 features (Q7). */
  desk: DeskLayoutSchema.optional(),
});

// ---- Tool Packages (called "Tools" in UI) ----

/** Added tool packages (formerly `InstalledTool {toolId, version, pageId}`). */
export const PackageSchema = z.strictObject({
  id: IdSchema,
  version: z.string().min(1),
  page: IdSchema,
});
export type InstalledPackage = z.infer<typeof PackageSchema>;
/** v33 name. */
export type InstalledTool = InstalledPackage;

// ---- Tools: Quick Actions, Reminders ----

export const ActionIdSchema = z.string().regex(/^[a-z]+\.[a-zA-Z0-9]+$/, 'invalid action id');

export const WorkflowStepSchema = z.strictObject({
  id: IdSchema,
  action: ActionIdSchema,
  params: z.record(z.string(), z.unknown()),
  /** Parameters asked of the user upon each run (keys must match parameters in the action's UI metadata). */
  ask: z.array(z.string().min(1).max(40)).max(10).optional(),
});
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;

/** Maximum number of steps in a quick action. */
export const MAX_WORKFLOW_STEPS = 12;

/** Upper limit on total quick actions: around 40 single-function quick actions when all tool packages are installed, plus user-defined ones. */
export const MAX_WORKFLOWS = 100;

/** Maximum number of quick actions in the menu when long-pressing the Morph icon on the mobile home screen (D-271): iOS displays only 4, and Android follows suit. */
export const MAX_HOME_SCREEN = 4;

/**
 * Quick action: a linear sequence of steps passing a typed value between them (§7C, D-060,
 * non-Turing-complete; relation rule 13: tools cannot trigger tools, only linear steps here can
 * be chained). `package`: created when adding a tool package and removed together with it
 * (formerly `toolId`); `preset`: the preset copied from (D-062, D-236, formerly `presetId`).
 * Placed on the mobile home screen via `nav.phoneHomeScreen` (D-271).
 */
export const QuickActionSchema = z.strictObject({
  id: IdSchema,
  kind: z.literal('quickAction'),
  name: boundedText(1, 40),
  /** Which app it belongs to (D-485); defaults to the home page when omitted. */
  app: IdSchema.optional(),
  icon: IconValueSchema.optional(),
  package: IdSchema.optional(),
  preset: IdSchema.optional(),
  steps: z.array(WorkflowStepSchema).min(1).max(MAX_WORKFLOW_STEPS),
});
export type QuickAction = z.infer<typeof QuickActionSchema>;
/** v33 name (same thing). */
export type Workflow = QuickAction;

/** Time of day in `HH:mm` format (device local time). */
export const TimeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'time like 09:00');

/** Where to open when tapping a reminder: a page, a system entry point, or a quick action (opened only, not executed, D-251). */
export type ReminderTarget = OpenTarget;
export const ReminderTargetSchema = openTargetSchema(
  'opens must be a page, a system entry or tool:<id>',
  ['tool'],
);

const tableField = z.strictObject({ table: IdSchema, field: IdSchema });

/**
 * When a reminder rings: `every` day / week (`days`: 1 = Monday ... 7 = Sunday) / month (`day`:
 * day of the month, 1-28, D-577) at `at` time; `before` rings at `at` time `days` days before a
 * date field in a table expires (once per record, formerly `dateField`); `each` schedules
 * reminders individually for each record based on a schedule field in a table (D-316, formerly
 * `scheduleField`); `after` reminds `minutes` minutes after each record is added to a table
 * (D-391); `before` + `minutes` reminds `minutes` minutes before the exact moment of a datetime
 * field (D-562, up to 7 days).
 */
/** Maximum advance time for reminding minutes before a datetime (D-562): 7 days. */
export const MAX_BEFORE_MINUTES = 7 * 24 * 60;

export const ReminderWhenSchema = z.union([
  z.strictObject({ every: z.literal('day'), at: TimeOfDaySchema }),
  z.strictObject({
    every: z.literal('week'),
    days: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    at: TimeOfDaySchema,
  }),
  z.strictObject({
    before: tableField,
    days: z.number().int().min(0).max(30),
    at: TimeOfDaySchema,
  }),
  z.strictObject({ each: tableField, at: TimeOfDaySchema }),
  z.strictObject({
    after: z.strictObject({ table: IdSchema }),
    minutes: z.number().int().min(1).max(1440),
  }),
  z.strictObject({ before: tableField, minutes: z.number().int().min(1).max(MAX_BEFORE_MINUTES) }),
  // D-577: Day `day` of every month (1-28, ensuring valid days across all months).
  z.strictObject({
    every: z.literal('month'),
    day: z.number().int().min(1).max(28),
    at: TimeOfDaySchema,
  }),
]);
export type ReminderWhen = z.infer<typeof ReminderWhenSchema>;

/**
 * Reminder (D-251): local notification, no push, no server needed. Time-triggered, tapping the
 * notification only opens opens, never runs anything (relation rules 13, 14: cannot hook up
 * actions that export data out of the app). title is the notification title (text in config,
 * visible to AI); the reminder body based on the record is generated locally from the record
 * (record content does not enter config and is not sent to AI).
 */
export const ReminderSchema = z.strictObject({
  id: IdSchema,
  kind: z.literal('reminder'),
  /** Which app it belongs to (D-485); defaults to the home page when omitted. */
  app: IdSchema.optional(),
  package: IdSchema.optional(),
  preset: IdSchema.optional(),
  title: boundedText(1, 60),
  enabled: z.boolean(),
  when: ReminderWhenSchema,
  opens: ReminderTargetSchema,
  /** each only (D-318): the "Complete" button on the notification is a one-touch record tool (writes records only) acting on this record ($row). */
  done: RecordToolSchema.optional(),
  /** each only (D-318): the "Snooze" button on the notification, reminds again in a few minutes. */
  snoozeMinutes: z.number().int().min(5).max(240).optional(),
  /**
   * unless only (D-317): do not remind if the table already has a record matching the filter on
   * that day / in that week / in that month. Days are based on date (creation time if omitted);
   * when it is the same table, check only this record itself; when link is a reference field in
   * that table pointing to this table, check only records pointing to this record.
   */
  unless: z
    .strictObject({
      table: IdSchema,
      within: z.enum(['day', 'week', 'month']),
      filter: z.array(ConditionSchema).max(5).optional(),
      date: FieldRefSchema.optional(),
      link: IdSchema.optional(),
    })
    .optional(),
});
export type Reminder = z.infer<typeof ReminderSchema>;

/** Maximum number of daily, weekly, and due reminders (D-251). */
export const MAX_REMINDERS = 20;
/** Maximum number of record-based reminders (each), counted separately and not occupying the above 20 slots (D-316). */
export const MAX_RECORD_REMINDERS = 10;

export const isRecordReminder = (r: Reminder) => 'each' in r.when;

/** Independent tools (tools[]): quick actions, reminders. Local one-touch record tools are defined inside blocks (Q1). */
export const ToolSchema = z.discriminatedUnion('kind', [QuickActionSchema, ReminderSchema]);
export type Tool = z.infer<typeof ToolSchema>;

/**
 * Tool registry (v34 "Data, Container, Tool"): where each independent tool acts, what it reads
 * and writes, and how it is triggered. trigger: tap = user action required; time = time-triggered
 * notification (opens only, relation rules 13, 14).
 */
export const TOOL_KINDS = {
  quickAction: { kind: 'tool', layer: 'file', access: 'write', trigger: 'tap', runs: 'steps' },
  reminder: { kind: 'tool', layer: 'table', access: 'read', trigger: 'time', runs: 'opens' },
} as const;

export const ToolsSchema = z
  .array(ToolSchema)
  .refine((list) => list.filter((t) => t.kind === 'quickAction').length <= MAX_WORKFLOWS, {
    message: `at most ${MAX_WORKFLOWS} quick actions`,
  })
  .refine(
    (list) =>
      list.filter((t) => t.kind === 'reminder' && !isRecordReminder(t)).length <= MAX_REMINDERS,
    { message: `at most ${MAX_REMINDERS} daily, weekly or date reminders` },
  )
  .refine(
    (list) =>
      list.filter((t) => t.kind === 'reminder' && isRecordReminder(t)).length <=
      MAX_RECORD_REMINDERS,
    { message: `at most ${MAX_RECORD_REMINDERS} reminders for each entry (when.each)` },
  );

// ---- Data ----

export const DataSchema = z.strictObject({
  /** Data table schema (formerly collections). Record content is not in the config and is never sent to the AI. */
  tables: z.array(CollectionSchema).max(MAX_TABLES),
  /** When a day or week starts (D-286); defaults to midnight and Monday when absent. */
  calendar: CalendarSchema.optional(),
});

export const HOME_PAGE_ID = 'home';
/** New user's toolbox page (D-181). A user page that can be edited or deleted; "Settings -> Tools" always lists all tools. */
export const TOOLBOX_PAGE_ID = 'toolbox';

export const WorkspaceConfigSchema = z.strictObject({
  schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
  theme: ThemeSchema,
  nav: NavSchema,
  data: DataSchema,
  containers: ContainersSchema,
  tools: ToolsSchema,
  packages: z.array(PackageSchema),
  /** Drawn icons (D-625): referenced as "my:<id>". Empty ones are not stored. */
  icons: DrawnIconsSchema.optional(),
});
type ParsedConfig = z.infer<typeof WorkspaceConfigSchema>;
export type WorkspaceConfig = Omit<ParsedConfig, 'containers'> & {
  containers: Omit<ParsedConfig['containers'], 'pages'> & { pages: Page[] };
};

// ---- Config reading helper functions ----

/** Quick actions (quickAction kind in tools[], in original order). */
export const quickActionsOf = (config: Pick<WorkspaceConfig, 'tools'>): QuickAction[] =>
  config.tools.filter((t): t is QuickAction => t.kind === 'quickAction');
/** Reminders (reminder kind in tools[], in original order). */
export const remindersOf = (config: Pick<WorkspaceConfig, 'tools'>): Reminder[] =>
  config.tools.filter((t): t is Reminder => t.kind === 'reminder');
export const tablesOf = (config: Pick<WorkspaceConfig, 'data'>) => config.data.tables;

/** Block child blocks (grouped children; other blocks have none). */
export const childrenOf = (c: Component): Component[] =>
  isKnownComponent(c) && c.look === 'group' ? (c.children as Component[]) : [];

/** All blocks on the page, including child blocks within groups (two levels, depth-first, in display order). */
export function allComponents(page: Page): Component[] {
  const walk = (list: readonly Component[]): Component[] =>
    list.flatMap((c) => [c, ...walk(childrenOf(c))]);
  return walk(page.blocks);
}
export const allBlocks = allComponents;

/** Group containing the block (top-level blocks are null). */
export function parentOf(page: Page, blockId: string): Component | null {
  for (const c of allComponents(page)) if (childrenOf(c).some((x) => x.id === blockId)) return c;
  return null;
}

/**
 * Which tool packs a tool grid displays (D-181): if ids are specified, follow their order;
 * otherwise, display those not listed in any other grid on the same page in the directory.
 * Unlisted tools are hidden.
 */
export function toolGridToolIds(
  grid: { ids?: readonly string[] | undefined },
  page: Page,
  catalog: readonly string[],
): string[] {
  if (grid.ids) return grid.ids.filter((id) => catalog.includes(id));
  const listed = new Set(
    allComponents(page).flatMap((c) =>
      isKnownComponent(c) && c.look === 'catalog' && c.source.catalog === 'packages'
        ? (c.source.ids ?? [])
        : [],
    ),
  );
  return catalog.filter((id) => !listed.has(id));
}

/** Data table read by a data-reading block (defined with refs pointing to a table key; $files is excluded). */
export function componentCollection(c: Component): string | null {
  const id = componentRefs(c, 'table')[0] as string | undefined;
  return id === undefined || id.startsWith('$') ? null : id;
}

/** Target opened by buttons and entry points (opens). */
export function componentTarget(c: Component): OpenTarget | null {
  return (componentRefs(c, 'target')[0] as OpenTarget | undefined) ?? null;
}
