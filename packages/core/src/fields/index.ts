import { z } from 'zod';

import type { FieldValue, LinkResolver } from '../field-values';
import type { FormulaType } from '../formula';
import type { Locale } from '../schema-primitives';
import { checkboxField } from './checkbox';
import { choiceField } from './choice';
import { dateField } from './date';
import { dateOffsetField } from './date-offset';
import { datetimeField } from './datetime';
import type { Coerced, FieldCheckContext } from './define';
import { durationField } from './duration';
import { fileField } from './file';
import { formulaField } from './formula';
import { linkField } from './link';
import { lookupField } from './lookup';
import { moneyField } from './money';
import { noteField } from './note';
import { numberField } from './number';
import { previousField } from './previous';
import { ratingField } from './rating';
import { rollupField } from './rollup';
import { scheduleField } from './schedule';
import { tagsField } from './tags';
import { textField } from './text';
import { timeField } from './time';

export * from './define';
export {
  ChoiceOptionSchema,
  isMultipleChoice,
  MULTIPLE_CHOICE_NOT_ONE,
  pickedOptions,
} from './choice';
export { ROLLUP_AGGREGATES } from './rollup';
export { SCHEDULE_LAST_DONE_TYPES } from './schedule';
export { cleanTags, MAX_RECORD_TAGS, MAX_TAG_LENGTH, tagKey } from './tags';

/** All field types. New types are added at the end (the order matches the config JSON Schema). */
export const FIELDS = [
  textField,
  noteField,
  numberField,
  moneyField,
  checkboxField,
  dateField,
  choiceField,
  ratingField,
  fileField,
  linkField,
  formulaField,
  timeField,
  datetimeField,
  durationField,
  lookupField,
  rollupField,
  previousField,
  scheduleField,
  tagsField,
  dateOffsetField,
] as const;

type Schemas<D extends readonly { schema: unknown }[]> = {
  -readonly [K in keyof D]: D[K]['schema'];
};

export const FieldSchema = z.discriminatedUnion(
  'type',
  FIELDS.map((d) => d.schema) as Schemas<typeof FIELDS>,
);
export type Field = z.infer<typeof FieldSchema>;
export type FieldType = Field['type'];
export type FieldOf<T extends FieldType> = Extract<Field, { type: T }>;

/** A definition in the registry table, unifying callback parameters as Field (retrieved by type for use). */
export interface FieldDefinition {
  type: FieldType;
  label: [string, string];
  read(field: Field, raw: unknown): FieldValue | undefined;
  shown?(field: Field, raw: unknown): FieldValue | undefined;
  write?(field: Field, input: unknown): Coerced;
  initial?(field: Field, now: Date, today: string): FieldValue | undefined;
  emptyNew?: FieldValue;
  format(field: Field, value: FieldValue, locale: Locale, links?: LinkResolver): string;
  csv?(field: Field, value: FieldValue): string;
  formatAmount?(field: Field, n: number, locale: Locale): string;
  print?: {
    numeric?: true;
    total?: { rank: number; format(field: Field, sum: number, locale: Locale): string };
  };
  formula?: FormulaType;
  formulaNumber?(field: Field, value: FieldValue | undefined): number | undefined;
  formulaProblem?(field: Field): string | undefined;
  numeric?: true;
  inForm?: false;
  filter: {
    is(field: Field, value: unknown): boolean;
    contains?: true;
    compare?: 'number' | 'date' | 'time';
    period?: true;
    emptyOnly?: true;
    schedule?: true;
  };
  day?(field: Field, value: FieldValue): string;
  sort?: false | ((field: Field, value: FieldValue) => FieldValue);
  titleRank?: number;
  convertGroup?: string;
  check?(field: Field, ctx: FieldCheckContext): { code: string; message: string }[];
  ai: { doc: string; docAfter?: string };
  example: Field;
  exampleValue?: FieldValue;
  schema: z.ZodObject;
  kind: 'data';
  layer: 'value';
  access: 'write' | 'read';
}

const BY_TYPE = new Map<string, FieldDefinition>(
  FIELDS.map((d) => [d.type, d as unknown as FieldDefinition]),
);

/** The definition for this field type. */
export function fieldDefinition(type: FieldType): FieldDefinition {
  return BY_TYPE.get(type)!;
}

/** Field types whose statistics and charts can sum and average. */
export const NUMERIC_FIELD_TYPES: readonly string[] = FIELDS.filter((d) => d.numeric).map(
  (d) => d.type,
);
