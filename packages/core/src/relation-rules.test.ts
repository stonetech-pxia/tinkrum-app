import { describe, expect, it } from 'vitest';

import { RecordToolSchema, ToolUseSchema } from './record-ops-schema';
import { QuickActionSchema, ReminderSchema, TOOL_KINDS, WorkflowStepSchema } from './schema';
import { fromV33, registry, v33Fixture } from './test-helpers';
import { validateWorkspace } from './validate';

// Relation rules 13 and 14 (Founder approved 2026-10-30, D-370): prove structurally that disallowed
// actions cannot occur; use validation to block permitted structures that violate constraints.
// Tests for rule 12 are in record-ops.test.ts.

const reminder = {
  id: 'r',
  kind: 'reminder',
  title: 'Water the plants',
  enabled: true,
  when: { every: 'day', at: '09:00' },
  opens: 'page:home',
} as const;

/** Actions that export data out of the app (export, share, save to "Files", save to photo library, print). */
const LEAVES_APP = [
  'out.share',
  'out.saveToFolder',
  'out.saveToPhotos',
  'out.print',
  // Making phone calls, sending SMS/emails, opening websites (D-428).
  'out.call',
  'out.message',
  'out.email',
  'out.website',
];

describe('rule 13: a tool never triggers another tool', () => {
  it('a reminder has no steps and its done is a record tool, never a reference to a tool', () => {
    expect(ReminderSchema.safeParse(reminder).success).toBe(true);
    expect(
      ReminderSchema.safeParse({
        ...reminder,
        steps: [{ id: 's', action: 'out.share', params: {} }],
      }).success,
    ).toBe(false);
    expect(ReminderSchema.safeParse({ ...reminder, runs: 'pdf-merge' }).success).toBe(false);
    expect(ReminderSchema.safeParse({ ...reminder, done: { tool: 'pdf-merge' } }).success).toBe(
      false,
    );
    expect(RecordToolSchema.safeParse({ do: 'create', table: 't', tool: 'x' }).success).toBe(false);
    // Inline tools on blocks cannot implicitly reference a tool either.
    expect(ToolUseSchema.safeParse({ do: 'create', table: 't', tool: 'x' }).success).toBe(false);
    // Batch creation (D-567) is a fixed tool type: no steps, no tool references; executed entry by entry by the engine, with no loops in configuration.
    const bulk = { do: 'createAll', table: 't', from: 's', values: {} };
    expect(RecordToolSchema.safeParse(bulk).success).toBe(true);
    for (const extra of [{ tool: 'x' }, { steps: [] }, { then: { do: 'create', table: 't' } }])
      expect(RecordToolSchema.safeParse({ ...bulk, ...extra }).success).toBe(false);
  });

  it('a quick action step is a catalog action, never another quick action or reminder', () => {
    expect(WorkflowStepSchema.safeParse({ id: 's', action: 'pdf-merge', params: {} }).success).toBe(
      false,
    );
    // None of the action parameters in the catalog are "select a tool": neither among parameter types nor parameter names.
    const kinds = new Set<string>();
    for (const action of registry.actions.values())
      for (const field of action.fields) {
        kinds.add(field.kind);
        expect({ action: action.id, key: field.key }).not.toEqual({
          action: action.id,
          key: expect.stringMatching(/workflow|quickAction|reminder|^tool/i),
        });
      }
    expect([...kinds].filter((k) => /tool|workflow|action|reminder/i.test(k))).toEqual([]);
  });

  it('only quick actions run steps; a reminder only opens', () => {
    expect(TOOL_KINDS.quickAction.runs).toBe('steps');
    expect(TOOL_KINDS.reminder.runs).toBe('opens');
    expect(Object.keys(QuickActionSchema.shape)).toContain('steps');
    expect(Object.keys(ReminderSchema.shape)).not.toContain('steps');
  });

  it("a reminder's done acts on this entry: setAll, createAll and ask are rejected", () => {
    const config = fromV33(v33Fixture('default-en'));
    config.data.tables.push({
      id: 'plants',
      name: 'Plants',
      fields: [
        { id: 'name', name: 'Name', type: 'text' },
        { id: 'watered', name: 'Watered', type: 'date' },
        { id: 'plan', name: 'Plan', type: 'schedule', lastDone: 'watered' },
      ],
    });
    config.data.tables.push({
      id: 'notes',
      name: 'Notes',
      fields: [{ id: 'watered', name: 'Day', type: 'date' }],
    });
    const withDone = (done: unknown) => {
      const copy = structuredClone(config);
      copy.tools.push({
        ...reminder,
        when: { each: { table: 'plants', field: 'plan' }, at: '09:00' },
        done,
      } as never);
      const r = validateWorkspace(copy, registry);
      return r.ok ? '' : r.issues.map((i) => i.message).join('\n');
    };
    expect(withDone({ do: 'set', table: 'plants', field: 'watered', value: 'today' })).toBe('');
    expect(withDone({ do: 'setAll', table: 'plants', field: 'watered', value: null })).toMatch(
      /done acts on this entry/,
    );
    expect(withDone({ do: 'create', table: 'plants', ask: 'all' })).toMatch(/can't ask/);
    // Batch creation (D-567) is also disallowed: "Complete" only modifies this single entry.
    expect(
      withDone({ do: 'createAll', table: 'plants', from: 'notes', values: { watered: 'today' } }),
    ).toMatch(/done acts on this entry.*not createAll/);
    // Multi-change on a single tap (D-566) is also disallowed: no undo banner on notifications.
    expect(
      withDone({
        do: 'set',
        table: 'plants',
        field: 'watered',
        value: 'today',
        also: [{ do: 'set', field: 'name', value: null }],
      }),
    ).not.toBe('');
    // Relation rule 12: "Complete" modifies this specific entry (when.each.table).
    expect(withDone({ do: 'set', table: 'notes', field: 'watered', value: 'today' })).toMatch(
      /so table must be plants, not notes/,
    );
  });
});

describe('rule 14: data leaves the app only when the user taps', () => {
  it('the actions that take data out of the app are catalog actions, usable only as steps', () => {
    for (const id of LEAVES_APP) expect(registry.actions.has(id)).toBe(true);
  });

  it('only tools the user taps run steps; time-triggered tools only open', () => {
    for (const [kind, meta] of Object.entries(TOOL_KINDS)) {
      if (meta.trigger !== 'tap')
        expect({ kind, runs: meta.runs }).toEqual({ kind, runs: 'opens' });
    }
    // Time-triggered reminders have no steps in their structure, preventing attachment of share, export, or save-to-"Files" actions.
    for (const action of LEAVES_APP)
      expect(
        ReminderSchema.safeParse({ ...reminder, steps: [{ id: 's', action, params: {} }] }).success,
      ).toBe(false);
  });

  it('a reminder opens a quick action only to show it; it never runs it', () => {
    const config = fromV33(v33Fixture('setup-pdf-zh'));
    config.tools.push({ ...reminder, opens: 'tool:pdf-merge' } as never);
    expect(validateWorkspace(config, registry).ok).toBe(true);
    // Reminders cannot open tool packages or files (must be pages, system entry points, or tool:<id>).
    for (const opens of ['package:pdf', { file: null }])
      expect(ReminderSchema.safeParse({ ...reminder, opens }).success).toBe(false);
  });
});
