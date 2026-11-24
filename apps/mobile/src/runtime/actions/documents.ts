import { RunError, type ActionImpl, type RunItem } from '@morph/core';
import { leafBlocks, parseDocDoc } from '@morph/tool-office';
import { countPages } from '@morph/tool-pdf';

import { jpegDataUrl, wordPageHtml } from '../../desk/word-page';
import { displayName, fileItems, freshName, type RunServices } from './helpers';

// Print a docx copy via intermediate format; returns null when intermediate format cannot be read
// (falls back to platform layout). Document to PDF conversion (D-186): platform handles layout (iOS
// document preview, Android converts Word via mammoth), this function checks progress, hands
// results to the next step. docx generated from Word containing intermediate format (D-466) is
// printed according to edit page layout: matches what is seen on the edit page (original image
// positions, whitespace, font size, alignment), unaffected by platform layout (Android mammoth
// ignores alignment, indentation, and font size).

/** Print a docx copy via intermediate format; returns null when intermediate format cannot be read (falls back to platform layout). */
async function docDocToPdf(
  services: RunServices,
  item: RunItem,
  page: { width: number; height: number },
  relPath: string,
): Promise<{ uri: string; size: number; pageCount: number } | null> {
  const { files, runId } = services;
  if (!item.docDoc || item.docDoc.for !== item.uri) return null;
  const doc = parseDocDoc(new TextDecoder().decode(await files.readUri(item.docDoc.uri)));
  if (!doc) return null;
  const images: Record<string, string> = {};
  for (const block of doc.pages.flatMap((p) => leafBlocks(p))) {
    if (block.kind !== 'image' || !block.src || images[block.src]) continue;
    try {
      images[block.src] = jpegDataUrl(await files.readUri(block.src));
    } catch {
      // Unreadable images are left empty (rendered as gray blocks, matching the edit page).
    }
  }
  const html = wordPageHtml(doc, page.width, images, true);
  const pdf = await files.htmlToPdf(html, page, runId, relPath, {
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
  });
  // Android expo-print always reports page count as 1: count pages directly from the PDF itself.
  return { ...pdf, pageCount: await countPages(await files.readUri(pdf.uri)) };
}

type Impl = ActionImpl<RunServices>;

/** Paper sizes (points). */
const PAGES = {
  a4: { width: 595.28, height: 841.89 },
  letter: { width: 612, height: 792 },
} as const;

export const DOCUMENT_IMPLS: Record<string, Impl> = {
  async 'pdf.fromDocument'(input, params, ctx) {
    const { pageSize } = params as { pageSize: keyof typeof PAGES };
    const { documents } = ctx.services.files;
    const { runId } = ctx.services;
    const items = fileItems(input);
    // Check format for all items upfront to avoid failing midway through processing.
    for (const item of items) {
      if (!documents.extensions.includes(item.ext.toLowerCase())) {
        throw new RunError('documentUnsupported', {
          name: displayName(item),
          format: item.ext.toUpperCase(),
        });
      }
    }
    const out: RunItem[] = [];
    for (const [i, item] of items.entries()) {
      ctx.throwIfCancelled();
      ctx.progress(i, items.length);
      let pdf;
      try {
        pdf =
          (await docDocToPdf(ctx.services, item, PAGES[pageSize], freshName(item.name, 'pdf'))) ??
          (await documents.toPdf(
            item.uri,
            item.ext.toLowerCase(),
            PAGES[pageSize],
            runId,
            freshName(item.name, 'pdf'),
          ));
      } catch (e) {
        if (e instanceof RunError) throw e;
        throw new RunError('unreadable', { name: displayName(item) });
      }
      out.push({
        uri: pdf.uri,
        name: item.name,
        ext: 'pdf',
        mimeType: 'application/pdf',
        size: pdf.size,
        pageCount: pdf.pageCount,
      });
    }
    ctx.progress(items.length, items.length);
    return { type: 'pdf', items: out };
  },
};
