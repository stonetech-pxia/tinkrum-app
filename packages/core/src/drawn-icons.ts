import { z } from 'zod';

// Drawn icons (D-625): The top-level icons configuration is an icon library where each icon
// contains only SVG path data (geometric shapes), rejecting full SVGs (scripts, external links, and
// styles violate invariants 1, 13, and §3). Referenced as "my:<id>". The canvas is fixed at 24x24
// with the top-left as the origin; it is filled by default with a single color using the even-odd
// rule. When stroke: true is set, only strokes are drawn (width 2, rounded caps and joins). The
// color always follows its usage context (like the 9 built-in graphics).

/** ID in the icon library. */
export const DRAWN_ICON_ID = /^[a-z][a-z0-9-]{0,23}$/;
/** Prefix for referencing drawn icons: write icons as "my:<id>". */
export const DRAWN_ICON_PREFIX = 'my:';
/** Maximum number of drawn icons per configuration. */
export const MAX_DRAWN_ICONS = 40;
/** Maximum number of paths per icon (shapes like cat paws have 5 parts; size is governed by the character count below). */
export const MAX_DRAWN_ICON_PATHS = 8;
/** Maximum total character count across all paths in an icon. */
export const MAX_DRAWN_ICON_CHARS = 1500;
/** Canvas side length. */
export const DRAWN_ICON_CANVAS = 24;

export const DrawnIconIdSchema = z
  .string()
  .regex(DRAWN_ICON_ID, 'icon id: a-z first, then a-z, 0-9 or -, at most 24 characters');

const REF = new RegExp(`^${DRAWN_ICON_PREFIX}${DRAWN_ICON_ID.source.slice(1, -1)}$`);

/** Check whether a value is an icon reference in the form "my:<id>". */
export const isDrawnIconRef = (value: unknown): value is `my:${string}` =>
  typeof value === 'string' && REF.test(value);

/** Extract the id from "my:<id>"; returns null if not in this format. */
export const drawnIconId = (value: unknown): string | null =>
  isDrawnIconRef(value) ? value.slice(DRAWN_ICON_PREFIX.length) : null;

// ---- Path data syntax (SVG path subset) ----

/** Number of arguments required per command segment. */
const ARGS: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };
const NUMBER = /[+-]?(?:\d+(?:\.\d*)?|\.\d+)/y;
const SEPARATOR = /[\s,]/;

/**
 * Validates path data and returns a problem description, or null if valid. Only recognizes M, L,
 * H, V, C, S, Q, T, A, Z (case-insensitive), ordinary numbers (without exponents), spaces, and
 * commas; must start with M/m; each command must have sufficient arguments (7 for A, with the 4th
 * and 5th being 0 or 1 flags); repetitive commands can be omitted as in SVG.
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
    // At least one segment, with subsequent numbers immediately following for repeated segments of the same command.
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
        // Insufficient arguments: reached the end or the next command; unrecognized characters.
        if (i >= d.length || ARGS[d[i]!.toLowerCase()] !== undefined)
          return `${command} needs ${count} numbers per segment`;
        return unexpected();
      }
      skip();
    } while (startsNumber());
  }
}

/** A drawn icon. */
export const DrawnIconSchema = z.strictObject({
  paths: z.array(z.string()).min(1).max(MAX_DRAWN_ICON_PATHS),
  /** Draws lines only (width 2, rounded caps and joins) with no fill; unconfigured defaults to even-odd fill. */
  stroke: z.literal(true).optional(),
});
export type DrawnIcon = z.infer<typeof DrawnIconSchema>;

/** Issues for a single icon (one per line, specifying which icon). */
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

/** Top-level icon library configuration. */
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

/** Icon library patch (icons in setTheme): if specified, adds or replaces icons; null removes them. */
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
 * Every "my:<id>" icon reference in the content (where the key name is icon, at any nesting
 * level): returns the id and location (uses the id-containing layer in the path). Top-level icons
 * (the icon library itself) are excluded.
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

/** Replaces "my:<old id>" with "my:<new id>" in the content (used for renaming when IDs clash during App file import); returns a new copy. */
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
