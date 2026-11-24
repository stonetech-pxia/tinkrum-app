import {
  IMPORT_LIMITS,
  decodeSheetText,
  parseCsv,
  type SheetRows,
  type SpreadsheetError,
} from '@morph/core';
import { OfficeImportFailure, readXlsxRows } from '@morph/tool-office';

// Reads user-selected spreadsheet files (imported into tables, D-575 / D-574): reads entirely
// on-device, offline, excluded from config and never sent to AI (invariants 1, 2, 14). Categorized
// by file extension (Android content:// URIs lack extensions, but names have them); falls back to
// MIME type when extension is missing.

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const CSV_MIME = /^text\/(csv|comma-separated-values|tab-separated-values|plain)$/i;

export type SpreadsheetKind = 'xlsx' | 'csv';

/** Determines spreadsheet type from name (and MIME type); returns null if unsupported for import. */
export function spreadsheetKind(name: string, mimeType: string | null): SpreadsheetKind | null {
  const ext = /\.([a-z0-9]+)$/i.exec(name.trim())?.[1]?.toLowerCase();
  if (ext === 'xlsx') return 'xlsx';
  if (ext === 'csv' || ext === 'tsv' || ext === 'txt') return 'csv';
  if (ext) return null;
  if (mimeType === XLSX_MIME) return 'xlsx';
  return mimeType && CSV_MIME.test(mimeType) ? 'csv' : null;
}

/** File bytes -> rows for each worksheet (CSV counts as one). Describes reasons for read failures. */
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
