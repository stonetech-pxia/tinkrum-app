import {
  IMPORT_LIMITS,
  decodeSheetText,
  parseCsv,
  type SheetRows,
  type SpreadsheetError,
} from '@morph/core';
import { OfficeImportFailure, readXlsxRows } from '@morph/tool-office';

// 读用户选的表格文件（导进表，D-574）：只在本机读，不联网、不进配置、不发给 AI（底线 1、2、14）。
// 按文件名的扩展名分（Android 的 content:// 地址里没有扩展名，名字里有）；没有扩展名时看 MIME 类型。

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const CSV_MIME = /^text\/(csv|comma-separated-values|tab-separated-values|plain)$/i;

export type SpreadsheetKind = 'xlsx' | 'csv';

/** 按名字（和 MIME 类型）看是哪种表格文件；不是能导入的返回 null。 */
export function spreadsheetKind(name: string, mimeType: string | null): SpreadsheetKind | null {
  const ext = /\.([a-z0-9]+)$/i.exec(name.trim())?.[1]?.toLowerCase();
  if (ext === 'xlsx') return 'xlsx';
  if (ext === 'csv' || ext === 'tsv' || ext === 'txt') return 'csv';
  if (ext) return null;
  if (mimeType === XLSX_MIME) return 'xlsx';
  return mimeType && CSV_MIME.test(mimeType) ? 'csv' : null;
}

/** 文件的字节 → 每张工作表的行（CSV 是一张）。读不了时说为什么。 */
export function readSpreadsheet(
  kind: SpreadsheetKind,
  bytes: Uint8Array,
): { ok: true; sheets: SheetRows[] } | { ok: false; error: SpreadsheetError } {
  let sheets: SheetRows[];
  if (kind === 'xlsx') {
    try {
      sheets = readXlsxRows(bytes, IMPORT_LIMITS.maxCells);
    } catch (e) {
      return {
        ok: false,
        error:
          e instanceof OfficeImportFailure && e.code === 'tooLarge' ? 'tooLarge' : 'notSpreadsheet',
      };
    }
  } else {
    const text = decodeSheetText(bytes);
    if (!text.ok) return text;
    sheets = [{ name: '', rows: parseCsv(text.text) }];
  }
  const filled = sheets.filter((s) =>
    s.rows.some((r) => r.some((c) => c.text.trim() !== '' || c.number !== undefined)),
  );
  return filled.length ? { ok: true, sheets: filled } : { ok: false, error: 'empty' };
}
