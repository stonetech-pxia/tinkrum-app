import { createDefaultWorkspace } from '@morph/core';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AnnotateScreen } from '../run/local/AnnotateScreen';
import { makePalette } from '../renderer/theme';

jest.mock('../runtime/skia', () => ({
  textLayout: () => ({ paragraph: {}, pad: 4, width: 100, height: 30 }),
}));

it('places local text in the selected color, undoes it and walks through photos', async () => {
  const onDone = jest.fn();
  const onCancel = jest.fn();
  await render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 400, height: 800 },
        insets: { top: 0, bottom: 0, left: 0, right: 0 },
      }}>
      <AnnotateScreen
        input={{
          items: ['one', 'two'].map((name) => ({
            uri: `file:///${name}.png`,
            name,
            ext: 'png',
            mimeType: 'image/png',
            size: 1,
            width: 1000,
            height: 500,
          })),
        }}
        palette={makePalette(createDefaultWorkspace('zh').theme, false)}
        locale="zh"
        onDone={onDone}
        onCancel={onCancel}
      />
    </SafeAreaProvider>,
  );
  await fireEvent(screen.getByTestId('annotate-area'), 'layout', {
    nativeEvent: { layout: { width: 200, height: 100 } },
  });
  await fireEvent.press(screen.getByTestId('annotate-tool-text'));
  await fireEvent.changeText(screen.getByTestId('annotate-text'), '只留在本机');
  await fireEvent.press(screen.getByTestId('annotate-color-2'));
  const event = {
    nativeEvent: { locationX: 20, locationY: 20 },
    touchHistory: {
      numberActiveTouches: 0,
      indexOfSingleActiveTouch: -1,
      touchBank: [],
      mostRecentTimeStamp: 1,
    },
  };
  await fireEvent(screen.getByTestId('annotate-drawing'), 'responderGrant', event);
  expect(screen.getByTestId('annotate-label-0')).toHaveProp('accessibilityLabel', '只留在本机');
  await fireEvent.press(screen.getByTestId('annotate-undo'));
  expect(screen.queryByTestId('annotate-label-0')).toBeNull();
  await fireEvent(screen.getByTestId('annotate-drawing'), 'responderGrant', event);
  await fireEvent.press(screen.getByTestId('local-done'));
  expect(onDone).not.toHaveBeenCalled();
  expect(screen.getByTestId('annotate-count')).toHaveTextContent('0/100 处');
  await fireEvent.press(screen.getByTestId('local-done'));
  expect(onDone).toHaveBeenCalledWith([
    [
      expect.objectContaining({
        kind: 'text',
        text: '只留在本机',
        color: '#2563EB',
        // The character starts from the point, and its bottom edge lands on the point (2026-11-09): the point is at page (100, 100), and the text box size is 100x30.
        point: { x: 100, y: 70 },
      }),
    ],
    [],
  ]);
  await fireEvent.press(screen.getByTestId('local-cancel'));
  expect(onCancel).toHaveBeenCalledTimes(1);
});

it('highlighter draws a wide, half-transparent stroke even for a single tap', async () => {
  const onDone = jest.fn();
  await render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 400, height: 800 },
        insets: { top: 0, bottom: 0, left: 0, right: 0 },
      }}>
      <AnnotateScreen
        input={{
          items: [
            {
              uri: 'file:///p.png',
              name: 'p',
              ext: 'png',
              mimeType: 'image/png',
              size: 1,
              width: 1000,
              height: 500,
            },
          ],
        }}
        palette={makePalette(createDefaultWorkspace('zh').theme, false)}
        locale="zh"
        onDone={onDone}
        onCancel={() => {}}
      />
    </SafeAreaProvider>,
  );
  await fireEvent(screen.getByTestId('annotate-area'), 'layout', {
    nativeEvent: { layout: { width: 200, height: 100 } },
  });
  await fireEvent.press(screen.getByTestId('annotate-tool-highlight'));
  await fireEvent.press(screen.getByTestId('annotate-color-6'));
  const touch = (x: number, y: number) => ({
    nativeEvent: { locationX: x, locationY: y },
    touchHistory: {
      numberActiveTouches: 0,
      indexOfSingleActiveTouch: -1,
      touchBank: [],
      mostRecentTimeStamp: 1,
    },
  });
  await fireEvent(screen.getByTestId('annotate-drawing'), 'responderGrant', touch(20, 20));
  await fireEvent(screen.getByTestId('annotate-drawing'), 'responderRelease', touch(20, 20));
  await fireEvent.press(screen.getByTestId('local-done'));
  const [[marks]] = onDone.mock.calls[0]!;
  expect(marks).toEqual([
    expect.objectContaining({ kind: 'highlight', color: '#FACC1566', width: 14 }),
  ]);
});

it('a placed text gets a style panel: size and rotation sliders, edit the words, delete', async () => {
  const onDone = jest.fn();
  await render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 400, height: 800 },
        insets: { top: 0, bottom: 0, left: 0, right: 0 },
      }}>
      <AnnotateScreen
        input={{
          tool: 'text',
          items: [
            {
              uri: 'file:///p.png',
              name: 'p',
              ext: 'png',
              mimeType: 'image/png',
              size: 1,
              width: 1000,
              height: 500,
            },
          ],
        }}
        palette={makePalette(createDefaultWorkspace('zh').theme, false)}
        locale="zh"
        onDone={onDone}
        onCancel={() => {}}
      />
    </SafeAreaProvider>,
  );
  await fireEvent(screen.getByTestId('annotate-area'), 'layout', {
    nativeEvent: { layout: { width: 200, height: 100 } },
  });
  // Initial tool comes from parameter: directly "text", allowing placement of default text with a tap without entering text first.
  expect(screen.getByTestId('annotate-tool-text')).toBeSelected();
  // The style area constantly occupies its position (uneditable when unselected); placing text does not shrink or reposition the page.
  expect(screen.getByTestId('annotate-style')).toHaveProp('pointerEvents', 'none');
  const touch = (x: number, y: number) => ({
    nativeEvent: { locationX: x, locationY: y },
    touchHistory: {
      numberActiveTouches: 0,
      indexOfSingleActiveTouch: -1,
      touchBank: [],
      mostRecentTimeStamp: 1,
    },
  });
  await fireEvent(screen.getByTestId('annotate-drawing'), 'responderGrant', touch(100, 50));
  expect(screen.getByTestId('annotate-label-0')).toHaveProp('accessibilityLabel', '文字');
  expect(screen.getByTestId('annotate-style')).toHaveProp('pointerEvents', 'auto');
  // Only a single input box at the top: selection modifies the currently selected text segment.
  expect(screen.getByTestId('annotate-text')).toHaveProp('defaultValue', '文字');
  await fireEvent.changeText(screen.getByTestId('annotate-text'), '你好，签证');
  expect(screen.getByTestId('annotate-label-0')).toHaveProp('accessibilityLabel', '你好，签证');
  // Slider: dragging to the far right = maximum rotation.
  await fireEvent(screen.getByTestId('annotate-rotation'), 'layout', {
    nativeEvent: { layout: { width: 200, height: 28 } },
  });
  await fireEvent(screen.getByTestId('annotate-rotation'), 'responderGrant', touch(100, 10));
  await fireEvent(screen.getByTestId('annotate-rotation'), 'responderRelease', touch(100, 10));
  await fireEvent.press(screen.getByTestId('local-done'));
  expect(onDone.mock.calls[0]![0][0][0]).toMatchObject({
    kind: 'text',
    text: '你好，签证',
    rotation: 180,
  });
  expect(screen.queryByTestId('annotate-delete')).toBeTruthy();
});

const pageItem = {
  uri: 'file:///page.png',
  name: 'page',
  ext: 'png',
  mimeType: 'image/png',
  size: 1,
  width: 1000,
  height: 500,
};
const tap = (x: number, y: number) => ({
  nativeEvent: { locationX: x, locationY: y },
  touchHistory: {
    numberActiveTouches: 0,
    indexOfSingleActiveTouch: -1,
    touchBank: [],
    mostRecentTimeStamp: 1,
  },
});
async function openDocument(
  lines: (index: number) => Promise<{ x: number; y: number; width: number; height: number }[]>,
) {
  const onDone = jest.fn();
  await render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 400, height: 800 },
        insets: { top: 0, bottom: 0, left: 0, right: 0 },
      }}>
      <AnnotateScreen
        input={{ tool: 'text', items: [pageItem], document: true, lines }}
        palette={makePalette(createDefaultWorkspace('en').theme, false)}
        locale="en"
        onDone={onDone}
        onCancel={() => {}}
      />
    </SafeAreaProvider>,
  );
  await fireEvent(screen.getByTestId('annotate-area'), 'layout', {
    nativeEvent: { layout: { width: 200, height: 100 } },
  });
  await act(async () => {});
  return onDone;
}

// 2026-11-09 user test: when the keyboard pops up, the page shrinks, the whole screen relayouts, and typed text is lost ("9 Nov 2026" becomes "9 Nov").
it('the text box is not overwritten by the screen while typing', async () => {
  await openDocument(async () => []);
  expect(screen.getByTestId('annotate-text').props.value).toBeUndefined();
  await fireEvent.changeText(screen.getByTestId('annotate-text'), '9 Nov 2026');
  expect(screen.getByTestId('annotate-text').props.value).toBeUndefined();
});

// 2026-11-09 user test: default font size is calculated based on page size, about 27 pt on A4, whereas contract body text is only 11 pt.
it('on a document page a new text takes the size of the nearest recognized line', async () => {
  const lines = jest.fn(async () => [{ x: 0, y: 90, width: 1000, height: 40 }]);
  const onDone = await openDocument(lines);
  expect(lines).toHaveBeenCalledWith(0);
  await fireEvent.changeText(screen.getByTestId('annotate-text'), '9 Nov 2026');
  await fireEvent(screen.getByTestId('annotate-drawing'), 'responderGrant', tap(20, 20));
  await fireEvent.press(screen.getByTestId('local-done'));
  expect(onDone.mock.calls[0]![0][0][0]).toMatchObject({ text: '9 Nov 2026', fontSize: 30 });
});

it('a document page without recognized lines uses about the size of body text', async () => {
  const onDone = await openDocument(async () => []);
  await fireEvent.changeText(screen.getByTestId('annotate-text'), 'x');
  await fireEvent(screen.getByTestId('annotate-drawing'), 'responderGrant', tap(20, 20));
  await fireEvent.press(screen.getByTestId('local-done'));
  expect(onDone.mock.calls[0]![0][0][0].fontSize).toBeCloseTo(9.5, 1);
});
