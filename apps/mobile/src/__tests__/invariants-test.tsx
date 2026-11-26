import {
  BUILTIN_TOOLS,
  CURRENT_SCHEMA_VERSION,
  DATA_TEMPLATES,
  FILE_RECORD_PRESETS,
  HIDDEN_RECORD_PRESETS,
  REDACTED_FILE,
  applyOps,
  calendarOf,
  createDefaultWorkspace,
  dayOf,
  localDate,
  createRegistry,
  createStarterWorkspace,
  sampleOps,
  templateOps,
  type AIProvider,
  type Collection,
  type Locale,
  type Op,
  type Plan,
  type WorkspaceConfig,
} from '@morph/core';
import { createClaudePlanner, createHttpCompleter } from '@morph/planner';
import { qrMatrix, qrToRgba } from '@morph/tool-qr';
import { act, fireEvent, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { screen } from 'expo-router/testing-library';
import { Alert, Linking } from 'react-native';

import { readAttachmentCodes } from '../data/attachment-text';
import { useGuide } from '../guide/store';
import { sharedAbout } from '../share/about';
import { MemoryWorkspaceRepo } from '../storage/memory';
import { FakeFiles } from '../test-utils/fake-files';
import { renderToolsApp } from '../test-utils/render-app';
import { fromV33 } from '../test-utils/v33';
import { createRemoteAIProvider } from '../workspace/remote-ai';
import { createWorkspaceStore } from '../workspace/store';
import sampleBabyGrowth from '../../../../packages/core/src/fixtures/v33/sample-baby-growth-zh.json';
import sampleExpenseHelper from '../../../../packages/core/src/fixtures/v33/sample-expense-helper-zh.json';
import sampleShopOrders from '../../../../packages/core/src/fixtures/v33/sample-shop-orders-zh.json';
import sampleStudyHelper from '../../../../packages/core/src/fixtures/v33/sample-study-helper-zh.json';
import sampleVisaDocs from '../../../../packages/core/src/fixtures/v33/sample-visa-docs-zh.json';
import v34Calendar from '../../../../packages/core/src/fixtures/v34/calendar.json';
import v34Habits from '../../../../packages/core/src/fixtures/v34/habits.json';
import v34Tasks from '../../../../packages/core/src/fixtures/v34/tasks.json';
import v34Todo from '../../../../packages/core/src/fixtures/v34/todo.json';

// Guard tests for Tinkrum's 19 invariants (AGENTS.md "Invariants", provisionally set by founder on
// 2026-10-31, with invariants 3, 7, 11, 16 modified and 19 added on the same day) at the app layer:
// requests sent to AI, verifying whether records persist before and after app modifications,
// checking that read-only pages write no data, and verifying that data writes are undoable. The
// core layer is tested in packages/core/src/invariants.test.ts, and the file platform in
// invariants-files-test.ts. When a real violation is detected, do not fix code: mark as it.failing
// with comment "violates invariant N, awaiting founder's decision: ...".

const registry = createRegistry(BUILTIN_TOOLS);
const NOW = new Date(2026, 9, 31, 9, 0);
const SENTINEL = 'SENTINEL-私密-7f3a';
const ASSET = 'sentinelasset01';
const OTHER_ASSET = 'otherasset0002';

/** Default config with a notes table and a file slot on the home screen (pointing to a user-selected file). */
function seeded(locale: Locale = 'zh'): WorkspaceConfig {
  const ops: Op[] = [
    {
      op: 'addData',
      table: {
        id: 'notes',
        name: '笔记',
        fields: [
          { id: 'title', name: '标题', type: 'text' },
          { id: 'body', name: '内容', type: 'text' },
        ],
      },
    },
    {
      op: 'addContainer',
      page: 'home',
      block: { id: 'slot', look: 'button', show: { label: '合同' }, opens: { file: ASSET } },
    },
  ];
  const r = applyOps(createDefaultWorkspace(locale), ops, { registry, locale });
  if (!r.ok) throw new Error(r.error);
  return r.config;
}

/** Records, file names, and recognized text (stored within records) all contain sentinel strings. */
async function repoWithPrivateData() {
  const repo = new MemoryWorkspaceRepo();
  await repo.insertRecord({
    id: 'r1',
    collectionId: 'notes',
    values: { body: `${SENTINEL} 识别出的文字` },
    createdAt: NOW.getTime(),
    updatedAt: NOW.getTime(),
  });
  for (const id of [ASSET, OTHER_ASSET])
    await repo.addAsset({
      id,
      name: `${SENTINEL}-${id}.pdf`,
      mimeType: 'application/pdf',
      size: 10,
      path: `assets/${id}/${SENTINEL}.pdf`,
      source: 'picked',
      createdAt: NOW.getTime(),
    });
  return repo;
}

const themePlan: Plan = { kind: 'ops', ops: [{ op: 'setTheme', primaryColor: '#336699' }] };

/** Mock fetch: records every outgoing request body and returns a valid plan. */
function capturingFetch(reply: (plan: string) => unknown) {
  const bodies: string[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    bodies.push(String(init.body));
    const body = reply(JSON.stringify(themePlan));
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  }) as unknown as typeof fetch;
  return { bodies, fetchImpl };
}

const relayReply = (text: string) => ({
  text,
  stopReason: 'end_turn',
  content: [{ type: 'text', text }],
  model: 'claude-haiku-5-5',
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
});
const claudeReply = (text: string) => ({
  content: [{ type: 'text', text }],
  stop_reason: 'end_turn',
  model: 'claude-haiku-5-5',
  usage: { input_tokens: 1, output_tokens: 1 },
});

async function bootedStore(provider: AIProvider, repo?: MemoryWorkspaceRepo) {
  const r = repo ?? (await repoWithPrivateData());
  const store = createWorkspaceStore({
    repo: r,
    provider,
    registry,
    locale: 'zh',
    now: () => NOW,
    seed: () => seeded(),
  });
  await store.getState().boot();
  return { repo: r, store };
}

const fixedPlanner = (plan: Plan): AIProvider => ({ plan: async () => plan });

describe('Invariant 1 / 2: AI requests contain no data content (records, file names, file content, recognized text)', () => {
  const shared = {
    id: 1,
    source: 'share' as const,
    copies: [],
    files: [
      {
        uri: `file:///shared/${SENTINEL}.jpg`,
        name: `${SENTINEL}.jpg`,
        size: 99,
        mimeType: 'image/jpeg',
      },
      { uri: `content://x/${SENTINEL}.pdf`, name: `${SENTINEL}.pdf`, size: 7, mimeType: null },
    ],
  };

  it('Tinkrum server mode: the AI page, the inbox and the draft chat send no data', async () => {
    const { bodies, fetchImpl } = capturingFetch(relayReply);
    const provider = createRemoteAIProvider({
      baseUrl: 'https://relay.test',
      registry,
      now: () => NOW,
      fetchImpl,
    });
    const { store } = await bootedStore(provider);
    expect((await store.getState().change('换个颜色', provider)).kind).toBe('drafted');
    // Continue the draft chat conversation (including previously spoken messages, D-207).
    await store.getState().draftChange('再深一点');
    await store.getState().deleteDraft();
    // Inbox opens AI: sends only file types and counts.
    await store.getState().change('给这些做个快捷操作', provider, { about: sharedAbout(shared) });
    await store.getState().deleteDraft();
    await store.getState().propose('换个颜色', provider, sharedAbout(shared));
    expect(bodies.length).toBeGreaterThanOrEqual(4);
    for (const body of bodies) {
      expect(body).not.toContain(SENTINEL);
      expect(body).not.toContain('识别出的文字');
    }
    // The configuration itself is sent (AI needs to inspect the structure); file slots contain only placeholders, without even random file IDs (Invariant 3).
    expect(bodies[0]).toContain('notes');
    for (const body of bodies) {
      expect(body).not.toContain(ASSET);
      expect(body).not.toContain(OTHER_ASSET);
    }
    expect(bodies[0]).toContain(REDACTED_FILE);
  });

  // D-423: QR codes read in the form enter candidates only and are not stored; they are excluded from AI requests. Uses real plan requests, and cannot be found in config either.
  it('a QR code read in the form never reaches the AI request', async () => {
    const { bodies, fetchImpl } = capturingFetch(relayReply);
    const provider = createRemoteAIProvider({
      baseUrl: 'https://relay.test',
      registry,
      now: () => NOW,
      fetchImpl,
    });
    const { store, repo } = await bootedStore(provider);
    const code = 'QRCODE-私密-91ab';
    const files = new FakeFiles();
    const path = 'assets/a/card.jpg';
    const uri = files.fileUri(path);
    files.disk.set(uri, new Uint8Array([1, 2, 3]));
    files.pixels.set(uri, qrToRgba(qrMatrix(`BEGIN:VCARD\nFN:${code}\nEND:VCARD`), { scale: 4 }));
    const codes = await readAttachmentCodes(
      [
        {
          id: 'a',
          name: 'card.jpg',
          mimeType: 'image/jpeg',
          size: 3,
          path,
          source: 'picked',
          createdAt: 1,
        },
      ],
      { files },
      new AbortController().signal,
    );
    // Successfully read (not omitted due to a read failure).
    expect(codes.join()).toContain(code);
    expect(JSON.stringify(store.getState().config)).not.toContain(code);
    expect((await store.getState().change('换个颜色', provider)).kind).toBe('drafted');
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) expect(body).not.toContain(code);
    expect(await repo.getMeta('prefill:picks')).toBeNull();
  });

  it('saved presets stay out of what the AI sees: not in the config, not their names (D-410)', async () => {
    const { bodies, fetchImpl } = capturingFetch(relayReply);
    const provider = createRemoteAIProvider({
      baseUrl: 'https://relay.test',
      registry,
      now: () => NOW,
      fetchImpl,
    });
    const { repo, store } = await bootedStore(provider);
    const saved = await store.getState().savePreset(`预设-${SENTINEL}`);
    expect(saved.kind).toBe('saved');
    if (saved.kind !== 'saved') return;
    expect(store.getState().config).not.toHaveProperty('presets');
    await repo.insertPreset({ ...saved.preset, id: 'otherpreset', name: `另一个-${SENTINEL}` });
    // After applying a preset, its name appears in the release notes and is not sent to AI.
    expect((await store.getState().proposePreset(saved.preset.id)).kind).toBe('preview');
    await store.getState().confirm();
    await store.getState().markRendered(store.getState().head!.id);
    await store.getState().change('换个颜色', provider);
    expect(bodies.length).toBeGreaterThanOrEqual(1);
    for (const body of bodies) expect(body).not.toContain(SENTINEL);
  });

  it('bring-your-own-key mode sends no data either', async () => {
    const { bodies, fetchImpl } = capturingFetch(claudeReply);
    const provider = createClaudePlanner({
      complete: createHttpCompleter({
        apiKey: 'test-key',
        model: 'claude-haiku-5-5',
        registry,
        fetchImpl,
      }),
      registry,
      now: () => NOW,
    });
    const { store } = await bootedStore(provider);
    await store.getState().change('换个颜色', provider, { about: sharedAbout(shared) });
    expect(bodies.length).toBe(1);
    expect(bodies[0]).not.toContain(SENTINEL);
  });
});

describe('Invariant 3: AI never touches files', () => {
  // Founder 2026-10-31 (conversation): AI modifications may never write file references; only the user picks them via long-press edit.
  it('AI cannot point a file slot at one of the user’s files; only the user picks it', async () => {
    const plan: Plan = {
      kind: 'ops',
      ops: [
        {
          op: 'updateContainer',
          page: 'home',
          block: 'slot',
          changes: { opens: { file: OTHER_ASSET } },
        },
      ],
    };
    const { store } = await bootedStore(fixedPlanner(plan));
    const result = await store.getState().change('换成另一个文件', fixedPlanner(plan));
    expect(['rejected', 'invalid']).toContain(result.kind);
  });

  it('AI can add an empty file slot (the user picks the file)', async () => {
    const plan: Plan = {
      kind: 'ops',
      ops: [
        {
          op: 'addContainer',
          page: 'home',
          block: { id: 'slot2', look: 'button', show: { label: '护照' }, opens: { file: null } },
        },
      ],
    };
    const { store } = await bootedStore(fixedPlanner(plan));
    expect((await store.getState().change('加一个放护照的地方', fixedPlanner(plan))).kind).toBe(
      'drafted',
    );
  });
});

describe('Invariant 5: Changing the app never deletes data', () => {
  async function apply(store: Awaited<ReturnType<typeof bootedStore>>['store'], ops: Op[]) {
    const r = await store.getState().proposeOps(ops, 'x');
    expect(r.kind).toBe('preview');
    expect(await store.getState().confirm()).toBe(true);
    await store.getState().markRendered(store.getState().head!.id);
  }

  it('removing a field or a table keeps the entries; going back to an old version keeps them too', async () => {
    const { repo, store } = await bootedStore(fixedPlanner(themePlan));
    const first = store.getState().head!.id;
    await apply(store, [{ op: 'removeData', table: 'notes', field: 'body' }]);
    expect((await repo.getRecord('r1'))!.values.body).toContain(SENTINEL);
    await apply(store, [{ op: 'removeData', table: 'notes' }]);
    expect((await repo.listRecords('notes')).map((r) => r.id)).toEqual(['r1']);
    // Restore to earliest version: table is restored, and records remain intact.
    expect((await store.getState().proposeRestore(first)).kind).toBe('preview');
    await store.getState().confirm();
    expect(store.getState().config!.data.tables.some((t) => t.id === 'notes')).toBe(true);
    expect((await repo.getRecord('r1'))!.values.body).toContain(SENTINEL);
    // Undo behaves the same way.
    await store.getState().undo();
    expect((await repo.listRecords('notes')).length).toBe(1);
  });

  it('applying a saved preset keeps every entry, also of tables the preset does not have (D-410)', async () => {
    const { repo, store } = await bootedStore(fixedPlanner(themePlan));
    await repo.insertPreset({
      id: 'emptypreset',
      name: '空的',
      createdAt: 1,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      config: createDefaultWorkspace('zh'),
    });
    expect((await store.getState().proposePreset('emptypreset')).kind).toBe('preview');
    await store.getState().confirm();
    expect(store.getState().config!.data.tables.some((t) => t.id === 'notes')).toBe(false);
    expect((await repo.getRecord('r1'))!.values.body).toContain(SENTINEL);
    expect(await repo.listDeletedRecords()).toEqual([]);
    await store.getState().markRendered(store.getState().head!.id);
    await store.getState().undo();
    expect(store.getState().config!.data.tables.some((t) => t.id === 'notes')).toBe(true);
    expect((await repo.listRecords('notes')).length).toBe(1);
  });

  it('an AI change can never reach the entries: the store only gets a configuration back', async () => {
    const plan: Plan = { kind: 'ops', ops: [{ op: 'removeData', table: 'notes' }] };
    const { repo, store } = await bootedStore(fixedPlanner(plan));
    await store.getState().change('删掉笔记表', fixedPlanner(plan));
    expect((await repo.listRecords('notes')).length).toBe(1);
    expect(await repo.listDeletedRecords()).toEqual([]);
  });
});

describe('Invariant 7: Look changes go into a draft first; feature changes take effect directly, can be undone at any time in Change history', () => {
  it('an AI change to the look goes into a draft; the app does not change until the user applies it', async () => {
    const { store } = await bootedStore(fixedPlanner(themePlan));
    const head = store.getState().head!.id;
    expect((await store.getState().change('换个颜色', fixedPlanner(themePlan))).kind).toBe(
      'drafted',
    );
    expect(store.getState().head!.id).toBe(head);
    await store.getState().applyDraft();
    expect(store.getState().head!.id).not.toBe(head);
    await store.getState().markRendered(store.getState().head!.id);
    await store.getState().undo();
    expect(store.getState().config!.theme.primaryColor).not.toBe('#336699');
  });

  // D-411: Function modifications stated in the draft chat are recorded and can be undone; the draft remains open and visual changes are not yet applied.
  it('a function change said in the draft chat is recorded and can be undone; the look stays a draft', async () => {
    const table: Plan = {
      kind: 'ops',
      ops: [
        {
          op: 'addData',
          table: { id: 'books', name: 'B', fields: [{ id: 'title', name: 'T', type: 'text' }] },
        },
      ],
    };
    const { repo, store } = await bootedStore({
      plan: async (input) => (input === 'look' ? themePlan : table),
    });
    await store.getState().draftChange('look');
    const before = store.getState().config!.theme.primaryColor;
    const head = store.getState().head!.id;
    await store.getState().draftChange('table');
    expect(store.getState().config!.theme.primaryColor).toBe(before);
    expect(store.getState().draft!.steps[0]!.config.theme.primaryColor).toBe('#336699');
    expect(await repo.listRevisions(1)).toMatchObject([{ source: 'ai', parentId: head }]);
    await store.getState().proposeRestore(head);
    await store.getState().confirm();
    expect(store.getState().config!.data.tables.some((t) => t.id === 'books')).toBe(false);
    expect(store.getState().draft!.open).toBe(true);
  });

  // Founder 2026-10-31 (conversation) updated Invariant 7 wording: function modifications (D-191,
  // creating tables, adding quick actions, etc.) take effect immediately, but can be undone at any
  // time in Change history.
  it('an AI change to function (a new table) applies at once, is recorded in the history and can be undone', async () => {
    const plan: Plan = {
      kind: 'ops',
      ops: [
        {
          op: 'addData',
          table: {
            id: 'books',
            name: '书',
            fields: [{ id: 'title', name: '书名', type: 'text' }],
          },
        },
      ],
    };
    const { repo, store } = await bootedStore(fixedPlanner(plan));
    const head = store.getState().head!.id;
    expect((await store.getState().change('加一张书的表', fixedPlanner(plan))).kind).toBe(
      'applied',
    );
    const after = store.getState().head!;
    expect(after.id).not.toBe(head);
    expect(after.source).toBe('ai');
    expect(store.getState().config!.data.tables.some((t) => t.id === 'books')).toBe(true);
    // Change history contains this version, and any previous version can be reverted to at any time.
    expect((await repo.listRevisions(50)).map((r) => r.id)).toEqual(
      expect.arrayContaining([head, after.id]),
    );
    await store.getState().markRendered(after.id);
    await store.getState().undo();
    expect(store.getState().config!.data.tables.some((t) => t.id === 'books')).toBe(false);
    expect((await store.getState().proposeRestore(after.id)).kind).toBe('preview');
    await store.getState().confirm();
    expect(store.getState().config!.data.tables.some((t) => t.id === 'books')).toBe(true);
  });

  // R02 (founder decided on 2026-11-07: implement pagination): Change history can always return to any previous point -- paging downwards until reaching the very first version.
  it('the change history pages back to the very first version however many there are', async () => {
    const { repo, store } = await bootedStore(fixedPlanner(themePlan));
    const first = store.getState().head!;
    let base = first.id;
    for (let n = 0; n < 120; n++)
      base = (
        await repo.commitRevision({
          baseId: base,
          config: store.getState().config!,
          source: 'user',
          summary: `v${n}`,
        })
      ).id;
    let before: number | undefined;
    let reached = false;
    for (;;) {
      const page = await store.getState().listRevisions(50, before);
      if (page.length === 0) break;
      reached ||= page.some((r) => r.id === first.id);
      before = page[page.length - 1]!.id;
    }
    expect(reached).toBe(true);
  });
});

// ---- Rendering: viewing pages writes no data (Invariants 15, 16), writing data is undoable (Invariant 11) ----

/** A few simple records per table (populating only stored, easily fillable fields). */
async function fillRecords(repo: MemoryWorkspaceRepo, tables: readonly Collection[]) {
  for (const t of tables)
    for (let i = 0; i < 3; i++) {
      const values: Record<string, unknown> = {};
      for (const f of t.fields) {
        if (f.type === 'text' || f.type === 'note') values[f.id] = `${t.id} ${i}`;
        else if (f.type === 'number' || f.type === 'money' || f.type === 'rating')
          values[f.id] = i + 1;
        else if (f.type === 'date') values[f.id] = `2026-10-${20 + i}`;
        else if (f.type === 'checkbox') values[f.id] = i === 0;
        else if (f.type === 'choice') values[f.id] = f.options[i % f.options.length]!.id;
        else if (f.type === 'tags') values[f.id] = [`tag ${i}`];
      }
      await repo.insertRecord({
        id: `${t.id}-${i}`,
        collectionId: t.id,
        values,
        createdAt: NOW.getTime() - i * 86_400_000,
        updatedAt: NOW.getTime() - i * 86_400_000,
      });
    }
}

const WRITES = [
  'insertRecord',
  'updateRecord',
  'deleteRecord',
  'restoreRecord',
  'purgeDeletedRecords',
  'purgeCollection',
  'commitRevision',
  'addAsset',
  'deleteAsset',
] as const;

function spyWrites(repo: MemoryWorkspaceRepo) {
  return WRITES.map((name) => [name, jest.spyOn(repo, name)] as const);
}

// Frozen core config: v34 scope templates, templates stored by v33 code (migrated to current).
const V34: Record<string, unknown> = {
  habits: v34Habits,
  calendar: v34Calendar,
  tasks: v34Tasks,
  todo: v34Todo,
};
const SAMPLES: Record<string, unknown> = {
  'expense-helper': sampleExpenseHelper,
  'visa-docs': sampleVisaDocs,
  'study-helper': sampleStudyHelper,
  'shop-orders': sampleShopOrders,
  'baby-growth': sampleBabyGrowth,
};
const v34 = (name: string) => structuredClone(V34[name]) as WorkspaceConfig;

function withTemplate(
  template:
    | (typeof DATA_TEMPLATES)[number]
    | (typeof FILE_RECORD_PRESETS)[number]
    | (typeof HIDDEN_RECORD_PRESETS)[number],
): WorkspaceConfig {
  const config = createDefaultWorkspace('zh');
  const r = applyOps(config, templateOps(template, config, 'zh'), { registry, locale: 'zh' });
  if (!r.ok) throw new Error(r.error);
  return r.config;
}

const VIEWED: [string, () => WorkspaceConfig, Locale][] = [
  ['default (fr)', () => createDefaultWorkspace('fr'), 'fr'],
  // Inbox "Save as record" preset table (D-392) and hidden presets (D-444) similarly perform read-only operations without writing.
  ...[...DATA_TEMPLATES, ...FILE_RECORD_PRESETS, ...HIDDEN_RECORD_PRESETS].map(
    (t): [string, () => WorkspaceConfig, Locale] => [`template ${t}`, () => withTemplate(t), 'zh'],
  ),
  ...['habits', 'calendar', 'tasks', 'todo'].map((n): [string, () => WorkspaceConfig, Locale] => [
    `v34 ${n}`,
    () => v34(n),
    'zh',
  ]),
  ...['expense-helper', 'visa-docs', 'study-helper', 'shop-orders', 'baby-growth'].map(
    (n): [string, () => WorkspaceConfig, Locale] => [
      `sample ${n}`,
      () => fromV33(structuredClone(SAMPLES[n])),
      'zh',
    ],
  ),
  // Business card sample (D-423): pages with QR codes, block views based on tables, searchable lists -- viewable without writing.
  ['sample business-cards', businessCards, 'zh'],
  // Habit grid (D-610): drawing grids and computing cell values writes nothing.
  ['grid', gridConfig, 'zh'],
];

/** Habit × last 7 days habit grid (D-610), located on the week page. */
function gridConfig(): WorkspaceConfig {
  const r = applyOps(
    createDefaultWorkspace('zh'),
    [
      {
        op: 'addData',
        table: { id: 'habits', name: '习惯', fields: [{ id: 'name', name: '名字', type: 'text' }] },
      },
      {
        op: 'addData',
        table: {
          id: 'checkins',
          name: '打卡',
          fields: [
            { id: 'habit', name: '习惯', type: 'link', table: 'habits' },
            { id: 'date', name: '日期', type: 'date' },
          ],
        },
      },
      {
        op: 'addContainer',
        page: {
          id: 'week',
          title: '这一周',
          blocks: [
            {
              id: 'grid',
              look: 'grid',
              source: {
                table: 'checkins',
                group: { by: 'habit', showEmpty: true },
                across: { unit: 'day', by: 'date' },
                limit: 30,
              },
              show: { title: 'habit' },
              tools: [
                { as: 'tap', do: 'create', table: 'checkins', values: '$here' },
                { as: 'tap', do: 'remove', table: 'checkins' },
              ],
            },
          ],
        },
      },
    ] as Op[],
    { registry, locale: 'zh' },
  );
  if (!r.ok) throw new Error(r.error);
  return r.config;
}

function businessCards(): WorkspaceConfig {
  const base = createStarterWorkspace('zh', registry);
  const sample = sampleOps('business-cards', base, 'zh');
  if (!sample.ok) throw new Error(sample.message);
  const r = applyOps(base, sample.ops, { registry, locale: 'zh' });
  if (!r.ok) throw new Error(r.error);
  return r.config;
}

async function renderSeeded(
  config: WorkspaceConfig,
  locale: Locale,
  repo = new MemoryWorkspaceRepo(),
) {
  await repo.setMeta('guide', 'done');
  await act(() => useGuide.getState().load(repo));
  await fillRecords(repo, config.data.tables);
  return renderToolsApp(repo, new FakeFiles(), { seed: () => config, locale });
}

// renderRouter replaced with fake timers: advance slightly to let page reads and animations finish.
const settle = () =>
  act(async () => {
    jest.advanceTimersByTime(200);
    await Promise.resolve();
  });

describe('Invariant 15 / 16: Looking never changes anything; every write comes from one user action (exception: clearing trash older than 30 days at startup)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    useGuide.setState({ stage: null, repo: null });
  });

  it.each(VIEWED)(
    '%s: opening every page writes nothing',
    async (_name, make, locale) => {
      const config = make();
      const { repo, store } = await renderSeeded(config, locale);
      // Seed version is usable (not a reverted default config), and pages are the ones intended for viewing.
      expect(store.getState().head!.source).toBe('seed');
      await settle();
      const spies = spyWrites(repo);
      const reads = jest.spyOn(repo, 'listRecords');
      for (const page of config.containers.pages) {
        if (page.of !== undefined || page.package !== undefined) continue;
        await act(() => router.push({ pathname: '/page/[pageId]', params: { pageId: page.id } }));
        await settle();
        await act(() => router.back());
      }
      await settle();
      expect(spies.filter(([, s]) => s.mock.calls.length > 0).map(([n]) => n)).toEqual([]);
      // Pages are genuinely rendered and read records (not showing nothing and thus omitting reads).
      if (config.data.tables.length > 0) expect(reads).toHaveBeenCalled();
    },
    20_000,
  );

  // D-422, D-423, D-428: Top buttons on the entry page merely open system applications.
  it('tapping call, message, email, website or share on an entry writes nothing', async () => {
    const opened = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined as never);
    const asked = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const base = createDefaultWorkspace('zh');
    const added = applyOps(
      base,
      [
        {
          op: 'addData',
          table: {
            id: 'contacts',
            name: '联系人',
            fields: [
              { id: 'tel', name: '电话', type: 'text', format: 'phone' },
              { id: 'mail', name: '邮箱', type: 'text', format: 'email' },
              { id: 'site', name: '网站', type: 'text', format: 'url' },
            ],
            recordRow: [
              { tool: 'record-call', field: 'tel' },
              { tool: 'record-message', field: 'tel' },
              { tool: 'record-email', field: 'mail' },
              { tool: 'record-vcard' },
              { tool: 'record-website', field: 'site' },
            ],
          },
        },
      ],
      { registry, locale: 'zh' },
    );
    if (!added.ok) throw new Error(added.error);
    const repo = new MemoryWorkspaceRepo();
    await repo.insertRecord({
      id: 'c1',
      collectionId: 'contacts',
      values: { tel: '+33 6 12', mail: 'a@example.com', site: 'example.com' },
      createdAt: 1,
      updatedAt: 1,
    });
    await renderSeeded(added.config, 'zh', repo);
    await settle();
    await act(() =>
      router.push({
        pathname: '/record/[collectionId]',
        params: { collectionId: 'contacts', recordId: 'c1' },
      }),
    );
    await settle();
    await screen.findByTestId('record-action-record-call-tel');
    const spies = spyWrites(repo);
    await fireEvent.press(screen.getByTestId('record-action-record-call-tel'));
    await settle();
    await fireEvent.press(screen.getByTestId('record-action-record-message-tel'));
    await settle();
    await fireEvent.press(screen.getByTestId('record-action-record-email-mail'));
    await settle();
    await fireEvent.press(screen.getByTestId('record-action-record-vcard'));
    await settle();
    await fireEvent.press(screen.getByTestId('record-action-record-website-site'));
    await settle();
    const open = (asked.mock.lastCall?.[2] ?? []).find((b) => b.text === '打开');
    await act(async () => open?.onPress?.());
    await settle();
    expect(opened.mock.calls.map(([url]) => url)).toEqual([
      'tel:+33612',
      'sms:+33612',
      'mailto:a@example.com',
      'https://example.com',
    ]);
    expect(spies.filter(([, s]) => s.mock.calls.length > 0).map(([n]) => n)).toEqual([]);
    expect((await repo.getRecord('c1'))!.updatedAt).toBe(1);
  });

  // D-424: Searching, switching sort, and changing grouping only affect the block view, without writing records or configuration (version remains unchanged).
  it('searching, switching sort and group on a list writes nothing', async () => {
    const base = createDefaultWorkspace('zh');
    const added = applyOps(
      base,
      [
        {
          op: 'addData',
          table: {
            id: 'people',
            name: '人',
            fields: [
              { id: 'name', name: '姓名', type: 'text' },
              { id: 'co', name: '公司', type: 'text' },
            ],
          },
        },
        {
          op: 'addContainer',
          page: {
            id: 'people-page',
            title: '人',
            blocks: [
              {
                id: 'list',
                look: 'list',
                source: { table: 'people', limit: 30 },
                show: {
                  title: 'name',
                  browse: { search: true, sort: ['name', 'createdAt'], group: ['co'] },
                },
              },
            ],
          },
        },
      ],
      { registry, locale: 'zh' },
    );
    if (!added.ok) throw new Error(added.error);
    const repo = new MemoryWorkspaceRepo();
    const { store } = await renderSeeded(added.config, 'zh', repo);
    await settle();
    await act(() => router.push({ pathname: '/page/[pageId]', params: { pageId: 'people-page' } }));
    await settle();
    const head = store.getState().head!.id;
    const spies = spyWrites(repo);
    await fireEvent.changeText(await screen.findByTestId('browse-search'), 'x');
    await fireEvent.changeText(screen.getByTestId('browse-search'), '');
    await fireEvent.press(screen.getByTestId('browse-sort-createdAt'));
    await fireEvent.press(screen.getByTestId('browse-group-co'));
    await fireEvent.press(screen.getByTestId('browse-group-none'));
    await settle();
    expect(spies.filter(([, s]) => s.mock.calls.length > 0).map(([n]) => n)).toEqual([]);
    expect(store.getState().head!.id).toBe(head);
  });

  // Founder 2026-10-31 (conversation) set exception (D-037): records in the trash deleted more than
  // 30 days ago are permanently deleted at startup, originating from the user's own deletion. This
  // is the only write at startup. The rescue page's start counter is outside the database, is the
  // app's own bookkeeping and not data (founder 2026-11-22, D-621), and is not counted here.
  it('starting the app writes nothing except emptying entries deleted more than 30 days ago', async () => {
    const repo = await repoWithPrivateData();
    await repo.insertRecord({
      id: 'r2',
      collectionId: 'notes',
      values: { title: 'x' },
      createdAt: NOW.getTime(),
      updatedAt: NOW.getTime(),
    });
    await repo.insertRecord({
      id: 'r3',
      collectionId: 'notes',
      values: { title: 'y' },
      createdAt: NOW.getTime(),
      updatedAt: NOW.getTime(),
    });
    // First open (saves the seed version), then the user deleted two entries: one 60 days ago, one 5 days ago.
    await bootedStore(fixedPlanner(themePlan), repo);
    await repo.deleteRecord('r2', NOW.getTime() - 60 * 86_400_000);
    await repo.deleteRecord('r3', NOW.getTime() - 5 * 86_400_000);
    const spies = spyWrites(repo);
    await bootedStore(fixedPlanner(themePlan), repo);
    expect(spies.filter(([, s]) => s.mock.calls.length > 0).map(([n]) => n)).toEqual([
      'purgeDeletedRecords',
    ]);
    expect((await repo.listDeletedRecords()).map((r) => r.id)).toEqual(['r3']);
    expect((await repo.getRecord('r1'))!.values.body).toContain(SENTINEL);
    jest.restoreAllMocks();
  });
});

describe('Invariant 11: Every write action can be taken back; an undo banner is shown only where one simple action cannot take it back (deletion, tapping once that changes several places, bulk creation, an imported batch)', () => {
  // Founder 2026-10-31 (conversation): "Store things or operations confirmed by the user should not
  // be undone, except for deletion." What is saved and confirmed by the user (form save, check,
  // one-way create, +1, Kanban drag, tapping circles, bulk edit, home screen widget) shows no undo,
  // and the user reverses it with an equally simple action; bulk edit must always ask first
  // (record-actions-test.tsx). Founder 2026-11-16 (conversation, decisions ③④): deletion, tapping
  // once that changes several places (D-566), and bulk create (D-567) show undo
  // (record-tap-also-test.tsx); same day (decision ⑦): an imported batch also shows undo (D-574).
  // import-records-test.tsx）。
  afterEach(() => {
    jest.restoreAllMocks();
    useGuide.setState({ stage: null, repo: null });
  });

  // Each test re-renders, but expo-router's global router remembers where the last test stopped: with a different parameter, guaranteeing that a new page is advanced to.
  let visit = 0;
  async function openPage(config: WorkspaceConfig, pageId: string, repo?: MemoryWorkspaceRepo) {
    const app = await renderSeeded(config, 'zh', repo);
    await act(() =>
      router.push({ pathname: '/page/[pageId]', params: { pageId, visit: ++visit } }),
    );
    return app;
  }
  const todoPage = () => openPage(v34('todo'), 'todo');

  it('deleting an entry shows undo', async () => {
    const { store } = await todoPage();
    await fireEvent.press(await screen.findByText('todos 1'));
    await fireEvent.press(await screen.findByTestId('editor-delete'));
    await waitFor(() => expect(store.getState().toast?.restoreRecordId).toBe('todos-1'));
    expect(screen.getByTestId('toast-undo')).toBeTruthy();
  });

  it('adding an entry with the form on the page shows no undo; deleting it does', async () => {
    const { repo, store } = await todoPage();
    await fireEvent.changeText(await screen.findByTestId('form-add-title'), '买牛奶');
    await fireEvent.press(screen.getByTestId('form-add-submit'));
    await settle();
    const added = (await repo.listRecords('todos')).find((r) => r.values.title === '买牛奶')!;
    expect(added).toBeDefined();
    expect(screen.queryByTestId('toast-undo')).toBeNull();
    // The new entry is right on this table, tap to open and delete it (deletion has undo as usual).
    await fireEvent.press(await screen.findByText('买牛奶'));
    await fireEvent.press(await screen.findByTestId('editor-delete'));
    await waitFor(() => expect(store.getState().toast?.restoreRecordId).toBe(added.id));
    expect((await repo.listRecords('todos')).some((r) => r.id === added.id)).toBe(false);
  });

  it('ticking a checklist entry shows no undo and is taken back by ticking it again', async () => {
    const { repo } = await todoPage();
    const before = (await repo.getRecord('todos-1'))!.values.done ?? false;
    await fireEvent.press(await screen.findByTestId('check-todos-1'));
    await settle();
    expect((await repo.getRecord('todos-1'))!.values.done).toBe(!before);
    expect(screen.queryByTestId('toast-undo')).toBeNull();
    await fireEvent.press(await screen.findByTestId('check-todos-1'));
    await settle();
    expect((await repo.getRecord('todos-1'))!.values.done ?? false).toBe(before);
  });

  // Todo check has "also" (D-617): ticking also records the completion date in a single write; unticking clears them, which undoes everything done by ticking, so no undo is shown.
  it('ticking a check that also records a date shows no undo; unticking takes all of it back', async () => {
    const config = v34('todo');
    config.data.tables
      .find((t) => t.id === 'todos')!
      .fields.push({ id: 'finished', name: '完成于', type: 'date' });
    const block = config.containers.pages
      .find((p) => p.id === 'todo')!
      .blocks.find((b) => b.id === 'tasks') as { tools: object[] };
    block.tools = [
      {
        as: 'check',
        do: 'toggle',
        table: 'todos',
        field: 'done',
        also: [{ do: 'set', field: 'finished', value: 'today' }],
      },
    ];
    const { repo } = await openPage(config, 'todo');
    // Todos 0 is ticked: first untick (clear completedAt), then tick (record today), then untick, returning to the state after the first untick; none show undo.
    const press = async () => {
      await fireEvent.press(await screen.findByTestId('check-todos-0'));
      await settle();
      expect(screen.queryByTestId('toast-undo')).toBeNull();
      return (await repo.getRecord('todos-0'))!.values;
    };
    const unticked = await press();
    expect([unticked.done, unticked.finished]).toEqual([false, undefined]);
    const ticked = await press();
    expect([ticked.done, ticked.finished]).toEqual([true, localDate(new Date())]);
    expect(await press()).toEqual(unticked);
  });

  it('a tap that makes several changes shows undo, which puts the entry back', async () => {
    const config = v34('todo');
    config.containers.pages
      .find((p) => p.id === 'todo')!
      .blocks.push({
        id: 'later',
        look: 'list',
        source: { table: 'todos', limit: 10 },
        show: { title: 'title' },
        tools: [
          {
            as: 'button',
            label: '明天再做',
            do: 'set',
            table: 'todos',
            field: 'done',
            value: false,
            also: [{ do: 'set', field: 'due', value: { from: 'today', add: 1, unit: 'days' } }],
          },
        ],
      } as never);
    const { repo } = await openPage(config, 'todo');
    const before = (await repo.getRecord('todos-1'))!.values;
    await fireEvent.press(await screen.findByTestId('row-action-todos-1'));
    await fireEvent.press(await screen.findByTestId('toast-undo'));
    await settle();
    expect((await repo.getRecord('todos-1'))!.values).toEqual(before);
  });

  it('creating entries in bulk asks first and shows undo, which removes the batch', async () => {
    const config = v34('todo');
    config.containers.pages
      .find((p) => p.id === 'todo')!
      .blocks.push({
        id: 'copy-all',
        look: 'button',
        show: { label: '全部再来一遍', shape: 'filled' },
        tools: [
          { do: 'createAll', table: 'todos', from: 'todos', values: { title: { copy: 'title' } } },
        ],
      } as never);
    const { repo } = await openPage(config, 'todo');
    const before = (await repo.listRecords('todos')).length;
    const alert = jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => {
      buttons?.find((b) => b.text === '新建')?.onPress?.();
    });
    await fireEvent.press(await screen.findByText('全部再来一遍'));
    expect(alert).toHaveBeenCalled();
    await fireEvent.press(await screen.findByTestId('toast-undo'));
    await settle();
    expect(await repo.listRecords('todos')).toHaveLength(before);
  });

  it('importing entries from a file asks first and shows undo, which removes exactly that batch (D-574)', async () => {
    const config = v34('todo');
    const repo = new MemoryWorkspaceRepo();
    await repo.setMeta('guide', 'done');
    await act(() => useGuide.getState().load(repo));
    await fillRecords(repo, config.data.tables);
    const files = new FakeFiles();
    await renderToolsApp(repo, files, { seed: () => config, locale: 'zh' });
    const ids = async () => (await repo.listRecords('todos')).map((r) => r.id).sort();
    const before = await ids();
    await act(() =>
      router.push({ pathname: '/import-records', params: { table: 'todos', visit: ++visit } }),
    );
    files.nextPick = [
      files.offer('todos.csv', new TextEncoder().encode('事项\n买牛奶\n交房租\n'), 'text/csv'),
    ];
    await fireEvent.press(await screen.findByTestId('import-choose'));
    await settle();
    await fireEvent.press(await screen.findByTestId('import-continue'));
    await settle();
    // Ask first: summary generated, nothing written yet.
    expect(screen.getByTestId('import-summary')).toHaveTextContent(/加入 2 条记录。/);
    expect(await ids()).toEqual(before);
    await fireEvent.press(screen.getByTestId('import-confirm'));
    await settle();
    expect(await ids()).toHaveLength(before.length + 2);
    await fireEvent.press(await screen.findByTestId('toast-undo'));
    await settle();
    expect(await ids()).toEqual(before);
    // What is undone is the user's own content: enter "Recently Deleted", it can be restored.
    expect((await repo.listDeletedRecords()).map((r) => r.values.title).sort()).toEqual(
      ['买牛奶', '交房租'].sort(),
    );
  });

  it('a one-tap check-in (tapping a habit tile) shows no undo', async () => {
    const seededRepo = new MemoryWorkspaceRepo();
    await seededRepo.insertRecord({
      id: 'run',
      collectionId: 'habits',
      values: { name: '跑步', plan: { repeat: 'daily' } },
      createdAt: NOW.getTime(),
      updatedAt: NOW.getTime(),
    });
    const { repo } = await openPage(v34('habits'), 'habits', seededRepo);
    const before = (await repo.listRecords('checkins')).length;
    await fireEvent.press(await screen.findByTestId('tile-run'));
    await waitFor(async () => expect(await repo.listRecords('checkins')).toHaveLength(before + 1));
    await settle();
    expect(screen.queryByTestId('toast-undo')).toBeNull();
  });
});

describe('Tool list and build plans do not break invariants (D-414, D-415, D-416)', () => {
  const steps = [
    { id: 'theme', kind: 'look', title: '颜色', request: '换颜色' },
    { id: 'pkg', kind: 'file', title: '工具', request: '加图片工具' },
  ] as const;
  const scripted = (calls: string[]): AIProvider => ({
    plan: async (input) => {
      calls.push(input);
      if (input === '搭一个') return { kind: 'build', summary: '一个 App', steps: [...steps] };
      if (input === '换颜色')
        return { kind: 'ops', ops: [{ op: 'setTheme', primaryColor: '#2F9E44' }] };
      return { kind: 'ops', ops: [{ op: 'setPackage', package: 'image', do: 'add' }] };
    },
  });
  const persisted = async (repo: MemoryWorkspaceRepo) =>
    `${(await repo.getMeta('session')) ?? ''}${(await repo.getMeta('build')) ?? ''}`;

  it('Invariant 1 / 2 / 14: Checklists and <session> sent to AI contain no record content', async () => {
    const { bodies, fetchImpl } = capturingFetch(relayReply);
    const provider = createRemoteAIProvider({
      baseUrl: 'https://relay.test',
      registry,
      now: () => NOW,
      fetchImpl,
    });
    const { repo, store } = await bootedStore(provider);
    expect(JSON.stringify(await repo.listRecords('notes'))).toContain(SENTINEL);
    await store.getState().change('换个颜色', provider);
    await store.getState().change('再深一点', provider);
    expect(bodies.at(-1)).toContain('<session>');
    for (const body of bodies) expect(body).not.toContain(SENTINEL);
    expect(await persisted(repo)).not.toContain(SENTINEL);
    expect(await persisted(repo)).not.toContain(ASSET);
    expect(JSON.stringify(store.getState().session)).toContain('换个颜色');
  });

  it('Invariant 7: Look steps go into draft, feature steps go into official version, can be undone in Change history', async () => {
    const calls: string[] = [];
    const provider = scripted(calls);
    const { store } = await bootedStore(provider);
    const startId = store.getState().head!.id;
    await store.getState().change('搭一个', provider);
    await store.getState().startBuild();
    const { config, draft, head } = store.getState();
    expect(config!.theme.primaryColor).not.toBe('#2F9E44');
    expect(draft!.steps.at(-1)!.config.theme.primaryColor).toBe('#2F9E44');
    expect(config!.packages.map((p) => p.id)).toContain('image');
    expect(head!.parentId).toBe(startId);
    expect(head!.source).toBe('ai');
  });

  it('Invariant 8: Checklists and plans are not in config, model replies cannot write to them', async () => {
    const provider: AIProvider = {
      plan: async () =>
        ({
          kind: 'ops',
          ops: [{ op: 'setTheme', primaryColor: '#2F9E44' }],
          session: { items: [] },
        }) as unknown as Plan,
    };
    const { repo, store } = await bootedStore(provider);
    await store.getState().change('记一句', provider);
    const session = await repo.getMeta('session');
    expect(store.getState().config).not.toHaveProperty('session');
    // Replies with multiple fields fail PlanSchema, nothing changes, checklist only notes "not done".
    expect(session).toContain('记一句');
    expect(store.getState().session.items).toEqual([]);
    expect(store.getState().draft).toBeNull();
  });

  it('Invariant 16: Plan does not run until "Start" is tapped; restart or stop does not auto-resume; a single "Start" runs continuously to completion (D-416)', async () => {
    const calls: string[] = [];
    const provider = scripted(calls);
    const repo = new MemoryWorkspaceRepo();
    const make = () =>
      createWorkspaceStore({ repo, provider, registry, locale: 'zh', now: () => NOW });
    const store = make();
    await store.getState().boot();
    await store.getState().change('搭一个', provider);
    const heads = store.getState().head!.id;
    await settle();
    expect(calls).toEqual(['搭一个']);
    expect(store.getState().head!.id).toBe(heads);

    // Restart: still only the plan.
    const again = make();
    await again.getState().boot();
    await settle();
    expect(calls).toEqual(['搭一个']);
    expect(again.getState().build!.phase).toBe('review');

    await again.getState().startBuild();
    expect(calls).toEqual(['搭一个', '换颜色', '加图片工具']);
    expect(again.getState().build!.phase).toBe('finished');
  });
});

describe('Invariant 5 / 15 / 19: Ask if there are duplicates before saving (D-426)', () => {
  const receipts: Collection = {
    id: 'claims',
    name: '报销',
    prefillRules: 'receipt',
    fields: [
      { id: 'amount', name: '金额', type: 'money', currency: 'CNY' },
      { id: 'date', name: '日期', type: 'date' },
    ],
  };
  const config = () => {
    const r = applyOps(createDefaultWorkspace('zh'), [{ op: 'addData', table: receipts }], {
      registry,
      locale: 'zh',
    });
    if (!r.ok) throw new Error(r.error);
    return r.config;
  };
  const existing = { amount: 30, date: '2026-11-03' };
  const flush = () =>
    act(async () => {
      jest.runOnlyPendingTimers();
    });

  async function openForm() {
    const repo = new MemoryWorkspaceRepo();
    await repo.setMeta('guide', 'done');
    await act(() => useGuide.getState().load(repo));
    await repo.insertRecord({
      id: 'r1',
      collectionId: 'claims',
      values: existing,
      createdAt: 1,
      updatedAt: 1,
    });
    await renderToolsApp(repo, new FakeFiles(), { seed: config });
    const spies = spyWrites(repo);
    await act(() =>
      router.push({ pathname: '/record/[collectionId]', params: { collectionId: 'claims' } }),
    );
    await screen.findByTestId('editor-amount', {}, { timeout: 4000 });
    return { repo, spies };
  }

  afterEach(async () => {
    jest.restoreAllMocks();
    useGuide.setState({ stage: null, repo: null });
    await flush();
    await flush();
    // Cleanup after router unmount (renderRouter will switch back to mock timers next time).
    jest.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it('Invariant 15: opening the form writes nothing', async () => {
    const { spies } = await openForm();
    await settle();
    expect(spies.filter(([, s]) => s.mock.calls.length > 0).map(([n]) => n)).toEqual([]);
  });

  it('Invariant 19 and 5: the prompt can always be passed, every time, and removes nothing', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const { repo, spies } = await openForm();
    await fireEvent.changeText(screen.getByTestId('editor-amount'), '30');
    await fireEvent.changeText(screen.getByTestId('editor-date'), '2026-11-03');
    await fireEvent.press(screen.getByTestId('editor-save'));
    await waitFor(() => expect(alert).toHaveBeenCalledTimes(1));
    // Back to the form, write nothing.
    const buttons = () => alert.mock.calls.at(-1)![2]!;
    await act(async () => buttons()[0]!.onPress!());
    expect(spies.filter(([, s]) => s.mock.calls.length > 0).map(([n]) => n)).toEqual([]);
    // Tap again and you can still select "Save anyway", only one extra is added and the original remains.
    await fireEvent.press(screen.getByTestId('editor-save'));
    await waitFor(() => expect(alert).toHaveBeenCalledTimes(2));
    expect(buttons().map((b) => b.text)).toEqual(['回到表单', '仍然保存']);
    await act(async () => buttons()[1]!.onPress!());
    await waitFor(async () => expect(await repo.listRecords('claims')).toHaveLength(2));
    await waitFor(() => expect(screen.queryByTestId('editor-save')).toBeNull());
    expect((await repo.getRecord('r1'))!.values).toEqual(existing);
    expect(spies.filter(([, s]) => s.mock.calls.length > 0).map(([n]) => n)).toEqual([
      'insertRecord',
    ]);
  });

  it('Invariant 19: when the records cannot be read, the save still goes through', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const { repo } = await openForm();
    jest.spyOn(repo, 'listRecords').mockRejectedValueOnce(new Error('disk'));
    await fireEvent.changeText(screen.getByTestId('editor-amount'), '30');
    await fireEvent.changeText(screen.getByTestId('editor-date'), '2026-11-03');
    await fireEvent.press(screen.getByTestId('editor-save'));
    await waitFor(() => expect(screen.queryByTestId('editor-save')).toBeNull());
    expect(alert).not.toHaveBeenCalled();
    expect(await repo.listRecords('claims')).toHaveLength(2);
  });
});

// Containers hand over data to tools (D-428, founder 2026-11-04 set in conversation: entering page runs nothing, tapped before handing over).
describe('Invariant 10 / 15 / 16: entering page, record page, list run nothing, write nothing (D-428)', () => {
  async function viewed() {
    const repo = new MemoryWorkspaceRepo();
    const files = new FakeFiles();
    const opened = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined as never);
    const asked = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    opened.mockClear();
    asked.mockClear();
    await repo.setMeta('guide', 'done');
    await act(() => useGuide.getState().load(repo));
    await repo.insertRecord({
      id: 'c1',
      collectionId: 'contacts',
      values: { name: 'A', phone: '123456', email: 'a@example.com', website: 'example.com' },
      createdAt: 1,
      updatedAt: 1,
    });
    await repo.insertRecord({
      id: 'm1',
      collectionId: 'my-card',
      values: { name: 'Me', phone: '123456' },
      createdAt: 1,
      updatedAt: 1,
    });
    const config = businessCards();
    await renderToolsApp(repo, files, { seed: () => config, locale: 'zh' });
    await settle();
    const spies = spyWrites(repo);
    return { repo, files, opened, asked, spies };
  }

  it('walking through every page and the entry page does nothing until a tap', async () => {
    const { files, opened, asked, spies, repo } = await viewed();
    const run = jest.spyOn(repo, 'startToolRun');
    for (const path of [
      { pathname: '/page/[pageId]', params: { pageId: 'my-card' } },
      { pathname: '/page/[pageId]', params: { pageId: 'contacts' } },
      { pathname: '/record/[collectionId]', params: { collectionId: 'contacts', recordId: 'c1' } },
      { pathname: '/record/[collectionId]', params: { collectionId: 'my-card', recordId: 'm1' } },
    ] as const) {
      await act(() => router.push(path));
      await settle();
      await settle();
    }
    expect(run).not.toHaveBeenCalled();
    expect(opened).not.toHaveBeenCalled();
    expect(asked).not.toHaveBeenCalled();
    expect(files.shared).toEqual([]);
    expect(files.clipboard).toBeFalsy();
    expect(spies.filter(([, s]) => s.mock.calls.length > 0).map(([n]) => n)).toEqual([]);
    jest.restoreAllMocks();
  });

  it('a tap runs exactly one tool, and it writes no record', async () => {
    const { opened, spies, repo } = await viewed();
    await act(() =>
      router.push({
        pathname: '/record/[collectionId]',
        params: { collectionId: 'contacts', recordId: 'c1' },
      }),
    );
    await settle();
    await fireEvent.press(await screen.findByTestId('record-action-record-call-phone'));
    await settle();
    expect(opened.mock.calls.map(([url]) => url)).toEqual(['tel:123456']);
    expect(spies.filter(([, s]) => s.mock.calls.length > 0).map(([n]) => n)).toEqual([]);
    expect((await repo.getRecord('c1'))!.updatedAt).toBe(1);
    jest.restoreAllMocks();
  });
});

describe('Invariant 15: search, sorting, filtering, expanding floating buttons write nothing (set by founder 2026-11-04)', () => {
  it('typing in the search, picking a sort or a tag, loading more and opening the dial write nothing', async () => {
    const repo = new MemoryWorkspaceRepo();
    await repo.setMeta('guide', 'done');
    await act(() => useGuide.getState().load(repo));
    for (let i = 0; i < 40; i++)
      await repo.insertRecord({
        id: `c${i}`,
        collectionId: 'contacts',
        values: { name: `P${i}`, company: 'Acme', tags: [i % 2 ? 'odd' : 'even'] },
        createdAt: i + 1,
        updatedAt: i + 1,
      });
    const config = businessCards();
    await renderToolsApp(repo, new FakeFiles(), { seed: () => config, locale: 'en' });
    await settle();
    await act(() => router.push({ pathname: '/page/[pageId]', params: { pageId: 'contacts' } }));
    await settle();
    const spies = spyWrites(repo);
    const run = jest.spyOn(repo, 'startToolRun');
    await fireEvent.changeText(await screen.findByTestId('browse-search'), 'p1');
    await fireEvent.changeText(screen.getByTestId('browse-search'), '');
    await fireEvent.press(screen.getByTestId('browse-sort-company'));
    await fireEvent.press(screen.getByTestId('browse-filter-tags-odd'));
    await fireEvent.press(screen.getByTestId('browse-filter-tags-all'));
    await fireEvent.scroll(screen.getByTestId('editable-scroll'), {
      nativeEvent: {
        contentOffset: { x: 0, y: 1000 },
        contentSize: { width: 100, height: 1200 },
        layoutMeasurement: { width: 100, height: 400 },
      },
    });
    await settle();
    await fireEvent.press(screen.getByTestId('dial-toggle'));
    expect(screen.getByTestId('dial-backdrop')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('dial-backdrop'));
    expect(screen.queryByTestId('dial-backdrop')).toBeNull();
    await settle();
    expect(run).not.toHaveBeenCalled();
    expect(spies.filter(([, s]) => s.mock.calls.length > 0).map(([n]) => n)).toEqual([]);
    jest.restoreAllMocks();
  });
});

describe('Invariant 2: tag values are not sent to AI (set by founder 2026-11-04)', () => {
  it('the request has the tags field, not the values', async () => {
    const { bodies, fetchImpl } = capturingFetch(relayReply);
    const provider = createRemoteAIProvider({
      baseUrl: 'https://relay.test',
      registry,
      now: () => NOW,
      fetchImpl,
    });
    const { store, repo } = await bootedStore(provider);
    const added = await store.getState().change('换个颜色', provider);
    expect(added.kind).toBe('drafted');
    await store.getState().deleteDraft();
    const collection = store.getState().config!.data.tables[0]!.id;
    await repo.insertRecord({
      id: 'tagged',
      collectionId: collection,
      values: { tags: [SENTINEL], labels: [SENTINEL] },
      createdAt: 1,
      updatedAt: 1,
    });
    await store.getState().change('再换个颜色', provider);
    for (const body of bodies) expect(body).not.toContain(SENTINEL);
  });
});

describe('Invariant 11 / 15: check-in grid (D-610)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    useGuide.setState({ stage: null, repo: null });
  });
  const today = (back = 0) => {
    const d = new Date();
    d.setDate(d.getDate() - back);
    return dayOf(d, calendarOf({ data: { tables: [] } }));
  };
  let visit = 0;
  async function openGrid() {
    const repo = new MemoryWorkspaceRepo();
    await repo.setMeta('guide', 'done');
    await act(() => useGuide.getState().load(repo));
    const at = Date.now();
    const put = (id: string, collectionId: string, values: Record<string, unknown>) =>
      repo.insertRecord({ id, collectionId, values, createdAt: at, updatedAt: at });
    await put('run', 'habits', { name: '跑步' });
    await put('read', 'habits', { name: '读书' });
    await put('c1', 'checkins', { habit: 'run', date: today() });
    await put('c2', 'checkins', { habit: 'read', date: today(2) });
    await put('c3', 'checkins', { habit: 'read', date: today(2) });
    const app = await renderToolsApp(repo, new FakeFiles(), { seed: gridConfig, locale: 'zh' });
    await act(() =>
      router.push({ pathname: '/page/[pageId]', params: { pageId: 'week', visit: ++visit } }),
    );
    await screen.findByTestId(`grid-grid-cell-run-${today()}`);
    await settle();
    return { ...app, repo };
  }

  it('Invariant 15: paging back and forth and opening a cell writes nothing', async () => {
    const { repo } = await openGrid();
    const spies = spyWrites(repo);
    await fireEvent.press(screen.getByTestId('grid-grid-prev'));
    await fireEvent.press(screen.getByTestId('grid-grid-prev'));
    await fireEvent.press(screen.getByTestId('grid-grid-today'));
    // Tapping a cell with two entries just lists them; long-pressing a cell with records also just lists them.
    await fireEvent.press(await screen.findByTestId(`grid-grid-cell-read-${today(2)}`));
    await fireEvent(screen.getByTestId(`grid-grid-cell-run-${today()}`), 'longPress');
    await settle();
    expect(spies.filter(([, s]) => s.mock.calls.length > 0).map(([n]) => n)).toEqual([]);
  });

  it('Invariant 11: adding in a cell shows no undo; removing the only entry of a cell shows undo', async () => {
    const { repo } = await openGrid();
    await fireEvent.press(screen.getByTestId(`grid-grid-cell-read-${today()}`));
    expect(await screen.findByTestId('toast')).toHaveTextContent(/已在「打卡」添加一条/);
    expect(screen.queryByTestId('toast-undo')).toBeNull();
    await fireEvent.press(screen.getByTestId(`grid-grid-cell-run-${today()}`));
    expect(await screen.findByTestId('toast')).toHaveTextContent(/已从「打卡」删除一条/);
    expect(screen.getByTestId('toast-undo')).toBeTruthy();
    expect((await repo.listDeletedRecords()).map((r) => r.id)).toEqual(['c1']);
  });
});
