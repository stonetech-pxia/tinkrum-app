import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appConfigFile, appLink, appLinkPayload } from '@morph/core';
import { act, fireEvent, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { screen } from 'expo-router/testing-library';
import { Alert } from 'react-native';

import { redirectSystemPath } from '../app/+native-intent';
import { renderToolsApp } from '../test-utils/render-app';
import { useAiReturn, AI_RETURN_TTL, aiReturnIsActive } from '../ai/return';

const wallet = readFileSync(
  join(__dirname, '../../../../packages/core/src/fixtures/portal-apps/tinkrum-app-wallet.json'),
  'utf8',
);

it('rewrites a web fragment before Router loses it, on cold and warm starts', () => {
  const url = appLink(wallet);
  const payload = appLinkPayload(url)!;
  for (const initial of [true, false]) {
    expect(redirectSystemPath({ path: url, initial })).toBe(`/open?a=${payload}`);
    expect(redirectSystemPath({ path: `morph://open?a=${payload}`, initial })).toBe(
      `/open?a=${payload}`,
    );
  }
  expect(redirectSystemPath({ path: '/page/wallet-home', initial: true })).toBe(
    '/page/wallet-home',
  );
});

it('opening a valid app link writes nothing and reads no clipboard; import still asks and previews', async () => {
  const { store, files, repo } = await renderToolsApp();
  const head = store.getState().head!.id;
  const read = jest.spyOn(files, 'readClipboardText');
  const alert = jest.spyOn(Alert, 'alert');
  await act(() =>
    router.push({ pathname: '/open', params: { a: appLinkPayload(appLink(wallet))! } }),
  );
  await screen.findByTestId('app-link-review');
  expect(store.getState().head!.id).toBe(head);
  expect(store.getState().proposal).toBeNull();
  expect(await repo.listPresets()).toEqual([]);
  expect(read).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByTestId('app-link-review'));
  expect(alert.mock.calls.at(-1)![2]).toHaveLength(3);
  await act(() => alert.mock.calls.at(-1)![2]![1]!.onPress!());
  await waitFor(() => expect(store.getState().proposal).not.toBeNull());
  expect(store.getState().head!.id).toBe(head);
});

it('opening a setup link saves nothing until a user asks to review it', async () => {
  const { store, repo } = await renderToolsApp();
  const text = appConfigFile(store.getState().config!, new Date());
  await act(() =>
    router.push({ pathname: '/open', params: { a: appLinkPayload(appLink(text))! } }),
  );
  await screen.findByTestId('app-link-review');
  expect(await repo.listPresets()).toEqual([]);
  await fireEvent.press(screen.getByTestId('app-link-review'));
  await waitFor(() => expect(store.getState().proposal).not.toBeNull());
  expect(await repo.listPresets()).toHaveLength(1);
});

it('a bad or truncated link offers no import and changes nothing', async () => {
  const { store, repo } = await renderToolsApp();
  const head = store.getState().head!.id;
  for (const a of ['invalid', appLinkPayload(appLink('not json'))!]) {
    await act(() => router.push({ pathname: '/open', params: { a } }));
    await screen.findByTestId('app-link-screen');
    expect(screen.queryByTestId('app-link-review')).toBeNull();
    expect(store.getState().head!.id).toBe(head);
    expect(await repo.listPresets()).toEqual([]);
  }
});

it('the return mark expires exactly at 24h, and an older import cannot dismiss a later handoff', () => {
  const first = useAiReturn.getState().start('app', 1000);
  expect(aiReturnIsActive(first, 1000 + AI_RETURN_TTL - 1)).toBe(true);
  expect(aiReturnIsActive(first, 1000 + AI_RETURN_TTL)).toBe(false);
  expect(aiReturnIsActive(first, 999)).toBe(false);
  const second = useAiReturn.getState().start('new', 2000);
  useAiReturn.getState().dismiss(first.id);
  expect(useAiReturn.getState().pending).toEqual(second);
  useAiReturn.getState().dismiss(second.id);
  expect(useAiReturn.getState().pending).toBeNull();
});

it('applying from a cold-start import route returns to home, even without a back stack', async () => {
  const { store } = await renderToolsApp();
  const alerts = jest.spyOn(Alert, 'alert');
  await act(() =>
    router.replace({ pathname: '/open', params: { a: appLinkPayload(appLink(wallet))! } }),
  );
  await fireEvent.press(await screen.findByTestId('app-link-review'));
  await act(() => alerts.mock.calls.at(-1)![2]![1]!.onPress!());
  await waitFor(() => expect(store.getState().proposal).not.toBeNull());
  await act(() => alerts.mock.calls.at(-1)![2]!.find((b) => b.text === '应用')!.onPress!());
  await screen.findByTestId('page-ai');
  expect(screen.queryByTestId('app-link-screen')).toBeNull();
});
