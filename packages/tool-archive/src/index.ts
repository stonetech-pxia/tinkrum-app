import { unzipSync, zipSync, type UnzipFileInfo, type Zippable } from 'fflate';

// ZIP archiving and extraction (T1). Depends only on byte arrays; fflate uses synchronous APIs only
// (asynchronous APIs require Workers, which Hermes lacks), allowing identical code to run on mobile
// and be tested with real ZIPs in Node.

export type ArchiveErrorCode = 'unreadable' | 'tooManyEntries' | 'tooLarge' | 'encrypted' | 'empty';

export class ArchiveError extends Error {
  constructor(
    readonly code: ArchiveErrorCode,
    readonly fileName?: string,
  ) {
    super(fileName ? `${code}: ${fileName}` : code);
  }
}

export interface ArchiveLimits {
  /** Maximum number of files (directories and system junk files excluded). */
  maxEntries: number;
  /** Upper limit on total uncompressed bytes across all files. */
  maxTotalBytes: number;
  /** Upper limit on uncompressed bytes for a single file. */
  maxFileBytes: number;
  /** Upper limit on uncompressed-to-compressed ratio to prevent zip bombs; checked only for files exceeding 1 MB. */
  maxRatio: number;
}

export const DEFAULT_LIMITS: ArchiveLimits = {
  maxEntries: 500,
  maxTotalBytes: 100 * 1024 * 1024,
  maxFileBytes: 50 * 1024 * 1024,
  maxRatio: 200,
};

const RATIO_CHECK_MIN_BYTES = 1024 * 1024;

export interface ArchiveInput {
  name: string;
  bytes: Uint8Array;
}

export interface ArchiveEntry {
  name: string;
  bytes: Uint8Array;
  mimeType: string;
}

export type CompressionLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

export interface CreateZipOptions {
  level?: CompressionLevel;
  limits?: Partial<ArchiveLimits>;
}

export interface ExtractZipOptions {
  limits?: Partial<ArchiveLimits>;
}

const MIME_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  gif: 'image/gif',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  zip: 'application/zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
};

// Formats already compressed; further compression is a waste of time, so store directly (level 0).
const STORED_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'heic', 'pdf', 'zip']);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function mimeTypeOfName(name: string): string {
  return MIME_TYPES[extensionOf(name)] ?? 'application/octet-stream';
}

/**
 * Sanitize arbitrary names into safe single-level filenames: strip control characters, replace
 * `/` and `\\` with `_`, collapse consecutive dots (preventing `..`), trim leading/trailing
 * whitespace and trailing dots. Preserves Chinese and other UTF-8 characters.
 */
export function sanitizeName(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[/\\]/g, '_')
    .replace(/\.{2,}/g, '.')
    .trim()
    .replace(/[.\s]+$/, '');
  return cleaned === '' || cleaned === '.' ? 'file' : cleaned;
}

/** Case-insensitive deduplication: when `photo.jpg` already exists, produces `photo-2.jpg`, `photo-3.jpg`, etc. */
function uniqueName(name: string, taken: Set<string>): string {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let candidate = name;
  for (let i = 2; taken.has(candidate.toLowerCase()); i++) candidate = `${stem}-${i}${ext}`;
  taken.add(candidate.toLowerCase());
  return candidate;
}

function resolveLimits(limits: Partial<ArchiveLimits> | undefined): ArchiveLimits {
  return { ...DEFAULT_LIMITS, ...limits };
}

/** Pack files into a ZIP. File names are sanitized and deduplicated; already compressed formats are stored without recompression. */
export function createZip(
  entries: readonly ArchiveInput[],
  { level = 6, limits }: CreateZipOptions = {},
): Uint8Array {
  const max = resolveLimits(limits);
  if (entries.length === 0) throw new ArchiveError('empty');
  if (entries.length > max.maxEntries) throw new ArchiveError('tooManyEntries');
  // Use a prototype-less object to prevent files named `__proto__` from being swallowed.
  const files = Object.create(null) as Zippable;
  const taken = new Set<string>();
  let total = 0;
  for (const entry of entries) {
    const name = uniqueName(sanitizeName(entry.name), taken);
    if (entry.bytes.length > max.maxFileBytes) throw new ArchiveError('tooLarge', name);
    total += entry.bytes.length;
    if (total > max.maxTotalBytes) throw new ArchiveError('tooLarge');
    files[name] = [entry.bytes, { level: STORED_EXTENSIONS.has(extensionOf(name)) ? 0 : level }];
  }
  return zipSync(files);
}

const u16 = (d: Uint8Array, i: number) => (d[i] ?? 0) | ((d[i + 1] ?? 0) << 8);
const u32 = (d: Uint8Array, i: number) => (u16(d, i) | (u16(d, i + 2) << 16)) >>> 0;

/**
 * Read general purpose flags for each entry in central directory order (fflate's filter does not
 * provide them). Read-only without decompression; returns null on structural anomalies, letting
 * fflate throw its own error.
 */
function readEntryFlags(data: Uint8Array): number[] | null {
  let e = data.length - 22;
  while (e >= 0 && u32(data, e) !== 0x06054b50) {
    if (data.length - e > 65558) return null;
    e--;
  }
  if (e < 0) return null;
  let count = u16(data, e + 8);
  let offset = u32(data, e + 16);
  // ZIP64: True entry count and offset reside in the ZIP64 end record (only lower 32 bits are taken, which is sufficient within the 100 MB limit).
  if (e >= 20 && u32(data, e - 20) === 0x07064b50) {
    const z = u32(data, e - 12);
    if (u32(data, z) === 0x06064b50) {
      count = u32(data, z + 32);
      offset = u32(data, z + 48);
    }
  }
  const flags: number[] = [];
  for (let i = 0; i < count; i++) {
    if (offset + 46 > data.length || u32(data, offset) !== 0x02014b50) return null;
    flags.push(u16(data, offset + 8));
    offset += 46 + u16(data, offset + 28) + u16(data, offset + 30) + u16(data, offset + 32);
  }
  return flags;
}

/** Directories, `__MACOSX/`, and `.DS_Store` do not count as user files. */
function isJunk(path: string): boolean {
  const parts = path.split('/');
  const base = parts[parts.length - 1] ?? '';
  return base === '' || base === '.DS_Store' || parts.includes('__MACOSX');
}

/**
 * Extract ZIP, returning a flat file list (keeping only file names and dropping directory
 * hierarchies, making path traversal impossible). All limits are checked before extraction using
 * the sizes declared in the central directory; fflate allocates output based on declared sizes,
 * so actual larger data cannot write out of bounds. File names not marked as UTF-8 are decoded
 * using Latin-1 (e.g., GBK Chinese names will be garbled).
 */
export function extractZip(bytes: Uint8Array, { limits }: ExtractZipOptions = {}): ArchiveEntry[] {
  const max = resolveLimits(limits);
  const flags = readEntryFlags(bytes);
  const order: string[] = [];
  let index = -1;
  let total = 0;
  const filter = (file: UnzipFileInfo): boolean => {
    index++;
    const path = file.name.replace(/\\/g, '/');
    if (isJunk(path)) return false;
    // Bit 0: encrypted; 99: AES encrypted compression method.
    if (((flags?.[index] ?? 0) & 1) !== 0 || file.compression === 99) {
      throw new ArchiveError('encrypted', file.name);
    }
    if (order.length + 1 > max.maxEntries) throw new ArchiveError('tooManyEntries');
    if (file.originalSize > max.maxFileBytes) throw new ArchiveError('tooLarge', file.name);
    total += file.originalSize;
    if (total > max.maxTotalBytes) throw new ArchiveError('tooLarge');
    if (file.originalSize > RATIO_CHECK_MIN_BYTES && file.originalSize > file.size * max.maxRatio) {
      throw new ArchiveError('tooLarge', file.name);
    }
    order.push(file.name);
    return true;
  };

  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, { filter });
  } catch (e) {
    if (e instanceof ArchiveError) throw e;
    throw new ArchiveError('unreadable');
  }

  const taken = new Set<string>();
  const result: ArchiveEntry[] = [];
  // When the same path appears repeatedly in the ZIP, fflate keeps only the last one; only one is output here as well.
  for (const path of new Set(order)) {
    const data = files[path];
    if (!data) continue;
    const base = path.replace(/\\/g, '/').split('/').pop() ?? '';
    const name = uniqueName(sanitizeName(base), taken);
    result.push({ name, bytes: data, mimeType: mimeTypeOfName(name) });
  }
  if (result.length === 0) throw new ArchiveError('empty');
  return result;
}
