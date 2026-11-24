import { createDefaultWorkspace, type Workflow } from '@morph/core';
import { act, waitFor, within } from '@testing-library/react-native';
import { router } from 'expo-router';
import { screen } from 'expo-router/testing-library';

import { makePalette } from '../renderer/theme';
import { FakeFiles } from '../test-utils/fake-files';
import { renderToolsApp } from '../test-utils/render-app';

// The step currently executing on the run page (D-276): show a "processing" spinner, and indicate the index when processing multiple items.

const wf: Workflow = {
  kind: 'quickAction',
  id: 'resize',
  name: '缩小照片',
  steps: [
    { id: 'input', action: 'in.photos', params: { source: 'library', min: 1, max: 10 } },
    { id: 'resize', action: 'image.resize', params: { mode: 'longEdge', px: 1600 } },
  ],
};

it('shows a spinner and which image is being processed, from the first one on', async () => {
  const files = new FakeFiles();
  // Block every image until the test releases it.
  const gates: (() => void)[] = [];
  const transform = files.transformImage.bind(files);
  jest
    .spyOn(files, 'transformImage')
    .mockImplementation(
      (...args: Parameters<typeof files.transformImage>) =>
        new Promise((resolve) => gates.push(() => resolve(transform(...args)))),
    );
  await renderToolsApp(undefined, files, {
    seed: (locale) => ({ ...createDefaultWorkspace(locale), tools: [wf] }),
  });
  files.nextPhotos = [1, 2, 3].map((n) => files.offerImage(`p${n}.jpg`, 3000, 2000));
  await act(async () =>
    router.push({ pathname: '/run/[workflowId]', params: { workflowId: wf.id } }),
  );
  await waitFor(() => expect(gates).toHaveLength(1), { timeout: 3000 });
  // Before the first image finishes processing, it already shows that image 1 is being processed.
  expect(screen.getByTestId('run-step-resize')).toHaveTextContent(/第 1\/3 张/);
  expect(screen.getByTestId('run-busy-resize')).toBeTruthy();
  // Step dots have a solid primary color background, and text on top uses the same color-picking rule as other accent-colored backgrounds.
  const palette = makePalette(createDefaultWorkspace('zh').theme, false);
  expect(within(screen.getByTestId('run-step-resize')).getByText('2')).toHaveStyle({
    color: palette.onAccent(palette.primary),
  });
  await act(async () => gates.shift()!());
  await waitFor(() => expect(gates).toHaveLength(1));
  expect(screen.getByTestId('run-step-resize')).toHaveTextContent(/第 2\/3 张/);
  await act(async () => gates.shift()!());
  await waitFor(() => expect(gates).toHaveLength(1));
  await act(async () => gates.shift()!());
  await screen.findByTestId('run-result', {}, { timeout: 3000 });
  expect(screen.queryByTestId('run-busy-resize')).toBeNull();
});
