import {
  applyOps,
  createDefaultWorkspace,
  type Collection,
  type Locale,
  type Op,
  type Registry,
} from '@morph/core';
import { act, fireEvent, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { screen } from 'expo-router/testing-library';

import { useGuide } from '../guide/store';
import { MemoryWorkspaceRepo } from '../storage/memory';
import { renderToolsApp } from '../test-utils/render-app';

// D-572 (simulator check QA_BATCH3 P2, P3): when save is rejected in a long form, next to the save
// button it states how many items need fixing and marks them above; modifying a field removes its
// error immediately (without waiting for the next save).

const orders: Collection = {
  id: 'orders',
  name: 'Orders',
  fields: [
    { id: 'item', name: 'Item', type: 'text', required: true },
    { id: 'qty', name: 'Quantity', type: 'number', min: 1, max: 5 },
    { id: 'invoice', name: 'Needs invoice', type: 'checkbox' },
    {
      id: 'tax-no',
      name: 'Tax number',
      type: 'text',
      required: true,
      hint: '15 or 18 characters',
    },
    { id: 'note', name: 'Note', type: 'note' },
  ],
  form: {
    sections: [
      { title: 'Order', fields: ['item', 'qty', 'invoice'] },
      {
        title: 'Invoice',
        fields: ['tax-no'],
        when: [{ field: 'invoice', op: 'is', value: true }],
      },
    ],
  },
};

const seed = (locale: Locale, registry: Registry) => {
  const r = applyOps(
    createDefaultWorkspace(locale),
    [
      { op: 'addData', table: orders },
      {
        op: 'addContainer',
        page: 'home',
        block: {
          id: 'order-list',
          look: 'list',
          source: { table: 'orders', limit: 30 },
          show: { title: 'item' },
          tools: [
            { as: 'button', label: '+1', do: 'increment', table: 'orders', field: 'qty', by: 1 },
          ],
        },
      } as Op,
      {
        op: 'addContainer',
        page: 'home',
        block: {
          id: 'quick',
          look: 'form',
          show: { mode: 'inline' },
          tools: [
            {
              as: 'submit',
              label: 'Add',
              do: 'create',
              table: 'orders',
              ask: ['item', 'qty', 'tax-no'],
            },
          ],
        },
      } as Op,
    ],
    { registry, locale },
  );
  if (!r.ok) throw new Error(r.error);
  return r.config;
};

async function start(values?: Record<string, unknown>, locale: Locale = 'en') {
  const repo = new MemoryWorkspaceRepo();
  await repo.setMeta('guide', 'done');
  await act(() => useGuide.getState().load(repo));
  if (values)
    await repo.insertRecord({
      id: 'r1',
      collectionId: 'orders',
      values,
      createdAt: 1,
      updatedAt: 1,
    });
  await renderToolsApp(repo, undefined, { locale, seed });
  await act(async () => {
    jest.advanceTimersByTime(200);
    await Promise.resolve();
  });
  return repo;
}

async function openEntry(recordId?: string) {
  await act(() =>
    router.push({
      pathname: '/record/[collectionId]',
      params: { collectionId: 'orders', ...(recordId ? { recordId } : {}) },
    }),
  );
  await screen.findByTestId('editor-save');
  await act(async () => {});
}

describe('a refused save says where the problem is (D-572)', () => {
  it('next to Save: how many fields need attention; editing a field clears its own error', async () => {
    const repo = await start();
    await openEntry();
    expect(screen.queryByTestId('editor-issues')).toBeNull();
    await fireEvent.changeText(screen.getByTestId('editor-qty'), '0');
    await fireEvent.press(screen.getByTestId('editor-save'));
    expect(await screen.findByTestId('editor-issues')).toHaveTextContent(
      '2 fields need attention; they are marked above.',
    );
    expect(screen.getByTestId('editor-item-issue')).toBeTruthy();
    expect(screen.getByTestId('editor-qty-issue')).toHaveTextContent('Must be at least 1.');

    // Modified quantity: its error is removed immediately, the sentence changes to singular; item name error remains.
    await fireEvent.changeText(screen.getByTestId('editor-qty'), '3');
    expect(screen.queryByTestId('editor-qty-issue')).toBeNull();
    expect(screen.getByTestId('editor-item-issue')).toBeTruthy();
    expect(screen.getByTestId('editor-issues')).toHaveTextContent(
      '1 field needs attention; it is marked above.',
    );

    await fireEvent.changeText(screen.getByTestId('editor-item'), 'Desk');
    expect(screen.queryByTestId('editor-issues')).toBeNull();
    await fireEvent.press(screen.getByTestId('editor-save'));
    await waitFor(async () =>
      expect((await repo.listRecords('orders'))[0]?.values).toMatchObject({ item: 'Desk', qty: 3 }),
    );
  });

  it('with data: a wrong edit is refused, nothing is written, and the sentence names one field', async () => {
    const repo = await start({ item: 'Desk', qty: 2 });
    await openEntry('r1');
    await fireEvent.changeText(screen.getByTestId('editor-qty'), '6');
    await fireEvent.press(screen.getByTestId('editor-save'));
    expect(await screen.findByTestId('editor-issues')).toHaveTextContent(
      '1 field needs attention; it is marked above.',
    );
    expect((await repo.getRecord('r1'))?.values.qty).toBe(2);
  });

  it.each([
    ['fr' as const, '2 champs sont à revoir\u202f; ils sont signalés plus haut.'],
    ['zh' as const, '有 2 项要改，已在上面标出。'],
  ])('%s: the sentence is in the language of the app', async (locale, text) => {
    await start(undefined, locale);
    await openEntry();
    await fireEvent.changeText(screen.getByTestId('editor-qty'), '9');
    await fireEvent.press(screen.getByTestId('editor-save'));
    expect(await screen.findByTestId('editor-issues')).toHaveTextContent(text);
  });
});
