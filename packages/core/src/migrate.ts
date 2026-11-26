import { migrateV33toV34 as migrateShapeV33toV34 } from './migrate-v34';
import { CURRENT_SCHEMA_VERSION } from './schema';
import { DEFAULT_THEME } from './theme';

// Schema migration (§7E): upgrade step-by-step to the current version when restoring an old
// snapshot, then validate. Each time CURRENT_SCHEMA_VERSION is incremented, the migration function
// and tests for the previous version must be added to MIGRATIONS. Adding a single component type
// does not increment the version number (D-254), see schema.ts.

export type Migration = (config: Record<string, unknown>) => Record<string, unknown>;

/** v1 default primary color; workspaces with unmodified primary colors get the new default style (Clay) after upgrade. */
const V1_DEFAULT_PRIMARY = '#3B5BDB';

/**
 * v1 → v2: theme gains style tokens (fonts, sizes, border radii, density, card and navigation bar
 * styles), protected elements change from "AI + history" to "Settings" (Settings page itself
 * provides fixed access to AI modifications and history).
 */
export const migrateV1toV2: Migration = (config) => {
  const theme = config.theme as { primaryColor: string; mode: string };
  const shell = config.shell as { nav: string[]; floating: string[] };
  const nav = [...shell.nav];
  const floating = [...shell.floating];
  if (!nav.includes('settings') && !floating.includes('settings')) {
    if (nav.length < 5) nav.push('settings');
    else if (floating.length < 3) floating.push('settings');
    else floating[floating.length - 1] = 'settings';
  }
  // v2 pages can have icons; home page gets a home icon added, other pages use the navigation bar's default icon.
  const pages = (config.pages as { id: string; icon?: string }[]).map((p) =>
    p.id === 'home' && p.icon === undefined ? { ...p, icon: 'home' } : p,
  );
  return {
    ...config,
    schemaVersion: 2,
    pages,
    theme: {
      ...DEFAULT_THEME,
      primaryColor:
        theme.primaryColor.toUpperCase() === V1_DEFAULT_PRIMARY
          ? DEFAULT_THEME.primaryColor
          : theme.primaryColor,
      mode: theme.mode,
    },
    shell: { nav, floating },
  };
};

/** v2 → v3: add data table structure collections (records themselves are not stored in the config). */
export const migrateV2toV3: Migration = (config) => ({
  ...config,
  schemaVersion: 3,
  collections: [],
});

/** v3 → v4: add image component, emoji icons, and rich text; existing data requires no changes, only the version number is incremented. */
export const migrateV3toV4: Migration = (config) => ({ ...config, schemaVersion: 4 });

interface V4Step {
  id: string;
  action: string;
  params: Record<string, unknown>;
}

/**
 * v4 → v5: workflow steps now pass typed values between each other (D-060).
 * - pdf.selectFiles {min, max} → in.files {accept: 'pdf', min, max}
 * - ui.askFileName {defaultTemplate} + file.save {nameTemplate} → file.rename (ask on each run) +
 * file.save {}
 * - only file.save {nameTemplate} (prompt removed) → file.rename {template} + file.save {}
 */
export const migrateV4toV5: Migration = (config) => {
  const workflows = (config.workflows as { steps: V4Step[] }[]).map((wf) => {
    const ask = wf.steps.find((s) => s.action === 'ui.askFileName');
    const steps: Record<string, unknown>[] = [];
    for (const step of wf.steps) {
      switch (step.action) {
        case 'pdf.selectFiles':
          steps.push({
            id: step.id,
            action: 'in.files',
            params: { accept: 'pdf', min: step.params.min, max: step.params.max },
          });
          break;
        case 'ui.askFileName':
          steps.push({
            id: step.id,
            action: 'file.rename',
            params: { template: step.params.defaultTemplate },
            ask: ['template'],
          });
          break;
        case 'file.save':
          if (!ask) {
            steps.push({
              id: steps.some((s) => s.id === 'name') ? `${step.id}-name` : 'name',
              action: 'file.rename',
              params: { template: step.params.nameTemplate },
            });
          }
          steps.push({ id: step.id, action: 'file.save', params: {} });
          break;
        default:
          steps.push({ ...step });
      }
    }
    return { ...wf, steps };
  });
  return { ...config, schemaVersion: 5, workflows };
};

/** v5 → v6: theme gains third color, dark mode colors, page background, and six card styles; existing data requires no changes, only the version number is incremented. */
export const migrateV5toV6: Migration = (config) => ({ ...config, schemaVersion: 6 });

/**
 * v6 → v7: file lists can filter by major file category (image/*, video/*, audio/*), icons added
 * for video and audio (D-140); existing data requires no changes, only the version number is
 * incremented.
 */
export const migrateV6toV7: Migration = (config) => ({ ...config, schemaVersion: 7 });

/**
 * v7 → v8: data tables gain attachment (file) and formula fields, quick actions can "log an
 * expense" (D-187, D-188); existing data requires no changes, only the version number is
 * incremented.
 */
export const migrateV7toV8: Migration = (config) => ({ ...config, schemaVersion: 8 });

/** v8 → v9: add tool grid component toolGrid, icons added for translate and note (D-181); existing data requires no changes, only the version number is incremented. */
export const migrateV8toV9: Migration = (config) => ({ ...config, schemaVersion: 9 });

/** v9 → v10: add file selection trigger; keep legacy user pages as-is. */
export const migrateV9toV10: Migration = (config) => ({ ...config, schemaVersion: 10 });

/** v10 → v11: allow category system entry, keep legacy users' home page as-is. */
export const migrateV10toV11: Migration = (config) => ({ ...config, schemaVersion: 11 });

/**
 * v11 → v12: entry cards and quick actions can have styles selected, buttons can carry icons,
 * theme gains icon background color, add quick action list component (D-230); existing data
 * requires no changes, only the version number is incremented.
 */
export const migrateV11toV12: Migration = (config) => ({ ...config, schemaVersion: 12 });

/** v12 → v13: statistics component can group by single-select fields (D-248); existing data requires no changes, only the version number is incremented. */
export const migrateV12toV13: Migration = (config) => ({ ...config, schemaVersion: 13 });

/** v13 → v14: add chart component chart (D-249); existing data requires no changes, only the version number is incremented. */
export const migrateV13toV14: Migration = (config) => ({ ...config, schemaVersion: 14 });

/** v14 → v15: data tables gain reference field link (D-250); existing data requires no changes, only the version number is incremented. */
export const migrateV14toV15: Migration = (config) => ({ ...config, schemaVersion: 15 });

/** v15 → v16: add reminders reminders (D-251, optional, absence means no reminders); only increment the version number. */
export const migrateV15toV16: Migration = (config) => ({ ...config, schemaVersion: 16 });

/**
 * v16 → v17: buttons and quick entries can open a quick action workflow:<id> (D-256, modified
 * existing component structure, incremented per D-254); existing data requires no changes, only
 * the version number is incremented.
 */
export const migrateV16toV17: Migration = (config) => ({ ...config, schemaVersion: 17 });

/**
 * v17 → v18: card components style and pages can have image backgrounds backdrop (D-258, modified
 * existing structure, incremented per D-254); existing data requires no changes, only the version
 * number is incremented.
 */
export const migrateV17toV18: Migration = (config) => ({ ...config, schemaVersion: 18 });

/**
 * v18 → v19: quick actions can be placed on the phone homeScreen (D-271, modified existing
 * structure, incremented per D-254); existing quick actions are not on the desktop, require no
 * changes, only increment the version number.
 */
export const migrateV18toV19: Migration = (config) => ({ ...config, schemaVersion: 19 });

/**
 * v19 → v20: text recognition language can be set to "automatic" (D-278, modified action
 * parameters, incremented per D-254). The two quick actions installed by the text recognition
 * tool (ocr-photos, ocr-scan) store step copies that previously prompted for language on every
 * run; only when identical to legacy generated ones (unmodified by user), change the recognition
 * step to automatic and stop prompting. User-modified ones remain untouched.
 */
const OLD_OCR_STEPS: Record<string, (lang: string) => unknown[]> = {
  'ocr-photos': (lang) => [
    { id: 'pick', action: 'in.photos', params: { source: 'library', min: 1, max: 20 } },
    { id: 'read', action: 'ocr.recognize', params: { lang }, ask: ['lang'] },
  ],
  'ocr-scan': (lang) => [
    { id: 'shoot', action: 'in.photos', params: { source: 'scanner', min: 1, max: 10 } },
    { id: 'edges', action: 'scan.detect', params: {} },
    { id: 'read', action: 'ocr.recognize', params: { lang }, ask: ['lang'] },
  ],
};

export const migrateV19toV20: Migration = (config) => {
  const workflows = Array.isArray(config.workflows) ? config.workflows : [];
  return {
    ...config,
    schemaVersion: 20,
    workflows: workflows.map((w: unknown) => {
      const wf = w as { id?: unknown; toolId?: unknown; steps?: unknown[] };
      const old = typeof wf.id === 'string' ? OLD_OCR_STEPS[wf.id] : undefined;
      if (!old || wf.toolId !== 'ocr') return w;
      const same = ['chi_sim', 'fra', 'eng'].some(
        (lang) => JSON.stringify(wf.steps) === JSON.stringify(old(lang)),
      );
      if (!same) return w;
      return {
        ...wf,
        steps: wf.steps!.map((s) => {
          const step = s as { action?: unknown };
          return step.action === 'ocr.recognize'
            ? { id: 'read', action: 'ocr.recognize', params: { lang: 'auto' } }
            : s;
        }),
      };
    }),
  };
};

/**
 * v20 → v21: fields gain three types: time, datetime, duration (D-279); formulas support new
 * functions, reference other formulas, up to 500 characters (D-280, D-281). Existing fields and
 * formulas remain valid, only increment the version number.
 */
export const migrateV20toV21: Migration = (config) => ({ ...config, schemaVersion: 21 });

/**
 * v21 → v22: statistics gain sequential aggregations (consecutive days, etc., D-284), time ranges
 * expanded (D-285), config can have calendar (start of day/week, D-286); absence of calendar
 * defaults to original midnight and Monday, existing data requires no changes, only increment the
 * version number.
 */
export const migrateV21toV22: Migration = (config) => ({ ...config, schemaVersion: 22 });

/**
 * v22 → v23: fields gain lookup, rollup, previous types (D-287–D-289), values are computed
 * on-the-fly and not stored in records. Existing fields remain valid, only increment the version
 * number.
 */
export const migrateV22toV23: Migration = (config) => ({ ...config, schemaVersion: 23 });

/**
 * v23 → v24: fields gain schedule (D-292, D-293), filters gain due (D-294). Existing fields and
 * filters remain valid, only increment the version number.
 */
export const migrateV23toV24: Migration = (config) => ({ ...config, schemaVersion: 24 });

/**
 * v24 → v25: buttons gain optional action and target, record lists gain rowActions (one-tap
 * record operations, D-300–D-304). Existing buttons have targets and remain valid, only increment
 * the version number.
 */
export const migrateV24toV25: Migration = (config) => ({ ...config, schemaVersion: 25 });

/**
 * v25 → v26: record lists gain monthly calendar view and right-side field display formats (D-305,
 * D-306), statistics gain targets and period-over-period comparison (D-307, D-308). All are new
 * optional properties, existing configs remain valid, only increment the version number.
 */
export const migrateV25toV26: Migration = (config) => ({ ...config, schemaVersion: 26 });

/**
 * v26 → v27: record lists gain tiles and board views along with groupField for board columns
 * (D-311–D-314). All are new optional values, existing configs remain valid, only increment the
 * version number.
 */
export const migrateV26toV27: Migration = (config) => ({ ...config, schemaVersion: 27 });

/**
 * v27 → v28: reminders gain record schedule-based scheduleField along with its unless, done, and
 * snoozeMinutes (D-316–D-318). All are new optional values, existing configs remain valid, only
 * increment the version number.
 */
export const migrateV27toV28: Migration = (config) => ({ ...config, schemaVersion: 28 });

/**
 * v28 → v29: statistics and charts can group by reference fields (D-336), statistics can subtract
 * another sum (minus, D-337), one-tap action creation can open a form (form, D-338). All are new
 * optional values, only increment the version number.
 */
export const migrateV28toV29: Migration = (config) => ({ ...config, schemaVersion: 29 });

/**
 * v29 → v30: schedule "once" and countEarly (D-340, D-341), record-specific pages (recordOf,
 * recordList.opens, "$record", D-342), quick add form preset values and smartDate (D-343, D-344).
 * All are new optional values, only increment the version number.
 */
export const migrateV29toV30: Migration = (config) => ({ ...config, schemaVersion: 30 });

/**
 * v30 → v31: schedule rule hours (D-346), record list sections (groupBy, groupUnit, showEmpty,
 * D-347), calendar schedule recognition (D-348), in-place addition (addHere, D-349). All are new
 * optional values, only increment the version number.
 */
export const migrateV30toV31: Migration = (config) => ({ ...config, schemaVersion: 31 });

/**
 * v31 → v32: board columns by reference field and groupFilter (D-351), quick add form sheet mode
 * (D-352). All are new optional values, only increment the version number.
 */
export const migrateV31toV32: Migration = (config) => ({ ...config, schemaVersion: 32 });

/**
 * v32 → v33: add file desk layout desk (D-358). A new optional value, existing configs remain
 * valid, only increment the version number.
 */
export const migrateV32toV33: Migration = (config) => ({ ...config, schemaVersion: 33 });

/**
 * v33 → v34: "Data · Containers · Tools" (D-368, decided by founder 2026-10-30): collections →
 * data.tables, pages → containers.pages (components → blocks: look / show / source / tools /
 * opens), workflows and reminders → tools, shell → nav, tools → packages, desk → containers.desk.
 * IDs unchanged; see migrate-v34.ts.
 */
export const migrateV33toV34: Migration = (config) => migrateShapeV33toV34(config);

/** v34 → v35: tables gain optional readAttachments (D-397). A new optional value, only increment the version number. */
export const migrateV34toV35: Migration = (config) => ({ ...config, schemaVersion: 35 });

/** v35 -> v36: theme colors now support an optional surfaceText (D-409). This is a new optional value, only bumping the schema version. */
export const migrateV35toV36: Migration = (config) => ({ ...config, schemaVersion: 36 });

/** v36 -> v37: amount fields now support an optional currencyField (D-429), tables now support optional prefillRules (D-421), text fields now support an optional format (D-422), blocks now support optional showIf, record block show now supports optional browse (D-424), print.records now supports optional attachments (D-425), tables now support optional recordRow, block tools now support as: "list", single now supports optional tools, step 1 can receive values passed from containers (D-428), blocks now support optional pin (pinned section on page, D-430), browse now supports optional pin (D-431), filter (D-433), added field type tags (D-432) and presentation dial (D-434), browse now supports optional period (D-437), chart source now supports optional compare (D-439) and period, numeric block source now supports optional period, and added presentation period (D-440). These are new optional values, only bumping the schema version. */
export const migrateV36toV37: Migration = (config) => ({ ...config, schemaVersion: 37 });

/**
 * v37 -> v38: button variant now supports "row" (full width: icon, name, arrow, matching the
 * settings page buttons, D-483). The home screen "Toolbox" trigger (opening the toolbox page,
 * outlined button) was previously rendered as an outlined button and is now changed to "row".
 * Only matches this specific button: opens toolbox page, no tools, outline variant; other buttons
 * remain untouched.
 */
export const migrateV37toV38: Migration = (config) => {
  const rowIfToolbox = (block: unknown): unknown => {
    if (typeof block !== 'object' || block === null) return block;
    const b = block as Record<string, unknown>;
    const show = b.show as Record<string, unknown> | undefined;
    if (
      b.look === 'button' &&
      b.opens === 'page:toolbox' &&
      b.tools === undefined &&
      show?.variant === 'outline'
    )
      return { ...b, show: { ...show, variant: 'row' } };
    if (Array.isArray(b.children)) return { ...b, children: b.children.map(rowIfToolbox) };
    return block;
  };
  const containers = config.containers as { pages?: Record<string, unknown>[] } | undefined;
  if (!containers?.pages) return { ...config, schemaVersion: 38 };
  return {
    ...config,
    schemaVersion: 38,
    containers: {
      ...containers,
      pages: containers.pages.map((p) =>
        Array.isArray(p.blocks) ? { ...p, blocks: p.blocks.map(rowIfToolbox) } : p,
      ),
    },
  };
};

/** v38 -> v39: nav now supports optional apps, and pages, tables, and quick actions now support an optional app (D-485). These are new optional values, only bumping the schema version. */
export const migrateV38toV39: Migration = (config) => ({ ...config, schemaVersion: 39 });

/**
 * v39 -> v40: single-choice fields now support an optional multiple (allowing multiple
 * selections), and default can be a list of option IDs (D-607). These are new optional values,
 * only bumping the schema version; a single option ID stored in existing records is read as a
 * single item without rewriting.
 */
export const migrateV39toV40: Migration = (config) => ({ ...config, schemaVersion: 40 });

/**
 * One block from v40 to v41 (D-655): twelve looks become five.
 * Each old block is drawn the same afterwards, except a button with variant "row", which now uses
 * the same row as the former entry (they differed only in spacing).
 * - divider → spacer {size: "small", line: true}
 * - library, packages, apps → catalog (show and source unchanged: source.catalog already says which)
 * - callout → notice (same keys)
 * - period → tabs, show.options → show.periods; choices → tabs (same keys)
 * - entry → button (show.title → show.label); action, picker → button (tools unchanged);
 *   button show.variant → show.shape
 */
/** The same object with one key renamed in place. */
const renameKey = (o: Record<string, unknown>, from: string, to: string) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k === from ? to : k, v]));

function blockV41(block: unknown): unknown {
  if (typeof block !== 'object' || block === null || Array.isArray(block)) return block;
  const b = block as Record<string, unknown>;
  const show = b.show as Record<string, unknown> | undefined;
  // Same keys in the same order, with look (and show, when given) replaced in place.
  const as = (look: string, rest: { show?: Record<string, unknown> }) => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(b)) {
      if (key === 'look') {
        out.look = look;
        if (rest.show && !('show' in b)) out.show = rest.show;
      } else if (key === 'show') {
        if (rest.show) out.show = rest.show;
      } else out[key] = value;
    }
    return out;
  };
  switch (b.look) {
    case 'group':
      return Array.isArray(b.children) ? { ...b, children: b.children.map(blockV41) } : b;
    case 'divider':
      return as('spacer', { show: { size: 'small', line: true } });
    case 'library':
    case 'packages':
    case 'apps':
    case 'callout':
      return { ...b, look: b.look === 'callout' ? 'notice' : 'catalog' };
    case 'choices':
      return { ...b, look: 'tabs' };
    case 'period':
      return as('tabs', { show: renameKey(show ?? {}, 'options', 'periods') });
    case 'picker':
      return as('button', show?.shape === 'icon' ? { show: { shape: 'icon' } } : {});
    case 'action':
      return as('button', show?.shape ? { show: { shape: show.shape } } : {});
    case 'entry':
      return as('button', show ? { show: renameKey(show, 'title', 'label') } : {});
    case 'button':
      return show ? as('button', { show: renameKey(show, 'variant', 'shape') }) : b;
    default:
      return b;
  }
}

/** A page's blocks in the v40 format, in the v41 format (also for pages built from the v33 shape, such as a downloaded tool's page). */
export const blocksToV41 = (blocks: readonly unknown[]): unknown[] => blocks.map(blockV41);

export const migrateV40toV41: Migration = (config) => {
  const containers = config.containers as { pages?: unknown; desk?: unknown } | undefined;
  if (!containers) return { ...config, schemaVersion: 41 };
  const next: Record<string, unknown> = { ...containers };
  if (Array.isArray(containers.pages))
    next.pages = containers.pages.map((p: unknown) => {
      const page = p as Record<string, unknown>;
      return page && Array.isArray(page.blocks) ? { ...page, blocks: blocksToV41(page.blocks) } : p;
    });
  // The blocks above and below the file preview (containers.desk, D-358).
  const desk = containers.desk as Record<string, unknown> | undefined;
  if (desk && typeof desk === 'object') {
    const slots: Record<string, unknown> = { ...desk };
    for (const key of ['above', 'below'])
      if (Array.isArray(desk[key])) slots[key] = (desk[key] as unknown[]).map(blockV41);
    next.desk = slots;
  }
  return { ...config, schemaVersion: 41, containers: next };
};

/** MIGRATIONS[n] upgrades schemaVersion n to n + 1. */
export const MIGRATIONS: Readonly<Record<number, Migration>> = {
  1: migrateV1toV2,
  2: migrateV2toV3,
  3: migrateV3toV4,
  4: migrateV4toV5,
  5: migrateV5toV6,
  6: migrateV6toV7,
  7: migrateV7toV8,
  8: migrateV8toV9,
  9: migrateV9toV10,
  10: migrateV10toV11,
  11: migrateV11toV12,
  12: migrateV12toV13,
  13: migrateV13toV14,
  14: migrateV14toV15,
  15: migrateV15toV16,
  16: migrateV16toV17,
  17: migrateV17toV18,
  18: migrateV18toV19,
  19: migrateV19toV20,
  20: migrateV20toV21,
  21: migrateV21toV22,
  22: migrateV22toV23,
  23: migrateV23toV24,
  24: migrateV24toV25,
  25: migrateV25toV26,
  26: migrateV26toV27,
  27: migrateV27toV28,
  28: migrateV28toV29,
  29: migrateV29toV30,
  30: migrateV30toV31,
  31: migrateV31toV32,
  32: migrateV32toV33,
  33: migrateV33toV34,
  34: migrateV34toV35,
  35: migrateV35toV36,
  36: migrateV36toV37,
  37: migrateV37toV38,
  38: migrateV38toV39,
  39: migrateV39toV40,
  40: migrateV40toV41,
};

export type MigrateResult =
  { ok: true; config: unknown; fromVersion: number } | { ok: false; error: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function migrateWorkspace(
  raw: unknown,
  migrations: Readonly<Record<number, Migration>> = MIGRATIONS,
  targetVersion: number = CURRENT_SCHEMA_VERSION,
): MigrateResult {
  if (!isRecord(raw) || !Number.isInteger(raw.schemaVersion)) {
    return { ok: false, error: 'missing schemaVersion' };
  }
  const fromVersion = raw.schemaVersion as number;
  if (fromVersion > targetVersion) {
    return { ok: false, error: `schemaVersion ${fromVersion} is newer than this app supports` };
  }
  let current: Record<string, unknown> = JSON.parse(JSON.stringify(raw));
  for (let v = fromVersion; v < targetVersion; v++) {
    const migration = migrations[v];
    if (!migration) return { ok: false, error: `no migration from schemaVersion ${v}` };
    try {
      current = migration(current);
    } catch (e) {
      return { ok: false, error: `migration from ${v} failed: ${String(e)}` };
    }
    if (current.schemaVersion !== v + 1) {
      return { ok: false, error: `migration from ${v} did not produce schemaVersion ${v + 1}` };
    }
  }
  return { ok: true, config: current, fromVersion };
}
