import type { z } from 'zod';

import type { Field, Locale, Localized } from '../schema';

// Action contract: each action declares its input type -> output type, parameter schema, and
// parameter UI metadata. Only registered actions can appear in workflows; implementation is
// provided by tool-* packages and the app runtime, whereas this describes the contract only.

/**
 * Types of values passed between steps (D-060). files is the parent type of images, pdf, zip,
 * video, and audio. video and audio added together (D-140): audio actions are provided by future
 * audio tools.
 */
export const VALUE_TYPES = [
  'images',
  'pdf',
  'files',
  'zip',
  'video',
  'audio',
  'text',
  'records',
] as const;
export type ValueType = (typeof VALUE_TYPES)[number];

const FILE_SUBTYPES: readonly ValueType[] = ['images', 'pdf', 'zip', 'video', 'audio', 'files'];

/** Checks whether an actual value type is compatible when an action accepts types in accepted. */
export function acceptsType(accepted: readonly ValueType[], actual: ValueType): boolean {
  if (accepted.includes(actual)) return true;
  return accepted.includes('files') && FILE_SUBTYPES.includes(actual);
}

/** Whether an action can accept a value of type actual: included in accepted types and not in rejects. */
export const actionAccepts = (action: ActionDefinition, actual: ValueType): boolean =>
  acceptsType(action.input, actual) && !action.rejects?.includes(actual);

/** File value types: files is the parent type of the others (listed first, searched in this order for the first step). */
export const FILE_VALUE_TYPES = [
  'files',
  'images',
  'pdf',
  'video',
  'audio',
  'zip',
] as const satisfies readonly ValueType[];
export type HandedFileType = (typeof FILE_VALUE_TYPES)[number];

/**
 * Values the container can pass to tools (founder set in conversation 2026-11-04, added files on
 * 2026-11-05): record page and single record blocks pass this entry (records), fields pass their
 * values (text), lists pass currently selected records (records); attachment fields pass internal
 * files (files, copies, D-442). Quick actions requiring these as the first step do not need input
 * steps; inbox and desktop files are not passed this way (D-115).
 */
export const HANDED_TYPES = ['text', 'records', 'files'] as const satisfies readonly ValueType[];
export type HandedType = (typeof HANDED_TYPES)[number];

/** File type the container should pass when the first step receives files: files accepts any file, otherwise the first accepted file type. */
export const handedFileTypeOf = (action: ActionDefinition): HandedFileType | null =>
  FILE_VALUE_TYPES.find((type) => actionAccepts(action, type)) ?? null;

/** What container value this action expects when acting as the first step; input actions are excluded. */
export const handedTypeOf = (action: ActionDefinition): HandedType | null =>
  (['text', 'records'] as const).find((type) => actionAccepts(action, type)) ??
  (handedFileTypeOf(action) !== null ? 'files' : null);

/** Steps requiring manual user operation on device (TOOLS_DESIGN §4). AI only determines where they appear and cannot see operation contents. */
export const LOCAL_STEP_KINDS = [
  'crop',
  'reorder',
  'pages',
  'corners',
  'redact',
  'annotate',
  'sign',
  'fillForm',
  'trimMedia',
  'frameMedia',
  'recordEntry',
] as const;
export type LocalStepKind = (typeof LOCAL_STEP_KINDS)[number];

export const PERMISSIONS = [
  'files.pick',
  'files.write',
  'photos.save',
  'camera',
  'microphone',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export type ParamUnit = 'px' | 'KB' | 'MB' | '%' | '°' | 'mm' | 'pt' | 'in';

/** Localized unit labels: French KB and MB are Ko and Mo. */
export const paramUnitLabel = (unit: ParamUnit, locale: Locale): string =>
  locale === 'fr' && unit === 'KB' ? 'Ko' : locale === 'fr' && unit === 'MB' ? 'Mo' : unit;

/** UI metadata for a parameter: used by the editor to generate forms and by runtime prompts. */
export interface ParamField {
  key: string;
  label: Localized;
  /**
   * collection: select a data table (options from config); fields: select fields from this table
   * (uses that table if a collection parameter exists in the same step, otherwise the table of
   * the incoming record; editor lists fields according to the preceding "Read records" step).
   * These two parameter reference config declarations (CHAIN_AUDIT A3): cleanup during
   * validation, table deletion, and field deletion follows them (workflow/refs.ts) rather than
   * hardcoded action IDs. secret: password (D-194, D-199). Excluded from parameter schema, not
   * persisted in config, invisible to AI; prompted at runtime, passed only to this execution
   * (StepContext.secrets), and excluded from run logs.
   */
  kind:
    | 'number'
    | 'choice'
    | 'toggle'
    | 'text'
    | 'nameTemplate'
    | 'color'
    | 'collection'
    | 'fields'
    | 'secret';
  /**
   * collection parameter: stores the incoming value into this table (log an entry, D-187). The
   * table must contain appropriate fields: attachment fields for files, long text or text fields
   * for text.
   */
  receives?: boolean;
  /** Restricts incoming records to this table; cannot be passed from other tables. */
  bindsInput?: boolean;
  /** Which collection parameter the fields parameter references; defaults to input record's table if omitted. */
  collectionKey?: string;
  /** Permitted types for field selectors; single field selection is still stored as an array of field IDs. */
  fieldTypes?: readonly Field['type'][];
  single?: boolean;
  textFormat?: 'email' | 'phone' | 'url';
  builtInCreated?: boolean;
  /** Multiline text (text-to-PDF, QR code content). */
  multiline?: boolean;
  unit?: ParamUnit;
  min?: number;
  max?: number;
  step?: number;
  /** Initial value of a numeric parameter when first added (uses min if absent): e.g., page numbers starting at 1, font size 10. */
  initial?: number;
  /** Meaning when a numeric parameter is 0 (e.g., "unlimited size"): description only contains this sentence, form displays "0 = unlimited". */
  zeroMeans?: Localized;
  options?: readonly { value: string | number; label: Localized }[];
  /** Display only when specific parameters take certain values, e.g., display long edge pixels only when "by long edge" is selected. */
  showIf?: { key: string; equals: readonly (string | number | boolean)[] };
  /**
   * false: default value is correct, no need to prompt each time (e.g., recognition language
   * "auto", D-278). When using this action alone in a room, if all parameters are false, it runs
   * directly without showing the parameter panel (D-363, deskToolAsks in desk/tools.ts).
   */
  ask?: boolean;
  /** Must be configured in quick action settings; cannot change output type or config references at runtime. */
  fixed?: boolean;
  /** User-written text (watermarks, text stamps): replaced with placeholders before sending to AI (D-065). */
  private?: boolean;
  /** secret must be entered twice and match (adding PDF password, D-194). */
  confirm?: boolean;
  /** toggle displays as on when this parameter is omitted (action treats omission as on, e.g., scan flattening, D-274). */
  defaultOn?: boolean;
}

/** Common presets: one-click fill for a parameter group, e.g., "Passport 35x45", "4 MB". */
export interface ParamPreset {
  id: string;
  label: Localized;
  values: Record<string, unknown>;
}

export type OutputSpec = ValueType | 'same' | ((params: Record<string, unknown>) => ValueType);

export interface ActionDefinition {
  id: string;
  label: Localized;
  /** Dynamic step name based on parameters (e.g., "Select photos" renamed to "Take photo" when source is camera); uses label if omitted or returns undefined. */
  labelFor?: (params: Record<string, unknown>) => Localized | undefined;
  /** One-sentence description, displayed in action selector and sent to AI. */
  description: Localized;
  /** Accepted input types; empty array indicates an input action (must be step 1). */
  input: readonly ValueType[];
  /** Subtypes that cannot be processed despite accepting files (e.g., PDF merge does not accept video and audio). */
  rejects?: readonly ValueType[];
  output: OutputSpec;
  params: z.ZodType<Record<string, unknown>>;
  fields: readonly ParamField[];
  presets?: readonly ParamPreset[];
  /** Steps requiring local user operation. */
  local?: LocalStepKind;
  /**
   * Open this text as a link of the specified type (phone call, SMS, email, web URL): links are
   * generated solely by core's fieldLink rules. Button hidden on record page if the field value
   * is mismatched (D-428).
   */
  opensLink?: 'phone' | 'message' | 'email' | 'url';
  /** When receiving a single record: whether this entry is compatible with this action (cannot generate vCard if business card content is empty). Defaults to compatible. */
  recordFits?: (fields: readonly Field[], values: Readonly<Record<string, unknown>>) => boolean;
  /** Required expansion pack (D-064). */
  pack?: string;
  /** When a pack depends on parameters (such as the language pack for text recognition): returns the pack that must be ensured installed for this run, which will be downloaded along with its dependencies. */
  packFor?: (params: Record<string, unknown>) => string | undefined;
  requires: readonly Permission[];
  /**
   * Prompt for the AI (in English, sent to the model with the action catalog): when the user says
   * X, use this action, how to set parameters, what precedes/follows it, and what to remind in
   * notes. Prompt rule 20 keeps only general workflow-building rules. If changed, run affected
   * evals.
   */
  ai?: string;
  /**
   * Rules specific to this action to teach the AI separately (like component `ai.rule`): `n` is
   * the number in the prompt's `## Rules` section, taking the number of the current last rule
   * plus 1. `text` is in English; if changed, run affected evals.
   */
  aiRules?: readonly { n: number; text: string }[];
  /**
   * Step phrasing recognized by built-in rules (mock AI), used in sentences like "Create a quick
   * action: select photos, compress to 500KB, share" (D-265). Matched as full phrases; phrasings
   * across different actions must not overlap (checked by `workflow-phrases.test.ts`).
   */
  phrases?: readonly StepPhraseRule[];
}

/** A step phrasing rule: `match` matches the phrase, `step` provides the parameters (empty when omitted). */
export interface StepPhraseRule {
  match: RegExp;
  step?: (
    m: RegExpMatchArray,
    locale: Locale,
  ) => {
    params: Record<string, unknown>;
    /** Parameters asked at each run. */
    ask?: string[];
    /** Log an expense (D-187): table name mentioned in the sentence; empty string means none was mentioned. */
    table?: string;
  };
}

/** Output type of the action given parameters and input types. */
export function outputTypeOf(
  action: ActionDefinition,
  params: Record<string, unknown>,
  input: ValueType | null,
): ValueType | null {
  if (action.output === 'same') return input;
  if (typeof action.output === 'function') return action.output(params);
  return action.output;
}

export const isSourceAction = (action: ActionDefinition) => action.input.length === 0;
