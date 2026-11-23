import { expect, it } from 'vitest';
import { createDefaultWorkspace } from './defaults';
import { registry } from './test-helpers';
import { validateWorkspace } from './validate';
import { applyOps } from './ops';
import { stepRefs, stepRefProblems } from './workflow/refs';
import { workflowProblems } from './workflow/check';
import type { QuickAction, WorkspaceConfig } from './schema';
const table = {
  id: 't',
  name: 'People',
  fields: [
    { id: 'name', name: 'Name', type: 'text' as const },
    { id: 'email', name: 'Email', type: 'text' as const, format: 'email' as const },
  ],
};
const templates = {
  id: 'templates',
  name: 'Templates',
  fields: [
    { id: 'title', name: 'Title', type: 'text' as const },
    { id: 'body', name: 'Body', type: 'note' as const },
    { id: 'doc', name: 'Word', type: 'file' as const },
  ],
};
const wf = (
  action = 'records.toExcel',
  params: Record<string, unknown> = { collectionId: 't', fields: ['name', 'createdAt'] },
): QuickAction => ({
  id: 'export',
  name: 'Export',
  kind: 'quickAction',
  steps: [{ id: 'x', action, params }],
});
const fill = () =>
  wf('records.fill', {
    collectionId: 't',
    templatesTable: 'templates',
    kind: 'text',
    body: ['body'],
  });
function config(w: QuickAction): WorkspaceConfig {
  const c = createDefaultWorkspace('en');
  c.data.tables = structuredClone([table, templates]);
  c.tools.push(w);
  return c;
}
const errors = (c: WorkspaceConfig) => {
  const v = validateWorkspace(c, registry);
  return v.ok ? [] : v.issues.map((i) => i.message);
};
it('accepts ordered field selection with a bound table, and rejects unknown fields or another input table', () => {
  const w = wf();
  expect(stepRefProblems(w, config(w), registry)).toEqual([]);
  expect(
    registry.actions.get('records.toExcel')!.params.safeParse(w.steps[0]!.params).success,
  ).toBe(true);
  w.steps[0]!.params.fields = ['missing'];
  expect(stepRefProblems(w, config(w), registry).join()).toContain('not a field');
  w.steps[0]!.params = { fields: ['name'] };
  expect(stepRefProblems(w, config(w), registry).join()).toContain('table is not known');
  const c = config(wf());
  c.data.tables[1]!.recordRow = [{ tool: 'export' }];
  expect(errors(c).join()).toContain('input table must be t');
});
it('allows selecting columns after in.records without repeating the table binding', () => {
  const w = wf();
  w.steps[0]!.params = { fields: ['name'] };
  w.steps.unshift({
    id: 'read',
    action: 'in.records',
    params: { collectionId: 't', period: 'all' },
  });
  expect(stepRefProblems(w, config(w), registry)).toEqual([]);
  expect(stepRefs(w, registry)).toContainEqual({
    index: 1,
    key: 'fields',
    table: 't',
    field: 'name',
  });
});
it('tracks fields from two tables independently and rejects the wrong template field type', () => {
  const w = fill();
  expect(stepRefs(w, registry)).toContainEqual({
    index: 0,
    key: 'body',
    table: 'templates',
    field: 'body',
  });
  expect(errors(config(w))).toEqual([]);
  w.steps[0]!.params.body = ['doc'];
  expect(errors(config(w)).join()).toContain('wrong field type');
});
it('accepts template filling from a list, after in.records, and email followed by another action', () => {
  const w = fill();
  const c = config(w);
  c.containers.pages[0]!.blocks.push({
    id: 'list',
    look: 'list',
    source: { table: 't', limit: 30 },
    show: { title: 'name' },
    tools: [{ as: 'list', tool: 'export' }],
  });
  expect(errors(c)).toEqual([]);
  w.steps.unshift({
    id: 'read',
    action: 'in.records',
    params: { collectionId: 't', period: 'all' },
  });
  expect(workflowProblems(w, registry)).toEqual([]);
  const email = wf('records.fill', {
    collectionId: 't',
    templatesTable: 'templates',
    kind: 'email',
    body: ['body'],
    subject: ['title'],
    recipient: ['email'],
  });
  email.steps.push({ id: 'next', action: 'text.copy', params: {} });
  expect(workflowProblems(email, registry)).toEqual([]);
});
it('removing a named column cleans its reference and removing the templates table removes the unusable action', () => {
  const w = wf();
  const c = config(w);
  const ctx = { registry, locale: 'en' as const, now: new Date() };
  const r = applyOps(c, [{ op: 'removeData', table: 't', field: 'name' }], ctx);
  expect(r.ok).toBe(true);
  if (r.ok)
    expect(
      (r.config.tools.find((t) => t.id === 'export') as QuickAction).steps[0]!.params.fields,
    ).toEqual(['createdAt']);
  const d = applyOps(config(fill()), [{ op: 'removeData', table: 'templates' }], ctx);
  expect(d.ok).toBe(true);
  if (d.ok) expect(d.config.tools.some((t) => t.id === 'export')).toBe(false);
});
it('keeps the output kind fixed in the quick-action settings', () => {
  const w = fill();
  w.steps[0]!.ask = ['kind'];
  expect(workflowProblems(w, registry)).toContainEqual(
    expect.objectContaining({
      code: 'ask',
      message: expect.stringContaining('fixed in the quick action settings'),
    }),
  );
});
it.each(['text', 'word', 'email'])(
  'chains %s template filling after in.records into the next compatible action',
  (kind) => {
    const w = wf('records.fill', {
      collectionId: 't',
      templatesTable: 'templates',
      kind,
      body: ['body'],
      subject: ['title'],
      document: ['doc'],
      recipient: ['email'],
    });
    w.steps.unshift({
      id: 'read',
      action: 'in.records',
      params: { collectionId: 't', period: 'all' },
    });
    w.steps.push({ id: 'next', action: kind === 'word' ? 'file.save' : 'text.copy', params: {} });
    expect(workflowProblems(w, registry)).toEqual([]);
    expect(errors(config(w))).toEqual([]);
  },
);
