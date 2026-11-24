import { LANGUAGE_WORD, languageOf } from '../workflow/phrase-words';
import { localize } from '../localization';
import { t, pairText } from '../messages';
import { z } from 'zod';

import type { ToolDefinition } from '../registry';
import type { Locale, Localized, Workflow } from '../schema';
import type { ActionDefinition } from '../workflow/contract';

// Translation tool (D-170–D-176): iOS uses the system Translation framework, Android uses ML Kit
// for on-device translation; text is neither uploaded nor sent to the AI (D-036). This is a tool
// run by the user directly; the AI only embeds it into quick actions and will never output
// translations directly (D-113, D-128). Outputs plain text only (which can be formatted into a PDF
// later), without preserving the original file layout.

export const TRANSLATE_TOOL_ID = 'translate';

/**
 * Available languages (BCP 47): common languages supported by both Apple Translation and ML Kit.
 * Traditional Chinese is only supported by iOS (ML Kit only has a single Chinese, translating to
 * Simplified). The app maps these to each platform's native language codes.
 */
export const TRANSLATE_LANGUAGES = [
  'zh-Hans',
  'en',
  'zh-Hant',
  'ja',
  'ko',
  'fr',
  'de',
  'es',
  'pt',
  'it',
  'ru',
  'vi',
  'th',
  'id',
  'ar',
  'tr',
  'nl',
  'pl',
  'uk',
  'hi',
] as const;
export type TranslateLanguage = (typeof TRANSLATE_LANGUAGES)[number];

export const TRANSLATE_LANGUAGE_NAMES: Record<TranslateLanguage, Localized> = {
  'zh-Hans': { en: 'Chinese (Simplified)', zh: '简体中文', fr: 'Chinois (simplifié)' },
  en: { en: 'English', zh: '英文', fr: 'Anglais' },
  'zh-Hant': { en: 'Chinese (Traditional)', zh: '繁体中文', fr: 'Chinois (traditionnel)' },
  ja: { en: 'Japanese', zh: '日文', fr: 'Japonais' },
  ko: { en: 'Korean', zh: '韩文', fr: 'Coréen' },
  fr: { en: 'French', zh: '法文', fr: 'Français' },
  de: { en: 'German', zh: '德文', fr: 'Allemand' },
  es: { en: 'Spanish', zh: '西班牙文', fr: 'Espagnol' },
  pt: { en: 'Portuguese', zh: '葡萄牙文', fr: 'Portugais' },
  it: { en: 'Italian', zh: '意大利文', fr: 'Italien' },
  ru: { en: 'Russian', zh: '俄文', fr: 'Russe' },
  vi: { en: 'Vietnamese', zh: '越南文', fr: 'Vietnamien' },
  th: { en: 'Thai', zh: '泰文', fr: 'Thaï' },
  id: { en: 'Indonesian', zh: '印尼文', fr: 'Indonésien' },
  ar: { en: 'Arabic', zh: '阿拉伯文', fr: 'Arabe' },
  tr: { en: 'Turkish', zh: '土耳其文', fr: 'Turc' },
  nl: { en: 'Dutch', zh: '荷兰文', fr: 'Néerlandais' },
  pl: { en: 'Polish', zh: '波兰文', fr: 'Polonais' },
  uk: { en: 'Ukrainian', zh: '乌克兰文', fr: 'Ukrainien' },
  hi: { en: 'Hindi', zh: '印地文', fr: 'Hindi' },
};

/** Maximum characters per translation batch (approx. 30 pages): on-device translation is fast, but excessively long texts make the user wait too long. */
export const MAX_TRANSLATE_CHARS = 100_000;

const languageOptions = TRANSLATE_LANGUAGES.map((value) => ({
  value,
  label: TRANSLATE_LANGUAGE_NAMES[value],
}));

export const TRANSLATE_ACTIONS: readonly ActionDefinition[] = [
  {
    id: 'translate.text',
    label: { en: 'Translate', zh: '翻译', fr: 'Traduire' },
    description: {
      en: 'Translate the text on this device (Apple Translation on iPhone, ML Kit on Android) into another language; the result is plain text, without the original layout. Good for understanding the meaning, not for official translations. The first use of a language may need a download. The text stays on this device.',
      zh: '在本机把文字翻译成另一种语言（iPhone 用系统翻译，Android 用 ML Kit），结果是纯文字，不保留原来的排版。适合看懂意思，正式文件请找专业翻译。第一次用某种语言时可能要下载。文字只留在本机。',
      fr: 'Traduire le texte sur cet appareil (Traduction d’Apple sur iPhone, ML Kit sur Android) vers une autre langue ; le résultat est du texte brut, sans la mise en page d’origine. Utile pour comprendre le sens, pas pour des traductions officielles. La première utilisation d’une langue peut nécessiter un téléchargement. Le texte reste sur cet appareil.',
    },
    input: ['text'],
    output: 'text',
    params: z.strictObject({
      from: z.enum(['auto', ...TRANSLATE_LANGUAGES]),
      to: z.enum(TRANSLATE_LANGUAGES),
    }),
    fields: [
      {
        key: 'from',
        label: { en: 'From', zh: '原文语言', fr: 'Langue source' },
        kind: 'choice',
        options: [
          {
            value: 'auto',
            label: { en: 'Auto-detect', zh: '自动识别', fr: 'Détection automatique' },
          },
          ...languageOptions,
        ],
      },
      {
        key: 'to',
        label: { en: 'Into', zh: '翻译成', fr: 'Vers' },
        kind: 'choice',
        // Simplified Chinese and English are placed at the top (most frequently used). This is the only parameter that prompts; no separate frequency shortcut buttons are provided (which would duplicate options).
        options: languageOptions,
        ask: true,
      },
    ],
    requires: [],
    // Step descriptions recognized by built-in rules (D-265).
    phrases: [
      {
        match: new RegExp(
          `^(?:翻译|翻|译)成\\s*${LANGUAGE_WORD}$|^translate (?:it |them |the text )?(?:in)?to ${LANGUAGE_WORD}$`,
          'i',
        ),
        step: (m) => ({
          params: { from: 'auto', to: languageOf(m[1] ?? m[2]!)! },
        }),
      },
      // Simply saying "Translate": translates to the interface language, switchable on each run.
      {
        match: /^翻译(?:一下)?$|^translate(?: it| them)?$/i,
        step: (_m, locale) => ({
          params: { from: 'auto', to: locale === 'zh' ? 'zh-Hans' : locale === 'fr' ? 'fr' : 'en' },
          ask: ['to'],
        }),
      },
    ],
  },
];

// ---- Segmentation and reassembly (pure functions, used before and after app-side translation) ----

const CJK = '　-〿぀-ヿ㐀-䶿一-鿿가-힯＀-￯';
const ENDS_CJK = new RegExp(`[${CJK}]$`);
const STARTS_CJK = new RegExp(`^[${CJK}]`);
/** A line ends a sentence here (or a heading/salutation): followed by a line break. */
const HARD_END = /[.!?。！？:：;；]["'”’）)]?$/;
/** List items and numbered points: preceded by a line break. */
const LIST_START =
  /^(?:[-•*·●▪◦]\s|\d{1,3}[.)、]\s?|[a-zA-Z][.)]\s|[一二三四五六七八九十]+[、.]|[（(]\d{1,3}[）)])/;
/** When a paragraph is too long, split it by sentences (system translation has limits on the text processed in a single call). */
const MAX_UNIT = 1500;
const SENTENCE = /[^.!?。！？]+[.!?。！？]+["'”’）)]?\s*|[^.!?。！？]+$/g;

function joinLine(current: string, line: string): string {
  if (/\p{L}-$/u.test(current) && /^\p{Ll}/u.test(line)) return current.slice(0, -1) + line;
  if (ENDS_CJK.test(current) || STARTS_CJK.test(line)) return current + line;
  return `${current} ${line}`;
}

function splitLong(unit: string): string[] {
  if (unit.length <= MAX_UNIT) return [unit];
  const out: string[] = [];
  let current = '';
  for (const sentence of unit.match(SENTENCE) ?? [unit]) {
    if (current && current.length + sentence.length > MAX_UNIT) {
      out.push(current.trim());
      current = '';
    }
    current += sentence;
    while (current.length > MAX_UNIT) {
      out.push(current.slice(0, MAX_UNIT));
      current = current.slice(MAX_UNIT);
    }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/**
 * Replace Kangxi Radicals (U+2F00–2FDF) and CJK Radicals Supplement (U+2E80–2EFF) with
 * homoglyphic standard characters (e.g., November radical form to standard form). Text extracted
 * from PDFs generated using PingFang on Mac and iPhone often uses these characters; they look
 * identical but cannot be recognized by translation or search. Only replace these two ranges:
 * running NFKC on the entire segment would also convert full-width Chinese punctuation to
 * half-width.
 */
export function fixCjkRadicals(text: string): string {
  return text.replace(/[\u2E80-\u2EFF\u2F00-\u2FDF]/g, (c) => c.normalize('NFKC'));
}

/**
 * Splits text into small segments for translation: empty lines separate paragraphs; lines within
 * a paragraph are reconnected (OCR and PDFs break every line, and translating line-by-line breaks
 * sentences), but sentence boundaries, short lines (headings, addresses, salutations), and list
 * items start new lines. The result is "paragraph → line → chunk"; if a line is too long, it is
 * split into multiple chunks by sentence.
 */
export function splitForTranslation(text: string): string[][][] {
  return fixCjkRadicals(text)
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((block) =>
      block
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    )
    .filter((lines) => lines.length > 0)
    .map((lines) => {
      const longest = Math.max(...lines.map((l) => l.length));
      const units: string[] = [];
      let current = '';
      lines.forEach((line, i) => {
        current = current ? joinLine(current, line) : line;
        const next = lines[i + 1];
        // Hyphenated words (agree-/ment) must always connect to the next line.
        const short = line.length < longest * 0.6 && !/\p{L}-$/u.test(line);
        if (!next || HARD_END.test(line) || short || LIST_START.test(next)) {
          units.push(current);
          current = '';
        }
      });
      return units.map(splitLong);
    });
}

/** Reassembly: chunks within the same line are joined with translated text, lines are separated by line breaks, and paragraphs are separated by an empty line. */
export function joinTranslation(pieces: string[][][], to: string): string {
  const cjk = /^(?:zh|ja)/.test(to);
  const joined = pieces
    .map((lines) =>
      lines.map((parts) => parts.map((p) => p.trim()).join(cjk ? '' : ' ')).join('\n'),
    )
    .join('\n\n');
  // When ML Kit translates into Chinese or Japanese, trailing spaces from the original text remain after periods (e.g., "apartment. Please...").
  return cjk ? joined.replace(/([。！？；：，、])[ \t]+/g, '$1') : joined;
}

/** System-detected language code → translation code; returns null if unrecognized (und, pinyin). */
export function normalizeDetected(code: string | null | undefined): string | null {
  if (!code || code === 'und') return null;
  const lower = code.toLowerCase();
  if (lower.startsWith('zh')) {
    if (lower.includes('latn')) return null;
    return /hant|tw|hk|mo/.test(lower) ? 'zh-Hant' : 'zh-Hans';
  }
  return lower.split(/[-_]/)[0]!;
}

/** Checks whether two codes represent the same language ("zh-Hans" and "zh-Hant" are not considered the same). */
export const sameLanguage = (a: string, b: string) =>
  (normalizeDetected(a) ?? a) === (normalizeDetected(b) ?? b);

/** Checks whether there are words to translate (chunks containing only numbers or symbols are preserved as-is). */
export const hasWords = (text: string) => /\p{L}/u.test(text);

/**
 * Groups by source language: returns "source language → chunk indices". When 'from' is auto, uses
 * the language detected for each chunk; unrecognized chunks fall back to the majority language of
 * the full text (by character count); chunks matching the target language are not translated.
 */
export function groupBySource(
  pieces: readonly string[],
  detected: readonly (string | null)[] | null,
  from: string,
  to: string,
): Map<string, number[]> {
  const sources = pieces.map((p, i) =>
    !hasWords(p) ? null : from === 'auto' ? normalizeDetected(detected?.[i]) : from,
  );
  const chars = new Map<string, number>();
  sources.forEach((s, i) => s && chars.set(s, (chars.get(s) ?? 0) + pieces[i]!.length));
  const dominant = [...chars.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const groups = new Map<string, number[]>();
  sources.forEach((s, i) => {
    const source = s ?? (hasWords(pieces[i]!) ? dominant : null);
    if (!source || sameLanguage(source, to)) return;
    groups.set(source, [...(groups.get(source) ?? []), i]);
  });
  return groups;
}

/** Display name of a language; displays the code for unlisted languages (such as auto-detected Swedish). */
export function translateLanguageName(code: string, locale: Locale): string {
  const known = TRANSLATE_LANGUAGE_NAMES[code as TranslateLanguage];
  return known ? localize(known, locale) : code;
}

// ---- Tools ----

/**
 * Single-function workflow (D-061): target language prompts on each run (D-072), defaulting to
 * the interface language; text in photos defaults to English recognition (for Chinese interface)
 * or Chinese recognition (for English interface), also prompting on each run.
 */
export function translateWorkflows(locale: Locale): Workflow[] {
  const to = locale === 'zh' ? 'zh-Hans' : locale === 'fr' ? 'fr' : 'en';
  const ocrLang = locale === 'zh' ? 'eng' : locale === 'fr' ? 'eng' : 'chi_sim';
  const wf = (id: string, name: [string, string], steps: Workflow['steps']): Workflow => ({
    id,
    kind: 'quickAction',
    package: TRANSLATE_TOOL_ID,
    name: pairText(locale, name),
    steps,
  });
  return [
    wf(
      'translate-typed',
      ['Translate text', '翻译文字'],
      [
        { id: 'type', action: 'in.text', params: { text: '' }, ask: ['text'] },
        { id: 'translate', action: 'translate.text', params: { from: 'auto', to }, ask: ['to'] },
      ],
    ),
    wf(
      'translate-photos',
      ['Translate text in photos', '翻译照片里的文字'],
      [
        { id: 'pick', action: 'in.photos', params: { source: 'library', min: 1, max: 20 } },
        { id: 'read', action: 'ocr.recognize', params: { lang: ocrLang }, ask: ['lang'] },
        { id: 'translate', action: 'translate.text', params: { from: 'auto', to }, ask: ['to'] },
      ],
    ),
    wf(
      'translate-pdf',
      ['Translate a PDF', '翻译 PDF'],
      [
        { id: 'pick', action: 'in.files', params: { accept: 'pdf', min: 1, max: 1 } },
        { id: 'extract', action: 'pdf.extractText', params: {} },
        { id: 'translate', action: 'translate.text', params: { from: 'auto', to }, ask: ['to'] },
      ],
    ),
  ];
}

export const translateTool: ToolDefinition = {
  id: TRANSLATE_TOOL_ID,
  version: '1.0.0',
  name: { en: 'Translate', zh: '翻译', fr: 'Traduire' },
  description: {
    en: 'Translate text, photos and PDFs on this device, in 20 languages. Plain text only, for understanding the meaning.',
    zh: '在本机翻译文字、照片和 PDF 里的文字，支持 20 种语言。只出纯文字，用来看懂意思。',
    fr: 'Traduisez le texte, les photos et les PDF sur cet appareil, dans 20 langues. Texte brut uniquement, pour comprendre le sens.',
  },
  icon: 'translate',
  aliases: ['translate', 'translation', 'translator', '翻译', '翻译工具', '翻译文字'],
  permissions: ['files.pick', 'files.write'],
  actions: TRANSLATE_ACTIONS,
  createPage: (locale) => ({
    id: `tool-${TRANSLATE_TOOL_ID}`,
    title: t(locale, 'translate_Translate_6c51b'),
    icon: 'translate',
    package: TRANSLATE_TOOL_ID,
    blocks: [
      {
        id: 'translate-header',
        look: 'header',
        show: { title: t(locale, 'translate_Translate_6c51b') },
      },
      {
        id: 'translate-intro',
        look: 'text',
        show: {
          text: t(locale, 'translate_Translates_on_this_device_the_text_is__027c8'),
        },
      },
      ...translateWorkflows(locale).map((wf) => ({
        id: `${wf.id}-runner`,
        look: 'action' as const,
        tools: [{ tool: wf.id }],
      })),
    ],
  }),
  createWorkflows: translateWorkflows,
};
