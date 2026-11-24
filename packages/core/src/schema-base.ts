import { z } from 'zod';

import { isDrawnIconRef } from './drawn-icons';
import { isValidDate } from './field-values';
import { FieldSchema } from './fields';
import { isEmoji, unsafeLinks } from './richtext';
import { ConditionSchema, FieldRefSchema, IdSchema, boundedText } from './schema-primitives';

// Non-component parts of the config schema (icons, themes, tables, filters, navigation). Component
// definitions (components/) depend on these, so they are kept in a separate file to prevent
// circular references between schema.ts and component definitions. Exported externally via
// schema.ts.

export * from './schema-primitives';

export const HexColorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'color must be #RRGGBB');

// ---- Icon Whitelist ----

/** Icons available for components, pages, and navigation. The renderer maps each name to iOS / Android system icons. */
export const ICON_NAMES = [
  'home',
  'apps',
  'sparkles',
  'history',
  'settings',
  'document',
  'folder',
  'star',
  'heart',
  'bolt',
  'calendar',
  'bookmark',
  'inbox',
  'chart',
  'check',
  'info',
  'lightbulb',
  'merge',
  'link',
  'person',
  'plus',
  'search',
  'photo',
  'scan',
  'text',
  'qrcode',
  'archive',
  'printer',
  'signature',
  'workflow',
  'video',
  'audio',
  'translate',
  'note',
  'phone',
  'message',
  'mail',
  'globe',
  'share',
  // D-552: Used for "Scan table to Excel", separated from the icon for scanning to PDF / Word.
  'table',
  // Built-in graphic icons (D-485, drawn from presets): rendered using images rather than system icons.
  'wallet',
  'rings',
  'moon',
  'timer',
  'book',
  'board',
  'suitcase',
  'vinyl',
  'paper',
] as const;
/** Icons with built-in graphics (the last items in ICON_NAMES): have no corresponding system icons. */
export const CUSTOM_ICON_NAMES = [
  'wallet',
  'rings',
  'moon',
  'timer',
  'book',
  'board',
  'suitcase',
  'vinyl',
  'paper',
] as const satisfies readonly (typeof ICON_NAMES)[number][];
export type CustomIconName = (typeof CUSTOM_ICON_NAMES)[number];

export const IconSchema = z.enum(ICON_NAMES);
export type IconName = z.infer<typeof IconSchema>;

/** Icon: a whitelisted name, or an emoji (D-046). Used where icon libraries are unavailable (downloaded tools). */
export const ListedIconValueSchema = z.union([
  IconSchema,
  z.string().refine(isEmoji, { message: 'icon must be a listed icon name or a single emoji' }),
]);
/** Icon in config: a whitelisted name, an emoji, or a custom-drawn icon from the icon library `"my:<id>"` (D-625). */
export const IconValueSchema = z.union([
  IconSchema,
  z.string().refine((s) => isEmoji(s) || isDrawnIconRef(s), {
    message: 'icon must be a listed icon name, a single emoji or my:<id> of a drawn icon',
  }),
]);
export type IconValue = IconName | (string & {});

/** User file ID (image components reference user-selected photos). */
export const AssetIdSchema = z.string().regex(/^[a-z0-9]{6,40}$/, 'invalid asset id');

/** Backdrop opacity level for image backgrounds (D-258) (see OVERLAY_OPACITY in theme.ts for opacity values). */
export const OverlayLevelSchema = z.enum(['light', 'medium', 'strong']);

/**
 * Image background (D-258): style.backdrop for card components and page backdrops. The AI can
 * only turn it on (write overlay), turn it off, or adjust the mask opacity; the specific image is
 * chosen by the user in long-press editing, and assetId points to user files just like image
 * components. Falls back to base color when there is no image.
 */
export const BackdropSchema = z.strictObject({
  overlay: OverlayLevelSchema,
  assetId: AssetIdSchema.optional(),
});
export type Backdrop = z.infer<typeof BackdropSchema>;

/** Image background in patch operations: only writes modified fields; removes image when assetId is null (image background remains enabled). */
export const BackdropPatchSchema = z.strictObject({
  overlay: OverlayLevelSchema.optional(),
  assetId: AssetIdSchema.nullable().optional(),
});
export type BackdropPatch = z.infer<typeof BackdropPatchSchema>;

/** Apply a patch: turns on with "medium" opacity if currently disabled. */
export function patchBackdrop(current: Backdrop | undefined, patch: BackdropPatch): Backdrop {
  const next: Backdrop = { ...(current ?? { overlay: 'medium' }) };
  if (patch.overlay) next.overlay = patch.overlay;
  if (patch.assetId === null) delete next.assetId;
  else if (patch.assetId !== undefined) next.assetId = patch.assetId;
  return next;
}

/** Rich text (richtext.ts): links must be https or mailto. */
export const richText = (max: number) =>
  boundedText(1, max).refine((s) => unsafeLinks(s).length === 0, {
    message: 'links must be https:// or mailto: addresses',
  });

// ---- Theme: Whitelisted style tokens ----

export const FONT_CHOICES = ['clay', 'system', 'serif', 'mono', 'inter'] as const;

export const ThemeColorsSchema = z.strictObject({
  background: HexColorSchema.optional(),
  surface: HexColorSchema.optional(),
  text: HexColorSchema.optional(),
  /** Text color on cards (D-409); defaults to `text` when omitted. When specified, `text` only applies to text on the page background. */
  surfaceText: HexColorSchema.optional(),
  secondary: HexColorSchema.optional(),
  tertiary: HexColorSchema.optional(),
});
export type ThemeColors = z.infer<typeof ThemeColorsSchema>;

/**
 * Colors in custom card borders and shadows (D-624): must be roles, cannot be raw color values;
 * resolved from theme colors during rendering, adapting automatically to dark mode. `text` = page
 * text color, `border` / `shadow` = separator line and shadow colors from the palette (same group
 * used by built-in card styles).
 */
export const CARD_COLOR_ROLES = [
  'text',
  'primary',
  'secondary',
  'tertiary',
  'border',
  'shadow',
  'white',
  'black',
] as const;
export type CardColorRole = (typeof CARD_COLOR_ROLES)[number];
/** Maximum number of shadow layers for custom cards. */
export const MAX_CARD_SHADOWS = 3;
export const CARD_BORDER_WIDTH = { min: 0.5, max: 4 } as const;
export const CARD_SHADOW_X = { min: -16, max: 16 } as const;
export const CARD_SHADOW_Y = { min: -16, max: 24 } as const;
export const CARD_SHADOW_BLUR = { min: 0, max: 40 } as const;
export const CARD_OPACITY = { min: 0.05, max: 1 } as const;

const cardOpacity = z.number().min(CARD_OPACITY.min).max(CARD_OPACITY.max);

/**
 * Custom card border and shadow parameters (D-624): overrides cardStyle's own border and shadow
 * when specified, while the background color continues to follow cardStyle (translucent frosted
 * glass, metallic gradient). Light and dark modes use the same parameter set; opacity defaults to
 * 1 when omitted.
 */
export const ThemeCardSchema = z
  .strictObject({
    border: z
      .strictObject({
        width: z.number().min(CARD_BORDER_WIDTH.min).max(CARD_BORDER_WIDTH.max),
        color: z.enum(CARD_COLOR_ROLES),
        opacity: cardOpacity.optional(),
      })
      .optional(),
    shadows: z
      .array(
        z.strictObject({
          x: z.number().min(CARD_SHADOW_X.min).max(CARD_SHADOW_X.max),
          y: z.number().min(CARD_SHADOW_Y.min).max(CARD_SHADOW_Y.max),
          blur: z.number().min(CARD_SHADOW_BLUR.min).max(CARD_SHADOW_BLUR.max),
          color: z.enum(CARD_COLOR_ROLES),
          opacity: cardOpacity.optional(),
          inset: z.literal(true).optional(),
        }),
      )
      .min(1)
      .max(MAX_CARD_SHADOWS)
      .optional(),
  })
  .refine((c) => c.border !== undefined || c.shadows !== undefined, {
    message: 'card needs a border, shadows or both',
  });
export type ThemeCard = z.infer<typeof ThemeCardSchema>;

export const ThemeSchema = z.strictObject({
  primaryColor: HexColorSchema,
  mode: z.enum(['light', 'dark', 'system']),
  /** Overrides the default palette; unconfigured colors use values from the default style (Clay). */
  colors: ThemeColorsSchema,
  /** Color overrides for dark mode; unconfigured colors fall back to colors and then the default dark style values in order. */
  darkColors: ThemeColorsSchema.optional(),
  /** Font family combination: clay = Sora (headings) + Karla (body); inter = Inter (D-591, with medium weight for numbers and major headings). */
  font: z.enum(FONT_CHOICES),
  fontScale: z.number().min(0.85).max(1.3),
  /** Card corner radius (pt); control elements like buttons scale their radii accordingly. */
  radius: z.number().int().min(0).max(28),
  density: z.enum(['compact', 'comfortable', 'spacious']),
  /**
   * brutal = thick borders + hard shadows (neo-brutalism), soft = dual-directional soft shadows
   * (neumorphism), puffy = inner highlights + soft shadows (claymorphism), glass = translucent
   * frosted glass, glow = primary color outer glow (neon), chrome = metallic gradient +
   * highlights (Y2K).
   */
  cardStyle: z.enum([
    'shadow',
    'outline',
    'flat',
    'brutal',
    'soft',
    'puffy',
    'glass',
    'glow',
    'chrome',
  ]),
  /** Custom card border and shadow parameters, overriding cardStyle's border and shadow (D-624). */
  card: ThemeCardSchema.optional(),
  /** Page backdrop: solid color (default), primary-to-secondary gradient, or three-color aurora. Colors are derived from the theme palette and adapt automatically in dark mode. */
  backdrop: z.enum(['plain', 'gradient', 'aurora']).optional(),
  navStyle: z.enum(['iconLabel', 'label', 'icon']),
  /** Icon background style: solid = solid color background with white icon, tint = light background with colored icon; components use their own defaults when omitted (D-230). */
  iconStyle: z.enum(['solid', 'tint']).optional(),
});
export type Theme = z.infer<typeof ThemeSchema>;

// ---- User Data: Table structure (in config, versioned). Records themselves are not in config, see docs/DATA_DESIGN.md ----

export {
  ChoiceOptionSchema,
  FIELDS,
  FieldSchema,
  NUMERIC_FIELD_TYPES,
  fieldDefinition,
  type Field,
  type FieldDefinition,
  type FieldOf,
  type FieldType,
  cleanTags,
  MAX_RECORD_TAGS,
  MAX_TAG_LENGTH,
  tagKey,
  isMultipleChoice,
  pickedOptions,
} from './fields';

/**
 * A button at the top of the record page (D-428): a quick action (first step collects text or
 * records); when collecting text, `field` specifies which field receives the value. Contains only
 * IDs in the config, no values (Invariant 14).
 */
export const RecordRowItemSchema = z.strictObject({ tool: IdSchema, field: IdSchema.optional() });
export type RecordRowItem = z.infer<typeof RecordRowItemSchema>;
/** Maximum number of buttons at the top of the record page. */
export const MAX_RECORD_ROW = 10;

/** Maximum number of sections in a record form (D-570). */
export const MAX_FORM_SECTIONS = 10;

/**
 * A section in a record form (D-570): title, assigned fields, can have 1–3 conditions (using
 * AND), evaluating only fields filled in this record, excluding fields within this section. When
 * conditions are not met, the section is hidden: field values stored within remain unchanged, and
 * validation ignores required checks while hidden.
 */
export const FormSectionSchema = z.strictObject({
  title: boundedText(1, 40).optional(),
  fields: z.array(IdSchema).min(1).max(30),
  when: z.array(ConditionSchema).min(1).max(3).optional(),
});
export type FormSection = z.infer<typeof FormSectionSchema>;

/**
 * Layout of the record form (D-570, founder decision 2026-11-16 ①): contains only sections and
 * conditional visibility; hints and scopes belong on fields. Saving, deletion, attachments, and
 * candidate values remain handled by the core. Fields not assigned to any section are placed
 * after all sections (in table order), ensuring new fields are never lost.
 */
export const EntryFormSchema = z.strictObject({
  sections: z.array(FormSectionSchema).min(1).max(MAX_FORM_SECTIONS),
});
export type EntryForm = z.infer<typeof EntryFormSchema>;

/** Data table (v34 data.tables, formerly collections). */
export const CollectionSchema = z.strictObject({
  id: IdSchema,
  name: boundedText(1, 40),
  /** Which app it belongs to (D-485); defaults to the home page when omitted. */
  app: IdSchema.optional(),
  icon: IconValueSchema.optional(),
  fields: z.array(FieldSchema).min(1).max(30),
  /** Automatically read attachments and provide suggestions in new record forms (D-394, D-397). Enabled by default when omitted; read-only behavior, not a workflow. */
  readAttachments: z.boolean().optional(),
  /** Additional rule groups to apply alongside general rules when reading attachments for suggestions (D-421). Only general rules apply when omitted. */
  prefillRules: z.enum(['receipt', 'card']).optional(),
  /**
   * A row of buttons at the top of existing record pages (D-428). Record pages are provided by
   * the core, one page per table, so this is defined at the table level (like readAttachments).
   * No button row is shown when omitted.
   */
  recordRow: z.array(RecordRowItemSchema).max(MAX_RECORD_ROW).optional(),
  /** Record form sections and conditional visibility (D-570). Defaults to a single section ordered by field sequence when omitted. */
  form: EntryFormSchema.optional(),
});
export type Collection = z.infer<typeof CollectionSchema>;
export type Table = Collection;

/**
 * Start time for days and weeks (D-286, schemaVersion 20): dayStartHour 0–6, weekStart as Monday
 * or Sunday, twoWeekStart as the anchor day for two-week periods. Defaults to 0:00 and Monday
 * when omitted.
 */
export const CalendarSchema = z.strictObject({
  dayStartHour: z.number().int().min(0).max(6).optional(),
  weekStart: z.enum(['monday', 'sunday']).optional(),
  twoWeekStart: z
    .string()
    .refine(isValidDate, { message: 'twoWeekStart must be a date like 2026-10-12' })
    .optional(),
});
export type CalendarSettings = z.infer<typeof CalendarSchema>;

export const SortSchema = z.strictObject({
  field: FieldRefSchema,
  direction: z.enum(['asc', 'desc']),
});
export type Sort = z.infer<typeof SortSchema>;

/** Sorting for record blocks (D-560): a single sort rule, or 1–3 sequential sort rules (primary, then secondary, etc.). A single object works as before. */
export const SortKeysSchema = z.union([SortSchema, z.array(SortSchema).min(1).max(3)]);
export type SortKeys = z.infer<typeof SortKeysSchema>;

/** Converts a single sort or an array of sorts into a uniform list. */
export const sortList = (sort: Sort | readonly Sort[] | undefined): readonly Sort[] =>
  sort === undefined ? [] : Array.isArray(sort) ? sort : [sort as Sort];

// ---- Navigation ----

export const SYSTEM_TARGETS = ['tools', 'ai', 'history', 'settings', 'quickActions'] as const;
export type SystemTarget = (typeof SYSTEM_TARGETS)[number];

/**
 * Protected elements (§5.1): Must always appear in the navigation bar or floating entry point.
 * Only "Settings" is protected: the settings page is fixed by the kernel to provide "AI modify"
 * and "History" entry points, ensuring modifications and undoes are always available.
 */
export const PROTECTED_TARGETS: readonly SystemTarget[] = ['settings'];

export type PageTarget = `page:${string}`;
export type NavTarget = SystemTarget | PageTarget;

const PAGE_TARGET_PATTERN = /^page:[a-z][a-z0-9-]{0,47}$/;
export const NavTargetSchema = z.custom<NavTarget>(
  (v) =>
    typeof v === 'string' &&
    ((SYSTEM_TARGETS as readonly string[]).includes(v) || PAGE_TARGET_PATTERN.test(v)),
  { message: 'nav target must be a system target or page:<id>' },
);

export const pageTarget = (pageId: string): PageTarget => `page:${pageId}`;

/**
 * Where to open (v34 opens, navigation, nothing written): A page or system entry point;
 * `tool:<id>` exposes a quick action that runs only when the user taps "Start" (reminders D-251,
 * P-043; buttons and quick entry points D-256, where id is the quick action in the config, and
 * buttons can also be preset IDs of built-in quick actions); `package:<id>` is a tool package
 * page (formerly `toolCard`, title and icon fetched dynamically from the package); `{file}` is a
 * user file (formerly `fileSlot`, null = empty slot, chosen by the user upon tap, never written
 * by AI, D-257).
 */
export type ToolTarget = `tool:${string}`;
export type PackageTarget = `package:${string}`;
export type FileTarget = { file: string | null };
export type AppTarget = `app:${string}`;
export type OpenTarget = NavTarget | ToolTarget | PackageTarget | AppTarget | FileTarget;
const APP_TARGET = /^app:[a-z][a-z0-9-]{0,47}$/;
const TOOL_TARGET = /^tool:[a-z][a-z0-9-]{0,47}$/;
const PACKAGE_TARGET = /^package:[a-z][a-z0-9-]{0,47}$/;
export const FileTargetSchema = z.strictObject({ file: AssetIdSchema.nullable() });

/** Open target; `kinds` restricts the allowed target types (reminds that tool packages and files cannot be opened). */
export const openTargetSchema = (
  message: string,
  kinds: readonly ('tool' | 'package' | 'app' | 'file')[] = ['tool', 'package', 'app', 'file'],
) =>
  z.custom<OpenTarget>(
    (v) =>
      NavTargetSchema.safeParse(v).success ||
      (kinds.includes('tool') && typeof v === 'string' && TOOL_TARGET.test(v)) ||
      (kinds.includes('package') && typeof v === 'string' && PACKAGE_TARGET.test(v)) ||
      (kinds.includes('app') && typeof v === 'string' && APP_TARGET.test(v)) ||
      (kinds.includes('file') && FileTargetSchema.safeParse(v).success),
    { message },
  );

/** app:<id> -> id; returns null if not an app entry point. */
export const appTargetId = (target: OpenTarget): string | null =>
  typeof target === 'string' && target.startsWith('app:') ? target.slice('app:'.length) : null;
export const appTarget = (appId: string): AppTarget => `app:${appId}`;
/** tool:<id> -> id; returns null if not a quick action. */
export const toolTargetId = (target: OpenTarget): string | null =>
  typeof target === 'string' && target.startsWith('tool:') ? target.slice('tool:'.length) : null;
/** package:<id> → id。 */
export const packageTargetId = (target: OpenTarget): string | null =>
  typeof target === 'string' && target.startsWith('package:')
    ? target.slice('package:'.length)
    : null;
export const pageIdOf = (target: OpenTarget): string | null =>
  typeof target === 'string' && target.startsWith('page:') ? target.slice('page:'.length) : null;
export const toolTarget = (id: string): ToolTarget => `tool:${id}`;
export const packageTarget = (id: string): PackageTarget => `package:${id}`;
export const isFileTarget = (target: OpenTarget): target is FileTarget =>
  typeof target === 'object' && target !== null;

// ---- app（D-485）----

export const MAX_APPS = 12;

/** Items allowed in the app bottom bar: pages of this app, or Tink (ai). System pages such as settings and change history are excluded; return to the home screen instead (D-485). */
export type AppBarTarget = 'ai' | PageTarget;
export const AppBarTargetSchema = z.custom<AppBarTarget>(
  (v) => typeof v === 'string' && (v === 'ai' || PAGE_TARGET_PATTERN.test(v)),
  { message: 'app bar target must be ai or page:<id>' },
);

/**
 * An app: its own name, icon, bottom bar, and theme (copied from the home screen theme upon
 * creation, then edited independently without inheritance). Pages, tables, and quick actions
 * specify which app they belong to via their `app` field; unassigned items belong to the home
 * screen.
 */
export const AppSchema = z.strictObject({
  id: IdSchema,
  name: boundedText(1, 40),
  icon: IconValueSchema.optional(),
  bar: z.array(AppBarTargetSchema).min(1).max(5),
  theme: ThemeSchema,
});
export type App = z.infer<typeof AppSchema>;

/** An item in the mobile home screen menu (D-485): a quick action ID, or `app:<id>` (tapping enters that app). */
export const HomeScreenEntrySchema = z.union([
  IdSchema,
  z.string().regex(/^app:[a-z][a-z0-9-]{0,47}$/),
]);

/**
 * Navigation (also a container in v34, D-368): bar navigation bar (1-5, formerly `shell.nav`),
 * floating entry points (≤3), `phoneHomeScreen` quick actions in the menu upon long-pressing the
 * Morph icon (≤4, D-271, formerly `workflow.homeScreen`).
 */
export const NavSchema = z.strictObject({
  bar: z.array(NavTargetSchema).min(1).max(5),
  floating: z.array(NavTargetSchema).max(3),
  /** Apps other than the home screen (D-485). The home screen consists of the top-level bar and theme; when absent, only the home screen exists. */
  apps: z.array(AppSchema).max(MAX_APPS).optional(),
  /** The upper limit `MAX_HOME_SCREEN` is checked in `validate.ts` (provides the AI with an instruction it can follow and modify). */
  phoneHomeScreen: z.array(HomeScreenEntrySchema).max(100).optional(),
});
export type Nav = z.infer<typeof NavSchema>;
