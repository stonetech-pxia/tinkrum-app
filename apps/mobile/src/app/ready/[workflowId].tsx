import { quickActionsOf } from '@morph/core';
import { Stack, useLocalSearchParams } from 'expo-router';
import { Text, View } from 'react-native';

import { readyNotes } from '@/draft/useApplyDraft';
import { t } from '@/i18n';
import { usePalette } from '@/renderer/theme';
import { workflowEntry } from '@/shell/ai-entry';
import { ReadyScreen } from '@/shell/ReadyScreen';
import { useWorkspace, useWorkspaceContext, useAppTheme } from '@/workspace/context';

/** AI-created quick action (D-125). Displays a notice when opened after being undone, stating it no longer exists. */
export default function ReadyRoute() {
  const { workflowId, notes } = useLocalSearchParams<{ workflowId: string; notes?: string }>();
  const { locale } = useWorkspaceContext();
  const config = useWorkspace((s) => s.config)!;
  const palette = usePalette(useAppTheme(config));
  const workflow = quickActionsOf(config).find((w) => w.id === workflowId);
  if (!workflow) {
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
      <Stack.Screen options={{ headerRight: workflowEntry(config, workflow.id, palette) }} />
      <ReadyScreen workflow={workflow} notes={readyNotes(notes)} />
    </>
  );
}
