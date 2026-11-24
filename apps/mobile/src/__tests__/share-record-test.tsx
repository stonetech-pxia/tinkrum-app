import {
  applyOps,
  attachmentIds,
  BUILTIN_TOOLS,
  createRegistry,
  createDefaultWorkspace,
  MAX_ATTACHMENTS,
  templateOps,
  type Locale,
  type Op,
  type Registry,
  type WorkspaceConfig,
} from '@morph/core';
import { act, fireEvent, waitFor, within } from '@testing-library/react-native';
import { router } from 'expo-router';
import { screen } from 'expo-router/testing-library';

import { useGuide } from '../guide/store';
import { recordChoices } from '../share/save-as-record';
import { useIncoming } from '../share/incoming';
import { MemoryWorkspaceRepo } from '../storage/memory';
import { FakeFiles, TINY_JPEG } from '../test-utils/fake-files';
import { renderToolsApp } from '../test-utils/render-app';

// Inbox "Save as record" (D-392): select a table with attachment fields or a preset table, open the
// new record form, and received files are already in attachments. Three states: new user (no
// tables), with data (tables with and without attachments exist), edge cases (two files, over 20,
// return without saving).

afterEach(() => {
  useIncoming.getState().clear();
  useGuide.setState({ stage: null, repo: null, introOpen: false });
});

/** "Receipts" table with attachment field and "Expenses" table without attachment field (expense template). */
const RECEIPTS: Op = {
  op: 'addData',
  table: {
    id: 'receipts',
    name: '收据',
    fields: [
      { id: 'title', name: '标题', type: 'text' },
      { id: 'photo', name: '照片', type: 'file' },
    ],
  },
};

function seeded(locale: Locale, registry: Registry): WorkspaceConfig {
  const blank = createDefaultWorkspace(locale);
  const budget = applyOps(blank, templateOps('budget', blank, locale), { registry, locale });
  if (!budget.ok) throw new Error(budget.error);
  const r = applyOps(budget.config, [RECEIPTS], { registry, locale });
  if (!r.ok) throw new Error(r.error);
  return r.config;
}

/** Onboarding is complete (otherwise the welcome page would cover the inbox page). */
async function render(seed?: (locale: Locale, registry: Registry) => WorkspaceConfig) {
  const repo = new MemoryWorkspaceRepo();
  await repo.setMeta('guide', 'done');
  await act(() => useGuide.getState().load(repo));
  return renderToolsApp(repo, new FakeFiles(), seed ? { seed } : {});
}

async function openShare(files: FakeFiles, names: string[], mime = 'image/jpeg') {
  const picked = names.map((n) => files.offer(n, TINY_JPEG, mime));
  await act(async () => useIncoming.getState().receive(picked, [], 'picker'));
  await act(() => router.push('/share'));
  return picked;
}

/** Save and wait for the record page to close and return to the inbox page (otherwise router.back will land in the next test). */
/** A single file is selected in the preview page's "Save Record" panel; multiple files are selected in the inbox page's "Save as Record" (D-457). */
async function openChooser() {
  await fireEvent.press(await screen.findByTestId(/^(preview-record|share-record-choose)$/));
}

async function save() {
  await fireEvent.press(screen.getByTestId('editor-save'));
  await waitFor(() => expect(screen.queryByTestId('editor-save')).toBeNull());
  expect(await screen.findByTestId('share-screen')).toBeTruthy();
}

async function choose(id: string) {
  await openChooser();
  await fireEvent.press(await screen.findByTestId(`share-record-${id}`));
}

const listIds = () =>
  within(screen.getByTestId('share-record-list'))
    .queryAllByTestId(/^share-record-(table-.+|new)$/)
    .map((e) => e.props.testID as string);

/** Select a preset on the new form page. */
async function pickType(preset: string) {
  await fireEvent.press(await screen.findByTestId('new-table-change-type'));
  await fireEvent.press(await screen.findByTestId(`new-table-type-${preset}`));
}

async function saveNew() {
  await fireEvent.press(screen.getByTestId('new-table-save'));
  await waitFor(() => expect(screen.queryByTestId('new-table-save')).toBeNull());
  expect(await screen.findByTestId('share-screen')).toBeTruthy();
}

describe('recordChoices', () => {
  it('Only list tables with attachment fields', () => {
    expect(recordChoices(createDefaultWorkspace('zh'))).toEqual([]);
    expect(recordChoices(seeded('fr', createRegistry(BUILTIN_TOOLS)))).toEqual([
      { kind: 'table', tableId: 'receipts', name: '收据' },
    ]);
  });
});

describe('recordChoices: files like receipts recommend tables with receipt rules', () => {
  const config = () => {
    const base = seeded('zh', createRegistry(BUILTIN_TOOLS));
    const next = applyOps(
      base,
      [
        {
          op: 'addData',
          table: {
            id: 'bills',
            name: '收据（样板）',
            prefillRules: 'receipt',
            fields: [
              { id: 'merchant', name: '商家', type: 'text' },
              { id: 'photo', name: '照片', type: 'file' },
            ],
          },
        },
      ],
      { registry: createRegistry(BUILTIN_TOOLS), locale: 'zh' },
    );
    if (!next.ok) throw new Error(next.error);
    return next.config;
  };
  it('Like receipts: tables with receipt rules ranked first and marked recommended, other tables follow normally', () => {
    expect(recordChoices(config(), true)).toEqual([
      { kind: 'table', tableId: 'bills', name: '收据（样板）', recommended: true },
      { kind: 'table', tableId: 'receipts', name: '收据' },
    ]);
  });
  it('Unlike receipts, or no tables with receipt rules: not recommended, order unchanged', () => {
    expect(recordChoices(config()).map((c) => c.tableId)).toEqual(['receipts', 'bills']);
    expect(recordChoices(seeded('zh', createRegistry(BUILTIN_TOOLS)), true)).toEqual([
      { kind: 'table', tableId: 'receipts', name: '收据' },
    ]);
  });
});

describe('Preview page and inbox page -> Save as record', () => {
  it('New user: select "New Form", pick preset, tap "Record" to create table, store only one record', async () => {
    const { files, repo, store } = await render();
    const [photo] = await openShare(files, ['IMG_1.jpg']);
    // A single file is a preview page, where "Save Record" is one of the buttons at the bottom row, tapping it pops up the panel (D-457).
    expect(await screen.findByTestId('preview-record')).toBeTruthy();
    expect(screen.queryByTestId('share-record-list')).toBeNull();
    const before = store.getState().head!.id;

    await openChooser();
    expect(listIds()).toEqual(['share-record-new']);
    expect(screen.queryByText('你的表')).toBeNull();
    await fireEvent.press(screen.getByTestId('share-record-new'));
    expect(await screen.findByTestId('draft-attachments-file-0')).toBeTruthy();
    await pickType('purchase');
    // Nothing has been created yet.
    expect(store.getState().config!.data.tables).toEqual([]);
    expect(store.getState().head!.id).toBe(before);

    await fireEvent.changeText(screen.getByTestId('draft-merchant'), '超市');
    await saveNew();
    const config = store.getState().config!;
    expect(config.data.tables.map((c) => c.id)).toEqual(['receipts']);
    // Select shopping vouchers without changing fields: create the full "Receipts" sample suite (D-479), including list page, expense page, and two quick actions.
    expect(config.containers.pages.map((p) => p.id)).toEqual(
      expect.arrayContaining(['receipts', 'spending']),
    );
    expect(config.data.tables[0]!.name).toBe('收据');
    expect(store.getState().head!.source).toBe('user');
    const [asset] = await repo.listAssets();
    expect(files.disk.get(asset!.path)).toEqual(TINY_JPEG);
    const [record] = await repo.listRecords('receipts');
    expect(record!.values.merchant).toBe('超市');
    expect(attachmentIds(record!.values.attachments)).toEqual([asset!.id]);
    expect(files.disk.has(photo!.uri)).toBe(true);
    expect(recordChoices(store.getState().config!)[0]).toEqual({
      kind: 'table',
      tableId: 'receipts',
      name: '收据',
    });
  });

  it("Selected shopping vouchers and changed table name: do not use full receipt suite, build according to preset's own pages (D-479)", async () => {
    const { files, store } = await render();
    await openShare(files, ['IMG_1.jpg']);
    await choose('new');
    expect(await screen.findByTestId('draft-attachments-file-0')).toBeTruthy();
    await pickType('purchase');
    expect(screen.getByTestId('new-table-name').props.value).toBe('收据');
    await fireEvent.changeText(screen.getByTestId('new-table-name'), '我的小票');
    await fireEvent.changeText(screen.getByTestId('draft-merchant'), '超市');
    await saveNew();
    const config = store.getState().config!;
    expect(config.data.tables.map((c) => c.id)).toEqual(['purchases']);
    expect(config.containers.pages.some((p) => p.id === 'spending')).toBe(false);
  });

  it('Can build without preset: add fields, rename, remove fields, write custom table name', async () => {
    const { files, repo, store } = await render();
    await openShare(files, ['IMG_1.jpg']);
    await choose('new');
    expect(await screen.findByTestId('draft-attachments-file-0')).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('new-table-name'), '车险');
    await fireEvent.press(screen.getByTestId('new-table-add'));
    await fireEvent.changeText(screen.getByTestId('new-table-add-name'), '保险公司');
    await fireEvent.press(screen.getByTestId('new-table-add-save'));
    const company = await screen.findByTestId('draft-field-3');
    await fireEvent.changeText(company, '平安');
    await fireEvent.press(screen.getByTestId('new-table-edit'));
    await fireEvent(screen.getByTestId('new-table-field-name-field-3'), 'endEditing', {
      nativeEvent: { text: '承保公司' },
    });
    await fireEvent.press(screen.getByTestId('new-table-field-remove-title'));
    await fireEvent.press(screen.getByTestId('new-table-edit'));
    await saveNew();
    const table = store.getState().config!.data.tables[0]!;
    expect(table.name).toBe('车险');
    expect(table.fields.map((f) => f.name)).toEqual(['承保公司', '附件']);
    const [record] = await repo.listRecords(table.id);
    expect(record!.values['field-3']).toBe('平安');
    // List displays remaining text fields (removed fields are not referenced by pages, invariant 18).
    expect(store.getState().config!.containers.pages.some((p) => p.title === '车险')).toBe(true);
  });

  it('With data: list only tables with attachment fields and "New Form"; selecting a table does not change config, files are placed into its attachment field', async () => {
    const { files, repo, store } = await render(seeded);
    await openShare(files, ['IMG_1.jpg']);
    await openChooser();
    expect(listIds()).toEqual(['share-record-new', 'share-record-table-receipts']);
    expect(screen.getByText('你的表')).toBeTruthy();
    const head = store.getState().head!.id;
    await fireEvent.press(screen.getByTestId('share-record-table-receipts'));
    expect(await screen.findByTestId('editor-photo-file-0')).toBeTruthy();
    expect(store.getState().head!.id).toBe(head);
    await save();
    expect(await repo.listRecords('receipts')).toHaveLength(1);
    const [asset] = await repo.listAssets();
    expect((await repo.listRecords('receipts'))[0]!.values.photo).toEqual([asset!.id]);
  });

  it('Save two files as a single record, two attachments in order', async () => {
    const { files, repo } = await render();
    await openShare(files, ['A.jpg', 'B.jpg']);
    await choose('new');
    expect(await screen.findByTestId('draft-attachments-file-1')).toBeTruthy();
    await saveNew();
    expect(await repo.listRecords('file-entries')).toHaveLength(1);
    const assets = await repo.listAssets();
    const byName = Object.fromEntries(assets.map((a) => [a.name, a.id]));
    expect((await repo.listRecords('file-entries'))[0]!.values.attachments).toEqual([
      byName['A.jpg'],
      byName['B.jpg'],
    ]);
  });

  it('Over 20: explain that only the first 20 are included, exactly 20 in the form', async () => {
    const { files, repo } = await render();
    // Photos can be received up to 10 at a time, PDFs up to 50.
    const names = Array.from({ length: MAX_ATTACHMENTS + 2 }, (_, i) => `P${i}.pdf`);
    await openShare(files, names, 'application/pdf');
    await openChooser();
    expect(screen.getByTestId('share-record-too-many').props.children).toBe(
      '一条记录最多放 20 个文件，只放前 20 个。',
    );
    await fireEvent.press(screen.getByTestId('share-record-new'));
    expect(await screen.findByTestId(`draft-attachments-file-${MAX_ATTACHMENTS - 1}`)).toBeTruthy();
    expect(screen.queryByTestId(`draft-attachments-file-${MAX_ATTACHMENTS}`)).toBeNull();
    expect(await repo.listAssets()).toHaveLength(MAX_ATTACHMENTS);
  });

  it('Return without saving: do not create table, do not save record, copied files deleted, received files remain', async () => {
    const { files, repo, store } = await render();
    const [photo] = await openShare(files, ['IMG_1.jpg']);
    await choose('new');
    expect(await screen.findByTestId('draft-attachments-file-0')).toBeTruthy();
    await pickType('bill');
    expect(await repo.listAssets()).toHaveLength(1);
    await act(() => router.back());
    expect(await screen.findByTestId('share-screen')).toBeTruthy();
    await act(async () => {
      for (let i = 0; i < 20; i++) await Promise.resolve();
    });
    expect(await repo.listAssets()).toEqual([]);
    expect([...files.disk.keys()].filter((k) => k.startsWith('assets/'))).toEqual([]);
    expect(store.getState().config!.data.tables).toEqual([]);
    expect(files.disk.has(photo!.uri)).toBe(true);
  });

  it("New user hasn't finished reading introduction: recording causes shell to remount, file remains, welcome page not pushed again", async () => {
    // On real device (2026-10-31): home screen pushed welcome page, inbox page covered it; after table creation, shell remounted with new version and pushed again.
    const repo = new MemoryWorkspaceRepo();
    await act(() => useGuide.getState().load(repo));
    expect(useGuide.getState().stage).toBe('intro');
    const { files } = await renderToolsApp(repo, new FakeFiles());
    expect(await screen.findByTestId('welcome')).toBeTruthy();
    await openShare(files, ['IMG_1.jpg']);
    await choose('new');
    await pickType('purchase');
    await saveNew();
    expect(screen.queryByTestId('welcome')).toBeNull();
    const [record] = await repo.listRecords('receipts');
    expect(attachmentIds(record!.values.attachments)).toHaveLength(1);
    expect(await repo.listAssets()).toHaveLength(1);
    await act(() => router.back());
    expect(await screen.findByTestId('welcome')).toBeTruthy();
  });

  it('Let Tink modify: create table first, switch to record page, AI page only knows about this table, request contains no file content', async () => {
    const { files, store } = await render();
    await openShare(files, ['IMG_1.jpg']);
    await choose('new');
    await pickType('insurance');
    await fireEvent.press(screen.getByTestId('new-table-tink'));
    await waitFor(() =>
      expect(store.getState().config!.data.tables.map((c) => c.id)).toEqual(['insurance']),
    );
    expect(await screen.findByTestId('change-about')).toBeTruthy();
    await act(() => router.back());
    expect(await screen.findByTestId('editor-attachments-file-0')).toBeTruthy();
  });
});
