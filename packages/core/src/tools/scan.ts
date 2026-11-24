import { t, pairText } from '../messages';
import { z } from 'zod';

import { FILES_TABLE } from '../files-table';
import type { ToolDefinition } from '../registry';
import type { Locale, Workflow } from '../schema';
import type { ActionDefinition } from '../workflow/contract';

// Scan tool manifest (T5): Edge detection and perspective correction use the system Vision / Core
// Image on iOS (D-086), and the scanning package (WebView + OpenCV.js + jscanify) on other
// platforms; capture scanning uses the system document camera (VisionKit on iOS, ML Kit on
// Android); the four corners are adjusted locally by the user (edge detection can fail when the
// background is cluttered or the paper extends past the frame); pages captured by the system
// document camera are already straightened and passed through directly; flattening (D-274, enabled
// by default) is performed on both page types and requires downloading the flattening model.
// Enhancement uses Skia (D-266: shadow removal, deskewing, auto color/grayscale, or black-and-white
// using local thresholding) without requiring an extension pack.

export const SCAN_TOOL_ID = 'scan';
export const SCAN_PAGE_ID = 'tool-scan';

export const ENHANCE_MODES = ['auto', 'gray', 'bw', 'none'] as const;

export const SCAN_ACTIONS: readonly ActionDefinition[] = [
  {
    id: 'scan.detect',
    label: {
      en: 'Find edges and straighten',
      zh: '找边并拉正',
      fr: 'Trouver les bords et redresser',
    },
    description: {
      en: 'Finds the edges of the paper in each photo; the user checks or drags the four corners; then the page is straightened. Pages from the document camera are already straight and pass through. flatten (on unless false) also flattens curved or creased pages so the lines of text come out straight (needs a one-time model download; scanning works without it).',
      zh: '在每张照片里找到纸张的边，用户确认或拖动四个角，然后把页面拉正。文档相机扫描的页面已经拉正，直接通过。flatten（不写成 false 就打开）还会把弯曲、有折痕的页面展平，文字行变直（要下载一次模型，不下载也照常扫描）。',
      fr: 'Recherche les bords du papier dans chaque photo ; vous vérifiez ou faites glisser les quatre coins, puis la page est redressée. Les pages de la caméra de document sont déjà droites et sont conservées telles quelles. flatten (activé sauf s’il vaut false) aplanit aussi les pages courbées ou froissées pour que les lignes de texte soient droites (un modèle à télécharger une fois ; la numérisation fonctionne sans lui).',
    },
    input: ['images'],
    output: 'images',
    // D-274: Flattening is enabled by default (omitted = enabled); old configurations do not require migration.
    params: z.strictObject({ flatten: z.boolean().optional() }),
    fields: [
      {
        key: 'flatten',
        label: {
          en: 'Flatten curved pages',
          zh: '展平弯曲的页面',
          fr: 'Aplanir les pages courbées',
        },
        kind: 'toggle',
        defaultOn: true,
      },
    ],
    local: 'corners',
    pack: 'scan',
    requires: [],
    // Step descriptions recognized by built-in rules (D-265).
    phrases: [{ match: /^(?:扫描|找边|拉正)$|^(?:scan|straighten)$/i }],
  },
  {
    id: 'scan.enhance',
    label: { en: 'Enhance', zh: '增强', fr: 'Améliorer' },
    description: {
      en: 'Makes scanned pages easier to read: removes shadows, turns the paper white and straightens slightly tilted text. Auto keeps color only when the page has colored ink; grayscale and black and white are also available.',
      zh: '让扫描的页面更清楚：去掉阴影，把纸变白，把轻微歪斜的文字转正。「自动」只在页面上有彩色字迹时保留颜色；也可以选灰度或黑白。',
      fr: 'Rend les pages numérisées plus lisibles : supprime les ombres, blanchit le papier et redresse le texte légèrement penché. Automatique ne garde la couleur que si la page contient de l’encre de couleur ; niveaux de gris et noir et blanc sont aussi proposés.',
    },
    input: ['images'],
    output: 'images',
    params: z.strictObject({ mode: z.enum(ENHANCE_MODES) }),
    fields: [
      {
        key: 'mode',
        label: { en: 'Look', zh: '效果', fr: 'Rendu' },
        kind: 'choice',
        options: [
          { value: 'auto', label: { en: 'Auto', zh: '自动', fr: 'Automatique' } },
          { value: 'gray', label: { en: 'Grayscale', zh: '灰度', fr: 'Niveaux de gris' } },
          { value: 'bw', label: { en: 'Black and white', zh: '黑白', fr: 'Noir et blanc' } },
          { value: 'none', label: { en: 'Original', zh: '原样', fr: 'Original' } },
        ],
      },
    ],
    requires: [],
  },
];

const toPdf = {
  id: 'pdf',
  action: 'pdf.fromImages',
  // Text layer (D-195): Scanned PDFs are searchable and text-copyable, and the document library can also search by the text inside them (D-455).
  params: {
    pageSize: 'a4',
    orientation: 'auto',
    marginMm: 0,
    fit: 'contain',
    maxMB: 0,
    textLayer: true,
  },
};

/** Single-function workflow (D-061). */
export function scanWorkflows(locale: Locale): Workflow[] {
  const wf = (id: string, name: [string, string], steps: Workflow['steps']): Workflow => ({
    id,
    kind: 'quickAction',
    package: SCAN_TOOL_ID,
    name: pairText(locale, name),
    steps,
  });
  const name = {
    id: 'name',
    action: 'file.rename',
    params: { template: t(locale, 'scan_Scan_5b295') },
  };
  // Scanned files remain in the app's document library (D-450): finally saved to Tinkrum files, visible in "Recent files" on the Home Screen.
  const keep = { id: 'keep', action: 'file.save', params: {} };
  return [
    wf(
      'scan-camera',
      ['Scan to PDF', '扫描成 PDF'],
      [
        { id: 'shoot', action: 'in.photos', params: { source: 'scanner', min: 1, max: 30 } },
        { id: 'edges', action: 'scan.detect', params: { flatten: true } },
        { id: 'look', action: 'scan.enhance', params: { mode: 'auto' }, ask: ['mode'] },
        toPdf,
        name,
        keep,
      ],
    ),
    wf(
      'scan-library',
      ['Scan photos to PDF', '照片扫描成 PDF'],
      [
        { id: 'pick', action: 'in.photos', params: { source: 'library', min: 1, max: 30 } },
        { id: 'edges', action: 'scan.detect', params: { flatten: true } },
        { id: 'look', action: 'scan.enhance', params: { mode: 'auto' }, ask: ['mode'] },
        toPdf,
        name,
        keep,
      ],
    ),
    wf(
      'scan-straighten',
      ['Straighten photos of paper', '拉正纸张照片'],
      [
        { id: 'pick', action: 'in.photos', params: { source: 'library', min: 1, max: 30 } },
        { id: 'edges', action: 'scan.detect', params: { flatten: true } },
      ],
    ),
  ];
}

export const scanTool: ToolDefinition = {
  id: SCAN_TOOL_ID,
  version: '1.0.0',
  name: { en: 'Scanner', zh: '扫描', fr: 'Numériser' },
  description: {
    en: 'Turn photos of paper into straight, clean pages and PDFs on this device.',
    zh: '在本机把拍下的纸张拉正、变清楚，合成 PDF。',
    fr: 'Transformez les photos de papier en pages droites et nettes, et en PDF, sur cet appareil.',
  },
  icon: 'scan',
  aliases: ['scan', 'scanner', 'document scanner', '扫描', '扫描仪'],
  permissions: ['files.pick', 'files.write', 'photos.save', 'camera'],
  actions: SCAN_ACTIONS,
  createPage: (locale) => ({
    id: SCAN_PAGE_ID,
    title: t(locale, 'scan_Scanner_08f22'),
    icon: 'scan',
    package: SCAN_TOOL_ID,
    blocks: [
      { id: 'scan-header', look: 'header', show: { title: t(locale, 'scan_Scanner_08f22') } },
      {
        id: 'scan-intro',
        look: 'text',
        show: {
          text: t(locale, 'scan_Everything_runs_on_this_device_nothing_09e42'),
        },
      },
      ...scanWorkflows(locale).map((wf) => ({
        id: `${wf.id}-runner`,
        look: 'action' as const,
        tools: [{ tool: wf.id }],
      })),
      {
        id: 'scan-files',
        look: 'files',
        show: { title: t(locale, 'scan_Scans_7ac9d') },
        source: {
          table: FILES_TABLE,
          filter: [{ field: 'kind', op: 'is', value: 'pdf' }],
          limit: 10,
        },
      },
    ],
  }),
  createWorkflows: scanWorkflows,
};
