import { z } from 'zod';

import { DrawnIconsPatchSchema } from './drawn-icons';
import { THEME_PRESET_IDS } from './presets';
import {
  AppBarTargetSchema,
  BackdropPatchSchema,
  CollectionSchema,
  ComponentSchema,
  ComponentStyleSchema,
  FieldSchema,
  FONT_CHOICES,
  HomeScreenEntrySchema,
  HexColorSchema,
  IconValueSchema,
  ShowIfSchema,
  IdSchema,
  NavTargetSchema,
  PageSchema,
  PinSchema,
  QuickActionSchema,
  ReminderSchema,
  ThemeCardSchema,
  ThemeSchema,
  WorkflowStepSchema,
  boundedText,
} from './schema';

// Semantic modification operations (§7D), 14 in total in v34 (D-371): 4 data, 4 container, 4 tool,
// theme, and pack. AI can only output these operations; applyOps (ops.ts) is a pure function that
// does not mutate inputs, handling execution and reference checks only, while full validity is
// determined by validateWorkspace. Each operation has a structure (differentiated by op),
// variations of the same operation are detailed in refine, and error messages are sent to the AI.

/** null indicates reverting to default / removing. */
const resettable = <T extends z.ZodType>(schema: T) => schema.nullable().optional();
const index = z.number().int().min(0);
/** Merged patch: keys with null values are removed. */
const patch = z.record(z.string(), z.unknown());

const ColorOverridesSchema = z.strictObject({
  background: resettable(HexColorSchema),
  surface: resettable(HexColorSchema),
  text: resettable(HexColorSchema),
  surfaceText: resettable(HexColorSchema),
  secondary: resettable(HexColorSchema),
  tertiary: resettable(HexColorSchema),
});

/** Block modifications (changes in updateContainer): style, show, and source are merged (null removes an item), while tools and opens are replaced entirely. */
export const BlockChangesSchema = z.strictObject({
  style: z
    .strictObject({
      align: resettable(ComponentStyleSchema.shape.align.unwrap()),
      tone: resettable(ComponentStyleSchema.shape.tone.unwrap()),
      size: resettable(ComponentStyleSchema.shape.size.unwrap()),
      /** Image background (D-258): write only modified fields, merged into existing ones; null disables it. */
      backdrop: resettable(BackdropPatchSchema),
    })
    .optional(),
  hidden: z.boolean().optional(),
  /** Replaced entirely; null removes it (D-424). */
  showIf: ShowIfSchema.nullable().optional(),
  /** null unpins it, returning to the center. */
  pin: PinSchema.nullable().optional(),
  show: patch.optional(),
  source: patch.optional(),
  /** Replaced entirely; null removes all tools on the block. */
  tools: z.array(z.unknown()).nullable().optional(),
  /** Replaced entirely; null removes it. */
  opens: z.unknown().optional(),
});
export type BlockChanges = z.infer<typeof BlockChangesSchema>;

/** Page modifications: name, icon (null removes), background image (merged into existing; null disables). */
export const PageChangesSchema = z.strictObject({
  title: z.string().optional(),
  icon: IconValueSchema.nullable().optional(),
  backdrop: BackdropPatchSchema.nullable().optional(),
});

export const NavChangesSchema = z.strictObject({
  bar: z.array(NavTargetSchema).min(1).max(5).optional(),
  floating: z.array(NavTargetSchema).max(3).optional(),
  /** Entire list (≤4, D-271); [] means none. */
  phoneHomeScreen: z.array(HomeScreenEntrySchema).optional(),
});

export const NewAppSchema = z.strictObject({
  id: IdSchema,
  name: boundedText(1, 40),
  icon: IconValueSchema.optional(),
  bar: z.array(AppBarTargetSchema).min(1).max(5).optional(),
  /** Copied from home page style when omitted; imported app files carry their own style (D-485). */
  theme: ThemeSchema.optional(),
});
export const AppChangesSchema = z.strictObject({
  id: IdSchema,
  name: boundedText(1, 40).optional(),
  icon: IconValueSchema.nullable().optional(),
  bar: z.array(AppBarTargetSchema).min(1).max(5).optional(),
});

const deskSlot = z.enum(['above', 'below']);

export const OpSchema = z.discriminatedUnion('op', [
  // ---- Data (features): structural changes only, never touching record content ----
  /** {table: a new table} or {table: table ID, field: new field, index?}. */
  z
    .strictObject({
      op: z.literal('addData'),
      table: z.union([IdSchema, CollectionSchema]),
      field: FieldSchema.optional(),
      index: index.optional(),
    })
    .refine((o) => (typeof o.table === 'string') === (o.field !== undefined), {
      message:
        'addData takes {table: {id, name, fields}} for a new table, or {table: "<table id>", field} for a new field',
    }),
  /**
   * {table, changes: {name?, icon?}}, {table, field, changes} (merged into field definition; null
   * removes; type can only be changed between compatible types), or {calendar: {dayStartHour?,
   * weekStart?, twoWeekStart?}} (null restores default).
   */
  z
    .strictObject({
      op: z.literal('updateData'),
      table: IdSchema.optional(),
      field: IdSchema.optional(),
      changes: patch.optional(),
      calendar: z
        .strictObject({
          dayStartHour: resettable(z.number().int()),
          weekStart: resettable(z.enum(['monday', 'sunday'])),
          twoWeekStart: resettable(z.string()),
        })
        .optional(),
    })
    .refine(
      (o) =>
        o.calendar !== undefined
          ? o.table === undefined && o.field === undefined && o.changes === undefined
          : o.table !== undefined && o.changes !== undefined,
      { message: 'updateData takes {table, field?, changes} or {calendar: {…}}' },
    ),
  /** Remove field: old values in records are retained; remove from table: records are retained and can be exported in "Settings -> Data" or permanently deleted by the user. */
  z.strictObject({ op: z.literal('removeData'), table: IdSchema, field: IdSchema.optional() }),
  z.strictObject({ op: z.literal('moveData'), table: IdSchema, field: IdSchema, toIndex: index }),

  // ---- Containers (appearance; inline one-tap logging tools are added, modified, and deleted along with blocks) ----
  /** {page: a new page}, {page: page ID, block, parent?, index?} or {desk: "above" | "below", block, index?}. */
  z
    .strictObject({
      op: z.literal('addContainer'),
      page: z.union([IdSchema, PageSchema.omit({ package: true })]).optional(),
      desk: deskSlot.optional(),
      /** New app (D-485): theme copied from current home page theme; bar defaults to Tink only. Pages and tables must be added using the app field. */
      app: NewAppSchema.optional(),
      block: ComponentSchema.optional(),
      /** Join a group; added to the page top-level when omitted. */
      parent: IdSchema.optional(),
      index: index.optional(),
    })
    .refine(
      (o) =>
        o.app !== undefined
          ? o.page === undefined &&
            o.desk === undefined &&
            o.block === undefined &&
            o.parent === undefined &&
            o.index === undefined
          : o.desk !== undefined
            ? o.page === undefined && o.block !== undefined && o.parent === undefined
            : typeof o.page === 'string'
              ? o.block !== undefined
              : o.page !== undefined &&
                o.block === undefined &&
                o.parent === undefined &&
                o.index === undefined,
      {
        message:
          'addContainer takes {app: {id, name, icon?, bar?}} for a new app, {page: {id, title, blocks}} for a new page, {page: "<page id>", block, parent?, index?} or {desk: "above"|"below", block}',
      },
    ),
  /**
   * {page, changes: {title?, icon?, backdrop?}}, {page, block, changes: {style?, hidden?, show?,
   * source?, tools?, opens?}}, {nav: {bar?, floating?, phoneHomeScreen?}}, or {desk: {toolbar?,
   * preview?, strip?, tools?}}.
   */
  z
    .strictObject({
      op: z.literal('updateContainer'),
      page: IdSchema.optional(),
      block: IdSchema.optional(),
      changes: z.union([BlockChangesSchema, PageChangesSchema]).optional(),
      nav: NavChangesSchema.optional(),
      /** Change an app's name, icon, or bottom bar (D-485); use setTheme {app} for style. */
      app: AppChangesSchema.optional(),
      desk: patch.optional(),
    })
    .refine(
      (o) =>
        o.app !== undefined
          ? o.page === undefined &&
            o.block === undefined &&
            o.changes === undefined &&
            o.nav === undefined &&
            o.desk === undefined
          : o.nav !== undefined
            ? o.page === undefined && o.desk === undefined && o.changes === undefined
            : o.desk !== undefined
              ? o.page === undefined && o.changes === undefined
              : o.page !== undefined && o.changes !== undefined,
      {
        message:
          'updateContainer takes {page, block?, changes}, {app: {id, name?, icon?, bar?}}, {nav: {bar?, floating?, phoneHomeScreen?}} or {desk: {…}}',
      },
    ),
  z
    .strictObject({
      op: z.literal('removeContainer'),
      page: IdSchema.optional(),
      desk: deskSlot.optional(),
      /** Remove an app (D-485): its pages and quick actions are removed together, and tables and records are moved to the home page. */
      app: IdSchema.optional(),
      block: IdSchema.optional(),
    })
    .refine(
      (o) =>
        o.app !== undefined
          ? o.page === undefined && o.desk === undefined && o.block === undefined
          : o.desk !== undefined
            ? o.page === undefined && !!o.block
            : !!o.page,
      {
        message: 'removeContainer takes {app}, {page, block?} or {desk: "above"|"below", block}',
      },
    ),
  z.strictObject({
    op: z.literal('moveContainer'),
    page: IdSchema,
    block: IdSchema,
    toIndex: index,
    /** Move into a specific group; when omitted, moves to the top level of the page. */
    parent: IdSchema.optional(),
  }),

  // ---- Tools (features): quick actions, reminders ----
  /**
   * {tool: a new quick action or reminder} (neither can belong to a tool package, and reminders
   * do not come from presets; place on the phone home screen using updateContainer {nav}), or
   * {tool: quick action ID, step, index?} (inserted before the specified step; omitted = end).
   */
  z
    .strictObject({
      op: z.literal('addTool'),
      tool: z.union([
        IdSchema,
        QuickActionSchema.omit({ package: true }),
        ReminderSchema.omit({ package: true, preset: true }),
      ]),
      step: WorkflowStepSchema.optional(),
      index: index.optional(),
    })
    .refine((o) => (typeof o.tool === 'string') === (o.step !== undefined), {
      message:
        'addTool takes {tool: {kind: "quickAction"|"reminder", …}} for a new tool, or {tool: "<quick action id>", step, index?}',
    }),
  /**
   * {tool, changes}: quick action {name?, icon?, steps?} (replace all steps: save quick action
   * edit page, restore presets), merge reminders (null removes optional keys); {tool, step,
   * changes: {params? (merged), ask? (replace entirely, [] for no questions)}}.
   */
  z.strictObject({
    op: z.literal('updateTool'),
    tool: IdSchema,
    step: IdSchema.optional(),
    changes: patch,
  }),
  /** Delete a user's own quick action (along with blocks running or opening it) or reminder, or a step of a quick action. Built-in tool package items cannot be deleted. */
  z.strictObject({ op: z.literal('removeTool'), tool: IdSchema, step: IdSchema.optional() }),
  z.strictObject({ op: z.literal('moveTool'), tool: IdSchema, step: IdSchema, toIndex: index }),

  // ---- Theme (appearance) ----
  /** {preset}, {reset: true}, or a patch (specifying only modified properties). */
  z
    .strictObject({
      op: z.literal('setTheme'),
      /** Change the style of this app; defaults to the home page if omitted (D-485). */
      app: IdSchema.optional(),
      preset: z.enum(THEME_PRESET_IDS).optional(),
      reset: z.literal(true).optional(),
      primaryColor: HexColorSchema.optional(),
      mode: ThemeSchema.shape.mode.optional(),
      colors: ColorOverridesSchema.optional(),
      darkColors: ColorOverridesSchema.optional(),
      font: z.enum(FONT_CHOICES).optional(),
      fontScale: ThemeSchema.shape.fontScale.optional(),
      radius: ThemeSchema.shape.radius.optional(),
      density: ThemeSchema.shape.density.optional(),
      cardStyle: ThemeSchema.shape.cardStyle.optional(),
      /**
       * Card border and shadow (D-624); null removes it. Removing cardStyle when card is absent
       * also removes it; selecting a card style applies that style.
       */
      card: ThemeCardSchema.nullable().optional(),
      navStyle: ThemeSchema.shape.navStyle.optional(),
      backdrop: ThemeSchema.shape.backdrop,
      iconStyle: ThemeSchema.shape.iconStyle,
      /**
       * Icon library (D-625): specified icons are added or replaced, null removes them. Applies
       * workspace-wide regardless of whether an app is specified; preset and reset operations do
       * not affect it.
       */
      icons: DrawnIconsPatchSchema.optional(),
    })
    .refine(
      (o) => {
        const keys = Object.keys(o).filter((k) => k !== 'op' && k !== 'app');
        return o.preset !== undefined || o.reset ? keys.length === 1 : keys.length > 0;
      },
      { message: 'setTheme takes {preset}, {reset: true} or the theme keys to change' },
    ),

  // ---- Tool packages (features; called "Tools" in the UI) ----
  /** add creates the tool package page and its quick actions; remove deletes them together; update upgrades to the current version while preserving user modifications. */
  z.strictObject({
    op: z.literal('setPackage'),
    package: IdSchema,
    do: z.enum(['add', 'remove', 'update']),
  }),
]);
export type Op = z.infer<typeof OpSchema>;
export type OpOf<K extends Op['op']> = Extract<Op, { op: K }>;
/** Maximum number of operations allowed per change (version). */
export const MAX_OPS_PER_CHANGE = 30;
export const OpListSchema = z.array(OpSchema).min(1).max(MAX_OPS_PER_CHANGE);
/**
 * Operations for importing and restoring an App file (D-554): unlimited steps, size governed by
 * configuration limits (number of tables, pages, quick actions, and reminders), processed as a
 * single version with full validation. Restricted to App files; AI plans and other modifications
 * use OpListSchema.
 */
export const AppFileOpListSchema = z.array(OpSchema).min(1);

/** Features (data, standalone tools, tool packages, phone home screen) and appearance (containers, local tools, theme, navigation bar) are processed in two rounds (Rule 26). */
export function isFunctionOp(op: Op): boolean {
  switch (op.op) {
    case 'addData':
    case 'updateData':
    case 'removeData':
    case 'moveData':
    case 'addTool':
    case 'updateTool':
    case 'removeTool':
    case 'moveTool':
    case 'setPackage':
      return true;
    case 'addContainer':
    case 'removeContainer':
      // Creating or removing an app is a feature operation (tables and quick actions must point to it); its pages, bottom bar, and style are appearance operations.
      return op.app !== undefined;
    case 'updateContainer':
      if (op.app !== undefined) return op.app.bar === undefined;
      return op.nav?.phoneHomeScreen !== undefined;
    default:
      return false;
  }
}
