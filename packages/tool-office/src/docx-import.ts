import {
  A4_WIDTH_PT,
  type DocBlock,
  type DocDoc,
  type DocList,
  type DocParagraph,
  type DocRun,
} from './doc';
import { OfficeImportFailure, openPackage, relKind, type OoxmlPackage } from './ooxml';
import type { Box, CellAlign, TableCell } from './types';
import { child, children, descendants, ownText, type XmlElement } from './xml';

// External docx (from other apps or Word on desktop) -> DocDoc (D-509): placed on the desk, edited
// using the same Word editor, saved via writeDocx as before. Following the founder's principle
// "good order, tables, and paragraphs, not striving for pixel perfection" (around D-501): reads
// paragraph text, bold / italic / underline / font size (also reads color if uniform per
// paragraph), alignment, headings (levels 1, 2), lists (each level forms a separate list,
// continuing previous numbering), tables (merged cells, column widths), embedded images (PNG / JPG
// / GIF / BMP), page breaks; text box text follows its containing paragraph, footnote and endnote
// text is placed at the end of the document (with markers like [1] left in the body), revisions are
// shown as "accept all" (deleted text is hidden), fields show their results. Not read:
// headers/footers, comments, fonts, line spacing and indentation, highlights, strikethrough /
// subscript/superscript (text is kept), page size and margins (saved as A4), shapes, charts,
// SmartArt, vector graphics (EMF / WMF), externally linked images (no network access). No layout:
// boxes are placeholders only (same as text-to-Word, D-441), spacing between paragraphs originally
// empty (empty paragraphs, space before/after) is written as spaced. Pure TS, parsed locally,
// offline (invariant 1); results stay on device only, never sent to AI (invariant 2).

/** Extracted image: src is its path in the package (DocImage.src is initially set to this, replaced with the file in the workspace when placed on the desk). */
export interface ImportedImage {
  bytes: Uint8Array;
  ext: 'png' | 'jpg' | 'gif' | 'bmp';
}

export interface DocxImport {
  doc: DocDoc;
  images: Map<string, ImportedImage>;
}

/** Maximum blocks per document: any more and the editor page (a web page) becomes too slow, treated as too large. */
export const MAX_IMPORT_BLOCKS = 5000;

/** Placeholder box with no layout (same as text-to-Word). */
const BOX: Box = { x: 0, y: 0, width: 1, height: 1 };
/** A4 height in points: page coordinates are in points (width is A4_WIDTH_PT), images and column widths are in points. */
const A4_HEIGHT_PT = 842;
/** writeDocx content area width in points (A4 minus 2 cm on each side): centered images are positioned based on this. */
const CONTENT_PT = (11906 - 2 * 1134) / 20;
/** Space before plus space after for a paragraph must be at least this much (twips, 6 pt) to be considered originally spaced. */
const SPACED_TWIP = 120;
/** Auto spacing (documents from web) is approximately this many twips. */
const AUTO_SPACING = 280;
/** Default font size in Word when unspecified is 10 pt. */
const DEFAULT_SIZE = 10;
const EMU_PER_PT = 12700;

interface RunStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  size?: number;
  color?: string;
  hidden?: boolean;
}

interface ParaProps {
  jc?: string;
  outline?: number;
  numId?: string;
  ilvl?: number;
  before?: number;
  after?: number;
  contextual?: boolean;
  pageBreakBefore?: boolean;
}

interface StyleDef {
  type: string;
  name: string;
  basedOn?: string;
  run: RunStyle;
  para: ParaProps;
  tblBorders?: XmlElement;
  isDefault: boolean;
}

/** Value of a boolean flag attribute: 1 / true / on is true. */
const flag = (v: string | undefined) =>
  v !== undefined && !['0', 'false', 'off', 'none'].includes(v.toLowerCase());

/** Switch elements like w:b: omitted val defaults to true. */
function onOff(el: XmlElement | undefined): boolean | undefined {
  if (!el) return undefined;
  const v = el.attrs['w:val'];
  return v === undefined || flag(v);
}

const num = (v: string | undefined) => {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

function readRun(rPr: XmlElement | undefined): RunStyle {
  const out: RunStyle = {};
  if (!rPr) return out;
  const b = onOff(child(rPr, 'w:b'));
  if (b !== undefined) out.bold = b;
  const i = onOff(child(rPr, 'w:i'));
  if (i !== undefined) out.italic = i;
  const u = child(rPr, 'w:u');
  if (u) out.underline = (u.attrs['w:val'] ?? 'single') !== 'none';
  const sz = num(child(rPr, 'w:sz')?.attrs['w:val']);
  if (sz) out.size = sz / 2;
  const color = child(rPr, 'w:color')?.attrs['w:val'];
  if (color) out.color = color;
  const hidden = onOff(child(rPr, 'w:vanish'));
  if (hidden !== undefined) out.hidden = hidden;
  return out;
}

function readPara(pPr: XmlElement | undefined): ParaProps {
  const out: ParaProps = {};
  if (!pPr) return out;
  const jc = child(pPr, 'w:jc')?.attrs['w:val'];
  if (jc) out.jc = jc;
  const outline = num(child(pPr, 'w:outlineLvl')?.attrs['w:val']);
  if (outline !== undefined) out.outline = outline;
  const numPr = child(pPr, 'w:numPr');
  if (numPr) {
    const id = child(numPr, 'w:numId')?.attrs['w:val'];
    if (id !== undefined) out.numId = id;
    const ilvl = num(child(numPr, 'w:ilvl')?.attrs['w:val']);
    if (ilvl !== undefined) out.ilvl = ilvl;
  }
  const spacing = child(pPr, 'w:spacing');
  if (spacing) {
    const before = flag(spacing.attrs['w:beforeAutospacing'])
      ? AUTO_SPACING
      : num(spacing.attrs['w:before']);
    const after = flag(spacing.attrs['w:afterAutospacing'])
      ? AUTO_SPACING
      : num(spacing.attrs['w:after']);
    if (before !== undefined) out.before = before;
    if (after !== undefined) out.after = after;
  }
  const contextual = onOff(child(pPr, 'w:contextualSpacing'));
  if (contextual !== undefined) out.contextual = contextual;
  const pageBreak = onOff(child(pPr, 'w:pageBreakBefore'));
  if (pageBreak !== undefined) out.pageBreakBefore = pageBreak;
  return out;
}

/** Remove items whose value is undefined (do not override parent level when merging styles). */
const defined = <T extends object>(o: T): { [K in keyof T]?: Exclude<T[K], undefined> } =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };

/** Stylesheet: combined appearance of each style following basedOn (parent style first, own overrides). */
function readStyles(root: XmlElement | undefined) {
  const defs = new Map<string, StyleDef>();
  const defaults = child(root, 'w:docDefaults');
  const baseRun = readRun(child(child(defaults, 'w:rPrDefault'), 'w:rPr'));
  const basePara = readPara(child(child(defaults, 'w:pPrDefault'), 'w:pPr'));
  for (const s of children(root, 'w:style')) {
    const id = s.attrs['w:styleId'];
    if (!id) continue;
    defs.set(id, {
      type: s.attrs['w:type'] ?? 'paragraph',
      name: (child(s, 'w:name')?.attrs['w:val'] ?? id).toLowerCase(),
      ...(child(s, 'w:basedOn')?.attrs['w:val']
        ? { basedOn: child(s, 'w:basedOn')!.attrs['w:val']! }
        : {}),
      run: readRun(child(s, 'w:rPr')),
      para: readPara(child(s, 'w:pPr')),
      ...(child(child(s, 'w:tblPr'), 'w:tblBorders')
        ? { tblBorders: child(child(s, 'w:tblPr'), 'w:tblBorders')! }
        : {}),
      isDefault: flag(s.attrs['w:default']),
    });
  }
  const chain = (id: string | undefined): StyleDef[] => {
    const out: StyleDef[] = [];
    const seen = new Set<string>();
    for (let cur = id; cur && defs.has(cur) && !seen.has(cur); cur = defs.get(cur)!.basedOn) {
      seen.add(cur);
      out.unshift(defs.get(cur)!);
    }
    return out;
  };
  const defaultOf = (type: string) =>
    [...defs.entries()].find(([, d]) => d.type === type && d.isDefault)?.[0];
  const defaultPara = defaultOf('paragraph');
  const runCache = new Map<string, RunStyle>();
  const paraCache = new Map<string, ParaProps>();
  return {
    baseRun,
    basePara,
    defaultPara,
    /** Font styling for paragraph style (falls back to default paragraph style when unspecified). */
    paraRun(id: string | undefined): RunStyle {
      const key = id ?? defaultPara ?? '';
      if (!runCache.has(key)) {
        runCache.set(
          key,
          Object.assign({}, baseRun, ...chain(key).map((d) => defined(d.run))) as RunStyle,
        );
      }
      return runCache.get(key)!;
    },
    para(id: string | undefined): ParaProps {
      const key = id ?? defaultPara ?? '';
      if (!paraCache.has(key)) {
        paraCache.set(
          key,
          Object.assign({}, basePara, ...chain(key).map((d) => defined(d.para))) as ParaProps,
        );
      }
      return paraCache.get(key)!;
    },
    charRun(id: string | undefined): RunStyle {
      return Object.assign({}, ...chain(id).map((d) => defined(d.run))) as RunStyle;
    },
    name: (id: string | undefined) => defs.get(id ?? defaultPara ?? '')?.name ?? '',
    tableBorders(id: string | undefined): XmlElement | undefined {
      return chain(id)
        .reverse()
        .find((d) => d.tblBorders)?.tblBorders;
    },
    numPrOfStyle(id: string): ParaProps {
      return Object.assign({}, ...chain(id).map((d) => defined(d.para))) as ParaProps;
    },
  };
}

type Styles = ReturnType<typeof readStyles>;

interface Level {
  fmt: string;
  text: string;
  start: number;
}

/** numbering.xml: numbering -> numbering format, notation, and starting number for each level. */
function readNumbering(root: XmlElement | undefined, styles: Styles) {
  const abstracts = new Map<string, { levels: Map<number, Level>; link?: string }>();
  const readLevel = (lvl: XmlElement): Level => ({
    fmt: child(lvl, 'w:numFmt')?.attrs['w:val'] ?? 'decimal',
    text: child(lvl, 'w:lvlText')?.attrs['w:val'] ?? '',
    start: num(child(lvl, 'w:start')?.attrs['w:val']) ?? 1,
  });
  for (const a of children(root, 'w:abstractNum')) {
    const id = a.attrs['w:abstractNumId'];
    if (id === undefined) continue;
    const levels = new Map<number, Level>();
    for (const lvl of children(a, 'w:lvl'))
      levels.set(num(lvl.attrs['w:ilvl']) ?? 0, readLevel(lvl));
    const link = child(a, 'w:numStyleLink')?.attrs['w:val'];
    abstracts.set(id, { levels, ...(link ? { link } : {}) });
  }
  const nums = new Map<string, { abstract: string; overrides: Map<number, Partial<Level>> }>();
  for (const n of children(root, 'w:num')) {
    const id = n.attrs['w:numId'];
    const abstract = child(n, 'w:abstractNumId')?.attrs['w:val'];
    if (id === undefined || abstract === undefined) continue;
    const overrides = new Map<number, Partial<Level>>();
    for (const o of children(n, 'w:lvlOverride')) {
      const ilvl = num(o.attrs['w:ilvl']) ?? 0;
      const lvl = child(o, 'w:lvl');
      const start = num(child(o, 'w:startOverride')?.attrs['w:val']);
      overrides.set(ilvl, {
        ...(lvl ? readLevel(lvl) : {}),
        ...(start !== undefined ? { start } : {}),
      });
    }
    nums.set(id, { abstract, overrides });
  }
  const levelOf = (numId: string, ilvl: number, depth = 0): Level | undefined => {
    const n = nums.get(numId);
    if (!n) return undefined;
    let a = abstracts.get(n.abstract);
    // List style (numStyleLink): defined on the numbering of that style.
    if (a?.link && a.levels.size === 0 && depth < 3) {
      const linked = styles.numPrOfStyle(a.link).numId;
      if (linked && linked !== numId) return levelOf(linked, ilvl, depth + 1);
      a = undefined;
    }
    const base = a?.levels.get(ilvl);
    const own = n.overrides.get(ilvl);
    if (!base && !own) return undefined;
    return { fmt: 'decimal', text: '', start: 1, ...base, ...own };
  };
  return { levelOf };
}

/** A styled text run (styles are computed, not relative to the paragraph). */
interface Piece {
  text: string;
  style: RunStyle;
}

type Inline =
  | { kind: 'text'; piece: Piece }
  | { kind: 'image'; src: string; width: number; height: number }
  | { kind: 'pageBreak' }
  | { kind: 'boxes'; content: XmlElement };

/** Image format (based on initial file bytes); returns null for images unviewable in web views (EMF, WMF, TIFF, SVG). */
export function imageExt(bytes: Uint8Array): ImportedImage['ext'] | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
    return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'gif';
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'bmp';
  return null;
}

/** VML length (width:72pt, 1in, 96px, 2.54cm in style) -> points. */
function vmlLength(style: string, key: string): number | undefined {
  const m = new RegExp(`(?:^|;)\\s*${key}\\s*:\\s*([\\d.]+)\\s*(pt|in|px|cm|mm)?`, 'i').exec(style);
  if (!m) return undefined;
  const v = Number(m[1]);
  const unit = (m[2] ?? 'px').toLowerCase();
  const k = { pt: 1, in: 72, px: 0.75, cm: 72 / 2.54, mm: 72 / 25.4 }[unit] ?? 1;
  return v * k;
}

class DocxReader {
  private readonly styles: Styles;
  private readonly numbering: ReturnType<typeof readNumbering>;
  private readonly rels: ReturnType<OoxmlPackage['rels']>;
  readonly images = new Map<string, ImportedImage>();
  /** Footnotes and endnotes: citation order -> numbering ([1], [2]), text is written out at the end of the document in this order. */
  private readonly notes: { kind: 'footnote' | 'endnote'; id: string }[] = [];
  private readonly pages: DocBlock[][] = [[]];
  /** Original styling (points, weight) for each block's text: written as relative to the paragraph only after fully reading and knowing the body font size. */
  private readonly pieces = new Map<DocParagraph | DocList | DocTableLike, Piece[][]>();
  private spacedNext = false;
  private prev: { after: number; style: string | undefined } | null = null;
  private list: { numId: string; ilvl: number; block: DocList } | null = null;
  private readonly counters = new Map<string, number[]>();
  private blockCount = 0;

  constructor(
    private readonly pkg: OoxmlPackage,
    private readonly main: string,
  ) {
    this.rels = pkg.rels(main);
    const rel = (kind: string) =>
      [...this.rels.values()].find((r) => relKind(r) === kind && !r.external);
    const stylesPart = rel('styles')?.target;
    this.styles = readStyles(stylesPart ? pkg.xml(stylesPart) : undefined);
    const numberingPart = rel('numbering')?.target;
    this.numbering = readNumbering(numberingPart ? pkg.xml(numberingPart) : undefined, this.styles);
  }

  private get blocks() {
    return this.pages.at(-1)!;
  }

  private push(block: DocBlock) {
    if (++this.blockCount > MAX_IMPORT_BLOCKS) throw new OfficeImportFailure('tooLarge');
    this.blocks.push(block);
  }

  private newPage() {
    this.closeList();
    if (this.blocks.length) this.pages.push([]);
    this.spacedNext = false;
    this.prev = null;
  }

  private closeList() {
    this.list = null;
  }

  read(): DocxImport {
    const root = this.pkg.xml(this.main);
    const body = child(root, 'w:body');
    if (!body) throw new OfficeImportFailure('damaged');
    this.blockLevel(body);
    this.closeList();
    this.writeNotes();
    return { doc: this.finish(), images: this.images };
  }

  /** A sequence of blocks in the body (or text box, or outside cells). */
  private blockLevel(el: XmlElement) {
    for (const c of children(el)) {
      switch (c.name) {
        case 'w:p':
          this.paragraph(c);
          break;
        case 'w:tbl':
          this.table(c);
          break;
        case 'w:sdt':
          this.blockLevel(child(c, 'w:sdtContent') ?? c);
          break;
        case 'w:customXml':
        case 'w:ins':
        case 'w:moveTo':
          this.blockLevel(c);
          break;
        case 'mc:AlternateContent':
          this.blockLevel(this.choice(c));
          break;
      }
    }
  }

  /** Compatibility content: use the first Choice (new format), or Fallback if none; do not read both (the same content written twice). */
  private choice(alt: XmlElement): XmlElement {
    return (
      child(alt, 'mc:Choice') ?? child(alt, 'mc:Fallback') ?? { name: '', attrs: {}, children: [] }
    );
  }

  /** Inline content of a paragraph, in order of appearance. */
  private inlines(p: XmlElement, paraRun: RunStyle): Inline[] {
    const out: Inline[] = [];
    const walk = (el: XmlElement) => {
      for (const c of children(el)) {
        switch (c.name) {
          case 'w:r':
            this.run(c, paraRun, out);
            break;
          case 'w:hyperlink':
          case 'w:smartTag':
          case 'w:customXml':
          case 'w:ins':
          case 'w:moveTo':
          case 'w:fldSimple':
          case 'w:dir':
          case 'w:bdo':
            walk(c);
            break;
          case 'w:sdt':
            walk(child(c, 'w:sdtContent') ?? c);
            break;
          case 'mc:AlternateContent':
            walk(this.choice(c));
            break;
          case 'm:oMath':
          case 'm:oMathPara': {
            // Formula keeps text only (subscript/superscript and fraction layouts are dropped).
            const text = descendants(c, 'm:t').map(ownText).join('');
            if (text) out.push({ kind: 'text', piece: { text, style: paraRun } });
            break;
          }
          // w:del, w:moveFrom: deleted text in revisions is not displayed (following "accept all"); bookmark and comment ranges are excluded.
        }
      }
    };
    walk(p);
    return out;
  }

  private run(r: XmlElement, paraRun: RunStyle, out: Inline[]) {
    const rPr = child(r, 'w:rPr');
    const style: RunStyle = {
      ...paraRun,
      ...defined(this.styles.charRun(child(rPr, 'w:rStyle')?.attrs['w:val'])),
      ...defined(readRun(rPr)),
    };
    if (style.hidden) return;
    const text = (t: string) => {
      if (t) out.push({ kind: 'text', piece: { text: t, style } });
    };
    for (const c of children(r)) {
      switch (c.name) {
        case 'w:t':
          text(ownText(c));
          break;
        case 'w:tab':
        case 'w:ptab':
          text('\t');
          break;
        case 'w:br':
          if (c.attrs['w:type'] === 'page') out.push({ kind: 'pageBreak' });
          else text('\n');
          break;
        case 'w:cr':
          text('\n');
          break;
        case 'w:noBreakHyphen':
          text('-');
          break;
        case 'w:footnoteReference':
        case 'w:endnoteReference': {
          const id = c.attrs['w:id'];
          if (id === undefined) break;
          const kind = c.name === 'w:footnoteReference' ? 'footnote' : 'endnote';
          this.notes.push({ kind, id });
          text(`[${this.notes.length}]`);
          break;
        }
        case 'w:drawing':
          this.drawing(c, out);
          break;
        case 'w:pict':
        case 'w:object':
          this.vml(c, out);
          break;
        case 'mc:AlternateContent': {
          const alt = this.choice(c);
          this.run({ ...r, children: [...(rPr ? [rPr] : []), ...alt.children] }, paraRun, out);
          break;
        }
        // w:instrText (field codes), w:delText, w:fldChar, w:sym, comment markers: omitted.
      }
    }
  }

  /** Image relationship -> package image (only recognized formats are kept). */
  private image(rid: string | undefined): string | null {
    const rel = rid ? this.rels.get(rid) : undefined;
    if (!rel || rel.external) return null;
    if (this.images.has(rel.target)) return rel.target;
    const bytes = this.pkg.bytes(rel.target);
    const ext = bytes ? imageExt(bytes) : null;
    if (!bytes || !ext) return null;
    this.images.set(rel.target, { bytes, ext });
    return rel.target;
  }

  /** DrawingML: images (including those in groups) and text boxes; charts, SmartArt, and shapes are omitted. */
  private drawing(d: XmlElement, out: Inline[]) {
    const frame = child(d, 'wp:inline') ?? child(d, 'wp:anchor');
    const extent = child(frame, 'wp:extent');
    const pics: XmlElement[] = [];
    const boxes: XmlElement[] = [];
    const walk = (el: XmlElement) => {
      for (const c of children(el)) {
        if (c.name === 'pic:pic') pics.push(c);
        else if (c.name === 'w:txbxContent') boxes.push(c);
        else walk(c);
      }
    };
    walk(d);
    for (const pic of pics) {
      const src = this.image(descendants(pic, 'a:blip')[0]?.attrs['r:embed']);
      if (!src) continue;
      // Images in groups use their own size; single images use the frame size.
      const own = descendants(child(pic, 'pic:spPr'), 'a:ext')[0];
      const size = pics.length === 1 && extent ? extent : (own ?? extent);
      const width = (num(size?.attrs.cx) ?? 200 * EMU_PER_PT) / EMU_PER_PT;
      const height = (num(size?.attrs.cy) ?? 150 * EMU_PER_PT) / EMU_PER_PT;
      out.push({ kind: 'image', src, width: Math.max(1, width), height: Math.max(1, height) });
    }
    for (const content of boxes) out.push({ kind: 'boxes', content });
  }

  /** VML (images, text boxes written by older Word, preview images of w:object). */
  private vml(el: XmlElement, out: Inline[]) {
    const walk = (e: XmlElement) => {
      for (const c of children(e)) {
        if (c.name === 'w:txbxContent') {
          out.push({ kind: 'boxes', content: c });
          continue;
        }
        if (c.name === 'v:imagedata') {
          const src = this.image(c.attrs['r:id']);
          const style = e.attrs.style ?? '';
          if (src) {
            out.push({
              kind: 'image',
              src,
              width: vmlLength(style, 'width') ?? 200,
              height: vmlLength(style, 'height') ?? 150,
            });
          }
          continue;
        }
        walk(c);
      }
    };
    walk(el);
  }

  private paraInfo(p: XmlElement) {
    const pPr = child(p, 'w:pPr');
    const styleId = child(pPr, 'w:pStyle')?.attrs['w:val'];
    const props: ParaProps = { ...this.styles.para(styleId), ...defined(readPara(pPr)) };
    return { styleId, props, run: this.styles.paraRun(styleId) };
  }

  /** Heading level: style name is heading 1 / 2 (or Title), outline level is 1 / 2; lower headings are treated as body text (font size and weight kept as is). */
  private headingOf(styleId: string | undefined, props: ParaProps): 1 | 2 | undefined {
    const name = this.styles.name(styleId);
    const m = /^heading\s*([1-9])$/.exec(name);
    const level = m
      ? Number(m[1])
      : name === 'title'
        ? 1
        : props.outline !== undefined && props.outline < 9
          ? props.outline + 1
          : undefined;
    return level === 1 || level === 2 ? level : undefined;
  }

  private paragraph(p: XmlElement) {
    const { styleId, props, run } = this.paraInfo(p);
    if (props.pageBreakBefore) this.newPage();
    const items = this.inlines(p, run);
    const level =
      props.numId && props.numId !== '0'
        ? this.numbering.levelOf(props.numId, props.ilvl ?? 0)
        : undefined;
    const numbered = !!level && level.fmt !== 'none' && level.text !== '';
    // Paragraphs lacking numbering definitions but starting with symbols or numbering followed by a tab (macOS "TextEdit", Word saved by textutil): also treated as list items.
    const typed = numbered ? null : typedMarker(items);
    const isList = numbered || typed !== null;
    const heading = this.headingOf(styleId, props);
    // Space before (space before this paragraph plus space after previous paragraph, ignoring cases where the same style specifies "no paragraph spacing").
    const gap =
      this.prev && !(props.contextual && this.prev.style === styleId)
        ? (props.before ?? 0) + this.prev.after
        : (props.before ?? 0);
    let spaced = this.spacedNext || (this.prev !== null && gap >= SPACED_TWIP);
    let pieces: Piece[] = [];
    let wrote = false;
    let listed = false;
    const deferred: XmlElement[] = [];
    const flush = () => {
      const text = pieces.map((x) => x.text).join('');
      if (!text.trim()) {
        pieces = [];
        return;
      }
      if (isList && !listed) {
        if (typed) this.listItem(typed.key, 0, typed.level, pieces, spaced, typed.n);
        else this.listItem(props.numId!, props.ilvl ?? 0, level!, pieces, spaced);
        listed = true;
      } else {
        this.closeList();
        const block: DocParagraph = {
          kind: 'paragraph',
          text,
          ...(heading ? { heading } : {}),
          ...(alignOf(props.jc) ? { align: alignOf(props.jc)! } : {}),
          ...(spaced ? { spaced: true } : {}),
          box: BOX,
        };
        this.pieces.set(block, [pieces]);
        this.push(block);
      }
      wrote = true;
      spaced = false;
      pieces = [];
    };
    for (const item of items) {
      if (item.kind === 'text') pieces.push(item.piece);
      else if (item.kind === 'boxes') deferred.push(item.content);
      else if (item.kind === 'pageBreak') {
        flush();
        this.newPage();
        spaced = false;
      } else {
        flush();
        this.closeList();
        const center = alignOf(props.jc);
        const width = Math.min(item.width, CONTENT_PT);
        const x =
          center === 'center'
            ? (CONTENT_PT - width) / 2
            : center === 'right'
              ? CONTENT_PT - width
              : 0;
        this.push({
          kind: 'image',
          src: item.src,
          box: { x: Math.max(0, x), y: 0, width: item.width, height: item.height },
        });
        wrote = true;
        spaced = false;
      }
    }
    flush();
    if (wrote) {
      this.spacedNext = false;
      this.prev = { after: props.after ?? 0, style: styleId };
    } else if (this.prev || this.blocks.length) {
      // Empty paragraph: original spacing existed between the next block and the preceding block.
      this.spacedNext = true;
    }
    // Text box text is appended after its containing paragraph.
    for (const content of deferred) this.blockLevel(content);
  }

  private listItem(
    numId: string,
    ilvl: number,
    level: Level,
    pieces: Piece[],
    spaced: boolean,
    /** In-line numbering (lists without numbering definitions): starts a new list when it fails to match the expected sequence. */
    typed?: number,
  ) {
    // Numbering: current count for each level of each list; lower levels restart when a higher level appears.
    const counts = this.counters.get(numId) ?? [];
    for (let k = ilvl + 1; k < counts.length; k++) counts[k] = 0;
    const next = counts[ilvl] ? counts[ilvl]! + 1 : level.start;
    const n = typed ?? next;
    counts[ilvl] = n;
    this.counters.set(numId, counts);
    const text = pieces.map((x) => x.text).join('');
    const open = this.list;
    if (open && open.numId === numId && open.ilvl === ilvl && n === next) {
      open.block.items.push(text);
      this.pieces.get(open.block)!.push(pieces);
      return;
    }
    const ordered = level.fmt !== 'bullet';
    const own = `%${ilvl + 1}`;
    // Numbering format retains only the current level ("%1.%2." style multi-level numbers are written as "%1.").
    const format = ordered
      ? level.text.includes(own) && !/%[1-9]/.test(level.text.split(own).join(''))
        ? level.text.split(own).join('%1')
        : '%1.'
      : undefined;
    const block: DocList = {
      kind: 'list',
      ordered,
      ...(format ? { format } : {}),
      // When "%1" lacks symbols, writeDocx writes circled numbers (D-328): starting number is written only if originally circled.
      ...(ordered && (format !== '%1' || level.fmt === 'decimalEnclosedCircle')
        ? { start: n }
        : {}),
      items: [text],
      ...(spaced ? { spaced: true } : {}),
      box: BOX,
    };
    this.pieces.set(block, [pieces]);
    this.push(block);
    this.list = { numId, ilvl, block };
  }

  /** Cell text: paragraphs line by line; list items prefixed with symbols/numbers; nested tables line by line, cells separated by tabs. */
  private cellText(tc: XmlElement, images: Inline[], pieces: Piece[]): string {
    const lines: string[] = [];
    const counters = new Map<string, number>();
    const walk = (el: XmlElement) => {
      for (const c of children(el)) {
        if (c.name === 'w:p') {
          const { props, run } = this.paraInfo(c);
          const items = this.inlines(c, run);
          let text = '';
          for (const item of items) {
            if (item.kind === 'text') {
              text += item.piece.text;
              pieces.push(item.piece);
            } else if (item.kind === 'image') images.push(item);
            else if (item.kind === 'pageBreak') text += '\n';
            else {
              const inner: string[] = [];
              for (const p of descendants(item.content, 'w:p')) {
                inner.push(
                  this.inlines(p, run)
                    .map((x) => (x.kind === 'text' ? x.piece.text : ''))
                    .join(''),
                );
              }
              text += (text ? '\n' : '') + inner.join('\n');
            }
          }
          const level =
            props.numId && props.numId !== '0'
              ? this.numbering.levelOf(props.numId, props.ilvl ?? 0)
              : undefined;
          if (level && level.fmt !== 'none' && level.text && text.trim()) {
            const key = `${props.numId}/${props.ilvl ?? 0}`;
            const n = (counters.get(key) ?? level.start - 1) + 1;
            counters.set(key, n);
            text = `${level.fmt === 'bullet' ? '•' : `${n}.`} ${text}`;
          }
          lines.push(text);
        } else if (c.name === 'w:tbl') {
          for (const tr of this.rowsOf(c)) {
            lines.push(
              this.cellsOf(tr)
                .map((cell) => this.cellText(cell, images, pieces).replace(/\n/g, ' '))
                .join('\t'),
            );
          }
        } else if (c.name === 'w:sdt') walk(child(c, 'w:sdtContent') ?? c);
        else if (c.name === 'w:customXml' || c.name === 'w:ins' || c.name === 'w:moveTo') walk(c);
      }
    };
    walk(tc);
    // Trailing empty lines at the end of cells (Word cells always end with a paragraph) are removed.
    while (lines.length && !lines.at(-1)!.trim()) lines.pop();
    return lines.join('\n');
  }

  private rowsOf(tbl: XmlElement): XmlElement[] {
    const out: XmlElement[] = [];
    const walk = (el: XmlElement) => {
      for (const c of children(el)) {
        if (c.name === 'w:tr') out.push(c);
        else if (c.name === 'w:sdt') walk(child(c, 'w:sdtContent') ?? c);
        else if (c.name === 'w:customXml' || c.name === 'w:ins') walk(c);
      }
    };
    walk(tbl);
    return out;
  }

  private cellsOf(tr: XmlElement): XmlElement[] {
    const out: XmlElement[] = [];
    const walk = (el: XmlElement) => {
      for (const c of children(el)) {
        if (c.name === 'w:tc') out.push(c);
        else if (c.name === 'w:sdt') walk(child(c, 'w:sdtContent') ?? c);
        else if (c.name === 'w:customXml') walk(c);
      }
    };
    walk(tr);
    return out;
  }

  private table(tbl: XmlElement) {
    this.closeList();
    const grid = children(child(tbl, 'w:tblGrid'), 'w:gridCol').map(
      (g) => (num(g.attrs['w:w']) ?? 0) / 20,
    );
    const tblPr = child(tbl, 'w:tblPr');
    const cells: TableCell[] = [];
    /** Which cell each position in each row belongs to. */
    const owner: number[][] = [];
    const images: Inline[] = [];
    const pieces: Piece[] = [];
    let visible = false;
    const rows = this.rowsOf(tbl);
    rows.forEach((tr, r) => {
      owner[r] = [];
      const trPr = child(tr, 'w:trPr');
      let col = num(child(trPr, 'w:gridBefore')?.attrs['w:val']) ?? 0;
      for (const tc of this.cellsOf(tr)) {
        const tcPr = child(tc, 'w:tcPr');
        const span = Math.max(1, num(child(tcPr, 'w:gridSpan')?.attrs['w:val']) ?? 1);
        const vMerge = child(tcPr, 'w:vMerge');
        const hMerge = child(tcPr, 'w:hMerge');
        const borders = child(tcPr, 'w:tcBorders');
        if (borders && hasVisibleBorder(borders)) visible = true;
        const text = this.cellText(tc, images, pieces);
        // Vertically merged continuation cell: linked to the cell in the same column of the previous row.
        const above = r > 0 ? owner[r - 1]![col] : undefined;
        if (vMerge && vMerge.attrs['w:val'] !== 'restart' && above !== undefined) {
          const cell = cells[above]!;
          if (cell.col === col && cell.row + cell.rowSpan === r) {
            cell.rowSpan++;
            for (let k = col; k < col + cell.colSpan; k++) owner[r]![k] = above;
            col += span;
            continue;
          }
        }
        // Legacy horizontally merged cell (hMerge): continuation cell merged into the cell to its left.
        const left = col > 0 ? owner[r]![col - 1] : undefined;
        if (hMerge && hMerge.attrs['w:val'] !== 'restart' && left !== undefined) {
          const cell = cells[left]!;
          if (cell.row === r) {
            cell.colSpan += span;
            for (let k = col; k < col + span; k++) owner[r]![k] = left;
            col += span;
            continue;
          }
        }
        const jc = this.paraInfo(child(tc, 'w:p') ?? tc).props.jc;
        const i = cells.length;
        cells.push({
          row: r,
          col,
          rowSpan: 1,
          colSpan: span,
          text,
          ...(alignOf(jc) ? { align: alignOf(jc)! } : {}),
        });
        for (let k = col; k < col + span; k++) owner[r]![k] = i;
        col += span;
      }
    });
    const cols = Math.max(grid.length, ...owner.map((row) => row.length), 0);
    if (!rows.length || !cols) return;
    // Grid positions lacking cells (gridBefore / gridAfter, rows shorter than others) are padded with empty cells: each position belongs to exactly one cell.
    for (let r = 0; r < rows.length; r++) {
      for (let c = 0; c < cols; c++) {
        if (owner[r]![c] === undefined) {
          owner[r]![c] = cells.length;
          cells.push({ row: r, col: c, rowSpan: 1, colSpan: 1, text: '' });
        }
      }
    }
    cells.sort((a, b) => a.row - b.row || a.col - b.col);
    // Column width: specified in the grid (points); unassigned or zero-width columns evenly split the content area.
    const fallback = CONTENT_PT / cols;
    const colWidths = Array.from({ length: cols }, (_, c) =>
      grid[c] && grid[c]! > 1 ? grid[c]! : fallback,
    );
    const direct = child(tblPr, 'w:tblBorders');
    const styled = this.styles.tableBorders(child(tblPr, 'w:tblStyle')?.attrs['w:val']);
    if ((direct ?? styled) && hasVisibleBorder((direct ?? styled)!)) visible = true;
    const width = colWidths.reduce((a, b) => a + b, 0);
    const table: DocTableLike = {
      kind: 'table',
      ...(visible ? {} : { borderless: true }),
      table: { kind: 'table', rows: rows.length, col: 0, cols, cells, box: { ...BOX, width } },
      colWidths,
      box: { ...BOX, width },
    };
    this.pieces.set(table, [pieces]);
    this.push(table);
    this.spacedNext = false;
    this.prev = { after: 0, style: undefined };
    // Images inside cells are placed after the table (cells contain text only).
    for (const item of images) {
      if (item.kind !== 'image') continue;
      this.push({
        kind: 'image',
        src: item.src,
        box: { x: 0, y: 0, width: item.width, height: item.height },
      });
    }
  }

  /** Footnote and endnote text is placed at the end of the document, one paragraph per entry, preceded by the body marker. */
  private writeNotes() {
    if (!this.notes.length) return;
    const parts = new Map<string, Map<string, XmlElement>>();
    const partOf = (kind: 'footnote' | 'endnote') => {
      if (!parts.has(kind)) {
        const rel = [...this.rels.values()].find((r) => relKind(r) === `${kind}s` && !r.external);
        const root = rel ? this.pkg.xml(rel.target) : undefined;
        parts.set(
          kind,
          new Map(children(root, `w:${kind}`).map((n) => [n.attrs['w:id'] ?? '', n])),
        );
      }
      return parts.get(kind)!;
    };
    let first = true;
    this.notes.forEach((note, i) => {
      const el = partOf(note.kind).get(note.id);
      if (!el) return;
      const body: Piece[] = [];
      children(el, 'w:p').forEach((p, k) => {
        const { run } = this.paraInfo(p);
        if (k) body.push({ text: ' ', style: run });
        for (const item of this.inlines(p, run)) {
          if (item.kind === 'text') body.push(item.piece);
        }
      });
      // Footnotes originally having a space after the marker: leading whitespace is stripped, and the marker is converted to [n].
      while (body.length && !body[0]!.text.trim()) body.shift();
      if (!body.length) return;
      body[0] = { ...body[0]!, text: body[0]!.text.trimStart() };
      const pieces = [{ text: `[${i + 1}] `, style: body[0]!.style }, ...body];
      const text = pieces.map((x) => x.text).join('');
      const block: DocParagraph = {
        kind: 'paragraph',
        text,
        ...(first ? { spaced: true } : {}),
        box: BOX,
      };
      first = false;
      this.pieces.set(block, [pieces]);
      this.push(block);
    });
  }

  /** Finished reading: determine body font size based on the most frequent font size in the text, and write each block's text relative to the paragraph. */
  private finish(): DocDoc {
    const sizes = new Map<number, number>();
    for (const [block, lists] of this.pieces) {
      if (block.kind === 'paragraph' && block.heading) continue;
      for (const list of lists) {
        for (const p of list) {
          const n = p.text.replace(/\s/g, '').length;
          const size = p.style.size ?? DEFAULT_SIZE;
          sizes.set(size, (sizes.get(size) ?? 0) + n);
        }
      }
    }
    const bodySize =
      [...sizes].sort((a, b) => b[1] - a[1])[0]?.[0] ??
      this.styles.paraRun(undefined).size ??
      DEFAULT_SIZE;
    for (const [block, lists] of this.pieces) {
      if (block.kind === 'table') {
        const size = dominant(lists.flat(), (s) => s.size ?? DEFAULT_SIZE);
        if (size !== undefined && Math.abs(size - bodySize) >= 0.5) block.size = size;
        continue;
      }
      const all = lists.flat();
      const base: RunStyle = defined({
        size: dominant(all, (s) => s.size ?? DEFAULT_SIZE),
        bold: dominant(all, (s) => !!s.bold),
        italic: dominant(all, (s) => !!s.italic),
        underline: dominant(all, (s) => !!s.underline),
      });
      const heading = block.kind === 'paragraph' && block.heading;
      if (base.size !== undefined && (heading || Math.abs(base.size - bodySize) >= 0.5))
        block.size = base.size;
      if (base.bold) block.bold = true;
      if (base.italic) block.italic = true;
      if (base.underline) block.underline = true;
      // Color can only be uniform per paragraph: written only when all text runs in the paragraph share the same color (when not black or automatic).
      const colors = new Set(all.filter((p) => p.text.trim()).map((p) => colorOf(p.style.color)));
      if (colors.size === 1) {
        const color = [...colors][0];
        if (color) block.color = color;
      }
      const own = lists.map((pieces) => ownRuns(pieces, base));
      if (block.kind === 'paragraph') {
        if (own[0]) block.runs = own[0];
      } else if (own.some(Boolean)) block.itemRuns = own.map((r) => r ?? null);
    }
    const pages = this.pages.filter((p, i) => p.length || i === 0);
    return {
      version: 1,
      pages: pages.map((blocks) => ({
        source: '',
        width: A4_WIDTH_PT,
        height: A4_HEIGHT_PT,
        bodySize,
        blocks,
      })),
    };
  }
}

/** In-line list marker: starts with an optional tab, followed by a symbol or 1-3 digit number (optionally followed by . or )), and another tab. */
const TYPED_MARKER = /^\t?(?:([•◦▪●○■□–·-])|(\d{1,3})[.)]?)\t/;

/** Strips the list marker when present at the start of a paragraph (modifying the text read from this paragraph), and returns the matched list type. */
function typedMarker(items: Inline[]): { key: string; level: Level; n?: number } | null {
  const texts = items.filter((i): i is Extract<Inline, { kind: 'text' }> => i.kind === 'text');
  const head = texts
    .map((i) => i.piece.text)
    .join('')
    .slice(0, 8);
  const m = TYPED_MARKER.exec(head);
  if (!m) return null;
  let left = m[0].length;
  for (const item of texts) {
    if (!left) break;
    const cut = Math.min(left, item.piece.text.length);
    item.piece = { ...item.piece, text: item.piece.text.slice(cut) };
    left -= cut;
  }
  return m[1]
    ? { key: '#typed-bullet', level: { fmt: 'bullet', text: '•', start: 1 } }
    : { key: '#typed-number', level: { fmt: 'decimal', text: '%1.', start: 1 }, n: Number(m[2]) };
}

/** DocTable representation (size must also be modified during reading). */
type DocTableLike = Extract<DocBlock, { kind: 'table' }>;

function hasVisibleBorder(borders: XmlElement): boolean {
  return children(borders).some((b) => !['nil', 'none'].includes(b.attrs['w:val'] ?? 'none'));
}

function alignOf(jc: string | undefined): CellAlign | undefined {
  if (jc === 'center') return 'center';
  if (jc === 'right' || jc === 'end') return 'right';
  return undefined;
}

const colorOf = (c: string | undefined) =>
  c && /^[0-9a-fA-F]{6}$/.test(c) && c !== '000000' ? c.toUpperCase() : undefined;

/** The most frequent value among a set of text runs (excluding whitespace; falls back to length if all whitespace). */
function dominant<T>(pieces: readonly Piece[], read: (s: RunStyle) => T): T | undefined {
  const count = new Map<T, number>();
  for (const p of pieces) {
    const n = p.text.replace(/\s/g, '').length || p.text.length * 0.001;
    count.set(read(p.style), (count.get(read(p.style)) ?? 0) + n);
  }
  return [...count].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/** Runs differing from the paragraph style (same as ownRuns in doc-runs): identical items are omitted, and adjacent runs with the same style are merged. */
function ownRuns(pieces: readonly Piece[], base: RunStyle): DocRun[] | undefined {
  const out: DocRun[] = [];
  for (const p of pieces) {
    if (!p.text) continue;
    const run: DocRun = { text: p.text };
    const size = p.style.size ?? DEFAULT_SIZE;
    if (base.size !== undefined && Math.abs(size - base.size) >= 0.5) run.size = size;
    if (!!p.style.bold !== !!base.bold) run.bold = !!p.style.bold;
    if (!!p.style.italic !== !!base.italic) run.italic = !!p.style.italic;
    if (!!p.style.underline !== !!base.underline) run.underline = !!p.style.underline;
    const last = out.at(-1);
    if (last && sameRun(last, run)) {
      last.text += run.text;
      continue;
    }
    out.push(run);
  }
  return out.some((r) => Object.keys(r).length > 1) ? out : undefined;
}

const sameRun = (a: DocRun, b: DocRun) =>
  a.size === b.size && a.bold === b.bold && a.italic === b.italic && a.underline === b.underline;

/** Read an incoming docx. Throws OfficeImportFailure when password-protected, not a docx, corrupted, or too large. */
export function importDocx(data: Uint8Array): DocxImport {
  const pkg = openPackage(
    data,
    (name) =>
      /\.(xml|rels)$/i.test(name) || /^word\/media\//i.test(name) || /\/media\//i.test(name),
    (name) => /\/media\//i.test(name),
  );
  const main = pkg.main() ?? (pkg.xml('word/document.xml') ? 'word/document.xml' : undefined);
  const root = main ? pkg.xml(main) : undefined;
  if (!main || !root) throw new OfficeImportFailure('notOffice');
  if (root.name !== 'w:document') throw new OfficeImportFailure('notOffice');
  return new DocxReader(pkg, main).read();
}
