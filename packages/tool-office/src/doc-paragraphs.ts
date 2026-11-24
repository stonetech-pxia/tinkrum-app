import type { PageBuildContext } from './doc-build-state';
import { type PreparePageState } from './doc-prepare';
import { type RuledTablesState } from './doc-ruled-tables';
import {
  type DocLeaf,
  type DocList,
  type DocParagraph,
  HEADING1_RATIO,
  HEADING_RATIO,
  INDENT_LINES,
  INDENT_MAX,
  INDENT_MIN,
  PAGE_CENTER,
  PAGE_CENTER_MARGIN,
  alignmentIn,
  listMarker,
  looksLikeHeading,
  notHeading,
  paragraphsOf,
  stripMarker,
  unionBox,
} from './doc-support';
import { type TextLinesState } from './doc-text-lines';
import { type TextTablesState } from './doc-text-tables';
import { type PageTypographyState } from './doc-typography';
import { type TableCell } from './types';

/** Generate paragraphs, headings, lists, and label-value pairs by group. */
export function buildParagraphBlocks(
  state: Pick<
    PageTypographyState,
    'groups' | 'units' | 'styleOf' | 'textRight' | 'origin' | 'bodySize' | 'textLeft' | 'alignment'
  > &
    Pick<PreparePageState, 'join' | 'joinParagraph' | 'image'> &
    Pick<TextTablesState, 'free'> &
    Pick<TextLinesState, 'releasedCells' | 'orig'> &
    Pick<RuledTablesState, 'rejected' | 'placedIn'> &
    Pick<PageBuildContext, 'input'>,
) {
  const {
    groups,
    units,
    join,
    styleOf,
    free,
    textRight,
    releasedCells,
    orig,
    origin,
    joinParagraph,
    rejected,
    placedIn,
    bodySize,
    input,
    image,
    textLeft,
    alignment,
  } = state;

  for (const group of groups) {
    const blocks: DocLeaf[] = [];
    units.push({ box: group.box, blocks });
    if (group.pairs) {
      // One pair per line: label, tab, value (D-332).
      const text = group.pairs
        .map(([label, value]) => `${join(label).trim()}\t${join(value).trim()}`)
        .join('\n');
      const left = Math.min(...group.pairs.flatMap(([label]) => label.map((l) => l.x)));
      const valueLeft = Math.min(...group.pairs.flatMap(([, value]) => value.map((l) => l.x)));
      blocks.push({
        kind: 'paragraph',
        text,
        ...styleOf(group.lines, text, 0).style,
        tab: Math.round(valueLeft - left),
        spaced: true,
        box: group.box,
      });
      continue;
    }
    const members = new Set(group.lines);
    const paragraphs = paragraphsOf(
      group.lines,
      free.filter((l) => !members.has(l)),
      textRight,
    ).flatMap((para) => {
      const chunks: (typeof para)[] = [];
      let previousCell: TableCell | undefined;
      let previousReleased = false;
      for (const row of para.rows) {
        const cells = new Set(row.lines.map((l) => releasedCells.get(orig(l))).filter(Boolean));
        const cell = cells.size === 1 ? [...cells][0] : undefined;
        const released = cells.size > 0;
        const previous = chunks.at(-1);
        // Different cells of misidentified grids remain independent information lines; do not merge
        // two agenda items into a single paragraph simply because borders were removed. Do not
        // merge body text outside grids with the first line inside grids either (one side is the
        // original paragraph, the other is lines released after border removal).
        if (
          previous &&
          released === previousReleased &&
          (!cell || !previousCell || cell === previousCell)
        )
          previous.rows.push(row);
        else chunks.push({ ...para, rows: [row], spaced: chunks.length ? false : para.spaced });
        previousCell = cell;
        previousReleased = released;
      }
      return chunks;
    });
    // The first paragraph of a block was originally spaced from the preceding block.
    if (paragraphs[0]) paragraphs[0].spaced = true;
    let list: DocList | null = null;
    const groupLeft = Math.min(...group.lines.map((l) => l.x));
    const groupWidth = Math.max(...group.lines.map((l) => l.x + l.width)) - groupLeft;
    for (const para of paragraphs) {
      const paraLines = para.rows.flatMap((r) => r.lines);
      const box = unionBox(paraLines);
      const repaired =
        new Set(paraLines.map((l) => origin.get(l))).size > 1 ||
        para.rows.some(
          (r, i) =>
            i > 0 && /\d[-–—]\s*$/.test(para.rows[i - 1]!.text) && /^\s*\d+\.?\s*$/.test(r.text),
        );
      const text = (repaired ? joinParagraph : join)(paraLines).trim();
      if (!text) continue;
      const { h, short, size, style } = styleOf(paraLines, text, group.title);
      // Items without text after removing numbering ('(3).') are not treated as list items. Text
      // released from misidentified grids retains its original title/numbering; do not generate new
      // automatic numbering for these lines.
      const released = paraLines.some((l) =>
        rejected.some((t) => placedIn.get(t)?.includes(orig(l))),
      );
      if (para.list && !released && /[\p{L}\p{N}]/u.test(stripMarker(text))) {
        const marker = listMarker(para.rows[0]!.text);
        // Same numbering sequence continuing the previous list; a different formatting style starts
        // a new one. Numbering that does not continue the previous item ('1.
        // D\u00e9lib\u00e9rations' following agendas 1\u20136) also starts a new list: lists record
        // only the first item's number, and merging would misnumber subsequent items as 7 and 8 (EU
        // sample 037).
        if (
          list &&
          list.ordered === marker.ordered &&
          list.format === marker.format &&
          (!marker.ordered || marker.start === (list.start ?? 1) + list.items.length) &&
          !para.spaced
        ) {
          list.items.push(stripMarker(text));
          list.box = unionBox([list.box, box]);
          continue;
        }
        list = {
          kind: 'list',
          ...marker,
          items: [stripMarker(text)],
          ...style,
          ...(para.spaced ? { spaced: true } : {}),
          box,
        };
        if (!marker.format) delete list.format;
        if (marker.start === undefined) delete list.start;
        blocks.push(list);
        continue;
      }
      list = null;
      // Heading: recognized by the model as a heading (text no smaller than body), or text significantly larger than body text and up to two lines; dialogue and full sentences are excluded (D-330).
      const big =
        !short &&
        size >= HEADING_RATIO * bodySize &&
        para.rows.length <= 2 &&
        looksLikeHeading(text);
      // Lines in regions identified by the model as headings that match body text size and lack bold styling (such as letterhead addresses or phone numbers) are treated as body text (D-463).
      const titled = group.title > 0 && (size > bodySize || style.bold === true);
      const headingLike = (titled || big) && !notHeading(text);
      const heading: 0 | 1 | 2 = headingLike
        ? (titled && group.title === 1) || size >= HEADING1_RATIO * bodySize
          ? 1
          : 2
        : 0;
      const pageCenteredHeading =
        input.paper &&
        heading &&
        para.rows.length <= 2 &&
        Math.min(box.x, image.width - box.x - box.width) > PAGE_CENTER_MARGIN * image.width &&
        Math.abs(box.x - (image.width - box.x - box.width)) < PAGE_CENTER * image.width;
      // Paragraphs with left-aligned and ragged right lines are left-aligned paragraphs, even if the overall left/right margins are roughly balanced (EU sample 036: full-page graphics compressing margins).
      const lefts = para.rows.map((r) => r.box.x);
      const rights = para.rows.map((r) => r.box.x + r.box.width);
      const raggedRight =
        para.rows.length >= 2 &&
        Math.max(...lefts) - Math.min(...lefts) <= 0.5 * h &&
        Math.max(...rights) - Math.min(...rights) > 1.5 * h;
      const boxAlign = alignmentIn(box, h, para.rows.length, textLeft, textRight, image.width);
      const align = pageCenteredHeading
        ? 'center'
        : boxAlign === 'center' && raggedRight
          ? undefined
          : boxAlign;
      const centered = align === 'center';
      const right = align === 'right';
      // First-line indentation: left position of the first line compared to other lines, up to 4
      // line heights (D-330). Single-line paragraphs have no first-line indentation (D-463): DOCX
      // sets each paragraph's left indent based on its original layout position (dialogues on
      // single lines in books are indented similarly), adding first-line indentation would apply it
      // twice.
      const first = para.rows[0]!.box.x;
      const base = Math.min(...para.rows.slice(1).map((r) => r.box.x));
      const indent = Math.round(first - base);
      const indented =
        para.rows.length > 1 &&
        !heading &&
        !centered &&
        !right &&
        indent >= INDENT_MIN * h &&
        indent <= Math.min(INDENT_MAX * groupWidth, INDENT_LINES * h);
      const paragraph: DocParagraph = {
        kind: 'paragraph',
        text,
        ...(heading ? { heading } : {}),
        ...style,
        // Headings specify their own font size (D-463): otherwise scaling up by 1.3x or 1.6x according to heading styles makes them larger than the original.
        ...(heading ? { size } : {}),
        ...(centered ? { align: 'center' as const } : right ? { align: 'right' as const } : {}),
        ...(para.spaced ? { spaced: true } : {}),
        ...(indented ? { indent } : {}),
        box,
      };
      blocks.push(paragraph);
      alignment.set(paragraph, { h, rows: para.rows.length });
    }
  }
}
