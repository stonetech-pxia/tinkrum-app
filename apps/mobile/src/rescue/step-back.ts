import { migrateWorkspace, t, type Locale, type WorkspaceConfig } from '@morph/core';

import { formatWhen } from '../i18n';
import type { RevisionRecord, WorkspaceRepo } from '../storage/types';

/** 这次打开兜底页以来退到了哪个版本。 */
export interface StepBackState {
  last?: number;
}

/**
 * 兜底页的「回到上一个版本」：从打开兜底页时的当前版本往前，每点一次多退一步（不会退回刚才那个坏的）。
 * 和改动历史里的恢复一样作为新版本提交（历史只往后加，§7D），记录和文件不动（底线 5、§7E）。
 * 读不懂的旧版本跳过。返回现在用的是哪个时候的版本。
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
