import type { Workflow } from '@morph/core';
import { Alert, StyleSheet, Text } from 'react-native';

import { t } from '../i18n';
import type { Palette } from '../renderer/theme';
import { Button, Card } from '../renderer/ui';
import { useWorkspace, useWorkspaceContext } from '../workspace/context';
import { useHomeScreenPlatform } from './context';
import { iosSymbolName } from '../renderer/Icon';

/**
 * How to use quick actions placed on the desktop (D-271): iOS only allows long-pressing the Morph
 * icon; Android additionally allows placing a separate icon on the desktop, where the system pops
 * up a confirmation dialog, so requests are made only after the user taps "Add to desktop", never
 * automatically popping up during app modifications.
 */
export function HomeScreenCard({ workflow, palette }: { workflow: Workflow; palette: Palette }) {
  const { locale } = useWorkspaceContext();
  const platform = useHomeScreenPlatform();
  const onHomeScreen = useWorkspace(
    (s) => s.config?.nav.phoneHomeScreen?.includes(workflow.id) ?? false,
  );
  if (!onHomeScreen) return null;
  const canPin = platform?.canPin() ?? false;

  async function pin() {
    const symbol = workflow.icon ? iosSymbolName(workflow.icon) : undefined;
    const sent = await platform!
      .pin({ id: workflow.id, title: workflow.name, ...(symbol ? { symbol } : {}) })
      .catch(() => false);
    if (!sent) Alert.alert(t(locale, 'homeScreenPinFailed'));
  }

  return (
    <Card palette={palette}>
      <Text style={[palette.font('title', 15), { color: palette.text }]}>
        {t(locale, 'homeScreenTitle')}
      </Text>
      <Text
        testID="home-screen-how"
        style={[palette.font('body', 14), styles.body, { color: palette.muted }]}>
        {t(locale, canPin ? 'homeScreenAndroid' : 'homeScreenIos', { name: workflow.name })}
      </Text>
      {canPin ? (
        <Button
          palette={palette}
          testID="home-screen-pin"
          variant="outline"
          label={t(locale, 'homeScreenPin')}
          onPress={() => void pin()}
        />
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  body: { lineHeight: 20 },
});
