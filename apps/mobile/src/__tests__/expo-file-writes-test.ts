// expo-file-system's File.write is asynchronous on Android (returns a Promise, with writeSync as an
// alternative). Proceeding without awaiting completion may cause the next step to read a
// half-written file: step 3 of "merge multiple materials" reports "file may be corrupted" on phone.
// Here, write is replaced with a version that finishes slowly, verifying that every file-writing
// location awaits completion. copy is similar (returns a Promise, with copySync as an alternative):
// the copy prepared for sharing is handed to Gmail before finishing copy, causing Gmail to report
// "unable to add attachment" (ENOENT).

import { Platform } from 'react-native';

import { expoPackFs } from '../packs/expo-pack-fs';
import { expoFilePlatform } from '../runtime/expo-platform';
import { expoVision } from '../runtime/expo-vision';
import { expoToolFs } from '../tool-download/expo-tool-fs';

const mockDisk = new Map<string, Uint8Array | string>();

jest.mock('expo-file-system', () => {
  const join = (...parts: string[]) => parts.join('/').replace(/\/+/g, '/');
  class Directory {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = join(...parts.map((p) => (typeof p === 'string' ? p : p.uri)));
    }
    get exists() {
      return true;
    }
    create() {}
    delete() {}
  }
  class File {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = join(...parts.map((p) => (typeof p === 'string' ? p : p.uri)));
    }
    get exists() {
      return mockDisk.has(this.uri);
    }
    get size() {
      return (mockDisk.get(this.uri) as Uint8Array | undefined)?.length ?? 0;
    }
    create() {}
    delete() {
      mockDisk.delete(this.uri);
    }
    write(content: Uint8Array | string) {
      // Same as Android: not yet written upon call, writes after a short delay.
      return new Promise<void>((resolve) =>
        setTimeout(() => {
          mockDisk.set(this.uri, content);
          resolve();
        }, 5),
      );
    }
    copy(destination: { uri: string }) {
      // Same as Android: not yet copied upon call, copies after a short delay.
      return new Promise<void>((resolve) =>
        setTimeout(() => {
          mockDisk.set(destination.uri, mockDisk.get(this.uri)!);
          resolve();
        }, 5),
      );
    }
    async bytes() {
      return mockDisk.get(this.uri) as Uint8Array;
    }
    async text() {
      return mockDisk.get(this.uri) as string;
    }
  }
  return { File, Directory, Paths: { cache: { uri: 'cache' }, document: { uri: 'doc' } } };
});

// Native sharing: the file must already exist when handed over.
const mockSharedExisted: boolean[] = [];
jest.mock('../../modules/morph-share', () => ({
  __esModule: true,
  default: {
    async shareFiles(uris: string[]) {
      mockSharedExisted.push(...uris.map((uri) => mockDisk.has(uri)));
    },
  },
}));

// OCR (D-269): tensors are written to temporary files and passed to the native module. The native
// side checks the file size; if incomplete, it reports "input has 0 bytes" (step 2 of "recognize
// text in photo" on mobile).
const mockDetectInputs: number[] = [];
jest.mock('../../modules/morph-vision', () => ({
  __esModule: true,
  default: {
    canFindPaper: () => false,
    isDocumentCameraSupported: () => false,
    supportsLanguage: () => false,
    ocrLoad: async () => {},
    async ocrDetect(input: string) {
      mockDetectInputs.push((mockDisk.get(input) as Uint8Array | undefined)?.length ?? 0);
      throw new Error('stop after detect');
    },
    ocrRecognize: async () => 0,
  },
}));
jest.mock('../packs/store', () => ({
  PackStore: class {
    isInstalled = async () => true;
    path = (id: string, file: string) => `packs/${id}/${file}`;
  },
}));
jest.mock('../runtime/skia', () => ({
  // Exactly the size the model needs, no scaling required: resizing pixel-by-pixel takes 4 seconds, which exceeds the 5-second limit when running full-scale.
  ocrPixels: async () => ({ width: 736, height: 736, data: new Uint8Array(736 * 736 * 4) }),
}));

beforeEach(() => {
  mockDisk.clear();
  mockDetectInputs.length = 0;
  mockSharedExisted.length = 0;
});

it('writes a run file completely before the next step can read it', async () => {
  const bytes = new Uint8Array([37, 80, 68, 70]);
  const { uri } = await expoFilePlatform.writeRunFile('run1', '1/merged.pdf', bytes);
  expect(mockDisk.get(uri)).toEqual(bytes);
});

it('finishes writing text files for packs and downloaded tools before returning', async () => {
  const before = mockDisk.size;
  await expoPackFs.writeText('pdfview/1/index.html', '<html></html>');
  expect(mockDisk.size).toBe(before + 1);
  await expoToolFs.writeText('tools/qr/1/tool.json', '{}');
  expect(mockDisk.size).toBe(before + 2);
});

it('finishes writing the text recognition input before the model reads it', async () => {
  mockDisk.set(expoPackFs.uri('packs/ppocr/dictionary.json'), '{"characters":["a"]}');
  const vision = expoVision((runId, relPath) => `cache/runs/${runId}/${relPath}`)!;
  await expect(vision.recognizeText('cache/photo.jpg', ['zh-Hans'])).rejects.toThrow(
    'stop after detect',
  );
  expect(mockDetectInputs).toHaveLength(1);
  expect(mockDetectInputs[0]).toBeGreaterThan(0);
});

it('finishes copying a file into the share folder before the system share sheet gets it', async () => {
  const original = Platform.OS;
  Platform.OS = 'android';
  try {
    // Files in the document library are not in the FileProvider-exposed directory: copy them first before handing them out.
    mockDisk.set('doc/v2-0.docx', new Uint8Array([80, 75]));
    await expoFilePlatform.shareUris([
      {
        uri: 'doc/v2-0.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        name: 'Letter',
        ext: 'docx',
      },
    ]);
    expect(mockSharedExisted).toEqual([true]);
  } finally {
    Platform.OS = original;
  }
});
