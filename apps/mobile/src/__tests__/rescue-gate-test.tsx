import { fireEvent, render, screen } from '@testing-library/react-native';
import { AppState, Text } from 'react-native';

import { MemoryAttemptStore } from '../test-utils/memory-attempts';
import { RescueGate } from '../rescue/RescueGate';
import { markHealthy, readAttempts, recordFatal } from '../rescue/attempts';

// 体检 6.6：App 连续两次没能正常打开（闪退、启动抛错），第三次打开直接进兜底页，不再加载主流程。

const actions = {
  exportBackup: jest.fn(async () => undefined),
  stepBack: jest.fn(async () => 0),
  shareError: jest.fn(async () => undefined),
  openSite: jest.fn(async () => undefined),
};

let rendered = 0;
function Crashing(): never {
  rendered++;
  throw new Error('boom at start');
}
function Fine() {
  rendered++;
  return <Text>home</Text>;
}

/** 一次启动 = 一个新的 JS 进程（新的 session）。 */
async function start(store: MemoryAttemptStore, App: () => React.JSX.Element | never) {
  return render(<RescueGate App={App} store={store} session={{}} locale="zh" actions={actions} />);
}
/** 一启动就抛错：进程没了（测试里就是渲染失败，没有走到「正常」）。 */
async function crash(store: MemoryAttemptStore) {
  await start(store, Crashing).catch(() => undefined);
}

const appState = AppState as { currentState: string };
const setAppState = (state: string) => {
  appState.currentState = state;
};
const initialAppState = appState.currentState;

beforeEach(() => {
  rendered = 0;
  setAppState('active');
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  setAppState(initialAppState);
  jest.restoreAllMocks();
});

it('opens the rescue page on the third start after two starts that crashed', async () => {
  const store = new MemoryAttemptStore();
  await crash(store);
  await crash(store);
  expect(readAttempts(store).failures).toBe(2);
  rendered = 0;
  await start(store, Crashing);
  expect(screen.getByTestId('rescue')).toBeTruthy();
  // 兜底页没有去加载主流程。
  expect(rendered).toBe(0);
});

it('a start that reaches the home page counts again from zero', async () => {
  const store = new MemoryAttemptStore();
  await crash(store);
  await start(store, Fine);
  expect(screen.getByText('home')).toBeTruthy();
  markHealthy(store);
  await crash(store);
  await start(store, Fine);
  expect(screen.queryByTestId('rescue')).toBeNull();
});

it('“open as usual” from the rescue page loads the app', async () => {
  const store = new MemoryAttemptStore({ failures: 2 });
  await start(store, Fine);
  expect(rendered).toBe(0);
  await fireEvent.press(screen.getByTestId('rescue-continue'));
  expect(screen.getByText('home')).toBeTruthy();
});

it('a start in the background (a reminder button) is not counted', async () => {
  setAppState('background');
  const store = new MemoryAttemptStore({ failures: 1 });
  await start(store, Fine);
  expect(readAttempts(store).failures).toBe(1);
});

it('shows the last error that ended a start', async () => {
  const store = new MemoryAttemptStore({ failures: 2 });
  recordFatal(store, new Error('cannot read property x'));
  await start(store, Fine);
  expect(screen.getByTestId('rescue-error')).toHaveTextContent(/cannot read property x/);
});

it('never blocks a start when the counter cannot be read or written', async () => {
  const store = new MemoryAttemptStore();
  store.text = '{"fail';
  store.broken = true;
  await start(store, Fine);
  expect(screen.getByText('home')).toBeTruthy();
});

it('a crash while rendering the app shows the rescue page at once and keeps the error', async () => {
  const store = new MemoryAttemptStore();
  await start(store, Crashing);
  expect(screen.getByTestId('rescue')).toBeTruthy();
  expect(screen.getByTestId('rescue-error')).toHaveTextContent(/boom at start/);
  expect(readAttempts(store)).toEqual({
    failures: 1,
    lastError: expect.stringMatching(/boom at start/),
  });
  // 这次没走到正常：下次打开还算着。
  await fireEvent.press(screen.getByTestId('rescue-continue'));
  expect(screen.getByTestId('rescue')).toBeTruthy();
});
