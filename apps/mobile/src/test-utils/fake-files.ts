import { createHash } from 'node:crypto';

import { RunError } from '@morph/core';
import { zlibSync } from 'fflate';
import { PDFDocument } from 'pdf-lib';

import { rotatedSize, type Quad } from '@morph/tool-image';
import type { LayoutRegion } from '@morph/tool-office';

import type { DeskFs } from '../desk/fs';

import type {
  AudioEncode,
  BackgroundPlatform,
  Box,
  DocumentPlatform,
  DrawOp,
  FilePlatform,
  Pixels,
  RecognizedLayer,
  FolderItem,
  ImageFormat,
  ImageOps,
  MediaInfo,
  MediaJob,
  MediaOutput,
  MediaPlatform,
  PdfPasswordPlatform,
  PickedFile,
  SpeakErrorCode,
  SpeakPlatform,
  SpeakRequest,
  TranslatePlatform,
  VideoEncode,
  VisionPlatform,
} from '../runtime/platform';
import {
  SpeechError,
  type SpeechErrorCode,
  type SpeechNeed,
  type SpeechPlatform,
  type TranscribeRequest,
} from '../runtime/speech';

// Test utility: in-memory file platform and real PDF generation.

export async function makePdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([200 + i, 300]);
  return doc.save();
}

/** A real 60x40 JPEG (test asset for tool-pdf), with the fake encoder padding zeros to the target size. */
export const TINY_JPEG = Uint8Array.from(
  atob(
    '/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAPKADAAQAAAABAAAAKAAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAKAA8AwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICBAICBAYEBAQGCAYGBgYICggICAgICgwKCgoKCgoMDAwMDAwMDA4ODg4ODhAQEBAQEhISEhISEhISEv/bAEMBAwMDBQQFCAQECBMNCw0TExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTE//dAAQABP/aAAwDAQACEQMRAD8A/H608O/7NdTaeHf9mvT7Tw7/ALNdRaeHf9mv3PE5z5nzOS8Q7anmFn4d6fLXU2fh3p8ten2nh3p8tdTZ+Heny14OJzrzP1vJeIdtTzCz8O/7NdTaeHf9mvT7Pw70+WuotPDv+zXgYnOfM/W8l4h21PMLTw7/ALNdFF4d+T7terWnh3/Zroo/Dvy/drwq+da7n6tlfEPubn//0Pm608O/7NdRaeHf9mvT7Tw7/s11Np4d/wBmvZxOdeZ/M+S8QbanmFp4d6fLXU2nh3p8ten2nh3/AGa6iz8O9PlrwcTnXmfreS8QbanmFp4d6fLXU2nh3p8ten2fh3p8tdTZ+Hf9mvAxOdeZ+t5LxBtqeYWnh3/Zroo/Dvyfdr1W08O/7NdFH4d+X7teFXznXc/Vsr4g9zc//9H1608O9PlrqbTw7/s1bs+1dTadq+MxOKqdz+B8lxtXTUp2nh3/AGa6m08O9Plq5aV1FpXg4nFVO5+t5LjaumpUtPDvT5a6iz8O9Plq5Z9a6i07V4GJxVTufreS42rpqVLTw70+Wuij8O/L92tKz7V0cf3BXhV8VUvufq2V42rybn//2Q==',
  ),
  (c) => c.charCodeAt(0),
);

/** A real, solid-gray PNG (embeddable by pdf-lib). */
export function makePng(width: number, height: number): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Uint8Array) => {
    let c = 0xffffffff;
    for (const b of bytes) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(
      [...type].map((c) => c.charCodeAt(0)),
      4,
    );
    out.set(data, 8);
    view.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
    return out;
  };
  const header = new Uint8Array(13);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  header.set([8, 0, 0, 0, 0], 8); // 8-bit grayscale
  const raw = new Uint8Array((width + 1) * height).fill(128);
  for (let y = 0; y < height; y++) raw[y * (width + 1)] = 0;
  const parts = [
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlibSync(raw)),
    chunk('IEND', new Uint8Array()),
  ];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    png.set(p, offset);
    offset += p.length;
  }
  return png;
}

/** In-memory "file system". */
/**
 * In-memory implementation of the desk directory (D-357): shares a disk with FakeFiles, with
 * paths under desk/<path> (directly readable at runtime). Originals (picker://, content://,
 * file:///group/) can only be copied; moving is only for files in the runs/ runtime directory.
 */
export class FakeDeskFs implements DeskFs {
  constructor(private readonly files: FakeFiles) {}
  /** Original path for each move (tests check that originals were not moved away). */
  moved: string[] = [];
  uri = (path: string) => `desk/${path}`;
  isRunFile = (uri: string) => uri.startsWith('runs/');
  pathOf = (uri: string) => (uri.startsWith('desk/') ? uri.slice('desk/'.length) : null);
  async copyIn(uri: string, path: string) {
    // User file URLs (fileUri) can also be copied in (record attachments placed on the desk, D-395).
    const bytes =
      this.files.disk.get(uri) ?? this.files.disk.get(uri.replace(/^file:\/\/\/fake\//, ''));
    if (!bytes) throw new Error(`missing ${uri}`);
    this.files.disk.set(this.uri(path), bytes);
    const size = this.files.imageSizes.get(uri);
    if (size) this.files.imageSizes.set(this.uri(path), size);
    return bytes.length;
  }
  async moveIn(uri: string, path: string) {
    if (!this.isRunFile(uri)) throw new Error(`only run files can be moved: ${uri}`);
    const size = await this.copyIn(uri, path);
    this.files.disk.delete(uri);
    this.moved.push(uri);
    return size;
  }
  async writeText(path: string, text: string) {
    return this.writeBytes(path, new TextEncoder().encode(text));
  }
  async writeBytes(path: string, bytes: Uint8Array) {
    this.files.disk.set(this.uri(path), bytes);
    return bytes.length;
  }
  async readText(path: string) {
    const bytes = this.files.disk.get(this.uri(path));
    return bytes ? new TextDecoder().decode(bytes) : null;
  }
  async rename(from: string, to: string) {
    const bytes = this.files.disk.get(this.uri(from));
    if (!bytes) throw new Error(`missing ${from}`);
    this.files.disk.set(this.uri(to), bytes);
    this.files.disk.delete(this.uri(from));
  }
  async remove(paths: readonly string[]) {
    for (const path of paths) this.files.disk.delete(this.uri(path));
  }
  async removeDesk(deskId: string) {
    for (const key of [...this.files.disk.keys()])
      if (key.startsWith(`desk/${deskId}/`)) this.files.disk.delete(key);
  }
  async list() {
    const ids = new Set<string>();
    for (const key of this.files.disk.keys())
      if (key.startsWith('desk/')) ids.add(key.split('/')[1]!);
    return [...ids];
  }
}

export class FakeFiles implements FilePlatform {
  disk = new Map<string, Uint8Array>();
  /** File room desk directory (D-357). */
  desk = new FakeDeskFs(this);
  /** Office document to PDF conversion: defaults to Android behavior, converting only .docx (iOS tests switch to all formats). */
  documents: FakeDocuments = new FakeDocuments(this);
  /** System OCR and scanning: defaults to none (like Android / Expo Go), replaced with FakeVision in tests. */
  vision: VisionPlatform | null = null;
  /** System translation: defaults to none (like Expo Go), replaced with FakeTranslator in tests. */
  translator: TranslatePlatform | null = null;
  /** Video processing: available by default (like dev builds), set to null when testing Expo Go. */
  media: MediaPlatform | null = new FakeMedia(this);
  /** Speech to text: defaults to none (like Expo Go), replaced with FakeSpeech in tests. */
  speech: SpeechPlatform | null = null;
  /** System text-to-speech (D-270): defaults to none (like Expo Go), replaced with FakeSpeaker in tests. */
  speaker: SpeakPlatform | null = null;
  /** Background continuation (D-160): defaults to none (like Expo Go), replaced with FakeBackground in tests. */
  background: BackgroundPlatform | null = null;
  /** Result of the next video selection from the photo library. */
  nextVideos: PickedFile[] | null = null;
  /** Remaining phone storage space in bytes; null means unreadable. */
  freeBytes: number | null = 64 * 1024 * 1024 * 1024;
  /** Files "moved in" during this run (videos and audio are not copied, D-142). */
  adopted: string[] = [];
  /** Result of the next file pick ("Files" app). */
  nextPick: PickedFile[] | null = null;
  /** Result of the next multi-selection from the photo library. */
  nextPhotos: PickedFile[] | null = null;
  /** Photos captured in sequence; null indicates user cancellation. */
  camera: (PickedFile | null)[] = [];
  cameraAvailable = true;
  photosAllowed = true;
  /** Types requested during the most recent file pick. */
  lastPickTypes: readonly string[] = [];
  shared: string[] = [];
  savedToPhotos: string[] = [];
  printed: string[] = [];
  clipboard = '';
  nextImage: PickedFile | null = null;
  /** Longest side requested for each photo selection. */
  imageSides: (number | undefined)[] = [];
  async pickImage(maxSide?: number) {
    this.imageSides.push(maxSide);
    return this.nextImage;
  }
  nextMedia: PickedFile[] | null = null;
  async pickMedia(max: number) {
    return this.nextMedia ? this.nextMedia.slice(0, max) : null;
  }
  async pickPhotos(max: number) {
    return this.nextPhotos ? this.nextPhotos.slice(0, max) : null;
  }
  async pickVideos(max: number) {
    return this.nextVideos ? this.nextVideos.slice(0, max) : null;
  }
  async adoptIntoRun(uri: string, runId: string, fileName: string, keepSource = false) {
    // User file URLs (fileUri) are also supported: used in place without moving (D-442).
    const bytes = this.disk.get(uri) ?? this.disk.get(uri.replace('file:///fake/', ''));
    if (!bytes) throw new Error('permission denied');
    this.adopted.push(uri);
    // Picker copies (picker://) and temporary runtime files are moved in; shared files are used in place.
    if (!keepSource && (uri.startsWith('picker://') || uri.startsWith('runs/'))) {
      const dest = `runs/${runId}/${fileName}`;
      this.disk.delete(uri);
      this.disk.set(dest, bytes);
      const info = this.videos.get(uri);
      if (info) this.videos.set(dest, info);
      return { uri: dest, size: bytes.length };
    }
    return { uri, size: bytes.length };
  }
  freeDiskBytes() {
    return this.freeBytes;
  }
  /** Fake video metadata (uri -> duration, dimensions, has audio). */
  videos = new Map<string, MediaInfo>();
  /** Provide a "user-selectable" fake video; byte count is its size (content does not matter). */
  offerVideo(
    name: string,
    opts: Partial<MediaInfo> & { size: number },
    mimeType = 'video/quicktime',
  ): PickedFile {
    const picked = this.offer(name, new Uint8Array(opts.size), mimeType);
    const info: MediaInfo = {
      kind: 'video',
      durationMs: 60_000,
      hasVideo: true,
      hasAudio: true,
      width: 1920,
      height: 1080,
      videoBitrateKbps: 15_000,
      ...opts,
    };
    this.videos.set(picked.uri, info);
    return { ...picked, durationMs: info.durationMs, width: info.width!, height: info.height! };
  }
  /** Provide a selectable fake audio file in "Files"; byte count is its size. */
  offerAudio(
    name: string,
    opts: Partial<MediaInfo> & { size: number },
    mimeType = 'audio/mp4',
  ): PickedFile {
    const picked = this.offer(name, new Uint8Array(opts.size), mimeType);
    const info: MediaInfo = {
      kind: 'audio',
      durationMs: 60_000,
      hasVideo: false,
      hasAudio: true,
      audioBitrateKbps: 128,
      channels: 2,
      sampleRate: 44100,
      ...opts,
    };
    this.videos.set(picked.uri, info);
    return { ...picked, durationMs: info.durationMs };
  }
  async takePhoto() {
    if (!this.cameraAvailable) {
      throw new RunError('cameraUnavailable');
    }
    return this.camera.shift() ?? null;
  }
  /** Whether the most recent file pick was "read in place without copying into cache" (full restore archive selection, D-600). */
  lastPickInPlace = false;
  async pickDocuments(types: readonly string[], _multiple?: boolean, inPlace = false) {
    this.lastPickTypes = types;
    this.lastPickInPlace = inPlace;
    return this.nextPick;
  }
  fileUri(path: string) {
    return `file:///fake/${path}`;
  }
  /** PDF first-page thumbnails (D-451): populated by path in tests; generated by the real platform when stored into user files. */
  thumbnails_: Map<string, string> = new Map();
  thumbnailUri(path: string) {
    return this.thumbnails_.get(path) ?? null;
  }
  /** Text inside files (D-455): stored in memory by path. */
  texts: Map<string, string> = new Map();
  async saveAssetText(path: string, text: string) {
    this.texts.set(path, text);
  }
  async assetText(path: string) {
    return this.texts.get(path) ?? null;
  }
  async importFile(file: PickedFile, assetId: string, name: string) {
    const bytes = this.disk.get(file.uri);
    if (!bytes) throw new Error('permission denied');
    const path = `assets/${assetId}/${name}`;
    this.disk.set(path, bytes);
    return { path, size: bytes.length };
  }
  async removeAssetFile(path: string) {
    const [root, id] = path.split('/');
    if (root !== 'assets' || !id) return;
    for (const key of [...this.disk.keys()])
      if (key.startsWith(`assets/${id}/`)) this.disk.delete(key);
  }
  async readBytes(path: string) {
    // On real devices, readBytes reads relative paths in the "Documents" directory; runtime directories are in cache and must be read with readUri.
    if (path.startsWith('runs/') || path.includes(':'))
      throw new Error(`not a document path: ${path}`);
    const bytes = this.disk.get(path);
    if (!bytes) throw new Error('missing');
    return bytes;
  }
  async writeBytes(assetId: string, name: string, bytes: Uint8Array) {
    const path = `assets/${assetId}/${name}`;
    this.disk.set(path, bytes);
    return { path, size: bytes.length };
  }
  async share(path: string) {
    this.shared.push(path);
  }
  /** Text files provided by pickers: URL -> content; read copies are recorded in readPicked. */
  pickedTexts = new Map<string, string>();
  readPicked: string[] = [];
  async readPickedText(uri: string) {
    this.readPicked.push(uri);
    const text = this.pickedTexts.get(uri);
    if (text === undefined) throw new Error('permission denied');
    return text;
  }
  /** Exported text files: filename -> content. */
  sharedTexts = new Map<string, string>();
  async shareText(fileName: string, text: string) {
    this.sharedTexts.set(fileName, text);
  }
  /** Shared with other AI apps (D-611): includes validator, app files are attachments. */
  aiShares: { text: string; request: string; files: { name: string; text: string }[] }[] = [];
  async shareWithAi(input: {
    file?: { name: string; text: string };
    prompt: (how: { attached: boolean; checker: boolean; docs?: boolean }) => string;
    pointer: string;
  }) {
    this.aiShares.push({
      // The shared text only points to tinkrum-request.md, while the prompt itself resides inside that file.
      text: input.pointer,
      request: input.prompt({ attached: input.file !== undefined, checker: true, docs: true }),
      files: [
        ...(input.file ? [input.file] : []),
        { name: 'tinkrum-check.js', text: '// checker' },
        { name: 'tinkrum-app-guide.md', text: '# guide' },
        { name: 'tinkrum-app-patterns.md', text: '# patterns' },
      ],
    });
  }
  async copyToRun(uri: string, runId: string, fileName: string) {
    // User file URLs (fileUri) can also be copied in, e.g., "add existing files" (D-197).
    const bytes = this.disk.get(uri) ?? this.disk.get(uri.replace('file:///fake/', ''));
    if (!bytes) throw new Error('permission denied');
    const dest = `runs/${runId}/${fileName}`;
    this.disk.set(dest, bytes);
    const size = this.imageSizes.get(uri);
    if (size) this.imageSizes.set(dest, size);
    return { uri: dest, size: bytes.length };
  }
  async writeRunFile(runId: string, fileName: string, bytes: Uint8Array) {
    const dest = `runs/${runId}/${fileName}`;
    this.disk.set(dest, bytes);
    return { uri: dest, size: bytes.length };
  }
  async removeRunFile(uri: string) {
    if (uri.startsWith('runs/')) this.disk.delete(uri);
  }
  async contentDigest(uri: string) {
    return createHash('sha256')
      .update(await this.readUri(uri))
      .digest('hex');
  }
  async readUri(uri: string) {
    // User file URLs (fileUri) correspond to relative paths on disk.
    const bytes = this.disk.get(uri) ?? this.disk.get(uri.replace(/^file:\/\/\/fake\//, ''));
    if (!bytes) throw new Error('missing');
    return bytes;
  }
  async removeRun(runId: string) {
    for (const key of [...this.disk.keys()]) {
      if (key.startsWith(`runs/${runId}/`)) this.disk.delete(key);
    }
  }
  async removeAllRuns() {
    for (const key of [...this.disk.keys()]) if (key.startsWith('runs/')) this.disk.delete(key);
  }
  async removeShared(keep: readonly string[] = [], copies: readonly string[] = []) {
    for (const key of [...this.disk.keys()]) {
      if (key.startsWith('file:///group/') && !keep.includes(key)) this.disk.delete(key);
    }
    for (const uri of copies) this.disk.delete(uri);
  }
  async removePickedCopies(uris: readonly string[]) {
    for (const uri of uris) if (uri.startsWith('picker://')) this.disk.delete(uri);
  }
  async removeStalePickerCopies() {
    for (const key of [...this.disk.keys()]) if (key.startsWith('picker://')) this.disk.delete(key);
  }
  async saveRunFile(uri: string, assetId: string, name: string) {
    return this.writeBytes(assetId, name, await this.readUri(uri));
  }
  /** Files attached during each share sheet opening. */
  shareSheets: string[][] = [];
  /** Filenames visible to the user during each share (D-466). */
  shareNames: (string | undefined)[][] = [];
  async shareUris(items: readonly { uri: string; name?: string }[]) {
    this.shareSheets.push(items.map((i) => i.uri));
    this.shareNames.push(items.map((i) => i.name));
    this.shared.push(...items.map((i) => i.uri));
  }
  /** User action for the next folder selection: pick, cancel, non-writable folder selected (non-writability also applies to remembered folders). */
  folderChoice: 'pick' | 'cancel' | 'notWritable' | 'saveFailed' = 'pick';
  /** Folder name selected by the user in the picker. */
  nextFolder = 'MorphOut';
  /** Last selected folder (D-123). */
  remembered: string | null = null;
  /** Folder remembered by each quick action (D-196): quick action ID -> folder name. */
  rememberedBy = new Map<string, string>();
  /** Number of times the folder picker was opened. */
  folderPicks = 0;
  /** Files in each folder: folder name -> filename -> content. */
  folders = new Map<string, Map<string, Uint8Array>>();
  async saveToFolder(items: readonly FolderItem[], key: string, choose = false) {
    const kept = choose ? null : (this.rememberedBy.get(key) ?? this.remembered);
    let folder = kept;
    if (!folder) {
      this.folderPicks++;
      if (this.folderChoice === 'cancel') return null;
      folder = this.nextFolder;
    }
    if (this.folderChoice === 'notWritable') throw new RunError('folderNotWritable');
    if (this.folderChoice === 'saveFailed')
      throw new RunError('saveFailed', { detail: 'disk full' });
    if (!kept) this.remembered = folder;
    this.rememberedBy.set(key, folder);
    const files = this.folders.get(folder) ?? new Map<string, Uint8Array>();
    this.folders.set(folder, files);
    for (const item of items) {
      files.set(`${item.name}.${item.ext}`, await this.readUri(item.uri));
    }
    return { saved: items.length, folder };
  }
  rememberedFolder(key: string) {
    return this.rememberedBy.get(key) ?? this.remembered;
  }
  forgetFolders(keep: readonly string[]) {
    for (const key of [...this.rememberedBy.keys()]) {
      if (!keep.includes(key)) this.rememberedBy.delete(key);
    }
  }
  async saveToPhotos(uris: readonly string[]) {
    if (!this.photosAllowed) {
      throw new RunError('permissionDenied', { what: 'photos' });
    }
    this.savedToPhotos.push(...uris);
  }
  /** Files opened via system preview (D-238). */
  previewed: { uri: string; mimeType: string }[] = [];
  /** When true, preview reports "No app found to open this file". */
  previewFails = false;
  async previewFile(item: { uri: string; mimeType: string }) {
    if (this.previewFails) throw new RunError('noViewer');
    this.previewed.push({ uri: item.uri, mimeType: item.mimeType });
  }
  async print(item: { uri: string }) {
    this.printed.push(item.uri);
  }
  async copyText(text: string) {
    this.clipboard = text;
  }
  async readClipboardText() {
    return this.clipboard;
  }
  /** Fake image dimensions (uri -> width and height). */
  imageSizes = new Map<string, { width: number; height: number }>();
  /** Minimum byte count of encoded output (simulating images that cannot be compressed further). */
  minEncodedBytes = 200;
  /** Record of each encoding operation, for assertions. */
  encodes: {
    ops: ImageOps;
    format: ImageFormat;
    quality: number;
    width: number;
    height: number;
  }[] = [];
  async imageSize(uri: string) {
    const size = this.imageSizes.get(uri);
    if (size) return size;
    // Images written directly by actions (e.g., lossless EXIF removal): processed as small real
    // JPEGs/PNGs. User file URLs (fileUri) correspond to relative paths on disk.
    const bytes = this.disk.get(uri) ?? this.disk.get(uri.replace(/^file:\/\/\/fake\//, ''));
    if (bytes && ((bytes[0] === 0xff && bytes[1] === 0xd8) || bytes[0] === 0x89)) {
      return { width: 60, height: 40 };
    }
    throw new Error('not an image');
  }
  /**
   * Fake encoder: estimates size based on pixel count and quality (JPEG approx. 0.05–0.5 bytes /
   * pixel, PNG 1.5), writes bytes of corresponding length, monotonic and predictable, sufficient
   * for testing the search of "compress to target size".
   */
  /** Files already deleted (simulated cleanup mid-run in tests). */
  deleted = new Set<string>();
  /** Source images used for each re-encoding (one-to-one with encodes). */
  encodedFrom: string[] = [];
  async transformImage(
    uri: string,
    ops: ImageOps,
    save: { format: ImageFormat; quality: number },
    runId: string,
    relPath: string,
  ) {
    // Same as real device: files cannot be read when already deleted.
    if (this.deleted.has(uri)) throw new Error('missing');
    let { width, height } = await this.imageSize(uri);
    if (ops.crop) ({ width, height } = ops.crop);
    if (ops.resize) ({ width, height } = ops.resize);
    if (ops.rotate === 90 || ops.rotate === 270) [width, height] = [height, width];
    width = Math.round(width);
    height = Math.round(height);
    const perPixel = save.format === 'png' ? 1.5 : 0.05 + 0.45 * save.quality;
    const size = Math.max(this.minEncodedBytes, Math.round(width * height * perPixel));
    // JPEG starts with a real small image (embeddable by pdf-lib), PNG uses a real gray PNG, padded with zeros to the estimated size.
    const head = save.format === 'png' ? makePng(4, 4) : TINY_JPEG;
    const bytes = new Uint8Array(Math.max(size, head.length));
    bytes.set(head);
    const dest = `runs/${runId}/${relPath}`;
    this.disk.set(dest, bytes);
    this.imageSizes.set(dest, { width, height });
    this.encodes.push({ ops, format: save.format, quality: save.quality, width, height });
    this.encodedFrom.push(uri);
    return { uri: dest, width, height, size: bytes.length };
  }
  /** Each call to reducedJpeg: long side and source image used (downscaled during decoding, bypassing imageSize). */
  reduced: { uri: string; maxSide: number }[] = [];
  async reducedJpeg(uri: string, maxSide: number, quality: number, runId: string, relPath: string) {
    this.reduced.push({ uri, maxSide });
    const size = await this.imageSize(uri);
    const k = Math.min(1, maxSide / Math.max(size.width, size.height));
    return this.transformImage(
      uri,
      { resize: { width: size.width * k, height: size.height * k } },
      { format: 'jpeg', quality },
      runId,
      relPath,
    );
  }
  /** Offer a "user-selectable" fake photo. */
  offerImage(
    name: string,
    width: number,
    height: number,
    mimeType = 'image/jpeg',
    bytes?: Uint8Array,
  ): PickedFile {
    // JPEG uses a real small image (required for pdf-lib embedding), other formats only need placeholder bytes.
    const fallback = mimeType === 'image/jpeg' ? TINY_JPEG : new Uint8Array([0, 1, 2, 3]);
    const picked = this.offer(name, bytes ?? fallback, mimeType);
    this.imageSizes.set(picked.uri, { width, height });
    return { ...picked, width, height };
  }
  /** Composed canvas and drawing steps (collage, redaction, watermark, photo paper). */
  composed: { canvas: { width: number; height: number; background: string }; ops: DrawOp[] }[] = [];
  async composeImage(
    canvas: { width: number; height: number; background: string },
    ops: readonly DrawOp[],
    save: { format: 'jpeg' | 'png'; quality: number },
    runId: string,
    relPath: string,
  ) {
    this.composed.push({ canvas, ops: [...ops] });
    const head = save.format === 'png' ? makePng(4, 4) : TINY_JPEG;
    const dest = `runs/${runId}/${relPath}`;
    this.disk.set(dest, head);
    this.imageSizes.set(dest, { width: canvas.width, height: canvas.height });
    return { uri: dest, width: canvas.width, height: canvas.height, size: head.length };
  }
  /** Pixels returned by imagePixels (by uri); returns a white image when missing. */
  pixels = new Map<string, { width: number; height: number; data: Uint8Array }>();
  async imagePixels(uri: string) {
    if (!this.disk.has(uri)) throw new Error('missing');
    return this.pixels.get(uri) ?? { width: 2, height: 2, data: new Uint8Array(16).fill(255) };
  }
  /** Generated HTML (text-to-PDF, reports). Generates a real PDF page using pdf-lib. */
  printedHtml: string[] = [];
  async htmlToPdf(
    html: string,
    page: { width: number; height: number },
    runId: string,
    relPath: string,
    _margins?: { left: number; right: number; top: number; bottom: number },
  ) {
    this.printedHtml.push(html);
    const doc = await PDFDocument.create();
    doc.addPage([page.width, page.height]);
    const bytes = await doc.save();
    const dest = `runs/${runId}/${relPath}`;
    this.disk.set(dest, bytes);
    return { uri: dest, size: bytes.length, pageCount: 1 };
  }
  enhanced: string[] = [];
  /** Correction angles during enhancement (for the next enhancement, in order); if rotated, canvas is scaled up to the post-rotation size. */
  enhanceSkews: number[] = [];
  async enhanceImage(uri: string, mode: string, runId: string, relPath: string) {
    if (!this.disk.has(uri)) throw new Error('missing');
    const base = this.imageSizes.get(uri) ?? { width: 600, height: 800 };
    const skew = this.enhanceSkews.shift() ?? 0;
    const size = rotatedSize(base, skew);
    const dest = `runs/${runId}/${relPath}`;
    this.disk.set(dest, TINY_JPEG);
    this.imageSizes.set(dest, size);
    this.enhanced.push(mode);
    return { uri: dest, ...size, size: TINY_JPEG.length, skew, base };
  }
  signatures: { uri: string; bytes: Uint8Array; aspect: number }[] = [];
  async loadSignatures() {
    return this.signatures;
  }
  async saveSignature(png: Uint8Array, aspect: number) {
    this.signatures.unshift({ uri: `sig://${this.signatures.length}`, bytes: png, aspect });
  }
  /** Drawn texts (for assertions). */
  renderedTexts: string[] = [];
  /** Use a real PNG instead of Skia-drawn text (10 pixels wide per character). */
  async renderText(text: string, style: { fontSize: number }) {
    this.renderedTexts.push(text);
    const width = [...text].length * Math.round(style.fontSize * 0.6);
    const height = Math.round(style.fontSize);
    return { bytes: makePng(width, height), width, height };
  }
  /** Remaining files in the temp directory. */
  runFiles() {
    return [...this.disk.keys()].filter((k) => k.startsWith('runs/'));
  }
  /** Offer a file "shared in by another App" (iOS App Group shared directory). */
  offerShared(
    name: string,
    bytes: Uint8Array,
    mimeType: string | null = 'application/pdf',
  ): PickedFile {
    const uri = `file:///group/${name}`;
    this.disk.set(uri, bytes);
    return { uri, name, size: bytes.length, mimeType };
  }
  sharedFiles() {
    return [...this.disk.keys()].filter((k) => k.startsWith('file:///group/'));
  }
  /** Offer a "user-selectable" file. */
  offer(name: string, bytes: Uint8Array, mimeType = 'application/pdf'): PickedFile {
    const uri = `picker://${name}`;
    this.disk.set(uri, bytes);
    return { uri, name, size: bytes.length, mimeType };
  }
}

/** Fake document-to-PDF (D-186): counts every 1 KB of document as one page, writes a minimal PDF header. */
/**
 * Fake PDF passwords: content starting with `%LOCK:password` requires a password to open,
 * `%RESTRICT` restricts only printing and copying. Upon unlocking, this line is removed; when
 * adding a password, this line is added.
 */
export class FakePdfPasswords implements PdfPasswordPlatform {
  constructor(private files: FakeFiles) {}
  private text(uri: string) {
    return new TextDecoder().decode(this.files.disk.get(uri) ?? new Uint8Array());
  }
  async lockState(uri: string) {
    const text = this.text(uri);
    return text.startsWith('%LOCK:')
      ? 'locked'
      : text.startsWith('%RESTRICT')
        ? 'restricted'
        : 'none';
  }
  async unlock(uri: string, password: string, runId: string, relPath: string) {
    const [first, ...rest] = this.text(uri).split('\n');
    if (first !== `%LOCK:${password}`) return null;
    return this.files.writeRunFile(runId, relPath, new TextEncoder().encode(rest.join('\n')));
  }
  async protect(uri: string, password: string, runId: string, relPath: string) {
    const bytes = new TextEncoder().encode(`%LOCK:${password}\n${this.text(uri)}`);
    return this.files.writeRunFile(runId, relPath, bytes);
  }
}

export class FakeDocuments implements DocumentPlatform {
  extensions: readonly string[] = ['docx'];
  /** Set to null to simulate Android (P-025). */
  passwords: PdfPasswordPlatform | null;
  converted: { uri: string; ext: string; page: { width: number; height: number } }[] = [];
  /** Error code to be thrown by the next conversion. */
  failWith: string | null = null;
  constructor(private files: FakeFiles) {
    this.passwords = new FakePdfPasswords(files);
  }
  async toPdf(
    uri: string,
    ext: string,
    page: { width: number; height: number },
    runId: string,
    relPath: string,
  ) {
    if (this.failWith) {
      const code = this.failWith;
      this.failWith = null;
      throw Object.assign(new Error(code), { code });
    }
    this.converted.push({ uri, ext, page });
    const size = this.files.disk.get(uri)?.length ?? 0;
    const out = await this.files.writeRunFile(
      runId,
      relPath,
      new TextEncoder().encode('%PDF-1.7\n'),
    );
    return { uri: out.uri, size: out.size, pageCount: Math.max(1, Math.ceil(size / 1024)) };
  }
}

/**
 * Fake video processing (modules/morph-media): calculates output size based on bitrate and
 * duration, writes bytes of corresponding length. oversize causes the encoder to exceed the
 * bitrate (testing "compress again when exceeding").
 */
export class FakeMedia implements MediaPlatform {
  encodes: (VideoEncode & { uri: string })[] = [];
  trims: { uri: string; range: { startMs: number; endMs: number } }[] = [];
  /** How much larger the output is compared to the bitrate calculation (1 = exact). */
  oversize = 1;
  /** Error code thrown by the next processing (ERR_MEDIA_UNSUPPORTED, etc.). */
  failWith: string | null = null;

  constructor(private files: FakeFiles) {}

  async probe(uri: string): Promise<MediaInfo> {
    const info = this.files.videos.get(uri);
    if (!info) throw Object.assign(new Error('unsupported'), { code: 'ERR_MEDIA_UNSUPPORTED' });
    return { ...info, size: this.files.disk.get(uri)?.length ?? 0 };
  }
  private fail() {
    if (this.failWith) {
      const code = this.failWith;
      this.failWith = null;
      throw Object.assign(new Error(code), { code });
    }
  }
  speechExtractions: string[] = [];
  async speechAudio(
    uri: string,
    runId: string,
    relPath: string,
    job: MediaJob,
  ): Promise<MediaOutput> {
    this.speechExtractions.push(uri);
    return this.encodeAudio(
      uri,
      { format: 'wav', bitrateKbps: 1536, sampleRate: 48000, channels: 2 },
      runId,
      relPath,
      job,
    );
  }
  volumes: { uri: string; automatic: boolean; db: number }[] = [];
  async volume(
    uri: string,
    settings: { automatic: boolean; db: number; video?: VideoEncode },
    runId: string,
    relPath: string,
    job: MediaJob,
  ): Promise<MediaOutput> {
    this.volumes.push({ uri, automatic: settings.automatic, db: settings.db });
    if (settings.video) return this.encodeVideo(uri, settings.video, runId, relPath, job);
    return this.encodeAudio(
      uri,
      { format: 'm4a', bitrateKbps: 192, channels: 2, sampleRate: 48000 },
      runId,
      relPath,
      job,
    );
  }
  denoises: string[] = [];
  async denoise(
    uri: string,
    settings: { video?: VideoEncode },
    runId: string,
    relPath: string,
    job: MediaJob,
  ): Promise<MediaOutput> {
    this.denoises.push(uri);
    return this.volume(uri, { ...settings, automatic: false, db: 0 }, runId, relPath, job);
  }
  mutes: string[] = [];
  async muteVideo(
    uri: string,
    settings: VideoEncode,
    runId: string,
    relPath: string,
    job: MediaJob,
  ): Promise<MediaOutput> {
    this.mutes.push(uri);
    return this.encodeVideo(uri, { ...settings, audioKbps: 0 }, runId, relPath, job);
  }
  rotations: { uri: string; degrees: number }[] = [];
  async rotateVideo(
    uri: string,
    degrees: 90 | 180 | 270,
    settings: VideoEncode,
    runId: string,
    relPath: string,
    job: MediaJob,
  ): Promise<MediaOutput> {
    this.rotations.push({ uri, degrees });
    const out = await this.encodeVideo(uri, settings, runId, relPath, job);
    if (degrees !== 180) [out.info.width, out.info.height] = [out.info.height, out.info.width];
    this.files.videos.set(out.uri, out.info);
    return out;
  }
  mixes: { uri: string; music: string; originalVolume: number; loop: boolean }[] = [];
  async mixVideoAudio(
    uri: string,
    music: string,
    settings: VideoEncode & {
      originalVolume: number;
      loop: boolean;
      videoDurationMs: number;
      musicDurationMs: number;
    },
    runId: string,
    relPath: string,
    job: MediaJob,
  ): Promise<MediaOutput> {
    this.mixes.push({ uri, music, originalVolume: settings.originalVolume, loop: settings.loop });
    await this.probe(music);
    return this.encodeVideo(uri, { ...settings, audioKbps: 128 }, runId, relPath, job);
  }
  videoConcats: { uris: readonly string[]; width: number; height: number; maxFps: number }[] = [];
  async concatVideo(
    uris: readonly string[],
    settings: VideoEncode & { width: number; height: number },
    runId: string,
    relPath: string,
    job: MediaJob,
  ): Promise<MediaOutput> {
    this.fail();
    this.videoConcats.push({
      uris: [...uris],
      width: settings.width,
      height: settings.height,
      maxFps: settings.maxFps,
    });
    const infos = await Promise.all(uris.map((uri) => this.probe(uri)));
    const durationMs = infos.reduce((n, i) => n + i.durationMs, 0);
    if (job.isCancelled())
      throw Object.assign(new Error('cancelled'), { code: 'ERR_MEDIA_CANCELLED' });
    const size = Math.round(((settings.videoKbps + settings.audioKbps) * durationMs) / 8);
    const out = await this.files.writeRunFile(runId, relPath, new Uint8Array(size));
    const info: MediaInfo = {
      kind: 'video',
      durationMs,
      size,
      width: settings.width,
      height: settings.height,
      fps: settings.maxFps,
      hasVideo: true,
      hasAudio: settings.audioKbps > 0,
    };
    this.files.videos.set(out.uri, info);
    job.progress(1);
    return { ...out, ext: 'mp4', info };
  }
  async encodeVideo(
    uri: string,
    settings: VideoEncode,
    runId: string,
    relPath: string,
    job: MediaJob,
  ): Promise<MediaOutput> {
    this.fail();
    const source = await this.probe(uri);
    this.encodes.push({ ...settings, uri });
    job.progress(0.5);
    if (job.isCancelled()) {
      throw Object.assign(new Error('cancelled'), { code: 'ERR_MEDIA_CANCELLED' });
    }
    const ms =
      (settings.range ? settings.range.endMs - settings.range.startMs : source.durationMs) /
      (settings.speed ?? 1);
    const bytes = Math.round(
      (((settings.videoKbps + settings.audioKbps) * 1000 * (ms / 1000)) / 8) * this.oversize,
    );
    const out = await this.files.writeRunFile(runId, relPath, new Uint8Array(bytes));
    const originalW = source.width ?? 1;
    const originalH = source.height ?? 1;
    const cropW = settings.aspectRatio
      ? Math.min(originalW, originalH * settings.aspectRatio)
      : originalW;
    const cropH = settings.aspectRatio
      ? Math.min(originalH, originalW / settings.aspectRatio)
      : originalH;
    const short = settings.shortSide ?? Math.min(cropW, cropH);
    const k = Math.min(1, short / Math.min(cropW, cropH));
    const info: MediaInfo = {
      ...source,
      durationMs: ms,
      size: bytes,
      width: settings.aspectRatio
        ? Math.max(2, Math.round((cropW * k) / 2) * 2)
        : Math.round(originalW * k),
      height: settings.aspectRatio
        ? Math.max(2, Math.round((cropH * k) / 2) * 2)
        : Math.round(originalH * k),
      hasAudio: settings.audioKbps > 0,
    };
    this.files.videos.set(out.uri, info);
    job.progress(1);
    return { uri: out.uri, ext: 'mp4', size: bytes, info };
  }
  async trim(
    uri: string,
    range: { startMs: number; endMs: number },
    runId: string,
    relPath: string,
    job: MediaJob,
  ): Promise<MediaOutput> {
    this.fail();
    const source = await this.probe(uri);
    this.trims.push({ uri, range });
    const part = (range.endMs - range.startMs) / source.durationMs;
    const bytes = Math.max(1, Math.round(source.size * part));
    const out = await this.files.writeRunFile(runId, relPath, new Uint8Array(bytes));
    const info = { ...source, durationMs: range.endMs - range.startMs, size: bytes };
    this.files.videos.set(out.uri, info);
    job.progress(1);
    return { uri: out.uri, ext: 'mp4', size: bytes, info };
  }
  frames: { uri: string; timeMs: number }[] = [];
  async frame(uri: string, timeMs: number, runId: string) {
    this.fail();
    const info = await this.probe(uri);
    this.frames.push({ uri, timeMs });
    const out = await this.files.writeRunFile(runId, `frame-${this.frames.length}.jpg`, TINY_JPEG);
    this.files.imageSizes.set(out.uri, { width: info.width ?? 1, height: info.height ?? 1 });
    return out.uri;
  }
  async thumbnails(uri: string, timesMs: readonly number[]) {
    await this.probe(uri);
    return timesMs.map((ms) => `frame://${uri}/${ms}`);
  }
  audioEncodes: (AudioEncode & { uri: string })[] = [];
  concats: { uris: readonly string[]; settings: AudioEncode }[] = [];
  private async writeAudio(
    durationMs: number,
    settings: AudioEncode,
    runId: string,
    relPath: string,
  ): Promise<MediaOutput> {
    const bytes = Math.max(
      1,
      Math.round(
        (settings.format === 'wav'
          ? settings.sampleRate * settings.channels * 2 * (durationMs / 1000)
          : (settings.bitrateKbps * 1000 * (durationMs / 1000)) / 8) * this.oversize,
      ),
    );
    const out = await this.files.writeRunFile(runId, relPath, new Uint8Array(bytes));
    const info: MediaInfo = {
      kind: 'audio',
      durationMs,
      size: bytes,
      hasVideo: false,
      hasAudio: true,
      audioCodec: settings.format === 'wav' ? 'lpcm' : 'aac',
      audioBitrateKbps: settings.bitrateKbps,
      channels: settings.channels,
      sampleRate: settings.sampleRate,
    };
    this.files.videos.set(out.uri, info);
    return { uri: out.uri, ext: settings.format, size: bytes, info };
  }
  async encodeAudio(
    uri: string,
    settings: AudioEncode,
    runId: string,
    relPath: string,
    job: MediaJob,
  ): Promise<MediaOutput> {
    this.fail();
    const source = await this.probe(uri);
    if (!source.hasAudio)
      throw Object.assign(new Error('no audio'), { code: 'ERR_MEDIA_UNSUPPORTED' });
    this.audioEncodes.push({ ...settings, uri });
    job.progress(0.5);
    if (job.isCancelled()) {
      throw Object.assign(new Error('cancelled'), { code: 'ERR_MEDIA_CANCELLED' });
    }
    const ms = settings.range ? settings.range.endMs - settings.range.startMs : source.durationMs;
    const out = await this.writeAudio(ms, settings, runId, relPath);
    job.progress(1);
    return out;
  }
  async concatAudio(
    uris: readonly string[],
    settings: AudioEncode,
    runId: string,
    relPath: string,
    job: MediaJob,
  ): Promise<MediaOutput> {
    this.fail();
    let ms = 0;
    for (const uri of uris) ms += (await this.probe(uri)).durationMs;
    this.concats.push({ uris, settings });
    const out = await this.writeAudio(ms, settings, runId, relPath);
    job.progress(1);
    return out;
  }
  gifs: { uris: readonly string[]; settings: Record<string, number> }[] = [];
  /** Fake GIF: 1 KB per frame, dimensions calculated based on settings (16:9 for videos, square for images). */
  private async writeGif(
    frames: number,
    width: number,
    height: number,
    runId: string,
    relPath: string,
    job: MediaJob,
  ) {
    if (job.isCancelled()) {
      throw Object.assign(new Error('cancelled'), { code: 'ERR_MEDIA_CANCELLED' });
    }
    const out = await this.files.writeRunFile(runId, relPath, new Uint8Array(frames * 1024));
    job.progress(1);
    return { uri: out.uri, size: out.size, width, height, frames };
  }
  async videoGif(
    uri: string,
    settings: { width: number; fps: number },
    runId: string,
    relPath: string,
    job: MediaJob,
  ) {
    this.fail();
    const source = await this.probe(uri);
    this.gifs.push({ uris: [uri], settings });
    const frames = Math.max(1, Math.floor((source.durationMs / 1000) * settings.fps));
    const height = Math.round((settings.width * 9) / 16);
    return this.writeGif(frames, settings.width, height, runId, relPath, job);
  }
  async imagesGif(
    uris: readonly string[],
    settings: { delayMs: number; maxSide: number },
    runId: string,
    relPath: string,
    job: MediaJob,
  ) {
    this.fail();
    this.gifs.push({ uris, settings });
    return this.writeGif(uris.length, settings.maxSide, settings.maxSide, runId, relPath, job);
  }
  /** Waveform: null indicates native module cannot read it. */
  peaks: number[] | null = [0.1, 0.8, 0.4, 1];
  async waveform(uri: string, buckets: number) {
    await this.probe(uri);
    return this.peaks
      ? Array.from({ length: buckets }, (_, i) => this.peaks![i % this.peaks!.length]!)
      : null;
  }
}

/** Fake speech-to-text (modules/morph-speech): returns text in order, recording language and model. */
export class FakeSpeech implements SpeechPlatform {
  engine: 'system' | 'whisper' = 'whisper';
  calls: { uri: string; language: string; model: string }[] = [];
  texts: string[] = [];
  /** Result of need(); Android requires downloading models by default. */
  needs: SpeechNeed = { kind: 'ready' };
  prepared: string[] = [];
  error: SpeechErrorCode | null = null;
  async need() {
    return this.needs;
  }
  async prepare(language: string) {
    this.prepared.push(language);
    this.needs = { kind: 'ready' };
  }
  timedResults: import('@morph/core').SpeechSegment[][] = [];
  async transcribe(uri: string, request: TranscribeRequest) {
    this.calls.push({ uri, language: request.language, model: request.model });
    request.onProgress?.(0.5);
    if (request.isCancelled?.()) throw new SpeechError('cancelled');
    if (this.error) throw new SpeechError(this.error);
    const text = this.texts.shift() ?? '';
    return {
      text,
      durationMs: 1000,
      ...(request.timed
        ? {
            segments:
              this.timedResults.shift() ?? (text ? [{ startMs: 0, endMs: 1000, text }] : []),
          }
        : {}),
    };
  }
}

/**
 * Fake system speech synthesis (modules/morph-tts): reads each character in 0.1 seconds (divided
 * by speech rate), writes a 24 kHz mono WAV of the same size into the current run's temp
 * directory, and registers it as probeable audio (can be chained with FakeMedia format conversion
 * later).
 */
export class FakeSpeaker implements SpeakPlatform {
  /** Status of each voice; unlisted ones are installed. */
  statuses: Record<string, 'installed' | 'notDownloaded' | 'unsupported' | 'noEngine'> = {};
  calls: { segments: readonly string[]; voice: string; rate: number; relPath: string }[] = [];
  /** Error code thrown during speech synthesis. */
  failWith: SpeakErrorCode | null = null;
  constructor(private files: FakeFiles) {}
  async voiceStatus(voice: string) {
    return this.statuses[voice] ?? 'installed';
  }
  async synthesize(segments: readonly string[], request: SpeakRequest) {
    const { voice, rate, relPath } = request;
    this.calls.push({ segments, voice, rate, relPath });
    // Like native modules: checks for "stop" before each segment.
    for (let i = 0; i < segments.length; i++) {
      if (request.isCancelled?.())
        throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
      request.onProgress?.((i + 1) / segments.length);
    }
    if (this.failWith) throw Object.assign(new Error(this.failWith), { code: this.failWith });
    const sampleRate = 24000;
    const chars = segments.reduce((n, s) => n + s.length, 0);
    const durationMs = Math.round((chars * 100) / rate);
    const bytes = 44 + Math.round((sampleRate * 2 * durationMs) / 1000);
    const out = await this.files.writeRunFile(request.runId, relPath, new Uint8Array(bytes));
    this.files.videos.set(out.uri, {
      kind: 'audio',
      durationMs,
      size: out.size,
      hasVideo: false,
      hasAudio: true,
      audioCodec: 'lpcm',
      channels: 1,
      sampleRate,
    });
    return { uri: out.uri, size: out.size, durationMs, sampleRate, channels: 1 };
  }
}

/** Fake background continuation (modules/morph-background): records each call in order. */
export class FakeBackground implements BackgroundPlatform {
  continuesInBackground = true;
  /** Notification permission: how the user responds when asked. */
  grantNotifications = true;
  /** Whether Morph is in the foreground. */
  foreground = true;
  /** Return value of begin (false: system disallows). */
  canBegin = true;
  calls: (
    | { kind: 'permission' }
    | { kind: 'begin'; title: string; text: string }
    | { kind: 'update'; text: string; fraction: number | null }
    | { kind: 'end'; done: { title: string; body: string } | null }
  )[] = [];
  async ensureNotificationPermission() {
    this.calls.push({ kind: 'permission' });
    return this.grantNotifications;
  }
  begin(title: string, text: string) {
    this.calls.push({ kind: 'begin', title, text });
    return this.canBegin;
  }
  update(text: string, fraction: number | null) {
    this.calls.push({ kind: 'update', text, fraction });
  }
  end(done: { title: string; body: string } | null) {
    this.calls.push({ kind: 'end', done });
  }
  isForeground() {
    return this.foreground;
  }
}

/** Point inside a convex quadrilateral (clockwise corners). */
function insideQuad(q: Quad, x: number, y: number): boolean {
  const pts = [q.tl, q.tr, q.br, q.bl];
  return pts.every((a, i) => {
    const b = pts[(i + 1) % 4]!;
    return (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x) >= 0;
  });
}

/**
 * Small grayscale image for pickPaper border detection (1/10 of the original image, D-326): when
 * draw is not provided, draws based on candidates; the first candidate contains paper (bright),
 * outside is desk (dark).
 */
export function paperGray(
  candidates: readonly Quad[],
  size: { width: number; height: number },
  draw?: ((size: { width: number; height: number }) => Uint8Array) | null,
): { width: number; height: number; data: Uint8Array } {
  const width = Math.round(size.width / 10);
  const height = Math.round(size.height / 10);
  let data = draw?.({ width, height });
  if (!data) {
    data = new Uint8Array(width * height).fill(60);
    const sheet = candidates[0];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (sheet && insideQuad(sheet, x * 10, y * 10)) data[y * width + x] = 210;
      }
    }
  }
  return { width, height, data };
}

/** Fake system text recognition and scanning (iOS Vision; Android ML Kit sets canFindPaper = false): returns found corners and recognized text in order, straightens and writes a real small JPEG. */
export class FakeVision implements VisionPlatform {
  async adjustImage(
    uri: string,
    settings: import('../runtime/platform').ImageAdjustSettings,
    format: 'jpeg' | 'png',
    runId: string,
    relPath: string,
  ) {
    this.calls.push({ method: 'adjustImage', uri, args: { ...settings, format } });
    const size = await this.files.imageSize(uri);
    const out = await this.files.writeRunFile(runId, relPath, TINY_JPEG);
    this.files.imageSizes.set(out.uri, size);
    return { ...out, ...size };
  }
  backgroundRemovalSupported = true;
  backgroundState: 'ready' | 'download' | 'unsupported' = 'ready';
  backgroundFailure = false;
  async backgroundStatus() {
    return this.backgroundState;
  }
  async downloadBackgroundModel() {
    this.calls.push({ method: 'downloadBackgroundModel', uri: '' });
    this.backgroundState = 'ready';
  }
  async removeBackground(uri: string, background: string, runId: string, relPath: string) {
    this.calls.push({ method: 'removeBackground', uri, args: background });
    if (this.backgroundFailure) throw new Error('no subject');
    const size = await this.files.imageSize(uri);
    const out = await this.files.writeRunFile(runId, relPath, TINY_JPEG);
    this.files.imageSizes.set(out.uri, size);
    return { ...out, ...size };
  }

  /**
   * Scan flattening (D-274): none by default (older app versions); enabled by enableFlatten.
   * flattenInstalled indicates whether the flattening model is installed, flattenFails causes
   * flattening errors on specified pages (input uris).
   */
  flattenModel?: { pack: string };
  flatten?: VisionPlatform['flatten'];
  flattenInstalled = true;
  flattenFails = new Set<string>();
  enableFlatten(prompt = true) {
    if (prompt) this.flattenModel = { pack: 'dewarp' };
    this.flatten = async (uri, runId, relPath) => {
      this.calls.push({ method: 'flatten', uri });
      if (this.flattenFails.has(uri)) throw new Error('model failed');
      if (!this.flattenInstalled) return null;
      const size = await this.files.imageSize(uri);
      const out = await this.files.writeRunFile(runId, relPath, TINY_JPEG);
      this.files.imageSizes.set(out.uri, size);
      return { ...out, ...size, refined: true, timing: {} };
    };
  }

  /**
   * Layout analysis for Word conversion (D-328): none by default (older app versions); enabled by
   * enableLayout. layoutRegions contains results per page (in order, null if model not
   * installed), layoutFails causes layout analysis errors.
   */
  layoutModel?: { pack: string };
  detectLayout?: VisionPlatform['detectLayout'];
  layoutRegions: (LayoutRegion[] | null)[] = [];
  layoutFails = false;
  enableLayout(prompt = true) {
    if (prompt) this.layoutModel = { pack: 'layout' };
    this.detectLayout = async () => {
      this.calls.push({ method: 'detectLayout', uri: '' });
      if (this.layoutFails) throw new Error('model failed');
      return this.layoutRegions.shift() ?? null;
    };
  }

  /** ID photos (D-252): results of face detection each time (in order; detection image size and face bounding box). */
  faceResults: { width: number; height: number; faces: Box[] }[] = [];
  async detectFaces(uri: string) {
    this.calls.push({ method: 'detectFaces', uri });
    return this.faceResults.shift() ?? { width: 1, height: 1, faces: [] };
  }
  /** Image classification: labels for each run (in order). */
  labelResults: { id: string; confidence: number }[][] = [];
  async classifyImage(uri: string) {
    this.calls.push({ method: 'classifyImage', uri });
    return this.labelResults.shift() ?? [];
  }
  /** iOS person segmentation does not require downloading a model; change to false to simulate Android. */
  personSegmentation = true;
  async replaceBackground(uri: string, color: string, runId: string, relPath: string) {
    this.calls.push({ method: 'replaceBackground', uri, args: color });
    if (this.backgroundFailure) throw new Error('no person');
    const size = await this.files.imageSize(uri);
    const out = await this.files.writeRunFile(runId, relPath, makePng(size.width, size.height));
    this.files.imageSizes.set(out.uri, size);
    return { ...out, ...size };
  }

  calls: { method: string; uri: string; args?: unknown }[] = [];
  /** Edge detection candidates per run (in order): a quadrilateral represents a piece of paper on a dark desk, null means not found (D-327). */
  found: (Quad | Quad[] | null)[] = [];
  /** Small grayscale image provided for edge detection; if unset, draws based on candidates (see paperGray). */
  gray: ((size: { width: number; height: number }) => Uint8Array) | null = null;
  texts: string[] = [];
  documentCamera = true;
  canFindPaper = true;
  /** Languages unsupported by system recognition (BCP 47 primary language), e.g., Android ML Kit does not recognize Russian. */
  unsupported = new Set<string>();
  /** Pages captured by the next document camera; null indicates user cancellation. */
  scanned: PickedFile[] | null = null;

  constructor(private files: FakeFiles) {}

  supportsLanguage(code: string) {
    return !this.unsupported.has(code.split('-')[0]!);
  }
  /** Devices with text recognition models (D-269): when set to { pack, languages }, these languages must download models first. */
  ocrModel?: { pack: string; languages: readonly string[] };
  async recognizeText(uri: string, languages: readonly string[]) {
    this.calls.push({ method: 'recognizeText', uri, args: languages });
    return this.texts.shift() ?? '';
  }
  /** Results of per-line recognition (in order); when empty, returns a 100×100 image without text. */
  layers: (RecognizedLayer | Error)[] = [];
  /** Whether decoded pixels were included during per-line recognition (shared with Excel conversion for line finding, D-272). */
  linePixels: (Pixels | undefined)[] = [];
  async recognizeLines(uri: string, languages: readonly string[], pixels?: Pixels) {
    this.calls.push({ method: 'recognizeLines', uri, args: languages });
    this.linePixels.push(pixels);
    // Reads whether "is it receipt-like" in the record panel (D-477) reads the same image; real
    // recognition can be repeated: only looks at the queue head without removing it, leaving it for
    // that subsequent read in the form.
    const hint = /\/receipt-like-/.test(uri);
    const next = (hint ? this.layers[0] : this.layers.shift()) ?? {
      width: 100,
      height: 100,
      lines: [],
    };
    if (next instanceof Error) throw next;
    return next;
  }
  /** Pixels used for line finding in Excel conversion (in order); when empty, returns a 100×100 white image. */
  tableImages: Pixels[] = [];
  async tablePixels(uri: string): Promise<Pixels> {
    this.calls.push({ method: 'tablePixels', uri });
    return (
      this.tableImages.shift() ?? {
        width: 100,
        height: 100,
        data: new Uint8Array(100 * 100 * 4).fill(255),
      }
    );
  }
  async findPaper(uri: string) {
    this.calls.push({ method: 'findPaper', uri });
    const found = this.found.shift() ?? null;
    const candidates = found === null ? [] : Array.isArray(found) ? found : [found];
    return {
      candidates: candidates.map((q) => [q.tl, q.tr, q.br, q.bl]),
      gray: paperGray(candidates, await this.files.imageSize(uri), this.gray),
    };
  }
  async straighten(
    uri: string,
    quad: Quad,
    size: { width: number; height: number },
    runId: string,
    relPath: string,
  ) {
    this.calls.push({ method: 'straighten', uri, args: { quad, ...size } });
    const out = await this.files.writeRunFile(runId, relPath, TINY_JPEG);
    this.files.imageSizes.set(out.uri, size);
    return { ...out, ...size };
  }
  async scanDocuments(_runId: string, maxSide: number) {
    this.calls.push({ method: 'scanDocuments', uri: '', args: { maxSide } });
    return this.scanned;
  }
}

/**
 * Fake system translation (D-170): guesses language from text (Chinese characters → zh, kana →
 * ja, other letters → en), translation format is "[target language] original text". When android
 * = true, provides sizes for languages to download (ML Kit), otherwise not (iOS uses system
 * prompt).
 */
export class FakeTranslator implements TranslatePlatform {
  supported = true;
  calls: { method: string; args: unknown[] }[] = [];
  /** Languages not yet downloaded. */
  missing = new Set<string>();
  unsupported = new Set<string>();
  android = false;
  /** Error code thrown by the next translation (cancelled: user cancelled in iOS download prompt). */
  failWith: string | null = null;

  async detectLanguages(texts: readonly string[]) {
    this.calls.push({ method: 'detectLanguages', args: [texts.length] });
    return texts.map((x) =>
      /[\u3040-\u30ff]/.test(x)
        ? 'ja'
        : /[\u4e00-\u9fff]/.test(x)
          ? 'zh'
          : /[a-z]/i.test(x)
            ? 'en'
            : null,
    );
  }
  async status(from: string, to: string) {
    this.calls.push({ method: 'status', args: [from, to] });
    if (this.unsupported.has(from) || this.unsupported.has(to)) {
      return { status: 'unsupported' as const };
    }
    const missing = [from, to].filter((l) => this.missing.has(l));
    if (missing.length === 0) return { status: 'installed' as const };
    return this.android
      ? { status: 'download' as const, missing }
      : { status: 'download' as const };
  }
  get downloadBytes() {
    return this.android ? 30 * 1024 * 1024 : undefined;
  }
  /** iOS: system prompt to download a language pair (Android uses download). */
  prepare = async (from: string, to: string) => {
    this.calls.push({ method: 'prepare', args: [from, to] });
    if (this.failWith) {
      const code = this.failWith;
      this.failWith = null;
      throw Object.assign(new Error(code), { code });
    }
    this.missing.delete(from);
    this.missing.delete(to);
  };
  /** Downloaded languages (listed in "Settings → Downloaded Content"). */
  downloaded = new Set<string>();
  download = async (language: string) => {
    this.calls.push({ method: 'download', args: [language] });
    this.missing.delete(language);
    this.downloaded.add(language);
  };
  downloadedLanguages = async () => [...this.downloaded];
  removeLanguage = async (language: string) => {
    this.downloaded.delete(language);
    this.missing.add(language);
  };
  async translate(texts: readonly string[], from: string, to: string) {
    this.calls.push({ method: 'translate', args: [texts, from, to] });
    if (this.failWith) throw Object.assign(new Error(this.failWith), { code: this.failWith });
    return texts.map((x) => `[${to}] ${x}`);
  }
}
