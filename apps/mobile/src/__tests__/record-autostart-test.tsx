import { createDefaultWorkspace } from '@morph/core';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { makePalette } from '../renderer/theme';
import { RecordScreen } from '../run/local/RecordScreen';

// 录音步骤的 autoStart（D-587）：录音页一打开就开始录，按钮是「停止并继续」，点一下就交给下一步；
// 不写 autoStart 的录音还是点按钮开始、暂停、点「完成」。

const frame = {
  frame: { x: 0, y: 0, width: 400, height: 800 },
  insets: { top: 0, left: 0, right: 0, bottom: 0 },
};

async function open(autoStart: boolean) {
  const onDone = jest.fn();
  await act(async () => {
    render(
      <SafeAreaProvider initialMetrics={frame}>
        <RecordScreen
          input={{ name: '录音', ...(autoStart ? { autoStart: true } : {}) }}
          palette={makePalette(createDefaultWorkspace('zh').theme, false)}
          locale="zh"
          onDone={onDone}
          onCancel={jest.fn()}
        />
      </SafeAreaProvider>,
    );
  });
  return { onDone };
}

describe('录音步骤打开就开始录（D-587）', () => {
  it('starts recording on its own, and one tap on 停止并继续 hands the recording on', async () => {
    const { onDone } = await open(true);
    // 没有点任何东西，假的录音机就在走了。
    await waitFor(() => expect(screen.getByTestId('record-time')).not.toHaveTextContent('0:00'));
    expect(screen.queryByLabelText('开始录音')).toBeNull();
    expect(screen.queryByLabelText('暂停')).toBeNull();
    await fireEvent.press(screen.getByLabelText('停止并继续'));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(onDone.mock.calls[0][0]).toMatchObject({ name: '录音.m4a', mimeType: 'audio/mp4' });
  });

  it('without autoStart nothing is recorded until the button is pressed', async () => {
    await open(false);
    expect(await screen.findByLabelText('开始录音')).toBeTruthy();
    await new Promise((r) => setTimeout(r, 500));
    expect(screen.getByTestId('record-time')).toHaveTextContent('0:00');
  });

  it('without microphone permission it stays on the recorder and says how to allow it', async () => {
    (globalThis as { __audioPermission?: boolean }).__audioPermission = false;
    try {
      await open(true);
      expect(
        await screen.findByText('需要权限才能继续（麦克风），可以在系统「设置」里允许。'),
      ).toBeTruthy();
      expect(screen.getByLabelText('开始录音')).toBeTruthy();
    } finally {
      delete (globalThis as { __audioPermission?: boolean }).__audioPermission;
    }
  });
});
