import type { Collection } from '@morph/core';

import { revisionTables } from '../workspace/revision-tables';
import type { RevisionRecord, WorkspaceRepo } from './types';

// Historical versions are append-only and never deleted (Invariant 7): wherever full history needs
// to be viewed (finding tables moved out of the interface, checking which files were used in old
// versions), read page by page from newest to oldest until done, rather than taking only the most
// recent ones.

/** Number of versions to read per page (each version includes the full configuration, avoiding reading too much at once). */
export const REVISION_PAGE = 100;

/** Read all historical versions page by page from newest to oldest. Returning true from onPage stops early. */
export async function eachRevisionPage(
  repo: WorkspaceRepo,
  onPage: (page: RevisionRecord[]) => boolean | void,
): Promise<void> {
  let before: number | undefined;
  for (;;) {
    const page = await repo.listRevisions(REVISION_PAGE, before);
    if (page.length === 0) return;
    if (onPage(page) === true) return;
    if (page.length < REVISION_PAGE) return;
    before = page[page.length - 1]!.id;
  }
}

/**
 * Find the table schemas for these tables in historical versions (for tables moved out of the
 * interface whose records still exist): take the latest version of each table, and stop once all
 * are found.
 */
export async function findRevisionTables(
  repo: WorkspaceRepo,
  missing: ReadonlySet<string>,
): Promise<Map<string, Collection>> {
  const found = new Map<string, Collection>();
  if (missing.size === 0) return found;
  await eachRevisionPage(repo, (page) => {
    for (const rev of page) {
      for (const table of revisionTables(rev.config)) {
        if (missing.has(table.id) && !found.has(table.id)) found.set(table.id, table);
      }
    }
    return found.size === missing.size;
  });
  return found;
}
