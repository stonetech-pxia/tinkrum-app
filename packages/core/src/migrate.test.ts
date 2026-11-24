import { describe, expect, it } from 'vitest';

import { prepareSnapshot } from './change';
import { migrateWorkspace, type Migration } from './migrate';
import { migratePageV33, v33Tables } from './migrate-v34';
import { fromV33, registry, v33Fixture, workspace } from './test-helpers';
import { V4_CUSTOM_ASK, V4_DEFAULT_MERGE, V4_FIXED_NAME } from './fixtures/v4';
import { DEFAULT_THEME } from './theme';
import { CURRENT_SCHEMA_VERSION, quickActionsOf } from './schema';

// Older version snapshots (v1…v33) upgraded to v34 through the complete migration chain (M13).
// Migrations prior to v33 only recognize v33 structure, so version-bump-only tests start from v33
// configurations (fixtures/v33/) instead of using v34 workspace().

type Json = Record<string, any>;
/** v33 default workspace (Chinese). */
const v33Default = () => v33Fixture('default-zh') as Json;
/** v33 default workspace has PDF tool installed. */
const v33WithPdf = () => v33Fixture('setup-pdf-zh') as Json;
/** v33 pages follow v34 block schema (migration result). */
const asV34Page = (page: unknown) => migratePageV33(page as Json, v33Tables([]));

/** Real schemaVersion 1 snapshot: PDF installed, navigation bar minimized, AI and history are floating buttons. */
const v1Snapshot = {
  schemaVersion: 1,
  theme: { primaryColor: '#3B5BDB', mode: 'system' },
  shell: { nav: ['page:home', 'tools', 'settings'], floating: ['ai', 'history'] },
  pages: [
    {
      id: 'home',
      title: '文件工作台',
      components: [
        { id: 'welcome', type: 'header', props: { title: '文件工作台', subtitle: '副标题' } },
        { id: 'card-pdf', type: 'toolCard', props: { toolId: 'pdf' } },
        { id: 'catalog', type: 'catalogLink', props: { title: '添加工具' } },
        { id: 'recent-files', type: 'fileList', props: { title: '最近文件', limit: 5 } },
      ],
    },
    {
      id: 'tool-pdf',
      title: 'PDF',
      toolId: 'pdf',
      components: [
        { id: 'pdf-header', type: 'header', props: { title: '合并 PDF' } },
        { id: 'pdf-runner', type: 'workflowRunner', props: { workflowId: 'pdf-merge' } },
      ],
    },
  ],
  tools: [{ toolId: 'pdf', version: '1.0.0', pageId: 'tool-pdf' }],
  workflows: [
    {
      id: 'pdf-merge',
      toolId: 'pdf',
      name: '合并 PDF',
      steps: [
        { id: 'select', action: 'pdf.selectFiles', params: { min: 2, max: 20 } },
        { id: 'merge', action: 'pdf.merge', params: {} },
        { id: 'save', action: 'file.save', params: { nameTemplate: '合并-{date:YYYY-MM-DD}' } },
      ],
    },
  ],
};

describe('migrateWorkspace', () => {
  it('v10 → v11 → v12 preserves the entire existing workspace', () => {
    const previous = { ...v33Default(), schemaVersion: 10 };
    const result = prepareSnapshot(previous, registry);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.after).toEqual(fromV33(previous));
    expect(previous.schemaVersion).toBe(10);
  });
  it('v19 → v20: the text recognition quick actions stop asking the language, unless the user changed them (D-278)', () => {
    const oldRead = (lang: string) => ({
      id: 'read',
      action: 'ocr.recognize',
      params: { lang },
      ask: ['lang'],
    });
    const photos = (lang: string) => ({
      id: 'ocr-photos',
      toolId: 'ocr',
      name: '识别照片里的文字',
      steps: [
        { id: 'pick', action: 'in.photos', params: { source: 'library', min: 1, max: 20 } },
        oldRead(lang),
      ],
    });
    const scan = {
      id: 'ocr-scan',
      toolId: 'ocr',
      name: '拍照识别文字',
      steps: [
        { id: 'shoot', action: 'in.photos', params: { source: 'scanner', min: 1, max: 10 } },
        { id: 'edges', action: 'scan.detect', params: {} },
        oldRead('fra'),
      ],
    };
    // User modifications (language changed, count changed, or custom quick actions) remain untouched.
    const picked = { ...photos('jpn') };
    const fewer = {
      ...photos('eng'),
      id: 'ocr-photos-2',
      steps: [
        { ...photos('eng').steps[0]!, params: { source: 'library', min: 1, max: 5 } },
        oldRead('eng'),
      ],
    };
    const own = { ...photos('chi_sim'), id: 'mine', toolId: undefined };
    const previous = {
      ...v33Default(),
      schemaVersion: 19,
      workflows: [photos('chi_sim'), scan, { ...picked, id: 'x' }, fewer, own],
    };
    const result = migrateWorkspace(previous, undefined, 20);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const after = (result.config as { workflows: { id: string; steps: unknown[] }[] }).workflows;
    const newRead = { id: 'read', action: 'ocr.recognize', params: { lang: 'auto' } };
    expect(after[0]!.steps[1]).toEqual(newRead);
    expect(after[1]!.steps[2]).toEqual(newRead);
    expect(after.slice(2)).toEqual(previous.workflows.slice(2));
    expect((result.config as { schemaVersion: number }).schemaVersion).toBe(20);
    // User who changed language in ocr-photos: untouched, continues to recognize text in the user's chosen language every time.
    const custom = { ...v33Default(), schemaVersion: 19, workflows: [picked] };
    const kept = migrateWorkspace(custom, undefined, 20);
    expect(kept.ok && (kept.config as { workflows: unknown[] }).workflows).toEqual([picked]);
  });
  it.each([
    {
      from: 35,
      to: 36,
      seed: v33Default,
      prepare: false,
      title: 'v35 → v36 (surfaceText, D-409) only raises the version; old themes keep every color',
    },
    {
      from: 32,
      to: 33,
      seed: v33WithPdf,
      prepare: true,
      title:
        'v32 → v33 (file room layout, D-358) only raises the version; the room uses its default layout',
    },
    {
      from: 31,
      to: 32,
      seed: v33WithPdf,
      prepare: false,
      title: 'v31 → v32 (board by a link, sheet quick add, D-351–D-352) only raises the version',
    },
    {
      from: 30,
      to: 31,
      seed: v33WithPdf,
      prepare: false,
      title:
        'v30 → v31 (schedule time, list sections, calendar on a schedule, add here, D-346–D-349) only raises the version',
    },
    {
      from: 29,
      to: 30,
      seed: v33WithPdf,
      prepare: false,
      title:
        'v29 → v30 (once, countEarly, record pages, form presets and smartDate, D-340–D-344) only raises the version',
    },
    {
      from: 28,
      to: 29,
      seed: v33WithPdf,
      prepare: false,
      title:
        'v28 → v29 (group by link, stat minus, create with form, D-336–D-338) only raises the version',
    },
    {
      from: 26,
      to: 27,
      seed: v33WithPdf,
      prepare: true,
      title: 'v26 → v27 (tiles and board lists, D-311–D-314) only raises the version',
    },
    {
      from: 25,
      to: 26,
      seed: v33WithPdf,
      prepare: true,
      title:
        'v25 → v26 (calendar list, trailing formats, stat goal and compare, D-305–D-309) only raises the version',
    },
    {
      from: 24,
      to: 25,
      seed: v33WithPdf,
      prepare: true,
      title: 'v24 → v25 (one-tap record actions, D-300–D-304) only raises the version',
    },
    {
      from: 23,
      to: 24,
      seed: v33WithPdf,
      prepare: true,
      title: 'v23 → v24 (schedule fields and the due filter, D-292–D-296) only raises the version',
    },
    {
      from: 22,
      to: 23,
      seed: v33WithPdf,
      prepare: true,
      title: 'v22 → v23 (lookup, rollup and previous fields, D-287–D-289) only raises the version',
    },
    {
      from: 21,
      to: 22,
      seed: v33WithPdf,
      prepare: true,
      title:
        'v21 → v22 (day-based aggregates, new periods and calendar, D-284–D-286) only raises the version',
    },
    {
      from: 20,
      to: 21,
      seed: v33WithPdf,
      prepare: true,
      title: 'v20 → v21 (time fields and formula upgrade, D-279–D-281) only raises the version',
    },
    {
      from: 17,
      to: 18,
      seed: v33Default,
      prepare: true,
      title: 'v17 → v18 (picture backgrounds, D-258) only raises the version',
    },
    {
      from: 16,
      to: 17,
      seed: v33Default,
      prepare: false,
      title: 'v16 → v17 (buttons open quick actions, D-256) only raises the version',
    },
    {
      from: 15,
      to: 16,
      seed: v33Default,
      prepare: false,
      title: 'v15 → v16 (reminders, D-251) only raises the version',
    },
    {
      from: 14,
      to: 15,
      seed: v33Default,
      prepare: false,
      title: 'v14 → v15 (link field, D-250) only raises the version',
    },
    {
      from: 13,
      to: 14,
      seed: v33Default,
      prepare: false,
      title: 'v13 → v14 (chart, D-249) only raises the version',
    },
    {
      from: 12,
      to: 13,
      seed: v33Default,
      prepare: true,
      title: 'v12 → v13 (stat groupBy, D-248) only raises the version',
    },
  ])('$title', ({ from, to, seed, prepare }) => {
    const previous = { ...seed(), schemaVersion: from };
    expect(migrateWorkspace(previous, undefined, to)).toEqual({
      ok: true,
      config: { ...previous, schemaVersion: to },
      fromVersion: from,
    });
    if (prepare) expect(prepareSnapshot(previous, registry).ok).toBe(true);
  });

  it('v27 → v28 (reminders per entry, D-316–D-318) only raises the version and keeps reminders', () => {
    const daily = {
      id: 'log',
      title: '记账',
      enabled: true,
      schedule: 'daily',
      time: '09:00',
      opens: 'page:home',
    };
    const previous = {
      ...v33WithPdf(),
      schemaVersion: 27,
      reminders: [daily],
    };
    expect(migrateWorkspace(previous, undefined, 28)).toEqual({
      ok: true,
      config: { ...previous, schemaVersion: 28 },
      fromVersion: 27,
    });
    expect(prepareSnapshot(previous, registry).ok).toBe(true);
  });
  it('v18 → v19 (quick actions on the phone home screen, D-271) only raises the version', () => {
    const previous = { ...v33WithPdf(), schemaVersion: 18 };
    expect((previous as Json).workflows.length).toBeGreaterThan(0);
    expect(migrateWorkspace(previous, undefined, 19)).toEqual({
      ok: true,
      config: { ...previous, schemaVersion: 19 },
      fromVersion: 18,
    });
    const prepared = prepareSnapshot(previous, registry);
    expect(prepared.ok).toBe(true);
    // No quick action is placed on the home screen after upgrade: user-unspecified ones do not appear on the phone desktop.
    if (prepared.ok) expect(prepared.after.nav.phoneHomeScreen).toBeUndefined();
  });
  it('v9 → v10 preserves the existing home without adding file pickers', () => {
    const previous = { ...v33Default(), schemaVersion: 9 };
    const original = structuredClone(previous);
    const result = prepareSnapshot(previous, registry);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.after).toEqual(fromV33(previous));
    expect(previous).toEqual(original);
  });

  it('upgrades a real v1 snapshot into a valid v2 config with the default style', () => {
    const result = prepareSnapshot(v1Snapshot, registry);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Unmodified v1 default primary color changes to Clay primary color; appearance mode is preserved.
    expect(result.after.theme).toEqual({ ...DEFAULT_THEME, mode: 'system' });
    expect(result.after.nav).toEqual({
      bar: v1Snapshot.shell.nav,
      floating: v1Snapshot.shell.floating,
    });
    expect(result.after.containers.pages[0]).toEqual(
      asV34Page({ ...v1Snapshot.pages[0], icon: 'home' }),
    );
    expect(result.after.containers.pages[1]).toEqual(asV34Page(v1Snapshot.pages[1]));
    expect(result.after.packages).toEqual([{ id: 'pdf', version: '1.0.0', page: 'tool-pdf' }]);
  });

  it('keeps a color the user chose, and puts Settings back where v1 allowed it to be missing', () => {
    const custom = {
      ...v1Snapshot,
      theme: { primaryColor: '#2F9E44', mode: 'dark' },
      shell: { nav: ['page:home', 'ai', 'history'], floating: [] },
    };
    const result = prepareSnapshot(custom, registry);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.after.theme).toMatchObject({ primaryColor: '#2F9E44', mode: 'dark' });
    expect(result.after.nav.bar).toEqual(['page:home', 'ai', 'history', 'settings']);

    const fullNav = {
      ...v1Snapshot,
      shell: { nav: ['page:home', 'tools', 'ai', 'history', 'page:tool-pdf'], floating: [] },
    };
    const full = prepareSnapshot(fullNav, registry);
    expect(full.ok && full.after.nav.floating).toEqual(['settings']);
  });

  it('turns the v1 merge workflow into typed steps with a fixed name', () => {
    const result = prepareSnapshot(v1Snapshot, registry);
    expect(result.ok && quickActionsOf(result.after)[0]!.steps).toEqual([
      { id: 'select', action: 'in.files', params: { accept: 'pdf', min: 2, max: 20 } },
      { id: 'merge', action: 'pdf.merge', params: {} },
      { id: 'name', action: 'file.rename', params: { template: '合并-{date:YYYY-MM-DD}' } },
      { id: 'save', action: 'file.save', params: {} },
    ]);
  });

  it('v4 → v5: the default merge asks for the file name at the rename step', () => {
    const result = prepareSnapshot(V4_DEFAULT_MERGE, registry);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.after.tools).toEqual([
      {
        id: 'pdf-merge',
        kind: 'quickAction',
        package: 'pdf',
        name: '合并 PDF',
        steps: [
          { id: 'select', action: 'in.files', params: { accept: 'pdf', min: 2, max: 20 } },
          { id: 'merge', action: 'pdf.merge', params: {} },
          {
            id: 'name',
            action: 'file.rename',
            params: { template: '{sourceName}-合并' },
            ask: ['template'],
          },
          { id: 'save', action: 'file.save', params: {} },
        ],
      },
    ]);
    // Pages and other configurations remain unchanged.
    expect(result.after.containers.pages).toEqual(V4_DEFAULT_MERGE.pages.map(asV34Page));
  });

  it('v4 → v5: a workflow that no longer asked keeps its fixed name template', () => {
    const result = prepareSnapshot(V4_FIXED_NAME, registry);
    expect(result.ok && quickActionsOf(result.after)[0]!.steps.slice(2)).toEqual([
      { id: 'name', action: 'file.rename', params: { template: '合并-{date:YYYY-MM-DD}' } },
      { id: 'save', action: 'file.save', params: {} },
    ]);
  });

  it('v4 → v5: the name the user was asked with wins over the save template', () => {
    const result = prepareSnapshot(V4_CUSTOM_ASK, registry);
    expect(result.ok && quickActionsOf(result.after)[0]!.steps).toEqual([
      { id: 'select', action: 'in.files', params: { accept: 'pdf', min: 3, max: 5 } },
      { id: 'merge', action: 'pdf.merge', params: {} },
      {
        id: 'name',
        action: 'file.rename',
        params: { template: '材料-{date:YYYYMMDD}' },
        ask: ['template'],
      },
      { id: 'save', action: 'file.save', params: {} },
    ]);
  });
  it.each([5, 6, 8])(
    'v%i: version-only additions preserve the workspace through all later migrations',
    (schemaVersion) => {
      const previous = { ...v33Default(), schemaVersion };
      const result = prepareSnapshot(previous, registry);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.after).toEqual(workspace());
    },
  );

  it('refuses snapshots it cannot migrate', () => {
    const v0 = { ...v1Snapshot, schemaVersion: 0 };
    expect(migrateWorkspace(v0)).toEqual({ ok: false, error: 'no migration from schemaVersion 0' });
    expect(migrateWorkspace({ schemaVersion: CURRENT_SCHEMA_VERSION + 1 }).ok).toBe(false);
    expect(migrateWorkspace('garbage').ok).toBe(false);
  });

  it('refuses a migration that does not bump the version', () => {
    const broken: Record<number, Migration> = { 1: (c) => c };
    expect(migrateWorkspace(v1Snapshot, broken).ok).toBe(false);
  });

  it('prepareSnapshot accepts current snapshots and rejects invalid ones', () => {
    expect(prepareSnapshot(workspace(), registry).ok).toBe(true);
    const invalid = { ...workspace(), nav: { bar: ['page:home'], floating: [] } };
    const result = prepareSnapshot(invalid, registry);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stage).toBe('validate');
  });

  // v37 → v38 (D-483): old home page "toolbox" entry (outlined button) upgraded to row; other buttons and data remain unchanged.
  it('v37 → v38 turns the home toolbox entry into a row and leaves other buttons alone', () => {
    const current = workspace('zh');
    const entry = (id: string, opens: string, variant: string) => ({
      id,
      look: 'button',
      show: { label: '工具箱', variant, icon: 'apps' },
      opens,
    });
    const old = {
      ...current,
      schemaVersion: 37,
      containers: {
        ...current.containers,
        pages: current.containers.pages.map((p) =>
          p.id === 'home'
            ? {
                ...p,
                blocks: [
                  entry('toolbox-entry', 'page:toolbox', 'outline'),
                  entry('other', 'settings', 'outline'),
                  entry('filled-toolbox', 'page:toolbox', 'filled'),
                ],
              }
            : p,
        ),
      },
    };
    const result = migrateWorkspace(old);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const migrated = result.config as typeof current;
    const home = migrated.containers.pages.find((p) => p.id === 'home')!;
    const variants = Object.fromEntries(
      home.blocks.map((b) => [b.id, (b as { show: { variant: string } }).show.variant]),
    );
    expect(variants).toEqual({
      'toolbox-entry': 'row',
      other: 'outline',
      'filled-toolbox': 'filled',
    });
    expect(migrated.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });
});
