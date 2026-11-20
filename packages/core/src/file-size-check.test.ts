import { describe, expect, it } from 'vitest';
import { checkSizes } from './file-size-check';
import { FILE_LIMITS, MEDIA_LIMITS, PDF_LIMITS } from './limits';

const MB = 1024 * 1024;
const file = (name: string, mimeType: string, mb: number) => ({ name, mimeType, size: mb * MB });
const pdf = (n: string, mb: number) => file(`${n}.pdf`, 'application/pdf', mb);
const png = (n: string, mb: number) => file(`${n}.png`, 'image/png', mb);
const zip = (n: string, mb: number) => file(`${n}.zip`, 'application/zip', mb);
const mov = (n: string, mb: number) => file(`${n}.mov`, 'video/quicktime', mb);
const err = (f: () => void) => {
  try {
    f();
  } catch (e) {
    return e as { code: string; detail?: unknown; params?: unknown };
  }
  return null;
};

describe('checkSizes: PDF limits (P-006, D-601)', () => {
  it('PDF limits are 100/200; the shared constant stays 50/100; media unchanged', () => {
    expect(PDF_LIMITS).toEqual({ maxFileBytes: 100 * MB, maxTotalBytes: 200 * MB });
    expect(FILE_LIMITS).toEqual({ maxFileBytes: 50 * MB, maxTotalBytes: 100 * MB });
    expect(MEDIA_LIMITS.maxFileBytes).toBe(4096 * MB);
  });

  it('accepts a 60 MB and a 100 MB PDF, refuses 101 MB with the limit that applied', () => {
    expect(() => checkSizes([pdf('a', 60)])).not.toThrow();
    expect(() => checkSizes([pdf('a', 100)])).not.toThrow();
    const e = err(() => checkSizes([pdf('a', 101)]));
    expect(e).toMatchObject({ code: 'tooLarge' });
    expect(JSON.stringify(e)).toContain('100');
  });

  it('accepts 200 MB of PDFs in total, refuses more', () => {
    expect(() => checkSizes([pdf('a', 100), pdf('b', 100)])).not.toThrow();
    const e = err(() => checkSizes([pdf('a', 100), pdf('b', 100), pdf('c', 1)]));
    expect(e).toMatchObject({ code: 'tooLargeTotal' });
    expect(JSON.stringify(e)).toContain('200');
  });

  it('keeps 50 MB per file and 100 MB in total for images, zips and other files', () => {
    expect(err(() => checkSizes([png('a', 60)]))).toMatchObject({ code: 'tooLarge' });
    expect(err(() => checkSizes([zip('a', 51)]))).toMatchObject({ code: 'tooLarge' });
    expect(() => checkSizes([png('a', 50)])).not.toThrow();
    expect(err(() => checkSizes([png('a', 40), png('b', 40), png('c', 40)]))).toMatchObject({
      code: 'tooLargeTotal',
    });
  });

  it('mixed batch: PDFs and other files each count against their own total', () => {
    expect(() =>
      checkSizes([pdf('a', 100), pdf('b', 100), png('c', 50), png('d', 50)]),
    ).not.toThrow();
    expect(err(() => checkSizes([pdf('a', 100), png('c', 50), png('d', 51)]))).toMatchObject({
      code: 'tooLarge',
    });
    const t = err(() => checkSizes([pdf('a', 100), png('c', 40), png('d', 40), png('e', 40)]));
    expect(t).toMatchObject({ code: 'tooLargeTotal' });
    expect(JSON.stringify(t)).toContain('100');
  });

  it('media is unchanged', () => {
    expect(() => checkSizes([mov('a', 900), mov('b', 900), pdf('p', 100)])).not.toThrow();
    expect(err(() => checkSizes([mov('a', 4097)]))).toMatchObject({ code: 'tooLarge' });
  });
});
