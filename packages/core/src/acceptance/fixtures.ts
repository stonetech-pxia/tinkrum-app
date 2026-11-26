import { prepareOps } from '../change';
import { createDefaultWorkspace } from '../defaults';
import type { Locale, WorkspaceConfig } from '../schema';
import { registry } from '../test-helpers';

// Config for acceptance tests: hand-written, runs through prepareOps (shares the same validator as
// AI modifications), proving these configs are genuinely accepted by the app. Not exported from
// index.ts.

/** Hand-written data, types guarded by the validator. */
export type Json = any;

export const text = (id: string, extra: object = {}) => ({ id, name: id, type: 'text', ...extra });
export const date = (id = 'date') => ({ id, name: id, type: 'date', default: 'today' });
export const money = (id = 'amount', extra: object = {}) => ({
  id,
  name: id,
  type: 'money',
  currency: 'USD',
  ...extra,
});
export const choice = (id: string, options: string[], extra: object = {}) => ({
  id,
  name: id,
  type: 'choice',
  options: options.map((o) => ({ id: o, label: o })),
  ...extra,
});
export const link = (id: string, table: string, extra: object = {}) => ({
  id,
  name: id,
  type: 'link',
  table,
  ...extra,
});
export const addTable = (id: string, fields: object[]) => ({
  op: 'addData',
  table: { id, name: id, fields },
});
export const addField = (table: string, field: object) => ({ op: 'addData', table, field });
export const addTool = (tool: object) => ({ op: 'addTool', tool });
export const addPage = (id: string, blocks: object[], extra: object = {}) => ({
  op: 'addContainer',
  page: { id, title: id, blocks, ...extra },
});
export const navTo = (...pages: string[]) => ({
  op: 'updateContainer',
  nav: { bar: ['page:home', ...pages.map((p) => `page:${p}`), 'settings'] },
});

export const form = (id: string, table: string, ask: string[], extra: object = {}) => ({
  id,
  look: 'form',
  show: { mode: 'inline' },
  tools: [{ as: 'submit', label: 'Save', do: 'create', table, ask, ...extra }],
});
export const button = (id: string, tool: object, label = 'Go') => ({
  id,
  look: 'button',
  show: { label, shape: 'filled' },
  tools: [tool],
});
export const records = (
  look: string,
  id: string,
  table: string,
  title: string,
  extra: { source?: object; show?: object; tools?: object[]; opens?: string } = {},
) => ({
  id,
  look,
  source: { table, limit: 30, ...extra.source },
  show: { title, ...extra.show },
  ...(extra.tools ? { tools: extra.tools } : {}),
  ...(extra.opens ? { opens: extra.opens } : {}),
});
export const number = (id: string, table: string, source: object) => ({
  id,
  look: 'number',
  show: { label: id },
  source: { table, ...source },
});
export const chart = (id: string, table: string, kind: string, source: object) => ({
  id,
  look: 'chart',
  show: { kind, title: id },
  source: { table, ...source },
});
export const reminder = (id: string, when: object, opens: string, extra: object = {}) => ({
  id,
  kind: 'reminder',
  title: id,
  enabled: true,
  when,
  opens,
  ...extra,
});
export const quickAction = (id: string, steps: [string, object][]) => ({
  id,
  kind: 'quickAction',
  name: id,
  steps: steps.map(([action, params], i) => ({ id: `s${i}`, action, params })),
});
export const scanInto = (id: string, table: string, source = 'scanner') =>
  quickAction(id, [
    ['in.photos', { source, min: 1, max: 10 }],
    ['scan.detect', {}],
    ['out.addRecord', { collectionId: table }],
  ]);
export const runAction = (id: string, tool: string) => ({ id, look: 'button', tools: [{ tool }] });

/** Operations run through the validator, returning config; fails immediately if validation fails. */
export function buildConfig(ops: readonly object[], locale: Locale = 'en'): WorkspaceConfig {
  const base = createDefaultWorkspace(locale);
  const prepared = prepareOps(base, ops as never, { registry, locale, now: new Date(0) });
  if (!prepared.ok) throw new Error(prepared.issues.join('\n'));
  return prepared.after;
}

/** A copy of the config, scored after changes (counterexamples do not need to pass validation). */
export function changed(config: WorkspaceConfig, change: (c: Json) => void): WorkspaceConfig {
  const copy = JSON.parse(JSON.stringify(config)) as WorkspaceConfig;
  change(copy);
  return copy;
}

const walk = (blocks: Json[]): Json[] =>
  blocks.flatMap((b) => [b, ...walk((b.children as Json[] | undefined) ?? [])]);

/** Find block by ID. */
export function blockIn(config: Json, id: string): Json {
  for (const page of config.containers.pages) {
    const hit = walk(page.blocks).find((b) => b.id === id);
    if (hit) return hit;
  }
  throw new Error(`no block ${id}`);
}

/** Delete block by ID. */
export function dropBlock(config: Json, id: string): void {
  blockIn(config, id);
  for (const page of config.containers.pages)
    page.blocks = page.blocks.filter((b: Json) => b.id !== id);
}

export const toolIn = (config: Json, id: string): Json => {
  const hit = config.tools.find((t: Json) => t.id === id);
  if (!hit) throw new Error(`no tool ${id}`);
  return hit;
};

export const tableIn = (config: Json, id: string): Json => {
  const hit = config.data.tables.find((t: Json) => t.id === id);
  if (!hit) throw new Error(`no table ${id}`);
  return hit;
};

export const fieldIn = (config: Json, table: string, id: string): Json => {
  const hit = tableIn(config, table).fields.find((f: Json) => f.id === id);
  if (!hit) throw new Error(`no field ${table}.${id}`);
  return hit;
};
