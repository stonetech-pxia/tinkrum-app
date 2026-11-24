import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { appFileText, readAppFile, type AppFile } from './app-file';
import { appConfigFile, parseAppConfigFile } from './config-file';
import { missingUses, usesOf, USES_FEATURES } from './file-uses';
import { applyOps, type Op } from './ops';
import { createDefaultWorkspace } from './defaults';
import type { WorkspaceConfig } from './schema';
import { registry } from './test-helpers';

// Exported files include a "dependencies" manifest (D-556): Calculated from content and registries
// at export time, not stored in local config; upon import, compares against known versions and
// precisely reports any missing items. Files without this manifest behave as before.

const NOW = new Date(2026, 10, 16);
const PORTAL = join(__dirname, 'fixtures', 'portal-apps');

/** A configuration utilizing features added in D-537–D-552: table layout, galleries, computed dates, next 7 days, single choice, red highlight, columns. */
function rich(): WorkspaceConfig {
  const ops: Op[] = [
    {
      op: 'addData',
      table: {
        id: 'contracts',
        name: 'Contracts',
        icon: 'paper',
        fields: [
          { id: 'name', name: 'Name', type: 'text' },
          { id: 'start', name: 'Start', type: 'date' },
          { id: 'end', name: 'End', type: 'dateOffset', from: 'start', add: 12, unit: 'months' },
          {
            id: 'status',
            name: 'Status',
            type: 'choice',
            options: [
              { id: 'a', name: 'A' },
              { id: 'b', name: 'B' },
              { id: 'c', name: 'C' },
            ],
          },
        ],
      },
    } as Op,
    {
      op: 'addContainer',
      page: 'home',
      block: {
        id: 'grid',
        look: 'table',
        source: {
          table: 'contracts',
          filter: [
            { field: 'status', op: 'is', value: ['a', 'b'] },
            { field: 'end', op: 'inPeriod', value: 'next30days' },
          ],
        },
        show: {
          title: 'name',
          columns: ['end'],
          highlight: [{ field: 'status', op: 'is', value: 'c' }],
        },
      },
    } as Op,
    {
      op: 'addContainer',
      page: 'home',
      block: {
        id: 'pics',
        look: 'list',
        source: { table: 'contracts' },
        show: { title: 'name', color: 'status' },
      },
    } as Op,
    {
      op: 'addTool',
      tool: {
        id: 'q',
        kind: 'quickAction',
        name: 'Q',
        steps: [{ id: 's', action: 'in.photos', params: { source: 'files', min: 1, max: 5 } }],
      },
    } as Op,
  ];
  const r = applyOps(createDefaultWorkspace('en'), ops, { registry, locale: 'en' });
  if (!r.ok) throw new Error(r.error);
  return r.config;
}

const appFileBody = (
  config: WorkspaceConfig,
): Omit<AppFile, 'format' | 'version' | 'exportedAt'> => ({
  schemaVersion: config.schemaVersion,
  app: { id: 'x', name: 'X', bar: ['ai'], theme: config.theme },
  pages: config.containers.pages,
  tables: config.data.tables,
  tools: config.tools,
});

describe('what a file uses (D-556)', () => {
  it('lists looks, field types, actions, icons and the features added since v39', () => {
    const uses = usesOf(rich());
    expect(uses.looks).toEqual(expect.arrayContaining(['table', 'list']));
    expect(uses.fieldTypes).toEqual(expect.arrayContaining(['dateOffset', 'choice', 'date']));
    expect(uses.actions).toContain('in.photos');
    expect(uses.icons).toContain('paper');
    expect(uses.features).toEqual(
      expect.arrayContaining([
        'filterAnyOf',
        'periodNextDays',
        'showColumns',
        'showHighlight',
        'showColorAnyLook',
      ]),
    );
    // Sorted and deduplicated, producing identical results across runs.
    for (const list of Object.values(uses)) expect(list).toEqual([...new Set(list)].sort());
  });

  it('does not count emoji icons or a calendar colour', () => {
    const r = applyOps(
      createDefaultWorkspace('en'),
      [
        {
          op: 'addData',
          table: { id: 't', name: 'T', icon: '🌱', fields: [{ id: 'd', name: 'D', type: 'date' }] },
        } as Op,
      ],
      { registry, locale: 'en' },
    );
    if (!r.ok) throw new Error(r.error);
    const uses = usesOf(r.config);
    expect(uses.icons ?? []).not.toContain('🌱');
    expect(uses.features ?? []).toEqual([]);
  });

  it('both exported files carry the list next to the content, not inside it', () => {
    const config = rich();
    const app = JSON.parse(appFileText(appFileBody(config), NOW)) as Record<string, unknown>;
    expect(app.uses).toEqual(usesOf(appFileBody(config)));
    const whole = JSON.parse(appConfigFile(config, NOW)) as Record<string, unknown>;
    expect(whole.uses).toEqual(usesOf(config));
    expect((whole.config as Record<string, unknown>).uses).toBeUndefined();
    // Can still be successfully parsed by the reader (an extra outer-level key does not affect it).
    expect(readAppFile(JSON.stringify(app))).not.toBeNull();
    expect(parseAppConfigFile(JSON.stringify(whole)).ok).toBe(true);
  });

  it('this build knows everything it writes', () => {
    const text = appConfigFile(rich(), NOW);
    expect(missingUses(text, registry)).toEqual([]);
    for (const f of usesOf(rich()).features ?? []) expect(USES_FEATURES).toContain(f);
  });

  it('names exactly what this build does not have', () => {
    const text = JSON.stringify({
      format: 'tinkrum-app',
      version: 1,
      uses: {
        looks: ['list', 'hologram'],
        fieldTypes: ['text', 'mood'],
        actions: ['in.photos', 'pdf.teleport'],
        icons: ['folder', 'unicorn'],
        features: ['filterAnyOf', 'showSparkles'],
      },
    });
    expect(missingUses(text, registry)).toEqual([
      'hologram',
      'mood',
      'pdf.teleport',
      'unicorn',
      'showSparkles',
    ]);
  });

  it('a file without the list, or with a broken one, says nothing', () => {
    expect(
      missingUses(readFileSync(join(PORTAL, 'tinkrum-app-clay.json'), 'utf8'), registry),
    ).toEqual([]);
    expect(missingUses('{"format":"tinkrum-app","uses":"nope"}', registry)).toEqual([]);
    expect(missingUses('{"format":"tinkrum-app","uses":{"looks":[1,{}]}}', registry)).toEqual([]);
    expect(missingUses('not json', registry)).toEqual([]);
  });
});

/** Several blocks on a single page (does not need to be a valid config: usesOf only inspects structure). */
const pageWith = (...blocks: object[]) => ({ containers: { pages: [{ id: 'p', blocks }] } });

describe('features added in batch 1 (D-557–D-563)', () => {
  it('a single block showing the opened entry (D-558)', () => {
    const single = (source: object) => ({
      id: 's',
      look: 'single',
      source,
      show: { fields: ['name'] },
    });
    expect(usesOf(pageWith(single({ table: 't', record: '$record' }))).features).toEqual([
      'singleOpenedRecord',
    ]);
    expect(usesOf(pageWith(single({ table: 't' }))).features).toBeUndefined();
  });

  it('a record block following the page range (D-561), not a number or chart doing so', () => {
    const block = (look: string) => ({
      id: look,
      look,
      source: { table: 't', period: 'page' },
      show: { title: 'name' },
    });
    expect(usesOf(pageWith(block('cards'))).features).toEqual(['recordsFollowPagePeriod']);
    expect(usesOf(pageWith(block('number'), block('chart'))).features).toBeUndefined();
  });
});
