import { z } from 'zod';

import type { DescribeContext } from '../describe';
import type { RecordToolKind, ToolUseAs } from '../record-ops-schema';
import type { Registry } from '../registry';
import type { Page, WorkspaceConfig } from '../schema';
import { BackdropSchema, IdSchema, type Collection, type FieldType } from '../schema-base';
import { filterSchema } from '../schema-primitives';

// Component registry (v34: containers): one definition per look (steps to add a new look in
// docs/COMPONENTS.md); structural validation, reference checks, draft notes, long-press editing,
// and prompts are all read from here, eliminating type-specific switch statements. Every block
// shares the same keys (D-368): look for rendering, show for look-specific options, source for data
// sources (read-only), tools for referenced tools (all write operations are here), opens for
// navigation targets (stateless), children (group only).

/** Look settings available on every block. tone specifies text color for text blocks and background color for card blocks. */
export const ComponentStyleSchema = z.strictObject({
  align: z.enum(['start', 'center']).optional(),
  tone: z.enum(['default', 'primary', 'secondary', 'tertiary', 'muted']).optional(),
  size: z.enum(['small', 'medium', 'large']).optional(),
  /** Uses an image instead of a background color (D-258, schemaVersion 18); available only on card blocks where edit.backdrop is true in definition. */
  backdrop: BackdropSchema.optional(),
});
export type ComponentStyle = z.infer<typeof ComponentStyleSchema>;

/**
 * Blocks display only when a table has some or no records (D-424). Affects rendering only, no
 * state changes. filter (D-579): counts only records matching these conditions, using list filter
 * syntax, including computed fields from summaries/lookups (e.g., show confirmation prompt when
 * "unbilled subscriptions this month" > 0).
 */
export const ShowIfSchema = z.strictObject({
  table: IdSchema,
  has: z.enum(['some', 'none']),
  filter: filterSchema(5).optional(),
});
export type ShowIf = z.infer<typeof ShowIfSchema>;

/**
 * Pins a block to the top or bottom of the page, preventing it from scrolling with the middle
 * content (determined by founder on 2026-11-04). Simply an attribute of a top-level page block:
 * all traversals (deletion, references, documentation, AI edits) process page blocks normally;
 * grouped blocks cannot have this (validate.ts).
 */
export const PinSchema = z.enum(['top', 'bottom']);
export type Pin = z.infer<typeof PinSchema>;

export const blockBase = {
  id: IdSchema,
  hidden: z.boolean().optional(),
  style: ComponentStyleSchema.optional(),
  showIf: ShowIfSchema.optional(),
  pin: PinSchema.optional(),
};

/** Appearance of entry cards (D-230): row = settings-style single line with an arrow on the right; tile = large icon block. */
export const EntryLookSchema = z.enum(['row', 'tile']);
export type EntryLook = z.infer<typeof EntryLookSchema>;

/**
 * What config references are pointed to by block keys (read by generic reference helpers like
 * reference checks and blockTable). Keys are paths ("source.table", "show.title",
 * "source.group.by"):
 * - table: data table ID; field and filter in the same block refer to this table ("$files" is the
 * system table, see files-table.ts).
 * - field: fields of this table (or createdAt / updatedAt), can be a single field or array of
 * fields; types restrict field types (system fields count as dates), role is the display name in
 * issue text, defaults to key name; one: single-choice field must be single-select (multi-select
 * not allowed, D-607).
 * - filter: filter conditions for this table.
 * - target: page, system entry point, tool:<id>, package:<id>, or {file} (opens).
 * - package: installed = installed tool pack (single), catalog = tool pack catalog (group).
 */
export type ComponentRef =
  | { to: 'table' }
  | { to: 'field'; role?: string; types?: readonly FieldType[]; one?: true }
  | { to: 'filter' }
  | { to: 'target' }
  | { to: 'package'; in: 'installed' | 'catalog' };

/** Field types required for sum, average, etc. (numeric flag in field definitions). */
export { NUMERIC_FIELD_TYPES } from '../fields';

/** System field present in every record, used as a date. */
export const isSystemField = (id: string) => id === 'createdAt' || id === 'updatedAt';

export interface CheckContext {
  config: WorkspaceConfig;
  registry: Registry;
  page: Page;
  /** Table read by the block (lookup and summary fields are mapped to the fields they display). Present only on table-reading blocks; check is not called when the table does not exist. */
  collection?: Collection;
  /** Outer group (when the block is inside a group). */
  parent?: { id: string; look: 'group' };
}

/** A text that can be edited directly in long-press edit (D-052) (key in show). */
export interface EditableText {
  prop: string;
  /** Matches the length limit in the schema (checked by components.test.ts); also intercepted by the validator when exceeded. */
  max: number;
  optional?: boolean;
  multiline?: boolean;
  /** Supports bold, italic, links, and lists (richtext.ts). */
  rich?: boolean;
}

export type StyleKey = 'tone' | 'align' | 'size';

/**
 * What can be changed in long-press edit (D-052). Lists only appearances actually rendered by the
 * renderer; data blocks cannot have their text changed (only position, color, hiding, and
 * deletion).
 */
export interface ComponentEdit {
  text: EditableText[];
  style: StyleKey[];
  /** User file that can be selected, changed, or removed in long-press edit (opens.file in file slots, D-257): file = a photo or any file from "Files". */
  asset?: 'file';
  /** A card with a background color, which can be replaced by an image (style.backdrop, D-258); the renderer must actually draw it. */
  backdrop?: true;
}

/** Instructions sent to the AI (read by packages/planner/src/prompt.ts, in English). Run affected evaluations if modified. */
export interface ComponentAI {
  /** A line in the prompt appearance list, following the look name: key (? means optional, lists optional values and range) and usage. */
  doc: string;
  /** Which appearance to place after in the prompt; defaults to registration order if omitted. */
  docAfter?: string;
  /** Rule associated with this appearance; n is the rule number. */
  rule?: { n: number; text: string };
}

export const ALL_STYLES: StyleKey[] = ['tone', 'align', 'size'];

/** Issues found during the block's own check. Plain text indicates data issues (code data, prefixed with block ID). */
export type CheckProblem = string | { code: string; message: string };

/**
 * Classification in the registry (v34 "Data · Container · Tool", relation rules 1-6): blocks are
 * containers, read-only; reads specifies what source reads, writes specifies whether tools that
 * write can be attached to the block (in-place quick record tools). tools lists tools attachable
 * to this appearance: as is the trigger mode ("self" = no as specified, executed when the block
 * itself is tapped), do is the kind of quick record, ref is independent tools that can be
 * referenced (quickAction = quick action, pick = core open photo/file), open is "open" on the
 * row.
 */
export interface LookMeta {
  kind: 'container';
  /** Layer it applies to: record lists and forms apply to records, numbers and charts apply to tables (aggregates), file reading uses $files. */
  layer?: 'value' | 'record' | 'table' | 'file' | 'config';
  reads: 'none' | 'table' | 'files' | 'catalog';
  writes: boolean;
  tools?: {
    as: readonly (ToolUseAs | 'self')[];
    do?: readonly RecordToolKind[];
    ref?: readonly ('quickAction' | 'pick')[];
    open?: true;
    /** Maximum count (total). */
    max: number;
  };
}

type Instance<L extends string, X extends z.ZodRawShape> = z.infer<
  ReturnType<typeof lookSchema<L, X>>
>;

export function lookSchema<L extends string, X extends z.ZodRawShape>(look: L, shape: X) {
  return z.strictObject({ ...blockBase, look: z.literal(look), ...shape });
}

export interface LookSpec<L extends string, X extends z.ZodRawShape> extends LookMeta {
  look: L;
  /** Keys other than id / hidden / style / look (show, source, tools, opens, children). */
  shape: X;
  /**
   * Keys checked by generic reference checks (validate.ts); see ComponentRef for path syntax. To
   * check references that require other keys, implement them in check.
   */
  refs?: Readonly<Record<string, ComponentRef>>;
  /**
   * Rules beyond generic checks. Table-reading blocks are checked after field references and
   * before filter conditions; other blocks are checked after page and tool references. Problem
   * messages are sent to the AI for correction, so message wording should be carefully
   * considered.
   */
  check?: (c: Instance<L, X>, ctx: CheckContext) => CheckProblem[];
  /** How to refer to this block in modification descriptions (e.g., "title "Accounting""). */
  describe: (c: Instance<L, X>, config: WorkspaceConfig, ctx: DescribeContext) => string;
  edit: ComponentEdit;
  ai: ComponentAI;
  /**
   * A usable example (excluding id and look): components.test.ts uses it to validate across three
   * languages and generate descriptions, and App's registry-test uses it for rendering.
   * References only items present in sample configs: data table expenses (amount, category, date,
   * note in the bookkeeping template), added tool pack pdf, and its quick action pdf-merge.
   */
  example: Omit<Instance<L, X>, 'id' | 'look'>;
}

/**
 * An appearance definition, plus the complete schema generated from it. Must be explicitly
 * specified in definition files (callbacks reference config types, which are generated from block
 * definitions, so TypeScript cannot infer them without it).
 */
export type LookDefinitionOf<L extends string, X extends z.ZodRawShape> = LookSpec<L, X> & {
  schema: ReturnType<typeof lookSchema<L, X>>;
};

export function defineLook<const L extends string, X extends z.ZodRawShape>(
  spec: LookSpec<L, X>,
): LookDefinitionOf<L, X> {
  return { ...spec, schema: lookSchema(spec.look, spec.shape) };
}

/** Values appearing more than once in the list. */
export function duplicates(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const id of ids) (seen.has(id) ? dup : seen).add(id);
  return [...dup];
}

/** Name of the data table; falls back to ID if the table no longer exists. */
export function collectionName(id: string, config: WorkspaceConfig): string {
  return config.data.tables.find((c) => c.id === id)?.name ?? id;
}

/** Gets a value from a block by path ("source.group.by"). */
export function valueAt(block: unknown, path: string): unknown {
  let v: unknown = block;
  for (const key of path.split('.')) {
    if (typeof v !== 'object' || v === null) return undefined;
    v = (v as Record<string, unknown>)[key];
  }
  return v;
}
