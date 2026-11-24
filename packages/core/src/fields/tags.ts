import { z } from 'zod';

import { defineField, fieldBase, isText, type FieldDefinitionOf } from './define';

/** Maximum number of tags per record, and maximum length per tag. */
export const MAX_RECORD_TAGS = 20;
export const MAX_TAG_LENGTH = 30;

const schema = z.strictObject({ ...fieldBase, type: z.literal('tags') });

/** Comparison logic for tags: case-insensitive, full-width and half-width characters treated equally. */
export const tagKey = (tag: string) => tag.normalize('NFKC').toLowerCase();

/** Trims surrounding whitespace, removes empty and duplicate tags (keeping the first occurrence), and skips non-text entries. */
export function cleanTags(raw: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const tag = item.trim();
    if (tag === '' || seen.has(tagKey(tag))) continue;
    seen.add(tagKey(tag));
    tags.push(tag);
  }
  return tags;
}

/**
 * Tags (set by the founder 2026-11-04): Values are a set of strings stored directly within the
 * record. No tag names are stored in the config (Invariant 14); available tags are computed
 * dynamically from records (tagsInRecords), and tags without records cease to exist. The AI knows
 * this field exists but cannot see its values (Invariant 2). Filters in config only check whether
 * tags are present (emptyOnly): the 'is' value specifies the tag name and cannot be written
 * directly into config; temporary browse filters are kept in memory (browseFilter).
 */
export const tagsField: FieldDefinitionOf<'tags', typeof schema> = defineField({
  type: 'tags',
  schema,
  label: ['标签', 'tags'],
  read: (_f, raw) => {
    if (!Array.isArray(raw)) return undefined;
    const tags = cleanTags(raw)
      .filter((tag) => tag.length <= MAX_TAG_LENGTH)
      .slice(0, MAX_RECORD_TAGS);
    return tags.length > 0 ? tags : undefined;
  },
  write: (_f, input) => {
    const list: unknown[] = Array.isArray(input) ? input : [input];
    if (!list.every((x) => typeof x === 'string')) return { issue: 'invalid' };
    const tags = cleanTags(list);
    if (tags.length > MAX_RECORD_TAGS || tags.some((tag) => tag.length > MAX_TAG_LENGTH))
      return { issue: 'tooLong' };
    return { value: tags.length > 0 ? tags : '' };
  },
  format: (_f, v) => (Array.isArray(v) ? v.join(', ') : ''),
  filter: { is: isText, emptyOnly: true },
  sort: false,
  ai: {
    doc: "(the entry's own tags, as many as the user likes: the user types them in the entry form, and tag names live only in the entries, so never name one: not in a filter, a value or a default; filters only take isEmpty / isNotEmpty; to let the user filter by tag use show.browse.filter)",
  },
  example: { id: 'labels', name: 'Tags', type: 'tags' },
  exampleValue: ['vip', 'client'],
});
