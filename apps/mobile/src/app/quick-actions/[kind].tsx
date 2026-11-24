import { localize, t, QUICK_ACTION_CATEGORIES, isQuickActionKind } from '@morph/core';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';
import { Text, View } from 'react-native';
import { usePalette } from '@/renderer/theme';
import { releaseShare } from '@/share/incoming';
import { quickActionsEntry } from '@/shell/ai-entry';
import { WorkflowsScreen } from '@/shell/WorkflowsScreen';
import { useWorkspaceContext, useAppTheme } from '@/workspace/context';

export default function QuickActionCategoryRoute() {
  const { locale, registry, files } = useWorkspaceContext();
  const palette = usePalette(useAppTheme());
  const { kind, shared } = useLocalSearchParams<{ kind: string; shared?: string }>();
  const valid = isQuickActionKind(kind);
  // Incorrect category in link: page cannot use incoming files, released anyway (category page not mounted, its own cleanup does not run).
  useEffect(() => {
    if (!valid && shared) void releaseShare(files, Number(shared));
  }, [valid, shared, files]);
  if (!valid)
    return (
      <View style={{ flex: 1, padding: palette.pad, backgroundColor: palette.background }}>
        <Text style={[palette.font('body', 15), { color: palette.muted }]}>
          {t(locale, '_kind__Category_not_found_5faf2')}
        </Text>
      </View>
    );
  return (
    <>
      <Stack.Screen
        options={{
          title: localize(QUICK_ACTION_CATEGORIES[kind].name, locale),
          headerRight: quickActionsEntry(palette),
        }}
      />
      <WorkflowsScreen
        palette={palette}
        locale={locale}
        registry={registry}
        kind={kind}
        shared={shared}
      />
    </>
  );
}
