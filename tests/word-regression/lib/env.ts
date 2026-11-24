// Resources outside the repository used for regression testing. Default value is the path on the founder's Mac; other machines use an environment variable to point to it.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO = resolve(HERE, '../..');
const NOTES = `${homedir()}/Library/Application Support/Claude/side-session-notes`;
const RUNTIME = `${homedir()}/.cache/codex-runtimes/codex-primary-runtime/dependencies`;

export const ENV = {
  /** Headless Chrome: runs the same pdfview page in the app (PDF.js renders pages, reads raw drawings). */
  chrome:
    process.env.WORD_REGRESSION_CHROME ??
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  /** Directory containing the playwright module (used only to launch Chrome, without downloading its browser). */
  playwright: process.env.WORD_REGRESSION_PLAYWRIGHT ?? `${RUNTIME}/node/node_modules`,
  /** pdfview package files (pdf.js build/, cmaps/, etc.), identical to the pdfview package downloaded by the app. */
  pdfjs: process.env.WORD_REGRESSION_PDFJS ?? `${NOTES}/word-graphics-pages-2026-11-12/pdfjs`,
  /** Used only with --record (re-recognition): PP-OCR, layout model, and onnxruntime-node. */
  models: {
    det: process.env.WORD_REGRESSION_DET ?? `${NOTES}/scan-to-office/dewarp-exp/models/det.onnx`,
    rec: process.env.WORD_REGRESSION_REC ?? `${NOTES}/scan-to-office/dewarp-exp/models/rec.onnx`,
    dict:
      process.env.WORD_REGRESSION_DICT ??
      `${NOTES}/scan-to-office/dewarp-exp/models/dictionary.json`,
    layout:
      process.env.WORD_REGRESSION_LAYOUT ??
      `${NOTES}/scan-to-office/word-exp/models/layout_S_fp16.onnx`,
  },
  onnxruntime: process.env.WORD_REGRESSION_ORT ?? `${NOTES}/prefill-real-ocr/scripts`,
  /** Used only with --render: LibreOffice renders docx to PDF, pdftoppm renders to images. */
  soffice: process.env.WORD_REGRESSION_SOFFICE ?? `${RUNTIME}/bin/override/soffice`,
  pdftoppm: process.env.WORD_REGRESSION_PDFTOPPM ?? `${RUNTIME}/bin/override/pdftoppm`,
  /**
   * fontconfig configuration bundled with headless LibreOffice. Without it, LibreOffice only
   * recognizes its built-in fonts, rendering all Chinese text as blank; this configuration
   * includes the system font directories.
   */
  fontconfig:
    process.env.WORD_REGRESSION_FONTCONFIG ??
    `${RUNTIME}/native/libreoffice-headless/libreoffice/LibreOfficeDev.app/Contents/Resources/fontconfig/fonts.conf`,
};

export function need(path: string, what: string): string {
  if (!existsSync(path)) {
    throw new Error(`${what} not found at ${path} (see tests/word-regression/README.md)`);
  }
  return path;
}
