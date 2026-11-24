import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { RenderEnv } from '@/renderer/components';
import { usePalette } from '@/renderer/theme';
import { HistoryView } from '@/shell/HistoryView';
import { useShellEnv } from '@/shell/Shell';
import { Toast } from '@/shell/Toast';
import { useWorkspace, useWorkspaceContext, useAppTheme } from '@/workspace/context';
import { shownConfig } from '@/workspace/store';

/**
 * 'Settings -> Change History': a standalone page like other settings pages, returning goes back
 * to settings. Returning to previous versions also returns to settings: the undo banner is on the
 * shell.
 */
export default function HistoryRoute() {
  const { registry, locale } = useWorkspaceContext();
  const config = useWorkspace(shownConfig)!;
  const palette = usePalette(useAppTheme(config));
  const { navigate, locked } = useShellEnv();
  const router = useRouter();
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
      <HistoryView env={env} onRestored={() => router.back()} />
      <Toast palette={palette} bottom={insets.bottom + 16} />
    </>
  );
}
