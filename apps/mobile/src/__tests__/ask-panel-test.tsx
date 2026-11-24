import type { ReactNode } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { createDefaultWorkspace } from '@morph/core';
import { fireEvent, render as renderNative, screen } from '@testing-library/react-native';

import { makePalette } from '../renderer/theme';
import { AskPanel } from '../run/AskPanel';
import { testRegistry } from '../test-utils/render-app';

const metrics = {
  frame: { x: 0, y: 0, width: 375, height: 667 },
  insets: { top: 44, bottom: 34, left: 0, right: 0 },
};
const render = (children: ReactNode) =>
  renderNative(<SafeAreaProvider initialMetrics={metrics}>{children}</SafeAreaProvider>);

const idPhoto = testRegistry.actions.get('image.idPhoto')!;

function ask(onAnswer = jest.fn()) {
  return render(
    <AskPanel
      request={{
        step: { id: 'id', action: 'image.idPhoto', params: {} },
        action: idPhoto,
        keys: ['spec', 'maxKB'],
        params: { spec: 'us-passport', maxKB: 240 },
        input: null,
      }}
      palette={makePalette(createDefaultWorkspace('zh').theme, false)}
      locale="zh"
      now={new Date(2026, 9, 26)}
      onAnswer={onAnswer}
    />,
  );
}

describe('run-time ask panel', () => {
  it('lists each ID photo size once, and picking one also sets its size limit', async () => {
    const onAnswer = jest.fn();
    await ask(onAnswer);
    // Specification appears only within the "Specification" group, avoiding duplicate identical button rows above.
    expect(screen.queryByTestId('ask-preset-cn-visa')).toBeNull();
    expect(screen.getAllByText('中国签证 33×48 毫米')).toHaveLength(1);
    await fireEvent.press(screen.getByTestId('ask-spec-cn-visa'));
    await fireEvent.press(screen.getByTestId('prompt-ok'));
    // Chinese visa has no size requirement: specification changes to 0 (unlimited), matching the original specification button tap.
    expect(onAnswer).toHaveBeenCalledWith({ spec: 'cn-visa', maxKB: 0 });
  });

  it('scrolls when the questions are taller than the screen, so OK stays reachable', async () => {
    await ask();
    expect(screen.getByTestId('ask-scroll')).toBeTruthy();
    // "Confirm" is outside the scroll area, staying on screen regardless of content length.
    expect(screen.getByTestId('ask-scroll')).not.toContainElement(screen.getByTestId('prompt-ok'));
  });
});
