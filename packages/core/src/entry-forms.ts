import { fieldDefinition } from './fields';
import { t } from './messages';
import { isRecordToolUse, type ToolUse } from './record-ops-schema';
import {
  RECORD_LOOKS,
  RECORD_REF,
  allComponents,
  isKnownComponent,
  parentOf,
  quickActionsOf,
  type Component,
  type Condition,
  type Locale,
  type WorkspaceConfig,
} from './schema';

// Add entry point for record blocks (D-310): When AI adds a record block (list, card, checklist,
// large circular block, kanban, calendar) but this table has no add entry point anywhere in the
// app, new users would only see "No records yet". In this case, prepend an "Add" button above it
// (an inline {do: "create", table, ask: "all"} opening the full add page). Checked only for newly
// added record blocks: if the user removes this button later, other modifications will not re-add
// it.

const isRecordLook = (c: Component): boolean =>
  isKnownComponent(c) && (RECORD_LOOKS as readonly string[]).includes(c.look);

/**
 * Locations where records can be added to this table: any inline tool on a block creating this
 * table (add form submission, buttons, row-level creation, inline add), or the quick action to
 * log an entry.
 */
function addsTo(config: WorkspaceConfig, table: string): boolean {
  const creates = (c: Component) =>
    isKnownComponent(c) &&
    ((c as { tools?: ToolUse[] }).tools ?? []).some(
      (u) => isRecordToolUse(u) && u.do === 'create' && u.table === table,
    );
  return (
    config.containers.pages.some((page) => allComponents(page).some(creates)) ||
    quickActionsOf(config).some((wf) =>
      wf.steps.some((s) => s.action === 'out.addRecord' && s.params.collectionId === table),
    )
  );
}

/** On pages dedicated to a single record (D-342): lists display only entries linked to this record, and new records must also link to it to appear in this list. */
function linkToRecord(filter: readonly Condition[] | undefined) {
  const links = (filter ?? []).filter((x) => x.op === 'is' && x.value === RECORD_REF);
  if (links.length === 0) return {};
  return { values: Object.fromEntries(links.map((x) => [x.field, RECORD_REF])) };
}

/** Add missing "Add" buttons for newly added record blocks in after; returns the tables with added buttons. */
export function addMissingEntryForms(
  before: WorkspaceConfig,
  after: WorkspaceConfig,
  locale: Locale,
): string[] {
  const added: string[] = [];
  for (const page of after.containers.pages) {
    const old = before.containers.pages.find((p) => p.id === page.id);
    const existed = new Set(old ? allComponents(old).map((c) => c.id) : []);
    for (const c of allComponents(page)) {
      if (!isRecordLook(c) || existed.has(c.id)) continue;
      const { table: tableId, filter } = (c as { source: { table: string; filter?: Condition[] } })
        .source;
      const table = after.data.tables.find((x) => x.id === tableId);
      if (!table || addsTo(after, table.id)) continue;
      // Do not add if the table has no fillable fields in the form (all fields are computed).
      if (!table.fields.some((f) => fieldDefinition(f.type).inForm !== false)) continue;
      const ids = new Set(allComponents(page).map((x) => x.id));
      const stem = `add-${table.id}`.slice(0, 44);
      let id = stem;
      for (let n = 2; ids.has(id); n++) id = `${stem}-${n}`;
      // When a record block is grouped, place it above the outermost group (buttons are placed at the page top level, matching v33).
      let top: Component = c;
      for (let p = parentOf(page, top.id); p; p = parentOf(page, top.id)) top = p;
      page.blocks.splice(page.blocks.indexOf(top), 0, {
        id,
        look: 'button',
        show: { label: t(locale, 'entryFormAdd'), variant: 'filled' },
        tools: [{ do: 'create', table: table.id, ask: 'all', ...linkToRecord(filter) }],
      });
      added.push(table.id);
    }
  }
  return added;
}
