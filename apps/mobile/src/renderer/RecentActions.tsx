import { builtinText, findWorkflowTarget, quickActionsOf, type Workflow } from '@morph/core';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useWorkspaceContext } from '../workspace/context';
import type { RenderEnv } from './components';
import { Icon } from './Icon';

/** Maximum count. */
const MAX = 4;

/**
 * Recently used quick actions (look library, source.recent, D-452): reads existing run logs
 * (tool_runs, successful ones, ordered from newest to oldest run), displayed as a row of small
 * capsules, tapping opens run page. Hidden entirely when none have been used. Read-only
 * (Invariant 15).
 */
export function RecentActions({ title, env }: { title: string | undefined; env: RenderEnv }) {
  const { repo } = useWorkspaceContext();
  const router = useRouter();
  const [ids, setIds] = useState<string[]>([]);
  const { palette, locale, registry } = env;

  // Re-read on returning to this page: visible immediately upon returning after running.
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      void repo.countSucceededRuns().then((runs) => {
        if (!alive) return;
        setIds([...runs.entries()].sort((a, b) => b[1].lastAt - a[1].lastAt).map(([id]) => id));
      });
      return () => {
        alive = false;
      };
    }, [repo]),
  );

  const flows: Workflow[] = [];
  for (const id of ids) {
    const flow = findWorkflowTarget(quickActionsOf(env.config), id, locale);
    if (flow && !flows.some((f) => f.id === flow.id))
      flows.push({ ...flow, name: builtinText(flow.name, locale, registry) });
    if (flows.length === MAX) break;
  }
  if (flows.length === 0) return null;

  return (
    <View style={styles.block} testID="recent-actions">
      {title ? (
        <Text style={[palette.font('bodyMedium', 14), { color: palette.caption }]}>{title}</Text>
      ) : null}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}>
        {flows.map((flow) => {
          const icon =
            flow.icon ?? (flow.package && registry.tools.get(flow.package)?.icon) ?? 'workflow';
          return (
            <Pressable
              key={flow.id}
              testID={`recent-${flow.id}`}
              accessibilityRole="button"
              disabled={!env.interactive}
              onPress={
                env.locked ??
                (() =>
                  router.push({ pathname: '/run/[workflowId]', params: { workflowId: flow.id } }))
              }
              onLongPress={env.onLongPress}
              style={({ pressed }) => [
                styles.chip,
                { backgroundColor: palette.surface, opacity: pressed ? 0.7 : 1 },
              ]}>
              <Icon name={icon} size={16} color={palette.primaryText} />
              <Text numberOfLines={1} style={[palette.font('body', 14), { color: palette.text }]}>
                {flow.name}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: 8 },
  // Title and small capsules outside the box: hugging page margins (D-454).
  row: { gap: 8 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
    maxWidth: 220,
  },
});
