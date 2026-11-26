import { localize } from './localization';
import type { Op, OpOf } from './ops-schema';
import {
  HOME_PAGE_ID,
  allComponents,
  componentCollection,
  pageTarget,
  type Collection,
  type Locale,
  type Page,
  type WorkspaceConfig,
} from './schema';
import bank from './templates/bank.json';
import education from './templates/education.json';
import identity from './templates/identity.json';
import insurance from './templates/insurance.json';
import lab from './templates/lab.json';
import lease from './templates/lease.json';
import loan from './templates/loan.json';
import payslip from './templates/payslip.json';
import pet from './templates/pet.json';
import prescription from './templates/prescription.json';
import property from './templates/property.json';
import tax from './templates/tax.json';
import travel from './templates/travel.json';
import vaccination from './templates/vaccination.json';
import vehicle from './templates/vehicle.json';
import warranty from './templates/warranty.json';
import bill from './templates/bill.json';
import blank from './templates/blank.json';
import budget from './templates/budget.json';
import contacts from './templates/contacts.json';
import contract from './templates/contract.json';
import notes from './templates/notes.json';
import purchase from './templates/purchase.json';
import reading from './templates/reading.json';
import reimbursement from './templates/reimbursement.json';
import todo from './templates/todo.json';

// Built-in data page templates (D-040): mock AI uses them to understand phrases like "create a new
// bookkeeping page", and evaluation sets use them to prepare initial states. Templates only
// generate data table structures and pages, containing no records; these four are not yet directly
// selectable by users (D-255), see preset tables for inbox page below (D-392).
//
// Each template is templates/<name>.json (D-255, v34 format):
// - ids: base IDs for data tables and pages; if config already has duplicates, append -2, -3...
// - table, page: content of addData {table}, addContainer {page}. IDs written as placeholders
// $table, $page, places in blocks referencing this table (source.table, inline tool's table) also
// written as $table, replaced with actual IDs upon generation.
// - User-facing text written as { en, zh, fr }, selected by interface language.
// - entry: page entry point. Currently only nav: put into nav bar (before settings), if full, add
// quick entry on home screen.

export const DATA_TEMPLATES = ['budget', 'todo', 'reading', 'notes'] as const;
export type DataTemplate = (typeof DATA_TEMPLATES)[number];

/**
 * Preset tables selectable by users for inbox page "Save as record" (D-392): each has an
 * attachment field (attachments), fields can be modified later. Listed separately from the above
 * four: mock AI and evaluations recognize only the top four, these are only for users to select
 * in the inbox page. blank is "blank": one title field plus attachment field, table name uses
 * default name initially, modified by user later.
 */
export const FILE_RECORD_PRESETS = [
  'purchase',
  'bill',
  'contract',
  'reimbursement',
  'contacts',
  'blank',
] as const;
export type FileRecordPreset = (typeof FILE_RECORD_PRESETS)[number];
/**
 * Presets invisible to users normally (D-444): participated in sorting and recommendation only
 * when importing files and deciding to create new forms; mock AI and evaluations do not recognize
 * them. Fields are prototypes, names unreviewed.
 */
export const HIDDEN_RECORD_PRESETS = [
  'bank',
  'education',
  'identity',
  'insurance',
  'lab',
  'lease',
  'loan',
  'payslip',
  'pet',
  'prescription',
  'property',
  'tax',
  'travel',
  'vaccination',
  'vehicle',
  'warranty',
] as const;
export type HiddenRecordPreset = (typeof HIDDEN_RECORD_PRESETS)[number];
/** All presets selectable when creating a new form (excluding blank). */
export type NewTablePreset = Exclude<FileRecordPreset, 'blank'> | HiddenRecordPreset;
type Template = DataTemplate | FileRecordPreset | HiddenRecordPreset;

interface TemplateJson {
  ids: { table: string; page: string };
  table: unknown;
  page: unknown;
  entry: 'nav';
}

const TEMPLATES: Record<Template, TemplateJson> = {
  budget: budget as TemplateJson,
  todo: todo as TemplateJson,
  reading: reading as TemplateJson,
  notes: notes as TemplateJson,
  purchase: purchase as TemplateJson,
  bill: bill as TemplateJson,
  contract: contract as TemplateJson,
  reimbursement: reimbursement as TemplateJson,
  contacts: contacts as TemplateJson,
  blank: blank as TemplateJson,
  bank: bank as TemplateJson,
  education: education as TemplateJson,
  identity: identity as TemplateJson,
  insurance: insurance as TemplateJson,
  lab: lab as TemplateJson,
  lease: lease as TemplateJson,
  loan: loan as TemplateJson,
  payslip: payslip as TemplateJson,
  pet: pet as TemplateJson,
  prescription: prescription as TemplateJson,
  property: property as TemplateJson,
  tax: tax as TemplateJson,
  travel: travel as TemplateJson,
  vaccination: vaccination as TemplateJson,
  vehicle: vehicle as TemplateJson,
  warranty: warranty as TemplateJson,
};

type AddTable = OpOf<'addData'> & { table: Exclude<OpOf<'addData'>['table'], string> };
type AddPage = OpOf<'addContainer'> & {
  page: Exclude<NonNullable<OpOf<'addContainer'>['page']>, string>;
};

const isLocalized = (v: object) => {
  const keys = Object.keys(v).sort();
  return keys.length === 3 && keys.join() === 'en,fr,zh';
};

/** Replace placeholders and retrieve text by language. */
function fill(value: unknown, locale: Locale, ids: Record<string, string>): unknown {
  if (typeof value === 'string') return ids[value] ?? value;
  if (Array.isArray(value)) return value.map((v) => fill(v, locale, ids));
  if (typeof value === 'object' && value !== null) {
    if (isLocalized(value)) return localize(value as Record<Locale, string>, locale);
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, fill(v, locale, ids)] as const),
    );
  }
  return value;
}

function uniqueId(base: string, taken: (id: string) => boolean): string {
  if (!taken(base)) return base;
  for (let n = 2; ; n++) if (!taken(`${base}-${n}`)) return `${base}-${n}`;
}

/** New pages need an entry point: put into nav bar if space permits (before settings), otherwise add a quick entry on the home screen. */
export function entryOps(
  config: WorkspaceConfig,
  pageId: string,
  title: string,
  icon: Page['icon'],
): Op[] {
  const nav = config.nav.bar;
  if (nav.length < 5) {
    const at = nav.indexOf('settings');
    const bar = [...nav];
    bar.splice(at < 0 ? bar.length : at, 0, pageTarget(pageId));
    return [{ op: 'updateContainer', nav: { bar } }];
  }
  return [
    {
      op: 'addContainer',
      page: HOME_PAGE_ID,
      block: {
        id: `shortcut-${pageId}`,
        look: 'button',
        show: { label: title, icon: icon ?? 'star' },
        opens: pageTarget(pageId),
      },
    },
  ];
}

/** Modification operations to generate a template: create data table, create page, and provide an entry point for the page. */
export function templateOps(template: Template, config: WorkspaceConfig, locale: Locale): Op[] {
  const op = templateCollectionOp(template, config, locale);
  return [op, ...templatePageOps(template, config, locale, op.table.id)];
}

/** Create only the template's data table (feature, D-191); add page separately later (look, goes into draft first). */
export function templateCollectionOp(
  template: Template,
  config: WorkspaceConfig,
  locale: Locale,
): AddTable {
  const json = TEMPLATES[template];
  const tableId = uniqueId(json.ids.table, (id) => config.data.tables.some((c) => c.id === id));
  const table = fill(json.table, locale, { $table: tableId });
  return { op: 'addData', table: table as AddTable['table'] };
}

/** Create page for existing template data table and add an entry point for the page. */
export function templatePageOps(
  template: Template,
  config: WorkspaceConfig,
  locale: Locale,
  tableId: string,
): Op[] {
  const json = TEMPLATES[template];
  const pageId = uniqueId(json.ids.page, (id) => config.containers.pages.some((p) => p.id === id));
  const page = fill(json.page, locale, {
    $table: tableId,
    $page: pageId,
  }) as AddPage['page'];
  return [{ op: 'addContainer', page }, ...entryOps(config, pageId, page.title, page.icon)];
}

/** Name of the preset table in this language (displayed in inbox page "Save as record" list). */
export function templateTableName(template: Template, locale: Locale): string {
  return localize((TEMPLATES[template].table as { name: Record<Locale, string> }).name, locale);
}

/** Data table created by this template that still exists (ID is base ID or appended with -2, -3...); undefined if none. */
export function templateTableOf(template: Template, config: WorkspaceConfig): string | undefined {
  const base = TEMPLATES[template].ids.table;
  return config.data.tables.find(
    (c) =>
      c.id === base || (c.id.startsWith(`${base}-`) && /^\d+$/.test(c.id.slice(base.length + 1))),
  )?.id;
}

/** Data tables created by this template but not yet used by any page (feature done first, page added later, D-191). */
export function templateCollectionWithoutPage(
  template: DataTemplate,
  config: WorkspaceConfig,
): string | undefined {
  const base = TEMPLATES[template].ids.table;
  const shown = new Set(
    config.containers.pages.flatMap((p) =>
      allComponents(p).flatMap((c) => {
        const id = componentCollection(c);
        return id === null ? [] : [id];
      }),
    ),
  );
  return config.data.tables.find(
    (c) => (c.id === base || c.id.startsWith(`${base}-`)) && !shown.has(c.id),
  )?.id;
}

export type NewPreset = NewTablePreset | 'blank';

/** Table being edited on the new form page (D-444): not yet written to config, created only when clicking "Save". */
export function draftTable(preset: NewPreset, config: WorkspaceConfig, locale: Locale): Collection {
  return templateCollectionOp(preset, config, locale).table as unknown as Collection;
}

/**
 * Modifications to create table when clicking "Save": data table, page, and entry point. If
 * fields still exist, use preset's own page; if user removed fields (preset page might reference
 * them) or built a table from scratch: use "blank" page, displaying first two text fields in
 * list.
 */
export function draftTableOps(
  table: Collection,
  preset: NewPreset,
  config: WorkspaceConfig,
  locale: Locale,
): Op[] {
  const json = TEMPLATES[preset];
  const original = (json.table as { fields: { id: string }[] }).fields;
  const intact =
    preset !== 'blank' && original.every((f) => table.fields.some((d) => d.id === f.id));
  const pageId = uniqueId(json.ids.page, (id) => config.containers.pages.some((p) => p.id === id));
  const page = fill((intact ? json : TEMPLATES.blank).page, locale, {
    $table: table.id,
    $page: pageId,
  }) as Record<string, unknown> & {
    title: string;
    icon?: Page['icon'];
    blocks: { id: string; show?: Record<string, unknown> }[];
  };
  page.title = table.name;
  const header = page.blocks.find((b) => b.id === 'title');
  if (header?.show) header.show.title = table.name;
  if (!intact) {
    const texts = table.fields.filter((f) => f.type === 'text').map((f) => f.id);
    const list = page.blocks.find((b) => b.id === 'entries');
    if (list?.show) {
      if (texts[0]) list.show.title = texts[0];
      else delete list.show.title;
      list.show.subtitles = texts.slice(1, 2);
    }
    if (table.icon) page.icon = table.icon as Page['icon'];
  }
  return [
    { op: 'addData', table: table as unknown as AddTable['table'] },
    { op: 'addContainer', page: page as unknown as AddPage['page'] },
    ...entryOps(config, pageId, page.title, page.icon),
  ];
}
