import {
  applyOps,
  createDefaultWorkspace,
  type Collection,
  type DataRecord,
  type Locale,
  type NewComponent,
  type Registry,
} from '@morph/core';
import { act, fireEvent, waitFor } from '@testing-library/react-native';
import { screen } from 'expo-router/testing-library';

import { MemoryWorkspaceRepo } from '../storage/memory';
import { renderToolsApp } from '../test-utils/render-app';

// 新的记录外观：表格（D-539）、图片墙（D-540）。看只读，什么都不写（底线 15）。

const people: Collection = {
  id: 'people',
  name: 'People',
  fields: [
    { id: 'name', name: 'Name', type: 'text' },
    { id: 'company', name: 'Company', type: 'text' },
    { id: 'age', name: 'Age', type: 'number' },
    { id: 'photo', name: 'Photo', type: 'file' },
  ],
};

const seedWith =
  (...components: NewComponent[]) =>
  (locale: Locale, registry: Registry) => {
    const result = applyOps(
      createDefaultWorkspace(locale),
      [
        { op: 'addData' as const, table: people },
        ...components.map((block) => ({ op: 'addContainer' as const, page: 'home', block })),
      ],
      { registry, locale },
    );
    if (!result.ok) throw new Error(result.error);
    return result.config;
  };

let seq = 0;
const put = async (repo: MemoryWorkspaceRepo, values: object) => {
  const record: DataRecord = {
    id: `r${++seq}`,
    collectionId: 'people',
    values: values as Record<string, unknown>,
    createdAt: Date.now() + seq,
    updatedAt: Date.now() + seq,
  };
  await repo.insertRecord(record);
  return record;
};

const table: NewComponent = {
  id: 'grid',
  look: 'table',
  source: { table: 'people', sort: { field: 'name', direction: 'asc' }, limit: 30 },
  show: { title: 'name', columns: ['company', 'age'] },
};

describe('table look (D-539)', () => {
  it('a header of field names and one row per entry; tapping a row opens it', async () => {
    const repo = new MemoryWorkspaceRepo();
    const ada = await put(repo, { name: 'Ada', company: 'Acme', age: 36 });
    await put(repo, { name: 'Bob', company: 'Globex' });
    const writes = jest.spyOn(repo, 'insertRecord');
    const updates = jest.spyOn(repo, 'updateRecord');
    const { router } = await renderToolsApp(repo, undefined, {
      seed: seedWith(table),
      locale: 'en',
    });
    expect(await screen.findByTestId('table-grid-head-company')).toHaveTextContent('Company');
    expect(screen.getByTestId('table-grid-head-name')).toHaveTextContent('Name');
    expect(screen.getByTestId(`table-grid-${ada.id}-company`)).toHaveTextContent('Acme');
    expect(screen.getByTestId(`table-grid-${ada.id}-age`)).toHaveTextContent('36');
    expect(screen.getByText('Globex')).toBeTruthy();
    expect(writes).not.toHaveBeenCalled();
    expect(updates).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId(`record-${ada.id}`));
    await waitFor(() => expect(router.getPathname()).toBe('/record/people'));
  });

  it('a new user sees the empty text, not an empty grid', async () => {
    const repo = new MemoryWorkspaceRepo();
    await renderToolsApp(repo, undefined, {
      seed: seedWith({
        ...table,
        show: { ...table.show, emptyText: 'Nobody yet' },
      } as NewComponent),
      locale: 'en',
    });
    expect(await screen.findByText('Nobody yet')).toBeTruthy();
    expect(screen.queryByTestId('table-grid-head-name')).toBeNull();
  });
});

describe('gallery look (D-540)', () => {
  const gallery: NewComponent = {
    id: 'pics',
    look: 'gallery',
    source: { table: 'people', sort: { field: 'name', direction: 'asc' }, limit: 30 },
    show: { title: 'name' },
  };

  it('the first image of each entry with its title; a placeholder without one', async () => {
    const repo = new MemoryWorkspaceRepo();
    const asset = (id: string, name: string, mimeType: string) => ({
      id,
      name,
      mimeType,
      size: 1000,
      path: `assets/${id}/${name}`,
      source: 'picked' as const,
      createdAt: 1,
    });
    await repo.addAsset(asset('doc', 'cv.pdf', 'application/pdf'));
    await repo.addAsset(asset('face', 'ada.jpg', 'image/jpeg'));
    const ada = await put(repo, { name: 'Ada', photo: ['doc', 'face'] });
    const bob = await put(repo, { name: 'Bob' });
    const writes = jest.spyOn(repo, 'updateRecord');
    const { router } = await renderToolsApp(repo, undefined, {
      seed: seedWith(gallery),
      locale: 'en',
    });
    await act(async () => {
      fireEvent(await screen.findByTestId('gallery-pics'), 'layout', {
        nativeEvent: { layout: { width: 320, height: 0 } },
      });
    });
    expect(await screen.findByTestId(`gallery-image-${ada.id}`)).toBeTruthy();
    expect(screen.queryByTestId(`gallery-placeholder-${ada.id}`)).toBeNull();
    expect(screen.getByTestId(`gallery-placeholder-${bob.id}`)).toHaveTextContent('Bob');
    expect(screen.getByTestId(`record-${ada.id}`)).toHaveTextContent('Ada');
    expect(writes).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId(`record-${bob.id}`));
    await waitFor(() => expect(router.getPathname()).toBe('/record/people'));
  });
});
