import { z } from 'zod';

import { fieldDefinition } from '../fields';
import { t } from '../messages';
import { isRecordToolUse, ToolUseSchema } from '../record-ops-schema';
import { collectionName, type LookDefinitionOf, defineLook, duplicates } from './define';

const shape = {
  /** inline fills directly on the page; sheet (D-352) shows a "+" at the bottom right of the page, popping up an add dialog from the bottom when tapped. */
  show: z.strictObject({ mode: z.enum(['inline', 'sheet']) }),
  /** A {as: "submit", label, do: "create", table, ask: [fields], values?, smartDate?}. */
  tools: z.array(ToolUseSchema).min(1).max(1),
};

/** Fields compatible with smartDate (D-344). */
export const SMART_DATE_TYPES: readonly string[] = ['date', 'datetime', 'schedule'];

/** Add form (original recordForm inline / sheet): forms are containers, submission is an in-place create tool (ask = fields in the form). */
export const formComponent: LookDefinitionOf<'form', typeof shape> = defineLook({
  look: 'form',
  shape,
  kind: 'container',
  layer: 'record',
  reads: 'none',
  writes: true,
  tools: { as: ['submit'], do: ['create'], max: 1 },
  refs: { 'tools.0.table': { to: 'table' } },
  check: (c, { config, collection, page, parent }) => {
    const problems: string[] = [];
    const tool = c.tools[0]!;
    if (!isRecordToolUse(tool) || tool.do !== 'create' || tool.as !== 'submit') {
      return ['a form has one tool {as: "submit", label, do: "create", table, ask: [fields]}'];
    }
    if (!tool.label) problems.push('the submit tool of a form needs a label');
    // Uses the original table from config: lookups and summaries are mapped to the fields they display when checking other blocks (D-287).
    const table = config.data.tables.find((x) => x.id === tool.table) ?? collection!;
    const ask = tool.ask;
    if (!Array.isArray(ask)) return [...problems, 'a form asks a list of fields: ask: [field ids]'];
    for (const id of ask) {
      const f = table.fields.find((x) => x.id === id);
      if (!f) problems.push(`form field ${id} does not exist`);
      // Formulas are computed (D-188): cannot be filled in forms (inForm in field definition). Attachments can be selected in forms (D-263).
      else if (fieldDefinition(f.type).inForm === false)
        problems.push(`form field ${id} is a ${f.type} field and cannot be filled in a form`);
    }
    for (const id of duplicates(ask)) problems.push(`form field ${id} is listed twice`);
    const values = typeof tool.values === 'object' ? tool.values : {};
    if (Object.keys(values).length > 10) problems.push('a form has at most 10 preset values');
    for (const id of Object.keys(values))
      if (ask.includes(id))
        problems.push(`${id} is both asked and in values; a preset value is not shown`);
    // D-352: Floating "+" placed at the bottom right of the page, one per page, cannot be placed inside groups.
    if (c.show.mode === 'sheet') {
      if (parent)
        problems.push(
          'a form with mode "sheet" floats over the page; put it on the page itself, not in a group',
        );
      const sheets = page.blocks.filter(
        (x) => x.look === 'form' && (x as { show?: { mode?: string } }).show?.mode === 'sheet',
      );
      if (sheets.length > 1 && sheets[0]!.id !== c.id)
        problems.push(
          `page ${page.id} already has a floating add button (${sheets[0]!.id}); one per page`,
        );
    }
    return problems;
  },
  describe: (c, config, ctx) => {
    const tool = c.tools[0]!;
    const table = isRecordToolUse(tool) ? tool.table : '';
    return t(ctx.locale, 'describe_form_f4ef1', { v0: collectionName(table, config) });
  },
  edit: { text: [], style: ['tone'] },
  ai: {
    doc: 'show {mode: "inline"|"sheet" (rule 45)}, tools: [{as: "submit", label, do: "create", table, ask: [field ids, 1-10], values? (preset values not shown; rule 48), smartDate? {from: a text field in ask, to: a date|datetime|schedule field} (rule 49)}]: "inline" adds records right on the page; "sheet" is a floating "+" (one per page, not in a group). Formula fields can\'t be asked; a file field lets the user add photos and files. A button that opens the full editor is a button with tools [{do: "create", table, ask: "all"}].',
  },
  example: {
    show: { mode: 'inline' },
    tools: [
      {
        as: 'submit',
        label: 'Add',
        do: 'create',
        table: 'expenses',
        ask: ['amount', 'category', 'note'],
      },
    ],
  },
});
