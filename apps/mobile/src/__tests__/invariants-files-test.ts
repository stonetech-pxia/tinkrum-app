// Invariant 4: Originals are never moved or deleted (photo library, "Files", content://), only
// copies are processed. Uses the real file platform (expo-platform.ts) with expo-file-system
// replaced by a mock that records every deletion and move: passing the original URI to every entry
// point that deletes or moves, ensuring not a single original is lost. Real-device behavior (system
// photo library, share extension directory) can only be verified on device, see
// INVARIANTS_AUDIT.md.

import { expoFilePlatform } from '../runtime/expo-platform';
import { copyHandedFiles } from '../runtime/runner';
import type { WorkspaceRepo } from '../storage/types';

const mockTouched: { op: 'delete' | 'move'; uri: string }[] = [];

jest.mock('expo-file-system', () => {
  const join = (...parts: string[]) => parts.join('/').replace(/(?<![:/])\/{2,}/g, '/');
  class Directory {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = join(...parts.map((p) => (typeof p === 'string' ? p : p.uri)));
    }
    get exists() {
      return true;
    }
    create() {}
    list() {
      return [];
    }
    delete() {
      mockTouched.push({ op: 'delete', uri: this.uri });
    }
  }
  class File {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = join(...parts.map((p) => (typeof p === 'string' ? p : p.uri)));
    }
    get exists() {
      return true;
    }
    get size() {
      return 10;
    }
    get name() {
      return this.uri.split('/').pop();
    }
    create() {}
    delete() {
      mockTouched.push({ op: 'delete', uri: this.uri });
    }
    move(dest: { uri: string }) {
      mockTouched.push({ op: 'move', uri: this.uri });
      this.uri = dest.uri;
    }
    async copy() {}
    async write() {}
    async text() {
      return 'x';
    }
    async bytes() {
      return new Uint8Array(1);
    }
  }
  return {
    File,
    Directory,
    Paths: { cache: { uri: 'file:///cache/' }, document: { uri: 'file:///doc/' } },
  };
});
jest.mock('../packs/store', () => ({ PackStore: class {} }));
jest.mock('expo-image-manipulator', () => {
  const rendered = {
    width: 100,
    height: 80,
    saveAsync: async () => ({
      uri: 'file:///cache/ImageManipulator/out.jpg',
      width: 100,
      height: 80,
    }),
  };
  return {
    ImageManipulator: { manipulate: () => ({ renderAsync: async () => rendered }) },
    SaveFormat: { JPEG: 'jpeg' },
    FlipType: {},
  };
});

/** User originals: photo library, "Files", Android content://, and user files stored by the app itself. */
const ORIGINALS = [
  'content://media/external/images/media/42',
  'content://com.android.providers.downloads.documents/document/7',
  'file:///var/mobile/Media/DCIM/100APPLE/IMG_0001.JPG',
  'file:///private/var/mobile/Library/Mobile%20Documents/com~apple~CloudDocs/合同.pdf',
  'file:///doc/assets/abcdef12/合同.pdf',
];

describe('Invariant 4: Originals are never moved or deleted', () => {
  beforeEach(() => {
    mockTouched.length = 0;
  });

  it('cleaning up a run, a picker batch or a shared batch never touches an original', async () => {
    for (const uri of ORIGINALS) {
      await expoFilePlatform.removeRunFile(uri);
      await expoFilePlatform.removePickedCopies([uri]);
      await expoFilePlatform.removeShared([], [uri]);
      await expoFilePlatform.readPickedText(uri);
    }
    // removeShared clears the Android preview cache directory (cache/preview) every time, which is the app's own private copy.
    expect(mockTouched.filter((t) => !t.uri.startsWith('file:///cache/'))).toEqual([]);
  });

  it('using an original in a run uses it in place; only the app’s own cache copies are moved', async () => {
    for (const uri of ORIGINALS) {
      const used = await expoFilePlatform.adoptIntoRun(uri, 'run1', 'a.jpg');
      expect(used.uri).toBe(uri);
    }
    expect(mockTouched).toEqual([]);
    // Copies placed in cache by the file picker can be moved into the run directory (belongs to this batch, not an original).
    await expoFilePlatform.adoptIntoRun('file:///cache/ImagePicker/x.jpg', 'run1', 'b.jpg');
    expect(mockTouched.filter((t) => t.op === 'move')).toEqual([
      { op: 'move', uri: 'file:///cache/ImagePicker/x.jpg' },
    ]);
    expect(mockTouched.every((t) => t.uri.startsWith('file:///cache/'))).toBe(true);
  });

  // D-425: When a report includes attachments, shrink originals to JPEG: only the generated copy (in cache) is modified; originals remain untouched.
  it('reducing a photo for a report never touches the original', async () => {
    for (const uri of ORIGINALS) {
      const out = await expoFilePlatform.reducedJpeg(uri, 1400, 0.75, 'run1', 'a/x.jpg');
      expect(out.uri).not.toBe(uri);
    }
    expect(mockTouched.some((t) => t.op === 'move')).toBe(true);
    expect(mockTouched.filter((t) => ORIGINALS.includes(t.uri))).toEqual([]);
  });

  // D-442: When passing attachments to a run, copies are processed and user files (assets/) are never moved or deleted; user files are used in place and not relocated.
  it('handing attachments to a run copies them and never moves or deletes the user files', async () => {
    const assets = new Map(
      [
        ['a1', 'contract.pdf', 'application/pdf'],
        ['a2', 'clip.mp4', 'video/mp4'],
      ].map(([id, name, mimeType]) => [
        id,
        {
          id,
          name,
          mimeType,
          size: 10,
          path: `assets/${id}/${name}`,
          source: 'picked',
          createdAt: 1,
        },
      ]),
    );
    const repo = {
      getAsset: async (id: string) => assets.get(id!) ?? null,
    } as unknown as WorkspaceRepo;
    const value = await copyHandedFiles({ repo, files: expoFilePlatform }, 'run1', {
      type: 'attachments',
      fileType: 'files',
      assetIds: ['a1', 'a2'],
      name: 'Scan',
    });
    expect(value.type).toBe('files');
    // Document-type files are copied into the run directory, while videos are used in place.
    const uris = (value as { items: { uri: string }[] }).items.map((i) => i.uri);
    expect(uris[0]).toContain('/runs/run1/');
    expect(uris[1]).toContain('/assets/a2/clip.mp4');
    expect(mockTouched.filter((t) => t.uri.includes('/assets/'))).toEqual([]);
  });

  it('removing a saved file only deletes inside the app’s own assets folder', async () => {
    for (const path of ['../DCIM/a.jpg', 'Documents/a.pdf', 'assets/..', 'assets/']) {
      await expoFilePlatform.removeAssetFile(path);
    }
    expect(mockTouched).toEqual([]);
  });
});
