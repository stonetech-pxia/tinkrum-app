// 文件大小上限（DECISIONS P-006）。pdf-lib 会把整份文件读入内存，手机上必须限制。
export const FILE_LIMITS = {
  maxFileBytes: 50 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
} as const;

/**
 * PDF 单独的上限（D-601，创始人 2026-11-20 定）：单个 100 MB、一次运行里所有 PDF 合计 200 MB。
 * 其他要整份读进内存的文件仍按上面的 FILE_LIMITS；混合时 PDF 和非 PDF 各算各的，互不占额度。
 */
export const PDF_LIMITS = {
  maxFileBytes: 100 * 1024 * 1024,
  maxTotalBytes: 200 * 1024 * 1024,
} as const;

export const isPdfFile = (f: { name: string; mimeType?: string | null }) =>
  f.mimeType === 'application/pdf' || /\.pdf$/i.test(f.name);

/**
 * 不是视频、音频的文件（要整份读进内存的）：先逐个查单个上限（PDF 用 PDF_LIMITS，其他用 FILE_LIMITS），
 * 再分别查 PDF 合计和非 PDF 合计。返回的 mb 是实际用到的那个上限。收件页面和快捷操作共用这一份（P-006、D-601）。
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
 * 视频和音频的上限（D-142）：由原生模块边读边写，不进 JS 内存，所以不受上面 50 MB 的限制。
 * 单个不超过 4 GB，一次最多 10 个；开始前另外检查手机剩余空间。
 */
export const MEDIA_LIMITS = {
  maxFileBytes: 4 * 1024 * 1024 * 1024,
  maxCount: 10,
} as const;

/**
 * 报表带附件（D-425）：照片缩到长边 maxSide 再放进 PDF；最多放 maxCount 个附件、合计 maxBytes，多的不放并印在报表上。
 * 每 batchImages 张（或 batchBytes）排一次版，系统排版的那份 HTML 不会太大；pdf-lib 合并时整份在内存里，所以有合计上限。
 */
export const REPORT_ATTACHMENT_LIMITS = {
  maxCount: 60,
  maxBytes: 40 * 1024 * 1024,
  maxSide: 1400,
  quality: 0.75,
  batchImages: 8,
  batchBytes: 4 * 1024 * 1024,
} as const;
