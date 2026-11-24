import type { DocDoc } from './doc';
import { importDocx, type ImportedImage } from './docx-import';
import { OfficeImportFailure, type OfficeImportError } from './ooxml';
import type { TableDoc } from './types';
import { importXlsx } from './xlsx-import';

// Shared entry point for the preview page and placing on the desk (D-509): read external docx/xlsx by extension, explain failures without throwing errors.

export type OfficeImport =
  | { ok: true; kind: 'doc'; doc: DocDoc; images: Map<string, ImportedImage> }
  | { ok: true; kind: 'table'; doc: TableDoc; formulas: number }
  | { ok: false; error: OfficeImportError };

/** File extensions that can be read and edited. */
export const isImportableOffice = (ext: string) => /^(docx|xlsx)$/i.test(ext);

/** Read a docx/xlsx file; return null for other extensions. */
export function importOffice(data: Uint8Array, ext: string): OfficeImport | null {
  if (!isImportableOffice(ext)) return null;
  try {
    if (/^docx$/i.test(ext)) {
      const { doc, images } = importDocx(data);
      return { ok: true, kind: 'doc', doc, images };
    }
    const { doc, formulas } = importXlsx(data);
    return { ok: true, kind: 'table', doc, formulas };
  } catch (e) {
    // Unexpected structures in the file (parsing errors): treated as damaged to prevent preview page and workspace crashes.
    return { ok: false, error: e instanceof OfficeImportFailure ? e.code : 'damaged' };
  }
}
