// Rich text (D-044): Text and tooltips support a small subset of Markdown. Parsed into a data
// structure only, mapped to native text styles by the renderer; HTML, images, or any executable
// content are not supported.
//
//   **bold**  *italic*  [link text](https://example.com)  [email](mailto:a@b.com)   - bullet lists (bullet • also supported)   1. numbered lists   blank lines separate paragraphs; \\* \\[ and other backslash escapes

export interface Span {
  text: string;
  bold?: true;
  italic?: true;
  /** Only https: and mailto: are allowed (see isSafeLink). */
  url?: string;
}

export type Block =
  { type: 'paragraph'; spans: Span[] } | { type: 'list'; ordered: boolean; items: Span[][] };

/** Links can only be https URLs or email addresses. */
export function isSafeLink(url: string): boolean {
  if (url.length > 500 || /\s/.test(url)) return false;
  return /^https:\/\/[^/?#]+\.[^/?#]+/i.test(url) || /^mailto:[^@]+@[^@]+\.[^@]+$/i.test(url);
}

/** The target displayed to the user for confirmation when a link is tapped (domain name or email address). */
export function linkTarget(url: string): string {
  if (/^mailto:/i.test(url)) return url.slice('mailto:'.length);
  const host = url.replace(/^https?:\/\//i, '').split(/[/?#]/)[0]!;
  return host;
}

function parseInline(source: string): Span[] {
  const spans: Span[] = [];
  let buffer = '';
  let style: { bold?: true; italic?: true } = {};
  const flush = () => {
    if (buffer) spans.push({ text: buffer, ...style });
    buffer = '';
  };
  for (let i = 0; i < source.length;) {
    const ch = source[i]!;
    if (ch === '\\' && i + 1 < source.length && /[*_[\]()\\-]/.test(source[i + 1]!)) {
      buffer += source[i + 1];
      i += 2;
      continue;
    }
    if (ch === '[') {
      const m = /^\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(source.slice(i));
      if (m) {
        flush();
        spans.push(
          isSafeLink(m[2]!) ? { text: m[1]!, url: m[2]!, ...style } : { text: m[1]!, ...style },
        );
        i += m[0].length;
        continue;
      }
    }
    if (source.startsWith('**', i)) {
      const end = source.indexOf('**', i + 2);
      if (style.bold || end > i + 2) {
        flush();
        style = style.bold ? omit(style, 'bold') : { ...style, bold: true };
        i += 2;
        continue;
      }
    }
    if (ch === '*') {
      const end = source.indexOf('*', i + 1);
      if (style.italic || (end > i + 1 && source[i + 1] !== ' ')) {
        flush();
        style = style.italic ? omit(style, 'italic') : { ...style, italic: true };
        i += 1;
        continue;
      }
    }
    buffer += ch;
    i += 1;
  }
  flush();
  return spans;
}

function omit<T extends object>(o: T, key: keyof T): T {
  const copy = { ...o };
  delete copy[key];
  return copy;
}

const BULLET = /^\s*[-•]\s+(.*)$/;
const NUMBERED = /^\s*\d{1,3}[.)]\s+(.*)$/;

export function parseRichText(source: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const endParagraph = () => {
    if (paragraph.length)
      blocks.push({ type: 'paragraph', spans: parseInline(paragraph.join('\n')) });
    paragraph = [];
  };
  for (const line of source.replace(/\r\n?/g, '\n').split('\n')) {
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (bullet || numbered) {
      endParagraph();
      const ordered = numbered !== null;
      const item = parseInline((bullet ?? numbered)![1]!);
      const last = blocks.at(-1);
      if (last?.type === 'list' && last.ordered === ordered) last.items.push(item);
      else blocks.push({ type: 'list', ordered, items: [item] });
    } else if (line.trim() === '') {
      endParagraph();
    } else {
      paragraph.push(line);
    }
  }
  endParagraph();
  return blocks;
}

/** URLs present in the text that are unsafe and therefore will not become links (reported by the validator). */
export function unsafeLinks(source: string): string[] {
  return [...source.matchAll(/\[[^\]\n]+\]\(([^)\s]+)\)/g)]
    .map((m) => m[1]!)
    .filter((url) => !isSafeLink(url));
}

/** Plain text with formatting markers removed (used for change descriptions, etc.). */
export function plainText(source: string): string {
  return parseRichText(source)
    .map((b) =>
      b.type === 'paragraph'
        ? b.spans.map((s) => s.text).join('')
        : b.items.map((item) => item.map((s) => s.text).join('')).join(' / '),
    )
    .join(' ');
}

// ---- emoji icons ----

/** Unicode code point ranges for emojis that can be rendered as icons (does not depend on regex Unicode properties, works on Hermes too). */
const PICTOGRAPHIC: [number, number][] = [
  [0x1f000, 0x1faff],
  [0x2600, 0x27bf],
  [0x2b00, 0x2bff],
  [0x2300, 0x23ff],
  [0x2190, 0x21ff],
  [0x1f1e6, 0x1f1ff],
  [0x3030, 0x3030],
  [0x303d, 0x303d],
  [0x3297, 0x3297],
  [0x3299, 0x3299],
  [0x00a9, 0x00a9],
  [0x00ae, 0x00ae],
  [0x2122, 0x2122],
];
const JOINERS = new Set([0x200d, 0xfe0f, 0x20e3]);
const inRanges = (cp: number) => PICTOGRAPHIC.some(([a, b]) => cp >= a && cp <= b);

/** Single emoji (may include skin tones and combining characters, e.g., 👨👩👧, 1️⃣, 🇨🇳). */
export function isEmoji(s: string): boolean {
  const cps = [...s].map((c) => c.codePointAt(0)!);
  if (cps.length === 0 || cps.length > 10) return false;
  let pictographic = 0;
  for (const cp of cps) {
    if (inRanges(cp)) pictographic++;
    else if (JOINERS.has(cp) || (cp >= 0xe0020 && cp <= 0xe007f)) continue;
    else if (/[#*0-9]/.test(String.fromCodePoint(cp)) && cps.includes(0x20e3)) continue;
    else return false;
  }
  return pictographic > 0 || cps.includes(0x20e3);
}
