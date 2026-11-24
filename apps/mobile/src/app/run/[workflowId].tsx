import { builtinText, findWorkflow, handedInput, localize, quickActionsOf } from '@morph/core';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';

import { t } from '@/i18n';
import { usePalette } from '@/renderer/theme';
import { dropHanded, readHanded } from '@/run/handed';
import { RunScreen } from '@/run/RunScreen';
import { useIncoming } from '@/share/incoming';
import { useToolDownloads } from '@/tool-download/context';
import { toolRevoked } from '@/tool-download/state';
import { useWorkspace, useWorkspaceContext, useAppTheme } from '@/workspace/context';

/** Run a workflow (single-function workflow on tools page, built-in preset, or user's own workflow). */
export default function RunRoute() {
  const {
    workflowId,
    shared,
    handed: handedKey,
    keep,
    then,
  } = useLocalSearchParams<{
    workflowId: string;
    shared?: string;
    handed?: string;
    keep?: string;
    then?: string;
  }>();
  // Coming from the record page or list (D-428): values passed by them. Key is valid only for this open, values do not enter route parameters.
  const [handed] = useState(() => readHanded(handedKey));
  useEffect(() => () => dropHanded(handedKey), [handedKey]);
  // Coming from the inbox (D-115): use the batch of files shared in as input for the first step.
  const [incoming] = useState(() => {
    const share = useIncoming.getState().share;
    return shared && share && String(share.id) === shared ? share : null;
  });
  const { locale, registry } = useWorkspaceContext();
  const config = useWorkspace((s) => s.config)!;
  const palette = usePalette(useAppTheme(config));
  const router = useRouter();
  const workflow = findWorkflow(quickActionsOf(config), workflowId, locale);
  // Downloaded tool has been disabled (D-178): its quick actions cannot run, but config and files are kept.
  const revoked = useToolDownloads(
    (s) => workflow?.package !== undefined && toolRevoked(s, workflow.package),
  );
  if (workflow && revoked) {
    const name = localize(registry.tools.get(workflow.package!)?.name, locale) ?? workflow.package!;
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <Stack.Screen options={{ title: builtinText(workflow.name, locale, registry) }} />
        <Text
          testID="run-revoked"
          style={[palette.font('body', 15), { color: palette.muted, textAlign: 'center' }]}>
          {t(locale, 'toolRevokedRun', { name })}
        </Text>
      </View>
    );
  }
  // Quick actions requiring container-passed values (D-428): when arriving here from the quick action list, home screen, or reminders without a value, explain it and do not run.
  if (workflow && !handed && handedInput(workflow.steps, registry)) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <Stack.Screen options={{ title: builtinText(workflow.name, locale, registry) }} />
        <Text
          testID="run-needs-record"
          style={[palette.font('body', 15), { color: palette.muted, textAlign: 'center' }]}>
          {t(locale, 'runError_needsRecord')}
        </Text>
      </View>
    );
  }
  if (!workflow || (shared && !incoming)) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={[palette.font('body', 15), { color: palette.muted }]}>
          {t(locale, workflow ? 'shareGone' : 'toolMissing')}
        </Text>
      </View>
    );
  }
  return (
    <>
      <Stack.Screen options={{ title: builtinText(workflow.name, locale, registry) }} />
      <RunScreen
        workflow={workflow}
        {...(incoming ? { incoming } : {})}
        {...(keep === '1' ? { keepIncoming: true } : {})}
        {...(then === 'desk' ? { thenDesk: true } : {})}
        {...(handed ? { handed } : {})}
        onEdit={() => router.push({ pathname: '/workflow/[id]', params: { id: workflow.id } })}
        // AI only sees quick actions in the config; built-in ones must first be modified once in the editor page (D-236).
        {...(quickActionsOf(config).some((w) => w.id === workflow.id)
          ? {
              onAskAI: () =>
                router.push({ pathname: '/change', params: { workflow: workflow.id } }),
            }
          : {})}
      />
    </>
  );
}
