// Core processing logic for PDF tools. Depends only on byte arrays and no platform APIs, allowing
// the same code to run on mobile (Hermes) and be tested with real PDFs in Node.

export {
  type MergeResult,
  PdfError,
  type PdfErrorCode,
  type PdfInput,
  canEncodeStandardText,
} from './core';
export {
  type PdfCompressor,
  type PdfPicture,
  type PdfReplacement,
  openForCompression,
  picturePagesPdf,
} from './compress';
export { type FormField, type FormFieldType, fillForm, listFormFields } from './forms';
export {
  type ImageInput,
  type ImageKind,
  type ImagePageOptions,
  type TextLayer,
  type TextLine,
  imagesToPdf,
} from './images';
export { type DocumentInput, countPages, mergeDocuments, mergePdfs } from './merge';
export {
  type PageInfo,
  type PageRule,
  type SplitMode,
  pageInfo,
  resolvePageRule,
  rotatePages,
  selectPages,
  splitPdf,
} from './pages';
export {
  type EdgePosition,
  type PageNumberOptions,
  type StampImageOptions,
  type StampPosition,
  type StampTextOptions,
  addPageNumbers,
  replacePageWithImage,
  stampImage,
  stampText,
} from './stamp';
