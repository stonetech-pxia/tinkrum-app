import { createDefaultWorkspace } from '@morph/core';
import { act, fireEvent, render as renderNative, screen } from '@testing-library/react-native';
import { Alert, Platform } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AlertHost } from '../renderer/AlertHost';
import { makePalette } from '../renderer/theme';

const metrics = {
  frame: { x: 0, y: 0, width: 375, height: 667 },
  insets: { top: 44, bottom: 34, left: 0, right: 0 },
};
const palette = makePalette(createDefaultWorkspace('en').theme, false);
const mount = () =>
  renderNative(
    <SafeAreaProvider initialMetrics={metrics}>
      <AlertHost palette={palette} locale="en" />
    </SafeAreaProvider>,
  );

describe('AlertHost: Alert.alert drawn by the app (Android)', () => {
  const platform = Platform.OS;
  beforeEach(() => {
    Platform.OS = 'android';
  });
  afterEach(() => {
    Platform.OS = platform;
  });

  it('shows the title, one text per message line and the buttons in the given order', async () => {
    await mount();
    const keep = jest.fn();
    const remove = jest.fn();
    await act(() => {
      Alert.alert('Switch?', 'First line\nSecond line', [
        { text: 'Cancel', style: 'cancel', onPress: keep },
        { text: 'Apply', style: 'destructive', onPress: remove },
      ]);
    });
    expect(screen.getByText('Switch?')).toBeTruthy();
    expect(screen.getByText('First line')).toBeTruthy();
    expect(screen.getByText('Second line')).toBeTruthy();
    expect(screen.getByTestId('alert-button-0')).toHaveTextContent('Cancel');
    await fireEvent.press(screen.getByTestId('alert-button-1'));
    expect(remove).toHaveBeenCalledTimes(1);
    expect(keep).not.toHaveBeenCalled();
    expect(screen.queryByText('Switch?')).toBeNull();
  });

  it('shows an OK button when no buttons are given', async () => {
    await mount();
    await act(() => Alert.alert('Saved'));
    await fireEvent.press(screen.getByTestId('alert-button-0'));
    expect(screen.queryByText('Saved')).toBeNull();
  });

  it('queues a second alert and shows it after the first is answered', async () => {
    await mount();
    await act(() => {
      Alert.alert('One');
      Alert.alert('Two');
    });
    expect(screen.getByText('One')).toBeTruthy();
    expect(screen.queryByText('Two')).toBeNull();
    await fireEvent.press(screen.getByTestId('alert-button-0'));
    expect(screen.getByText('Two')).toBeTruthy();
  });

  it('keeps an alert that the button handler raises', async () => {
    await mount();
    await act(() => {
      Alert.alert('First', undefined, [{ text: 'Next', onPress: () => Alert.alert('Chained') }]);
    });
    await fireEvent.press(screen.getByTestId('alert-button-0'));
    expect(screen.getByText('Chained')).toBeTruthy();
  });

  it('ignores the backdrop unless the alert is cancelable, like the system one', async () => {
    await mount();
    const dismissed = jest.fn();
    await act(() => Alert.alert('Sure?', undefined, [{ text: 'Yes' }], { onDismiss: dismissed }));
    expect(screen.getByTestId('alert-dialog-backdrop')).toBeDisabled();
    await fireEvent.press(screen.getByTestId('alert-button-0'));
    await act(() =>
      Alert.alert('Sure?', undefined, [{ text: 'Yes' }], {
        cancelable: true,
        onDismiss: dismissed,
      }),
    );
    await fireEvent.press(screen.getByTestId('alert-dialog-backdrop'));
    expect(dismissed).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Sure?')).toBeNull();
  });

  it('puts the system alert back when it unmounts', async () => {
    const system = Alert.alert;
    const view = await mount();
    expect(Alert.alert).not.toBe(system);
    await act(() => view.unmount());
    expect(Alert.alert).toBe(system);
  });
});

// iOS: an RN Modal cannot present over an open bottom sheet or modal route (seen in the simulator), so the system alert is left alone.
describe('AlertHost on iOS', () => {
  it('leaves the system alert alone', async () => {
    const system = Alert.alert;
    await mount();
    expect(Alert.alert).toBe(system);
  });
});
