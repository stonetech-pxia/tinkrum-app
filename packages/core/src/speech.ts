import type { Localized } from './schema';

// Platform-agnostic portion of speech-to-text (D-150, D-151): Languages, required download assets,
// and formatting transcription results into text. iOS uses system recognition (BCP 47 language
// codes), while Android uses whisper.cpp (whisper language codes + downloaded model). Transcribed
// text remains strictly on-device (D-036): it can be copied, saved as a file, or converted to PDF,
// but is never sent to the AI.

/** Available languages (12 languages, same as OCR). zh is Mandarin with Simplified output; zh-TW is Taiwanese Mandarin with Traditional output. */
export const SPEECH_LANGUAGES = [
  'zh',
  'zh-TW',
  'en',
  'ja',
  'ko',
  'fr',
  'de',
  'es',
  'pt',
  'it',
  'ru',
  'vi',
] as const;
export type SpeechLanguage = (typeof SPEECH_LANGUAGES)[number];

export const SPEECH_LANGUAGE_NAMES: Record<SpeechLanguage, Localized> = {
  zh: { en: 'Mandarin (Simplified)', zh: '普通话（简体）', fr: 'Mandarin (simplifié)' },
  'zh-TW': { en: 'Mandarin (Traditional)', zh: '国语（繁体）', fr: 'Mandarin (traditionnel)' },
  en: { en: 'English', zh: '英语', fr: 'Anglais' },
  ja: { en: 'Japanese', zh: '日语', fr: 'Japonais' },
  ko: { en: 'Korean', zh: '韩语', fr: 'Coréen' },
  fr: { en: 'French', zh: '法语', fr: 'Français' },
  de: { en: 'German', zh: '德语', fr: 'Allemand' },
  es: { en: 'Spanish', zh: '西班牙语', fr: 'Espagnol' },
  pt: { en: 'Portuguese', zh: '葡萄牙语', fr: 'Portugais' },
  it: { en: 'Italian', zh: '意大利语', fr: 'Italien' },
  ru: { en: 'Russian', zh: '俄语', fr: 'Russe' },
  vi: { en: 'Vietnamese', zh: '越南语', fr: 'Vietnamien' },
};

/** Languages used for iOS system recognition (BCP 47). */
export const SYSTEM_SPEECH_LOCALES: Record<SpeechLanguage, string> = {
  zh: 'zh-CN',
  'zh-TW': 'zh-TW',
  en: 'en-US',
  ja: 'ja-JP',
  ko: 'ko-KR',
  fr: 'fr-FR',
  de: 'de-DE',
  es: 'es-ES',
  pt: 'pt-BR',
  it: 'it-IT',
  ru: 'ru-RU',
  vi: 'vi-VN',
};

/** Whisper language codes: Both Mandarin and Taiwanese Mandarin use zh, with Simplified/Traditional determined by prompt hints. */
export const whisperLanguage = (lang: SpeechLanguage): string => (lang === 'zh-TW' ? 'zh' : lang);

/**
 * Whisper prompt. Without a prompt, Whisper often transcribes Mandarin into Traditional Chinese
 * (observed on Mac using the base model for entire paragraphs); starting with a Simplified
 * Chinese phrase ensures it follows with Simplified, and vice versa for Taiwanese Mandarin.
 */
export function whisperPrompt(lang: SpeechLanguage): string | undefined {
  if (lang === 'zh') return '以下是普通话的句子。';
  if (lang === 'zh-TW') return '以下是國語的句子。';
  return undefined;
}

/**
 * Android speech recognition models (downloadable assets, core/packs.ts). standard is Whisper
 * small (~190 MB, significantly more accurate for Chinese), fast is Whisper base (~60 MB, ~3x
 * faster). Both require the speech-vad voice activity detection model.
 */
export const SPEECH_MODELS = ['standard', 'fast'] as const;
export type SpeechModel = (typeof SPEECH_MODELS)[number];

export const SPEECH_MODEL_PACKS: Record<SpeechModel, string> = {
  standard: 'speech-whisper-small',
  fast: 'speech-whisper-base',
};
export const SPEECH_VAD_PACK = 'speech-vad';
/** File name within the downloaded assets. */
export const SPEECH_MODEL_FILE = 'model.bin';
export const SPEECH_VAD_FILE = 'vad.bin';

export interface SpeechSegment {
  startMs: number;
  endMs: number;
  text: string;
}

/** CJK characters and full-width punctuation. */
const CJK = '\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uff00-\uffef';
const FULL_WIDTH: Record<string, string> = {
  ',': '，',
  '?': '？',
  '!': '！',
  ':': '：',
  ';': '；',
};
/** Chinese and Japanese have no spaces between words (Korean does). */
const noSpaces = (lang: SpeechLanguage) => lang === 'zh' || lang === 'zh-TW' || lang === 'ja';

/**
 * Common "hallucinated" sentences (derived from training subtitles) and non-speech markers that
 * Whisper often generates during silence or background music. Stripped out only when an entire
 * segment consists of these; spoken mentions are preserved.
 */
const HALLUCINATIONS = [
  /^字幕(由|製作|制作|提供).*$/,
  /^.*amara\.org.*$/i,
  /^请不吝点赞.*$/,
  /^請不吝點贊.*$/,
  /^(謝謝|谢谢)(大家)?(收看|觀看|观看)[。！!]?$/,
  /^thanks? (you )?for watching[.!]?$/i,
  /^(please )?subscribe.*$/i,
  /^ご視聴ありがとうございました[。]?$/,
];
const NON_SPEECH = /^[[(（【♪].*[\])）】♪]$/;

/** Pause duration threshold to start a new paragraph (adding an empty line). */
export const PARAGRAPH_PAUSE_MS = 3000;

function cleanSegment(text: string, lang: SpeechLanguage): string {
  let t = text.replace(/\s+/g, ' ').trim();
  if (noSpaces(lang)) {
    // Whisper uses half-width punctuation for Chinese: converted to full-width; spaces between Chinese characters are removed (iOS occasionally leaves a space before punctuation).
    t = t
      .replace(
        new RegExp(`([${CJK}]) *([,?!:;])`, 'g'),
        (_, c: string, p: string) => c + FULL_WIDTH[p],
      )
      .replace(new RegExp(` *([,?!:;]) *(?=[${CJK}])`, 'g'), (_, p: string) => FULL_WIDTH[p]!)
      .replace(new RegExp(`([${CJK}]) *\\.(?![0-9])`, 'g'), '$1。')
      .replace(new RegExp(`([${CJK}]) +(?=[${CJK}])`, 'g'), '$1');
  }
  return t;
}

const isNoise = (text: string) =>
  text === '' ||
  /^[\s.。,，!！?？…-]*$/.test(text) ||
  NON_SPEECH.test(text) ||
  HALLUCINATIONS.some((re) => re.test(text));

/**
 * Cleans up recognized paragraphs into coherent text (performed on-device): removes Whisper's
 * hallucinated subtitle sentences and markers like [Music], converts half-width punctuation to
 * full-width for Chinese, removes extra spaces; CJK characters are joined directly, other
 * languages are joined with spaces, and pauses exceeding 3 seconds start a new paragraph.
 */
export function tidyTranscript(segments: readonly SpeechSegment[], lang: SpeechLanguage): string {
  const joiner = noSpaces(lang) ? '' : ' ';
  const paragraphs: string[][] = [];
  let lastEnd = -Infinity;
  for (const seg of segments) {
    const text = cleanSegment(seg.text, lang);
    if (isNoise(text)) continue;
    if (paragraphs.length === 0 || seg.startMs - lastEnd >= PARAGRAPH_PAUSE_MS) paragraphs.push([]);
    paragraphs[paragraphs.length - 1]!.push(text);
    lastEnd = seg.endMs;
  }
  return paragraphs
    .map((p) => p.join(joiner).trim())
    .filter(Boolean)
    .join('\n\n');
}
