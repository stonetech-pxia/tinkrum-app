import { describe, expect, it } from 'vitest';

import { prepareOps } from './change';
import { createStarterWorkspace } from './starter';
import type { Op } from './ops-schema';
import { draftTable } from './templates';
import { withCurrency } from './new-table';
import { draftReceiptSample, SAMPLE_APPS, sampleInfo, sampleOps, type SampleApp } from './samples';
import {
  HOME_PAGE_ID,
  allComponents,
  isKnownComponent,
  quickActionsOf,
  remindersOf,
  type Locale,
  type WorkspaceConfig,
  type BlockOf,
} from './schema';
import {
  apply,
  fromV33,
  registry,
  v33Fixture,
  withScanKeep,
  withStarterTheme,
  workspace,
} from './test-helpers';
import { recordToVCard } from './vcard';
import { validateWorkspace } from './validate';
import { CONTAINER_PRESETS, presetById, presetWorkflow } from './workflows/presets';

// Sample apps (samples/*.json, D-260): Each sample under all three languages must pass validation
// for new users, existing tables/pages with duplicate names, full navigation bars, and near-limit
// configurations; all references must point to remapped IDs; presets when expanded must match
// user-added entries.

const LOCALES: Locale[] = ['en', 'zh', 'fr'];

function ops(sample: SampleApp, config: WorkspaceConfig, locale: Locale): Op[] {
  const result = sampleOps(sample, config, locale);
  if (!result.ok) throw new Error(result.message);
  return result.ops;
}

/** New user: Home screen before onboarding is empty, navigation bar contains only Home, AI, and Settings. */
const fresh = (locale: Locale) => createStarterWorkspace(locale, registry);

/** Already contains tables, pages, quick actions, or reminders with the same name as the sample: apply the same sample once first (plus any preset IDs it uses). */
function crowded(sample: SampleApp, locale: Locale): WorkspaceConfig {
  const base = fresh(locale);
  return apply(base, ops(sample, base, locale), locale);
}

/** Navigation bar is full (default workspace: Home, Tools, AI, History, Settings). */
const navFull = (locale: Locale) => workspace(locale);

/** Add a few tables and pages so that both tables and pages have only room spare slots remaining. */
function nearLimit(locale: Locale, room: { tables: number; pages: number }): WorkspaceConfig {
  let config = fresh(locale);
  const extra: Op[] = [];
  for (let i = config.data.tables.length; i < 20 - room.tables; i++)
    extra.push({
      op: 'addData',
      table: {
        id: `t${i}`,
        name: `T${i}`,
        fields: [{ id: 'name', name: 'Name', type: 'text' }],
      },
    });
  for (let i = config.containers.pages.length; i < 20 - room.pages; i++)
    extra.push({
      op: 'addContainer',
      page: {
        id: `p${i}`,
        title: `P${i}`,
        blocks: [{ id: 'h', look: 'header', show: { title: `P${i}` } }],
      },
    });
  config = apply(config, extra, locale);
  return config;
}

const added = (before: WorkspaceConfig, after: WorkspaceConfig) => ({
  tables: new Set(
    after.data.tables
      .filter((c) => !before.data.tables.some((x) => x.id === c.id))
      .map((c) => c.id),
  ),
  pages: new Set(
    after.containers.pages
      .filter((p) => !before.containers.pages.some((x) => x.id === p.id))
      .map((p) => p.id),
  ),
  workflows: new Set(
    quickActionsOf(after)
      .filter((w) => !before.tools.some((x) => x.id === w.id))
      .map((w) => w.id),
  ),
  reminders: remindersOf(after).filter((r) => !before.tools.some((x) => x.id === r.id)),
});

/**
 * All references in a configuration JSON: tables (table, table in when.before / each, step
 * parameter collectionId), quick actions ({tool: id}, excluding $pick.*), page:x, tool:x.
 */
function refsIn(
  value: unknown,
  out = { tables: [] as string[], pages: [] as string[], workflows: [] as string[] },
) {
  if (Array.isArray(value)) value.forEach((v) => refsIn(v, out));
  else if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      if ((k === 'table' || k === 'collectionId') && typeof v === 'string') {
        if (!v.startsWith('$')) out.tables.push(v);
      } else if (k === 'tool' && typeof v === 'string') {
        // Built-in quick actions used by containers (D-428) are not added, they are referenced directly.
        if (!v.startsWith('$') && !CONTAINER_PRESETS.some((p) => p.id === v)) out.workflows.push(v);
      } else if (typeof v === 'string' && v.startsWith('page:')) out.pages.push(v.slice(5));
      else if (typeof v === 'string' && v.startsWith('tool:')) out.workflows.push(v.slice(5));
      else refsIn(v, out);
    }
  }
  return out;
}

function expectValid(config: WorkspaceConfig) {
  const valid = validateWorkspace(config, registry);
  expect(valid.ok ? [] : valid.issues).toEqual([]);
}

describe.each(SAMPLE_APPS)('sample %s', (sample) => {
  describe.each(LOCALES)('in %s', (locale) => {
    const cases: [string, () => WorkspaceConfig][] = [
      ['a new user', () => fresh(locale)],
      ['a config that already has its tables and pages', () => crowded(sample, locale)],
      ['a full navigation bar', () => navFull(locale)],
      ['a config with exactly enough room', () => nearLimit(locale, { tables: 2, pages: 3 })],
    ];

    it.each(cases)('applies to %s and validates', (_name, make) => {
      const before = make();
      const result = sampleOps(sample, before, locale);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const after = apply(before, result.ops, locale);
      expectValid(after);
      // App execution path: at most 30 operations per modification, parsing, application, and validation must all succeed (prepareOps).
      const prepared = prepareOps(before, result.ops, { registry, locale, now: new Date() });
      expect(prepared.ok ? [] : prepared.issues).toEqual([]);

      // All text seen by the user is translated to this language, leaving no { en, zh, fr } or placeholders ($files, $row, etc., are configuration keywords, not placeholders).
      expect(JSON.stringify(after)).not.toMatch(/"en":|\$(table|page|tool)\./);
      // Do not modify the style theme (D-260).
      expect(after.theme).toEqual(before.theme);

      const fresh = added(before, after);
      expect(fresh.pages.has(result.mainPageId)).toBe(true);
      // Tables, pages, and quick actions referenced by newly added content are all newly created for this addition (remapped IDs), and do not point to existing ones with the same name.
      const content = [
        ...after.data.tables.filter((c) => fresh.tables.has(c.id)),
        ...after.containers.pages.filter((p) => fresh.pages.has(p.id)),
        ...quickActionsOf(after).filter((w) => fresh.workflows.has(w.id)),
        ...fresh.reminders,
      ];
      const refs = refsIn(content);
      expect(refs.tables.length).toBeGreaterThan(0);
      for (const id of refs.tables) expect(fresh.tables).toContain(id);
      for (const id of refs.pages) expect(fresh.pages).toContain(id);
      for (const id of refs.workflows) expect(fresh.workflows).toContain(id);
      // Every newly added quick action has an entry point on the sample's pages.
      const runners = new Set(refs.workflows);
      for (const id of fresh.workflows) expect(runners).toContain(id);

      // Main page has an entry point: in the navigation bar if there is space, otherwise added as a quick entry on the home screen.
      const target = `page:${result.mainPageId}`;
      const home = after.containers.pages.find((p) => p.id === HOME_PAGE_ID)!;
      const onHome = allComponents(home).some(
        (c) => isKnownComponent(c) && c.look === 'button' && c.opens === target,
      );
      if (before.nav.bar.length < 5) {
        expect(after.nav.bar).toContain(target);
        expect(after.nav.bar.at(-1)).toBe('settings');
      } else {
        expect(after.nav.bar).toEqual(before.nav.bar);
        expect(onHome).toBe(true);
      }
      // Home screen component references are also new.
      const homeRefs = refsIn(
        allComponents(home).filter(
          (c) =>
            !allComponents(before.containers.pages.find((p) => p.id === HOME_PAGE_ID)!).some(
              (x) => x.id === c.id,
            ),
        ),
      );
      for (const id of homeRefs.workflows) expect(fresh.workflows).toContain(id);
      for (const id of homeRefs.pages) expect(fresh.pages).toContain(id);
    });

    it('expands presets exactly like adding them yourself', () => {
      for (const make of [() => fresh(locale), () => crowded(sample, locale)]) {
        const before = make();
        for (const op of ops(sample, before, locale)) {
          if (op.op !== 'addTool' || typeof op.tool === 'string') continue;
          if (op.tool.kind !== 'quickAction' || !op.tool.preset) continue;
          const preset = presetById(op.tool.preset)!;
          expect(op.tool).toEqual(presetWorkflow(preset, locale, op.tool.id));
        }
      }
    });

    it('uses new ids when the old ones are taken', () => {
      const once = crowded(sample, locale);
      const before = fresh(locale);
      const first = added(before, once);
      const twice = apply(once, ops(sample, once, locale), locale);
      const second = added(once, twice);
      expect(second.tables.size).toBe(first.tables.size);
      expect(second.pages.size).toBe(first.pages.size);
      expect(second.workflows.size).toBe(first.workflows.size);
      expect(second.reminders.length).toBe(first.reminders.length);
      for (const id of second.tables) expect(first.tables.has(id)).toBe(false);
      for (const id of second.pages) expect(first.pages.has(id)).toBe(false);
      // Both times they were placed in the navigation bar (new user navigation bar has two empty slots).
      expect(twice.nav.bar).toHaveLength(5);
    });

    it('refuses with a reason when the tables or pages do not fit', () => {
      const name = sampleInfo(sample, locale).name;
      const tables = sampleOps(sample, nearLimit(locale, { tables: 0, pages: 10 }), locale);
      expect(tables).toMatchObject({ ok: false, problem: 'tables' });
      if (!tables.ok) expect(tables.message).toContain(name);
      const pages = sampleOps(sample, nearLimit(locale, { tables: 10, pages: 0 }), locale);
      expect(pages).toMatchObject({ ok: false, problem: 'pages' });
      if (!pages.ok) expect(pages.message).toContain(name);
    });
  });
});

describe('sample files', () => {
  it('every text has all three languages and every list entry has a name and a summary', () => {
    for (const sample of SAMPLE_APPS) {
      for (const locale of LOCALES) {
        const info = sampleInfo(sample, locale);
        expect(info.name.length).toBeGreaterThan(0);
        expect(info.summary.length).toBeGreaterThan(0);
      }
      // Configuration structure is identical across all three languages, differing only in text (preset-expanded steps naturally vary by language, e.g., translation target).
      const shape = (locale: Locale) =>
        JSON.stringify(
          ops(sample, fresh(locale), locale).filter(
            (op) =>
              op.op !== 'addTool' ||
              typeof op.tool === 'string' ||
              op.tool.kind !== 'quickAction' ||
              !op.tool.preset,
          ),
          // Default currency follows language (D-429), speech-to-text language follows language (D-576), considered as text.
          (k, v: unknown) =>
            typeof v === 'string' && (k === 'default' || k === 'lang' || !/^[a-z0-9:-]+$/.test(v))
              ? 'TEXT'
              : v,
        );
      // English uses Letter paper, Chinese and French use A4.
      expect(shape('fr')).toBe(shape('zh'));
    }
  });

  it('the samples use different main page ids', () => {
    let config = fresh('zh');
    const mains = new Set<string>();
    for (const sample of SAMPLE_APPS) {
      const result = sampleOps(sample, config, 'zh');
      if (!result.ok) throw new Error(result.message);
      mains.add(result.mainPageId);
      config = apply(config, result.ops, 'zh');
    }
    expect(mains.size).toBe(SAMPLE_APPS.length);
    expectValid(config);
    // After the navigation bar is full, subsequent sample main pages are placed in home screen quick entries.
    expect(config.nav.bar).toHaveLength(5);
  });

  it('refuses when the reminders or the home page are full', () => {
    let config = fresh('en');
    const reminders: Op[] = Array.from({ length: 20 }, (_, i) => ({
      op: 'addTool',
      tool: {
        id: `r${i}`,
        kind: 'reminder',
        title: 'R',
        enabled: false,
        when: { every: 'day', at: '09:00' },
        opens: 'page:home',
      },
    }));
    config = apply(config, reminders, 'en');
    expect(sampleOps('baby-growth', config, 'en')).toMatchObject({
      ok: false,
      problem: 'reminders',
    });

    let full = navFull('en');
    const fill: Op[] = [];
    const home = full.containers.pages.find((p) => p.id === HOME_PAGE_ID)!;
    for (let i = home.blocks.length; i < 30; i++)
      fill.push({
        op: 'addContainer',
        page: HOME_PAGE_ID,
        block: { id: `d${i}`, look: 'spacer', show: { size: 'small', line: true } },
      });
    full = apply(full, fill, 'en');
    expect(sampleOps('baby-growth', full, 'en')).toMatchObject({ ok: false, problem: 'home' });
  });
});

describe('sample expense-helper', () => {
  // Receipt scanner sample: without parameters it only applies general rules, and does not ask whether an expense was logged (D-421, D-426).
  it('its table reads attachments as receipts', () => {
    const base = fresh('en');
    const config = apply(base, ops('expense-helper', base, 'en'), 'en');
    const table = config.data.tables.find((t) => t.fields.some((f) => f.id === 'receipt'));
    expect(table?.prefillRules).toBe('receipt');
  });
});

describe('samples equal the v33 samples, migrated', () => {
  /** The new user's first version when the fixtures were made: an empty home page and the toolbox. */
  const oldStarter = () => withStarterTheme(withScanKeep(fromV33(v33Fixture('starter-zh'))));
  // fixtures/v33/sample-<id>-zh.json: Results of applying samples to new users (starter) under v33
  // code. Business card sample (D-423) and receipt sample (D-437) were added after v34 and do not
  // have v33 counterparts. Expense claim assistant (D-425, D-427) has extra print with attachments
  // and Excel export, checked separately below.
  it.each(
    SAMPLE_APPS.filter(
      (s) =>
        s !== 'business-cards' && s !== 'expense-helper' && s !== 'receipts' && s !== 'visa-docs',
    ),
  )('%s in zh', (sample) => {
    const before = oldStarter();
    expect(apply(before, ops(sample, before, 'zh'), 'zh')).toEqual(
      // Old sample copy uses the old name Morph (D-435); compared only for structure and remaining content, fixed samples are unchanged.
      JSON.parse(
        JSON.stringify(
          withStarterTheme(withScanKeep(fromV33(v33Fixture(`sample-${sample}-zh`)))),
        ).replaceAll('Morph', 'Tinkrum'),
      ),
    );
  });

  it('visa-docs in zh differs only by the "expire within 30 days" count (D-537)', () => {
    const before = oldStarter();
    const config = structuredClone(apply(before, ops('visa-docs', before, 'zh'), 'zh'));
    const page = config.containers.pages.find((p) => p.id === 'my-ids')!;
    const expiring = page.blocks.find((b) => b.id === 'expiring');
    expect(expiring).toMatchObject({ look: 'number' });
    expect((expiring as { source?: unknown }).source).toMatchObject({
      filter: [{ field: 'expires', op: 'inPeriod', value: 'next30days' }],
    });
    page.blocks = page.blocks.filter((b) => b.id !== 'expiring');
    expect(config).toEqual(
      JSON.parse(
        JSON.stringify(
          withStarterTheme(withScanKeep(fromV33(v33Fixture('sample-visa-docs-zh')))),
        ).replaceAll('Morph', 'Tinkrum'),
      ),
    );
  });

  it('expense-helper in zh differs only by the receipt rules, the attachments switch and the Excel export', () => {
    const before = oldStarter();
    const config = structuredClone(apply(before, ops('expense-helper', before, 'zh'), 'zh'));
    const claims = config.data.tables.find((t) => t.prefillRules === 'receipt')!;
    delete claims.prefillRules;
    // D-429: Each entry selects its currency individually, so an extra currency field is added, and pie charts are changed to count entries (different currencies cannot be summed together).
    claims.fields = claims.fields.filter((f) => f.id !== 'currency');
    const amount = claims.fields.find((f) => f.id === 'amount')!;
    expect(amount).toMatchObject({ type: 'money', currency: 'CNY', currencyField: 'currency' });
    delete (amount as { currencyField?: string }).currencyField;
    const print = quickActionsOf(config).find((q) => q.id === 'print-expenses')!;
    const step = print.steps.find((s) => s.action === 'print.records')!;
    expect(step.params.attachments).toBe(true);
    delete step.params.attachments;
    const excel = quickActionsOf(config).find((q) => q.id === 'export-expenses-excel')!;
    expect(excel.steps.map((s) => s.action)).toEqual([
      'in.records',
      'records.toExcel',
      'out.share',
    ]);
    config.tools = config.tools.filter((x) => x.id !== excel.id);
    const without = JSON.stringify(config, (_key, value: unknown) => {
      if (Array.isArray(value)) return value.filter((v: { id?: string }) => v?.id !== 'run-excel');
      const block = value as { id?: string; show?: { title?: string }; source?: object };
      if (block?.id === 'by-category') {
        expect(block.show?.title).toBe('各类笔数');
        expect(block.source).toMatchObject({ aggregate: 'count' });
        return {
          ...block,
          show: { ...block.show, title: '各类花费' },
          source: { ...block.source, aggregate: 'sum', field: 'amount' },
        };
      }
      return value;
    });
    expect(JSON.parse(without)).toEqual(
      withStarterTheme(withScanKeep(fromV33(v33Fixture('sample-expense-helper-zh')))),
    );
  });

  it('a reminder whose id a quick action already uses gets a new id (one id space, M1)', () => {
    const base = oldStarter();
    const taken = apply(
      base,
      [
        {
          op: 'addTool',
          tool: {
            id: 'submit-expenses',
            kind: 'quickAction',
            name: 'X',
            steps: [{ id: 'a', action: 'in.files', params: {} }],
          },
        },
      ],
      'zh',
    );
    const result = sampleOps('expense-helper', taken, 'zh');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const after = apply(taken, result.ops, 'zh');
    const ids = after.tools.map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(remindersOf(after).map((r) => r.id)).toEqual(['submit-expenses-2']);
  });
});

describe('the business card sample (D-423)', () => {
  const applied = (locale: Locale) => {
    const base = fresh(locale);
    return apply(base, ops('business-cards', base, locale), locale);
  };

  it.each(LOCALES)(
    'both tables use the card rules and their fields read as a card in %s',
    (locale) => {
      const config = applied(locale);
      const tables = config.data.tables.filter((t) => t.id === 'contacts' || t.id === 'my-card');
      expect(tables.map((t) => t.prefillRules)).toEqual(['card', 'card']);
      for (const table of tables) {
        const text = recordToVCard(table.fields, {
          name: 'A B',
          title: 'CTO',
          company: 'Acme',
          phone: '555 0100',
          email: 'a@example.com',
          website: 'example.com',
          address: 'Main St',
          note: 'private',
          tags: ['private-tag'],
        })!;
        expect(text.split('\r\n')).toEqual(
          expect.arrayContaining([
            'FN:A B',
            'TITLE:CTO',
            'ORG:Acme',
            'TEL:555 0100',
            'EMAIL:a@example.com',
            'URL:https://example.com',
            'ADR:;;Main St;;;;',
          ]),
        );
        expect(text).not.toContain('private');
      }
      // Contacts have an extra tags field, everything else is identical.
      expect(tables[0]!.fields.map((f) => f.id).filter((id) => id !== 'tags')).toEqual(
        tables[1]!.fields.map((f) => f.id),
      );
    },
  );

  it('entering it is the contacts list: no header, search fixed on top, My card and the dial fixed below', () => {
    const config = applied('en');
    const page = config.containers.pages.find((p) => p.id === 'contacts')!;
    expect(page.blocks.map((b) => [b.look, 'pin' in b ? b.pin : undefined])).toEqual([
      ['list', undefined],
      ['button', 'bottom'],
      ['dial', 'bottom'],
    ]);
    const list = page.blocks[0] as BlockOf<'list'>;
    expect(list.show.browse).toEqual({
      search: true,
      sort: ['name', 'company', 'createdAt'],
      filter: ['tags'],
      pin: true,
    });
    expect(list.tools).toBeUndefined();
    const dial = page.blocks[2] as BlockOf<'dial'>;
    expect(dial.tools.map((u) => u.as ?? ('do' in u ? u.do : 'run'))).toEqual([
      'run',
      'create',
      'list',
    ]);
    expect(config.data.tables[0]!.fields.some((f) => f.id === 'group')).toBe(false);
  });

  it('scanning ends in the right table, and export starts from the records the list hands over', () => {
    const config = applied('en');
    const steps = (id: string) =>
      quickActionsOf(config)
        .find((q) => q.id === id)!
        .steps.map((s) => [s.action, s.params.collectionId]);
    const scan = (table: string) => [
      ['in.photos', undefined],
      ['scan.detect', undefined],
      ['out.addRecord', table],
    ];
    expect(steps('scan-card')).toEqual(scan('contacts'));
    expect(steps('scan-my-card')).toEqual(scan('my-card'));
    // Export is triggered from the contacts list, passing currently selected records from the list to the first step (D-428).
    expect(steps('export-contacts')).toEqual([
      ['records.toVCard', undefined],
      ['out.share', undefined],
    ]);
  });

  it('my card page shows the card or the two ways to make one, never both', () => {
    const page = applied('en').containers.pages.find((p) => p.id === 'my-card')!;
    const when = page.blocks.map((b) => [b.id, isKnownComponent(b) ? b.showIf?.has : undefined]);
    expect(when).toEqual([
      ['title', undefined],
      ['card', 'some'],
      ['none', 'none'],
      ['by-hand', 'none'],
      ['scan', 'none'],
    ]);
  });
});

describe('draftReceiptSample (shopping voucher selected in new form page, D-479)', () => {
  it.each(LOCALES)(
    'Fields and table names unmodified: complete "Receipt" preset, the built table is the target table for records (%s)',
    (locale) => {
      const config = workspace(locale);
      const table = draftTable('purchase', config, locale);
      const got = draftReceiptSample(table, 'purchase', config, locale);
      expect(got).not.toBeNull();
      const added = apply(config, got!.ops, locale);
      expect(added.data.tables.map((c) => c.id)).toEqual([got!.table.id]);
      expect(got!.table.id).toBe('receipts');
      expect(got!.table.name).toBe(sampleInfo('receipts', locale).name);
      expect(added.data.tables[0]!.prefillRules).toBe('receipt');
      // Full suite: list page, expense page, scan, log an expense via voice (D-576), and export quick actions.
      expect(added.containers.pages.map((p) => p.id)).toEqual(
        expect.arrayContaining(['receipts', 'spending']),
      );
      expect(quickActionsOf(added).map((w) => w.id)).toEqual([
        'scan-receipt',
        'voice-receipt',
        'export-receipts-excel',
      ]);
    },
  );

  it('Currency of amount matches the draft (determined by symbol on the file, D-548)', () => {
    const config = workspace('en');
    const table = withCurrency(draftTable('purchase', config, 'en'), 'MYR');
    const got = draftReceiptSample(table, 'purchase', config, 'en')!;
    const added = apply(config, got.ops, 'en');
    const money = (c: { fields: { type: string; currency?: string | undefined }[] }) =>
      c.fields.filter((f) => f.type === 'money').map((f) => f.currency);
    expect(money(added.data.tables[0]!)).toEqual(['MYR']);
    expect(money(got.table)).toEqual(['MYR']);
  });

  it('A table named receipts already exists: new table ID is remapped, returned table matches the created one', () => {
    const config = workspace('zh');
    const first = draftReceiptSample(
      draftTable('purchase', config, 'zh'),
      'purchase',
      config,
      'zh',
    )!;
    const next = apply(config, first.ops, 'zh');
    const second = draftReceiptSample(draftTable('purchase', next, 'zh'), 'purchase', next, 'zh')!;
    const both = apply(next, second.ops, 'zh');
    expect(both.data.tables.map((c) => c.id)).toEqual(['receipts', second.table.id]);
    expect(second.table.id).not.toBe('receipts');
  });

  it('User modified fields or table name, selected a non-voucher preset, or sample does not fit: do not use sample', () => {
    const config = workspace('zh');
    const table = draftTable('purchase', config, 'zh');
    expect(draftReceiptSample({ ...table, name: '我的小票' }, 'purchase', config, 'zh')).toBeNull();
    expect(
      draftReceiptSample(
        { ...table, fields: table.fields.filter((f) => f.id !== 'note') },
        'purchase',
        config,
        'zh',
      ),
    ).toBeNull();
    expect(draftReceiptSample(draftTable('bill', config, 'zh'), 'bill', config, 'zh')).toBeNull();
  });
});
