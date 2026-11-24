import { createDefaultWorkspace, initialParams, type Workflow } from '@morph/core';
import { act, fireEvent } from '@testing-library/react-native';
import { router } from 'expo-router';
import { screen } from 'expo-router/testing-library';

import { FakeFiles } from '../test-utils/fake-files';
import { renderToolsApp, testRegistry } from '../test-utils/render-app';

// Tap a thumbnail on the result page to open full-screen preview (D-277): view images full-screen and swipe left/right within the app; use system preview for PDFs, etc.

const photos: Workflow = {
  kind: 'quickAction',
  id: 'resize',
  name: '缩小照片',
  steps: [
    { id: 'input', action: 'in.photos', params: { source: 'library', min: 1, max: 10 } },
    { id: 'resize', action: 'image.resize', params: { mode: 'longEdge', px: 1600 } },
  ],
};
const pdf: Workflow = {
  kind: 'quickAction',
  id: 'pdf',
  name: '照片做成 PDF',
  steps: [
    photos.steps[0]!,
    {
      id: 'pdf',
      action: 'pdf.fromImages',
      params: initialParams(testRegistry.actions.get('pdf.fromImages')!),
    },
  ],
};

async function run(wf: Workflow, files: FakeFiles) {
  await renderToolsApp(undefined, files, {
    seed: (locale) => ({ ...createDefaultWorkspace(locale), tools: [photos, pdf] }),
  });
  files.nextPhotos = [1, 2].map((n) => files.offerImage(`scan-${n}.jpg`, 3000, 2000));
  await act(async () =>
    router.push({ pathname: '/run/[workflowId]', params: { workflowId: wf.id } }),
  );
  await screen.findByTestId('run-result', {}, { timeout: 3000 });
}

it('opens the result images full screen from their thumbnails, swiping through all of them', async () => {
  const files = new FakeFiles();
  await run(photos, files);
  await fireEvent.press(screen.getByTestId('result-open-scan-2.jpg'));
  expect(await screen.findByTestId('share-viewer')).toBeTruthy();
  // Starting from the tapped image, 2 total.
  expect(screen.getByTestId('share-viewer-count')).toHaveTextContent('2 / 2');
  await fireEvent.press(screen.getByTestId('share-viewer-close'));
  expect(screen.queryByTestId('share-viewer')).toBeNull();
});

it('opens a result PDF in the system preview', async () => {
  const files = new FakeFiles();
  await run(pdf, files);
  const row = screen.getAllByTestId(/^result-open-/)[0]!;
  await fireEvent.press(row);
  expect(files.previewed).toHaveLength(1);
  expect(files.previewed[0]!.mimeType).toBe('application/pdf');
});
