import { type ComposedPageState } from './doc-compose';
import { type PreparePageState } from './doc-prepare';
import { leafBlocks } from './doc-support';

/** Determine page margins using source paper dimensions and content boundaries. */
export function finishPageMargins(
  state: Pick<ComposedPageState, 'page'> & Pick<PreparePageState, 'paper' | 'image'>,
) {
  const { page, paper, image } = state;

  // Left and right margins calculated based on text: images touching paper edges (full-bleed color
  // bands, footer decorations) would compress margins to 0, causing paragraphs to span paper edge
  // to edge (EU sample 036). Pages with only images are calculated based on images. Top and bottom
  // margins continue to use all blocks: page headers and footers remain in their original
  // positions.
  const content = leafBlocks(page);
  const texts = content.filter((b) => b.kind !== 'image');
  const across = texts.length ? texts : content;
  if (content.length && paper) {
    // Horizontal and vertical scaling ratios (photos close to A4 use A4 paper proportions, with tiny differences between both ratios).
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
