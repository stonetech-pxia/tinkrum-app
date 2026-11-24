import {
  applyOps,
  createDefaultWorkspace,
  type Field,
  type Locale,
  type Registry,
} from '@morph/core';
import { act, fireEvent, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { screen } from 'expo-router/testing-library';

import { useGuide } from '../guide/store';
import { MemoryWorkspaceRepo } from '../storage/memory';
import { renderToolsApp } from '../test-utils/render-app';

// A single record of a table (single, D-424) and display based on record existence (showIf): no records, has records, content too large for QR code.

const FIELDS: Field[] = [
  { id: 'name', name: '姓名', type: 'text' },
  { id: 'phone', name: '电话', type: 'text', format: 'phone' },
  { id: 'addr', name: '地址', type: 'text' },
  { id: 'photo', name: '照片', type: 'file' },
];

const seed = (locale: Locale, registry: Registry) => {
  const r = applyOps(
    createDefaultWorkspace(locale),
    [
      { op: 'addData', table: { id: 'mine', name: '我的名片', fields: FIELDS } },
      {
        op: 'addContainer',
        page: {
          id: 'mine-page',
          title: '我的名片',
          blocks: [
            {
              id: 'one',
              look: 'single',
              source: { table: 'mine' },
              show: { fields: ['name', 'phone'], qr: true },
              showIf: { table: 'mine', has: 'some' },
            },
            {
              id: 'none',
              look: 'text',
              show: { text: '还没有名片' },
              showIf: { table: 'mine', has: 'none' },
            },
            { id: 'always', look: 'text', show: { text: '一直都在' } },
          ],
        },
      },
      {
        // Display the opened record (D-558) on the page dedicated to a single record (D-342).
        op: 'addContainer',
        page: {
          id: 'one-page',
          title: '一张名片',
          of: 'mine',
          blocks: [
            {
              id: 'me',
              look: 'single',
              source: { table: 'mine', record: '$record' },
              show: { fields: ['name', 'photo'] },
            },
          ],
        },
      },
      {
        op: 'addContainer',
        page: {
          id: 'plain-page',
          title: '没有条件',
          blocks: [
            {
              id: 'one',
              look: 'single',
              source: { table: 'mine' },
              show: { fields: ['name'] },
            },
          ],
        },
      },
    ],
    { registry, locale },
  );
  if (!r.ok) throw new Error(r.error);
  return r.config;
};

const settle = () =>
  act(async () => {
    jest.advanceTimersByTime(200);
    await Promise.resolve();
  });

async function open(
  records: Record<string, unknown>[] = [],
  pageId = 'mine-page',
  record?: string,
  before?: (repo: MemoryWorkspaceRepo) => Promise<void>,
) {
  const repo = new MemoryWorkspaceRepo();
  await repo.setMeta('guide', 'done');
  await act(() => useGuide.getState().load(repo));
  for (const [i, values] of records.entries())
    await repo.insertRecord({
      id: `r${i}`,
      collectionId: 'mine',
      values,
      createdAt: 100 + i,
      updatedAt: 100 + i,
    });
  await before?.(repo);
  const app = await renderToolsApp(repo, undefined, { locale: 'zh', seed });
  await settle();
  await act(() =>
    router.push({ pathname: '/page/[pageId]', params: { pageId, ...(record ? { record } : {}) } }),
  );
  await settle();
  return { ...app, repo };
}

afterEach(() => useGuide.setState({ stage: null, repo: null }));

describe('no entry yet', () => {
  it('shows what is for no entries, and not the card', async () => {
    await open();
    expect(await screen.findByText('还没有名片')).toBeTruthy();
    expect(screen.getByText('一直都在')).toBeTruthy();
    expect(screen.queryByTestId('single-r0')).toBeNull();
    expect(screen.queryByTestId('single-qr')).toBeNull();
  });

  it('without a condition, the block says there is nothing', async () => {
    await open([], 'plain-page');
    expect(await screen.findByText('还没有记录')).toBeTruthy();
    expect(screen.queryByTestId('single-edit')).toBeNull();
  });
});

describe('with an entry', () => {
  it('shows the fields and a QR code; the no-entry block is gone', async () => {
    await open([{ name: '张三', phone: '138 0000 0000' }]);
    expect(await screen.findByText('张三')).toBeTruthy();
    expect(screen.getByText('138 0000 0000')).toBeTruthy();
    const image = screen.getByTestId('single-qr');
    expect(image.props.source.uri).toMatch(/^data:image\/png;base64,/);
    expect(screen.queryByText('还没有名片')).toBeNull();
  });

  it('uses the oldest entry', async () => {
    await open([{ name: '先加的' }, { name: '后加的' }]);
    expect(await screen.findByText('先加的')).toBeTruthy();
    expect(screen.queryByText('后加的')).toBeNull();
  });

  it('edit opens the entry form of that entry', async () => {
    await open([{ name: '张三' }]);
    await fireEvent.press(await screen.findByTestId('single-edit'));
    await waitFor(() => expect(screen.getByTestId('editor-name').props.value).toBe('张三'));
  });

  it('skips empty fields, and asks for no QR code when the block has none', async () => {
    await open([{ name: '张三' }], 'plain-page');
    expect(await screen.findByText('张三')).toBeTruthy();
    expect(screen.queryByTestId('single-qr')).toBeNull();
    expect(screen.queryByTestId('single-qr-note')).toBeNull();
  });
});

describe('edge cases', () => {
  it('too much for a QR code: the info stays, with a short note instead', async () => {
    await open([{ name: '张三', addr: '很长的地址'.repeat(300) }]);
    expect(await screen.findByText('张三')).toBeTruthy();
    expect(screen.queryByTestId('single-qr')).toBeNull();
    expect(screen.getByTestId('single-qr-note')).toHaveTextContent('内容太多，放不进二维码。');
  });

  it('an entry with nothing for a card shows no code and no note', async () => {
    await open([{ phone: '分机' }]);
    await screen.findByTestId('single-edit');
    expect(screen.queryByTestId('single-qr')).toBeNull();
    expect(screen.queryByTestId('single-qr-note')).toBeNull();
  });

  it('adding the first entry switches the page without leaving it', async () => {
    const { store, repo } = await open();
    await screen.findByText('还没有名片');
    await repo.insertRecord({
      id: 'r0',
      collectionId: 'mine',
      values: { name: '张三' },
      createdAt: 1,
      updatedAt: 1,
    });
    await act(async () => store.getState().bumpRecords());
    await settle();
    expect(await screen.findByText('张三')).toBeTruthy();
    expect(screen.queryByText('还没有名片')).toBeNull();
    expect(screen.getByText('一直都在')).toBeTruthy();
  });
});

describe('on a page for one entry (D-558)', () => {
  const asset = (id: string, name: string, mimeType: string) => ({
    id,
    name,
    mimeType,
    size: 1000,
    path: `assets/${id}/${name}`,
    source: 'picked' as const,
    createdAt: 1,
  });

  it('shows the opened entry, not the oldest', async () => {
    await open([{ name: '先加的' }, { name: '后加的' }], 'one-page', 'r1');
    expect(await screen.findByTestId('single-r1')).toBeTruthy();
    expect(screen.getAllByText('后加的').length).toBeGreaterThan(0);
    expect(screen.queryByTestId('single-r0')).toBeNull();
  });

  it('edit edits the opened entry', async () => {
    await open([{ name: '先加的' }, { name: '后加的' }], 'one-page', 'r1');
    await fireEvent.press(await screen.findByTestId('single-edit'));
    await waitFor(() => expect(screen.getByTestId('editor-name').props.value).toBe('后加的'));
  });

  it('pictures in a file field are drawn; other files stay a line of text', async () => {
    await open([{ name: '张三', photo: ['face', 'cv'] }], 'one-page', 'r0', async (repo) => {
      await repo.addAsset(asset('face', 'me.jpg', 'image/jpeg'));
      await repo.addAsset(asset('cv', 'cv.pdf', 'application/pdf'));
    });
    expect(await screen.findByTestId('single-image-face')).toBeTruthy();
    expect(screen.queryByTestId('single-image-cv')).toBeNull();
  });

  it('a file field without pictures still shows its text', async () => {
    await open([{ name: '张三', photo: ['cv'] }], 'one-page', 'r0', async (repo) => {
      await repo.addAsset(asset('cv', 'cv.pdf', 'application/pdf'));
    });
    await screen.findByTestId('single-r0');
    expect(screen.queryByTestId('single-image-cv')).toBeNull();
    expect(screen.getByText('照片')).toBeTruthy();
  });
});
