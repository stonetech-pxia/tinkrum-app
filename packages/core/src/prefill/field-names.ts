import type { TextBox, TextPage } from './rows';

// Find clickable field names from the document (D-444): look only at layout, use no dictionary, no
// language model, and no AI. Results are used for highlighting only; users can still tap any line
// in the original text, so rule misjudgments will not block them. Only evaluated on generated
// documents (side-session-notes/form-from-file/round4). Text remains strictly on-device, is not
// networked, and is never sent to the AI (invariants 1, 2). Avoid lookbehind assertions (not
// supported in older versions of Hermes).

const clean = (s: string) => s.replace(/^[\s|·•*=\-–—#]+|[\s:：\-–—|·•*=#._]+$/g, '').trim();
/** Formatting convention for comparing field names: case-insensitive, ignoring leading/trailing punctuation and extra whitespace. */
export const fieldNameKey = (s: string) => clean(s).replace(/\s+/g, ' ').toLowerCase();

/** Looks like a value (number, amount, ID, email, fill-in line, URL) rather than a field name. */
export function looksLikeValue(s: string): boolean {
  const t = s.trim();
  return (
    /^[+(]?[\d$€£¥￥]/.test(t) ||
    /^[A-Za-z]{1,4}[-\s]?\d[\w\-./]*$/.test(t) ||
    /[\w.+-]+@[\w-]+\./.test(t) ||
    /^[_\-.]{3,}$/.test(t) ||
    /^https?:/i.test(t)
  );
}
const prose = (s: string) => {
  const t = s.trim();
  return /[.!?。！？]$/.test(t) || t.split(/\s+/).length > 7 || t.length > 45;
};
const hasColon = (s: string) => /[:：]/.test(s);
const join = (a: string, b: string) =>
  /[㐀-鿿]$/.test(a) && /^[㐀-鿿]/.test(b) ? a + b : `${a} ${b}`;

function rowsOf(lines: readonly TextBox[]): TextBox[][] {
  const rows: TextBox[][] = [];
  for (const l of [...lines].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const row = rows.find(
      (r) =>
        Math.min(r[0]!.y + r[0]!.height, l.y + l.height) - Math.max(r[0]!.y, l.y) >=
        0.5 * Math.min(r[0]!.height, l.height),
    );
    if (row) row.push(l);
    else rows.push([l]);
  }
  rows.forEach((r) => r.sort((a, b) => a.x - b.x));
  return rows;
}
const top = (r: readonly TextBox[]) => Math.min(...r.map((l) => l.y));
const bottom = (r: readonly TextBox[]) => Math.max(...r.map((l) => l.y + l.height));

/** Split blocks by vertical spacing: a spacing significantly larger than the minimum spacing (more than 1.6x plus half a character height) marks a new block. */
function blocks<T>(items: readonly T[], gap: (a: T, b: T) => number, height: number): T[][] {
  if (items.length === 0) return [];
  const gaps = items.slice(1).map((x, i) => gap(items[i]!, x));
  const min = Math.min(...gaps, Infinity);
  const out: T[][] = [[items[0]!]];
  items.slice(1).forEach((x, i) => {
    if (gaps[i]! > Math.max(min * 1.6, min + height * 0.5)) out.push([x]);
    else out[out.length - 1]!.push(x);
  });
  return out;
}

/**
 * Field names in a line with a colon. The entire segment to the left of the first colon is a
 * field name: do not split even if characters are unrecognized (OCR typos, symbols), preferring
 * to let the user rename it. Look for other groups on the same line to the right of the colon
 * ("A:1 B:2").
 */
function colonNames(text: string): string[] {
  const at = text.search(/[:：]/);
  if (at <= 0) return [];
  const first = text.slice(0, at);
  // Two widely separated text segments at the beginning of a line ("Name Date: 12"): the left segment is not considered part of this field name.
  const name = first
    .split(/\s{2,}/)
    .pop()!
    .trim();
  const out = name.length <= 60 ? [name] : [];
  const re =
    /(?:\s{2,}|\s(?=[\p{L}][\p{L}\s°№.#()%-]{0,35}\s*[:：]))([\p{L}][\p{L}\d\s°№.#()%'’/-]{0,60}?)\s*[:：]/gu;
  for (const m of text.slice(at + 1).matchAll(re)) out.push(m[1]!);
  return out;
}

function pageNames(page: TextPage): string[] {
  const all = page.lines.filter((l) => l.text.trim());
  const colons = all.filter(
    (l) => hasColon(l.text) && !/^\d/.test(l.text.trim()) && !prose(l.text.split(/[:：]/)[0] ?? ''),
  );
  const out = colons.flatMap((l) => colonNames(l.text));
  const used = new Set<TextBox>(colons);
  // Colon is followed by empty space: the value is on the immediately following line or to the right on the same row.
  const allRows = rowsOf(all);
  for (const c of colons) {
    if (!/[:：]\s*$/.test(c.text)) continue;
    for (const n of all)
      if (
        !used.has(n) &&
        Math.abs(n.x - c.x) < c.height * 1.5 &&
        n.y > c.y &&
        n.y - (c.y + c.height) < c.height * 1.2
      )
        used.add(n);
    const right = allRows.find((r) => r.includes(c))?.find((n) => n.x > c.x && !used.has(n));
    if (right) used.add(right);
  }
  // Field name followed by an underscore (Label ______).
  for (const l of all)
    if (!used.has(l) && !hasColon(l.text) && /\p{L}.*\s*[_-]{3,}\s*$/u.test(l.text)) {
      out.push(l.text);
      used.add(l);
    }
  const rest = all.filter((l) => !used.has(l) && !prose(l.text));
  const rows = rowsOf(rest);
  if (rows.length === 0) return out;
  const height = rest.map((l) => l.height).sort((a, b) => a - b)[rest.length >> 1]!;
  const multi = rows.filter((r) => r.length >= 2);
  const parts = blocks(multi, (a, b) => top(b) - bottom(a), height);
  const taken = new Set<TextBox[]>();

  const isHeader = (b: TextBox[][]) => {
    const first = b[0]!;
    if (b.length < 2 || b.some((r) => r.length !== first.length)) return false;
    if (first.some((l) => looksLikeValue(l.text))) return false;
    const n = first.length;
    const valueIn = (i: number) => b.slice(1).some((r) => looksLikeValue(r[i]!.text));
    const columns = Array.from({ length: n }, (_, i) => i);
    // Blocks of the same size appear more than once: each block is a header + value.
    if (parts.filter((x) => x.length >= 2 && x.length === b.length).length >= 2) return true;
    // Three or more columns, unless formatted as "field name value field name value".
    if (n >= 3 && !(n % 2 === 0 && columns.every((i) => valueIn(i) === (i % 2 === 1)))) return true;
    if (n === 2) {
      if (valueIn(0) && valueIn(1)) return true;
      // Mixed value types for "field name value" pairs (date, amount, text); or an entire table column consists solely of pure numbers.
      if (
        !valueIn(0) &&
        b.length >= 3 &&
        b.slice(1).every((r) => /^[+(-]?\d[\d\s.,]*\)?$/.test(r[1]!.text.trim()))
      )
        return true;
    }
    return n % 2 === 0 && columns.every(valueIn);
  };

  for (const b of parts) {
    if (isHeader(b)) {
      const first = b[0]!;
      const second = b[1];
      const third = b[2];
      // Wrapped header: the second row consists entirely of short words and is positioned closer to the values below it.
      const wrapped =
        second &&
        third &&
        second.length === first.length &&
        !second.some((l) => looksLikeValue(l.text)) &&
        second.every((l) => l.text.trim().split(/\s+/).length <= 2) &&
        b.slice(2).some((r) => r.some((l) => looksLikeValue(l.text))) &&
        top(second) - bottom(first) < top(third) - bottom(second);
      first.forEach((l, i) =>
        out.push(wrapped ? join(l.text.trim(), second[i]!.text.trim()) : l.text),
      );
      b.forEach((r) => taken.add(r));
      continue;
    }
    // Field name value: vote by grid index, defaulting odd-numbered grid cells to field names.
    const votes = [0, 0];
    b.forEach((r) =>
      r.forEach((l, i) => {
        if (looksLikeValue(l.text)) votes[i % 2]!++;
      }),
    );
    const labelAt = votes[0]! > votes[1]! ? 1 : 0;
    for (const r of b) {
      taken.add(r);
      r.forEach((l, i) => {
        if (i % 2 !== labelAt || looksLikeValue(l.text)) return;
        let name = l.text.trim();
        // Wrapped field name: a single-cell row immediately above or below, in the same column.
        const at = rows.indexOf(r);
        const up = rows[at - 1];
        const down = rows[at + 1];
        const fits = (o: TextBox[] | undefined, gap: number) =>
          o !== undefined &&
          o.length === 1 &&
          Math.abs(o[0]!.x - l.x) < height &&
          gap < height * 0.6 &&
          !looksLikeValue(o[0]!.text);
        if (up && fits(up, top(r) - bottom(up))) {
          name = join(up[0]!.text.trim(), name);
          taken.add(up);
        } else if (down && fits(down, top(down) - bottom(r))) {
          const after = rows[at + 2];
          if (!after || top(after) - bottom(down) > height * 0.6) {
            name = join(name, down[0]!.text.trim());
            taken.add(down);
          }
        }
        out.push(name);
      });
    }
  }

  // Single-column rows: split blocks by spacing within the same column, use numerical voting to determine whether the value is at the end or the beginning, and merge remaining rows into field names.
  const singles = rows.filter((r) => r.length === 1 && !taken.has(r)).map((r) => r[0]!);
  const columns: TextBox[][] = [];
  for (const l of singles) {
    const c = columns.find((col) => Math.abs(col[0]!.x - l.x) < height * 2);
    if (c) c.push(l);
    else columns.push([l]);
  }
  for (const col of columns) {
    if (col.length < 2) continue;
    col.sort((a, b) => a.y - b.y);
    const groups = blocks(col, (a, b) => b.y - (a.y + a.height), height);
    if (groups.length <= 1 || groups.every((g) => g.length === 1)) {
      // Spacing is uniform: use alternating row voting; do not guess in the absence of numerical evidence.
      const list = groups.flat();
      const votes = [0, 0];
      list.forEach((l, i) => {
        if (looksLikeValue(l.text)) votes[i % 2]!++;
      });
      if (list.length >= 4 && votes[0] !== votes[1]) {
        const labelAt = votes[1]! > votes[0]! ? 0 : 1;
        list.forEach((l, i) => {
          if (i % 2 === labelAt && !looksLikeValue(l.text)) out.push(l.text);
        });
      }
      continue;
    }
    const real = groups.filter((g) => g.length >= 2 && g.length <= 4);
    if (real.length < 2 && !(real.length === 1 && real[0]!.some((l) => looksLikeValue(l.text))))
      continue;
    let first = 0;
    let last = 0;
    for (const g of real) {
      if (looksLikeValue(g[0]!.text)) first++;
      if (looksLikeValue(g[g.length - 1]!.text)) last++;
    }
    for (const g of real) {
      const name = first > last ? g.slice(1) : g.slice(0, -1);
      if (name.some((l) => looksLikeValue(l.text))) continue;
      out.push(name.map((l) => l.text.trim()).reduce(join));
    }
  }
  return out;
}

/** Clickable field names in the document (in order of appearance, deduplicated). */
export function extractFieldNames(pages: readonly TextPage[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const page of pages)
    for (const raw of pageNames(page)) {
      const name = clean(raw.replace(/[_-]{3,}\s*$/, ''));
      const key = fieldNameKey(name);
      if (!name || !/\p{L}/u.test(name) || looksLikeValue(name) || seen.has(key)) continue;
      seen.add(key);
      out.push(name);
    }
  return out;
}

/** Original rows (by position), used for "view original and select"; left and right separated cells in a row are counted as separate segments. */
export function originalRows(pages: readonly TextPage[]): string[][] {
  return pages.flatMap((p) =>
    rowsOf(p.lines.filter((l) => l.text.trim())).map((r) => r.map((l) => l.text.trim())),
  );
}

/** A segment of original text tapped by the user -> field name: take the left side of the colon if a colon is present. */
export function fieldNameFromText(text: string): string {
  const left = text.split(/[:：]/)[0] ?? text;
  return clean(left.replace(/[_-]{3,}\s*$/, ''));
}
