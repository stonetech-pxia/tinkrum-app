import type { ReactNode } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { createDefaultWorkspace } from '@morph/core';
import { fireEvent, render as renderNative, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { BottomSheet, Dialog } from '../renderer/Overlays';
import { makePalette } from '../renderer/theme';
import { Pill } from '../renderer/ui';

const metrics = {
  frame: { x: 0, y: 0, width: 375, height: 667 },
  insets: { top: 44, bottom: 34, left: 0, right: 0 },
};
const render = (children: ReactNode) =>
  renderNative(<SafeAreaProvider initialMetrics={metrics}>{children}</SafeAreaProvider>);

const palette = makePalette(createDefaultWorkspace('fr').theme, false);

describe('shared overlays and pills', () => {
  it('closes from the backdrop without treating a content press as cancel', async () => {
    const close = jest.fn();
    const choose = jest.fn();
    await render(
      <BottomSheet palette={palette} locale="fr" onClose={close} testID="sheet">
        <Pill palette={palette} label="Choisir" onPress={choose} testID="choose" />
      </BottomSheet>,
    );
    await fireEvent.press(screen.getByTestId('choose'));
    expect(choose).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('sheet-backdrop'));
    expect(close).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('sheet')).toHaveStyle({ paddingBottom: 46 });
  });

  it('hides the content of a closed sheet', async () => {
    await render(
      <BottomSheet visible={false} palette={palette} locale="fr" onClose={jest.fn()}>
        <Text>Hidden</Text>
      </BottomSheet>,
    );
    expect(screen.queryByText('Hidden')).toBeNull();
  });

  it('keeps a progress dialog open when dismissal is unavailable', async () => {
    await render(
      <Dialog palette={palette} locale="fr" testID="progress">
        <Text>Saving</Text>
      </Dialog>,
    );
    expect(screen.getByTestId('progress-backdrop')).toBeDisabled();
    expect(screen.getByText('Saving')).toBeTruthy();
  });

  it('exposes radio selection and prevents disabled pills from firing', async () => {
    const pick = jest.fn();
    await render(
      <Pill
        palette={palette}
        label="Table"
        selected
        radio
        disabled
        onPress={pick}
        testID="radio"
      />,
    );
    expect(
      screen.getByRole('radio', { selected: true, checked: true, disabled: true }),
    ).toBeTruthy();
    await fireEvent.press(screen.getByTestId('radio'));
    expect(pick).not.toHaveBeenCalled();
  });

  // Regression found on real device: pill icon rendered as an icon name, not its icon; when going
  // through config icon components, the name was not found and treated as an emoji, rendering the
  // word "palette" verbatim.
  it('draws a pill icon as an icon, not as its name', async () => {
    await render(
      <Pill palette={palette} label="Choisir un style" icon="palette" onPress={jest.fn()} />,
    );
    expect(screen.getByText('Choisir un style')).toBeTruthy();
    expect(screen.queryByText('palette')).toBeNull();
  });
});
