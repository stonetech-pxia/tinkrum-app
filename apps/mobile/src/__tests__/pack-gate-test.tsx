import { SafeAreaProvider } from 'react-native-safe-area-context';
import { createDefaultWorkspace, formatFileSize, packById, type PackNeed } from '@morph/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { PackGate } from '../packs/PackGate';
import { PackStore } from '../packs/store';
import { makePalette } from '../renderer/theme';
import { MemoryPackFs, manifests, sha256 } from '../test-utils/memory-packs';

// Prompt when first using a feature requiring download (D-112): State download size and offline
// availability, avoid mentioning "extension packs". All requirements for a single run fit in one
// prompt (D-299).

async function setup(needs: PackNeed[]) {
  const fs = new MemoryPackFs();
  const lookup = await manifests(fs);
  const store = new PackStore(fs, sha256, (id) => lookup.get(id));
  const palette = makePalette(createDefaultWorkspace('zh').theme, false);
  const done: (string[] | null)[] = [];
  const gate = (n: PackNeed[]) => (
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 375, height: 667 },
        insets: { top: 0, bottom: 0, left: 0, right: 0 },
      }}>
      <PackGate
        needs={n}
        store={store}
        palette={palette}
        locale="zh"
        onDone={(left) => done.push(left)}
      />
    </SafeAreaProvider>
  );
  const view = await render(gate(needs));
  return { store, done, view, gate };
}

const size = (...ids: string[]) =>
  formatFileSize(
    ids.reduce((sum, id) => sum + packById(id)!.files.reduce((s, f) => s + f.size, 0), 0),
    'zh',
  );

describe('first-use download prompt', () => {
  // Cancel button remains present during download; waiting does not block until download completion; must wait for onDone.
  it('says how much to download and that it works offline afterwards', async () => {
    await setup([{ pack: 'pdfview', optional: false }]);
    expect(await screen.findByText(/^首次使用需下载 \d+(\.\d)? (KB|MB)$/)).toBeTruthy();
    expect(screen.getByText(/之后不联网也能用/)).toBeTruthy();
    expect(screen.getByTestId('pack-gate')).not.toHaveTextContent(/扩展包|包/);
  });

  it('says the step goes on without the download when it is optional (D-274)', async () => {
    const { done } = await setup([{ pack: 'pdfview', optional: true }]);
    expect(await screen.findByText(/不下载也能继续/)).toBeTruthy();
    // Cancel button labeled "Don't download, continue" to avoid implying the entire quick action is cancelled.
    expect(screen.getByTestId('pack-cancel')).toHaveTextContent('不下载，继续');
    await fireEvent.press(screen.getByTestId('pack-cancel'));
    expect(done).toEqual([['pdfview']]);
  });

  it('lists everything a quick action needs in one prompt with the total size (D-299)', async () => {
    // New user "Scan table to Excel": Find edges, flatten (optional), recognize text, stated clearly in one go without popping up three times consecutively.
    const { done } = await setup([
      { pack: 'scan', optional: false },
      { pack: 'dewarp', optional: true },
      { pack: 'ppocr', optional: false },
    ]);
    expect(
      await screen.findByText(`首次使用需下载 ${size('scan', 'dewarp', 'ppocr')}`),
    ).toBeTruthy();
    for (const id of ['scan', 'dewarp', 'ppocr']) {
      expect(screen.getByTestId(`pack-item-${id}`)).toHaveTextContent(packById(id)!.name.zh, {
        exact: false,
      });
    }
    // Optional items can be unchecked, total size updates accordingly; required items cannot be unchecked.
    expect(screen.queryByTestId('pack-include-scan')).toBeNull();
    await fireEvent.press(screen.getByTestId('pack-include-dewarp'));
    expect(await screen.findByText(`首次使用需下载 ${size('scan', 'ppocr')}`)).toBeTruthy();
    // When required items exist, canceling aborts execution.
    expect(screen.getByTestId('pack-cancel')).toHaveTextContent('取消');
    await fireEvent.press(screen.getByTestId('pack-cancel'));
    expect(done).toEqual([null]);
  });

  it('downloads every ticked item with one tap and says which optional ones were left out', async () => {
    const all = await setup([
      { pack: 'ocr', optional: false },
      { pack: 'ocr-eng', optional: true },
    ]);
    await fireEvent.press(await screen.findByTestId('pack-download'));
    await waitFor(() => expect(all.done).toEqual([[]]));
    expect(await all.store.isInstalled('ocr')).toBe(true);
    expect(await all.store.isInstalled('ocr-eng')).toBe(true);
    all.view.unmount();

    const some = await setup([
      { pack: 'ocr', optional: false },
      { pack: 'ocr-eng', optional: true },
    ]);
    await fireEvent.press(await screen.findByTestId('pack-include-ocr-eng'));
    await fireEvent.press(screen.getByTestId('pack-download'));
    await waitFor(() => expect(some.done).toEqual([['ocr-eng']]));
    expect(await some.store.isInstalled('ocr')).toBe(true);
    expect(await some.store.isInstalled('ocr-eng')).toBe(false);
  });

  it('asks again for the next download when one run needs two (scan, then flattening)', async () => {
    // When downloading one item and then prompting for the next within the same run view, the
    // prompt box does not remount: Avoid getting stuck in the previous "Downloading" state,
    // re-display the download button (on mobile, getting stuck on a full progress bar forced
    // selecting "Don't download, continue").
    const { done, view, gate } = await setup([{ pack: 'ocr', optional: true }]);
    await fireEvent.press(await screen.findByTestId('pack-download'));
    await waitFor(() => expect(done).toEqual([[]]));
    await view.rerender(gate([{ pack: 'ocr-eng', optional: true }]));
    expect(await screen.findByTestId('pack-download')).toBeTruthy();
  });

  it('lets a running download go on in the background and tells when it is done', async () => {
    // Slow download: User taps "Download in background", prompt closes, current run is cancelled, download continues; notify once upon completion, without calling onDone.
    const fs = new MemoryPackFs();
    const lookup = await manifests(fs);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const slow = fs.download.bind(fs);
    fs.download = async (url, path) => {
      await hold;
      return slow(url, path);
    };
    const store = new PackStore(fs, sha256, (id) => lookup.get(id));
    const palette = makePalette(createDefaultWorkspace('zh').theme, false);
    const done: (string[] | null)[] = [];
    const ended: { ids: string[]; ok: boolean }[] = [];
    store.onBackgroundEnd((e) => ended.push(e));
    await render(
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 375, height: 667 },
          insets: { top: 0, bottom: 0, left: 0, right: 0 },
        }}>
        <PackGate
          needs={[{ pack: 'ocr', optional: false }]}
          store={store}
          palette={palette}
          locale="zh"
          onDone={(left) => done.push(left)}
        />
      </SafeAreaProvider>,
    );
    expect(screen.queryByTestId('pack-background')).toBeNull();
    await fireEvent.press(await screen.findByTestId('pack-download'));
    const later = await screen.findByTestId('pack-background');
    expect(later).toHaveTextContent('后台下载');
    await fireEvent.press(later);
    expect(done).toEqual([null]);
    release();
    await waitFor(() => expect(ended).toEqual([{ ids: ['ocr'], ok: true }]));
    expect(await store.isInstalled('ocr')).toBe(true);
    expect(done).toEqual([null]);
  });
});
