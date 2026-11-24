import { topIndex, type Op } from './ops';
import { isToolRefUse } from './record-ops-schema';
import type { Registry } from './registry';
import {
  HOME_PAGE_ID,
  allComponents,
  isKnownComponent,
  quickActionsOf,
  type WorkspaceConfig,
} from './schema';
import { handedInput } from './workflow/check';

// Home screen entry point (D-109, usability ranking scheme A): quick actions created by the AI are
// no longer automatically placed on the home screen by the AI; instead, a separate "Place an entry
// on the home screen" option is listed in the preview for the user to manually select.

const hasRunner = (config: WorkspaceConfig, id: string) =>
  config.containers.pages.some((p) =>
    allComponents(p).some(
      (c) =>
        isKnownComponent(c) &&
        c.look === 'action' &&
        c.tools.some((u) => isToolRefUse(u) && u.tool === id),
    ),
  );

/**
 * Quick actions created in this modification that lack a running block (look action) on any page.
 * Excludes those requiring container-passed values (D-428), which reside on record pages and
 * record blocks where home screen blocks cannot supply values.
 */
export function workflowsWithoutEntry(
  ops: readonly Op[],
  after: WorkspaceConfig,
  registry: Registry,
): string[] {
  return ops.flatMap((op) => {
    if (op.op !== 'addTool' || typeof op.tool === 'string' || op.tool.kind !== 'quickAction')
      return [];
    const id = op.tool.id;
    const wf = quickActionsOf(after).find((w) => w.id === id);
    return wf && !hasRunner(after, id) && !handedInput(wf.steps, registry) ? [id] : [];
  });
}

/** Add a running block for each of these quick actions immediately following the home screen title. */
export function homeEntryOps(config: WorkspaceConfig, workflowIds: readonly string[]): Op[] {
  const home = config.containers.pages.find((p) => p.id === HOME_PAGE_ID);
  if (!home) return [];
  const used = new Set(config.containers.pages.flatMap((p) => allComponents(p).map((c) => c.id)));
  const at = topIndex(home);
  return workflowIds.map((tool, i) => {
    const base = `run-${tool}`.slice(0, 40);
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base.slice(0, 36)}-${n}`;
    used.add(id);
    return {
      op: 'addContainer',
      page: HOME_PAGE_ID,
      index: at + i,
      block: { id, look: 'action', tools: [{ tool }] },
    };
  });
}
