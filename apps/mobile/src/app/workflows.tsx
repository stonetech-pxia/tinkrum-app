import { Stack } from 'expo-router';

import { usePalette } from '@/renderer/theme';
import { quickActionsEntry } from '@/shell/ai-entry';
import { WorkflowsScreen } from '@/shell/WorkflowsScreen';
import { useWorkspaceContext, useAppTheme } from '@/workspace/context';

/** Legacy /workflows route compatibility entry: display file type categories. Provided by core, AI cannot modify this page. */
export default function WorkflowsRoute() {
  const { locale, registry } = useWorkspaceContext();
  const theme = useAppTheme();
  const palette = usePalette(theme);
  return (
    <>
      <Stack.Screen options={{ headerRight: quickActionsEntry(palette) }} />
      <WorkflowsScreen palette={palette} locale={locale} registry={registry} />
    </>
  );
}
