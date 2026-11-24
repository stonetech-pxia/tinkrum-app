import { Stack } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { RenderEnv } from '@/renderer/components';
import { usePalette } from '@/renderer/theme';
import { entryOption } from '@/shell/ai-entry';
import { BannerAnchor } from '@/shell/Banner';
import { useShellEnv } from '@/shell/Shell';
import { Toast } from '@/shell/Toast';
import { ToolsView } from '@/shell/ToolsView';
import { useWorkspace, useWorkspaceContext, useAppTheme } from '@/workspace/context';
import { shownConfig } from '@/workspace/store';

/** Tool page opened from settings or page entry points (when not in navigation bar): standalone page, going back returns to previous location. */
export default function ToolsRoute() {
  const { registry, locale } = useWorkspaceContext();
  const config = useWorkspace(shownConfig)!;
  const palette = usePalette(useAppTheme(config));
  const { navigate, locked } = useShellEnv();
  const insets = useSafeAreaInsets();
  const env: RenderEnv = {
    config,
    palette,
    locale,
    registry,
    interactive: true,
    navigate,
    ...(locked ? { locked } : {}),
  };
  return (
    <>
      <Stack.Screen
        options={{ headerRight: entryOption({ kind: 'screen', screen: 'tools' }, palette) }}
      />
      <BannerAnchor palette={palette} />
      <ToolsView env={env} />
      <Toast palette={palette} bottom={insets.bottom + 16} />
    </>
  );
}
