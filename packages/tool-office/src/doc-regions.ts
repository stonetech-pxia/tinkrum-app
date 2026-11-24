import { type PageBuildContext, type StageState, donePage, nextStage } from './doc-build-state';
import { type PreparePageState } from './doc-prepare';
import { type RuledTablesState } from './doc-ruled-tables';
import {
  type DocImage,
  type Group,
  IMAGE_PAD,
  MARKER_GAP,
  PAGE_NUMBER,
  clustersOf,
  listStart,
  mergeTextRegions,
  pairForms,
  splitAtGutter,
  splitLabelColumn,
  stripMarker,
  unionBox,
} from './doc-support';
import { type TextLinesState } from './doc-text-lines';
import { type TextTablesState } from './doc-text-tables';
import { assignLines, cleanRegions, lineShareIn } from './layout';
import { findPageGutter } from './word-gutter';

/** Assign regions, images, and two-column layouts, pairing form labels with values. */
export function assignPageRegions(
  state: Pick<
    PreparePageState,
    'image' | 'layout' | 'figures' | 'native' | 'previous' | 'lineHeight' | 'owns'
  > &
    Pick<TextTablesState, 'free' | 'barcodes' | 'early'> &
    Pick<RuledTablesState, 'tables'> &
    Pick<PageBuildContext, 'buildPage' | 'input' | 'options' | 'repairTables' | 'repairBarcodes'> &
    Pick<TextLinesState, 'verticals'>,
) {
  const {
    image,
    layout,
    figures,
    free,
    tables,
    native,
    previous,
    buildPage,
    input,
    options,
    repairTables,
    repairBarcodes,
    lineHeight,
    owns,
    barcodes,
    verticals,
    early,
  } = state;

  const size = { width: image.width, height: image.height };
  const protectedImages = new Set(layout.filter((r) => figures.some((f) => r.box === f.box)));
  const regions = cleanRegions(layout, free, size, image, protectedImages).filter(
    // Exclude regions overlapping significantly with tables (table header rows, table contents misidentified as body text).
    (r) => {
      // Native full images inside a table cell (logos in headers, ID photos in forms, EU sample
      // 090): cells cannot contain images, so the image is retained and placed before the table,
      // preventing full-page image revocation caused by table intersection.
      if (
        r.kind === 'image' &&
        protectedImages.has(r) &&
        tables.some((t) => t.table.cells.some((c) => c.box && lineShareIn(r.box, c.box) >= 0.8))
      )
        return true;
      const overlaps = tables.map(({ box }) => {
        const ix = Math.min(box.x + box.width, r.box.x + r.box.width) - Math.max(box.x, r.box.x);
        const iy = Math.min(box.y + box.height, r.box.y + r.box.height) - Math.max(box.y, r.box.y);
        return ix > 0 && iy > 0 ? ix * iy : 0;
      });
      const half = 0.5 * r.box.width * r.box.height;
      // Image regions covered significantly by multiple combined tables also count (small tables inside form cells, D-524).
      const covered = r.kind === 'image' ? overlaps.reduce((a, b) => a + b, 0) : 0;
      return covered <= half && overlaps.every((o) => o <= half);
    },
  );
  // Takeover is a page-level transaction: if subsequent deduplication or table filtering discards
  // any full image, OCR/pixel isolation is revoked and the original path is used. For non-native
  // full images, previous is the original path result with identical parameters, avoiding
  // re-reconstruction.
  if (figures.some((f) => !regions.some((r) => r.kind === 'image' && r.box === f.box)))
    return donePage(
      !native && previous
        ? previous
        : buildPage(input, options, false, repairTables, repairBarcodes),
    );
  const merged = mergeTextRegions(regions, lineHeight);
  regions.splice(0, regions.length, ...merged);
  const owner = assignLines(free, regions);
  // Isolated numbering at the beginning of a line joins the same-row provisions on the right into the same region (layout models often group numbering into adjacent large regions, EU sample 032).
  for (const [i, l] of free.entries()) {
    if (!listStart(l.text) || stripMarker(l.text)) continue;
    const next = free
      .map((t, k) => ({ t, k }))
      .filter(
        ({ t }) =>
          t.x > l.x + l.width &&
          t.x - (l.x + l.width) <= MARKER_GAP * lineHeight &&
          Math.min(t.y + t.height, l.y + l.height) - Math.max(t.y, l.y) >=
            0.5 * Math.min(t.height, l.height),
      )
      .sort((a, b) => a.t.x - b.t.x)[0];
    if (next && regions[owner[next.k]!]?.kind !== 'image') owner[i] = owner[next.k]!;
  }
  if (native)
    for (const [i, l] of free.entries()) {
      const region = regions[owner[i] ?? -1];
      if (region?.kind === 'image' && figures.some((f) => f.box === region.box) && !owns(l))
        owner[i] = -1;
    }
  // Page-level label columns (e.g., 'Step 3:' in W-4): layout models segment each step into tiny regions, requiring page-level searching.
  const labelSplit = splitLabelColumn(free, lineHeight);
  // Lines within regions; exclude page number text and minor text within image regions (logos, text in photos).
  let groups: Group[] = [];
  // When layout models also misidentify barcodes as image regions, use only the region's version (preventing duplicate occurrences of the same barcode).
  const pictured = regions.filter((r) => r.kind === 'image').map((r) => r.box);
  const images: DocImage[] = [
    ...barcodes.filter((b) => !pictured.some((r) => lineShareIn(b, r) >= 0.8)),
    ...verticals,
  ].map((box) => ({ kind: 'image', box }));
  for (const [i, region] of regions.entries()) {
    const members = free.filter((_, k) => owner[k] === i);
    if (region.kind === 'image') {
      // Model bounding boxes often hug image borders; clip with a slight margin retained.
      const pad = native?.includes(region.box) ? 0 : IMAGE_PAD * lineHeight;
      const x = Math.max(0, region.box.x - pad);
      const y = Math.max(0, region.box.y - pad);
      images.push({
        kind: 'image',
        box: {
          x,
          y,
          width: Math.min(size.width, region.box.x + region.box.width + pad) - x,
          height: Math.min(size.height, region.box.y + region.box.height + pad) - y,
        },
      });
      continue;
    }
    // Discard page number region text only if it reads like a page number (D-334): layout models also misidentify short strings like 'Art. 1' or 'n.a.' as page numbers, causing data loss if discarded.
    const kept =
      region.kind === 'pageNumber' ? members.filter((l) => !PAGE_NUMBER.test(l.text)) : members;
    if (!kept.length) continue;
    const title = region.kind === 'title' ? (region.label === 'doc_title' ? 1 : 2) : 0;
    // Distant blocks within a large body region (an entire receipt recognized as a single block,
    // D-471) are separated: after table rows are removed, store names above and numbers below no
    // longer merge into a single block that disrupts page order.
    const clusters = title ? [{ lines: kept }] : clustersOf(kept, lineHeight, labelSplit);
    for (const { lines: part, side } of clusters) {
      groups.push({
        lines: part,
        title,
        box: unionBox(part),
        region: region.box,
        ...(side ? { side } : {}),
      });
    }
  }
  const unowned = free.filter((_, k) => owner[k] === -1);
  for (const { lines: cluster, side } of clustersOf(unowned, lineHeight, labelSplit)) {
    groups.push({ lines: cluster, title: 0, box: unionBox(cluster), ...(side ? { side } : {}) });
  }
  // Forms: pair left label column and right value column blocks by row (D-332). Two-column layouts
  // with aligned rows across the page (EU sample 044): blocks crossing the gutter are split across
  // sides without pairing or joining into 'left\\tright'.
  const gutter = early
    ? findPageGutter(
        free,
        [...tables.map((t) => t.box), ...images.map((im) => im.box)],
        lineHeight,
        size,
      )
    : null;
  if (gutter) groups = groups.flatMap((g) => splitAtGutter(g, gutter, lineHeight));
  groups = pairForms(groups, lineHeight, gutter);
  return nextStage({ groups, images, gutter });
}
export type PageRegionsState = StageState<ReturnType<typeof assignPageRegions>>;
