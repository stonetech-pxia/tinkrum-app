import type { Locale } from './schema';
import {
  TRANSLATE_LANGUAGES,
  TRANSLATE_LANGUAGE_NAMES,
  hasWords,
  normalizeDetected,
  splitForTranslation,
} from './tools/translate';

// Platform-agnostic part of text-to-speech (D-270): Languages, segmentation, automatic language
// selection, and estimated size. Speech is synthesized by the system (AVSpeechSynthesizer on iOS,
// TextToSpeech on Android), generating audio files locally without uploading. This is a step
// executed directly by the user; the AI only wires it into quick actions and cannot see the text
// (D-036, D-113).

/** Available languages: The same 20 languages as translation (both platforms have system voices for these, though not all may be installed). */
export const SPEAK_LANGUAGES = TRANSLATE_LANGUAGES;
export type SpeakLanguage = (typeof SPEAK_LANGUAGES)[number];
export const SPEAK_LANGUAGE_NAMES = TRANSLATE_LANGUAGE_NAMES;

/** Region codes (BCP 47) used for system voices: Recognized by iOS AVSpeechSynthesisVoice and Android Locale. */
export const SPEAK_VOICE_LOCALES: Record<SpeakLanguage, string> = {
  'zh-Hans': 'zh-CN',
  en: 'en-US',
  'zh-Hant': 'zh-TW',
  ja: 'ja-JP',
  ko: 'ko-KR',
  fr: 'fr-FR',
  de: 'de-DE',
  es: 'es-ES',
  pt: 'pt-BR',
  it: 'it-IT',
  ru: 'ru-RU',
  vi: 'vi-VN',
  th: 'th-TH',
  id: 'id-ID',
  ar: 'ar-SA',
  tr: 'tr-TR',
  nl: 'nl-NL',
  pl: 'pl-PL',
  uk: 'uk-UA',
  hi: 'hi-IN',
};

/** Speech rate: 1 is the system's normal speed. */
export const SPEAK_RATE_MIN = 0.5;
export const SPEAK_RATE_MAX = 2;

/**
 * Maximum character count per read: Roughly 2 hours of Chinese speech or 40 minutes of English
 * speech. Longer intermediate WAV files would be hundreds of MBs, and users rarely need an audio
 * file that long.
 */
export const MAX_SPEAK_CHARS = 30_000;

/**
 * Maximum character count per segment: Android TextToSpeech supports at most 4,000 characters at
 * once (getMaxSpeechInputLength); smaller segments keep the progress evenly paced and allow
 * faster cancellation.
 */
export const SPEAK_SEGMENT_CHARS = 1000;

const CJK_CHAR = /[　-〿぀-ヿ㐀-䶿一-鿿가-힯＀-￯]/;
/** Sentence boundary marker (preferred breaking point when splitting overly long segments). */
const SENTENCE = /[^.!?。！？]+[.!?。！？]+["'”’）)]?\s*|[^.!?。！？]+$/g;
/** Soft break for long sentences lacking periods: Falls back to breaking at commas and spaces. */
const SOFT_BREAK = /[,，、;；:：\s]/;
/** Only read characters that are letters or numbers (segments containing only symbols are skipped). */
const READABLE = /[\p{L}\p{N}]/u;

/** Joins parts of a line: CJK characters are joined directly, others are separated by spaces. */
function joinParts(parts: readonly string[]): string {
  return parts.reduce((line, part) => {
    if (!line) return part;
    return CJK_CHAR.test(line.at(-1)!) || CJK_CHAR.test(part[0]!) ? line + part : `${line} ${part}`;
  }, '');
}

/** Splits an excessively long unit by sentences, falls back to commas and spaces if sentences are still too long, and makes a hard split if necessary. */
function splitLong(unit: string, max: number): string[] {
  if (unit.length <= max) return [unit];
  const out: string[] = [];
  let current = '';
  const flush = () => {
    if (current.trim()) out.push(current.trim());
    current = '';
  };
  for (const sentence of unit.match(SENTENCE) ?? [unit]) {
    if (current && current.length + sentence.length > max) flush();
    current += sentence;
    while (current.length > max) {
      let cut = max;
      for (let i = max; i > max / 2; i--) {
        if (SOFT_BREAK.test(current[i - 1]!)) {
          cut = i;
          break;
        }
      }
      out.push(current.slice(0, cut).trim());
      current = current.slice(cut);
    }
  }
  flush();
  return out.filter(Boolean);
}

/**
 * Splits text into segments for system speech synthesis, ensuring each segment does not exceed
 * max characters. Broken lines are joined back first (PDF and OCR break every line, causing the
 * system to pause at line breaks), and paragraphs are separated by newlines; short segments are
 * combined to reduce system calls. Segments consisting solely of symbols are not read.
 */
export function splitForSpeech(text: string, max = SPEAK_SEGMENT_CHARS): string[] {
  const units = splitForTranslation(text).flatMap((paragraph, p) =>
    paragraph
      .map(joinParts)
      .filter((line) => READABLE.test(line))
      .flatMap((line) => splitLong(line, max))
      .map((line, i) => ({ line, newParagraph: p > 0 && i === 0 })),
  );
  const segments: string[] = [];
  let current = '';
  for (const { line, newParagraph } of units) {
    const sep = current ? (newParagraph ? '\n\n' : '\n') : '';
    if (current && current.length + sep.length + line.length > max) {
      segments.push(current);
      current = line;
    } else {
      current += sep + line;
    }
  }
  if (current) segments.push(current);
  return segments;
}

/** Speech language corresponding to the interface locale. */
export const speakLanguageFor = (locale: Locale): SpeakLanguage =>
  locale === 'zh' ? 'zh-Hans' : locale === 'fr' ? 'fr' : 'en';

/** Guesses the language based on the writing system of the text itself (fallback when the system cannot recognize the language); returns null for Latin scripts since they cannot be distinguished. */
function scriptLanguage(text: string): SpeakLanguage | null {
  const count = (re: RegExp) => text.match(re)?.length ?? 0;
  const scripts: [SpeakLanguage, number][] = [
    ['ja', count(/[぀-ヿ]/g) * 3],
    ['ko', count(/[가-힯]/g)],
    ['zh-Hans', count(/[一-鿿]/g)],
    ['ru', count(/[Ѐ-ӿ]/g)],
    ['ar', count(/[؀-ۿ]/g)],
    ['th', count(/[฀-๿]/g)],
    ['hi', count(/[ऀ-ॿ]/g)],
  ];
  const [best, n] = scripts.sort((a, b) => b[1] - a[1])[0]!;
  return n > 0 ? best : null;
}

/**
 * Language selection for "Auto-detect": detected is the system-recognized language for each
 * segment (or null if unavailable), selecting the one with the highest character count; falls
 * back to script-based guessing when the system cannot recognize it, using Latin languages from
 * the interface locale (English/French) for Latin text, or returning null if all fail. Only one
 * voice is used per run: mixed foreign text is read using that language's voice.
 */
export function chooseSpeakLanguage(
  segments: readonly string[],
  detected: readonly (string | null)[] | null,
  locale: Locale,
): SpeakLanguage | null {
  const known = new Set<string>(SPEAK_LANGUAGES);
  const chars = new Map<SpeakLanguage, number>();
  segments.forEach((segment, i) => {
    const code = normalizeDetected(detected?.[i]);
    if (code && known.has(code)) {
      const lang = code as SpeakLanguage;
      chars.set(lang, (chars.get(lang) ?? 0) + segment.length);
    }
  });
  const best = [...chars.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (best) return best;
  const all = segments.join('\n');
  const byScript = scriptLanguage(all);
  if (byScript) return byScript;
  if (!hasWords(all)) return null;
  return /\p{Script=Latin}/u.test(all) ? (locale === 'fr' ? 'fr' : 'en') : null;
}

/**
 * Estimated size (in bytes, used for checking remaining space) of the intermediate WAV file
 * generated by the system voice: Based on 24 kHz 16-bit mono, assuming ~5 characters per second
 * for CJK and ~14 characters per second for other scripts, estimated conservatively.
 */
export function estimateSpeechBytes(text: string, rate = 1): number {
  const cjk = text.match(new RegExp(CJK_CHAR.source, 'g'))?.length ?? 0;
  const seconds = (cjk / 5 + (text.length - cjk) / 14) / Math.max(SPEAK_RATE_MIN, rate);
  return Math.ceil(seconds * 24000 * 2) + 44;
}
