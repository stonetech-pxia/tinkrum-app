import { z } from 'zod';

import type { LayoutMemory } from './memory';
import { MAX_LEARNED_LABELS, type FieldPick } from './rank';

// Layout memory storage, export, and recovery (D-244): one group of layouts per table, stored in a
// key in local app_meta. "Settings -> Data" allows one-tap clearing, exporting to a file (also a
// backup), and restoring from that file. The file contains tag texts, positions, formatting, and
// merchant names, but no amount or date values; each item is validated upon reading, and bad ones
// are discarded. Since version 2, it also includes candidates clicked in the new record form
// (D-394, under another key prefill:picks): one tag and position per field per table, also without
// values. Since version 3, each field also has learned tags (tag texts only), and old files are
// read as usual.

export const LAYOUT_STORE_KEY = 'prefill:layouts';
export const LAYOUT_FILE_FORMAT = 'morph-prefill-memory';
const FILE_VERSION = 3;
/** Maximum layouts stored per table: discard the earliest learned ones when exceeded. */
export const MAX_LAYOUTS_PER_TABLE = 50;

const FIELD_TYPES = [
  'text',
  'note',
  'number',
  'money',
  'checkbox',
  'date',
  'choice',
  'rating',
  'file',
  'link',
  'formula',
] as const;

const hits = z.number().int().min(0).max(9);
const HabitSchema = z.union([
  z.strictObject({
    kind: z.enum(['amount', 'date']),
    label: z.string().max(200),
    offset: z.union([z.literal(0), z.literal(1)]),
    position: z.number().min(0).max(1),
    format: z.string().max(40),
    hits,
    needs: hits.optional(),
  }),
  z.strictObject({
    kind: z.literal('constant'),
    value: z.string().min(1).max(200),
    hits,
    needs: hits.optional(),
  }),
]);

const LayoutSchema = z.strictObject({
  id: z.string().min(1).max(64),
  anchors: z.array(z.string().max(200)).max(40),
  fieldTypes: z.record(z.string().max(64), z.enum(FIELD_TYPES)),
  fields: z.record(z.string().max(64), HabitSchema),
});

/** Table ID -> layouts for this table (in order of learning). */
export type LayoutStore = Record<string, LayoutMemory[]>;

/** Validate each layout individually, discarding bad ones (tampered storage or left over from older versions is prevented from affecting prefilling). */
function cleanStore(raw: unknown): LayoutStore {
  const out: LayoutStore = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [table, list] of Object.entries(raw)) {
    if (!Array.isArray(list)) continue;
    const layouts = list
      .map((l) => LayoutSchema.safeParse(l))
      .filter((r) => r.success)
      .map((r) => r.data as LayoutMemory)
      .slice(-MAX_LAYOUTS_PER_TABLE);
    if (layouts.length > 0) out[table] = layouts;
  }
  return out;
}

/** Read from app_meta storage; missing or corrupted returns empty. */
export function parseLayoutStore(raw: string | null): LayoutStore {
  if (!raw) return {};
  try {
    return cleanStore(JSON.parse(raw));
  } catch {
    return {};
  }
}

export const serializeLayoutStore = (store: LayoutStore): string => JSON.stringify(store);

/** Total number of layouts remembered. */
export const layoutCount = (store: LayoutStore): number =>
  Object.values(store).reduce((n, list) => n + list.length, 0);

/** Update a table's layout after a successful save (replace if same ID, put new at the end, discard earliest if exceeding limit). */
export function putLayout(store: LayoutStore, table: string, memory: LayoutMemory): LayoutStore {
  const list = (store[table] ?? []).filter((m) => m.id !== memory.id);
  return { ...store, [table]: [...list, memory].slice(-MAX_LAYOUTS_PER_TABLE) };
}

/** Exported file (also a backup): includes format name and version so it can be recognized during recovery. */
export function layoutStoreFile(store: LayoutStore, now: Date, picks: PickStore = {}): string {
  return JSON.stringify(
    {
      format: LAYOUT_FILE_FORMAT,
      version: FILE_VERSION,
      exportedAt: now.toISOString(),
      tables: store,
      picks,
    },
    null,
    2,
  );
}

function readFile(text: string): { tables?: unknown; picks?: unknown } | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const file = data as { format?: unknown; version?: unknown; tables?: unknown; picks?: unknown };
  if (file.format !== LAYOUT_FILE_FORMAT || typeof file.version !== 'number') return null;
  if (file.version > FILE_VERSION) return null;
  return file;
}

/** Read exported file: returns null if format doesn't match; if format matches but contains bad layouts, keeps only the good ones. */
export function readLayoutStoreFile(text: string): LayoutStore | null {
  const file = readFile(text);
  return file && cleanStore(file.tables);
}

// ---- Clicked candidates (D-394) ----

export const PICK_STORE_KEY = 'prefill:picks';

const PickSchema = z.strictObject({
  label: z.string().max(200),
  relY: z.number().min(0).max(1),
  order: z.enum(['DMY', 'MDY']).optional(),
  labels: z
    .array(
      z.strictObject({
        label: z.string().min(1).max(200),
        order: z.enum(['DMY', 'MDY']).optional(),
        rejected: z.literal(true).optional(),
      }),
    )
    .max(MAX_LEARNED_LABELS)
    .optional(),
});

/** Table ID -> Field ID -> last clicked candidate location. */
export type PickStore = Record<string, Record<string, FieldPick>>;

function cleanPicks(raw: unknown): PickStore {
  const out: PickStore = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [table, fields] of Object.entries(raw)) {
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) continue;
    const kept: Record<string, FieldPick> = {};
    for (const [field, pick] of Object.entries(fields).slice(0, 200)) {
      const r = PickSchema.safeParse(pick);
      if (r.success && field.length <= 64) kept[field] = r.data as FieldPick;
    }
    if (Object.keys(kept).length > 0) out[table] = kept;
  }
  return out;
}

/** Read from app_meta storage; missing or corrupted returns empty. */
export function parsePickStore(raw: string | null): PickStore {
  if (!raw) return {};
  try {
    return cleanPicks(JSON.parse(raw));
  } catch {
    return {};
  }
}

export const serializePickStore = (store: PickStore): string => JSON.stringify(store);

/** Total number of fields remembered. */
export const pickCount = (store: PickStore): number =>
  Object.values(store).reduce((n, fields) => n + Object.keys(fields).length, 0);

/** User clicked a candidate: record this occurrence for this field in this table (replacing the previous one). */
export function putPick(
  store: PickStore,
  table: string,
  field: string,
  pick: FieldPick,
): PickStore {
  return { ...store, [table]: { ...store[table], [field]: pick } };
}

/** Read clicked candidates from exported file: returns null if format doesn't match; version 1 files have none and are empty. */
export function readPickStoreFile(text: string): PickStore | null {
  const file = readFile(text);
  return file && cleanPicks(file.picks);
}
