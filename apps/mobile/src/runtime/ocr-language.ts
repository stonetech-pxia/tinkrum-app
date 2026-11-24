import type { Locale, OcrLanguage } from '@morph/core';
import { getLocales } from 'expo-localization';

// Language used when OCR language is set to "Auto" (D-278): defaults to the first item in the
// device language list (falls back to interface language if absent). PP-OCRv6 recognizes Chinese,
// English, Japanese, French, German, Spanish, Portuguese, and Italian with a single model;
// selection only determines post-recognition formatting (Simplified/Traditional, full-width
// punctuation); Korean, Russian, and Vietnamese are unrecognized, falling back to system
// recognition (or OCR pack) when device language matches those.

const BY_LANGUAGE: Record<string, OcrLanguage> = {
  ko: 'kor',
  ru: 'rus',
  vi: 'vie',
  ja: 'jpn',
  fr: 'fra',
  de: 'deu',
  es: 'spa',
  pt: 'por',
  it: 'ita',
  en: 'eng',
};

/** languageTags: device language list (BCP 47, ordered by preference). */
export function autoOcrLanguage(languageTags: readonly string[], locale: Locale): OcrLanguage {
  const tag = (languageTags[0] ?? locale).toLowerCase();
  const code = tag.split('-')[0]!;
  if (code === 'zh') return /hant|-tw|-hk|-mo/.test(tag) ? 'chi_tra' : 'chi_sim';
  return BY_LANGUAGE[code] ?? 'eng';
}

/** Language from parameters; converts "auto" to the one selected based on device language. */
export function resolveOcrLanguage(lang: unknown, locale: Locale): OcrLanguage {
  if (lang !== 'auto') return lang as OcrLanguage;
  const tags = getLocales()
    .map((l) => l.languageTag)
    .filter((t): t is string => typeof t === 'string' && t.length > 0);
  return autoOcrLanguage(tags, locale);
}
