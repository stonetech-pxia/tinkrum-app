import { type ComposedPageState } from './doc-compose';
import { type PreparePageState } from './doc-prepare';
import { leafBlocks } from './doc-support';

/** 用来源纸张和内容边界确定页边距。 */
export function finishPageMargins(
  state: Pick<ComposedPageState, 'page'> & Pick<PreparePageState, 'paper' | 'image'>,
) {
  const { page, paper, image } = state;

  // 左右页边距按字算：贴着纸边的图（满版的色带、页脚的花纹）会把边距压成 0，段落就从纸边排到纸边（EU 样本 036）。
  // 页上只有图时按图算。上下照旧按所有的块算：页顶的标志、页底的图留在原来的位置。
  const content = leafBlocks(page);
  const texts = content.filter((b) => b.kind !== 'image');
  const across = texts.length ? texts : content;
  if (content.length && paper) {
    // 横竖各用自己的比例（近似 A4 的照片按 A4 纸，两个比例只差一点点）。
    const k = paper.width / image.width;
    const ky = paper.height / image.height;
    const max = Math.min(56.7, paper.width / 10, paper.height / 10);
    const margin = (v: number) => Math.round(Math.max(0, Math.min(max, v)) * 100) / 100;
    page.margins = {
      left: margin(Math.min(...across.map((b) => b.box.x)) * k),
      right: margin((image.width - Math.max(...across.map((b) => b.box.x + b.box.width))) * k),
      top: margin(Math.min(...content.map((b) => b.box.y)) * ky),
      bottom: margin(paper.height - Math.max(...content.map((b) => b.box.y + b.box.height)) * ky),
    };
  }
  return page;
}
