import { pageTarget } from '@morph/core';
import { useRouter } from 'expo-router';

import { useSampleHint } from '../guide/SampleHint';
import { useWorkspace, useWorkspaceContext } from '../workspace/context';
import type { Applied } from '../workspace/store';

/**
 * Takes the user to the appropriate place after application (after a draft application or a
 * feature modification is applied directly, D-191): newly created quick action -> "done" page
 * (D-125); started from the inbox page -> return to the inbox page and run the new quick action
 * with the shared file (D-129); started from a quick action ("Let AI modify this") -> its "done"
 * page so it can be used again right away (D-126); placed an existing quick action on the phone's
 * home screen -> its "done" page explaining how to use it and that it can be added to the home
 * screen on Android (D-271); newly created data table -> the data table's "done" page, ready to
 * log an entry immediately; applied sample app (D-260) -> its main page with a prompt that AI can
 * be used to continue modifying it.
 */
export function useAfterApply(): (applied: Applied) => void {
  const router = useRouter();
  const { store } = useWorkspaceContext();
  const showInShell = useWorkspace((s) => s.showInShell);
  return ({ origin, addedWorkflowIds, addedCollectionIds, homeScreenWorkflowIds, notes }) => {
    // A sample adds several quick actions and tables at once, so it skips the "done" page. Stepping back to cancel the sample leaves the page missing, so stay in place.
    if (origin.sample) {
      const { id, pageId } = origin.sample;
      const config = store.getState().config;
      if (!config?.containers.pages.some((p) => p.id === pageId)) return;
      useSampleHint.getState().show(id, pageId);
      const target = pageTarget(pageId);
      // Return to the shell first (the draft might have been applied on a pushed page), then open the main page to avoid stacking two layers of the same page.
      if (router.canDismiss()) router.dismissAll();
      if (!showInShell(config, target))
        router.push({ pathname: '/page/[pageId]', params: { pageId } });
      return;
    }
    // AI explanation (D-110): shown in the reply within the draft, or displayed on the "done" page for directly applied features.
    const extra = notes?.length ? { notes: JSON.stringify(notes) } : {};
    const made = addedWorkflowIds.length === 1 ? addedWorkflowIds[0] : undefined;
    if (origin.about?.kind === 'shared') {
      router.push({ pathname: '/share', params: made ? { made } : {} });
      return;
    }
    const ready =
      made ??
      (origin.about?.kind === 'workflow' ? origin.about.workflowId : undefined) ??
      (homeScreenWorkflowIds.length === 1 ? homeScreenWorkflowIds[0] : undefined);
    if (ready) {
      router.push({
        pathname: '/ready/[workflowId]',
        params: {
          workflowId: ready,
          ...extra,
        },
      });
      return;
    }
    const table = addedCollectionIds.length === 1 ? addedCollectionIds[0] : undefined;
    if (table) {
      router.push({
        pathname: '/table-ready/[collectionId]',
        params: { collectionId: table, ...extra },
      });
    }
  };
}

/** The notes parameter for the "done" page (array of JSON strings); treat as empty if unparseable. */
export function readyNotes(param: string | undefined): string[] {
  try {
    const value: unknown = param ? JSON.parse(param) : [];
    return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** "Apply" draft (D-190): synthesize a version and save it (the "Modified · Undo" banner appears at the top as usual), then same as above. */
export function useApplyDraft(): () => Promise<void> {
  const applyDraft = useWorkspace((s) => s.applyDraft);
  const after = useAfterApply();
  return async () => {
    const applied = await applyDraft();
    if (applied) after(applied);
  };
}
