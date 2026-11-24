import {
  type AskedAnswer,
  dismissHabit,
  habitKey,
  habitLabel,
  type HabitRecord,
  habitWorkflow,
  hasSameWorkflow,
  homeEntryOps,
  newWorkflowId,
  quickActionsOf,
  recordHabit,
  rememberedAnswers,
  shouldSuggest,
  type Workflow,
} from '@morph/core';
import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { t } from '../i18n';
import type { Palette } from '../renderer/theme';
import { Card, Pill } from '../renderer/ui';
import type { WorkspaceRepo } from '../storage/types';
import { useWorkspace, useWorkspaceContext } from '../workspace/context';
import { useWorkflowChange } from './workflow-change';

// Suggest from usage habits (D-127): when the same value is repeatedly chosen across several runs
// in "ask at runtime", the results page prompts whether to make it a quick action on the home
// screen that doesn't require re-selection. Statistics are kept locally only (app_meta), never sent
// to the AI; changes occur only upon user tap and can be undone.

const metaKey = (workflowId: string) => `habit:${workflowId}`;

async function readHabit(repo: WorkspaceRepo, workflowId: string): Promise<HabitRecord | null> {
  try {
    const raw = await repo.getMeta(metaKey(workflowId));
    return raw ? (JSON.parse(raw) as HabitRecord) : null;
  } catch {
    return null;
  }
}

const writeHabit = (repo: WorkspaceRepo, workflowId: string, record: HabitRecord) =>
  repo.setMeta(metaKey(workflowId), JSON.stringify(record));

interface Suggestion {
  label: string;
  workflow: Workflow;
  record: HabitRecord;
}

/**
 * Called once after a successful run ends: records this response, showing suggestions when the
 * threshold is met. answers contains responses to each step's "ask at runtime" in this run.
 */
export function HabitCard({
  workflow,
  answers,
  palette,
}: {
  workflow: Workflow;
  answers: readonly AskedAnswer[];
  palette: Palette;
}) {
  const { repo, registry, locale } = useWorkspaceContext();
  const tools = useWorkspace((s) => s.config!.tools);
  const workflows = useMemo(() => quickActionsOf({ tools }), [tools]);
  const change = useWorkflowChange();
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [made, setMade] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      const remembered = rememberedAnswers(workflow, answers, registry);
      const record = recordHabit(
        await readHabit(repo, workflow.id),
        remembered ? habitKey(remembered) : null,
      );
      await writeHabit(repo, workflow.id, record);
      if (!remembered || !shouldSuggest(record) || !live) return;
      const label = habitLabel(workflow, remembered, registry, locale, new Date());
      const candidate = habitWorkflow(
        workflow,
        remembered,
        newWorkflowId(`${workflow.id}-habit`, workflows),
        `${workflow.name} · ${label}`,
      );
      if (hasSameWorkflow(workflows, candidate)) return;
      setSuggestion({ label, workflow: candidate, record });
    })();
    return () => {
      live = false;
    };
    // Result of each run is recorded only once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const config = useWorkspace((s) => s.config!);
  if (made) {
    return (
      <Text testID="habit-made" style={[palette.font('bodyMedium', 14), { color: palette.muted }]}>
        {t(locale, 'habitMade', { name: made })}
      </Text>
    );
  }
  if (!suggestion) return null;

  async function make() {
    const wf = suggestion!.workflow;
    const ok = await change(
      [{ op: 'addTool', tool: wf }, ...homeEntryOps(config, [wf.id])],
      t(locale, 'habitMade', { name: wf.name }),
    );
    if (ok) setMade(wf.name);
  }

  async function dismiss() {
    await writeHabit(repo, workflow.id, dismissHabit(suggestion!.record));
    setSuggestion(null);
  }

  return (
    <Card palette={palette} background={palette.primaryTint} testID="habit-card">
      <Text style={[palette.font('title', 16), { color: palette.text }]}>
        {t(locale, 'habitTitle', { value: suggestion.label })}
      </Text>
      <Text style={[palette.font('body', 14), { color: palette.text }]}>
        {t(locale, 'habitBody', { name: suggestion.workflow.name })}
      </Text>
      <View style={styles.actions}>
        <Pill
          palette={palette}
          testID="habit-make"
          label={t(locale, 'habitMake')}
          onPress={() => void make()}
        />
        <Pill
          palette={palette}
          testID="habit-no"
          label={t(locale, 'habitNo')}
          onPress={() => void dismiss()}
        />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 },
});
