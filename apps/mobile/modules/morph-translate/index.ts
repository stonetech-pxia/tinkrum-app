import { requireOptionalNativeModule } from 'expo';

// Local Expo module MorphTranslate (D-170): iOS uses ios/MorphTranslateModule.swift (Translation
// framework, iOS 18+), Android uses android/…/MorphTranslateModule.kt (ML Kit translation +
// language recognition). Returns null in Expo Go and tests. Languages use BCP 47 (zh-Hans, en, ja,
// etc.), mapped to platform-specific codes in native code. Error codes: ERR_TRANSLATE_CANCELLED
// (user cancelled in system download dialog), ERR_TRANSLATE_UNSUPPORTED, ERR_TRANSLATE_DOWNLOAD
// (download failure, mostly due to no network), ERR_TRANSLATE_FAILED.

export interface MorphTranslateModule {
  /** Whether the system supports translation (iOS 18+; always true on Android). */
  isSupported(): boolean;
  /** Language of each text segment (BCP 47); returns null when unrecognized. */
  detectLanguages(texts: readonly string[]): Promise<(string | null)[]>;
  /**
   * status: installed means models are on-device; download means download is required (missing on
   * Android indicates languages not yet downloaded); unsupported means translation is not
   * supported.
   */
  status(
    from: string,
    to: string,
  ): Promise<{ status: 'installed' | 'download' | 'unsupported'; missing?: string[] }>;
  /** Estimated download size for each language model (Android only). */
  downloadBytes?: number;
  /** Download a language model (Android only). */
  download?(language: string): Promise<void>;
  /** Pre-download a language pair (iOS only: system prompts for download confirmation; throws ERR_TRANSLATE_CANCELLED if the user cancels). */
  prepare?(from: string, to: string): Promise<void>;
  /** Segment-by-segment translation; iOS displays a system prompt asking the user if a download is required. */
  translate(texts: readonly string[], from: string, to: string): Promise<string[]>;
  /** Downloaded language models (Android only; iOS languages are managed via system "Settings -> Translation"). */
  downloadedLanguages?(): Promise<string[]>;
  /** Languages supported by the system for translation (iOS only, for debugging). */
  supportedLanguages?(): Promise<string[]>;
  /** Delete a language model (Android only; English cannot be deleted). */
  deleteLanguage?(code: string): Promise<void>;
}

export default requireOptionalNativeModule<MorphTranslateModule>('MorphTranslate');
