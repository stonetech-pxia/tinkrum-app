import { useState } from 'react';
import { createDefaultWorkspace, type Collection, type Locale } from '@morph/core';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { ParamForm } from '../run/ParamForm';
import { makePalette } from '../renderer/theme';
import { useWorkspace } from '../workspace/context';
import { testRegistry } from '../test-utils/render-app';
jest.mock('../workspace/context', () => ({ useWorkspace: jest.fn() }));
const source: Collection = {
  id: 'people',
  name: 'People',
  fields: [
    { id: 'name', name: 'Name', type: 'text' },
    { id: 'email', name: 'Email', type: 'text', format: 'email' },
  ],
};
const templates: Collection = {
  id: 'templates',
  name: 'Templates',
  fields: [
    { id: 'title', name: 'Title', type: 'text' },
    { id: 'body', name: 'Body', type: 'note' },
    { id: 'doc', name: 'Word', type: 'file' },
  ],
};
async function show(actionId: string, locale: Locale, initial: Record<string, unknown> = {}) {
  const action = testRegistry.actions.get(actionId)!;
  let current = initial;
  function Form() {
    const [values, set] = useState(initial);
    current = values;
    return (
      <ParamForm
        action={action}
        values={values}
        onChange={set}
        palette={makePalette(createDefaultWorkspace(locale).theme, false)}
        locale={locale}
      />
    );
  }
  await render(<Form />);
  return () => current;
}
beforeEach(() => {
  const c = createDefaultWorkspace('en');
  c.data.tables = [source, templates];
  (useWorkspace as jest.Mock).mockImplementation((selector) => selector({ config: c }));
});
it.each(['en', 'zh', 'fr'] as const)(
  'exports columns in tap order, including Created, in %s',
  async (locale) => {
    const values = await show('records.toExcel', locale, { collectionId: 'people' });
    await fireEvent.press(screen.getByTestId('param-fields-email'));
    await fireEvent.press(screen.getByTestId('param-fields-name'));
    await fireEvent.press(screen.getByTestId('param-fields-createdAt'));
    expect(values().fields).toEqual(['email', 'name', 'createdAt']);
    expect(screen.getByText('1. Email')).toBeTruthy();
    expect(screen.getByText('2. Name')).toBeTruthy();
    expect(screen.queryByTestId('param-totals')).toBeNull();
  },
);
it('uses the templates table for body and the source table for email-format recipient fields', async () => {
  const values = await show('records.fill', 'fr', {
    collectionId: 'people',
    templatesTable: 'templates',
    kind: 'email',
  });
  expect(screen.getByTestId('param-body-body')).toBeTruthy();
  expect(screen.queryByTestId('param-body-email')).toBeNull();
  expect(screen.getByTestId('param-recipient-email')).toBeTruthy();
  expect(screen.queryByTestId('param-recipient-name')).toBeNull();
  await fireEvent.press(screen.getByTestId('param-body-title'));
  await fireEvent.press(screen.getByTestId('param-body-body'));
  expect(values().body).toEqual(['body']);
});
it('new user: with no tables, asks to choose a table and does not invent columns', async () => {
  const c = createDefaultWorkspace('fr');
  c.data.tables = [];
  (useWorkspace as jest.Mock).mockImplementation((selector) => selector({ config: c }));
  await show('records.toExcel', 'fr');
  expect(screen.queryByTestId('param-fields-createdAt')).toBeNull();
  expect(screen.queryByTestId('param-fields-name')).toBeNull();
});
