// Layout checks: directly read docx XML to inspect font size, underline, indentation, space before
// paragraphs, paper size, cell widths, and image sizes. Prefer relative relationships (ratio of two
// font sizes, difference of two indents, whether a line fits) over fixed numerical values.
import { norm, type Check, type Converted } from './checks';

const decodeXml = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

/** A paragraph in docx: the innermost w:p (without nested paragraphs), at is its position in document.xml. */
export interface XmlPara {
  xml: string;
  text: string;
  at: number;
}

const cache = new WeakMap<Converted, XmlPara[]>();

/** All innermost paragraphs in document order. */
export function xmlParas(c: Converted): XmlPara[] {
  let out = cache.get(c);
  if (out) return out;
  out = [];
  for (const m of c.xml.matchAll(/<w:p>(?:(?!<w:p[ >])[\s\S])*?<\/w:p>/g)) {
    const text = [...m[0].matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)]
      .map((t) => decodeXml(t[1]!))
      .join('');
    out.push({ xml: m[0], text, at: m.index });
  }
  cache.set(c, out);
  return out;
}

/** The first paragraph containing this text. */
export function xmlPara(c: Converted, text: string): XmlPara | undefined {
  return xmlParas(c).find((p) => norm(p.text).includes(norm(text)));
}

const pPrOf = (p: XmlPara) =>
  (/<w:pPr>([\s\S]*?)<\/w:pPr>/.exec(p.xml)?.[1] ?? '').replace(/<w:rPr>[\s\S]*?<\/w:rPr>/, '');

const runsOf = (p: XmlPara) =>
  [...p.xml.matchAll(/<w:r>([\s\S]*?)<\/w:r>/g)]
    .map((r) => ({
      xml: r[1]!,
      text: [...r[1]!.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((t) => t[1]!).join(''),
    }))
    .filter((r) => r.text.trim());

/** Font sizes (in points) of runs containing text within the paragraph; NaN if w:sz is not specified. */
export const runSizes = (p: XmlPara): number[] =>
  runsOf(p).map((r) => Number(/<w:sz w:val="(\d+)"/.exec(r.xml)?.[1]) / 2);

/** Paragraph font size: the font size with the most characters (in points). */
export function paraSize(p: XmlPara): number {
  const chars = new Map<number, number>();
  for (const r of runsOf(p)) {
    const s = Number(/<w:sz w:val="(\d+)"/.exec(r.xml)?.[1]) / 2;
    chars.set(s, (chars.get(s) ?? 0) + r.text.length);
  }
  return [...chars].sort((a, b) => b[1] - a[1])[0]?.[0] ?? NaN;
}

/** Font size of this text (in points): font size of the run containing it; when spanning multiple runs, based on the font size of the paragraph containing it. */
export function sizeOf(c: Converted, text: string): number {
  for (const p of xmlParas(c)) {
    if (!norm(p.text).includes(norm(text))) continue;
    const run = runsOf(p).find((r) => norm(decodeXml(r.text)).includes(norm(text)));
    return run ? Number(/<w:sz w:val="(\d+)"/.exec(run.xml)?.[1]) / 2 : paraSize(p);
  }
  return NaN;
}

/** Every text-containing run has this property (e.g., '<w:u w:val="single"/>', '<w:b/>'). */
export const allRuns = (p: XmlPara, prop: RegExp) => runsOf(p).every((r) => prop.test(r.xml));
/** At least one text-containing run has this property. */
export const anyRun = (p: XmlPara, prop: RegExp) => runsOf(p).some((r) => prop.test(r.xml));

const pPrNumber = (p: XmlPara, re: RegExp) => Number(re.exec(pPrOf(p))?.[1] ?? 0);
/** Left indent (in twips), 0 if unspecified. */
export const indentLeft = (p: XmlPara) => pPrNumber(p, /<w:ind\b[^>]*\bw:left="(-?[\d.]+)"/);
/** Space before paragraph (in twips), 0 if unspecified. */
export const spaceBefore = (p: XmlPara) => pPrNumber(p, /<w:spacing\b[^>]*\bw:before="(\d+)"/);
/** Alignment (w:jc), 'left' if unspecified. */
export const jcOf = (p: XmlPara) => /<w:jc w:val="(\w+)"/.exec(pPrOf(p))?.[1] ?? 'left';

/** Width of the innermost table cell containing the paragraph (in twips, w:tcW); undefined when not in a table. */
export function cellWidth(c: Converted, p: XmlPara): number | undefined {
  const open: number[] = [];
  for (const m of c.xml.slice(0, p.at).matchAll(/<(\/?)w:tc>/g)) {
    if (m[1]) open.pop();
    else open.push(m.index);
  }
  const start = open[open.length - 1];
  if (start === undefined) return undefined;
  return Number(/<w:tcW w:w="(\d+)"/.exec(c.xml.slice(start, p.at))?.[1]);
}

/** Paper size (in twips) and page margins for each section. */
export function sections(c: Converted) {
  return [...c.xml.matchAll(/<w:sectPr>[\s\S]*?<\/w:sectPr>/g)].map((m) => {
    const n = (re: RegExp) => Number(re.exec(m[0])?.[1] ?? 0);
    return {
      width: n(/<w:pgSz [^>]*w:w="(\d+)"/),
      height: n(/<w:pgSz [^>]*w:h="(\d+)"/),
      landscape: /w:orient="landscape"/.test(m[0]),
      left: n(/<w:pgMar [^>]*w:left="(\d+)"/),
      right: n(/<w:pgMar [^>]*w:right="(\d+)"/),
      at: m.index,
    };
  });
}

/** Images in the text flow (excluding background images behind text): width and height of wp:extent (in points), in document order. */
export function pictures(c: Converted) {
  return [...c.xml.matchAll(/<w:drawing>([\s\S]*?)<\/w:drawing>/g)]
    .filter((m) => !/behindDoc="1"/.test(m[1]!))
    .map((m) => {
      const e = /<wp:extent cx="(\d+)" cy="(\d+)"/.exec(m[1]!)!;
      return { width: Number(e[1]) / 12700, height: Number(e[2]) / 12700 };
    });
}

/** Widths of ASCII characters in Arial (in units of 1/1000 of the font size, 32–126). */
const ARIAL = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667,
  611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
  222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

/** How many font-size widths a string of text occupies in Arial: accented letters are counted as unaccented, CJK characters and full-width symbols count as 1, others count as 0.556. */
export function arialEm(text: string): number {
  let em = 0;
  for (const ch of text.normalize('NFD')) {
    const code = ch.codePointAt(0)!;
    if (code >= 0x300 && code < 0x370) continue;
    if (code >= 32 && code <= 126) em += ARIAL[code - 32]! / 1000;
    else if (code >= 0x2e80) em += 1;
    else em += 0.556;
  }
  return em;
}

/** Left and right margins for all table cells (in twips, CELL_PAD × 2 in docx.ts). */
const CELL_PADDING = 160;
/** Arial Bold is wider than regular weight by approximately this factor. */
const BOLD_WIDER = 1.07;

/** This paragraph fits on a single line in Word: the cell (or page content area) width minus margins and indentation can accommodate the text width measured in Arial. */
export const fitsOneLine = (text: string): Check => ({
  name: `${JSON.stringify(text)} fits on one line`,
  run(c) {
    const p = xmlPara(c, text);
    if (!p) return 'missing';
    const size = paraSize(p);
    const em = arialEm(p.text.trim()) * (anyRun(p, /<w:b\/>/) ? BOLD_WIDER : 1);
    const need = Math.ceil(em * size * 20);
    const cell = cellWidth(c, p);
    const sect = sections(c).find((s) => s.at > p.at) ?? sections(c).at(-1)!;
    const room =
      (cell !== undefined ? cell - CELL_PADDING : sect.width - sect.left - sect.right) -
      indentLeft(p);
    return need <= room
      ? null
      : `needs ${need} twips at ${size} pt but has ${room}${cell !== undefined ? ` (cell ${cell})` : ''}`;
  },
});

/** The font size of a divided by the font size of b is within ±tol (relative) of ratio. */
export const sizeRatio = (a: string, b: string, ratio: number, tol = 0.1): Check => ({
  name: `size of ${JSON.stringify(a)} / ${JSON.stringify(b)} ≈ ${ratio} ±${tol * 100}%`,
  run(c) {
    const x = sizeOf(c, a);
    const y = sizeOf(c, b);
    if (Number.isNaN(x)) return `"${a}" is missing`;
    if (Number.isNaN(y)) return `"${b}" is missing`;
    const got = x / y;
    return Math.abs(got / ratio - 1) <= tol ? null : `${x} pt / ${y} pt = ${got.toFixed(2)}`;
  },
});

/** These text blocks (each and all of their runs) have the same font size. */
export const sameSize = (...texts: string[]): Check => ({
  name: `same size ${texts.map((t) => JSON.stringify(t)).join(', ')}`,
  run(c) {
    const got: string[] = [];
    const all = new Set<number>();
    for (const t of texts) {
      const p = xmlPara(c, t);
      if (!p) return `"${t}" is missing`;
      const s = runSizes(p);
      s.forEach((v) => all.add(v));
      got.push(`${t.slice(0, 12)}=${[...new Set(s)].join('/')}`);
    }
    return all.size === 1 ? null : got.join(', ');
  },
});
