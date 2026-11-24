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

// D-570 (founder 2026-11-16 decision 1): record form segmented by config, conditional display looks
// only at its own fields and changes as you type; tooltips below fields; numeric ranges. Values in
// hidden sections are not cleared (invariant 5), and save/delete remain handled by core.

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

async function start(values?: Record<string, unknown>) {
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
  await renderToolsApp(repo, undefined, { locale: 'en', seed });
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

describe('the entry form follows the table form (D-570)', () => {
  it('new entry: sections with titles; the invoice section shows only while ticked, live', async () => {
    const repo = await start();
    await openEntry();
    expect(screen.getByText('Order')).toBeTruthy();
    expect(screen.queryByText('Invoice')).toBeNull();
    expect(screen.queryByTestId('editor-tax-no')).toBeNull();
    // Fields not written into any section are listed at the end.
    expect(screen.getByTestId('editor-section-rest')).toBeTruthy();
    expect(screen.getByTestId('editor-note')).toBeTruthy();

    await fireEvent(screen.getByTestId('editor-invoice'), 'valueChange', true);
    expect(screen.getByText('Invoice')).toBeTruthy();
    expect(screen.getByTestId('editor-tax-no-hint')).toHaveTextContent('15 or 18 characters');

    // Required fields must be filled when displayed.
    await fireEvent.changeText(screen.getByTestId('editor-item'), 'Desk');
    await fireEvent.press(screen.getByTestId('editor-save'));
    expect(await screen.findByTestId('editor-tax-no-issue')).toHaveTextContent('Required');
    expect(await repo.listRecords('orders')).toEqual([]);

    // When hidden, required validation is not checked, and partially filled values inside it are not submitted.
    await fireEvent.changeText(screen.getByTestId('editor-tax-no'), 'half');
    await fireEvent(screen.getByTestId('editor-invoice'), 'valueChange', false);
    expect(screen.queryByTestId('editor-tax-no')).toBeNull();
    await fireEvent.press(screen.getByTestId('editor-save'));
    await waitFor(async () =>
      expect((await repo.listRecords('orders'))[0]?.values).toEqual({
        item: 'Desk',
        invoice: false,
      }),
    );
  });

  it('with data: hiding the section keeps the stored tax number, and it comes back', async () => {
    const stored = { item: 'Desk', qty: 2, invoice: true, 'tax-no': 'DE123456789012345' };
    const repo = await start(stored);
    await openEntry('r1');
    expect(screen.getByTestId('editor-tax-no').props.value).toBe('DE123456789012345');
    await fireEvent(screen.getByTestId('editor-invoice'), 'valueChange', false);
    await fireEvent.press(screen.getByTestId('editor-save'));
    await waitFor(async () =>
      expect((await repo.getRecord('r1'))?.values).toEqual({ ...stored, invoice: false }),
    );
    await openEntry('r1');
    await fireEvent(screen.getByTestId('editor-invoice'), 'valueChange', true);
    expect(screen.getByTestId('editor-tax-no').props.value).toBe('DE123456789012345');
  });

  it('a number outside the range is refused with the limit; an old value outside it still shows', async () => {
    const repo = await start({ item: 'Old', qty: 9 });
    await openEntry('r1');
    // Range added later: existing stored 9 is displayed as usual, and modifying other fields saves successfully.
    expect(screen.getByTestId('editor-qty').props.value).toBe('9');
    await fireEvent.changeText(screen.getByTestId('editor-item'), 'Old desk');
    await fireEvent.press(screen.getByTestId('editor-save'));
    await waitFor(async () => expect((await repo.getRecord('r1'))?.values.item).toBe('Old desk'));

    await openEntry('r1');
    await fireEvent.changeText(screen.getByTestId('editor-qty'), '0');
    await fireEvent.press(screen.getByTestId('editor-save'));
    expect(await screen.findByTestId('editor-qty-issue')).toHaveTextContent('Must be at least 1.');
    expect((await repo.getRecord('r1'))?.values.qty).toBe(9);
  });

  it('the quick-add form shows the hint and the range message too', async () => {
    const repo = await start();
    expect(await screen.findByTestId('form-quick-tax-no-hint')).toHaveTextContent(
      '15 or 18 characters',
    );
    await fireEvent.changeText(screen.getByTestId('form-quick-item'), 'Desk');
    await fireEvent.changeText(screen.getByTestId('form-quick-qty'), '6');
    await fireEvent.changeText(screen.getByTestId('form-quick-tax-no'), 'X');
    await fireEvent.press(screen.getByText('Add'));
    expect(await screen.findByTestId('form-quick-qty-issue')).toHaveTextContent(
      'Must be at most 5.',
    );
    expect(await repo.listRecords('orders')).toEqual([]);
  });

  it('+1 past the maximum changes nothing and says why, without opening the form', async () => {
    const repo = await start({ item: 'Desk', qty: 5 });
    await fireEvent.press(await screen.findByTestId('row-action-r1'));
    expect(await screen.findByTestId('toast')).toHaveTextContent(
      /Nothing was changed: “Quantity” can’t go above 5\./,
    );
    expect((await repo.getRecord('r1'))?.values.qty).toBe(5);
    expect(screen.queryByTestId('editor-save')).toBeNull();
  });
});
