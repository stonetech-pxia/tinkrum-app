import type { z } from 'zod';

import { ICON_NAMES } from './schema-base';
import { ID_MESSAGE } from './schema-primitives';
import { closest, didYouMean, idFrom } from './suggest';

// 校验问题的文字（发给模型修正，D10）。z.union 全部分支都不合格时只报 Invalid input，模型不知道哪里错：
// 这里展开到最接近的分支，报出具体的路径和问题。

type Issue = z.ZodError['issues'][number];

interface Line {
  path: PropertyKey[];
  code: string;
  message: string;
  /** 字面量不对时可选的值。 */
  values?: readonly unknown[];
  /** 判别的键（look、type、kind）不是任何一个可选的值时：键名和可选的值。 */
  discriminator?: { key: string; options: readonly unknown[] };
}

/** 这一支离输入有多远：类型都不对的最远，判别的字面量（kind、every）不对、多了键的次之，然后看问题个数。 */
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

/** 每一支都说这个键不对（do 拼错）时，把各支要的值合起来：只说第一支要的 "create" 会把模型带错。 */
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
  // 判别的键（look、op、type）不是任何一个可选的值时没有分支可以展开。
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

/** 记录块的这些地方写的是字段 ID，模型常写成要显示的文字。 */
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
/** 记录块的 show.title 等处写的是要显示的文字（有空格、中文，或者像 "Calendar" 这样的一个词），不是写错的 id。 */
const looksLikeText = (value: string) =>
  /\s|[^\x00-\x7f]/.test(value) || /^[A-Z][a-z]*$/.test(value);
const ID_RULE = 'lowercase letters, digits and -, starting with a letter';
const ICON_MESSAGES = new Set([
  'icon must be a listed icon name or a single emoji',
  'icon must be a listed icon name, a single emoji or my:<id> of a drawn icon',
]);

/**
 * 有文件原文时（检查别的 AI 写的 App 文件，D-597）：说出写的是什么、该怎么改。照着改不了的照旧（undefined）。
 * Tink 那边不传原文，说法不变。
 */
function withFix(line: Line, where: string, value: unknown): string | undefined {
  if (line.message === ID_MESSAGE && typeof value === 'string') {
    const place = FIELD_ID_PLACE.exec(where);
    if (place && looksLikeText(value))
      return `${show(value)} is text, but show.${place[1]} takes a field id of the block's table; put text in a header block or the page title`;
    // 只要 id 的地方写成了目标（"page:x"）：只写后面的 id。
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
 * 一个 zod 错误的每个问题一行：「路径: 问题」。给了原文（input.value）时，每行再说写的是什么、该怎么改（D-597）。
 */
export function issueLines(error: z.ZodError, input?: { value: unknown }): string[] {
  return error.issues.flatMap((issue) => expand(issue, [])).map((line) => text(line, input));
}
