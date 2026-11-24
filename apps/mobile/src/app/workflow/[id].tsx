import { findWorkflow, quickActionsOf, t } from '@morph/core';
import { Stack, useLocalSearchParams } from 'expo-router';
import { Text, View } from 'react-native';

import { usePalette } from '@/renderer/theme';
import { WorkflowEditor } from '@/run/WorkflowEditor';
import { workflowEntry } from '@/shell/ai-entry';
import { useWorkspace, useWorkspaceContext, useAppTheme } from '@/workspace/context';

/** Edit a workflow (parameters, prompt on each run, steps). Saving generates an undoable version. */
export default function WorkflowRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { locale, registry } = useWorkspaceContext();
  const config = useWorkspace((s) => s.config)!;
  const palette = usePalette(useAppTheme(config));
  const workflow = findWorkflow(quickActionsOf(config), id, locale);
  if (!workflow) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={[palette.font('body', 15), { color: palette.muted }]}>
          {t(locale, '_id__This_quick_action_no_longer_exists_35f5a')}
        </Text>
      </View>
    );
  }
  return (
    <>
      <Stack.Screen
        options={{ title: workflow.name, headerRight: workflowEntry(config, workflow.id, palette) }}
      />
      {/* Rebuild draft when workflow changes (e.g., after duplication). */}
      <WorkflowEditor
        key={workflow.id}
        workflow={workflow}
        palette={palette}
        locale={locale}
        registry={registry}
      />
    </>
  );
}
