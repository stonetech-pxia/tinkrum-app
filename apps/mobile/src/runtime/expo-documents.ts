import { escapeHtml } from '@morph/core';
import { countPages } from '@morph/tool-pdf';
import { File } from 'expo-file-system';

import MorphDocs from '../../modules/morph-docs';
import type { DocumentPlatform, FilePlatform } from './platform';

// Office documents to PDF conversion (D-186). iOS development version: system document preview
// layout (modules/morph-docs). Android and Expo Go: mammoth (BSD-2) converts Word to HTML, then
// system print layout (expo-print) converts to PDF. Documents are processed entirely on-device;
// HTML contains only the document's own text and embedded images, with no network access during
// printing.

/** Formats displayable by the iOS system preview. */
const SYSTEM_EXTENSIONS = ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'rtf'];
/** Margin for iOS print layout (points). */
const MARGIN = 36;

const unreadable = (detail: string) =>
  Object.assign(new Error(`unreadable: ${detail}`), { code: 'ERR_DOC_UNREADABLE' });

/** mammoth provides only the body structure; layout is determined independently: system fonts, table borders, images constrained to page width. */
export function wordPage(body: string, title: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
body{font-family:-apple-system,Roboto,"Noto Sans CJK SC","PingFang SC",sans-serif;font-size:11pt;line-height:1.45;color:#111}
h1{font-size:20pt}h2{font-size:16pt}h3{font-size:13pt}
table{border-collapse:collapse;width:100%;margin:8pt 0}td,th{border:1px solid #999;padding:4pt 6pt;vertical-align:top}
img{max-width:100%;height:auto}p{margin:0 0 6pt}
</style></head><body>${body}</body></html>`;
}

export function expoDocuments(
  runFileUri: (runId: string, relPath: string) => string,
  htmlToPdf: FilePlatform['htmlToPdf'],
): DocumentPlatform {
  const native = MorphDocs;
  if (native) {
    return {
      extensions: SYSTEM_EXTENSIONS,
      passwords: {
        lockState: (uri) => native.pdfLockState(uri),
        unlock: (uri, password, runId, relPath) =>
          native.unlockPdf(uri, password, runFileUri(runId, relPath)),
        protect: (uri, password, runId, relPath) =>
          native.protectPdf(uri, password, runFileUri(runId, relPath)),
      },
      async toPdf(uri, _ext, page, runId, relPath) {
        return native.toPdf(uri, runFileUri(runId, relPath), { ...page, margin: MARGIN });
      },
    };
  }
  return {
    extensions: ['docx'],
    passwords: null,
    async toPdf(uri, _ext, page, runId, relPath) {
      // Browser version is a bundled single file (does not depend on Node fs or path), loaded only when needed (~400 KB).
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mammoth = require('mammoth/mammoth.browser.min.js') as {
        convertToHtml(input: { arrayBuffer: ArrayBuffer }): Promise<{ value: string }>;
      };
      const bytes = await new File(uri).bytes();
      let body: string;
      try {
        const result = await mammoth.convertToHtml({
          arrayBuffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        });
        body = result.value;
      } catch (e) {
        throw unreadable(String(e));
      }
      if (!body.trim()) throw unreadable('empty');
      const name = relPath.replace(/^.*\//, '').replace(/\.[^.]+$/, '');
      const pdf = await htmlToPdf(wordPage(body, name), page, runId, relPath);
      // Android expo-print always reports page count as 1 (tested as 1 even for a 6-page document in simulator): count pages directly from the PDF itself.
      return { ...pdf, pageCount: await countPages(await new File(pdf.uri).bytes()) };
    },
  };
}
