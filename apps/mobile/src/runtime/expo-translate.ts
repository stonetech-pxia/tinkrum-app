import MorphTranslate from '../../modules/morph-translate';
import type { TranslatePlatform } from './platform';

// Implementation of TranslatePlatform: local Expo module MorphTranslate (D-170). Null when this module is absent (Expo Go).

/** Native module error codes -> platform error codes (action implementations decide how to notify the user based on these). */
const CODES: Record<string, string> = {
  ERR_TRANSLATE_CANCELLED: 'cancelled',
  ERR_TRANSLATE_UNSUPPORTED: 'unsupported',
  ERR_TRANSLATE_DOWNLOAD: 'download',
};

function rethrow(e: unknown): never {
  const code = CODES[String((e as { code?: string }).code)];
  throw code ? Object.assign(new Error(String((e as Error).message)), { code }) : e;
}

export function expoTranslate(): TranslatePlatform | null {
  const native = MorphTranslate;
  if (!native) return null;
  const { download, downloadedLanguages, deleteLanguage, prepare } = native;
  return {
    supported: native.isSupported(),
    detectLanguages: (texts) => native.detectLanguages(texts),
    status: (from, to) => native.status(from, to),
    ...(download
      ? {
          downloadBytes: native.downloadBytes ?? 0,
          download: (language: string) => download(language).catch(rethrow),
        }
      : {}),
    translate: (texts, from, to) => native.translate(texts, from, to).catch(rethrow),
    ...(prepare ? { prepare: (from: string, to: string) => prepare(from, to).catch(rethrow) } : {}),
    ...(downloadedLanguages && deleteLanguage
      ? {
          downloadedLanguages: () => downloadedLanguages(),
          removeLanguage: (language: string) => deleteLanguage(language),
        }
      : {}),
  };
}
