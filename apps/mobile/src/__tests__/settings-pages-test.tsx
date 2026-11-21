import { applyOps, createDefaultWorkspace, type Locale, type Registry } from '@morph/core';
import { act, fireEvent } from '@testing-library/react-native';
import { router } from 'expo-router';
import { screen } from 'expo-router/testing-library';

import { MemoryWorkspaceRepo } from '../storage/memory';
import { renderToolsApp } from '../test-utils/render-app';

// 设置里的「App 和预设」「数据」一屏看完（D-614）：设置页直接有三行；预设页只有两个按钮和预设列表，
// 添加的几种方式、示例 App、保存的表单点了才展开；数据页每张表一行，表的操作在表自己的页面里。

const seed = (locale: Locale, registry: Registry) => {
  const r = applyOps(
    createDefaultWorkspace(locale),
    [
      {
        op: 'addData',
        table: { id: 'notes', name: '笔记', fields: [{ id: 'title', name: '标题', type: 'text' }] },
      },
    ],
    { registry, locale },
  );
  if (!r.ok) throw new Error(r.error);
  return r.config;
};

async function start(locale: Locale = 'zh') {
  const repo = new MemoryWorkspaceRepo();
  await repo.insertRecord({
    id: 'note0aaaa',
    collectionId: 'notes',
    values: { title: '一' },
    createdAt: 1,
    updatedAt: 1,
  });
  await renderToolsApp(repo, undefined, { seed, locale });
  await fireEvent.press(await screen.findByTestId('nav-settings'));
  return repo;
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
    expect(screen.getByTestId('table-notes')).toHaveTextContent(/1 条记录 · 主页/);
    expect(screen.queryByTestId('export-notes')).toBeNull();
    expect(screen.queryByTestId('select-notes')).toBeNull();
    expect(screen.getByTestId('data-deleted')).toBeTruthy();
    // 没有不在界面里的表，这一行就不出现。
    expect(screen.queryByTestId('data-unused')).toBeNull();

    await fireEvent.press(screen.getByTestId('table-notes'));
    expect(await screen.findByTestId('data-table-screen')).toBeTruthy();
    expect(screen.getByTestId('export-notes')).toBeTruthy();
    expect(screen.getByTestId('select-notes')).toBeTruthy();
    // 没有文件字段的表没有附件的设置。
    expect(screen.queryByTestId('read-attachments-notes')).toBeNull();

    await act(() => router.back());
    await fireEvent.press(await screen.findByTestId('data-deleted'));
    expect(await screen.findByTestId('data-deleted-screen')).toHaveTextContent(/保留 30 天/);
  });

  it('French: the new rows and pages use French words', async () => {
    await start('fr');
    expect(await screen.findByTestId('settings-presets')).toHaveTextContent(/Apps et préréglages/);
    await fireEvent.press(screen.getByTestId('settings-data'));
    expect(await screen.findByTestId('table-notes')).toHaveTextContent(/1 entrée · Accueil/);
    expect(screen.getByTestId('data-more')).toHaveTextContent(/Plus/);
  });
});
