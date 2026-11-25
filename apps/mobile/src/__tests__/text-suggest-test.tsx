import {
  applyOps,
  createDefaultWorkspace,
  type Collection,
  type Locale,
  type Registry,
} from '@morph/core';
import { act, fireEvent, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { screen } from 'expo-router/testing-library';

import { useGuide } from '../guide/store';
import { MemoryWorkspaceRepo } from '../storage/memory';
import { renderToolsApp } from '../test-utils/render-app';

// D-642: a text field with suggest: true lists, under its input, the
// values already saved in it. A tap fills the input; only Save writes.

const spending: Collection = {
  id: 'spending',
  name: 'Spending',
  fields: [
    { id: 'merchant', name: 'Merchant', type: 'text', suggest: true },
    { id: 'memo', name: 'Memo', type: 'text' },
  ],
};

const seed = (locale: Locale, registry: Registry) => {
  const r = applyOps(createDefaultWorkspace(locale), [{ op: 'addData', table: spending }], {
    registry,
    locale,
  });
  if (!r.ok) throw new Error(r.error);
  return r.config;
};

// Carrefour is in two entries, the others in one.
const SHOPS = ['Carrefour', 'Aldi', 'Carrefour', 'Boulangerie Paul', 'Carrefour City'];

async function openForm(recordId?: string, shops: readonly string[] = SHOPS) {
  const repo = new MemoryWorkspaceRepo();
  // Guide has been viewed: home screen no longer skips away.
  await repo.setMeta('guide', 'done');
  await act(() => useGuide.getState().load(repo));
  // Saved in list order: the last one is the latest.
  for (const [i, merchant] of shops.entries())
    await repo.insertRecord({
      id: `r${i + 1}`,
      collectionId: 'spending',
      values: { merchant, memo: `memo ${i + 1}` },
      createdAt: i + 1,
      updatedAt: i + 1,
    });
  await renderToolsApp(repo, undefined, { locale: 'en', seed });
  await act(async () => {
    jest.advanceTimersByTime(200);
    await Promise.resolve();
  });
  await act(() =>
    router.push({
      pathname: '/record/[collectionId]',
      params: { collectionId: 'spending', ...(recordId ? { recordId } : {}) },
    }),
  );
  await screen.findByTestId('editor-save');
  await act(async () => {});
  return repo;
}

/** The values offered under the merchant input, top to bottom. */
const offered = () =>
  screen
    .queryAllByTestId(/^editor-merchant-past-\d+$/)
    .map((chip) => chip.props.accessibilityLabel as string);
const labels = (...values: string[]) => values.map((v) => `Fill “Merchant” with ${v}`);
const input = () => screen.getByTestId('editor-merchant').props.value as string;
const saved = async (repo: MemoryWorkspaceRepo) =>
  (await repo.listRecords('spending')).map((r) => r.values.merchant);

describe('earlier values under a text field', () => {
  it('offers them on a new entry, most used first, only under the field that asks for it', async () => {
    await openForm();
    await waitFor(() =>
      expect(offered()).toEqual(labels('Carrefour', 'Carrefour City', 'Boulangerie Paul', 'Aldi')),
    );
    expect(screen.queryByTestId('editor-memo-past')).toBeNull();
  });

  it('narrows while typing, and a tap fills the input without saving anything', async () => {
    const repo = await openForm();
    await screen.findByTestId('editor-merchant-past');
    await fireEvent.changeText(screen.getByTestId('editor-merchant'), 'carre');
    expect(offered()).toEqual(labels('Carrefour', 'Carrefour City'));

    await fireEvent.press(screen.getByTestId('editor-merchant-past-0'));
    expect(input()).toBe('Carrefour');
    // The chips stay where they are, so the fields below don't jump.
    expect(offered()).toEqual(labels('Carrefour', 'Carrefour City'));
    expect(screen.getByTestId('editor-merchant-past-0').props.accessibilityState).toMatchObject({
      selected: true,
    });
    expect(await saved(repo)).toEqual(SHOPS);

    await fireEvent.press(screen.getByTestId('editor-save'));
    await waitFor(async () => expect(await saved(repo)).toEqual([...SHOPS, 'Carrefour']));
  });

  it('offers nothing when nothing matches', async () => {
    await openForm();
    await screen.findByTestId('editor-merchant-past');
    await fireEvent.changeText(screen.getByTestId('editor-merchant'), 'Lidl');
    expect(screen.queryByTestId('editor-merchant-past')).toBeNull();
  });

  it('shows nothing before the table has a value', async () => {
    await openForm(undefined, []);
    expect(screen.queryByTestId('editor-merchant-past')).toBeNull();
  });

  it('offers other values containing it when an entry is edited', async () => {
    await openForm('r1');
    await waitFor(() => expect(input()).toBe('Carrefour'));
    await waitFor(() => expect(offered()).toEqual(labels('Carrefour City')));
  });
});
