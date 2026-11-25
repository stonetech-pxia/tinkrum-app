import { createDefaultWorkspace } from '@morph/core';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { makePalette } from '../renderer/theme';
import { RecordScreen } from '../run/local/RecordScreen';

// The "Stop" button on Android's "Recording audio" notification ends the recording natively, without
// a tap on the recording screen. The user must still be able to keep what was recorded: either the
// screen hands it on by itself, or "Done" does.

const frame = {
  frame: { x: 0, y: 0, width: 400, height: 800 },
  insets: { top: 0, left: 0, right: 0, bottom: 0 },
};

type MockRecorder = { stop: () => Promise<void> };

async function open(autoStart: boolean) {
  const onDone = jest.fn();
  const onCancel = jest.fn();
  await act(async () => {
    render(
      <SafeAreaProvider initialMetrics={frame}>
        <RecordScreen
          input={{ name: 'Recording', ...(autoStart ? { autoStart: true } : {}) }}
          palette={makePalette(createDefaultWorkspace('en').theme, false)}
          locale="en"
          onDone={onDone}
          onCancel={onCancel}
        />
      </SafeAreaProvider>,
    );
  });
  if (!autoStart) await fireEvent.press(screen.getByTestId('record-toggle'));
  await waitFor(() => expect(screen.getByTestId('record-time')).not.toHaveTextContent('0:00'));
  return { onDone, onCancel };
}

async function stopFromNotification() {
  await act(async () => {
    await (globalThis as unknown as { __audioRecorder: MockRecorder }).__audioRecorder.stop();
    // One poll of the recorder state.
    await new Promise((r) => setTimeout(r, 300));
  });
}

async function expectRecordingKept({ onDone, onCancel }: Awaited<ReturnType<typeof open>>) {
  if (onDone.mock.calls.length === 0) await fireEvent.press(screen.getByTestId('local-done'));
  await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  expect(onDone.mock.calls[0][0]).toMatchObject({
    uri: 'file:///cache/ExpoAudio/recording.m4a',
    name: 'Recording.m4a',
  });
  expect(onDone.mock.calls[0][0].durationMs).toBeGreaterThan(0);
  expect(onCancel).not.toHaveBeenCalled();
}

describe('Stop on the recording notification keeps the recording', () => {
  it('while recording', async () => {
    const run = await open(false);
    await stopFromNotification();
    await expectRecordingKept(run);
  });

  it('while paused', async () => {
    const run = await open(false);
    await fireEvent.press(screen.getByTestId('record-toggle'));
    await stopFromNotification();
    await expectRecordingKept(run);
  });

  it('in a recording that started at once (D-587)', async () => {
    const run = await open(true);
    await stopFromNotification();
    await expectRecordingKept(run);
  });
});
