import { PDFDocument } from 'pdf-lib';

import { type MergeResult, PdfError, type PdfInput, loadPdf } from './core';
import {
  type ImageKind,
  type ImagePageOptions,
  addImagePage,
  assertImagePageOptions,
  embedImage,
} from './images';

// Merge: pure PDF merging, as well as mixed PDF and image merging.

/** Merge PDFs in input order. Encrypted or corrupted files report specific filenames via PdfError. */
export async function mergePdfs(inputs: readonly PdfInput[]): Promise<MergeResult> {
  if (inputs.length < 2) throw new PdfError('tooFew');
  const merged = await PDFDocument.create();
  for (const input of inputs) {
    const doc = await loadPdf(input.bytes, input.name);
    const pages = await merged.copyPages(doc, doc.getPageIndices());
    for (const page of pages) merged.addPage(page);
  }
  return { bytes: await merged.save(), pageCount: merged.getPageCount() };
}

export async function countPages(bytes: Uint8Array): Promise<number> {
  return (await loadPdf(bytes, 'document')).getPageCount();
}

export interface DocumentInput {
  name: string;
  bytes: Uint8Array;
  kind: 'pdf' | ImageKind;
  width?: number;
  height?: number;
}

const DEFAULT_IMAGE_PAGE: ImagePageOptions = {
  pageSize: 'a4',
  orientation: 'auto',
  marginMm: 0,
  fit: 'contain',
};

/**
 * Merge PDFs and images in order (each image occupies one page, layout matches imagesToPdf). At
 * least 1 input. Unreadable PDFs / images report fileName.
 */
export async function mergeDocuments(
  inputs: readonly DocumentInput[],
  opts: ImagePageOptions = DEFAULT_IMAGE_PAGE,
): Promise<MergeResult> {
  if (inputs.length < 1) throw new PdfError('tooFew');
  assertImagePageOptions(opts);
  const merged = await PDFDocument.create();
  for (const input of inputs) {
    if (input.kind === 'pdf') {
      const doc = await loadPdf(input.bytes, input.name);
      const pages = await merged.copyPages(doc, doc.getPageIndices());
      for (const page of pages) merged.addPage(page);
    } else {
      const image = await embedImage(merged, { bytes: input.bytes, kind: input.kind }, input.name);
      addImagePage(merged, image, opts);
    }
  }
  return { bytes: await merged.save(), pageCount: merged.getPageCount() };
}
