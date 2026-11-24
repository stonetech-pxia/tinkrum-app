import {
  calendarOf,
  runsInline,
  type HandedFiles,
  type RunValue,
  type Workflow,
} from '@morph/core';
import { useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { Alert } from 'react-native';

import { useRunHost } from '../desk/useRunHost';
import { runErrorText } from '../i18n';
import type { Palette } from '../renderer/theme';
import { newAssetId, startRun, type Run } from '../runtime/runner';
import { useWorkspace, useWorkspaceContext } from '../workspace/context';
import { handOver } from './handed';

// Tools on a container (D-428): runs only when the user taps a button, passing container values to
// the first step. A single value, a record, or final output directed outside the app (making a
// call, sharing a vCard) runs in place without a results page; other operations open a run page
// (with progress and results). Entering the page runs nothing (invariants 15, 16).

export function useHandedRun(palette: Palette) {
  const { repo, files, registry, locale } = useWorkspaceContext();
  const config = useWorkspace((s) => s.config!);
  const revisionId = useWorkspace((s) => s.head!.id);
  const bumpAssets = useWorkspace((s) => s.bumpAssets);
  const bumpRecords = useWorkspace((s) => s.bumpRecords);
  const host = useRunHost(palette, locale);
  const router = useRouter();
  const running = useRef(false);
  // The share panel might still be using the file: deleted only upon the next run or when leaving the page.
  const last = useRef<Run | null>(null);
  useEffect(
    () => () => {
      void last.current?.dispose();
    },
    [],
  );

  async function run(workflow: Workflow, value: RunValue | HandedFiles) {
    if (!runsInline(workflow, value)) {
      router.push({
        pathname: '/run/[workflowId]',
        params: { workflowId: workflow.id, handed: handOver(value) },
      });
      return;
    }
    if (running.current) return;
    running.current = true;
    try {
      await last.current?.dispose();
      last.current = null;
      const started = await startRun({
        workflow,
        revisionId,
        repo,
        files,
        registry,
        locale,
        now: () => new Date(),
        newId: newAssetId,
        ui: host.ui,
        collections: config.data.tables,
        calendar: calendarOf(config),
        packs: host.packs ?? null,
        ...(host.askParams ? { askParams: host.askParams } : {}),
        ...(host.ensurePack ? { ensurePack: host.ensurePack } : {}),
        ...(host.ensurePacks ? { ensurePacks: host.ensurePacks } : {}),
        handed: value,
      });
      last.current = started;
      const { result } = started;
      if (result.status === 'failed')
        Alert.alert(runErrorText(locale, result.error.code, result.error.detail));
      if (result.status === 'succeeded' && result.saved.length > 0) bumpAssets();
      if (workflow.steps.some((s) => s.action === 'out.addRecord')) bumpRecords();
    } finally {
      running.current = false;
    }
  }

  return { run, elements: host.elements };
}
