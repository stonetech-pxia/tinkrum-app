import { BUNDLED_PACKS, packById, type PackManifest, type PackNeed } from '@morph/core';
import { act, fireEvent, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { screen } from 'expo-router/testing-library';

import type { PackBridge } from '../packs/bridge';
import { FILE_BUNDLE_ASKED, ensureRunPacks, fileBundleMissing } from '../packs/file-bundle';
import type { Packs } from '../packs/PackHost';
import { PackStore } from '../packs/store';
import { useIncoming } from '../share/incoming';
import { MemoryWorkspaceRepo } from '../storage/memory';
import { FakeFiles, FakeVision, TINY_JPEG, makePdf } from '../test-utils/fake-files';
import { MemoryPackFs, bundlePack, sha256, text } from '../test-utils/memory-packs';
import { renderToolsApp } from '../test-utils/render-app';

// File processing bundle asked once (D-456): asked once after scanning, sharing, or opening a file, downloaded together; no optional popups at runtime anymore.

const NO_PAGES: string[] = [];

async function packStore(installed: string[] = []) {
  const fs = new MemoryPackFs();
  const store = new PackStore(fs, sha256);
  for (const id of installed)
    await fs.writeText(`${id}/${packById(id)!.version}/ready.json`, '{"bytes":1,"installedAt":1}');
  return store;
}

/**
 * Fresh install of App (D-510): documentDirectory/packs is empty, app includes the platform's
 * extension pack. Real manifest hash does not match test content, so each extension pack is
 * replaced with a small file manifest (ID and version unchanged).
 */
async function freshInstall(platform: 'ios' | 'android') {
  const fs = new MemoryPackFs();
  const lookup = new Map<string, PackManifest>();
  for (const id of BUNDLED_PACKS[platform]) {
    const body = text(`${id} body`);
    const pack = {
      ...packById(id)!,
      files: [
        {
          path: 'model.bin',
          url: `https://cdn/${id}`,
          size: body.length,
          sha256: await sha256(body),
        },
      ],
    };
    lookup.set(id, pack);
    bundlePack(fs, pack, () => body);
  }
  return { fs, store: new PackStore(fs, sha256, (id) => lookup.get(id) ?? packById(id)) };
}

function phone({ documentCamera = true, canFindPaper = true } = {}) {
  const files = new FakeFiles();
  const vision = new FakeVision(files);
  vision.ocrModel = { pack: 'ppocr', languages: ['zh', 'en'] };
  Object.assign(vision, {
    flattenModel: { pack: 'dewarp' },
    layoutModel: { pack: 'layout' },
    documentCamera,
    canFindPaper,
  });
  files.vision = vision;
  return files;
}

describe('which packs the file bundle lists (D-456)', () => {
  it('lists text recognition, PDF preview, flattening and layout on a phone with a document camera', async () => {
    expect(await fileBundleMissing(phone(), await packStore())).toEqual([
      'ppocr',
      'pdfview',
      'dewarp',
      'layout',
    ]);
  });

  it('adds the photo straightener only when the phone has no document camera and cannot find paper', async () => {
    const files = phone({ documentCamera: false, canFindPaper: false });
    expect(await fileBundleMissing(files, await packStore())).toContain('scan');
  });

  // D-510: New users no longer see "Download File Tool": this group comes bundled with the app.
  it('lists nothing on a fresh install: the file tools come with the app (D-510)', async () => {
    const iphone = await freshInstall('ios');
    expect(await fileBundleMissing(phone(), iphone.store)).toEqual([]);
    // Android cannot auto-find paper edges; document camera also absent without Google Play services, scan correction package is also bundled.
    for (const documentCamera of [true, false]) {
      const android = await freshInstall('android');
      const files = phone({ documentCamera, canFindPaper: false });
      expect(await fileBundleMissing(files, android.store)).toEqual([]);
      expect(android.fs.downloads).toEqual([]);
    }
    expect(iphone.fs.downloads).toEqual([]);
  });

  it('leaves out what is already installed', async () => {
    expect(await fileBundleMissing(phone(), await packStore(['ppocr', 'pdfview']))).toEqual([
      'dewarp',
      'layout',
    ]);
  });
});

describe('packs while running (D-456)', () => {
  const needs: PackNeed[] = [
    { pack: 'dewarp', optional: true },
    { pack: 'ppocr', optional: false },
  ];

  it('does not ask for optional packs: they are skipped', async () => {
    const ask = jest.fn(async () => []);
    const left = await ensureRunPacks(await packStore(), [needs[0]!], ask);
    expect(ask).not.toHaveBeenCalled();
    expect(left).toEqual(['dewarp']);
  });

  it('asks only for the required ones and still reports the skipped optional ones', async () => {
    const ask = jest.fn(async () => [] as string[]);
    const left = await ensureRunPacks(await packStore(), needs, ask);
    expect(ask).toHaveBeenCalledWith([{ pack: 'ppocr', optional: false }]);
    expect(left).toEqual(['dewarp']);
  });

  it('cancels the run when a required pack is not downloaded', async () => {
    expect(await ensureRunPacks(await packStore(), needs, async () => null)).toBeNull();
  });
});

describe('the one-time prompt after opening a file (D-456)', () => {
  async function open(repo: MemoryWorkspaceRepo, files: FakeFiles) {
    const bridge = {
      subscribe: () => () => undefined,
      activePages: () => NO_PAGES,
      close: () => undefined,
    } as unknown as PackBridge;
    await renderToolsApp(repo, files, { packs: { store: await packStore(), bridge } as Packs });
    const picked = files.offer('bill.jpg', TINY_JPEG, 'image/jpeg');
    await act(async () => useIncoming.getState().receive([picked], [], 'picker'));
    await act(() => router.push('/share'));
  }

  it('a fresh install with the bundled packs does not ask at all (D-510)', async () => {
    const repo = new MemoryWorkspaceRepo();
    const files = phone();
    const { fs, store } = await freshInstall('ios');
    const bridge = {
      subscribe: () => () => undefined,
      activePages: () => NO_PAGES,
      close: () => undefined,
    } as unknown as PackBridge;
    await renderToolsApp(repo, files, { packs: { store, bridge } as Packs });
    const picked = files.offer('bill.jpg', TINY_JPEG, 'image/jpeg');
    await act(async () => useIncoming.getState().receive([picked], [], 'picker'));
    await act(() => router.push('/share'));
    expect(await screen.findByTestId('share-screen')).toBeTruthy();
    await waitFor(() => expect(fs.copies.length).toBe(BUNDLED_PACKS.ios.length));
    expect(screen.queryByTestId('pack-gate')).toBeNull();
    expect(screen.queryByText(/^下载文件工具/)).toBeNull();
    expect(fs.downloads).toEqual([]);
    // Not asked, so not recorded as "asked": can ask again when the manifest is updated in the future.
    expect(await repo.getMeta(FILE_BUNDLE_ASKED)).toBeNull();
  });

  it('asks once with everything in one list, and not again after "not now"', async () => {
    const repo = new MemoryWorkspaceRepo();
    const files = phone();
    await open(repo, files);
    expect(await screen.findByText(/^下载文件工具/)).toBeTruthy();
    for (const id of ['ppocr', 'pdfview', 'dewarp', 'layout'])
      expect(screen.getByTestId(`pack-item-${id}`)).toBeTruthy();
    // Every item can be unchecked, without writing "continue without downloading".
    expect(screen.getByTestId('pack-include-ppocr')).toBeTruthy();
    expect(screen.queryByText(/不下载也能继续/)).toBeNull();
    expect(screen.queryByText(/许可证/)).toBeNull();
    // Opening the page does not write data (invariant 15): recorded as asked only upon tapping.
    expect(await repo.getMeta(FILE_BUNDLE_ASKED)).toBeNull();
    expect(screen.getByTestId('pack-cancel')).toHaveTextContent('以后再说');
    await fireEvent.press(screen.getByTestId('pack-cancel'));
    await waitFor(() => expect(screen.queryByTestId('pack-gate')).toBeNull());
    expect(await repo.getMeta(FILE_BUNDLE_ASKED)).toBe('1');

    await act(() => router.back());
    const again = files.offer('bill2.jpg', TINY_JPEG, 'image/jpeg');
    await act(async () => useIncoming.getState().receive([again], [], 'picker'));
    await act(() => router.push('/share'));
    expect(await screen.findByTestId('share-screen')).toBeTruthy();
    expect(screen.queryByTestId('pack-gate')).toBeNull();
  });

  // Observed on simulator (2026-11-06): after downloading "PDF Preview" in this box, preview page still prompts to download, tapping again asks once more.
  it('the PDF preview behind it starts showing pages once the bundle is downloaded', async () => {
    const fs = new MemoryPackFs();
    const lookup = new Map<string, PackManifest>();
    for (const id of ['ppocr', 'pdfview']) {
      const body = `${id} body`;
      const url = `https://cdn/${id}.js`;
      fs.net.set(url, text(body));
      lookup.set(id, {
        ...packById(id)!,
        requires: [],
        files: [{ path: `${id}.js`, url, size: body.length, sha256: await sha256(text(body)) }],
      });
    }
    const store = new PackStore(fs, sha256, (id) => lookup.get(id));
    const files = new FakeFiles();
    const vision = new FakeVision(files);
    vision.ocrModel = { pack: 'ppocr', languages: ['zh', 'en'] };
    files.vision = vision;
    const bridge = {
      subscribe: () => () => undefined,
      activePages: () => NO_PAGES,
      close: () => undefined,
      call: async () => ({ count: 1, pages: [{ index: 0, data: 'AAAA' }] }),
    } as unknown as PackBridge;
    await renderToolsApp(new MemoryWorkspaceRepo(), files, { packs: { store, bridge } as Packs });
    const picked = files.offer('合同.pdf', await makePdf(1), 'application/pdf');
    await act(async () => useIncoming.getState().receive([picked], [], 'picker'));
    await act(() => router.push('/share'));
    expect(await screen.findByTestId('desk-pdf-pack')).toBeTruthy();
    await fireEvent.press(await screen.findByTestId('pack-download'));
    await waitFor(() => expect(screen.queryByTestId('pack-gate')).toBeNull());
    expect(await screen.findByTestId('desk-pdf-pages')).toBeTruthy();
    expect(screen.queryByTestId('desk-pdf-pack')).toBeNull();
  });
});
