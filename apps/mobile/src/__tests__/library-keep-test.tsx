import { act, fireEvent, waitFor, within } from '@testing-library/react-native';
import { router } from 'expo-router';
import { screen } from 'expo-router/testing-library';

import { useGuide } from '../guide/store';
import { MemoryWorkspaceRepo } from '../storage/memory';
import { FakeFiles, makePdf } from '../test-utils/fake-files';
import { openPick, renderToolsApp, homeWithFileEntries } from '../test-utils/render-app';

// D-455: Opened and shared files are saved into the document library, storing thumbnails and text (PDF text layer, image recognition); all files are searchable by text inside them.

async function start() {
  const repo = new MemoryWorkspaceRepo();
  const files = new FakeFiles();
  // Only the two functions related to text: PDF text layer and image recognition.
  files.vision = {
    pdfText: async () => '房屋租赁合同 甲方 王小明 月租金 4500 元',
    recognizeText: async () => '午餐 合计 128 元',
  } as never;
  await repo.setMeta('guide', 'done');
  await act(() => useGuide.getState().load(repo));
  const app = await renderToolsApp(repo, files, { seed: homeWithFileEntries });
  return { ...app, files, repo };
}

afterEach(() => useGuide.setState({ stage: null, repo: null }));

describe('opened files go into the library with their text (D-455)', () => {
  it('opening a file keeps one copy with its text; opening it again does not add another', async () => {
    const { files, repo } = await start();
    const pdf = await makePdf(1);
    files.nextPick = [files.offer('租房合同.pdf', pdf, 'application/pdf')];
    await openPick('files');
    expect(await screen.findByTestId('share-screen')).toBeTruthy();
    const assets = await repo.listAssets();
    expect(assets.map((a) => [a.name, a.source])).toEqual([['租房合同.pdf', 'picked']]);
    await waitFor(() =>
      expect(files.texts.get(assets[0]!.path)).toBe('房屋租赁合同 甲方 王小明 月租金 4500 元'),
    );

    await act(() => router.back());
    files.nextPick = [files.offer('租房合同.pdf', pdf, 'application/pdf')];
    await openPick('files');
    await screen.findByTestId('share-screen');
    expect(await repo.listAssets()).toHaveLength(1);
  });

  it('a picture is recognized; all files finds it by the words inside and shows them', async () => {
    const { files, repo } = await start();
    files.nextMedia = [files.offerImage('IMG_0042.jpg', 400, 300)];
    await openPick('media');
    await screen.findByTestId('share-screen');
    const [photo] = await repo.listAssets();
    await waitFor(() => expect(files.texts.get(photo!.path)).toBe('午餐 合计 128 元'));
    await act(() => router.back());

    await act(() => router.push('/files'));
    const page = await screen.findByTestId('files-screen');
    await fireEvent.changeText(within(page).getByTestId('files-search'), '合计');
    expect(await within(page).findByTestId('file-IMG_0042.jpg')).toBeTruthy();
    expect(within(page).getByTestId(`file-snippet-${photo!.id}`)).toHaveTextContent(/合计 128/);
    await fireEvent.changeText(within(page).getByTestId('files-search'), '没有的字');
    expect(within(page).getByTestId('files-none')).toBeTruthy();
  });

  it('saving the opened file as a record reuses the library copy; leaving the form keeps it', async () => {
    const { files, repo } = await start();
    files.nextMedia = [files.offerImage('收据.jpg', 400, 300)];
    await openPick('media');
    // A file enters the preview page (D-457), with record storage on the bottom bar.
    await screen.findByTestId('preview-bar');
    expect(await repo.listAssets()).toHaveLength(1);
    await fireEvent.press(await screen.findByTestId('preview-record'));
    await fireEvent.press(await screen.findByTestId('share-record-new'));
    await screen.findByTestId('new-table-save');
    // No duplicate copy made.
    expect(await repo.listAssets()).toHaveLength(1);
    // Leave without saving: the copy in the document library remains.
    await act(() => router.back());
    await waitFor(() => expect(screen.queryByTestId('new-table-save')).toBeNull());
    expect((await repo.listAssets()).map((a) => a.name)).toEqual(['收据.jpg']);
  });
});
