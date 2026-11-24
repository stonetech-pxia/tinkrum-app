import {
  applyOps,
  BUILTIN_TOOLS,
  createRegistry,
  createStarterWorkspace,
  DEFAULT_THEME,
  type DrawnIcon,
} from '@morph/core';
import { render } from '@testing-library/react-native';

import { homeScreenEntries } from '../home-screen/useHomeScreen';
import { DrawnIconsProvider, drawnIconOf } from '../renderer/DrawnIcon';
import { Icon, iconSource, iosSymbolName } from '../renderer/Icon';
import { makePalette } from '../renderer/theme';
import { AppIconPicker } from '../shell/AppMenu';

// Drawn icon (D-625): my:<id> fetches path from icon library and draws using Skia; when missing or
// unreadable from library, shows placeholder only with size unchanged. Skia is absent in Jest: mock
// here recognizes only paths starting with M, used to test lookups and branches, not pixels.

jest.mock('@shopify/react-native-skia', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require('react-native');
  const builder = () => ({
    addPath() {
      return this;
    },
    setFillType() {
      return this;
    },
    build: () => ({}),
  });
  return {
    Canvas: View,
    Group: View,
    Path: () => null,
    Skia: {
      Path: { MakeFromSVGString: (d: string) => (d.startsWith('M') ? {} : null) },
      PathBuilder: { Make: builder },
    },
  };
});

const PAW: DrawnIcon = { paths: ['M4 4h16v16H4z', 'M8 8h8v8H8z'] };
const RING: DrawnIcon = { paths: ['M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16z'], stroke: true };

describe('drawn icons', () => {
  it('looks the definition up by my:<id> only', () => {
    expect(drawnIconOf('my:paw', { paw: PAW })).toBe(PAW);
    expect(drawnIconOf('my:cat', { paw: PAW })).toBeNull();
    expect(drawnIconOf('paw', { paw: PAW })).toBeNull();
  });

  it.each([
    ['filled', PAW],
    ['in lines', RING],
  ])('draws a known icon %s in a box of the given size', async (_, icon) => {
    const { getByTestId, queryByTestId } = await render(
      <DrawnIconsProvider icons={{ paw: icon }}>
        <Icon name="my:paw" size={30} color="#ff0000" />
      </DrawnIconsProvider>,
    );
    expect(getByTestId('icon-my:paw').props.style).toMatchObject({ width: 30, height: 30 });
    expect(queryByTestId('drawn-icon-canvas')).not.toBeNull();
  });

  it.each([
    ['no library', undefined],
    ['an icon missing from the library', { cat: PAW }],
    ['a path Skia cannot read', { paw: { paths: ['m4 4h16'] } }],
  ])('keeps the box but draws nothing with %s', async (_, icons) => {
    const { getByTestId, queryByTestId } = await render(
      <DrawnIconsProvider icons={icons}>
        <Icon name="my:paw" size={24} color="#000000" />
      </DrawnIconsProvider>,
    );
    expect(getByTestId('icon-my:paw').props.style).toMatchObject({ width: 24, height: 24 });
    expect(queryByTestId('drawn-icon-canvas')).toBeNull();
  });

  it('keeps the box without any provider (an empty library)', async () => {
    const { getByTestId } = await render(<Icon name="my:paw" size={24} color="#000000" />);
    expect(getByTestId('icon-my:paw').props.style).toMatchObject({ width: 24, height: 24 });
  });

  it('has no system symbol; the Android home-screen art carries the paths', () => {
    expect(iosSymbolName('my:paw')).toBeUndefined();
    expect(iconSource('my:paw')).toEqual({});
    const registry = createRegistry(BUILTIN_TOOLS);
    const ctx = { registry, locale: 'en' as const };
    const applied = applyOps(
      createStarterWorkspace('en', registry),
      [
        { op: 'setTheme', icons: { paw: PAW } },
        { op: 'addContainer', app: { id: 'pets', name: 'Pets', icon: 'my:paw' } },
        { op: 'updateContainer', nav: { phoneHomeScreen: ['app:pets'] } },
      ],
      ctx,
    );
    if (!applied.ok) throw new Error(applied.error);
    const [entry] = homeScreenEntries(applied.config);
    expect(entry).toMatchObject({ id: 'app:pets', art: { icon: 'my:paw', drawn: PAW } });
    expect(entry).not.toHaveProperty('symbol');
  });

  it('the app icon picker offers the drawn icons after the listed ones', async () => {
    const { getByTestId } = await render(
      <DrawnIconsProvider icons={{ paw: PAW }}>
        <AppIconPicker
          palette={makePalette(DEFAULT_THEME, false)}
          locale="en"
          current="my:paw"
          onPick={() => undefined}
        />
      </DrawnIconsProvider>,
    );
    expect(getByTestId('app-icon-my:paw').props.accessibilityState).toEqual({ selected: true });
  });
});
