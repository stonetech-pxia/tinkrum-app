import { z } from 'zod';

import { t } from '../messages';
import { ToolUseSchema } from '../record-ops-schema';
import { type LookDefinitionOf, defineLook } from './define';

// Separate floating buttons (set by founder 2026-11-04): fixed at the bottom of the page (pin:
// "bottom"). The first tool is the primary button and executes on tap; tapping the arrow expands
// the rest into a row of labeled circular buttons, which collapse when tapped outside. Each item is
// a regular tool reference or page open, executed only upon tap (invariants 9, 10, 15, 16).

const shape = {
  /**
   * The first is the primary button, followed by expanded ones. An item is: {tool} (run quick
   * action), {as: "list", tool} (pass records currently selected in the page list to it), {do:
   * "create", table, …, label} (one-tap creation), or {opens: <page>, label}. label is the button
   * text; quick actions use their name if omitted.
   */
  tools: z.array(ToolUseSchema).min(1).max(5),
};

export const dialComponent: LookDefinitionOf<'dial', typeof shape> = defineLook({
  look: 'dial',
  shape,
  kind: 'container',
  layer: 'record',
  reads: 'none',
  writes: true,
  tools: { as: ['self', 'list'], do: ['create'], ref: ['quickAction'], open: true, max: 5 },
  check: (c, ctx) => {
    const problems: string[] = [];
    if (c.pin !== 'bottom') problems.push('a dial sits in the fixed bottom zone: set pin "bottom"');
    if (ctx.page.blocks.filter((b) => b.look === 'dial').length > 1)
      problems.push(`page ${ctx.page.id} has more than one dial; keep one`);
    return problems;
  },
  describe: (c, _config, ctx) => t(ctx.locale, 'describe_dial', { n: c.tools.length }),
  edit: { text: [], style: [] },
  ai: {
    doc: 'pin: "bottom" (required), tools: [1-5 tools]: a floating split button in the bottom zone of a page (rule 55). The first tool is the main button, the others open above it from an arrow. Each tool is {tool: <quick action id>, label?}, {as: "list", tool: <quick action id>, label?} (hands over the entries the list on this page shows now, searched and filtered, all of them), {do: "create", table, values?, ask?: "all", label} or {opens: <page id>, label}; label at most 20 characters.',
    rule: {
      n: 55,
      text: 'Fixed zones: any top-level block on a page may have pin: "top" or pin: "bottom"; it stays in place while the middle of the page scrolls (never inside a group, never a list with show.browse). Set it with addContainer, or updateContainer {page, block, changes: {pin: "top"|"bottom"|null}}. show.browse.pin: true keeps a list\'s search box, sort and filter chips fixed at the top while the list scrolls (one per page, on a top-level list). When the user wants big floating actions like "scan" with "more" behind an arrow ("把扫描放在右下角", "floating add button with more options"), use a dial; several ordinary actions keep their blocks. {as: "list"} on a dial needs exactly one top-level list with show.browse on the same page, and a quick action whose first step takes records (rule 54). Nothing on a dial runs by itself; each tool runs when tapped.',
    },
  },
  example: {
    pin: 'bottom',
    tools: [
      { tool: 'pdf-merge', label: 'Merge' },
      { do: 'create', table: 'expenses', ask: 'all', label: 'Add by hand' },
    ],
  },
});
