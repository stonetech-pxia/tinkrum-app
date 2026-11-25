import { appEntryOps } from './app-file';
import { t, pairText } from './messages';
import { createDefaultWorkspace } from './defaults';
import type { DrawnIcon } from './drawn-icons';
import { FILES_TABLE } from './files-table';
import { applyOps } from './ops';
import type { Op } from './ops-schema';
import type { Registry } from './registry';
import {
  HOME_PAGE_ID,
  TOOLBOX_PAGE_ID,
  pageTarget,
  type ComponentOf,
  type Locale,
  type WorkspaceConfig,
} from './schema';
import { STARTER_THEME } from './theme';
import { validateWorkspace } from './validate';

/**
 * Preinstalled tools for new users on first launch (D-104): High-demand Image and PDF tools,
 * Video tool for "videos too large to send" (D-146), along with built-in phone capabilities for
 * scanning, OCR, and QR codes. All run locally and download nothing upon installation.
 */
export const STARTER_TOOL_IDS = ['image', 'pdf', 'video', 'scan', 'ocr', 'qr'] as const;

/** Toolbox groups (D-181): Categorized by purpose, with the final group capturing any unlisted tools (future newly added tools will also appear here). */
const TOOLBOX_GROUPS: { id: string; title: [string, string]; toolIds?: string[] }[] = [
  {
    id: 'media',
    title: ['Photos, video and audio', '照片、视频和声音'],
    toolIds: ['image', 'video', 'audio'],
  },
  { id: 'files', title: ['Files and documents', '文件和材料'], toolIds: ['pdf', 'scan', 'zip'] },
  { id: 'text', title: ['Text', '文字'], toolIds: ['ocr', 'translate', 'text'] },
  // QR codes, reports, and future newly added tools.
  { id: 'more', title: ['More tools', '更多工具'] },
];

type Page = WorkspaceConfig['containers']['pages'][number];

/** The toolbox page (D-181): every tool of the catalog, grouped by purpose, and "Manage tools". */
export function toolboxPage(locale: Locale, registry: Registry, id = TOOLBOX_PAGE_ID): Page {
  const pick = (pair: [string, string]) => pairText(locale, pair);
  const grids: ComponentOf<'packages'>[] = TOOLBOX_GROUPS.flatMap((g) => {
    const ids = g.toolIds?.filter((toolId) => registry.tools.has(toolId));
    if (ids && ids.length === 0) return [];
    return [
      {
        id: `tools-${g.id}`,
        look: 'packages' as const,
        show: { title: pick(g.title) },
        source: { catalog: 'packages' as const, ...(ids ? { ids } : {}) },
      },
    ];
  });
  return {
    id,
    title: t(locale, 'starter_Toolbox_802f3'),
    icon: 'apps',
    blocks: [
      {
        id: 'toolbox-header',
        look: 'header',
        show: { title: t(locale, 'starter_Toolbox_802f3') },
      },
      ...grids,
      {
        id: 'toolbox-manage',
        look: 'button',
        show: { label: t(locale, 'starter_Manage_tools_f1487'), variant: 'text' },
        opens: 'tools',
      },
    ],
  };
}

/**
 * The blocks of the Paper app's first page (D-487): title and subtitle; product selling points
 * highlighted at the top: scan to PDF, Word, Excel, and merge files (four tiles, all built-in
 * quick actions that run immediately on tap without needing to be added); followed by a
 * primary-colored "Open files" button (prompting whether to choose from photo library or files);
 * followed by recent operations and recent files (D-452). Tiles are omitted if required tools are
 * uninstalled.
 */
export function paperBlocks(
  config: WorkspaceConfig,
  locale: Locale,
  title: string,
): Page['blocks'] {
  const installed = (id: string) => config.packages.some((p) => p.id === id);
  // Quick actions in the tiles (built-in preset IDs) and their required tools.
  const tiles = [
    { id: 'scan', tool: 'scan-camera', needs: 'scan' },
    { id: 'scan-word', tool: 'scan-doc-word', needs: 'scan' },
    { id: 'scan-excel', tool: 'scan-table-excel', needs: 'scan' },
    { id: 'combine', tool: 'combine-documents', needs: 'pdf' },
  ].filter((x) => installed(x.needs));
  const grid: Page['blocks'] =
    tiles.length > 0
      ? [
          {
            id: 'file-entries',
            look: 'group',
            show: { layout: 'grid', columns: 2 },
            children: tiles.map((x) => ({
              id: x.id,
              look: 'action' as const,
              show: { shape: 'tile' as const },
              tools: [{ tool: x.tool }],
            })),
          },
        ]
      : [];
  return [
    { id: 'hello', look: 'header', show: { title, subtitle: t(locale, 'homeTagline') } },
    ...grid,
    { id: 'open-files', look: 'picker', tools: [{ tool: '$pick.open' }] },
    // D-452: Recently used quick actions (reading run logs, hidden when empty) and recent files (all scanned files are stored here, D-450).
    {
      id: 'recent-actions',
      look: 'library',
      show: { title: t(locale, 'homeRecentActions') },
      source: { catalog: 'quickActions', recent: true },
    },
    {
      id: 'recent-files',
      look: 'files',
      show: { title: t(locale, 'homeRecentFiles') },
      source: { table: FILES_TABLE, limit: 3 },
    },
  ];
}

/** The app the guide builds for a new user (D-new-apphome-2). */
export const PAPER_APP_ID = 'paper';

/** The sentence of guide step 1: it fills the box on the Tink page, and the built-in rules know it in all three languages. */
export const PAPER_APP_REQUEST: Record<Locale, string> = {
  zh: '创建一个 Paper App',
  en: 'Create a Paper app',
  fr: 'Créer une app Paper',
};

/** Tinkrum's red, as on its own app icon: the color of the Paper app and of its icon. */
const TINKRUM_RED = '#D92D20';
const PAPER_ICON_ID = 'tinkrum-paper';
/**
 * The Paper app's icon, in the manner of Tinkrum's own: a tilted sheet with a folded corner and
 * the two oval eyes. Drawn in the config (D-625), so Tink and the user can change it.
 */
const PAPER_ICON: DrawnIcon = {
  paths: [
    'M3.86 5.39L10.61 3.2L12.28 8.33L17.42 6.67L20.88 17.32L20.08 18.73L9.42 22.19L7.94 21.52L3.15 6.78ZM9.89 12.95A1.15 1.95 -18 1 0 11.09 16.66A1.15 1.95 -18 1 0 9.89 12.95ZM14.36 11.5A1.15 1.95 -18 1 0 15.56 15.21A1.15 1.95 -18 1 0 14.36 11.5Z',
    'M12.23 2.99L16.64 5.24L13.31 6.32Z',
  ],
};

/**
 * The Paper app (D-new-apphome-2): the former default home page (D-487) as an app of its own,
 * with the files by type and the toolbox on its bar, in the Clay look in Tinkrum's red on a plain
 * backdrop (D-552). No operations when the app is already there.
 */
export function paperAppOps(config: WorkspaceConfig, locale: Locale, registry: Registry): Op[] {
  const app = PAPER_APP_ID;
  if (config.nav.apps?.some((a) => a.id === app)) return [];
  const name = t(locale, 'paperAppName');
  const pages: Page[] = [
    {
      id: `${app}-home`,
      title: t(locale, 'defaults_Home_ec133'),
      icon: 'home',
      blocks: paperBlocks(config, locale, name),
    },
    { ...filesByTypePage(locale), id: `${app}-files` },
    toolboxPage(locale, registry, `${app}-toolbox`),
  ];
  return [
    { op: 'setTheme', icons: { [PAPER_ICON_ID]: PAPER_ICON } },
    {
      op: 'addContainer',
      app: {
        id: app,
        name,
        icon: `my:${PAPER_ICON_ID}`,
        bar: [...pages.map((p) => pageTarget(p.id)), 'ai'],
        theme: { ...structuredClone(STARTER_THEME), primaryColor: TINKRUM_RED, backdrop: 'plain' },
      },
    },
    // These pages hold only blocks this version knows.
    ...pages.map((page) => ({ op: 'addContainer', page: { ...page, app } }) as Op),
    ...appEntryOps(config, app),
  ];
}

/**
 * Initial version for new users (D-new-apphome-1): the home page is the list of the user's apps
 * and nothing else, empty until the guide builds the first one; preinstalled tools; the navigation
 * bar limited to Home, AI, and Settings (tool management and history are under Settings).
 * createDefaultWorkspace remains blank: used as the baseline for tests, evaluations, and
 * rollbacks.
 */
export function createStarterWorkspace(locale: Locale, registry: Registry): WorkspaceConfig {
  // D-487: New users' first version uses the refined Clay (STARTER_THEME); createDefaultWorkspace remains the baseline.
  const base = { ...createDefaultWorkspace(locale), theme: structuredClone(STARTER_THEME) };
  const toolIds = STARTER_TOOL_IDS.filter((id) => registry.tools.has(id));

  const ops: Op[] = [
    ...toolIds.map((id) => ({ op: 'setPackage' as const, package: id, do: 'add' as const })),
    // With no tool grid yet, adding each tool put a card on the home page: the home page only lists apps.
    ...[...toolIds.map((id) => `card-${id}`), 'welcome', 'catalog', 'recent-files'].map(
      (block): Op => ({ op: 'removeContainer', page: HOME_PAGE_ID, block }),
    ),
    {
      op: 'addContainer',
      page: HOME_PAGE_ID,
      block: { id: 'apps', look: 'apps', source: { catalog: 'apps' } },
    },
    { op: 'updateContainer', nav: { bar: [pageTarget(HOME_PAGE_ID), 'ai', 'settings'] } },
  ];
  const applied = applyOps(base, ops, { registry, locale });
  if (!applied.ok) return base;
  const valid = validateWorkspace(applied.config, registry);
  return valid.ok ? valid.config : base;
}

/**
 * "Files" page: scanned, converted, and opened files are arranged as a bookshelf by type (used by
 * the portal's Clay preset, D-487). Generated per language, and builtin-text also recognizes it,
 * so imported presets follow the interface language (D-582).
 */
export function filesByTypePage(locale: Locale): Page {
  const shelf = (id: string, title: string, kind: string) => ({
    id,
    look: 'files' as const,
    show: { title },
    source: {
      table: FILES_TABLE,
      filter: [{ field: 'kind', op: 'is' as const, value: kind }],
      limit: 5,
    },
  });
  return {
    id: 'files',
    title: t(locale, 'presetFilesTitle'),
    icon: 'document',
    blocks: [
      {
        id: 'files-hello',
        look: 'header',
        show: { title: t(locale, 'presetFilesTitle'), subtitle: t(locale, 'presetFilesSubtitle') },
      },
      shelf('shelf-pdf', t(locale, 'filesKindPdf'), 'pdf'),
      shelf('shelf-doc', t(locale, 'filesKindDoc'), 'doc'),
      shelf('shelf-sheet', 'Excel', 'sheet'),
      shelf('shelf-image', t(locale, 'filesKindImage'), 'image'),
    ],
  } as Page;
}
