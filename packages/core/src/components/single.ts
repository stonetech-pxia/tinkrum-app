import { z } from 'zod';

import { t } from '../messages';
import { ToolUseSchema } from '../record-ops-schema';
import { FieldRefSchema, IdSchema } from '../schema-base';
import { RECORD_REF } from '../schema-primitives';
import { collectionName, type LookDefinitionOf, defineLook } from './define';

// Displays a single record from a table (earliest added entry, D-424): several fields, an "Edit"
// button, and optionally a vCard QR code for this record. Config contains only table and field
// references; QR codes are computed on demand and not stored (invariant 14). Pages dedicated to a
// single record (page.of is this table) can specify source.record "$record": displays the opened
// record (D-558). Config contains only placeholders, IDs are bound only during rendering
// (bindRecord in record-pages.ts), invisible to AI (invariants 2, 14).

const shape = {
  source: z.strictObject({
    table: IdSchema,
    /** Opened record (D-558), valid only on pages where page.of is this table. */
    record: z.literal(RECORD_REF).optional(),
  }),
  show: z.strictObject({
    fields: z.array(FieldRefSchema).min(1).max(8),
    /** Render a vCard QR code for this record. */
    qr: z.literal(true).optional(),
  }),
  /** A single button that runs a record-capturing quick action, passing this record to it (D-428). */
  tools: z.array(ToolUseSchema).min(1).max(1).optional(),
};

export const singleComponent: LookDefinitionOf<'single', typeof shape> = defineLook({
  look: 'single',
  shape,
  kind: 'container',
  layer: 'record',
  reads: 'table',
  writes: false,
  refs: {
    'source.table': { to: 'table' },
    'show.fields': { to: 'field', role: 'show.fields' },
  },
  check: (c, { page }) =>
    c.source.record !== undefined && page.of !== c.source.table
      ? [
          `source.record "${RECORD_REF}" only works on a page for one entry of ${c.source.table} (page.of: "${c.source.table}"); remove it to show the oldest entry`,
        ]
      : [],
  describe: (c, config, ctx) =>
    t(ctx.locale, 'describeSingle', { table: collectionName(c.source.table, config) }),
  tools: { as: ['self'], ref: ['quickAction'], max: 1 },
  edit: { text: [], style: ['tone'] },
  ai: {
    doc: 'source {table, record?: "$record"}, show {fields (1-8 field ids), qr?: true}: one entry of a table (the oldest), its fields and an Edit button that opens the entry form; tools? [{tool: <a quick action taking records>}] adds one button that hands it this entry (rule 54); qr also draws a QR code of its contact card (vCard), computed on the device. For "my card" or "my profile"; pair it with showIf. On a page for one entry (page.of = this table) record: "$record" shows the opened entry instead (rule 58)',
    rules: [
      {
        n: 58,
        text: 'The entry itself on a page for one entry (rule 48): to show the opened entry\'s own fields there ("植物页上面显示照片、品种和上次浇水", "show the client\'s phone and address at the top", "la fiche du livre en haut") → a single block with source {table: the page\'s of table, record: "$record"} and show.fields the fields to show (a file field shows its pictures), usually first on the page, above the lists of what belongs to it. Its Edit button edits that entry. Without record it shows the oldest entry of the table, so never leave record out on such a page; never write record anywhere else.',
      },
    ],
  },
  example: {
    source: { table: 'expenses' },
    show: { fields: ['category', 'amount'], qr: true },
  },
});
