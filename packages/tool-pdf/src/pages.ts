import { PDFDocument, degrees } from 'pdf-lib';

import { PdfError, assertPageIndices, loadPdf } from './core';
import { normalizeRotation, pageView } from './view';

// Page operations: info, extraction / deletion / rearrangement, rotation, splitting, and symbolic
// page rules. All page indices are 0-based; only range strings are human-facing 1-based page
// numbers.

export interface PageInfo {
  /** User-facing width and height (accounting for rotation), in pt. */
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
}

export async function pageInfo(bytes: Uint8Array): Promise<PageInfo[]> {
  const doc = await loadPdf(bytes);
  return doc.getPages().map((page) => {
    const { width, height, rotation } = pageView(page);
    return { width, height, rotation };
  });
}

/** Copy specified pages in order to a new document. Returns badRange for empty lists or duplicate pages. */
async function copyPagesToNew(src: PDFDocument, indices: readonly number[]): Promise<Uint8Array> {
  assertPageIndices(indices, src.getPageCount());
  const out = await PDFDocument.create();
  for (const page of await out.copyPages(src, [...indices])) out.addPage(page);
  return out.save();
}

/**
 * New PDF contains only pages specified by indices, in the given order: can be used for
 * extraction, deletion (passing remaining pages), and rearrangement. Duplicate pages are not
 * allowed. The new document does not retain bookmarks or forms.
 */
export async function selectPages(
  bytes: Uint8Array,
  indices: readonly number[],
): Promise<Uint8Array> {
  return copyPagesToNew(await loadPdf(bytes), indices);
}

/** Rotate clockwise by rotation degrees relative to the existing rotation; rotates all pages when indices are omitted. */
export async function rotatePages(
  bytes: Uint8Array,
  rotation: 90 | 180 | 270,
  indices?: readonly number[],
): Promise<Uint8Array> {
  if (rotation !== 90 && rotation !== 180 && rotation !== 270) throw new PdfError('badOption');
  const doc = await loadPdf(bytes);
  const pages = doc.getPages();
  const targets = indices ?? doc.getPageIndices();
  assertPageIndices(targets, pages.length);
  for (const i of targets) {
    const page = pages[i];
    if (page) page.setRotation(degrees(normalizeRotation(page.getRotation().angle + rotation)));
  }
  return doc.save();
}

/** every: split every n pages; ranges: each inner array is 0-based page indices for one split (rules match selectPages). */
export type SplitMode = { kind: 'every'; n: number } | { kind: 'ranges'; ranges: number[][] };

export async function splitPdf(bytes: Uint8Array, mode: SplitMode): Promise<Uint8Array[]> {
  const src = await loadPdf(bytes);
  const count = src.getPageCount();
  let parts: number[][];
  if (mode.kind === 'every') {
    if (!Number.isInteger(mode.n) || mode.n < 1) throw new PdfError('badOption');
    parts = [];
    for (let start = 0; start < count; start += mode.n) {
      parts.push(src.getPageIndices().slice(start, start + mode.n));
    }
  } else {
    if (mode.ranges.length < 1) throw new PdfError('badRange');
    parts = mode.ranges;
  }
  const out: Uint8Array[] = [];
  for (const part of parts) out.push(await copyPagesToNew(src, part));
  return out;
}

/** AI can only select symbolic rules (without viewing document content), which are converted here into concrete page numbers. */
export type PageRule = 'all' | 'odd' | 'even' | 'first' | 'last' | { range: string };

const MAX_RANGE_LENGTH = 1000;

/**
 * Rule -> 0-based page numbers. odd / even refer to human page numbers (pages 1, 3, 5... are
 * odd). ranges take forms like "1-3, 5, 8-" (1-based; "8-" to end, "-3" from start), outputting
 * in written order and deduplicating. Out-of-bounds, reversed ranges, unparseable inputs, or
 * empty results all return badRange.
 */
export function resolvePageRule(rule: PageRule, pageCount: number): number[] {
  if (!Number.isInteger(pageCount) || pageCount < 0) throw new PdfError('badRange');
  const all = Array.from({ length: pageCount }, (_, i) => i);
  let result: number[];
  if (rule === 'all') result = all;
  else if (rule === 'odd') result = all.filter((i) => i % 2 === 0);
  else if (rule === 'even') result = all.filter((i) => i % 2 === 1);
  else if (rule === 'first') result = all.slice(0, 1);
  else if (rule === 'last') result = all.slice(-1);
  else if (typeof rule === 'object' && rule !== null && typeof rule.range === 'string') {
    result = parseRange(rule.range, pageCount);
  } else throw new PdfError('badRange');
  if (result.length < 1) throw new PdfError('badRange');
  return result;
}

function parseRange(text: string, pageCount: number): number[] {
  if (text.length > MAX_RANGE_LENGTH) throw new PdfError('badRange');
  const seen = new Set<number>();
  const result: number[] = [];
  // Normalization: Chinese/English commas / semicolons as separators, treats various hyphens and tildes as "-", ignores whitespace.
  for (const raw of text.split(/[,，;；]/)) {
    const token = raw.replace(/\s/g, '').replace(/[–—~～]/g, '-');
    if (token === '') continue;
    const parts = token.split('-');
    if (parts.length > 2) throw new PdfError('badRange');
    const [left = '', right] = parts;
    const start = left === '' && right !== undefined ? 1 : parsePage(left);
    const end = right === undefined ? start : right === '' ? pageCount : parsePage(right);
    if (start < 1 || start > end || end > pageCount) throw new PdfError('badRange');
    for (let page = start; page <= end; page++) {
      if (!seen.has(page)) {
        seen.add(page);
        result.push(page - 1);
      }
    }
  }
  return result;
}

function parsePage(text: string): number {
  if (!/^\d{1,6}$/.test(text)) throw new PdfError('badRange');
  return Number(text);
}
