import { donePage, nextStage } from './doc-build-state';
import { type ComposedPageState } from './doc-compose';
import { type PreparePageState } from './doc-prepare';
import { type DocLeaf, type DocPage, type DocParagraph, leafBlocks } from './doc-support';
import { lineShareIn } from './layout';

/** Verify content and styles outside full images, falling back to full-page reversion if cascaded changes occur. */
export function preservePageFigures(
  state: Pick<PreparePageState, 'previous' | 'figures' | 'lineHeight' | 'available' | 'native'> &
    Pick<ComposedPageState, 'page'>,
) {
  const { previous, figures, lineHeight, page, available, native } = state;

  if (previous) {
    const outside = (b: DocLeaf) => figures.every((f) => lineShareIn(b.box, f.box) === 0);
    const oldParagraphs = leafBlocks(previous).filter(
      (b): b is DocParagraph => b.kind === 'paragraph' && outside(b),
    );
    // Disappearance of intra-image grids changes column lines shared across the page. Tables at the
    // same position outside images continue using their original complete representation,
    // preventing pure shared column coordinate changes from revoking confirmed full images;
    // boundary or content changes are still handled by the fallback checks below.
    const oldTables = new Map(
      leafBlocks(previous)
        .filter((b) => b.kind === 'table' && outside(b))
        .map((b) => [JSON.stringify(b.box), b]),
    );
    const restoreOutside = (b: DocLeaf): DocLeaf => {
      if (!outside(b)) return b;
      if (b.kind === 'table') return oldTables.get(JSON.stringify(b.box)) ?? b;
      if (b.kind === 'paragraph') {
        const matches = oldParagraphs.filter(
          (old) =>
            old.text === b.text &&
            Math.abs(old.box.x - b.box.x) <= 3 * lineHeight &&
            Math.abs(old.box.y - b.box.y) <= 3 * lineHeight &&
            Math.abs(old.box.width - b.box.width) <= 3 * lineHeight &&
            Math.abs(old.box.height - b.box.height) <= 3 * lineHeight,
        );
        if (matches.length === 1) return matches[0]!;
      }
      return b;
    };
    page.blocks = page.blocks.map((b) =>
      b.kind === 'row'
        ? { ...b, cells: b.cells.map((c) => ({ ...c, blocks: c.blocks.map(restoreOutside) })) }
        : restoreOutside(b),
    );
    const compact = (s: string) => s.replace(/\s/g, '');
    const editable = compact(
      leafBlocks(page)
        .flatMap((b) =>
          b.kind === 'paragraph'
            ? [b.text]
            : b.kind === 'list'
              ? b.items
              : b.kind === 'table'
                ? b.table.cells.map((c) => c.text)
                : [],
        )
        .join(' '),
    );
    const recovered = (b: DocLeaf) =>
      b.kind === 'table' &&
      outside(b) &&
      leafBlocks(previous).some(
        (old) =>
          old.kind === 'table' &&
          !outside(old) &&
          lineShareIn(b.box, old.box) >= 0.5 &&
          available
            .filter((l) => lineShareIn(l, old.box) >= 0.5)
            .every((l) => editable.includes(compact(l.text))),
      );
    const artifacts = (p: DocPage) =>
      leafBlocks(p)
        .filter(
          (b) =>
            (b.kind === 'table' || b.kind === 'image') &&
            outside(b) &&
            !(p === page && recovered(b)),
        )
        .map((b) => JSON.stringify(b))
        .sort()
        .join('\n');
    const styles = new Map(
      leafBlocks(previous)
        .filter((b) => b.kind === 'paragraph' && outside(b))
        .map((b) => [JSON.stringify(b.box), b]),
    );
    const styleOf = (b: DocLeaf) =>
      JSON.stringify(
        b.kind === 'paragraph'
          ? [b.size, b.bold, b.underline, b.color, b.heading, b.align, b.indent, b.tab]
          : [],
      );
    // Grids, barcodes, and fonts outside images may also depend on page-level statistics; any cascaded change triggers full-page fallback without partial patching.
    if (
      !native &&
      (previous.bodySize !== page.bodySize ||
        artifacts(previous) !== artifacts(page) ||
        leafBlocks(page).some((b) => {
          const old = styles.get(JSON.stringify(b.box));
          return old && b.kind === 'paragraph' && outside(b) && styleOf(old) !== styleOf(b);
        }) ||
        leafBlocks(previous).some((old) => {
          if (old.kind !== 'paragraph' || !outside(old)) return false;
          const matching = leafBlocks(page).filter(
            (b) => b.kind === 'paragraph' && b.text === old.text && outside(b),
          );
          return matching.length > 0 && matching.every((b) => styleOf(old) !== styleOf(b));
        }))
    )
      return donePage(previous);
  }
  return nextStage({});
}
