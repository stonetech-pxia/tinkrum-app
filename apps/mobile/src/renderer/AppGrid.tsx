import { appTarget, type App, type BlockOf } from '@morph/core';

import { Pressable, StyleSheet, Text, View } from 'react-native';

import { HOLD_MS, LONG_PRESS_MS } from '../editing/entry';
import { setInnerGesture } from '../editing/useSingleDrag';
import { useAppMenu } from '../shell/useAppMenu';
import type { RenderEnv } from './components';
import { onPage, usePalette } from './theme';
import { IconTile } from './ui';

const COLUMNS = 4;

/**
 * The app list block (D-new-apphome-1): the user's apps as icons, four per row, like a phone's home
 * screen. Each icon takes its app's own primary color, as on the phone's home screen (D-606). A tap
 * opens the app; a long press opens its menu (D-new-apphome-5), from which it can go on the phone's
 * home screen. Long-pressing beside the icons edits the block, as for any block.
 */
export function AppGrid({ grid, env }: { grid: BlockOf<'apps'>; env: RenderEnv }) {
  const { palette } = env;
  const { openAppMenu, appMenu } = useAppMenu(env);
  const apps = env.config.nav.apps ?? [];
  if (apps.length === 0) return null;
  return (
    <View style={styles.block}>
      {appMenu}
      {grid.show?.title ? (
        <Text
          style={[
            palette.font('bodyBold', 12),
            { color: onPage(palette).caption, letterSpacing: 0.5 },
          ]}>
          {grid.show.title.toUpperCase()}
        </Text>
      ) : null}
      <View style={styles.grid}>
        {apps.map((app) => (
          <AppIcon key={app.id} app={app} env={env} onMenu={() => openAppMenu(app.id)} />
        ))}
      </View>
    </View>
  );
}

function AppIcon({ app, env, onMenu }: { app: App; env: RenderEnv; onMenu: () => void }) {
  const { palette } = env;
  const own = usePalette(app.theme);
  // The icon's long press comes before the page's long-press edit (D-235), as on tiles (D-311).
  // After the menu opens, this icon might not receive onPressOut.
  const hold = () => {
    onMenu();
    setTimeout(() => setInnerGesture(false), LONG_PRESS_MS);
  };
  return (
    <Pressable
      testID={`app-icon-${app.id}`}
      accessibilityRole="button"
      accessibilityLabel={app.name}
      onPress={env.interactive ? () => env.navigate(appTarget(app.id)) : undefined}
      onPressIn={env.interactive ? () => setInnerGesture(true) : undefined}
      onPressOut={() => setInnerGesture(false)}
      onLongPress={env.interactive ? (env.locked ?? hold) : undefined}
      delayLongPress={HOLD_MS}
      style={({ pressed }) => [styles.app, pressed && { opacity: 0.7 }]}>
      <IconTile
        palette={palette}
        icon={app.icon ?? 'apps'}
        size={60}
        background={own.primary}
        color={own.onPrimary}
      />
      <Text
        numberOfLines={2}
        style={[palette.font('bodyMedium', 12), styles.name, { color: onPage(palette).text }]}>
        {app.name}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // Room above and below, so the frame drawn around the block while editing clears icons and names.
  block: { gap: 10, paddingVertical: 8 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 18 },
  app: { width: `${100 / COLUMNS}%`, alignItems: 'center', gap: 8, paddingHorizontal: 2 },
  name: { textAlign: 'center' },
});
