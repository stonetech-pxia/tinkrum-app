import { Stack, useLocalSearchParams } from 'expo-router';
import { Text, View } from 'react-native';

import { t } from '@/i18n';
import { usePalette } from '@/renderer/theme';
import { tableEntry } from '@/shell/ai-entry';
import { TableReadyScreen } from '@/shell/TableReadyScreen';
import { useWorkspace, useWorkspaceContext, useAppTheme } from '@/workspace/context';
import { readyNotes } from '@/draft/useApplyDraft';

/** Data table created by AI (D-191). When opened after being reverted, explain that it no longer exists. */
export default function TableReadyRoute() {
  const { collectionId, notes } = useLocalSearchParams<{ collectionId: string; notes?: string }>();
  const { locale } = useWorkspaceContext();
  const config = useWorkspace((s) => s.config)!;
  const palette = usePalette(useAppTheme(config));
  const collection = config.data.tables.find((c) => c.id === collectionId);
  if (!collection) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={[palette.font('body', 15), { color: palette.muted }]}>
          {t(locale, 'toolMissing')}
        </Text>
      </View>
    );
  }
  return (
    <>
      <Stack.Screen options={{ headerRight: tableEntry(collection.id, palette) }} />
      <TableReadyScreen collection={collection} notes={readyNotes(notes)} />
    </>
  );
}
