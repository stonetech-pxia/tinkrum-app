import { SafeAreaProvider } from 'react-native-safe-area-context';
import { DEFAULT_THEME, PREFILL_MODEL_PACK, type Locale } from '@morph/core';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Alert, type AlertButton } from 'react-native';

import { LocalModelCard } from '../packs/LocalModelCard';
import type { Packs } from '../packs/PackHost';
import { makePalette } from '../renderer/theme';

// On-device model in "Settings -> Data" (D-396): downloaded only after user tap and confirmation; can be deleted; not downloaded on phones with insufficient memory.

let mockPacks: Packs | null = null;
jest.mock('../packs/PackHost', () => ({ usePacks: () => mockPacks }));
let mockFits = true;
jest.mock('../runtime/local-model', () => ({ deviceFitsLocalModel: () => mockFits }));

const palette = makePalette(DEFAULT_THEME, false);
const URL = 'https://example.test/packs';

function fakeStore(installed: boolean) {
  const store = {
    isInstalled: jest.fn(async () => installed),
    installed: jest.fn(async () => []),
    install: jest.fn(async () => undefined),
    remove: jest.fn(async () => undefined),
  };
  mockPacks = { store, bridge: {} } as unknown as Packs;
  return store;
}
const show = async (locale: Locale = 'zh') => {
  await render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 375, height: 667 },
        insets: { top: 0, bottom: 0, left: 0, right: 0 },
      }}>
      <LocalModelCard palette={palette} locale={locale} />
    </SafeAreaProvider>,
  );
};

describe('On-device model settings item (D-396)', () => {
  beforeEach(() => {
    mockFits = true;
    process.env.EXPO_PUBLIC_MORPH_PACKS_URL = URL;
  });
  afterEach(() => {
    delete process.env.EXPO_PUBLIC_MORPH_PACKS_URL;
  });

  it('Does not download upon opening the page; downloads only after tapping download and confirming in the confirmation dialog', async () => {
    const store = fakeStore(false);
    await show();
    expect(store.install).not.toHaveBeenCalled();
    expect(screen.queryByTestId('pack-gate')).toBeNull();
    await fireEvent.press(screen.getByTestId('local-model-download'));
    expect(screen.getByTestId('pack-gate')).toBeTruthy();
    expect(store.install).not.toHaveBeenCalled();
    await act(async () => {
      await fireEvent.press(screen.getByTestId('pack-download'));
    });
    expect(store.install).toHaveBeenCalledWith(PREFILL_MODEL_PACK, expect.any(Function));
    expect(screen.getByTestId('local-model-remove')).toBeTruthy();
  });

  it('Cancel in confirmation dialog: does not download, button remains', async () => {
    const store = fakeStore(false);
    await show();
    await fireEvent.press(screen.getByTestId('local-model-download'));
    await fireEvent.press(screen.getByTestId('pack-cancel'));
    expect(store.install).not.toHaveBeenCalled();
    expect(screen.getByTestId('local-model-download')).toBeTruthy();
  });

  it('Already downloaded: can be deleted, asks first', async () => {
    const store = fakeStore(true);
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    await show();
    await fireEvent.press(screen.getByTestId('local-model-remove'));
    expect(store.remove).not.toHaveBeenCalled();
    const buttons = alert.mock.calls[0]![2] as AlertButton[];
    await act(async () => buttons.find((b) => b.style === 'destructive')!.onPress!());
    expect(store.remove).toHaveBeenCalledWith(PREFILL_MODEL_PACK);
    expect(screen.getByTestId('local-model-download')).toBeTruthy();
    alert.mockRestore();
  });

  it('Insufficient memory and not installed: do not mention on-device model at all', async () => {
    fakeStore(false);
    mockFits = false;
    await show();
    expect(screen.queryByTestId('local-model')).toBeNull();
    expect(screen.queryByTestId('local-model-download')).toBeNull();
  });

  it('Insufficient memory but already installed (e.g., restored from backup): can only be deleted', async () => {
    fakeStore(true);
    mockFits = false;
    await show();
    expect(screen.getByTestId('local-model-remove')).toBeTruthy();
    expect(screen.queryByTestId('local-model-download')).toBeNull();
  });

  it('Download URL not configured and not installed: no prompt; installed ones can still be deleted', async () => {
    delete process.env.EXPO_PUBLIC_MORPH_PACKS_URL;
    fakeStore(false);
    await show();
    expect(screen.queryByTestId('local-model')).toBeNull();
    fakeStore(true);
    await show();
    expect(screen.getByTestId('local-model-remove')).toBeTruthy();
  });
});
