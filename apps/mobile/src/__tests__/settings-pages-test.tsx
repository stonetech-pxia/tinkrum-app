import { applyOps, createDefaultWorkspace, type Locale, type Op, type Registry } from '@morph/core';
import { act, fireEvent, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { screen } from 'expo-router/testing-library';
import { Alert, Linking } from 'react-native';

import { MemoryWorkspaceRepo } from '../storage/memory';
import { renderToolsApp } from '../test-utils/render-app';

// "Apps & Presets" and "Data" in settings visible in a single screen (D-614): three rows directly
// on the settings page; presets page has only two buttons and preset list, with addition methods,
// sample apps, and saved forms expanding on tap; data page has one row per table, with table
// operations inside each table's own page.

const seed = (locale: Locale, registry: Registry, withApp = false) => {
  const r = applyOps(
    createDefaultWorkspace(locale),
    [
      {
        op: 'addData',
        table: { id: 'notes', name: '笔记', fields: [{ id: 'title', name: '标题', type: 'text' }] },
      },
      // Second app and its tables: data page grouped by app (D-615).
      ...(withApp
        ? [
            { op: 'addContainer', app: { id: 'fit', name: '健身', icon: 'heart' } },
            {
              op: 'addData',
              table: {
                id: 'runs',
                name: '跑步',
                app: 'fit',
                fields: [{ id: 'km', name: '公里', type: 'number' }],
              },
            },
          ]
        : []),
    ] as Op[],
    { registry, locale },
  );
  if (!r.ok) throw new Error(r.error);
  return r.config;
};

async function start(locale: Locale = 'zh', withApp = false) {
  const repo = new MemoryWorkspaceRepo();
  await repo.insertRecord({
    id: 'note0aaaa',
    collectionId: 'notes',
    values: { title: '一' },
    createdAt: 1,
    updatedAt: 1,
  });
  const { store } = await renderToolsApp(repo, undefined, {
    seed: (l: Locale, registry: Registry) => seed(l, registry, withApp),
    locale,
  });
  await fireEvent.press(await screen.findByTestId('nav-settings'));
  return { repo, store };
}

describe('Settings rows', () => {
  it('Apps and presets, Data and Storage are rows of their own; Downloads moved under Data → More', async () => {
    await start();
    expect(await screen.findByTestId('settings-presets')).toHaveTextContent(/App 和预设/);
    expect(screen.getByTestId('settings-data')).toHaveTextContent(/表、备份、最近删除/);
    expect(screen.getByTestId('settings-storage')).toBeTruthy();
    expect(screen.queryByTestId('settings-more')).toBeNull();
    expect(screen.queryByTestId('settings-packs')).toBeNull();
    await fireEvent.press(screen.getByTestId('settings-data'));
    await fireEvent.press(await screen.findByTestId('data-more'));
    expect(await screen.findByTestId('settings-packs')).toBeTruthy();
    expect(screen.getByTestId('export-app-config')).toBeTruthy();
    expect(screen.getByTestId('prefill-memory')).toBeTruthy();
  });
});

describe('Apps and presets page', () => {
  it('shows two buttons and the list; the ways to add and the save form open only when tapped', async () => {
    await start();
    await fireEvent.press(await screen.findByTestId('settings-presets'));
    await screen.findByTestId('presets-screen');
    expect(screen.getByTestId('preset-add')).toHaveTextContent('添加 App');
    expect(screen.getByTestId('preset-new')).toHaveTextContent('保存现在的样子');
    expect(screen.getByTestId('presets-none')).toBeTruthy();
    for (const id of ['preset-import', 'preset-paste', 'preset-share-to-ai', 'preset-samples'])
      expect(screen.queryByTestId(id)).toBeNull();
    expect(screen.queryByTestId('preset-name-input')).toBeNull();
    expect(screen.queryByTestId('preset-sample-receipts')).toBeNull();

    await fireEvent.press(screen.getByTestId('preset-add'));
    expect(screen.getByTestId('preset-import')).toHaveTextContent(/从文件导入/);
    expect(screen.getByTestId('preset-paste')).toBeTruthy();
    expect(screen.getByTestId('preset-share-to-ai')).toHaveTextContent(/让 AI 做一个/);
    expect(screen.getByTestId('preset-make-with-ai')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('preset-samples'));
    expect(screen.getByTestId('preset-sample-receipts')).toBeTruthy();
    expect(screen.queryByTestId('preset-import')).toBeNull();

    await fireEvent.press(screen.getByTestId('preset-new'));
    expect(screen.getByTestId('preset-name-input')).toBeTruthy();
    expect(screen.queryByTestId('preset-sample-receipts')).toBeNull();
    await fireEvent.press(screen.getByTestId('preset-new'));
    expect(screen.queryByTestId('preset-name-input')).toBeNull();
  });
});

describe('Data page', () => {
  it('one row per table; its export, select and import live on the table’s own page', async () => {
    await start();
    await fireEvent.press(await screen.findByTestId('settings-data'));
    expect(await screen.findByTestId('table-notes')).toHaveTextContent(/笔记/);
    // A row has only name and count; title is "Data tables" when there is only a single app (D-615).
    expect(screen.getByTestId('table-notes')).toHaveTextContent(/^笔记1 条记录›$/);
    expect(screen.getByText('数据表')).toBeTruthy();
    expect(screen.queryByText('主页')).toBeNull();
    expect(screen.queryByTestId('export-notes')).toBeNull();
    expect(screen.queryByTestId('select-notes')).toBeNull();
    expect(screen.getByTestId('data-deleted')).toBeTruthy();
    // If there are no unused tables in the UI, this row does not appear.
    expect(screen.queryByTestId('data-unused')).toBeNull();

    await fireEvent.press(screen.getByTestId('table-notes'));
    expect(await screen.findByTestId('data-table-screen')).toBeTruthy();
    expect(screen.getByTestId('export-notes')).toBeTruthy();
    expect(screen.getByTestId('select-notes')).toBeTruthy();
    // Tables without file fields have no attachment settings.
    expect(screen.queryByTestId('read-attachments-notes')).toBeNull();

    await act(() => router.back());
    await fireEvent.press(await screen.findByTestId('data-deleted'));
    expect(await screen.findByTestId('data-deleted-screen')).toHaveTextContent(/保留 30 天/);
  });

  it('with several apps the tables are grouped under each app’s name, Home first', async () => {
    await start('zh', true);
    await fireEvent.press(await screen.findByTestId('settings-data'));
    await screen.findByTestId('table-runs');
    const labels = screen.getAllByText(/^(主页|健身|数据表)$/).map((n) => n.props.children);
    expect(labels).toEqual(['主页', '健身']);
    expect(screen.getByTestId('table-runs')).toHaveTextContent(/^跑步0 条记录›$/);
    // Trash and more appear above tables, keeping tables on the first screen no matter how many there are (D-615).
    const order = screen
      .getAllByTestId(/^(data-deleted|data-more|table-notes|table-runs)$/)
      .map((n) => n.props.testID);
    expect(order).toEqual(['data-deleted', 'data-more', 'table-notes', 'table-runs']);
  });

  it('French: the new rows and pages use French words', async () => {
    await start('fr');
    expect(await screen.findByTestId('settings-presets')).toHaveTextContent(/Apps et préréglages/);
    await fireEvent.press(screen.getByTestId('settings-data'));
    expect(await screen.findByTestId('table-notes')).toHaveTextContent(/1 entrée/);
    expect(screen.getByTestId('data-more')).toHaveTextContent(/Plus/);
  });
});

// Google Play's User Data policy requires the privacy policy to be reachable inside the app too.
describe('Privacy policy row', () => {
  const URL = 'https://tinkrum.stonetech.dev/privacy';
  const openURL = () =>
    jest
      .spyOn(Linking, 'openURL')
      .mockClear()
      .mockResolvedValue(undefined as never);

  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['en', /Privacy policy.*Opens in your browser/],
    ['zh', /隐私政策.*在浏览器中打开/],
    ['fr', /Politique de confidentialité.*S’ouvre dans votre navigateur/],
  ] as const)('%s: opens the policy in the browser, only on a tap', async (locale, text) => {
    const open = openURL();
    const { repo, store } = await start(locale);
    const row = await screen.findByTestId('settings-privacy');
    expect(row).toHaveTextContent(text);
    expect(open).not.toHaveBeenCalled();
    const head = store.getState().head!.id;
    const writes = (['insertRecord', 'updateRecord', 'commitRevision'] as const).map((name) =>
      jest.spyOn(repo, name),
    );
    await fireEvent.press(row);
    expect(open.mock.calls).toEqual([[URL]]);
    expect(writes.flatMap((spy) => spy.mock.calls)).toEqual([]);
    expect(store.getState().head!.id).toBe(head);
  });

  it('says so when the phone cannot open it', async () => {
    openURL().mockRejectedValue(new Error('no browser'));
    const asked = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    await start('en');
    await fireEvent.press(await screen.findByTestId('settings-privacy'));
    await waitFor(() => expect(asked).toHaveBeenCalledWith("This device can't open it."));
  });

  it('still opens while a look draft is being previewed', async () => {
    const open = openURL();
    const { store } = await start('zh');
    await act(() => store.getState().change('主题换成绿色'));
    expect(store.getState().draft).not.toBeNull();
    await fireEvent.press(await screen.findByTestId('settings-privacy'));
    expect(open.mock.calls).toEqual([[URL]]);
  });
});
