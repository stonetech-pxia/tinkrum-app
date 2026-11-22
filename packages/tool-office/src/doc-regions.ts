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

/** 分配区域、图片和两栏，配对表单标签与值。 */
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
    // 和表格重叠一大半的区域（表格的标题行、表格里认成正文的）不要。
    (r) => {
      // 原生整图在表的一格里（表头一格里的标志、表单里的证件照，EU 样本 090）：格子里放不了图，
      // 图留着，排在表的前面，不因为压着表就连整页的图一起撤销。
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
      // 图片区域几张表格合起来盖住一大半也算（表单里一格一张的小表，D-524）。
      const covered = r.kind === 'image' ? overlaps.reduce((a, b) => a + b, 0) : 0;
      return covered <= half && overlaps.every((o) => o <= half);
    },
  );
  // 接管是整页事务：后续去重或表格过滤若淘汰了任一整图，撤销 OCR/像素隔离，沿用原路径。
  // 非原生整图时 previous 就是同样参数的原路径结果，不再重建一遍。
  if (figures.some((f) => !regions.some((r) => r.kind === 'image' && r.box === f.box)))
    return donePage(
      !native && previous
        ? previous
        : buildPage(input, options, false, repairTables, repairBarcodes),
    );
  const merged = mergeTextRegions(regions, lineHeight);
  regions.splice(0, regions.length, ...merged);
  const owner = assignLines(free, regions);
  // 行首单独的编号跟着同一排右边的条文进同一个区域（版面模型常把编号划进旁边的大区域，EU 样本 032）。
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
  // 整页的标签列（W-4 的「Step 3:」一列）：版面模型把每一步切成很小的区域，要在整页上找。
  const labelSplit = splitLabelColumn(free, lineHeight);
  // 区域里的行；页码区域的字不要；图片区域里的少量字（标志、照片里的字）也不要。
  let groups: Group[] = [];
  // 版面模型也把条形码认成了图片区域时，只用区域那一张（不然同一个条形码出现两次）。
  const pictured = regions.filter((r) => r.kind === 'image').map((r) => r.box);
  const images: DocImage[] = [
    ...barcodes.filter((b) => !pictured.some((r) => lineShareIn(b, r) >= 0.8)),
    ...verticals,
  ].map((box) => ({ kind: 'image', box }));
  for (const [i, region] of regions.entries()) {
    const members = free.filter((_, k) => owner[k] === i);
    if (region.kind === 'image') {
      // 模型的框常常贴着图的边，剪下来留一点边。
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
    // 页码区域只丢读起来像页码的字（D-334）：版面模型也把「Art. 1」「n.a.」这类短字认成页码，丢了就是丢字。
    const kept =
      region.kind === 'pageNumber' ? members.filter((l) => !PAGE_NUMBER.test(l.text)) : members;
    if (!kept.length) continue;
    const title = region.kind === 'title' ? (region.label === 'doc_title' ? 1 : 2) : 0;
    // 一个很大的正文区域（整张小票被认成一块，D-471）里隔得远的几块照样分开：表格的行拿走以后，
    // 上面的店名和下面的号码不再连成一块、把整页的顺序打乱。
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
  // 表单：左边一列标签、右边一列值的两块按行配好（D-332）。
  // 整页左右两栏、两栏的行对齐（EU 样本 044）：跨过中缝的块按两边拆开，不配对、不接成「左\t右」。
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
