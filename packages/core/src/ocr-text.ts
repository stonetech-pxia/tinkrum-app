import { T2S_FROM, T2S_TO } from './ocr-t2s';

// Organize OCR results into text (D-268): layout into lines and paragraphs by position, re-joining
// lines wrapped due to formatting within the same paragraph (resulting in complete copied
// paragraphs); convert accidental Traditional Chinese characters to Simplified; convert half-width
// punctuation next to Chinese characters to full-width. All done locally, without modifying content
// other than recognized characters.

/** Recognized text line: pixel coordinates, origin at top-left. */
export interface OcrLine {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** CJK characters and full-width punctuation. */
const CJK =
  '\\u3000-\\u303f\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef';
const IS_CJK = new RegExp(`[${CJK}]`);
/** Start of list item: bullet points, "1.", "2、", "(3)", "①-①". */
const LIST_ITEM = /^\s*(?:[•·\-–—*▪●○◦■□]|\d{1,3}[.、)）]|[(（]\d{1,3}[)）]|[①-⑳])/;

interface Row {
  text: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[sorted.length >> 1]! : 0;
}

/** How to join two lines: no spaces between CJK characters; strip hyphen when an English end-of-line "word-" connects to a lowercase letter; otherwise add a space. */
function joiner(prev: string, next: string): { prev: string; sep: string } {
  const last = prev.slice(-1);
  const first = next.charAt(0);
  if (IS_CJK.test(last) || IS_CJK.test(first)) return { prev, sep: '' };
  if (/[A-Za-zÀ-ɏ]-$/.test(prev) && /^[a-zà-ÿ]/.test(next))
    return { prev: prev.slice(0, -1), sep: '' };
  return { prev, sep: ' ' };
}

/**
 * Arrange recognized lines into text: first group into rows by vertical overlap (joining blocks
 * in the same row from left to right with spaces), leaving a blank line (paragraph break) where
 * vertical spacing exceeds 1.5 lines. Within the same paragraph, lines that extend to the right
 * without indentation or list markers are considered layout wraps and are joined into a single
 * line.
 */
/**
 * Check if the first word of the next line fits at the end of the previous line: left-aligned
 * body text has a ragged right edge, and the previous line fell short because the next word
 * wouldn't fit. Very short lines (such as a column of labels) frequently vary in length and do
 * not use this check; CJK text can wrap at the first character.
 */
function wordFits(
  prev: { left: number; right: number; text: string },
  row: { left: number; right: number; text: string },
  right: number,
  typical: number,
): boolean {
  if ([...prev.text].length <= 30) return true;
  const text = row.text.trim();
  const first = /^[\u2e80-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/.test(text)
    ? text.slice(0, 1)
    : (text.split(/\s+/)[0] ?? '');
  const char = (row.right - row.left) / Math.max(1, text.length);
  return prev.right + (first.length + 1) * char <= right + 0.3 * typical;
}

function ocrRows(lines: readonly OcrLine[]): { rows: Row[]; typical: number } {
  const items = lines.filter((l) => l.text.trim());
  if (items.length === 0) return { rows: [], typical: 1 };
  const typical = median(items.map((l) => l.height)) || 1;
  const sorted = [...items].sort((a, b) => a.y + a.height / 2 - (b.y + b.height / 2));
  const groups: OcrLine[][] = [];
  for (const line of sorted) {
    const first = groups.at(-1)?.[0];
    if (first) {
      const overlap =
        Math.min(first.y + first.height, line.y + line.height) - Math.max(first.y, line.y);
      if (overlap >= 0.5 * Math.min(first.height, line.height)) {
        groups.at(-1)!.push(line);
        continue;
      }
    }
    groups.push([line]);
  }
  const rows: Row[] = groups.map((group) => {
    const ordered = group.sort((a, b) => a.x - b.x);
    return {
      text: ordered.map((l) => l.text.trim()).join(' '),
      left: Math.min(...ordered.map((l) => l.x)),
      right: Math.max(...ordered.map((l) => l.x + l.width)),
      top: Math.min(...ordered.map((l) => l.y)),
      bottom: Math.max(...ordered.map((l) => l.y + l.height)),
    };
  });
  return { rows, typical };
}

/** Word has already determined paragraphs by position; only re-join line wraps, without re-segmenting based on list markers or ragged line ends. */
export function joinOcrParagraph(lines: readonly OcrLine[]): string {
  const { rows } = ocrRows(lines);
  let text = '';
  for (const row of rows) {
    if (!text) {
      text = row.text;
      continue;
    }
    // Retain hyphens in number ranges; different from hyphens splitting English words at line ends.
    const { prev, sep } =
      /\d[-–—]$/.test(text) && /^\d/.test(row.text)
        ? { prev: text, sep: '' }
        : joiner(text, row.text);
    text = prev + sep + row.text;
  }
  return text;
}

export function layoutOcrLines(lines: readonly OcrLine[]): string {
  const { rows, typical } = ocrRows(lines);
  if (!rows.length) return '';
  // Paragraphs: vertical spacing exceeding 1.5 lines constitutes a new paragraph.
  const blocks: Row[][] = [];
  for (const row of rows) {
    const block = blocks.at(-1);
    const prev = block?.at(-1);
    if (block && prev && row.top - prev.bottom <= 1.2 * typical) block.push(row);
    else blocks.push([row]);
  }
  return blocks
    .map((block) => {
      const left = Math.min(...block.map((r) => r.left));
      const right = Math.max(...block.map((r) => r.right));
      const out: string[] = [];
      for (const [i, row] of block.entries()) {
        const prev = block[i - 1];
        const wrapped =
          prev !== undefined &&
          (prev.right >= right - 1.2 * typical || !wordFits(prev, row, right, typical)) &&
          prev.right - prev.left >= 0.6 * (right - left) &&
          row.left <= left + typical &&
          !LIST_ITEM.test(row.text);
        if (wrapped && out.length > 0) {
          const { prev: head, sep } = joiner(out.at(-1)!, row.text);
          out[out.length - 1] = head + sep + row.text;
        } else out.push(row.text);
      }
      return out.join('\n');
    })
    .join('\n\n');
}

let t2s: Map<string, string> | null = null;

/** Convert accidental Traditional Chinese characters in Simplified Chinese recognition results to Simplified (only converting one-to-one characters never used in Simplified, D-268). */
export function toSimplifiedChinese(text: string): string {
  if (!t2s) {
    const from = [...T2S_FROM];
    const to = [...T2S_TO];
    t2s = new Map(from.map((c, i) => [c, to[i]!]));
  }
  const map = t2s;
  return Array.from(text, (c) => map.get(c) ?? c).join('');
}

const FULL: Record<string, string> = {
  ',': '，',
  ':': '：',
  ';': '；',
  '?': '？',
  '!': '！',
  '(': '（',
  ')': '）',
};

/**
 * Convert half-width punctuation next to Chinese to full-width (recognizers often output `,`,
 * `:`, `()` as half-width): convert commas, colons, and semicolons when adjacent to Chinese
 * (numbers like 1,000 or 12:30 are not adjacent to Chinese and are left unchanged); convert
 * periods only when preceded by Chinese and not followed by alphanumeric characters; convert
 * question marks and exclamation points when following Chinese; convert brackets when adjacent to
 * Chinese inside or outside, changing opening and closing brackets together. Remove spaces around
 * full-width punctuation.
 */
export function cjkPunctuation(text: string): string {
  const chars = Array.from(text);
  const isCjk = (c: string | undefined) => c !== undefined && IS_CJK.test(c);
  // If the left parenthesis changes, the right parenthesis follows accordingly ("pixel(px)" -> "pixel (px)").
  const open: boolean[] = [];
  const out = chars.map((c, i) => {
    const prev = chars[i - 1];
    const next = chars[i + 1];
    // Half-width punctuation may have a space before and after it ("Chinese , Chinese").
    const before = prev === ' ' ? chars[i - 2] : prev;
    const after = next === ' ' ? chars[i + 2] : next;
    switch (c) {
      case ',':
      case ':':
      case ';':
        return isCjk(before) || isCjk(after) ? FULL[c]! : c;
      case '.':
        return isCjk(before) && !/[0-9A-Za-z]/.test(after ?? '') ? '。' : c;
      case '?':
      case '!':
        return isCjk(before) ? FULL[c]! : c;
      case '(': {
        const full = isCjk(after) || isCjk(before);
        open.push(full);
        return full ? FULL[c]! : c;
      }
      case ')': {
        const full = open.pop() ?? (isCjk(before) || isCjk(after));
        return full ? FULL[c]! : c;
      }
      default:
        return c;
    }
  });
  return out.join('').replace(/ *([，。：；？！（）、]) */g, '$1');
}

/** Refinement for a recognition language: convert Simplified to Traditional and polish punctuation for Simplified Chinese; polish punctuation only for Traditional Chinese; leave other languages unchanged (D-268). */
export function polishOcrText(text: string, lang: 'zh-Hans' | 'zh-Hant' | 'other'): string {
  if (lang === 'zh-Hans') return cjkPunctuation(toSimplifiedChinese(text));
  if (lang === 'zh-Hant') return cjkPunctuation(text);
  return text;
}
