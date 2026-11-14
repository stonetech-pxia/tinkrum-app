import {
  applyOps,
  createDefaultWorkspace,
  type Collection,
  type DataRecord,
  type Locale,
  type NewComponent,
  type Registry,
} from '@morph/core';
import { fireEvent, waitFor } from '@testing-library/react-native';
import { screen } from 'expo-router/testing-library';

import { MemoryWorkspaceRepo } from '../storage/memory';
import { renderToolsApp } from '../test-utils/render-app';

// 新的记录外观：表格（D-539）。看只读，什么都不写（底线 15）。

const people: Collection = {
  id: 'people',
  name: 'People',
  fields: [
    { id: 'name', name: 'Name', type: 'text' },
    { id: 'company', name: 'Company', type: 'text' },
    { id: 'age', name: 'Age', type: 'number' },
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
