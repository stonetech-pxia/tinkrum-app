import { migrateWorkspace, t, type Locale, type WorkspaceConfig } from '@morph/core';

import { formatWhen } from '../i18n';
import type { RevisionRecord, WorkspaceRepo } from '../storage/types';

/** Version rolled back to since opening the rescue page. */
export interface StepBackState {
  last?: number;
}

/**
 * Rescue page "Step back" button: moving backward from the current version when the rescue page
 * opened, stepping back one version per tap (will not revert to the broken one just encountered).
 * Committed as a new version just like restores in change history (history only grows forward,
 * §7D), leaving records and files untouched (Invariant 5, §7E). Unrecognized old versions are
 * skipped. Returns the timestamp/version of the current state being used.
 */
export async function stepBack(
  repo: WorkspaceRepo,
  state: StepBackState,
  locale: Locale,
  now: Date,
): Promise<number> {
  const head = await repo.getHead();
  if (!head) throw new Error('noOlder');
  let target: RevisionRecord | null = await repo.getRevision(state.last ?? head.id);
  let config: WorkspaceConfig | null = null;
  while (target && !config) {
    target = target.parentId ? await repo.getRevision(target.parentId) : null;
    const migrated = target ? migrateWorkspace(target.config) : null;
    if (migrated?.ok) config = migrated.config as WorkspaceConfig;
  }
  if (!target || !config) throw new Error('noOlder');
  await repo.commitRevision({
    baseId: head.id,
    config,
    source: 'restore',
    summary: t(locale, 'restoreSummary', {
      when: formatWhen(locale, new Date(target.createdAt), now),
    }),
  });
  state.last = target.id;
  return target.createdAt;
}
