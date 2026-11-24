import type { Workflow } from '@morph/core';

import type { WorkspaceRepo } from '../storage/types';

// Order, configuration, and a single handoff jointly determine a successful handoff; recorded locally only, not used as AI context.
const key = (first: string, second: string) =>
  `chain:${encodeURIComponent(first)}:${encodeURIComponent(second)}`;
export const sameWorkflow = (a: Workflow, b: Workflow) => JSON.stringify(a) === JSON.stringify(b);

interface ChainRecord {
  signature: string;
  count: number;
  transfer: string;
  /** User has already synthesized or clicked "No thanks": these two quick actions are not modified and will not be suggested again. */
  dismissed?: boolean;
}

async function readChain(
  repo: Pick<WorkspaceRepo, 'getMeta'>,
  metaKey: string,
): Promise<ChainRecord | null> {
  try {
    const raw = await repo.getMeta(metaKey);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (
      parsed &&
      typeof parsed === 'object' &&
      'signature' in parsed &&
      'count' in parsed &&
      'transfer' in parsed &&
      typeof parsed.signature === 'string' &&
      typeof parsed.count === 'number' &&
      Number.isInteger(parsed.count) &&
      parsed.count > 0 &&
      typeof parsed.transfer === 'string'
    )
      return parsed as ChainRecord;
  } catch {
    /* Record from scratch when old statistics are corrupted, without affecting file processing. */
  }
  return null;
}

/** Running the second segment repeatedly on the same batch of results does not increase the count; re-accumulates after any configuration change. */
export async function recordChain(
  repo: Pick<WorkspaceRepo, 'getMeta' | 'setMeta'>,
  first: Workflow,
  second: Workflow,
  transfer: string,
): Promise<boolean> {
  const metaKey = key(first.id, second.id);
  const signature = JSON.stringify([first, second]);
  const previous = await readChain(repo, metaKey);
  const same = previous !== null && previous.signature === signature;
  const count =
    same && previous ? Math.min(2, previous.count + (previous.transfer === transfer ? 0 : 1)) : 1;
  const dismissed = same && previous?.dismissed === true;
  await repo.setMeta(
    metaKey,
    JSON.stringify({ signature, count, transfer, ...(dismissed ? { dismissed } : {}) }),
  );
  return count >= 2 && !dismissed;
}

/** Synthesized or clicked "No thanks": the same two quick actions will no longer be suggested (re-calculated after any changes to either). */
export async function dismissChain(
  repo: Pick<WorkspaceRepo, 'getMeta' | 'setMeta'>,
  first: Workflow,
  second: Workflow,
): Promise<void> {
  const metaKey = key(first.id, second.id);
  const previous = await readChain(repo, metaKey);
  const signature = JSON.stringify([first, second]);
  await repo.setMeta(
    metaKey,
    JSON.stringify({
      signature,
      count: previous?.signature === signature ? previous.count : 1,
      transfer: previous?.transfer ?? '',
      dismissed: true,
    }),
  );
}
