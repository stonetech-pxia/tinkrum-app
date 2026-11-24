import type { Component } from '@morph/core';
import { Alert } from 'react-native';

import { t } from '../i18n';
import { useWorkspace, useWorkspaceContext } from '../workspace/context';
import { useWidgetPlatform } from './context';
import { useWidgetPlacement } from './placed';
import { onRecordPage, widgetName, widgetSupported } from './snapshot';

/**
 * Long-press widget "Add to Desktop" (D-325): placed only on user tap; AI cannot place it.
 * Android shows system confirmation dialog (if supported by launcher); iOS cannot place it for
 * the user, adds it to the "Edit Widget" list, and explains how to add it on the desktop.
 * Unsupported widgets explain which types can be placed.
 */
export function usePlaceWidget() {
  const { locale, registry } = useWorkspaceContext();
  const config = useWorkspace((s) => s.config);
  const platform = useWidgetPlatform();
  const placed = useWidgetPlacement((s) => s.placed);
  const isPlaced = (id: string) => placed?.some((p) => p.componentId === id) ?? false;

  async function toggle(component: Component) {
    const name = config ? widgetName(component, config, registry, locale) : component.id;
    const store = useWidgetPlacement.getState();
    if (isPlaced(component.id)) return store.remove(component.id);
    if (!widgetSupported(component)) {
      Alert.alert(t(locale, 'widgetUnsupportedTitle'), t(locale, 'widgetUnsupportedHelp'));
      return;
    }
    // D-342: This page opens tied to a specific record, but the desktop doesn't know which record to display.
    if (config && onRecordPage(component, config)) {
      Alert.alert(t(locale, 'widgetUnsupportedTitle'), t(locale, 'widgetRecordPageHelp'));
      return;
    }
    await store.add(component.id, Date.now());
    if (platform?.canPin()) {
      const sent = await platform.pin(component.id, name).catch(() => false);
      if (!sent) Alert.alert(t(locale, 'widgetPinFailed'));
    } else {
      Alert.alert(t(locale, 'widgetIosTitle'), t(locale, 'widgetIosHow', { name }));
    }
  }

  return { available: platform !== null, isPlaced, toggle };
}
