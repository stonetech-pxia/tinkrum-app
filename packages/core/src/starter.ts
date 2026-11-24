import { t, pairText } from './messages';
import { createDefaultWorkspace } from './defaults';
import { FILES_TABLE } from './files-table';
import { applyOps } from './ops';
import type { Op } from './ops-schema';
import type { Registry } from './registry';
import {
  HOME_PAGE_ID,
  TOOLBOX_PAGE_ID,
  allComponents,
  isKnownComponent,
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

/**
 * Home screen entry points (used in onboarding step 1 and "Skip guide", D-231; redesigned in
 * D-487): Title and subtitle; product selling points highlighted at the top—scan to PDF, Word,
 * Excel, and merge files (four tiles, all built-in quick actions that run immediately on tap
 * without needing to be added); followed by a primary-colored "Open files" button (prompting
 * whether to choose from photo library or files); followed by the toolbox entry, recent
 * operations, and recent files. Omitted if file entry points already exist on the home screen;
 * tiles are omitted if required tools are uninstalled.
 */
export function homeFileEntryOps(config: WorkspaceConfig, locale: Locale): Op[] {
  const home = config.containers.pages.find((p) => p.id === HOME_PAGE_ID);
  if (!home || allComponents(home).some((c) => isKnownComponent(c) && c.look === 'picker'))
    return [];
  const ids = new Set(allComponents(home).map((c) => c.id));
  const free = (id: string) => (ids.has(id) ? `${id}-2` : id);
  const installed = (id: string) => config.packages.some((p) => p.id === id);
  // Quick actions in the tiles (built-in preset IDs) and their required tools.
  const tiles = [
    { id: 'scan', tool: 'scan-camera', needs: 'scan' },
    { id: 'scan-word', tool: 'scan-doc-word', needs: 'scan' },
    { id: 'scan-excel', tool: 'scan-table-excel', needs: 'scan' },
    { id: 'combine', tool: 'combine-documents', needs: 'pdf' },
  ].filter((x) => installed(x.needs));
  return [
    {
      op: 'addContainer',
      page: HOME_PAGE_ID,
      block: {
        id: free('hello'),
        look: 'header',
        show: { title: 'Tinkrum', subtitle: t(locale, 'homeTagline') },
      },
    },
    ...(tiles.length > 0
      ? [
          {
            op: 'addContainer' as const,
            page: HOME_PAGE_ID,
            block: {
              id: free('file-entries'),
              look: 'group' as const,
              show: { layout: 'grid' as const, columns: 2 as const },
              children: tiles.map((x) => ({
                id: free(x.id),
                look: 'action' as const,
                show: { shape: 'tile' as const },
                tools: [{ tool: x.tool }],
              })),
            },
          },
        ]
      : []),
    {
      op: 'addContainer',
      page: HOME_PAGE_ID,
      block: {
        id: free('open-files'),
        look: 'picker',
        tools: [{ tool: '$pick.open' }],
      },
    },
    ...(config.containers.pages.some((p) => p.id === TOOLBOX_PAGE_ID)
      ? [
          {
            op: 'addContainer' as const,
            page: HOME_PAGE_ID,
            block: {
              id: free('toolbox-entry'),
              look: 'button' as const,
              show: {
                label: t(locale, 'starter_Toolbox_802f3'),
                variant: 'row' as const,
                icon: 'apps' as const,
              },
              opens: pageTarget(TOOLBOX_PAGE_ID),
            },
          },
        ]
      : []),
    // D-452: Recently used quick actions (reading run logs, hidden when empty) and recent files (all scanned files are stored here, D-450).
    {
      op: 'addContainer',
      page: HOME_PAGE_ID,
      block: {
        id: free('recent-actions'),
        look: 'library',
        show: { title: t(locale, 'homeRecentActions') },
        source: { catalog: 'quickActions', recent: true },
      },
    },
    {
      op: 'addContainer',
      page: HOME_PAGE_ID,
      block: {
        id: free('recent-files'),
        look: 'files',
        show: { title: t(locale, 'homeRecentFiles') },
        source: { table: FILES_TABLE, limit: 3 },
      },
    },
  ];
}

/**
 * Initial version for new users (D-182): Blank home screen (D-231, onboarding step 1 adds file
 * entry), toolbox page, preinstalled tools, with navigation bar limited to Home, AI, and Settings
 * (tools reside in the home screen toolbox, while tool management and history are under
 * Settings). createDefaultWorkspace remains blank: used as the baseline for tests, evaluations,
 * and rollbacks.
 */
export function createStarterWorkspace(locale: Locale, registry: Registry): WorkspaceConfig {
  const pick = (pair: [string, string]) => pairText(locale, pair);
  // D-487: New users' first version uses the refined Clay (STARTER_THEME); createDefaultWorkspace remains the baseline.
  const base = { ...createDefaultWorkspace(locale), theme: structuredClone(STARTER_THEME) };
  const toolIds = STARTER_TOOL_IDS.filter((id) => registry.tools.has(id));

  const grids: ComponentOf<'packages'>[] = TOOLBOX_GROUPS.flatMap((g) => {
    const ids = g.toolIds?.filter((id) => registry.tools.has(id));
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
  const toolbox = {
    id: TOOLBOX_PAGE_ID,
    title: t(locale, 'starter_Toolbox_802f3'),
    icon: 'apps' as const,
    blocks: [
      {
        id: 'toolbox-header',
        look: 'header' as const,
        show: { title: t(locale, 'starter_Toolbox_802f3') },
      },
      ...grids,
      {
        id: 'toolbox-manage',
        look: 'button' as const,
        show: { label: t(locale, 'starter_Manage_tools_f1487'), variant: 'text' as const },
        opens: 'tools' as const,
      },
    ],
  };

  const ops: Op[] = [
    // Place toolbox first: when adding tool packs, it already displays these tool packs, so the home screen won't have extra entry points (D-181).
    { op: 'addContainer', page: toolbox },
    ...toolIds.map((id) => ({ op: 'setPackage' as const, package: id, do: 'add' as const })),
    // Start home screen from blank (D-231): onboarding step 1 has the user add "Open album" and "Open files" themselves.
    { op: 'removeContainer', page: HOME_PAGE_ID, block: 'welcome' },
    { op: 'removeContainer', page: HOME_PAGE_ID, block: 'catalog' },
    { op: 'removeContainer', page: HOME_PAGE_ID, block: 'recent-files' },
    { op: 'updateContainer', nav: { bar: [pageTarget(HOME_PAGE_ID), 'ai', 'settings'] } },
  ];
  const applied = applyOps(base, ops, { registry, locale });
  if (!applied.ok) return base;
  const valid = validateWorkspace(applied.config, registry);
  return valid.ok ? valid.config : base;
}

type Page = WorkspaceConfig['containers']['pages'][number];

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
