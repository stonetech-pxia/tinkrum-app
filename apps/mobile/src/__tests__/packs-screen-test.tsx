import { createDefaultWorkspace } from '@morph/core';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { Alert } from 'react-native';

import { PackStore } from '../packs/store';
import { makePalette } from '../renderer/theme';
import { PacksScreen } from '../shell/PacksScreen';
import { MemoryPackFs, bundlePack, manifests, sha256, text } from '../test-utils/memory-packs';

// "Settings -> Extension packs": lists downloaded extension packs and used space; deleting the OCR pack also deletes the language packs together.

describe('extension packs screen', () => {
  afterEach(() => jest.restoreAllMocks());

  it('lists downloaded packs with their size and deletes the text pack with its languages', async () => {
    const fs = new MemoryPackFs();
    const lookup = await manifests(fs);
    const store = new PackStore(fs, sha256, (id) => lookup.get(id));
    await store.install('ocr-eng');
    const palette = makePalette(createDefaultWorkspace('zh').theme, false);
    await render(<PacksScreen store={store} palette={palette} locale="zh" />);

    expect(await screen.findByTestId('pack-ocr')).toBeTruthy();
    expect(screen.getByTestId('pack-ocr-eng')).toBeTruthy();
    // 3 + 4 + 7 bytes.
    expect(screen.getByTestId('packs-total').props.children).toBe('共占用 14 B');

    const alert = jest.spyOn(Alert, 'alert').mockImplementationOnce((_t, message, buttons) => {
      expect(message).toContain('1 种语言');
      buttons?.find((b) => b.style === 'destructive')?.onPress?.();
    });
    await fireEvent.press(screen.getByTestId('pack-delete-ocr'));
    expect(alert).toHaveBeenCalled();
    expect(await screen.findByTestId('packs-empty')).toBeTruthy();
    expect(await store.isInstalled('ocr-eng')).toBe(false);
  });

  // D-510: packs bundled with the app are not downloaded, so they are not listed (if deleted, they will be copied back from the app when needed); the description also no longer says PDF preview needs to be downloaded.
  it('does not list the packs that come with the app as downloads', async () => {
    const fs = new MemoryPackFs();
    const lookup = await manifests(fs);
    bundlePack(fs, lookup.get('ocr')!, (path) => (path === 'a.js' ? text('aaa') : text('bbbb')));
    const store = new PackStore(fs, sha256, (id) => lookup.get(id));
    const palette = makePalette(createDefaultWorkspace('zh').theme, false);
    await render(<PacksScreen store={store} palette={palette} locale="en" />);
    expect(await screen.findByTestId('packs-empty')).toHaveTextContent('Nothing downloaded yet.');
    expect(screen.queryByTestId('pack-ocr')).toBeNull();
    expect(await store.isInstalled('ocr')).toBe(true);
    expect(screen.getByText(/PDF preview, page flattening and layout are built in/)).toBeTruthy();
  });
});
