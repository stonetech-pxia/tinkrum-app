import { drawnIconUses } from './drawn-icons';
import type { Op } from './ops-schema';
import type { Registry } from './registry';
import { referenceProblems } from './reference-checks';
import type { WorkspaceConfig } from './schema';
import { validateWorkspace } from './validate';

// New pages, tables, and quick actions added in this modification without an explicit app
// assignment belong to this app. (D-485, provisional rule). Checked via "pre- and post-modification
// configs" rather than individual operations: deleting pages, data, or installing toolboxes makes
// cascading changes elsewhere, so relying on target IDs of individual operations would miss things.
// Approach: 1. After stripping out this app's components (pages, tables, quick actions, its entry
// in nav.apps), everything else must match character for character; 2. This app's items can only
// reference its own items or home tables (maintaining workspace self-consistency after removing
// other app items). Newly added pages, tables, and quick actions without an app property
// automatically belong to this app (since models frequently omit it). Checked only during
// modification; excluded from validateWorkspace to ensure tighter rules don't break opening
// existing legacy versions (invariant 12).

/** New pages, tables, and quick actions added in this modification without an explicit app assignment belong to this app. */
export function tagNewForApp(before: WorkspaceConfig, after: WorkspaceConfig, appId: string): void {
  const had = {
    page: new Set(before.containers.pages.map((p) => p.id)),
    table: new Set(before.data.tables.map((t) => t.id)),
    tool: new Set(before.tools.map((t) => t.id)),
  };
  for (const page of after.containers.pages)
    if (!had.page.has(page.id) && page.app === undefined && !page.package) page.app = appId;
  for (const table of after.data.tables)
    if (!had.table.has(table.id) && table.app === undefined) table.app = appId;
  for (const tool of after.tools)
    if (
      tool.kind === 'quickAction' &&
      !had.tool.has(tool.id) &&
      tool.app === undefined &&
      !tool.package
    )
      tool.app = appId;
}

/**
 * Commands spoken within this app (D-485): Style changes without an app target modify this app's
 * style (home styles cannot be modified inside apps anyway), and new unassigned pages, tables,
 * and quick actions belong to this app. Recorded in operations rather than just inferred from
 * results so draft reapplication preserves scope without context.
 */
export function opsForApp(ops: readonly Op[], appId: string): Op[] {
  return ops.map((op): Op => {
    if (op.op === 'setTheme' && op.app === undefined) return { ...op, app: appId };
    // New pages and quick actions added within operations cannot belong to a toolbox (toolbox property removed from ops-schema).
    if (op.op === 'addContainer' && typeof op.page === 'object' && op.page.app === undefined)
      return { ...op, page: { ...op.page, app: appId } };
    if (op.op === 'addData' && typeof op.table === 'object' && op.table.app === undefined)
      return { ...op, table: { ...op.table, app: appId } };
    if (
      op.op === 'addTool' &&
      typeof op.tool === 'object' &&
      op.tool.kind === 'quickAction' &&
      op.tool.app === undefined
    )
      return { ...op, tool: { ...op.tool, app: appId } };
    return op;
  });
}

/** Strip out this app's components. */
function withoutApp(config: WorkspaceConfig, appId: string): unknown {
  const nav = { ...config.nav };
  if (nav.apps) {
    nav.apps = nav.apps.filter((a) => a.id !== appId);
    if (nav.apps.length === 0) delete nav.apps;
  }
  const rest = {
    ...config,
    nav,
    containers: {
      ...config.containers,
      pages: config.containers.pages.filter((p) => p.app !== appId),
    },
    data: { ...config.data, tables: config.data.tables.filter((t) => t.app !== appId) },
    tools: config.tools.filter((t) => t.app !== appId),
  };
  // The icon library is workspace-wide (D-625): Apps can add icons and modify those exclusively used by themselves, but cannot alter icons in use elsewhere.
  const used = new Set(drawnIconUses(rest).map((u) => u.id));
  const { icons, ...others } = rest;
  const kept = Object.entries(icons ?? {}).filter(([id]) => used.has(id));
  return kept.length > 0 ? { ...others, icons: Object.fromEntries(kept) } : others;
}

/** Keep only components belonging to this app and home (removing other apps' pages, tables, quick actions, and apps themselves). */
function onlyAppAndHome(config: WorkspaceConfig, appId: string): WorkspaceConfig {
  const mine = (owner: string | undefined) => owner === undefined || owner === appId;
  const nav = { ...config.nav };
  if (nav.apps) nav.apps = nav.apps.filter((a) => a.id === appId);
  return {
    ...config,
    nav,
    containers: {
      ...config.containers,
      pages: config.containers.pages.filter((p) => mine(p.app)),
    },
    data: { ...config.data, tables: config.data.tables.filter((t) => mine(t.app)) },
    tools: config.tools.filter((t) => t.kind !== 'quickAction' || mine(t.app)),
  };
}

const problemsOf = (config: WorkspaceConfig, registry: Registry): string[] => {
  const valid = validateWorkspace(config, registry, { unknownComponents: 'keep' });
  return [
    ...(valid.ok ? [] : valid.issues.map((i) => i.message)),
    ...referenceProblems(config, registry),
  ];
};

/** Out-of-scope issues (empty if none). Each item is phrasing the model can follow to correct it. */
export function scopeProblems(
  before: WorkspaceConfig,
  after: WorkspaceConfig,
  appId: string,
  registry: Registry,
): string[] {
  const problems: string[] = [];
  if (!after.nav.apps?.some((a) => a.id === appId))
    problems.push(`app ${appId} cannot be removed from inside the app`);
  if (JSON.stringify(withoutApp(before, appId)) !== JSON.stringify(withoutApp(after, appId)))
    problems.push(
      `out of scope: inside app ${appId} you can only change this app's own pages, tables, quick actions, bar and style; the home page, other apps, the home bar, tools, reminders and the file room are not yours to change`,
    );
  const old = new Set(problemsOf(onlyAppAndHome(before, appId), registry));
  const added = problemsOf(onlyAppAndHome(after, appId), registry).filter((p) => !old.has(p));
  for (const p of added)
    problems.push(
      `out of scope: ${p} (inside an app you can only point at its own things or the home page's tables)`,
    );
  return problems;
}

/**
 * Configuration sent to the model (when modifying within an app): Contains only this app's pages,
 * tables, quick actions, plus home tables (references only, read-only); home pages, home bottom
 * bar, and other apps are hidden. The model still modifies the full configuration (operations
 * execute and scope-check against the full config).
 */
export function scopedViewForAI(config: WorkspaceConfig, appId: string): WorkspaceConfig {
  const mineOrHome = (owner: string | undefined) => owner === undefined || owner === appId;
  const app = config.nav.apps?.find((a) => a.id === appId);
  return {
    ...config,
    nav: { bar: app?.bar ?? [], floating: [], ...(app ? { apps: [app] } : {}) } as never,
    containers: {
      ...config.containers,
      pages: config.containers.pages.filter((p) => p.app === appId),
    },
    data: { ...config.data, tables: config.data.tables.filter((t) => mineOrHome(t.app)) },
    tools: config.tools.filter((t) => t.app === appId),
  };
}

/** IDs occupied by hidden components (IDs only, no content): New items cannot reuse these names. */
export function hiddenIdsForAI(
  config: WorkspaceConfig,
  appId: string,
): { pages: string[]; tables: string[]; tools: string[]; apps: string[] } {
  return {
    pages: config.containers.pages.filter((p) => p.app !== appId).map((p) => p.id),
    tables: config.data.tables
      .filter((t) => t.app !== undefined && t.app !== appId)
      .map((t) => t.id),
    tools: config.tools.filter((t) => t.app !== appId).map((t) => t.id),
    apps: (config.nav.apps ?? []).filter((a) => a.id !== appId).map((a) => a.id),
  };
}
