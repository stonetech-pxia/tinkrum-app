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
import { Alert, Linking, type AlertButton } from 'react-native';

import { useGuide } from '../guide/store';
import { MemoryWorkspaceRepo } from '../storage/memory';
import { renderToolsApp } from '../test-utils/render-app';

// Text field formats (D-422) and record page top buttons (D-423): phone numbers, SMS, and emails
// open directly, URLs prompt first, vCard sharing runs on tap; keyboard adapts accordingly; saves
// without format validation.

const contacts: Collection = {
  id: 'contacts',
  name: '联系人',
  fields: [
    { id: 'name', name: '姓名', type: 'text' },
    { id: 'tel', name: '电话', type: 'text', format: 'phone' },
    { id: 'mail', name: '邮箱', type: 'text', format: 'email' },
    { id: 'site', name: '网站', type: 'text', format: 'url' },
  ],
  // D-428: available buttons are determined by configuration.
  recordRow: [
    { tool: 'record-call', field: 'tel' },
    { tool: 'record-message', field: 'tel' },
    { tool: 'record-email', field: 'mail' },
    { tool: 'record-website', field: 'site' },
    { tool: 'record-vcard' },
  ],
};

const seed = (locale: Locale, registry: Registry) => {
  const r = applyOps(
    createDefaultWorkspace(locale),
    [
      { op: 'addData', table: contacts },
      {
        op: 'addContainer',
        page: 'home',
        block: {
          id: 'contacts',
          look: 'list',
          source: { table: 'contacts', limit: 30 },
          show: { title: 'name' },
        },
      },
    ],
    { registry, locale },
  );
  if (!r.ok) throw new Error(r.error);
  return r.config;
};

async function openRecord(values?: Record<string, string>) {
  const repo = new MemoryWorkspaceRepo();
  // Guide has been viewed: home screen no longer skips away.
  await repo.setMeta('guide', 'done');
  await act(() => useGuide.getState().load(repo));
  if (values)
    await repo.insertRecord({
      id: 'r1',
      collectionId: 'contacts',
      values,
      createdAt: 1,
      updatedAt: 1,
    });
  const app = await renderToolsApp(repo, undefined, { locale: 'zh', seed });
  // renderRouter replaced with a fake timer: wait for the home screen to finish drawing before opening the record page.
  await act(async () => {
    jest.advanceTimersByTime(200);
    await Promise.resolve();
  });
  await act(() =>
    router.push({
      pathname: '/record/[collectionId]',
      params: { collectionId: 'contacts', ...(values ? { recordId: 'r1' } : {}) },
    }),
  );
  await screen.findByTestId('editor-save');
  // Existing records only have values after reading completes.
  if (values) await waitFor(() => expect(screen.getByTestId('editor-name')).toBeTruthy());
  await act(async () => {});
  return { repo, files: app.files };
}

function alerts() {
  const spy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  return {
    spy,
    press: (label: string) => {
      const buttons = (spy.mock.lastCall?.[2] ?? []) as AlertButton[];
      buttons.find((b) => b.text === label)!.onPress?.();
    },
  };
}

let open: jest.SpiedFunction<typeof Linking.openURL>;
beforeEach(() => {
  open = jest.spyOn(Linking, 'openURL').mockClear().mockResolvedValue(undefined);
});
afterEach(() => {
  jest.restoreAllMocks();
  useGuide.setState({ stage: null, repo: null });
});

const FULL = {
  name: 'Maria',
  tel: '+33 6 12 34 56 78',
  mail: 'maria@example.com',
  site: 'www.example.com',
};

describe('no data yet', () => {
  it('a new record form has the right keyboards and no action row', async () => {
    await openRecord();
    expect(screen.getByTestId('editor-tel').props).toMatchObject({
      keyboardType: 'phone-pad',
      autoCapitalize: 'none',
      autoCorrect: false,
    });
    expect(screen.getByTestId('editor-mail').props).toMatchObject({
      keyboardType: 'email-address',
      autoCapitalize: 'none',
      autoCorrect: false,
    });
    expect(screen.getByTestId('editor-site').props).toMatchObject({
      keyboardType: 'url',
      autoCapitalize: 'none',
      autoCorrect: false,
    });
    // Text fields without a format remain unchanged.
    const plain = screen.getByTestId('editor-name').props;
    expect(plain.keyboardType).toBe('default');
    expect(plain.autoCapitalize).toBeUndefined();
    expect(plain.autoCorrect).toBeUndefined();
    expect(screen.queryByTestId('record-actions')).toBeNull();
  });
});

const ALL_BUTTONS = [
  'record-call-tel',
  'record-message-tel',
  'record-email-mail',
  'record-website-site',
  'record-vcard',
];

const actionIds = () =>
  screen.queryAllByTestId(/^record-action-/).map((b) => String(b.props.testID).slice(14));

describe('with data', () => {
  // Real device (Samsung): when saving a form, the system asks "Do you want to save login info to Smart Password Manager?", but record fields are not login information.
  it('record fields tell the system not to offer saving them as a login', async () => {
    await openRecord();
    for (const id of ['editor-name', 'editor-tel', 'editor-mail', 'editor-site'])
      expect(screen.getByTestId(id).props).toMatchObject({
        autoComplete: 'off',
        importantForAutofill: 'no',
      });
  });

  it('shows the row at the top of the page, above the first field', async () => {
    await openRecord(FULL);
    expect(actionIds()).toEqual(ALL_BUTTONS);
    const ids: string[] = [];
    const walk = (node: unknown) => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === 'object' && 'props' in node) {
        const { props, children } = node as { props: { testID?: string }; children: unknown };
        if (props.testID) ids.push(props.testID);
        walk(children);
      }
    };
    walk(screen.toJSON());
    expect(ids.indexOf('record-actions')).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf('record-actions')).toBeLessThan(ids.indexOf('editor-name'));
    // The row from D-422 is no longer present.
    expect(screen.queryByTestId('editor-tel-link')).toBeNull();
  });

  it('call opens directly with the digits only', async () => {
    const { spy } = alerts();
    await openRecord(FULL);
    await fireEvent.press(screen.getByTestId('record-action-record-call-tel'));
    await waitFor(() => expect(open).toHaveBeenCalledWith('tel:+33612345678'));
    expect(spy).not.toHaveBeenCalled();
  });

  it('message opens directly', async () => {
    const { spy } = alerts();
    await openRecord(FULL);
    await fireEvent.press(screen.getByTestId('record-action-record-message-tel'));
    await waitFor(() => expect(open).toHaveBeenCalledWith('sms:+33612345678'));
    expect(spy).not.toHaveBeenCalled();
  });

  it('email opens directly', async () => {
    const { spy } = alerts();
    await openRecord(FULL);
    await fireEvent.press(screen.getByTestId('record-action-record-email-mail'));
    await waitFor(() => expect(open).toHaveBeenCalledWith('mailto:maria@example.com'));
    expect(spy).not.toHaveBeenCalled();
  });

  it('the website asks first and names the host; cancel opens nothing', async () => {
    const { spy, press } = alerts();
    await openRecord(FULL);
    await fireEvent.press(screen.getByTestId('record-action-record-website-site'));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(open).not.toHaveBeenCalled();
    expect(spy.mock.lastCall?.[0]).toBe('打开链接？');
    expect(spy.mock.lastCall?.[1]).toContain('www.example.com');
    press('取消');
    expect(open).not.toHaveBeenCalled();
  });

  it('the website opens after the user agrees', async () => {
    const { press } = alerts();
    await openRecord(FULL);
    await fireEvent.press(screen.getByTestId('record-action-record-website-site'));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalled());
    press('打开');
    expect(open).toHaveBeenCalledWith('https://www.example.com');
  });

  it('when the phone cannot open it, a short message says so', async () => {
    const { spy } = alerts();
    open.mockRejectedValue(new Error('no handler'));
    await openRecord(FULL);
    await fireEvent.press(screen.getByTestId('record-action-record-call-tel'));
    await waitFor(() => expect(spy).toHaveBeenCalledWith('这台设备打不开。'));
  });

  it('the row follows the boxes: editing to something that does not fit hides those buttons', async () => {
    await openRecord(FULL);
    await fireEvent.changeText(screen.getByTestId('editor-tel'), '分机');
    expect(actionIds()).toEqual(ALL_BUTTONS.slice(2));
    await fireEvent.changeText(screen.getByTestId('editor-tel'), '555 0100');
    expect(actionIds()).toEqual(ALL_BUTTONS);
  });

  it('share vCard builds the card only when tapped and hands it to the system', async () => {
    const { files } = await openRecord(FULL);
    expect(files.shared).toEqual([]);
    await fireEvent.press(screen.getByTestId('record-action-record-vcard'));
    await waitFor(() => expect(files.shared).toHaveLength(1));
    const text = new TextDecoder().decode(files.disk.get(files.shared[0]!)!);
    expect(text).toContain('BEGIN:VCARD');
    expect(text).toContain('FN:Maria');
    expect(text).toContain('TEL:+33 6 12 34 56 78');
    expect(open).not.toHaveBeenCalled();
  });
});

describe('edge cases', () => {
  it('values that do not fit their format have no buttons', async () => {
    await openRecord({
      tel: '分机 123',
      mail: 'a@b.com?bcc=c@d.com',
      site: 'javascript:alert(1)',
    });
    expect(screen.getByTestId('editor-tel').props.value).toBe('分机 123');
    expect(screen.queryByTestId('record-actions')).toBeNull();
  });

  it('a record with only a name can still be shared, because the table has a phone field', async () => {
    await openRecord({ name: 'Maria' });
    expect(actionIds()).toEqual(['record-vcard']);
  });

  it('a table with no recordRow has no row', async () => {
    const repo = new MemoryWorkspaceRepo();
    await repo.setMeta('guide', 'done');
    await act(() => useGuide.getState().load(repo));
    await repo.insertRecord({
      id: 'r1',
      collectionId: 'plain',
      values: { name: 'https://example.com' },
      createdAt: 1,
      updatedAt: 1,
    });
    await renderToolsApp(repo, undefined, {
      locale: 'zh',
      seed: (locale, registry) => {
        const r = applyOps(
          createDefaultWorkspace(locale),
          [
            {
              op: 'addData',
              table: {
                id: 'plain',
                name: '普通',
                fields: [{ id: 'name', name: '姓名', type: 'text' }],
              },
            },
          ],
          { registry, locale },
        );
        if (!r.ok) throw new Error(r.error);
        return r.config;
      },
    });
    await act(async () => {
      jest.advanceTimersByTime(200);
      await Promise.resolve();
    });
    await act(() =>
      router.push({
        pathname: '/record/[collectionId]',
        params: { collectionId: 'plain', recordId: 'r1' },
      }),
    );
    await waitFor(() => expect(screen.getByTestId('editor-name')).toBeTruthy());
    await act(async () => {});
    expect(screen.queryByTestId('record-actions')).toBeNull();
  });
});

describe('saving', () => {
  it('an existing record saves an edit that does not fit', async () => {
    const { repo } = await openRecord(FULL);
    await fireEvent.changeText(screen.getByTestId('editor-tel'), 'OCR 碎片 12');
    await fireEvent.press(screen.getByTestId('editor-save'));
    await waitFor(async () => expect((await repo.getRecord('r1'))?.values.tel).toBe('OCR 碎片 12'));
    await waitFor(() => expect(screen.queryByTestId('editor-save')).toBeNull());
  });

  it('a new record saves a value that does not fit its format', async () => {
    const { repo } = await openRecord();
    await fireEvent.changeText(screen.getByTestId('editor-tel'), '分机 123');
    await fireEvent.changeText(screen.getByTestId('editor-mail'), 'not an address');
    await fireEvent.changeText(screen.getByTestId('editor-site'), 'javascript:alert(1)');
    await fireEvent.press(screen.getByTestId('editor-save'));
    await waitFor(async () => {
      expect((await repo.listRecords('contacts'))[0]?.values).toEqual({
        tel: '分机 123',
        mail: 'not an address',
        site: 'javascript:alert(1)',
      });
    });
    expect(open).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId('editor-save')).toBeNull());
  });
});
