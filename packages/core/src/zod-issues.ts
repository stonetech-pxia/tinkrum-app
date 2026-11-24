import type { z } from 'zod';

import { ICON_NAMES } from './schema-base';
import { ID_MESSAGE } from './schema-primitives';
import { closest, didYouMean, idFrom } from './suggest';

// Validation issue text (sent to model for correction, D10). When all branches of z.union fail, it
// only reports Invalid input and the model does not know what is wrong: here it expands to the
// closest branch, reporting the specific path and issue.

type Issue = z.ZodError['issues'][number];

interface Line {
  path: PropertyKey[];
  code: string;
  message: string;
  /** Optional values when literal is incorrect. */
  values?: readonly unknown[];
  /** When the discriminated key (look, type, kind) is not any of the optional values: key name and optional values. */
  discriminator?: { key: string; options: readonly unknown[] };
}

/** How far this branch is from the input: completely wrong types are furthest, incorrect literal (kind, every) or extra keys are secondary, then number of issues. */
function distance(lines: readonly Line[], depth: number): number {
  let score = lines.length;
  for (const line of lines) {
    if (line.code === 'invalid_type' && line.path.length === depth) score += 1000;
    if (line.code === 'invalid_value' && line.path.length === depth + 1) score += 100;
    if (line.code === 'unrecognized_keys' && line.path.length === depth) score += 100;
  }
  return score;
}

const samePath = (a: Line, b: Line) => a.path.join('.') === b.path.join('.');

/** When every branch says this key is incorrect (e.g. do misspelled), combine the values required by each branch: only saying the first branch's required "create" leads the model astray. */
function withAllValues(line: Line, branches: readonly Line[][]): Line {
  if (!line.values) return line;
  const values = branches.flatMap((lines) =>
    lines.filter((l) => l.values && samePath(l, line)).flatMap((l) => l.values!),
  );
  const options = [...new Set(values)].map((v) => JSON.stringify(v)).join('|');
  return { ...line, values, message: `Invalid option: expected one of ${options}` };
}

function expand(issue: Issue, base: readonly PropertyKey[]): Line[] {
  const path = [...base, ...issue.path];
  if (issue.code === 'invalid_value')
    return [{ path, code: issue.code, message: issue.message, values: issue.values }];
  if (issue.code !== 'invalid_union')
    return [{ path, code: issue.code ?? 'custom', message: issue.message }];
  // When the discriminated key (look, op, type) is not any of the optional values, there are no branches to expand.
  if (issue.errors.length === 0) {
    const key = issue.discriminator;
    const options = (issue as { options?: readonly unknown[] }).options ?? [];
    return [
      {
        path,
        code: issue.code,
        message: key ? `not a valid ${key}` : issue.message,
        ...(key ? { discriminator: { key, options } } : {}),
      },
    ];
  }
  const branches = issue.errors.map((branch) => branch.flatMap((i) => expand(i, path)));
  const best = branches.reduce((a, b) =>
    distance(b, path.length) < distance(a, path.length) ? b : a,
  );
  return best.map((line) => withAllValues(line, branches));
}

/** Record block positions of this form are field IDs, which the model often writes as display text. */
const FIELD_ID_PLACE = /(?:^|\.)show\.(title|subtitles|trailing)(?:\.\d+)?$/;

function text(line: Line, input?: { value: unknown }): string {
  const where = line.path.map(String).join('.');
  if (input) {
    const better = withFix(line, where, valueAt(input.value, line.path));
    if (better) return `${where || '(root)'}: ${better}`;
  }
  const place = line.message === ID_MESSAGE ? FIELD_ID_PLACE.exec(where) : null;
  const what = place
    ? `record blocks' show.${place[1]} is a field id, use a header block or a page title for text`
    : line.message;
  return `${where || '(root)'}: ${what}`;
}

function valueAt(root: unknown, path: readonly PropertyKey[]): unknown {
  let value = root;
  for (const key of path) {
    if (value === null || typeof value !== 'object') return undefined;
    value = (value as Record<PropertyKey, unknown>)[key];
  }
  return value;
}

const show = (value: unknown) => JSON.stringify(value);
const choices = (values: readonly unknown[]) => values.map(show).join('|');
const strings = (values: readonly unknown[]) => values.filter((v) => typeof v === 'string');
/** Record block show.title and similar places written as display text (containing spaces, Chinese, or a single word like "Calendar"), not an incorrect ID. */
const looksLikeText = (value: string) =>
  /\s|[^\x00-\x7f]/.test(value) || /^[A-Z][a-z]*$/.test(value);
const ID_RULE = 'lowercase letters, digits and -, starting with a letter';
const ICON_MESSAGES = new Set([
  'icon must be a listed icon name or a single emoji',
  'icon must be a listed icon name, a single emoji or my:<id> of a drawn icon',
]);

/**
 * When file original text is available (checking other AI-written App files, D-597): state what
 * is written and how to fix it. Unfixable ones remain as is (undefined). Tink does not pass the
 * original text, description remains unchanged.
 */
function withFix(line: Line, where: string, value: unknown): string | undefined {
  if (line.message === ID_MESSAGE && typeof value === 'string') {
    const place = FIELD_ID_PLACE.exec(where);
    if (place && looksLikeText(value))
      return `${show(value)} is text, but show.${place[1]} takes a field id of the block's table; put text in a header block or the page title`;
    // Where only an ID is expected but a target is written ("page:x"): write only the ID after it.
    const target = /^(?:page|tool|app):(.+)$/.exec(value)?.[1];
    if (target !== undefined && idFrom(target) === target)
      return `${show(value)} is not a valid id; this place takes the id alone: write ${show(target)}`;
    const id = idFrom(value);
    const everywhere = where.endsWith('.id') ? ' and use it everywhere this id is referenced' : '';
    return `${show(value)} is not a valid id (${ID_RULE})${id ? `; write ${show(id)}${everywhere}` : ''}`;
  }
  if (line.discriminator) {
    const { key, options } = line.discriminator;
    const guess = typeof value === 'string' ? didYouMean(value, strings(options)) : '';
    return `${show(value)} is not a valid ${key}; use one of ${choices(options)}${guess}`;
  }
  if (line.code === 'invalid_value' && line.values && value !== undefined) {
    const guess = typeof value === 'string' ? didYouMean(value, strings(line.values)) : '';
    return `${show(value)} is not allowed here; use one of ${choices(line.values)}${guess}`;
  }
  if (line.code === 'invalid_type' && value === undefined) {
    const expected = /expected (\w+)/.exec(line.message)?.[1];
    return `missing; this is required${expected ? ` (${expected})` : ''}`;
  }
  if (line.code === 'unrecognized_keys')
    return `${line.message}; remove it, it does not belong here`;
  if (value === undefined || (typeof value === 'object' && value !== null)) return undefined;
  const guess =
    ICON_MESSAGES.has(line.message) && typeof value === 'string'
      ? closest(value, ICON_NAMES)
      : undefined;
  return `${line.message} (got ${show(value)}${guess ? `; did you mean ${show(guess)}?` : ''})`;
}

/**
 * One line per issue for a Zod error: "path: issue". When original text (input.value) is
 * provided, each line additionally states what is written and how to fix it (D-597).
 */
export function issueLines(error: z.ZodError, input?: { value: unknown }): string[] {
  return error.issues.flatMap((issue) => expand(issue, [])).map((line) => text(line, input));
}
