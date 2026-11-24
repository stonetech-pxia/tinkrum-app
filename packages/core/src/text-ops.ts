import { extractAll, type ExtractKind } from './text-rules';
import type { Locale } from './schema';

// Text processing (D-245): fixed operations transforming text to text. Text is processed entirely
// on-device, and the AI only selects operations and parameters; replacement terms are written by
// the user (private parameters, replaced with placeholders before sending to the AI, D-065 /
// D-082), using literal matching rather than regular expressions.

export type BlankLines = 'keep' | 'single' | 'remove';

/** Removes extra whitespace (leading/trailing spaces, consecutive spaces, and tabs) and blank lines (keep leaves them unchanged, single collapses consecutive blank lines into one, remove deletes all). */
export function tidyText(text: string, blankLines: BlankLines, spaces: boolean): string {
  let lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (spaces) lines = lines.map((l) => l.replace(/[ \t 　]+/g, ' ').trim());
  if (blankLines === 'remove') lines = lines.filter((l) => l.trim() !== '');
  else if (blankLines === 'single')
    lines = lines.filter((l, i) => l.trim() !== '' || (i > 0 && lines[i - 1]!.trim() !== ''));
  return lines.join('\n').replace(/^\n+|\n+$/g, '');
}

/** Performs literal replacement of all occurrences; case-insensitive when ignoreCase is set. Returns the modified text and the count of replacements. */
export function replaceText(
  text: string,
  find: string,
  replaceWith: string,
  ignoreCase: boolean,
): { text: string; count: number } {
  if (!find) return { text, count: 0 };
  const haystack = ignoreCase ? text.toLowerCase() : text;
  const needle = ignoreCase ? find.toLowerCase() : find;
  let out = '';
  let count = 0;
  let from = 0;
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, from)) {
    out += text.slice(from, at) + replaceWith;
    from = at + find.length;
    count++;
  }
  return { text: out + text.slice(from), count };
}

/** Extracts all phone numbers / emails / URLs / numbers / dates, one per line. */
export const extractText = (text: string, kind: ExtractKind, locale: Locale) =>
  extractAll(text, kind, locale).join('\n');

export const LINE_SEPARATORS = ['newline', 'comma', 'semicolon', 'space', 'tab', 'none'] as const;
export type LineSeparator = (typeof LINE_SEPARATORS)[number];

const JOIN: Record<LineSeparator, string> = {
  newline: '\n',
  comma: ', ',
  semicolon: '; ',
  space: ' ',
  tab: '\t',
  none: '',
};
// Chinese commas, semicolons, and ideographic commas are also treated as delimiters during splitting.
const SPLIT: Record<Exclude<LineSeparator, 'none' | 'newline'>, RegExp> = {
  comma: /[,，、]/,
  semicolon: /[;；]/,
  space: /[ 　]+/,
  tab: /\t/,
};

/**
 * Split into lines: splits by delimiter, placing each segment on a new line (stripping
 * leading/trailing spaces and empty segments). Join into lines: strips leading/trailing spaces
 * from each line, skips empty lines, and concatenates with the delimiter.
 */
export function splitOrJoinLines(text: string, mode: 'split' | 'join', separator: LineSeparator) {
  if (mode === 'join') {
    return text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .join(JOIN[separator]);
  }
  if (separator === 'none' || separator === 'newline') return text;
  return text
    .split(/\r?\n/)
    .flatMap((l) => l.split(SPLIT[separator]))
    .map((p) => p.trim())
    .filter(Boolean)
    .join('\n');
}
