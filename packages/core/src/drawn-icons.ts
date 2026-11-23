import { z } from 'zod';

// 画出来的图标（D-new-extensibility-2）：配置顶层的 icons 是一份图标库，每个图标只有 SVG 的路径数据（几何形状），
// 不收整份 SVG（脚本、外部链接、样式会破坏底线 1、13 和 §3）。用的地方写 "my:<id>"。
// 画布固定 24×24，左上角是原点；默认用一种颜色按 even-odd 填满，stroke: true 时只画线（2 宽，圆头圆角）。
// 颜色总是跟着用它的地方（和自带图形的 9 个图标一样）。

/** 图标库里的 ID。 */
export const DRAWN_ICON_ID = /^[a-z][a-z0-9-]{0,23}$/;
/** 引用画出来的图标的前缀：icon 写 "my:<id>"。 */
export const DRAWN_ICON_PREFIX = 'my:';
/** 一份配置最多几个画出来的图标。 */
export const MAX_DRAWN_ICONS = 40;
/** 一个图标最多几条路径（猫爪这样的图形就有 5 块；大小由下面的字符数管）。 */
export const MAX_DRAWN_ICON_PATHS = 8;
/** 一个图标所有路径加起来最多几个字符。 */
export const MAX_DRAWN_ICON_CHARS = 1500;
/** 画布边长。 */
export const DRAWN_ICON_CANVAS = 24;

export const DrawnIconIdSchema = z
  .string()
  .regex(DRAWN_ICON_ID, 'icon id: a-z first, then a-z, 0-9 or -, at most 24 characters');

const REF = new RegExp(`^${DRAWN_ICON_PREFIX}${DRAWN_ICON_ID.source.slice(1, -1)}$`);

/** 是不是 "my:<id>" 形式的图标值。 */
export const isDrawnIconRef = (value: unknown): value is `my:${string}` =>
  typeof value === 'string' && REF.test(value);

/** "my:<id>" 里的 id；不是这种写法返回 null。 */
export const drawnIconId = (value: unknown): string | null =>
  isDrawnIconRef(value) ? value.slice(DRAWN_ICON_PREFIX.length) : null;

// ---- 路径数据的语法（SVG path 的子集）----

/** 每个命令一段要几个数。 */
const ARGS: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };
const NUMBER = /[+-]?(?:\d+(?:\.\d*)?|\.\d+)/y;
const SEPARATOR = /[\s,]/;

/**
 * 路径数据有什么问题；没问题返回 null。只认 M L H V C S Q T A Z（大小写）、普通的数（没有指数）、空格和逗号；
 * 必须以 M / m 开头；每个命令的数要够（A 一段 7 个，第 4、5 个是 0 或 1 的标志）；和 SVG 一样可以省略重复的命令。
 */
export function pathDataProblem(d: string): string | null {
  let i = 0;
  const skip = () => {
    while (i < d.length && SEPARATOR.test(d[i]!)) i++;
  };
  const startsNumber = () => i < d.length && /[0-9+\-.]/.test(d[i]!);
  const unexpected = () => {
    const ch = d[i]!;
    if ((ch === 'e' || ch === 'E') && i > 0 && /[0-9.]/.test(d[i - 1]!))
      return `numbers cannot use an exponent (at character ${i + 1})`;
    return `"${ch}" is not allowed (at character ${i + 1}); use only M L H V C S Q T A Z and plain numbers`;
  };
  const readNumber = (): boolean => {
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(d);
    if (!m) return false;
    i = NUMBER.lastIndex;
    return true;
  };
  skip();
  if (i >= d.length) return 'is empty';
  if (d[i] !== 'M' && d[i] !== 'm') return 'must start with M or m';
  while (true) {
    skip();
    if (i >= d.length) return null;
    const command = d[i]!;
    const count = ARGS[command.toLowerCase()];
    if (count === undefined) return unexpected();
    i++;
    if (count === 0) continue;
    // 至少一段，后面紧跟着数就是同一个命令再来一段。
    do {
      for (let k = 0; k < count; k++) {
        skip();
        if (command.toLowerCase() === 'a' && (k === 3 || k === 4)) {
          if (d[i] === '0' || d[i] === '1') {
            i++;
            continue;
          }
          return `${command}: argument ${k + 1} must be the flag 0 or 1`;
        }
        if (readNumber()) continue;
        // 数不够：到了结尾或下一个命令；别的字符是不认识的。
        if (i >= d.length || ARGS[d[i]!.toLowerCase()] !== undefined)
          return `${command} needs ${count} numbers per segment`;
        return unexpected();
      }
      skip();
    } while (startsNumber());
  }
}

/** 一个画出来的图标。 */
export const DrawnIconSchema = z.strictObject({
  paths: z.array(z.string()).min(1).max(MAX_DRAWN_ICON_PATHS),
  /** 只画线（2 宽，圆头圆角），什么都不填；不写是按 even-odd 填满。 */
  stroke: z.literal(true).optional(),
});
export type DrawnIcon = z.infer<typeof DrawnIconSchema>;

/** 一个图标的问题（每条一句，说出是哪个图标）。 */
export function drawnIconProblems(id: string, icon: DrawnIcon): string[] {
  const problems: string[] = [];
  icon.paths.forEach((d, n) => {
    const problem = pathDataProblem(d);
    if (problem) problems.push(`icon ${id}: path ${n + 1} ${problem}`);
  });
  const chars = icon.paths.reduce((sum, d) => sum + d.length, 0);
  if (chars > MAX_DRAWN_ICON_CHARS)
    problems.push(
      `icon ${id}: its paths have ${chars} characters; at most ${MAX_DRAWN_ICON_CHARS} in all`,
    );
  return problems;
}

/** 配置顶层的图标库。 */
export const DrawnIconsSchema = z
  .record(DrawnIconIdSchema, DrawnIconSchema)
  .superRefine((icons, ctx) => {
    const ids = Object.keys(icons);
    if (ids.length > MAX_DRAWN_ICONS)
      ctx.addIssue({
        code: 'custom',
        message: `at most ${MAX_DRAWN_ICONS} drawn icons (has ${ids.length})`,
      });
    for (const id of ids)
      for (const message of drawnIconProblems(id, icons[id]!))
        ctx.addIssue({ code: 'custom', message, path: [id, 'paths'] });
  });
export type DrawnIcons = z.infer<typeof DrawnIconsSchema>;

/** 修改里的图标库（setTheme 的 icons）：写了就加上或换掉，null 去掉。 */
export const DrawnIconsPatchSchema = z
  .record(DrawnIconIdSchema, DrawnIconSchema.nullable())
  .superRefine((icons, ctx) => {
    for (const [id, icon] of Object.entries(icons))
      if (icon)
        for (const message of drawnIconProblems(id, icon))
          ctx.addIssue({ code: 'custom', message, path: [id, 'paths'] });
  });

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * 内容里每一处 "my:<id>" 图标（键名是 icon 的地方，哪一层都算）：id 和在哪（路径里有 id 的一层用 id）。
 * 顶层的 icons（图标库本身）不算。
 */
export function drawnIconUses(content: unknown): { id: string; where: string }[] {
  const out: { id: string; where: string }[] = [];
  const walk = (node: unknown, where: string) => {
    if (Array.isArray(node)) {
      node.forEach((item, n) =>
        walk(
          item,
          `${where}.${isObject(item) && typeof item.id === 'string' ? item.id : String(n)}`,
        ),
      );
      return;
    }
    if (!isObject(node)) return;
    for (const [k, v] of Object.entries(node)) {
      if (where === '' && k === 'icons') continue;
      const at = where ? `${where}.${k}` : k;
      const id = k === 'icon' ? drawnIconId(v) : null;
      if (id !== null) out.push({ id, where: at });
      else walk(v, at);
    }
  };
  walk(content, '');
  return out;
}

/** 把内容里 "my:<旧 id>" 换成 "my:<新 id>"（导入 App 文件时 ID 撞了改名用）；返回新的一份。 */
export function renameDrawnIcons<T>(content: T, map: ReadonlyMap<string, string>): T {
  if (map.size === 0) return content;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!isObject(node)) return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      const id = k === 'icon' ? drawnIconId(v) : null;
      const to = id !== null ? map.get(id) : undefined;
      out[k] = to !== undefined ? `${DRAWN_ICON_PREFIX}${to}` : walk(v);
    }
    return out;
  };
  return walk(content) as T;
}
