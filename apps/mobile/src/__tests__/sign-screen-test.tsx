import { createDefaultWorkspace } from '@morph/core';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { makePalette } from '../renderer/theme';
import { SignScreen } from '../run/local/SignScreen';
import { FakeFiles } from '../test-utils/fake-files';
import { WorkspaceProvider } from '../workspace/context';

// 2026-11-09 PDF user retest: rapid double-tap on "Next" during signing resulted in the second tap
// hitting "Finish" to "Place signature" at the exact same position, skipping the placement step and
// placing the signature at the default position.

afterEach(() => jest.restoreAllMocks());

async function open() {
  const files = new FakeFiles();
  await files.saveSignature(new Uint8Array([1]), 3);
  const onDone = jest.fn();
  await render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 400, height: 800 },
        insets: { top: 0, bottom: 0, left: 0, right: 0 },
      }}>
      <WorkspaceProvider value={{ files } as never}>
        <SignScreen
          input={{
            item: { uri: 'a.pdf', name: 'a', ext: 'pdf', mimeType: 'application/pdf', size: 1 },
            pages: [{ uri: 'file:///p1.png', width: 1000, height: 1414 }],
          }}
          palette={makePalette(createDefaultWorkspace('en').theme, false)}
          locale="en"
          onDone={onDone}
          onCancel={jest.fn()}
        />
      </WorkspaceProvider>
    </SafeAreaProvider>,
  );
  return { onDone };
}

it('a second quick tap right after choosing the signature does not skip placing it', async () => {
  const now = jest.spyOn(Date, 'now').mockReturnValue(10_000);
  const { onDone } = await open();
  await fireEvent.press(await screen.findByTestId('signature-saved'));
  // "Place signature" just appeared, second tap at the same position (top right header): ignored.
  now.mockReturnValue(10_200);
  await fireEvent.press(screen.getByTestId('local-done'));
  expect(onDone).not.toHaveBeenCalled();
  expect(screen.getByText('Place signature')).toBeTruthy();
  // Tapping "Finish" again a moment later works normally.
  now.mockReturnValue(12_000);
  await act(async () => {
    await fireEvent.press(screen.getByTestId('local-done'));
  });
  expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ pageIndex: 0 }));
});
