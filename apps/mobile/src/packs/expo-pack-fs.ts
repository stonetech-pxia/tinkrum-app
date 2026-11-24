import { CryptoDigestAlgorithm, digest } from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';

import MorphSpeech from '../../modules/morph-speech';
import { PackStore, type PackFs, type Sha256 } from './store';

// Expo implementation of PackFs: documentDirectory/packs/. Downloads use expo-file-system, hashes
// use expo-crypto (both available in Expo Go). Large file hashes (speech models) are computed
// chunk-by-chunk by the native MorphSpeech module (falling back to reading the entire file into
// memory if unavailable). Packs bundled with the App (D-510) reside under packs/ in the App: iOS is
// a folder inside .app, Android is APK assets (asset:///packs/).

const root = () => new Directory(Paths.document, 'packs');
const bundle = () => new Directory(Paths.bundle, 'packs');

function fileAt(path: string): File {
  const parts = path.split('/');
  const dir = new Directory(root(), ...parts.slice(0, -1));
  dir.create({ idempotent: true, intermediates: true });
  return new File(dir, parts[parts.length - 1]!);
}

const entry = (path: string) => (path ? new Directory(root(), ...path.split('/')) : root());

export const expoPackFs: PackFs = {
  async download(url, path) {
    const dest = fileAt(path);
    if (dest.exists) dest.delete();
    const file = await File.downloadFileAsync(url, dest);
    return file.bytes();
  },

  ...(MorphSpeech && {
    async downloadLarge(url: string, path: string, onBytes: (bytes: number) => void) {
      const dest = fileAt(path);
      if (dest.exists) dest.delete();
      const file = await File.downloadFileAsync(url, dest, {
        onProgress: ({ bytesWritten }) => onBytes(bytesWritten),
      });
      return { size: file.size, sha256: await MorphSpeech!.sha256File(file.uri) };
    },
  }),

  async exists(path) {
    return new File(root(), ...path.split('/')).exists;
  },

  async readText(path) {
    return new File(root(), ...path.split('/')).text();
  },

  async writeText(path, text) {
    const file = fileAt(path);
    if (file.exists) file.delete();
    file.create();
    await file.write(text);
  },

  async readBytes(path) {
    return new File(root(), ...path.split('/')).bytes();
  },

  async remove(path) {
    const file = new File(root(), ...path.split('/'));
    if (path && file.exists) {
      file.delete();
      return;
    }
    const dir = entry(path);
    if (dir.exists) dir.delete();
  },

  async listDirs(path) {
    const dir = entry(path);
    if (!dir.exists) return [];
    return dir
      .list()
      .filter((e): e is Directory => e instanceof Directory)
      .map((d) => d.name);
  },

  uri(path) {
    return new File(root(), ...path.split('/')).uri;
  },

  async bundledDirs(path) {
    // When the App directory cannot be read, treat it as absent: prompt for download as usual, preventing "installed or not" errors from breaking everything.
    try {
      const dir = path ? new Directory(bundle(), ...path.split('/')) : bundle();
      if (!dir.exists) return [];
      return dir
        .list()
        .filter((e): e is Directory => e instanceof Directory)
        .map((d) => d.name);
    } catch (e) {
      if (__DEV__) console.warn('[packs] cannot read bundled packs', e);
      return [];
    }
  },

  async copyBundled(path) {
    const dest = fileAt(path);
    if (dest.exists) dest.delete();
    await new File(bundle(), ...path.split('/')).copy(dest);
    return { size: dest.size, sha256: await dest.digest('SHA-256') };
  },
};

export const expoSha256: Sha256 = async (bytes) => {
  const buffer = await digest(CryptoDigestAlgorithm.SHA256, bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

/**
 * The single PackStore in the App: shared by root layout (downloads), OCR, flattening, layout
 * analysis, and speech-to-text. Bundled packs are copied upon first use (D-510); if two
 * PackStores copy the same pack simultaneously they corrupt each other's half-copied files, so
 * there can only be one. Downloaded only after user confirmation, stored in
 * documentDirectory/packs (D-064); packs without a hosting URL yet (flattening, layout, D-274)
 * are downloaded from EXPO_PUBLIC_MORPH_PACKS_URL, prompting is skipped if unconfigured.
 */
export const expoPackStore = new PackStore(
  expoPackFs,
  expoSha256,
  undefined,
  undefined,
  process.env.EXPO_PUBLIC_MORPH_PACKS_URL,
);

/** Channel file reader: files inside packs and temporary files of the current run. */
export function expoBridgeFiles(store: {
  isInstalled(id: string): Promise<boolean>;
  path(id: string, file: string): string;
}): import('./bridge').BridgeFiles {
  return {
    isInstalled: (pack) => store.isInstalled(pack),
    async packFile(pack, path, as) {
      const file = new File(root(), ...store.path(pack, path).split('/'));
      return as === 'text' ? file.text() : file.base64();
    },
    runFile: (uri) => new File(uri).base64(),
  };
}
