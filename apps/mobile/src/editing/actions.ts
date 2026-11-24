import { allComponents, componentLabel, type Op, type Page } from '@morph/core';
import { Alert } from 'react-native';

import { t } from '../i18n';
import { useWorkspace, useWorkspaceContext } from '../workspace/context';

// Direct editing (D-052–D-054): every action on the interface is translated into semantic
// modification operations, validated first and added to the edit mode draft; upon tapping "Done",
// the entire draft goes through the same protocol as AI (`proposeOps` -> `confirm`), generating a
// version with source `user`, with an undoable banner.

export function useEditActions(page: Page) {
  const { registry, locale } = useWorkspaceContext();
  const config = useWorkspace((s) => s.editing?.config ?? s.config)!;
  const draftOps = useWorkspace((s) => s.editing?.ops.length ?? 0);
  const editOps = useWorkspace((s) => s.editOps);
  const finishEditing = useWorkspace((s) => s.finishEditing);
  const cancelEditing = useWorkspace((s) => s.cancelEditing);

  const label = (componentId: string) => {
    const c = allComponents(page).find((x) => x.id === componentId);
    return c ? componentLabel(c, config, { registry, locale, now: new Date() }) : componentId;
  };

  const blocked = (issues: string[]) => Alert.alert(t(locale, 'invalidPlan'), issues.join('\n'));

  /** Adds an operation to the draft; shows the reason for failure and leaves the draft unchanged if validation fails. */
  function edit(ops: Op[]): boolean {
    const result = editOps(ops);
    if (result.ok) return true;
    if ('full' in result) Alert.alert(t(locale, 'tooManyEdits'));
    else blocked(result.issues);
    return false;
  }

  async function finish() {
    const result = await finishEditing(
      t(locale, 'editPageSummary', { page: page.title, count: draftOps }),
    );
    if (!result.ok && 'issues' in result) blocked(result.issues);
  }

  function cancel() {
    if (draftOps === 0) {
      cancelEditing();
      return;
    }
    Alert.alert(t(locale, 'discardEditTitle'), t(locale, 'discardEditMessage'), [
      { text: t(locale, 'keepEditing'), style: 'cancel' },
      { text: t(locale, 'discard'), style: 'destructive', onPress: cancelEditing },
    ]);
  }

  return { edit, finish, cancel, label };
}
