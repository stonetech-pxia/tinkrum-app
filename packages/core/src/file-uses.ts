import { COMPONENTS, RECORD_LOOKS } from './components';
import { isDrawnIconRef } from './drawn-icons';
import { FIELDS } from './fields';
import { parseFormula } from './formula';
import type { Registry } from './registry';
import { ICON_NAMES } from './schema-base';

// Exported file "dependencies" manifest (D-556): App files and app configuration files include a
// manifest at the outer level (alongside format and version, not inside the config). It is
// calculated from content during export and never stored in local configuration files (does not
// alter config format or increment version numbers). When reading files, it compares the manifest
// against known versions and accurately reports missing features rather than failing with a generic
// error. Files lacking this manifest (exported from older versions) behave as before. Appearance,
// field types, actions, icons come from registries and are automatically accounted for; keys or
// values added under existing keys post-v39 are explicitly listed in USES_FEATURES (future
// additions of this kind must be added here).

export interface FileUses {
  looks?: string[];
  fieldTypes?: string[];
  actions?: string[];
  icons?: string[];
  features?: string[];
}

/** Keys and values added after v39 that older versions will reject (excluding new appearances, field types, actions, or icons). */
export const USES_FEATURES = [
  'numberCalc',
  'chartExtrema',
  'chartRunning',
  'chartSplit',
  'calendarDayValue',
  'calendarWeek',
  'calendarUntil',
  /** Filter condition 'is' values containing multiple options (D-538). */
  'filterAnyOf',
  /** Time periods next7days / next30days / next90days (D-537). */
  'periodNextDays',
  /** Table layout show.columns (D-539). */
  'showColumns',
  /** Record block show.highlight (D-541). */
  'showHighlight',
  /** Record block show.color outside of calendars (D-541). */
  'showColorAnyLook',
  /** Reminders belonging to an App (supplementing D-485). */
  'reminderInApp',
  /** Placing Apps in the phone home screen menu (app:<id>, supplementing D-485). */
  'appOnPhoneHomeScreen',
  /** Single block source.record "$record": displays the opened record on a page dedicated to a single record (D-558). */
  'singleOpenedRecord',
  /** Time periods yesterday / lastWeek / lastMonth / lastYear / tomorrow / nextWeek / nextMonth (D-559). */
  'periodNeighbours',
  /** Record block source.sort listing multiple fields (D-560). */
  'sortMany',
  /** Record block source.period "page": follows the time range specified on the page (D-561). */
  'recordsFollowPagePeriod',
  /** Reminder when {before, minutes}: minutes before a date/time (D-562). */
  'reminderMinutesBefore',
  /** Daily and weekly reminders with 'unless' condition (D-563). */
  'reminderUnlessRepeating',
  /** Reminder when {every: "month", day}: specific day of every month (D-577). */
  'reminderMonthly',
  /** One-tap record tool value {from, add, unit}: adds days or months relative to today or the record's date (D-565). */
  'recordToolDateValue',
  /** One-tap record tool value {copy}: copies a field from the current record (D-565). */
  'recordToolCopyValue',
  /** Increment 'by' referencing a numeric field of the current record (D-565). */
  'incrementByField',
  /** Tap to modify multiple places: 'also' on in-place tools (D-566). */
  'tapAlso',
  /** Sixth type of one-tap record tool: batch creation (D-567). */
  'createAll',
  /** Value on single-choice options (D-568). */
  'choiceOptionValue',
  /** Color on single-choice options (D-568). */
  'choiceOptionColor',
  /** Formulas reading checkboxes or single-choice fields (D-569). */
  'formulaReadsCheckboxOrChoice',
  /** Table form: sections and conditional display for record forms (D-570). */
  'entryForm',
  /** Field hint: input placeholder guidance (D-570). */
  'fieldHint',
  /** Min / max constraints on number, currency, and duration fields (D-570). */
  'fieldRange',
  /** Record block, number, and chart source.choice "page": follows a row of options on the page (D-573). */
  'blocksFollowPageChoice',
  /** Theme card: parameter-driven card borders and shadows (D-624). */
  'themeCard',
  /** Drawn icons: top-level icons, specified as "my:<id>" (D-625). */
  'drawnIcons',
  /** Text field suggest: earlier values offered while filling in (D-642). */
  'textSuggest',
] as const;

const NEXT_DAYS = new Set(['next7days', 'next30days', 'next90days']);
const NEIGHBOURS = new Set([
  'yesterday',
  'lastWeek',
  'lastMonth',
  'lastYear',
  'tomorrow',
  'nextWeek',
  'nextMonth',
]);
const RECORD_LOOK_SET = new Set<string>(RECORD_LOOKS);
const ICON_NAME = /^[a-z][a-z0-9-]*$/;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Computes the dependencies of a content payload (full config, or app file with outer layers removed); sorted, deduplicated, omitting empty values. */
export function usesOf(content: unknown): FileUses {
  const found = {
    looks: new Set<string>(),
    fieldTypes: new Set<string>(),
    actions: new Set<string>(),
    icons: new Set<string>(),
    features: new Set<string>(),
  };
  const walk = (node: unknown, key: string | null) => {
    if (Array.isArray(node)) {
      // Formulas reading checkboxes or single-choice fields of the same table (D-569).
      if (key === 'fields') {
        const readable = new Set(
          node
            .filter((f) => isObject(f) && (f.type === 'checkbox' || f.type === 'choice'))
            .map((f) => (f as { id?: unknown }).id),
        );
        for (const f of node) {
          if (!isObject(f) || f.type !== 'formula' || typeof f.expression !== 'string') continue;
          const parsed = parseFormula(f.expression);
          if (parsed.ok && parsed.refs.some((id) => readable.has(id)))
            found.features.add('formulaReadsCheckboxOrChoice');
        }
      }
      for (const item of node) {
        if (key === 'fields' && isObject(item) && typeof item.type === 'string') {
          found.fieldTypes.add(item.type);
          // Input hints and ranges (D-570).
          if (item.hint !== undefined) found.features.add('fieldHint');
          if (item.min !== undefined || item.max !== undefined) found.features.add('fieldRange');
          if (item.suggest !== undefined) found.features.add('textSuggest');
          // Values and colors on single-choice options (D-568).
          for (const o of Array.isArray(item.options) ? item.options : []) {
            if (isObject(o) && o.value !== undefined) found.features.add('choiceOptionValue');
            if (isObject(o) && o.color !== undefined) found.features.add('choiceOptionColor');
          }
        }
        if (key === 'phoneHomeScreen' && typeof item === 'string' && item.startsWith('app:'))
          found.features.add('appOnPhoneHomeScreen');
        walk(item, key);
      }
      return;
    }
    if (!isObject(node)) return;
    // Blocks with id and look (in pages, groups, including unrecognized looks in this version).
    if (typeof node.look === 'string' && typeof node.id === 'string') {
      found.looks.add(node.look);
      const show = node.show;
      if (isObject(show)) {
        // Periods and default of time tabs (D-559).
        if (
          node.look === 'tabs' &&
          [show.periods, show.default]
            .flat()
            .some((p) => typeof p === 'string' && NEIGHBOURS.has(p))
        )
          found.features.add('periodNeighbours');
        if (show.columns !== undefined) found.features.add('showColumns');
        if (show.highlight !== undefined) found.features.add('showHighlight');
        if (show.color !== undefined && RECORD_LOOK_SET.has(node.look) && node.look !== 'calendar')
          found.features.add('showColorAnyLook');
      }
      if (isObject(show) && node.look === 'calendar') {
        if (show.day !== undefined) found.features.add('calendarDayValue');
        if (show.span !== undefined) found.features.add('calendarWeek');
      }
      const source = node.source;
      if (isObject(source)) {
        if (node.look === 'number' && source.calc !== undefined) found.features.add('numberCalc');
        if (node.look === 'chart') {
          if (['latest', 'min', 'max'].includes(String(source.aggregate)))
            found.features.add('chartExtrema');
          if (source.running !== undefined) found.features.add('chartRunning');
          if (source.split !== undefined) found.features.add('chartSplit');
        }
        if (node.look === 'calendar' && isObject(source.group) && source.group.until !== undefined)
          found.features.add('calendarUntil');
        if (node.look === 'single' && source.record !== undefined)
          found.features.add('singleOpenedRecord');
        if (Array.isArray(source.sort)) found.features.add('sortMany');
        if (RECORD_LOOK_SET.has(node.look) && source.period !== undefined)
          found.features.add('recordsFollowPagePeriod');
        if (source.choice !== undefined) found.features.add('blocksFollowPageChoice');
      }
    }
    // Quick action steps, actions on the toolbar.
    if (typeof node.action === 'string') found.actions.add(node.action);
    // Filter conditions (used in blocks, summaries, reminders, and quick actions).
    if (typeof node.field === 'string' && typeof node.op === 'string') {
      if (Array.isArray(node.value)) found.features.add('filterAnyOf');
      if (node.op === 'inPeriod' && typeof node.value === 'string' && NEXT_DAYS.has(node.value))
        found.features.add('periodNextDays');
      if (node.op === 'inPeriod' && typeof node.value === 'string' && NEIGHBOURS.has(node.value))
        found.features.add('periodNeighbours');
    }
    if (typeof node.period === 'string' && NEXT_DAYS.has(node.period))
      found.features.add('periodNextDays');
    if (typeof node.period === 'string' && NEIGHBOURS.has(node.period))
      found.features.add('periodNeighbours');
    // Values written by one-tap record tools (on blocks, reminder done) (D-565).
    if (typeof node.do === 'string') {
      const values = [node.value, ...(isObject(node.values) ? Object.values(node.values) : [])];
      for (const v of values) {
        if (isObject(v) && v.unit !== undefined && v.from !== undefined)
          found.features.add('recordToolDateValue');
        if (isObject(v) && v.copy !== undefined) found.features.add('recordToolCopyValue');
      }
      if (node.do === 'increment' && typeof node.by === 'string')
        found.features.add('incrementByField');
      if (Array.isArray(node.also)) found.features.add('tapAlso');
      if (node.do === 'createAll') found.features.add('createAll');
    }
    // Form on a table (D-570): the layer with fields is a form.
    if (Array.isArray(node.fields) && node.form !== undefined) found.features.add('entryForm');
    // Card on a theme (D-624): the layer with cardStyle is a theme.
    if (typeof node.cardStyle === 'string' && node.card !== undefined)
      found.features.add('themeCard');
    if (node.kind === 'reminder' && node.app !== undefined) found.features.add('reminderInApp');
    if (node.kind === 'reminder' && isObject(node.when)) {
      if (node.when.before !== undefined && node.when.minutes !== undefined)
        found.features.add('reminderMinutesBefore');
      if (node.when.every !== undefined && node.unless !== undefined)
        found.features.add('reminderUnlessRepeating');
      if (node.when.every === 'month') found.features.add('reminderMonthly');
    }
    for (const [k, v] of Object.entries(node)) {
      // Icon: whitelist name (emojis do not count, recognized across all versions); rendered my:<id> counts as a feature, not an icon name.
      if (k === 'icon' && typeof v === 'string' && ICON_NAME.test(v)) found.icons.add(v);
      if (k === 'icon' && isDrawnIconRef(v)) found.features.add('drawnIcons');
      walk(v, k);
    }
  };
  walk(content, null);
  if (isObject(content) && isObject(content.icons)) found.features.add('drawnIcons');
  const out: FileUses = {};
  for (const [k, set] of Object.entries(found))
    if (set.size > 0) out[k as keyof FileUses] = [...set].sort();
  return out;
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/**
 * Items in the outer file manifest not recognized by this version (ordered by look, field type,
 * action, icon, others). Missing manifest, invalid manifest, or unreadable files all return
 * empty: such files follow legacy behavior.
 */
export function missingUses(text: string, registry: Registry): string[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  if (!isObject(data) || !isObject(data.uses)) return [];
  const uses = data.uses;
  const looks = new Set<string>(COMPONENTS.map((c) => c.look));
  const types = new Set<string>(FIELDS.map((f) => f.type));
  const icons = new Set<string>(ICON_NAMES);
  const features = new Set<string>(USES_FEATURES);
  return [
    ...strings(uses.looks).filter((x) => !looks.has(x)),
    ...strings(uses.fieldTypes).filter((x) => !types.has(x)),
    ...strings(uses.actions).filter((x) => !registry.actions.has(x)),
    ...strings(uses.icons).filter((x) => !icons.has(x)),
    ...strings(uses.features).filter((x) => !features.has(x)),
  ];
}
