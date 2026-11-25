import { useAiReturn } from '../ai/return';
import {
  BUILTIN_TOOLS,
  applyOps,
  createMockAIProvider,
  createRegistry,
  createStarterWorkspace,
  paperBlocks,
  toolboxPage,
  type Locale,
  type Op,
  type Registry,
  type WorkspaceConfig,
} from '@morph/core';
import { Stack } from 'expo-router';
import type { ReactNode } from 'react';
import { fireEvent } from '@testing-library/react-native';
import { renderRouter, screen } from 'expo-router/testing-library';
import { Alert } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { AISettingsProvider } from '../ai/context';
import { DraftChatSheet } from '../draft/DraftBar';
import { useDraftUi } from '../draft/ui';
import { createAISettingsStore, type SecretStore } from '../ai/settings';
import ChangeRoute from '../app/change';
import DataRoute from '../app/data';
import DataBackupRoute from '../app/data-backup';
import DataDeletedRoute from '../app/data-deleted';
import DataMoreRoute from '../app/data-more';
import DataTableRoute from '../app/data-table/[tableId]';
import DataUnusedRoute from '../app/data-unused';
import PickRecordsRoute from '../app/pick-records';
import SelectRecordsRoute from '../app/select-records';
import ImportRecordsRoute from '../app/import-records';
import DeskRoute from '../app/desk/[deskId]';
import FilePreviewRoute from '../app/file-preview';
import HomeRoute from '../app/index';
import OpenRoute from '../app/open';
import PageRoute from '../app/page/[pageId]';
import LanguageRoute from '../app/language';
import PresetsRoute from '../app/presets';
import ReadyRoute from '../app/ready/[workflowId]';
import NewTableRoute from '../app/new-table';
import RecordRoute from '../app/record/[collectionId]';
import ReminderRoute from '../app/reminder/[workflowId]';
import RunRoute from '../app/run/[workflowId]';
import ShareRoute from '../app/share';
import FilesRoute from '../app/files';
import StorageRoute from '../app/storage';
import OpenAppRoute from '../app/app/[appId]';
import WelcomeRoute from '../app/welcome';
import WorkflowRoute from '../app/workflow/[id]';
import WorkflowsRoute from '../app/workflows';
import QuickActionsRoute from '../app/quick-actions';
import QuickActionCategoryRoute from '../app/quick-actions/[kind]';
import { HomeScreenProvider } from '../home-screen/context';
import { PackHostProvider, type Packs } from '../packs/PackHost';
import type { HomeScreenPlatform } from '../home-screen/platform';
import { HomeScreenBridge } from '../home-screen/useHomeScreen';
import { useIncomingShare } from '../share/useIncomingShare';
import { ToolDownloadsProvider } from '../tool-download/context';
import type { ToolDownloads } from '../tool-download/state';
import { MemoryWorkspaceRepo } from '../storage/memory';
import { WidgetProvider } from '../widgets/context';
import type { WidgetPlatform } from '../widgets/types';
import { WidgetBridge } from '../widgets/useWidgets';
import { WorkspaceProvider } from '../workspace/context';
import { createWorkspaceStore } from '../workspace/store';
import { FakeFiles } from './fake-files';

// Shared by tool and workflow journey tests: real routing + in-memory storage + mock file platform.

// Draft mode UI state is module-scoped (D-190): each test starts with the chat box closed.
afterEach(() => useAiReturn.setState({ pending: null }));
afterEach(() => useDraftUi.setState({ chatOpen: false, seenStep: null }));

export const testRegistry = createRegistry(BUILTIN_TOOLS);

const memorySecrets = (): SecretStore => {
  const data = new Map<string, string>();
  return {
    get: async (k) => data.get(k) ?? null,
    set: async (k, v) => void data.set(k, v),
    delete: async (k) => void data.delete(k),
  };
};

/** Receives shares like the root layout (native modules are mocked or absent in tests). */
function ShareListener({ files }: { files: FakeFiles }) {
  useIncomingShare(files);
  return null;
}

/**
 * The home page of a user from before the app list (D-231, D-487): the scan tiles, "Open files",
 * the toolbox button, recent actions and files on the home page itself, and the toolbox page beside
 * it. Existing users keep it (D-new-apphome-1).
 */
export function homeWithFileEntries(locale: Locale, registry: Registry): WorkspaceConfig {
  const config = createStarterWorkspace(locale, registry);
  const toolbox = toolboxPage(locale, registry);
  const blocks = paperBlocks(config, locale, 'Tinkrum');
  blocks.splice(blocks.findIndex((b) => b.id === 'open-files') + 1, 0, {
    id: 'toolbox-entry',
    look: 'button',
    show: { label: toolbox.title, variant: 'row', icon: 'apps' },
    opens: 'page:toolbox',
  });
  const ops = [
    { op: 'addContainer', page: toolbox },
    { op: 'removeContainer', page: 'home', block: 'apps' },
    ...blocks.map((block) => ({ op: 'addContainer', page: 'home', block })),
  ] as Op[];
  const result = applyOps(config, ops, { registry, locale });
  if (!result.ok) throw new Error(result.error);
  return result.config;
}

export async function renderToolsApp(
  repo = new MemoryWorkspaceRepo(),
  files = new FakeFiles(),
  /** Downloaded tools (D-177): uses its own registry, which acquires tools during download. */
  options: {
    registry?: Registry;
    locale?: Locale;
    toolDownloads?: ToolDownloads;
    /** Initial version; defaults to a blank workspace when omitted (uses createStarterWorkspace in the app). */
    seed?: (locale: Locale, registry: Registry) => WorkspaceConfig;
    /** Home screen (D-271): fake long-press menu / home screen icons; matches Expo Go by default when omitted. */
    homeScreen?: HomeScreenPlatform;
    /** Home screen widgets (D-321): fake platform; matches Expo Go by default when omitted. */
    widgets?: WidgetPlatform;
    /** Packs environment (D-064): fake page channels and in-memory PackStore; absent by default (usePacks is null). */
    packs?: Packs;
    /** Whether the send button uses Tink (D-626). Tests default to Tink; the product default is another AI app. */
    tinkAgent?: boolean;
  } = {},
) {
  const registry = options.registry ?? testRegistry;
  const locale = options.locale ?? 'zh';
  const aiSettings = createAISettingsStore({ secrets: memorySecrets(), serverAvailable: false });
  await aiSettings.getState().load();
  await aiSettings.getState().setTinkAgent(options.tinkAgent ?? true);
  const store = createWorkspaceStore({
    repo,
    provider: createMockAIProvider(),
    registry,
    locale,
    now: () => new Date(2026, 9, 22, 9, 0),
    toolName: (id) =>
      options.toolDownloads?.getState().catalog?.tools.find((e) => e.id === id)?.name[locale],
    ...(options.seed ? { seed: options.seed } : {}),
  });
  await store.getState().boot();
  const withPacks = (children: ReactNode) =>
    options.packs ? (
      <PackHostProvider value={options.packs}>{children}</PackHostProvider>
    ) : (
      children
    );
  const router = await renderRouter({
    _layout: () => (
      <GestureHandlerRootView style={{ flex: 1 }}>
        <AISettingsProvider store={aiSettings}>
          <WorkspaceProvider value={{ store, repo, files, registry, locale }}>
            <ShareListener files={files} />
            <HomeScreenProvider value={options.homeScreen ?? null}>
              {withPacks(
                <WidgetProvider value={options.widgets ?? null}>
                  {options.toolDownloads ? (
                    <ToolDownloadsProvider value={options.toolDownloads}>
                      <Stack />
                      <DraftChatSheet />
                    </ToolDownloadsProvider>
                  ) : (
                    <>
                      <Stack />
                      <DraftChatSheet />
                    </>
                  )}
                  <HomeScreenBridge platform={options.homeScreen ?? null} />
                  <WidgetBridge platform={options.widgets ?? null} />
                </WidgetProvider>,
              )}
            </HomeScreenProvider>
          </WorkspaceProvider>
        </AISettingsProvider>
      </GestureHandlerRootView>
    ),
    index: HomeRoute,
    open: OpenRoute,
    change: ChangeRoute,
    'page/[pageId]': PageRoute,
    'run/[workflowId]': RunRoute,
    'reminder/[workflowId]': ReminderRoute,
    workflows: WorkflowsRoute,
    'quick-actions/index': QuickActionsRoute,
    'quick-actions/[kind]': QuickActionCategoryRoute,
    'workflow/[id]': WorkflowRoute,
    share: ShareRoute,
    'file-preview': FilePreviewRoute,
    'desk/[deskId]': DeskRoute,
    storage: StorageRoute,
    files: FilesRoute,
    presets: PresetsRoute,
    language: LanguageRoute,
    'ready/[workflowId]': ReadyRoute,
    data: DataRoute,
    'data-table/[tableId]': DataTableRoute,
    'data-backup': DataBackupRoute,
    'data-deleted': DataDeletedRoute,
    'data-unused': DataUnusedRoute,
    'data-more': DataMoreRoute,
    'select-records': SelectRecordsRoute,
    'pick-records': PickRecordsRoute,
    'import-records': ImportRecordsRoute,
    'record/[collectionId]': RecordRoute,
    'new-table': NewTableRoute,
    'app/[appId]': OpenAppRoute,
    welcome: WelcomeRoute,
  });
  return { repo, store, files, router };
}

/** System confirmation dialog: directly taps the non-cancel button (e.g., "Apply changes"). */
export function acceptNextAlert() {
  jest.spyOn(Alert, 'alert').mockImplementationOnce((_title, _message, buttons) => {
    buttons?.find((b) => b.style !== 'cancel')?.onPress?.();
  });
}

/** Home screen "Open files" icon button (D-449): prompts whether to select from photo library or Files, here auto-selecting one for the user. */
export async function openPick(from: 'media' | 'files') {
  jest.spyOn(Alert, 'alert').mockImplementationOnce((_title, _message, buttons) => {
    buttons?.[from === 'media' ? 0 : 1]?.onPress?.();
  });
  await fireEvent.press(await screen.findByTestId('file-pick-open'));
}
