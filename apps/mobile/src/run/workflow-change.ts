import type { Op } from '@morph/core';
import { Alert } from 'react-native';

import { t } from '../i18n';
import { useWorkspace, useWorkspaceContext } from '../workspace/context';

// Modifications to workflow and edit pages: follows the same protocol as AI (proposeOps → confirm),
// generating a version with source set to user each time, with an undoable banner (D-082). User
// taps in the interface directly confirm, so the preview dialog is skipped.

export function useWorkflowChange() {
  const { locale } = useWorkspaceContext();
  const proposeOps = useWorkspace((s) => s.proposeOps);
  const confirm = useWorkspace((s) => s.confirm);
  const cancel = useWorkspace((s) => s.cancel);

  return async function change(ops: Op[], summary: string): Promise<boolean> {
    const result = await proposeOps(ops, summary);
    if (result.kind !== 'preview') {
      Alert.alert(
        t(locale, 'invalidPlan'),
        result.kind === 'invalid' ? result.issues.join('\n') : result.message,
      );
      await cancel();
      return false;
    }
    return confirm();
  };
}

/** Confirm before deleting; `message` says what stays when it is more than the files. */
export function confirmDelete(
  locale: 'en' | 'zh' | 'fr',
  name: string,
  onDelete: () => void,
  message = t(locale, 'workflow_change_Your_files_are_kept_You_can_undo_this_e9492'),
): void {
  Alert.alert(t(locale, 'workflow_change_Delete_e4208', { v0: name }), message, [
    { text: t(locale, 'cancel'), style: 'cancel' },
    { text: t(locale, 'workflow_change_Delete_8940a'), style: 'destructive', onPress: onDelete },
  ]);
}
