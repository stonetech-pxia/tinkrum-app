import { z } from 'zod';

import { t } from '../messages';
import { OPTION_COLOR_NAMES } from '../option-colors';
import { IdSchema, boundedText } from '../schema-primitives';
import { defineField, fieldBase, type FieldDefinitionOf } from './define';

/**
 * An option. D-568: value is the numeric representation of this option (for formulas; ignored in
 * sorting and statistics), color is a named color (option-colors.ts; used for color-by-value,
 * calendar, pie charts; unwritten ones fall back to sequential colors).
 */
export const ChoiceOptionSchema = z.strictObject({
  id: IdSchema,
  label: boundedText(1, 40),
  value: z.number().finite().optional(),
  color: z.enum(OPTION_COLOR_NAMES).optional(),
});

const schema = z.strictObject({
  ...fieldBase,
  type: z.literal('choice'),
  options: z.array(ChoiceOptionSchema).min(1).max(50),
  /** Allows multiple selections (D-607): stored value is a list of option IDs. */
  multiple: z.literal(true).optional(),
  /** An option ID; can also be multiple IDs for multi-select. */
  default: z.union([IdSchema, z.array(IdSchema).min(1).max(50)]).optional(),
});

type ChoiceField = z.infer<typeof schema>;

const isOption = (f: { options: { id: string }[] }, v: unknown) =>
  typeof v === 'string' && f.options.some((o) => o.id === v);

/** Multi-select field (D-607). */
export const isMultipleChoice = (f: { type: string; multiple?: true | undefined } | undefined) =>
  f?.type === 'choice' && f.multiple === true;

/**
 * Stored options that still exist, in option order: multi-select stores a list, single ID stored
 * before conversion to multi-select is treated as a single item; deleted options are ignored.
 */
export function pickedOptions(f: { options: { id: string }[] }, raw: unknown): string[] {
  const list: unknown[] = Array.isArray(raw) ? raw : [raw];
  return f.options.filter((o) => list.includes(o.id)).map((o) => o.id);
}

/** Told to the AI: multi-select fields have multiple values and cannot be used where a single option is expected (D-607). */
export const MULTIPLE_CHOICE_NOT_ONE = 'picks several options, so it is not one value';

/**
 * Single-select: value is an option ID; sorted by option order, statistics can group by it
 * (D-248). Multi-select (multiple, D-607): value is a list of option IDs (in option order, empty
 * list = none selected); sorted by first selected item; 'is' filter means 'contains', 'isNot'
 * means 'does not contain'; grouping counts a record for each item it selected. When a
 * single-select field contains a list (undo/restore old versions when converting multi-select
 * back to single-select), it is display-only; reading, filtering, and grouping treat it as
 * unselected, and storing to other fields leaves it as-is (data.ts prepareRecordValues).
 */
export const choiceField: FieldDefinitionOf<'choice', typeof schema> = defineField({
  type: 'choice',
  schema,
  label: ['单选', 'choice'],
  read: (f, raw) => {
    if (f.multiple) {
      const picked = pickedOptions(f, raw);
      return picked.length > 0 ? picked : undefined;
    }
    return isOption(f, raw) ? (raw as string) : undefined;
  },
  shown: (f, raw) => {
    if (!f.multiple && !Array.isArray(raw)) return isOption(f, raw) ? (raw as string) : undefined;
    const picked = pickedOptions(f, raw);
    return picked.length > 0 ? picked : undefined;
  },
  write: (f, input) => {
    if (!f.multiple) return isOption(f, input) ? { value: input as string } : { issue: 'invalid' };
    const list: unknown[] = Array.isArray(input) ? input : [input];
    if (!list.every((v) => isOption(f, v))) return { issue: 'invalid' };
    const picked = pickedOptions(f, list);
    return { value: picked.length > 0 ? picked : '' };
  },
  format: (f, v, locale) =>
    pickedOptions(f, v)
      .map((id) => f.options.find((o) => o.id === id)!.label)
      .join(t(locale, 'separatorList')),
  // Multi-select: 'is' / 'isNot' value is also an option ID (list only for 'is', conditions.ts).
  filter: { is: isOption },
  // Multi-select sorts by the first selected item.
  sort: (f, v) => f.options.findIndex((o) => o.id === pickedOptions(f, v)[0]),
  // D-569: formula value is the selected option's value; empty when unselected or the selected option has no value (like empty numbers).
  formula: 'number',
  formulaNumber: (f, v) => (f.multiple ? undefined : f.options.find((o) => o.id === v)?.value),
  formulaProblem: (f) =>
    f.multiple
      ? `a choice field that ${MULTIPLE_CHOICE_NOT_ONE} (not one number); a formula can't use it`
      : f.options.some((o) => o.value !== undefined)
        ? undefined
        : `a choice field where none of its options has a value; give the options the numbers they stand for, e.g. options: [{id: "monthly", label: "Monthly", value: 12}]`,
  titleRank: 3,
  check: (f, { collection }) => {
    const seen = new Set<string>();
    const dup = new Set<string>();
    for (const o of f.options) (seen.has(o.id) ? dup : seen).add(o.id);
    const at = `${collection.id}.${f.id}`;
    return [
      ...[...dup].map((id) => ({ code: 'duplicate', message: `option ${id} in ${at}` })),
      ...defaultProblems(f).map((message) => ({ code: 'data', message: `${at}: ${message}` })),
    ];
  },
  ai: {
    doc: `{options: [{id, label, value?: a number the option stands for (e.g. high = 3, monthly = 12), color?: ${OPTION_COLOR_NAMES.join(' | ')}}] (1-50), multiple?: true (several options per entry, rule 69), default?: optionId (multiple: a list of option ids)} (color is how the option is drawn wherever entries are coloured by this field; options without it take colours by their order)`,
  },
  example: {
    id: 'category',
    name: 'Category',
    type: 'choice',
    options: [
      { id: 'food', label: 'Food', value: 1 },
      { id: 'other', label: 'Other' },
    ],
  },
  exampleValue: 'food',
});

/** Default value problems: single-select is an option; multi-select can be several, non-duplicating. */
function defaultProblems(f: ChoiceField): string[] {
  const d = f.default;
  if (d === undefined) return [];
  if (Array.isArray(d) && !f.multiple)
    return ['default is a list, but only a field with multiple: true picks several options'];
  const ids = [d].flat();
  const missing = ids.filter((id) => !isOption(f, id));
  if (missing.length > 0) return [`default ${missing.join(', ')} is not an option`];
  if (new Set(ids).size < ids.length) return ['default lists an option more than once'];
  return [];
}
