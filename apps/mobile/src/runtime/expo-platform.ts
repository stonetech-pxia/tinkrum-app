import { CHECKER_FILE_NAME, HANDOFF_DOC_FILES, HANDOFF_REQUEST_FILE, RunError } from '@morph/core';
import { getStringAsync, setStringAsync } from 'expo-clipboard';
import { getDocumentAsync } from 'expo-document-picker';
import { Directory, File, Paths } from 'expo-file-system';
import { FlipType, ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import {
  UIImagePickerPreferredAssetRepresentationMode,
  VideoExportPreset,
  launchCameraAsync,
  launchImageLibraryAsync,
  requestCameraPermissionsAsync,
  type ImagePickerAsset,
} from 'expo-image-picker';
import { Asset, requestPermissionsAsync } from 'expo-media-library';
import { printAsync, printToFileAsync } from 'expo-print';
import { shareAsync } from 'expo-sharing';

import {
  FOLDER_NOT_WRITABLE,
  forgetFolders,
  previewFile,
  rememberedFolder,
  saveAllToFolder,
  shareAll,
  type ShareDeps,
} from './expo-share';
import { Platform, Share } from 'react-native';

import { expoDeskFs } from '../desk/expo-desk-fs';
import { expoDocuments } from './expo-documents';
import { expoTranslate } from './expo-translate';
import { expoBackground } from './expo-background';
import { expoMedia } from './expo-media';
import { expoVision } from './expo-vision';
import MorphShare from '../../modules/morph-share';
import MorphSpeech from '../../modules/morph-speech';
import MorphTTS from '../../modules/morph-tts';
import MorphVision from '../../modules/morph-vision';
import type { FilePlatform, ImageFormat, PickedFile } from './platform';
import { composeOnSurface, enhanceJpeg, pixelsOf, renderTextPng } from './skia';
import { createSpeech } from './speech';
import { createSpeaker } from './expo-tts';
import { expoPackFs, expoPackStore } from '../packs/expo-pack-fs';

/** Used solely to locate speech model files (downloading is handled by the app root layout, D-064); shares the same instance as the root layout (D-510). */
const speechPacks = expoPackStore;

// Expo implementation of FilePlatform. User files are stored in app documents directory under
// assets/<id>/<filename>, with databases storing only relative paths, completely decoupled from
// configuration versions (§7G).

const ROOT = 'assets';

/** Filename format for files copied by the share extension (plugins/share-extension/ShareViewController.swift). */
const SHARED_COPY = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\.[A-Za-z0-9]+$/i;

function assetDir(assetId: string): Directory {
  const dir = new Directory(Paths.document, ROOT, assetId);
  dir.create({ idempotent: true, intermediates: true });
  return dir;
}

const fileAt = (path: string) => new File(Paths.document, ...path.split('/'));

/** Thumbnail of the first page of a PDF (D-451): stored in the same assets/<id>/ directory as the file and deleted together with it. */
const THUMB = '.thumb.jpg';
/** Extracted text from files (D-455): in the same directory, deleted together with the file. */
const TEXT = '.text.txt';
const besideAsset = (path: string, name: string) => {
  const parts = path.split('/');
  parts[parts.length - 1] = name;
  return new File(Paths.document, ...parts);
};

/** Render the first page of a PDF when saving into user files (as part of a user action); if it fails to open (corrupted, password-protected), no thumbnail is created and an icon is displayed instead. */
async function makePdfThumbnail(file: File, dir: Directory): Promise<void> {
  if (!/\.pdf$/i.test(file.name) || !MorphVision) return;
  try {
    await MorphVision.pdfThumbnail(file.uri, new File(dir, THUMB).uri, 360);
  } catch {
    // No thumbnail available, display PDF icon in the list.
  }
}

/** Temporary file in the current run (D-063). relPath looks like 3/report.pdf, directories are created on demand. */
function runFile(runId: string, relPath: string): File {
  const parts = relPath.split('/');
  const dir = new Directory(Paths.cache, 'runs', runId, ...parts.slice(0, -1));
  dir.create({ idempotent: true, intermediates: true });
  const file = new File(dir, parts[parts.length - 1]!);
  if (file.exists) file.delete();
  return file;
}

/** EXIF date "2026:10:22 09:00:00" -> milliseconds (device local time). */
function exifDate(exif: Record<string, unknown> | null | undefined): number | undefined {
  const raw = exif?.DateTimeOriginal ?? exif?.DateTime;
  const m =
    typeof raw === 'string' ? /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(raw) : null;
  if (!m) return undefined;
  const [, y, mo, d, h, mi, se] = m.map(Number) as number[];
  return new Date(y!, mo! - 1, d, h, mi, se).getTime();
}

function pickedPhoto(a: ImagePickerAsset): PickedFile {
  const ext = a.mimeType?.split('/')[1]?.replace('jpeg', 'jpg') ?? 'jpg';
  const takenAt = exifDate(a.exif);
  return {
    uri: a.uri,
    name: a.fileName ?? `photo-${Date.now()}.${ext}`,
    size: a.fileSize ?? null,
    mimeType: a.mimeType ?? null,
    width: a.width,
    height: a.height,
    // Read capture timestamp only (used for naming); other EXIF data (including location) is not saved.
    ...(takenAt !== undefined ? { takenAt } : {}),
  };
}

function pickedVideo(a: ImagePickerAsset): PickedFile {
  const ext =
    a.fileName?.split('.').pop()?.toLowerCase() ?? (a.mimeType === 'video/mp4' ? 'mp4' : 'mov');
  return {
    uri: a.uri,
    name: a.fileName ?? `video-${Date.now()}.${ext}`,
    size: a.fileSize ?? null,
    mimeType: a.mimeType ?? null,
    width: a.width,
    height: a.height,
    ...(a.duration ? { durationMs: a.duration } : {}),
  };
}

const SAVE_FORMATS: Record<ImageFormat, SaveFormat> = {
  jpeg: SaveFormat.JPEG,
  png: SaveFormat.PNG,
  webp: SaveFormat.WEBP,
};

const UTI: Record<string, string> = {
  'application/pdf': 'com.adobe.pdf',
  'text/csv': 'public.comma-separated-values-text',
  'image/jpeg': 'public.jpeg',
  'image/png': 'public.png',
  'application/zip': 'public.zip-archive',
  'text/plain': 'public.plain-text',
  'video/mp4': 'public.mpeg-4',
  'video/quicktime': 'com.apple.quicktime-movie',
  'audio/mp4': 'com.apple.m4a-audio',
};

const shareOne = (item: { uri: string; mimeType: string }) =>
  shareAsync(item.uri, {
    mimeType: item.mimeType,
    ...(UTI[item.mimeType] ? { UTI: UTI[item.mimeType] } : {}),
  });

/** Cache directory exposed by Android FileProvider (modules/morph-share/android/src/main/res/xml/morph_share_paths.xml). */
/** Cache directories exposed by Android FileProvider (modules/morph-share/android/src/main/res/xml/morph_share_paths.xml). */
const SHAREABLE_DIRS = ['runs/', 'preview/', 'share/'];

const SHARE: ShareDeps = {
  native: MorphShare,
  shareOne,
  shareable(uri) {
    if (Platform.OS !== 'android') return true;
    const cache = Paths.cache.uri.replace(/\/?$/, '/');
    return SHAREABLE_DIRS.some((dir) => uri.startsWith(cache + dir));
  },
  async stageCopy(uri, name, first) {
    const dir = new Directory(Paths.cache, 'share');
    // Keep only the copy for the current share operation.
    if (first && dir.exists) dir.delete();
    if (!dir.exists) dir.create({ intermediates: true });
    const target = new File(dir, name);
    // copy on Android is asynchronous: handing over to the share target before copying completes results in the file missing when opened by the recipient (Gmail "Failed to add attachment").
    await new File(uri).copy(target);
    return target.uri;
  },
  remembered: null,
  rememberedBy: new Map(),
  async pickFolder() {
    let dir: Directory;
    try {
      dir = await Directory.pickDirectoryAsync();
    } catch (e) {
      if (/CANCEL/i.test(String((e as { code?: string }).code))) return null;
      throw e;
    }
    return {
      name: dir.name,
      names() {
        try {
          return dir.list().map((entry) => entry.name);
        } catch {
          return [];
        }
      },
      async write(name, mimeType, sourceUri) {
        let file: File;
        try {
          file = dir.createFile(name, mimeType);
        } catch {
          throw Object.assign(new Error('folder not writable'), { code: FOLDER_NOT_WRITABLE });
        }
        await file.write(await new File(sourceUri).bytes());
      },
    };
  },
};

/** Maximum image side length (D-047): large enough for clear full-screen display without consuming excessive space. */
const MAX_IMAGE_SIDE = 2048;

let documents: FilePlatform['documents'] | null = null;

export const expoFilePlatform: FilePlatform = {
  // Android Word-to-PDF conversion requires htmlToPdf defined below, initialized on first use.
  get documents() {
    documents ??= expoDocuments(
      (runId, relPath) => runFile(runId, relPath).uri,
      (...args) => expoFilePlatform.htmlToPdf(...args),
    );
    return documents;
  },
  vision: expoVision((runId, relPath) => runFile(runId, relPath).uri),
  translator: expoTranslate(),
  media: expoMedia((runId, relPath) => runFile(runId, relPath).uri),
  background: expoBackground(),
  desk: expoDeskFs,
  // speech: createSpeech(MorphSpeech, { Android recognition models are located in downloaded content (D-151); iOS uses system recognition without needing downloaded content.
  speech: createSpeech(MorphSpeech, {
    isInstalled: (id) => speechPacks.isInstalled(id),
    uri: (id, file) => expoPackFs.uri(speechPacks.path(id, file)),
  }),
  speaker: createSpeaker(MorphTTS, (runId, relPath) => runFile(runId, relPath).uri),

  async pickImage(maxSide = MAX_IMAGE_SIDE) {
    const result = await launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: false,
      exif: false,
    });
    if (result.canceled || !result.assets[0]) return null;
    const picked = result.assets[0];
    // Reencode to JPEG: unify format (Android cannot display HEIC), downscale to max side maxSide,
    // and strip metadata such as location (D-047). Downscale during decoding (maxWidth /
    // maxHeight): decoding tens of megapixels of raw photos as-is takes hundreds of MB, causing
    // out-of-memory errors on Android.
    let image = await ImageManipulator.manipulate(picked.uri, {
      maxWidth: maxSide,
      maxHeight: maxSide,
    }).renderAsync();
    if (Math.max(image.width, image.height) > maxSide) {
      image = await ImageManipulator.manipulate(image)
        .resize(image.width >= image.height ? { width: maxSide } : { height: maxSide })
        .renderAsync();
    }
    const saved = await image.saveAsync({ compress: 0.82, format: SaveFormat.JPEG });
    const base = (picked.fileName ?? `photo-${Date.now()}`).replace(/\.[^.]+$/, '');
    return {
      uri: saved.uri,
      name: `${base}.jpg`,
      size: new File(saved.uri).size,
      mimeType: 'image/jpeg',
    };
  },

  fileUri: (path) => fileAt(path).uri,

  thumbnailUri(path) {
    const thumb = besideAsset(path, THUMB);
    return thumb.exists ? thumb.uri : null;
  },

  async saveAssetText(path, text) {
    const file = besideAsset(path, TEXT);
    // If the file has already been deleted (parent directory does not exist), do not write.
    if (!file.parentDirectory.exists) return;
    file.write(text);
  },

  async assetText(path) {
    const file = besideAsset(path, TEXT);
    return file.exists ? await file.text() : null;
  },

  async importFile(file, assetId, name) {
    const dir = assetDir(assetId);
    const dest = new File(dir, name);
    // Native copy with streaming read/write, avoiding loading large files into JS memory (file
    // entry D-257 might be a multi-GB video). Leaves no partial file on copy failure (insufficient
    // space, read error).
    try {
      await new File(file.uri).copy(dest);
    } catch (e) {
      if (dir.exists) dir.delete();
      throw e;
    }
    await makePdfThumbnail(dest, dir);
    return { path: `${ROOT}/${assetId}/${name}`, size: dest.size };
  },

  async contentDigest(uri) {
    // File.digest is native (iOS 64 KB chunks, Android similarly), but it is not declared in expo-file-system 58 types.
    const file = new File(uri) as File & { digest(algorithm: 'SHA-256'): Promise<string> };
    return file.digest('SHA-256');
  },

  async removeAssetFile(path) {
    // Delete only the assets/<id>/ directory layer: user files are stored in their own directories (importFile, writeBytes, saveRunFile).
    const [root, id] = path.split('/');
    if (root !== ROOT || !id || id === '.' || id === '..') return;
    const dir = new Directory(Paths.document, ROOT, id);
    if (dir.exists) dir.delete();
  },

  readBytes: (path) => fileAt(path).bytes(),

  async writeBytes(assetId, name, bytes) {
    const dest = new File(assetDir(assetId), name);
    await dest.write(bytes);
    return { path: `${ROOT}/${assetId}/${name}`, size: dest.size };
  },

  async readPickedText(uri) {
    const file = new File(uri);
    try {
      return await file.text();
    } finally {
      // Delete only copies placed in cache by selectors; do not touch items outside cache (originals, content://).
      if (uri.startsWith(Paths.cache.uri) && uri.includes('/DocumentPicker/')) {
        try {
          file.delete();
        } catch {
          // Already gone.
        }
      }
    }
  },

  async shareText(fileName, text, mimeType) {
    const dir = new Directory(Paths.cache, 'exports');
    dir.create({ idempotent: true, intermediates: true });
    const file = new File(dir, fileName);
    if (file.exists) file.delete();
    file.create();
    await file.write(text);
    await shareAsync(file.uri, {
      mimeType,
      ...(mimeType === 'text/csv' ? { UTI: 'public.comma-separated-values-text' } : {}),
    });
  },

  async shareWithAi({ file, prompt, pointer }) {
    const send = MorphShare?.shareFilesWithText?.bind(MorphShare);
    if (!send) {
      // Expo Go, dev builds older than this feature: send text only, with app files appended afterward.
      await Share.share({
        message:
          prompt({ attached: false, checker: false }) +
          (file ? `\n\n\`\`\`json\n${file.text}\n\`\`\`` : ''),
      });
      return;
    }
    // Stored in cache share/: exposed exclusively by Android's FileProvider (D-466); cleared before each share operation.
    const dir = new Directory(Paths.cache, 'share');
    if (dir.exists) dir.delete();
    dir.create({ intermediates: true, idempotent: true });
    const uris: string[] = [];
    const types: string[] = [];
    if (file) {
      const app = new File(dir, file.name);
      app.create();
      await app.write(file.text);
      uris.push(app.uri);
      types.push('application/json');
    }
    let checker = false;
    try {
      // Checker packaged into the app during prebuild (plugins/with-agent-checker.js); omitted if absent (older dev builds).
      const copy = new File(dir, CHECKER_FILE_NAME);
      await new File(Paths.bundle, 'agent', CHECKER_FILE_NAME).copy(copy);
      uris.push(copy.uri);
      types.push('application/javascript');
      checker = true;
    } catch (e) {
      if (__DEV__) console.warn('[share] no bundled checker', e);
    }
    let docs = false;
    try {
      const copies: string[] = [];
      for (const name of HANDOFF_DOC_FILES) {
        const copy = new File(dir, name);
        await new File(Paths.bundle, 'agent', name).copy(copy);
        copies.push(copy.uri);
      }
      uris.push(...copies);
      types.push(...copies.map(() => 'text/plain'));
      docs = true;
    } catch (e) {
      // When older dev builds lack the guide, prompt falls back to the URL with the current date version, without claiming attachments.
      if (__DEV__) console.warn('[share] no bundled guide', e);
    }
    // Makes the prompt the first attachment: Claude drops shared text when receiving multiple files
    // (on-device 2026-11-23), but attachments are never lost; the shared text merely points to it,
    // remaining visible in text-accepting apps like ChatGPT.
    const request = new File(dir, HANDOFF_REQUEST_FILE);
    request.create();
    await request.write(prompt({ attached: file !== undefined, checker, docs }));
    await send(pointer, [request.uri, ...uris], ['text/markdown', ...types]);
  },

  async share(path, mimeType) {
    await shareOne({ uri: fileAt(path).uri, mimeType });
  },

  async pickMedia(max) {
    const result = await launchImageLibraryAsync({
      mediaTypes: ['images', 'videos'],
      allowsMultipleSelection: max > 1,
      selectionLimit: max,
      orderedSelection: true,
      exif: true,
      videoExportPreset: VideoExportPreset.Passthrough,
      preferredAssetRepresentationMode: UIImagePickerPreferredAssetRepresentationMode.Current,
      shouldDownloadFromNetwork: true,
    });
    if (result.canceled) return null;
    return result.assets.map((a) => (a.type === 'video' ? pickedVideo(a) : pickedPhoto(a)));
  },

  async pickPhotos(max) {
    const result = await launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: max > 1,
      selectionLimit: max,
      orderedSelection: true,
      exif: true,
    });
    if (result.canceled) return null;
    return result.assets.map(pickedPhoto);
  },

  async pickVideos(max) {
    const result = await launchImageLibraryAsync({
      mediaTypes: ['videos'],
      allowsMultipleSelection: max > 1,
      selectionLimit: max,
      orderedSelection: true,
      // Keep video as-is (do not transcode HEVC), otherwise large videos cause the user to wait for system transcoding during selection (D-142).
      videoExportPreset: VideoExportPreset.Passthrough,
      preferredAssetRepresentationMode: UIImagePickerPreferredAssetRepresentationMode.Current,
      shouldDownloadFromNetwork: true,
    });
    if (result.canceled) return null;
    return result.assets.map(pickedVideo);
  },

  async takePhoto() {
    // When the camera is unavailable in dev builds (simulators), the system picker throws a native exception crashing the app, which cannot be caught by the catch block below.
    if (MorphVision && !MorphVision.isCameraAvailable()) throw new RunError('cameraUnavailable');
    const permission = await requestCameraPermissionsAsync();
    if (!permission.granted) throw new RunError('permissionDenied', { what: 'camera' });
    let result;
    try {
      result = await launchCameraAsync({ mediaTypes: ['images'], exif: true });
    } catch {
      // Simulator has no camera.
      throw new RunError('cameraUnavailable');
    }
    if (result.canceled || !result.assets[0]) return null;
    return pickedPhoto(result.assets[0]);
  },

  async pickDocuments(types, multiple, inPlace = false) {
    const result = await getDocumentAsync({
      type: [...types],
      multiple,
      copyToCacheDirectory: !inPlace,
    });
    if (result.canceled) return null;
    return result.assets.map((a) => ({
      uri: a.uri,
      name: a.name,
      size: a.size ?? null,
      mimeType: a.mimeType ?? null,
      // Used for date filtering (D-242); some providers return 0, treated as absent.
      ...(a.lastModified > 0 ? { modifiedAt: a.lastModified } : {}),
    }));
  },

  async copyToRun(uri, runId, fileName) {
    const dest = runFile(runId, fileName);
    await new File(uri).copy(dest);
    return { uri: dest.uri, size: dest.size };
  },

  async removeRunFile(uri) {
    // Delete only files in the run directory (do not touch user originals or copies shared in).
    if (!uri.startsWith(new Directory(Paths.cache, 'runs').uri)) return;
    const file = new File(uri);
    if (file.exists) file.delete();
  },

  async writeRunFile(runId, fileName, bytes) {
    const dest = runFile(runId, fileName);
    dest.create();
    await dest.write(bytes);
    // Size may still be 0 right after writing, so use byte length directly.
    return { uri: dest.uri, size: bytes.length };
  },

  async adoptIntoRun(uri, runId, fileName, keepSource = false) {
    const source = new File(uri);
    // Copies placed in cache by selectors: move into the temporary directory for this run, and delete together upon run completion.
    if (!keepSource && uri.startsWith(Paths.cache.uri) && source.exists) {
      // Read size before moving: File objects at the new path after move may still read as 0.
      const size = source.size;
      const dest = runFile(runId, fileName);
      source.move(dest);
      return { uri: dest.uri, size };
    }
    // Files shared in (shared directory, content://): used in place without copying (deletion handled separately by D-116).
    let size = 0;
    try {
      size = source.size;
    } catch {
      // content:// size may not be readable, to be populated later by probe.
    }
    return { uri, size };
  },

  freeDiskBytes() {
    try {
      return Paths.availableDiskSpace;
    } catch {
      return null;
    }
  },

  readUri: (uri) => new File(uri).bytes(),

  async removeRun(runId) {
    const dir = new Directory(Paths.cache, 'runs', runId);
    if (dir.exists) dir.delete();
  },

  async removeAllRuns() {
    const dir = new Directory(Paths.cache, 'runs');
    if (dir.exists) dir.delete();
  },

  async removeShared(keep = [], copies = []) {
    // Share extensions copy files to the top level of the App Group shared directory with names
    // formatted as UUID.extension. Delete only these files: the shared directory also contains
    // system files (such as container metadata; deleting them causes the system to rebuild the
    // entire directory) and Library subdirectories.
    const keepNames = new Set(keep.map((uri) => uri.split('/').pop()));
    for (const container of Object.values(Paths.appleSharedContainers ?? {})) {
      for (const entry of container.list()) {
        if (entry instanceof File && SHARED_COPY.test(entry.name) && !keepNames.has(entry.name)) {
          entry.delete();
        }
      }
    }
    for (const uri of copies) {
      const copy = new File(uri);
      if (copy.uri.startsWith(Paths.cache.uri) && copy.exists) copy.delete();
    }
    // The copy placed in cache preview/ by MorphShare during Android previews (D-238); deleted together when this batch is released.
    const preview = new Directory(Paths.cache, 'preview');
    if (preview.exists) preview.delete();
  },

  async removePickedCopies(uris) {
    const runs = new Directory(Paths.cache, 'runs').uri;
    for (const uri of uris) {
      if (!uri.startsWith(Paths.cache.uri) || uri.startsWith(runs)) continue;
      const copy = new File(uri);
      if (copy.exists) copy.delete();
    }
  },

  async removeStalePickerCopies() {
    // expo-image-picker and expo-document-picker (58.x) copy selected files to these two folders under the cache directory.
    for (const name of ['ImagePicker', 'DocumentPicker']) {
      const dir = new Directory(Paths.cache, name);
      if (dir.exists) dir.delete();
    }
  },

  async saveRunFile(uri, assetId, name) {
    const dir = assetDir(assetId);
    const dest = new File(dir, name);
    await new File(uri).copy(dest);
    await makePdfThumbnail(dest, dir);
    return { path: `${ROOT}/${assetId}/${name}`, size: dest.size };
  },

  shareUris: (items) => shareAll(SHARE, items),

  saveToFolder: (items, key, choose = false) => saveAllToFolder(SHARE, items, key, choose),

  rememberedFolder: (key) => rememberedFolder(SHARE, key),
  previewFile: (item) => previewFile(SHARE, item),
  forgetFolders: (keep) => forgetFolders(SHARE, keep),

  async saveToPhotos(uris) {
    const permission = await requestPermissionsAsync(true, ['photo', 'video']);
    if (!permission.granted) throw new RunError('permissionDenied', { what: 'photos' });
    for (const uri of uris) await Asset.create(uri);
  },

  async print(item) {
    if (item.mimeType === 'application/pdf') {
      await printAsync({ uri: item.uri });
      return;
    }
    // Images: local files cannot be referenced inside WKWebView, inline as data URIs (open-tool-research #17).
    const base64 = await new File(item.uri).base64();
    await printAsync({
      html: `<html><body style="margin:0"><img style="width:100%" src="data:${item.mimeType};base64,${base64}"></body></html>`,
    });
  },

  async copyText(text) {
    await setStringAsync(text);
  },

  async readClipboardText() {
    return getStringAsync();
  },

  async loadSignatures() {
    const dir = new Directory(Paths.document, 'signatures');
    if (!dir.exists) return [];
    const files = dir
      .list()
      .filter((e): e is File => e instanceof File && e.name.endsWith('.png'))
      .sort((a, b) => (b.modificationTime ?? 0) - (a.modificationTime ?? 0))
      .slice(0, 3);
    return Promise.all(
      files.map(async (f) => ({
        uri: f.uri,
        bytes: await f.bytes(),
        aspect: Number(/_(\d+(?:\.\d+)?)\.png$/.exec(f.name)?.[1] ?? 3),
      })),
    );
  },

  async saveSignature(png, aspect) {
    const dir = new Directory(Paths.document, 'signatures');
    dir.create({ idempotent: true, intermediates: true });
    // Keep at most 3: delete the oldest.
    const old = dir
      .list()
      .filter((e): e is File => e instanceof File)
      .sort((a, b) => (b.modificationTime ?? 0) - (a.modificationTime ?? 0));
    for (const f of old.slice(2)) f.delete();
    const file = new File(dir, `${Date.now()}_${aspect.toFixed(3)}.png`);
    file.create();
    await file.write(png);
  },

  async renderText(text, style) {
    return renderTextPng(text, style);
  },

  async enhanceImage(uri, mode, runId, relPath) {
    const out = enhanceJpeg(await new File(uri).bytes(), mode);
    const dest = runFile(runId, relPath);
    dest.create();
    await dest.write(out.bytes);
    return {
      uri: dest.uri,
      width: out.width,
      height: out.height,
      size: out.bytes.length,
      skew: out.skew,
      base: out.base,
    };
  },

  async composeImage(canvas, ops, save, runId, relPath) {
    const out = await composeOnSurface(canvas, ops, save, (uri) => new File(uri).bytes());
    const dest = runFile(runId, relPath);
    dest.create();
    await dest.write(out.bytes);
    return { uri: dest.uri, width: out.width, height: out.height, size: out.bytes.length };
  },

  async imagePixels(uri, maxSide) {
    return pixelsOf(await new File(uri).bytes(), maxSide);
  },

  async reducedJpeg(uri, maxSide, quality, runId, relPath) {
    let image = await ImageManipulator.manipulate(uri, {
      maxWidth: maxSide,
      maxHeight: maxSide,
    }).renderAsync();
    if (Math.max(image.width, image.height) > maxSide) {
      image = await ImageManipulator.manipulate(image)
        .resize(image.width >= image.height ? { width: maxSide } : { height: maxSide })
        .renderAsync();
    }
    const saved = await image.saveAsync({ compress: quality, format: SaveFormat.JPEG });
    const dest = runFile(runId, relPath);
    await new File(saved.uri).move(dest);
    return {
      uri: dest.uri,
      width: saved.width,
      height: saved.height,
      size: new File(dest.uri).size,
    };
  },

  async htmlToPdf(html, page, runId, relPath, margins) {
    // iOS print layout ignores CSS @page margins, so they must be specified here (in points).
    const printed = await printToFileAsync({
      html,
      width: page.width,
      height: page.height,
      margins: margins ?? { left: 44, right: 44, top: 40, bottom: 40 },
    });
    const dest = runFile(runId, relPath);
    await new File(printed.uri).move(dest);
    return { uri: dest.uri, size: new File(dest.uri).size, pageCount: printed.numberOfPages };
  },

  async imageSize(uri) {
    const image = await ImageManipulator.manipulate(uri).renderAsync();
    return { width: image.width, height: image.height };
  },

  async transformImage(uri, ops, save, runId, relPath) {
    const context = ImageManipulator.manipulate(uri);
    if (ops.crop) {
      context.crop({
        originX: Math.round(ops.crop.x),
        originY: Math.round(ops.crop.y),
        width: Math.round(ops.crop.width),
        height: Math.round(ops.crop.height),
      });
    }
    if (ops.resize) context.resize({ width: ops.resize.width, height: ops.resize.height });
    if (ops.rotate) context.rotate(ops.rotate);
    if (ops.flip) context.flip(ops.flip === 'horizontal' ? FlipType.Horizontal : FlipType.Vertical);
    const image = await context.renderAsync();
    const saved = await image.saveAsync({
      compress: save.quality,
      format: SAVE_FORMATS[save.format],
    });
    const dest = runFile(runId, relPath);
    await new File(saved.uri).move(dest);
    return {
      uri: dest.uri,
      width: saved.width,
      height: saved.height,
      size: new File(dest.uri).size,
    };
  },
};
