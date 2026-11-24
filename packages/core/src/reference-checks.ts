import { isSystemField } from './components/define';
import { deskActionFits } from './desk/tools';
import type { DeskKind } from './desk/model';
import type { DeskTool } from './desk/layout';
import type { Registry } from './registry';
import { allComponents, isKnownComponent, quickActionsOf, type WorkspaceConfig } from './schema';
import { handedInput } from './workflow/check';
import { findWorkflowTarget, presetById } from './workflows/presets';

// Partial reference for Invariant 18 (audit F3): such broken references do not affect execution
// (unused fields, toolbar items filtered out during display), and may exist in saved config, so
// they are excluded from validateWorkspace (Invariant 12: old config must still open). Checked only
// during modifications (change.ts): modifications cannot introduce new broken references.

/** Referenced field is written on a number block, chart, or minus, but does not exist in this table (ignored during counting and date-based calculations, validator does not check). */
function fieldProblems(config: WorkspaceConfig): string[] {
  const problems: string[] = [];
  const check = (who: string, tableId: string, field: string | undefined) => {
    const table = config.data.tables.find((t) => t.id === tableId);
    if (field === undefined || !table || isSystemField(field)) return;
    if (!table.fields.some((f) => f.id === field))
      problems.push(
        `${who}: field ${field} is not a field of ${tableId}; leave field out (only sum, avg, min and max read it)`,
      );
  };
  for (const page of config.containers.pages)
    for (const c of allComponents(page)) {
      if (!isKnownComponent(c) || (c.look !== 'number' && c.look !== 'chart')) continue;
      check(c.id, c.source.table, c.source.field);
      if (c.look === 'number')
        for (const total of c.source.calc?.with ?? [])
          check(`${c.id} calc`, total.table, total.field);
      if (c.look === 'number' && c.source.minus)
        check(`${c.id} minus`, c.source.minus.table, c.source.minus.field);
    }
  return problems;
}

/** An item on the file desk toolbar: actions supported for this file type (must also match specs), or a quick action. */
function deskItemProblem(
  item: DeskTool,
  kind: DeskKind,
  config: WorkspaceConfig,
  registry: Registry,
): string | null {
  if (typeof item === 'string') {
    if (quickActionsOf(config).some((w) => w.id === item) || presetById(item)) {
      const wf = findWorkflowTarget(quickActionsOf(config), item, 'en');
      return wf && handedInput(wf.steps, registry)
        ? `${item} takes what a container hands over (a record, a value or attachments); it can't go on a toolbar`
        : null;
    }
    // Do not distinguish between reminders and non-existent items: items in old config, once reminders are deleted, must not turn into "new" issues that block that deletion.
    return `${item} is not a quick action (reminders can't go on a toolbar); use the id of a quick action or a built-in one`;
  }
  const action = registry.actions.get(item.action);
  if (!action) return `action ${item.action} is not in the catalog`;
  if (!deskActionFits(action, kind)) return `action ${item.action} can't work on ${kind} files`;
  if (item.preset !== undefined && !action.presets?.some((p) => p.id === item.preset))
    return `action ${item.action} has no preset ${item.preset}; leave preset out`;
  return null;
}

function deskProblems(config: WorkspaceConfig, registry: Registry): string[] {
  const tools = config.containers.desk?.tools;
  if (!tools) return [];
  return (Object.keys(tools) as DeskKind[]).flatMap((kind) =>
    (tools[kind] ?? [])
      .flatMap((g) => g.items)
      .map((item) => deskItemProblem(item, kind, config, registry))
      .filter((p) => p !== null)
      .map((p) => `containers.desk.tools.${kind}: ${p}`),
  );
}

function presetProblems(config: WorkspaceConfig): string[] {
  return quickActionsOf(config)
    .filter((wf) => wf.preset !== undefined && !presetById(wf.preset))
    .map((wf) => `quick action ${wf.id}: preset ${wf.preset} is not a built-in quick action`);
}

/** All such issues in this config (messages sent to AI, also used to compare config before and after changes). */
export function referenceProblems(config: WorkspaceConfig, registry: Registry): string[] {
  return [...fieldProblems(config), ...deskProblems(config, registry), ...presetProblems(config)];
}
