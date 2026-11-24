import { RunCancelled, RunError } from '@morph/core';
import { PdfError } from '@morph/tool-pdf';

// Translates tool-pdf errors into run errors. In a separate file: workspace PDF merging (storage) also needs it and should not depend on the entire PDF action module for this (R11).

/** tool-pdf error -> run error (with the erroneous filename). */
export function pdfError(e: unknown, name = ''): never {
  if (e instanceof RunError || e instanceof RunCancelled) throw e;
  // pdf-lib throws various generic errors when reading corrupted files: all presented to the user as "unreadable".
  if (!(e instanceof PdfError)) throw new RunError('unreadable', { name });
  const file = e.fileName ?? name;
  switch (e.code) {
    case 'tooFew':
      throw new RunError('tooFew', { min: 2, kind: 'PDF' });
    case 'encrypted':
    case 'unreadable':
    case 'badRange':
    case 'unsupportedText':
      throw new RunError(e.code, {
        name: e.code === 'unsupportedText' ? (e.fieldName ?? file) : file,
      });
    case 'badField':
      throw new RunError('badField', { name: e.fieldName ?? '' });
    case 'badImage':
      throw new RunError('unreadable', { name: file });
    default:
      throw new RunError('unexpected', { detail: e.code });
  }
}

export async function guard<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    return pdfError(e, name);
  }
}
