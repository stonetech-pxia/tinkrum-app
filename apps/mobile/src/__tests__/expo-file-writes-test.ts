// expo-file-system 的 File.write 在 Android 上是异步的（返回 Promise，另有 writeSync）。
// 不等它写完就往下走，下一步可能读到写了一半的文件：手机上「多份材料合一」第 3 步报「文件可能已损坏」。
// 这里把 write 换成慢一点才写完的版本，检查每个写文件的地方都等它写完。
// copy 也一样（返回 Promise，另有 copySync）：分享前复制的那一份没复制完就交给 Gmail，Gmail 报「无法添加附件」（ENOENT）。

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
      // 和 Android 一样：调用时还没写，等一会儿才写进去。
      return new Promise<void>((resolve) =>
        setTimeout(() => {
          mockDisk.set(this.uri, content);
          resolve();
        }, 5),
      );
    }
    copy(destination: { uri: string }) {
      // 和 Android 一样：调用时还没复制，等一会儿才复制过去。
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

// 原生分享：交出去的时候，那个文件要已经在了。
const mockSharedExisted: boolean[] = [];
jest.mock('../../modules/morph-share', () => ({
  __esModule: true,
  default: {
    async shareFiles(uris: string[]) {
      mockSharedExisted.push(...uris.map((uri) => mockDisk.has(uri)));
    },
  },
}));

// 文字识别（D-269）：张量写进临时文件交给原生模块。原生只看文件有多大，没写完就报
// 「input has 0 bytes」（手机上「识别照片里的文字」第 2 步）。
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
  // 正好是模型要的大小，不用缩放：逐像素放大要 4 秒，全量跑时会超过 5 秒上限。
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
    // 文档库里的文件不在 FileProvider 开放的目录里：先复制一份再交出去。
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
