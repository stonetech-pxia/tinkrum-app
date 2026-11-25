import {
  appFileOfApp,
  appFileText,
  appResetOps,
  appTarget,
  homeScreenFull,
  homeScreenOp,
  type AppFile,
  type IconValue,
} from '@morph/core';
import { useState, type ReactNode } from 'react';
import { Alert } from 'react-native';

import { loadAppOrigin } from '../apps/origin';
import { useHomeScreenPlatform } from '../home-screen/context';
import { homeScreenEntries } from '../home-screen/useHomeScreen';
import { t } from '../i18n';
import type { RenderEnv } from '../renderer/components';
import { confirmDelete, useWorkflowChange } from '../run/workflow-change';
import { useWorkspace, useWorkspaceContext } from '../workspace/context';
import { AppIconPicker, AppMenuRow, AppMenuSheet } from './AppMenu';

/**
 * The menu of an app, opened by long-pressing it in Settings or in the app list (D-648):
 * put it on the phone's home screen or take it off, change its icon (D-606), share it (D-545),
 * restore it (D-485), delete it (D-650). System layer, cannot be modified by AI
 * (invariant 8). Opening it changes nothing (invariant 15). Render `appMenu` somewhere on the
 * page that opens it.
 */
export function useAppMenu(env: RenderEnv): {
  openAppMenu: (appId: string) => void;
  appMenu: ReactNode;
} {
  const { palette, locale } = env;
  // picking: currently selecting an icon in the menu.
  const [menu, setMenu] = useState<{
    appId: string;
    origin: AppFile | null;
    picking: boolean;
  } | null>(null);
  const change = useWorkflowChange();
  const homeScreen = useHomeScreenPlatform();
  const { repo, registry, files, store } = useWorkspaceContext();
  const proposeOps = useWorkspace((s) => s.proposeOps);
  const confirm = useWorkspace((s) => s.confirm);
  const cancel = useWorkspace((s) => s.cancel);

  /** Restore this App to its initial state (D-485): preview first, take effect upon confirmation, can be undone in change history; records remain completely untouched. */
  async function restoreApp(appId: string, name: string, origin: AppFile) {
    const plan = appResetOps(origin, env.config, registry);
    if (!plan.ok) {
      Alert.alert(t(locale, 'appResetItem'), t(locale, 'importAppClash', { reason: plan.error }));
      return;
    }
    const result = await proposeOps(plan.ops, t(locale, 'appResetSummary', { name }), {
      fromAppFile: true,
    });
    if (result.kind !== 'preview') {
      Alert.alert(
        t(locale, 'invalidPlan'),
        result.kind === 'invalid' ? result.issues.join('\n') : result.message,
      );
      return;
    }
    Alert.alert(
      name,
      [t(locale, 'appResetConfirm', { name }), ...result.proposal.lines].join('\n'),
      [
        { text: t(locale, 'cancel'), style: 'cancel', onPress: () => void cancel() },
        { text: t(locale, 'presetApply'), onPress: () => void confirm() },
      ],
    );
  }

  async function openAppMenu(appId: string) {
    // Only Apps imported from files have an initial state; those created by Tink or oneself do not, so this item is not displayed.
    setMenu({ appId, origin: await loadAppOrigin(repo, appId), picking: false });
  }

  /** Items in the menu: tap to collapse the menu first before performing the action. */
  function appMenuItems(appId: string, name: string, origin: AppFile | null) {
    const id = appTarget(appId);
    const onHome = (env.config.nav.phoneHomeScreen ?? []).includes(id);
    // Android: place an individual icon on the home screen displaying this App's own icon (D-606). The system prompts a confirmation dialog, and the user decides.
    const pin = () => {
      const entry = homeScreenEntries(store.getState().config!).find((e) => e.id === id);
      if (entry)
        void homeScreen?.pin(entry).then((sent) => {
          if (!sent) Alert.alert(t(locale, 'homeScreenPinFailed'));
        });
    };
    // Into the Tinkrum icon's menu on the phone, or out of it. Where the phone can, putting it
    // there goes straight on to its own icon (D-648).
    const toggle = async () => {
      if (!onHome && homeScreenFull(env.config)) {
        Alert.alert(t(locale, 'homeScreenFull'));
        return;
      }
      const done = await change(
        [homeScreenOp(env.config, id, !onHome)],
        t(locale, onHome ? 'homeScreenRemoved' : 'homeScreenAdded', { name }),
      );
      if (done && !onHome && homeScreen?.canPin()) pin();
    };
    // Share this App (D-545): structure only, user file references are cleared; sent only after the user explicitly taps it (Invariants 3, 10, 14).
    const share = () => {
      const file = appFileOfApp(env.config, appId);
      if (file)
        void files.shareText(
          `tinkrum-app-${appId}.json`,
          appFileText(file, new Date()),
          'application/json',
        );
    };
    return [
      {
        id: 'home',
        label: t(locale, onHome ? 'homeScreenRemove' : 'homeScreenAdd'),
        run: () => void toggle(),
      },
      ...(onHome && homeScreen?.canPin()
        ? [{ id: 'pin', label: t(locale, 'homeScreenPin'), run: pin }]
        : []),
      // This item does not collapse the menu: the menu switches to an icon selection grid.
      {
        id: 'icon',
        label: t(locale, 'appIconItem'),
        run: () => setMenu({ appId, origin, picking: true }),
      },
      { id: 'share', label: t(locale, 'shareAppItem'), run: share },
      ...(origin
        ? [
            {
              id: 'reset',
              label: t(locale, 'appResetItem'),
              run: () => void restoreApp(appId, name, origin),
            },
          ]
        : []),
      { id: 'delete', label: t(locale, 'appDeleteItem'), run: () => deleteApp(appId, name) },
    ];
  }

  /** Change icon (D-606): what the user taps is confirmation, taking effect immediately, and can be undone in change history. */
  function pickIcon(appId: string, name: string, icon: IconValue) {
    setMenu(null);
    void change(
      [{ op: 'updateContainer', app: { id: appId, icon } }],
      t(locale, 'appIconChanged', { name }),
    );
  }

  /**
   * Delete the app (D-650): asks first; its pages, quick actions and reminders go, its
   * tables and entries stay on the home page (invariant 5). Can be undone, like any change.
   */
  function deleteApp(appId: string, name: string) {
    confirmDelete(
      locale,
      name,
      () =>
        void change(
          [{ op: 'removeContainer', app: appId }],
          t(locale, 'appDeletedSummary', { name }),
        ),
      t(locale, 'appDeleteConfirm'),
    );
  }

  const menuApp = menu ? (env.config.nav.apps ?? []).find((a) => a.id === menu.appId) : undefined;
  const appMenu =
    menu && menuApp ? (
      <AppMenuSheet
        palette={palette}
        locale={locale}
        title={menuApp.name}
        onClose={() => setMenu(null)}>
        {menu.picking ? (
          <AppIconPicker
            palette={palette}
            locale={locale}
            current={menuApp.icon ?? 'apps'}
            onPick={(icon) => pickIcon(menuApp.id, menuApp.name, icon)}
          />
        ) : (
          appMenuItems(menuApp.id, menuApp.name, menu.origin).map((item) => (
            <AppMenuRow
              key={item.id}
              id={`app-menu-${item.id}`}
              label={item.label}
              palette={palette}
              danger={item.id === 'delete'}
              onPress={() => {
                setMenu(null);
                item.run();
              }}
            />
          ))
        )}
      </AppMenuSheet>
    ) : null;

  return { openAppMenu: (appId) => void openAppMenu(appId), appMenu };
}
