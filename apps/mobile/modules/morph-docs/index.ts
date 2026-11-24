import { requireOptionalNativeModule } from 'expo';

// Local Expo module MorphDocs (D-186): iOS uses system document preview (WKWebView can display
// Word, Excel, PowerPoint, RTF) and print formatting to render office documents into paginated
// PDFs. iOS only; Android system does not display office documents, so the app uses mammoth in JS
// to convert Word to web pages before printing (runtime/expo-documents.ts). Returns null in Expo Go
// and tests. PDF passwords (D-194) are also handled here via iOS PDFKit. Android does not support
// this (P-025). Error codes on failure: ERR_DOC_UNREADABLE (cannot open: corrupted, encrypted,
// invalid format), ERR_DOC_FAILED.

export interface MorphDocsModule {
  /** none: unencrypted; restricted: can be opened without a password but with restrictions; locked: requires a password to open. */
  pdfLockState(uri: string): Promise<'none' | 'restricted' | 'locked'>;
  /** Open with a password and save an unencrypted copy to output; returns null if the password is incorrect. */
  unlockPdf(
    uri: string,
    password: string,
    output: string,
  ): Promise<{ uri: string; size: number } | null>;
  /** Add an open password (the same password also acts as the owner password) and write to output. */
  protectPdf(uri: string, password: string, output: string): Promise<{ uri: string; size: number }>;
  /** Render the document at uri into a PDF and write to output; page size and margin units are points (1/72 inch). */
  toPdf(
    uri: string,
    output: string,
    page: { width: number; height: number; margin: number },
  ): Promise<{ uri: string; size: number; pageCount: number }>;
}

export default requireOptionalNativeModule<MorphDocsModule>('MorphDocs');
