import { t, pairText } from '../messages';
import { z } from 'zod';

import { OCR_LANGUAGES, ocrPackId } from '../packs';
import type { ToolDefinition } from '../registry';
import type { Locale, Localized, Workflow } from '../schema';
import type { ActionDefinition } from '../workflow/contract';

// Manifest of text recognition tools (T5): Chinese, Japanese, English, French, German, Spanish,
// Portuguese, Italian use PP-OCRv6 (D-269, on both iOS and Android, models downloaded on first
// use); Korean and others use system-native ones (iOS Vision, D-085; Android retains ML Kit only
// for Korean, D-087); languages unsupported by the system (Russian, Vietnamese on Android) and Expo
// Go use tesseract.js from the OCR package (WebView), with one language pack per language.
// Recognized text remains strictly on-device (RunValue 'text'): copy, save to file, generate
// PDF—never sent to the AI (D-036).

export const OCR_TOOL_ID = 'ocr';

/** Recognition scope for Excel conversion (D-272): entire content (default) or table content only. */
export const TABLE_SCOPES = ['all', 'tables'] as const;
export const OCR_PAGE_ID = 'tool-ocr';

/**
 * Recognition language parameter (D-278): auto (default, does not prompt user) or specify one. On
 * mobile, auto selects the engine based on system language: PP-OCRv6 uses a single model covering
 * Chinese, Japanese, English, French, German, Spanish, Portuguese, and Italian (all included in
 * its dictionary), while Korean, Russian, and Vietnamese use system APIs.
 */
export const OCR_LANGUAGE_CHOICES = ['auto', ...OCR_LANGUAGES] as const;
export type OcrLanguageChoice = (typeof OCR_LANGUAGE_CHOICES)[number];

export const OCR_LANGUAGE_NAMES: Record<(typeof OCR_LANGUAGES)[number], Localized> = {
  eng: { en: 'English', zh: '英文', fr: 'Anglais' },
  chi_sim: { en: 'Chinese (Simplified)', zh: '简体中文', fr: 'Chinois (simplifié)' },
  chi_tra: { en: 'Chinese (Traditional)', zh: '繁体中文', fr: 'Chinois (traditionnel)' },
  jpn: { en: 'Japanese', zh: '日文', fr: 'Japonais' },
  kor: { en: 'Korean', zh: '韩文', fr: 'Coréen' },
  fra: { en: 'French', zh: '法文', fr: 'Français' },
  deu: { en: 'German', zh: '德文', fr: 'Allemand' },
  spa: { en: 'Spanish', zh: '西班牙文', fr: 'Espagnol' },
  por: { en: 'Portuguese', zh: '葡萄牙文', fr: 'Portugais' },
  ita: { en: 'Italian', zh: '意大利文', fr: 'Italien' },
  rus: { en: 'Russian', zh: '俄文', fr: 'Russe' },
  vie: { en: 'Vietnamese', zh: '越南文', fr: 'Vietnamien' },
};

export const OCR_ACTIONS: readonly ActionDefinition[] = [
  {
    id: 'ocr.recognize',
    label: { en: 'Recognize text', zh: '识别文字', fr: 'Reconnaître le texte' },
    description: {
      en: 'Reads printed text in the images. lang "auto" (the default) reads Chinese, Japanese, English and Western European text with one model and picks by the phone’s language otherwise; set a language only when the user names one. Handwriting and receipt amounts may be wrong. The text stays on this device.',
      zh: '识别图片里的印刷文字。lang 为 auto（默认）时一个模型认中日英和西欧文字，其他按手机语言选；用户指定语言时才写具体语言。手写和收据金额可能认错。文字只留在本机。',
      fr: 'Reconnaît le texte imprimé des images. lang « auto » (par défaut) lit le chinois, le japonais, l’anglais et les langues d’Europe de l’Ouest avec un seul modèle, et choisit selon la langue du téléphone sinon ; n’indiquez une langue que si l’utilisateur la précise. L’écriture manuscrite et les montants de tickets peuvent être mal lus. Le texte reste sur cet appareil.',
    },
    input: ['images'],
    output: 'text',
    params: z.strictObject({ lang: z.enum(OCR_LANGUAGE_CHOICES) }),
    fields: [
      {
        key: 'lang',
        label: { en: 'Language', zh: '语言', fr: 'Langue' },
        kind: 'choice',
        // Automatic correctness without prompting (D-278, D-363).
        ask: false,
        options: [
          { value: 'auto', label: { en: 'Auto', zh: '自动', fr: 'Automatique' } },
          ...OCR_LANGUAGES.map((value) => ({ value, label: OCR_LANGUAGE_NAMES[value] })),
        ],
      },
    ],
    pack: 'ocr',
    // Language pack depends on recognition package: ensures downloading the language pack also
    // downloads the recognition package together. Not required for system-supported languages
    // (engine's packNotNeeded). Device determines which to use when set to auto (app's devicePack /
    // packNotNeeded), falling back to the recognition package itself here.
    packFor: (params) => (params.lang === 'auto' ? undefined : ocrPackId(String(params.lang))),
    requires: [],
    // Step descriptions recognized by built-in rules (D-265).
    phrases: [
      {
        match: /^(?:识别文字|文字识别|提取文字)$|^(?:recognize|read|extract) (?:the )?text$/i,
        step: () => ({ params: { lang: 'auto' } }),
      },
    ],
  },
  {
    // Scanned document to Excel (D-272): recognizes bordered tables only (plus tables with horizontal lines only), without adding new models; results page allows viewing and editing.
    id: 'ocr.toExcel',
    label: { en: 'Convert to Excel', zh: '转 Excel', fr: 'Convertir en classeur Excel' },
    description: {
      en: 'Reads tables with ruled lines in the images and makes one Excel workbook, a sheet per page. You can check and edit it before saving. The text stays on this device.',
      zh: '识别图片里带线的表格，做成一个 Excel 文件，每页一张工作表。保存前可以核对和修改。文字只留在本机。',
      fr: 'Lit les grilles à lignes des images et crée un seul classeur Excel, une feuille par page. Vous pouvez le vérifier et le modifier avant de l’enregistrer. Le texte reste sur cet appareil.',
    },
    input: ['images'],
    output: 'files',
    // Language and scope same as text recognition, defaults to auto without prompting (D-278).
    params: z.strictObject({ lang: z.enum(OCR_LANGUAGE_CHOICES), scope: z.enum(TABLE_SCOPES) }),
    fields: [
      {
        key: 'lang',
        label: { en: 'Language', zh: '语言', fr: 'Langue' },
        kind: 'choice',
        // Automatic correctness without prompting (D-278, D-363).
        ask: false,
        options: [
          { value: 'auto', label: { en: 'Auto', zh: '自动', fr: 'Automatique' } },
          ...OCR_LANGUAGES.map((value) => ({ value, label: OCR_LANGUAGE_NAMES[value] })),
        ],
      },
      {
        key: 'scope',
        label: { en: 'Content', zh: '识别范围', fr: 'Contenu' },
        kind: 'choice',
        ask: false,
        options: [
          { value: 'all', label: { en: 'Everything', zh: '全部内容', fr: 'Tout le contenu' } },
          {
            value: 'tables',
            label: { en: 'Tables only', zh: '仅表格内容', fr: 'Grilles seulement' },
          },
        ],
      },
    ],
    // Requires line text coordinates: uses on-device recognition only (PP-OCRv6 or system), excluding the OCR package (tesseract provides text only).
    requires: [],
    ai: '"Photo / scan of a table to Excel, a spreadsheet from a paper table, 表格转 Excel" → in.photos (source "scanner" for paper, then scan.detect → scan.enhance mode "auto"; library photos and screenshots go straight in) → ocr.toExcel; lang "auto" unless they name the language of the table, scope "all" unless they want only the tables. A scanned PDF: in.files accept "pdf" → pdf.toImages first. It makes one .xlsx with a sheet per page, which the user can check and edit on the result page; only tables with ruled lines (or only horizontal rules) become cells, everything else comes out as rows of text. Handwriting and tables without lines are not supported yet.',
    phrases: [
      {
        match:
          /^(?:(?:表格)?转(?:成)?\s*excel|做成\s*excel(?:\s*表格)?|(?:convert|turn) (?:it |them )?(?:in)?to (?:an )?excel(?: (?:file|workbook|spreadsheet))?)$/i,
        step: () => ({ params: { lang: 'auto', scope: 'all' } }),
      },
    ],
  },
  {
    // Scanned document to Word (D-328): layout analysis (layout expansion pack, can convert without
    // downloading though without title/image distinction) + text recognition + bordered tables,
    // compiled into a docx; results page allows viewing and editing. Distinct from electronic PDF
    // to Word conversion (which D-186 does not do).
    id: 'ocr.toWord',
    label: { en: 'Convert to Word', zh: '转 Word', fr: 'Convertir en document Word' },
    description: {
      en: 'Reads the printed pages in the images and makes one Word document: headings, paragraphs, lists, tables with ruled lines and pictures, a page per image. You can check and edit it before saving. The text stays on this device.',
      zh: '识别图片里的印刷页面，做成一个 Word 文件：标题、段落、列表、带线的表格和图片，每张图一页。保存前可以核对和修改。文字只留在本机。',
      fr: 'Lit les pages imprimées des images et crée un seul document Word : titres, paragraphes, listes, grilles à lignes et images, une page par image. Vous pouvez le vérifier et le modifier avant de l’enregistrer. Le texte reste sur cet appareil.',
    },
    input: ['images'],
    output: 'files',
    // Language and scope same as text recognition, defaults to auto without prompting (D-278).
    params: z.strictObject({ lang: z.enum(OCR_LANGUAGE_CHOICES) }),
    fields: [
      {
        key: 'lang',
        label: { en: 'Language', zh: '语言', fr: 'Langue' },
        kind: 'choice',
        // Automatic correctness without prompting (D-278, D-363).
        ask: false,
        options: [
          { value: 'auto', label: { en: 'Auto', zh: '自动', fr: 'Automatique' } },
          ...OCR_LANGUAGES.map((value) => ({ value, label: OCR_LANGUAGE_NAMES[value] })),
        ],
      },
    ],
    // Requires line text coordinates: uses on-device recognition only (same as Excel conversion); layout analysis model is queried separately by the app (optional).
    requires: [],
    ai: '"Photo / scan of a document, letter or book page to Word, 拍文档转 Word, 图片转 Word" → in.photos (source "scanner" for paper, then scan.detect → scan.enhance mode "auto"; library photos and screenshots go straight in) → ocr.toWord; lang "auto" unless they name the language. A scanned PDF: in.files accept "pdf" → pdf.toImages first. It makes one .docx (a page per image) that the user can check and edit on the result page. For a digital PDF, use in.files accept "pdf" → pdf.toImages → ocr.toWord too: available source graphics and paper size are retained locally, while body text is reconstructed as editable paragraphs and tables. Exact fonts and reading order are not guaranteed.',
    phrases: [
      {
        match:
          /^(?:(?:文档|图片)?转(?:成)?\s*word(?:\s*文档)?|做成\s*word(?:\s*文档)?|(?:convert|turn) (?:it |them )?(?:in)?to (?:a )?word(?: (?:file|document))?)$/i,
        step: () => ({ params: { lang: 'auto' } }),
      },
    ],
  },
];

const CJK = '\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef';
// Korean words naturally contain spaces, so they are excluded. Avoids lookbehind: uses a capturing group to preserve the preceding character.
const CJK_THEN = new RegExp(`([${CJK}]) +(?=[${CJK}0-9])`, 'g');
const DIGIT_THEN_CJK = new RegExp(`([0-9]) +(?=[${CJK}])`, 'g');

/**
 * Clean up OCR results (done on-device): Tesseract inserts spaces between CJK characters (e.g.,
 * "lease renewal notice"), remove these spaces; preserve spaces between Latin characters; trim
 * leading/trailing whitespace from each line and remove redundant empty lines.
 */
export function tidyOcrText(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(CJK_THEN, '$1').replace(DIGIT_THEN_CJK, '$1').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Single-feature workflow (D-061). Automatic language (D-278), not prompted at runtime; users can specify it in "Adjust Settings". */
export function ocrWorkflows(locale: Locale): Workflow[] {
  const wf = (id: string, name: [string, string], steps: Workflow['steps']): Workflow => ({
    id,
    kind: 'quickAction',
    package: OCR_TOOL_ID,
    name: pairText(locale, name),
    steps,
  });
  return [
    wf(
      'ocr-photos',
      ['Text from photos', '识别照片里的文字'],
      [
        { id: 'pick', action: 'in.photos', params: { source: 'library', min: 1, max: 20 } },
        { id: 'read', action: 'ocr.recognize', params: { lang: 'auto' } },
      ],
    ),
    wf(
      'ocr-scan',
      ['Scan and get text', '拍照识别文字'],
      [
        { id: 'shoot', action: 'in.photos', params: { source: 'scanner', min: 1, max: 10 } },
        { id: 'edges', action: 'scan.detect', params: {} },
        { id: 'read', action: 'ocr.recognize', params: { lang: 'auto' } },
      ],
    ),
  ];
}

export const ocrTool: ToolDefinition = {
  id: OCR_TOOL_ID,
  version: '1.0.0',
  name: { en: 'Text recognition', zh: '文字识别', fr: 'Reconnaissance de texte' },
  description: {
    en: 'Get printed text out of photos and scans on this device, in 12 languages.',
    zh: '在本机识别照片和扫描件里的印刷文字，支持 12 种语言。',
    fr: 'Extrait le texte imprimé des photos et numérisations sur cet appareil, en 12 langues.',
  },
  icon: 'text',
  aliases: ['ocr', 'text recognition', 'recognize text', '文字识别', '识别文字', 'ocr 工具'],
  permissions: ['files.pick', 'files.write', 'camera'],
  actions: OCR_ACTIONS,
  createPage: (locale) => ({
    id: OCR_PAGE_ID,
    title: t(locale, 'ocr_Text_recognition_fe569'),
    icon: 'text',
    package: OCR_TOOL_ID,
    blocks: [
      {
        id: 'ocr-header',
        look: 'header',
        show: { title: t(locale, 'ocr_Text_recognition_fe569') },
      },
      {
        id: 'ocr-intro',
        look: 'text',
        show: {
          text: t(locale, 'ocr_Runs_on_this_device_the_text_is_never__38fca'),
        },
      },
      ...ocrWorkflows(locale).map((wf) => ({
        id: `${wf.id}-runner`,
        look: 'button' as const,
        tools: [{ tool: wf.id }],
      })),
    ],
  }),
  createWorkflows: ocrWorkflows,
};
