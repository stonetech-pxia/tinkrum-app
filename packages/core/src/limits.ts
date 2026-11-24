// File size limit (DECISIONS P-006). pdf-lib reads entire files into memory, which must be limited on mobile devices.
export const FILE_LIMITS = {
  maxFileBytes: 50 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
} as const;

/**
 * PDF-specific limits (D-601, decided by founder 2026-11-20): 100 MB per single file, 200 MB
 * total across all PDFs in a single run. Other files requiring full in-memory loading still
 * follow FILE_LIMITS above; PDFs and non-PDFs are calculated separately without sharing quotas.
 */
export const PDF_LIMITS = {
  maxFileBytes: 100 * 1024 * 1024,
  maxTotalBytes: 200 * 1024 * 1024,
} as const;

export const isPdfFile = (f: { name: string; mimeType?: string | null }) =>
  f.mimeType === 'application/pdf' || /\.pdf$/i.test(f.name);

/**
 * Non-video/audio files (requiring full in-memory read): check individual limits first (PDFs use
 * PDF_LIMITS, others use FILE_LIMITS), then check PDF totals and non-PDF totals separately. The
 * returned mb is the actual applicable limit. Shared between the inbox page and quick actions
 * (P-006, D-601).
 */
export function inMemorySizeProblem(
  files: readonly { name: string; size: number | null; mimeType?: string | null }[],
): { code: 'tooLarge'; name: string; mb: number } | { code: 'tooLargeTotal'; mb: number } | null {
  const MB = 1024 * 1024;
  const pdfs = files.filter(isPdfFile);
  const others = files.filter((f) => !isPdfFile(f));
  for (const f of files) {
    const limit = isPdfFile(f) ? PDF_LIMITS.maxFileBytes : FILE_LIMITS.maxFileBytes;
    if ((f.size ?? 0) > limit) return { code: 'tooLarge', name: f.name, mb: limit / MB };
  }
  const sum = (list: typeof files) => list.reduce((n, f) => n + (f.size ?? 0), 0);
  if (sum(pdfs) > PDF_LIMITS.maxTotalBytes) {
    return { code: 'tooLargeTotal', mb: PDF_LIMITS.maxTotalBytes / MB };
  }
  if (sum(others) > FILE_LIMITS.maxTotalBytes) {
    return { code: 'tooLargeTotal', mb: FILE_LIMITS.maxTotalBytes / MB };
  }
  return null;
}

/**
 * Video and audio limits (D-142): read and written in streams by native modules without entering
 * JS memory, thus exempt from the 50 MB limit above. Maximum 4 GB per file, up to 10 files at
 * once; check remaining device storage separately before starting.
 */
export const MEDIA_LIMITS = {
  maxFileBytes: 4 * 1024 * 1024 * 1024,
  maxCount: 10,
} as const;

/**
 * Reports with attachments (D-425): downscale photos so their long edge is at most maxSide before
 * embedding in PDF; maximum maxCount attachments totalling maxBytes, excess attachments are
 * omitted and noted in the report. Layout in batches of batchImages (or batchBytes) to prevent
 * system HTML rendering from becoming too large; pdf-lib merges the entire file in memory, hence
 * the total size limit.
 */
export const REPORT_ATTACHMENT_LIMITS = {
  maxCount: 60,
  maxBytes: 40 * 1024 * 1024,
  maxSide: 1400,
  quality: 0.75,
  batchImages: 8,
  batchBytes: 4 * 1024 * 1024,
} as const;
