import { fireEvent } from '@testing-library/react-native';
import { screen } from 'expo-router/testing-library';
import { Alert } from 'react-native';

import { useIncoming } from '../share/incoming';
import { makePdf } from '../test-utils/fake-files';
import { renderToolsApp, homeWithFileEntries } from '../test-utils/render-app';

// D-200: In-app click counting for real routing; fake selectors/media platforms do not impersonate
// simulators, system shares, or timing measurements. D-449: Home screen has only a single "Open
// File", requiring an extra step compared to before whether choosing the photo library or files.
afterEach(() => useIncoming.getState().clear());
it.each([
  // A file entering the preview page requires opening the "quick action" panel first and then running it, taking one extra step compared to before (D-457); two photos still go directly to the inbox page without change.
  ['video-too-big', 'media', 5],
  ['pdf-too-big', 'files', 5],
  ['document-packet', 'media', 7],
] as const)(
  '%s (%s): first and second use finish with %i App taps',
  async (preset, source, expected) => {
    const { files } = await renderToolsApp(undefined, undefined, { seed: homeWithFileEntries });
    const traces: string[][] = [];
    for (const iteration of [0, 1]) {
      const trace: string[] = [];
      const press = async (id: string) => {
        await fireEvent.press(await screen.findByTestId(id, {}, { timeout: 3000 }));
        trace.push(id);
      };
      if (preset === 'video-too-big')
        files.nextMedia = [files.offerVideo('clip.mov', { size: 120 * 1024 * 1024 })];
      else if (preset === 'pdf-too-big')
        files.nextPick = [files.offer('document.pdf', await makePdf(2), 'application/pdf')];
      else
        files.nextMedia = [
          files.offerImage('id-front.jpg', 1000, 630),
          files.offerImage('id-back.jpg', 1000, 630),
        ];
      jest.spyOn(Alert, 'alert').mockImplementationOnce((_title, _message, buttons) => {
        buttons?.[source === 'media' ? 0 : 1]?.onPress?.();
      });
      await press('file-pick-open');
      trace.push(`choose-${source}`);
      if (preset !== 'document-packet') await press('preview-more');
      await press(`share-run-${preset}`);
      if (preset === 'document-packet') {
        await screen.findByText('裁剪 1/2', {}, { timeout: 3000 });
        await press('local-done');
        await screen.findByText('裁剪 2/2');
        await press('local-done');
        await screen.findByTestId('reorder-item-0');
        await press('local-done');
      }
      await press('prompt-ok');
      await screen.findByTestId('run-result', {}, { timeout: 3000 });
      expect(files.shared).toHaveLength(iteration + 1);
      expect(trace).toHaveLength(expected);
      traces.push(trace);
      // The action of returning to the home screen upon completion is not counted toward "obtaining a shareable result".
      await fireEvent.press(screen.getByTestId('run-done'));
    }
    expect(traces.map((trace) => trace.length)).toEqual([expected, expected]);
  },
);
