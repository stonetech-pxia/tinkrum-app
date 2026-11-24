import {
  DESK_KINDS,
  pageIdOf,
  quickActionsOf,
  type DeskKind,
  type Locale,
  type NavTarget,
  type PlanAbout,
  type WorkspaceConfig,
} from '@morph/core';
import { useRouter } from 'expo-router';
import { Pressable } from 'react-native';

import { useDraftUi } from '../draft/ui';
import { LivelyTink } from '../guide/LivelyTink';
import { t } from '../i18n';
import { Icon } from '../renderer/Icon';
import type { Palette } from '../renderer/theme';
import { useWorkspace, useWorkspaceContext } from '../workspace/context';

// AI entry point in the top right corner of the page (D-406): present on all pages except Settings
// (including its subpages), Change History, and the AI page itself. Entering the AI page from here
// defaults "this page" to refer to this page (PlanAbout, ID only, no records or file names,
// invariants 1 and 2). Entering from elsewhere (navigation bar, "Modify this app" in settings)
// carries no page context.

/** Route parameters when opening the AI page; ChangeScreen reads them back using aboutFromParams. */
export function aboutParams(about: PlanAbout): Record<string, string> {
  switch (about.kind) {
    case 'page':
      return { page: about.pageId };
    case 'table':
      return { table: about.tableId };
    case 'screen':
      return { screen: about.screen };
    case 'desk':
      return { desk: about.fileKind };
    case 'workflow':
      return { workflow: about.workflowId };
    default:
      return {};
  }
}

export function aboutFromParams(
  params: { page?: string; table?: string; screen?: string; desk?: string },
  config: WorkspaceConfig,
): PlanAbout | undefined {
  if (params.page && config.containers.pages.some((p) => p.id === params.page))
    return { kind: 'page', pageId: params.page };
  if (params.table && config.data.tables.some((c) => c.id === params.table))
    return { kind: 'table', tableId: params.table };
  if (params.screen === 'tools' || params.screen === 'quickActions')
    return { kind: 'screen', screen: params.screen };
  if (params.desk && (DESK_KINDS as readonly string[]).includes(params.desk))
    return { kind: 'desk', fileKind: params.desk as DeskKind };
  return undefined;
}

/** Tooltip on the AI page and draft chat box indicating "which page is currently being modified"; quick actions and inbox pages have their own terminology. */
export function aboutPlace(
  about: PlanAbout | undefined,
  config: WorkspaceConfig | null,
  locale: Locale,
): { title: string; hint: string } | null {
  if (!about || !config) return null;
  switch (about.kind) {
    case 'page': {
      const name = config.containers.pages.find((p) => p.id === about.pageId)?.title;
      return name === undefined
        ? null
        : { title: t(locale, 'aboutPage', { name }), hint: t(locale, 'aboutPageHint') };
    }
    case 'table': {
      const name = config.data.tables.find((c) => c.id === about.tableId)?.name;
      return name === undefined
        ? null
        : { title: t(locale, 'aboutTable', { name }), hint: t(locale, 'aboutTableHint') };
    }
    case 'screen':
      return about.screen === 'tools'
        ? { title: t(locale, 'aboutToolsScreen'), hint: t(locale, 'aboutToolsScreenHint') }
        : {
            title: t(locale, 'aboutQuickActionsScreen'),
            hint: t(locale, 'aboutQuickActionsScreenHint'),
          };
    case 'desk':
      return { title: t(locale, 'aboutDesk'), hint: t(locale, 'aboutDeskHint') };
    default:
      return null;
  }
}

/** What entry context this page carries in the shell; null = no entry point (settings, change history). */
export function shellAbout(target: NavTarget): PlanAbout | null {
  const pageId = pageIdOf(target);
  if (pageId !== null) return { kind: 'page', pageId };
  if (target === 'tools' || target === 'quickActions') return { kind: 'screen', screen: target };
  return null;
}

/** The AI only sees quick actions in the config; built-in ones not yet modified (D-236) are counted on the quick actions page. */
export function workflowAbout(config: WorkspaceConfig, workflowId: string): PlanAbout {
  return quickActionsOf(config).some((w) => w.id === workflowId)
    ? { kind: 'workflow', workflowId }
    : { kind: 'screen', screen: 'quickActions' };
}

/**
 * Top-right entry point: opens chat box in draft mode (same as D-190), or AI page otherwise.
 * During guidance (D-447), the shell passes `onPress` and `lively`: Tink animates and tapping it
 * opens the guide prompt.
 */
export function AIEntry({
  about,
  palette,
  lively,
  onPress,
}: {
  about: PlanAbout;
  palette: Palette;
  lively?: boolean;
  onPress?: () => void;
}) {
  const { locale } = useWorkspaceContext();
  const router = useRouter();
  const inDraft = useWorkspace((s) => !!s.draft?.open);
  const setChatOpen = useDraftUi((s) => s.setChatOpen);
  // Tink's speech bubble remains expanded in draft preview (D-526) with animation and a halo; it shrinks to three dots, closes the chat box, and stops animating when exiting the draft.
  const lastStep = useWorkspace((s) =>
    s.draft?.open ? s.draft.steps.at(-1)?.changeRequestId : undefined,
  );
  const seenStep = useDraftUi((s) => s.seenStep);
  const chatOpen = useDraftUi((s) => s.chatOpen);
  const draftLively = lastStep !== undefined && seenStep !== lastStep && !chatOpen;
  return (
    <AIEntryButton
      palette={palette}
      locale={locale}
      lively={lively || draftLively}
      onPress={() =>
        onPress
          ? onPress()
          : inDraft
            ? setChatOpen(true, about)
            : router.push({ pathname: '/change', params: aboutParams(about) })
      }
    />
  );
}

/** Appearance of the entry point; inbox pages must preserve shared files before opening the AI, passing their own onPress. */
export function AIEntryButton({
  palette,
  locale,
  onPress,
  lively,
}: {
  palette: Palette;
  locale: Locale;
  onPress: () => void;
  lively?: boolean;
}) {
  return (
    <Pressable
      testID="page-ai"
      accessibilityRole="button"
      accessibilityLabel={t(locale, 'aboutEntryLabel')}
      hitSlop={10}
      onPress={onPress}>
      {lively ? (
        <LivelyTink size={24} color={palette.primaryText} halo={palette.primary} />
      ) : (
        <Icon name="tink" size={24} color={palette.primaryText} />
      )}
    </Pressable>
  );
}

// headerRight for the navigation bar.
export function entryOption(about: PlanAbout, palette: Palette) {
  return function HeaderEntry() {
    return <AIEntry about={about} palette={palette} />;
  };
}
export const quickActionsEntry = (palette: Palette) =>
  entryOption({ kind: 'screen', screen: 'quickActions' }, palette);
export const tableEntry = (tableId: string, palette: Palette) =>
  entryOption({ kind: 'table', tableId }, palette);
export const workflowEntry = (config: WorkspaceConfig, workflowId: string, palette: Palette) =>
  entryOption(workflowAbout(config, workflowId), palette);
