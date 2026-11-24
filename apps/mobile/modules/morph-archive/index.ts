import { requireOptionalNativeModule } from 'expo';

// Local Expo module MorphArchive (D-600): ZIP read/write used for full export and restore. iOS uses
// ios/MorphArchiveModule.swift + ZipCodec.swift (Foundation, Compression), Android uses
// android/.../MorphArchiveModule.kt + ZipCodec.kt (java.util.zip's Deflater/Inflater/CRC32). Both
// sides follow the same rules: read-as-you-write, no memory buffering, Zip64 for files > 4 GB,
// validate entry-by-entry before reading. Local files only, no networking. Null in Expo Go and
// tests.

/** Contents to write into the archive: a directory (with all its files placed under prefix/), a file, or a text string. */
export type ArchiveSource =
  { dir: string; prefix: string } | { file: string; name: string } | { text: string; name: string };

export interface ArchiveEntry {
  name: string;
  size: number;
}

export interface MorphArchiveModule {
  /** Number of files and total bytes in these directories (file://); does not follow symbolic links. */
  scanTree(uris: readonly string[]): Promise<{ files: number; bytes: number }>;
  /**
   * Write a standard ZIP to dest. Compress databases and text; store already compressed files
   * (photos, videos, PDFs, etc.) without recompression; use Zip64 if > 4 GB. Delete unfinished
   * files on error or cancellation. Returns entry count and archive size.
   */
  createArchive(
    dest: string,
    sources: readonly ArchiveSource[],
  ): Promise<{ entries: number; bytes: number }>;
  /**
   * Read the archive directory and validate each entry without extracting. src can be file:// or
   * (on Android) content://; will not be copied, moved, or deleted. Returns each file's name and
   * size, plus the contents of tinkrum-backup.json (null if absent or > 1 MB). Throws
   * corresponding error codes for non-zip (ERR_ARCHIVE_NOT_ZIP), damaged or truncated directory
   * (ERR_ARCHIVE_DAMAGED), unsafe names or symbolic links (ERR_ARCHIVE_UNSAFE), or
   * encrypted/unsupported compression methods (ERR_ARCHIVE_UNSUPPORTED).
   */
  inspectArchive(
    src: string,
  ): Promise<{ entries: ArchiveEntry[]; bytes: number; manifest: string | null }>;
  /**
   * Extract the archive to dest (must not exist yet; will be created). Verify size and checksum
   * during extraction; delete the entire dest directory on error or cancellation. Possible error
   * codes are the same as inspectArchive, plus ERR_ARCHIVE_NO_SPACE and ERR_ARCHIVE_CANCELLED.
   */
  extractArchive(src: string, dest: string): Promise<{ files: number; bytes: number }>;
  /** Stop ongoing work at the next data chunk; its Promise finishes with ERR_ARCHIVE_CANCELLED, and unfinished files are deleted. */
  cancel(): void;
  /** Rename/move a directory (in the same volume, instantaneous, no copy); 'to' must not exist yet, otherwise throws ERR_ARCHIVE_IO. */
  moveTree(from: string, to: string): Promise<void>;
  /** Delete a directory on a background thread (avoids UI freezes when large). Does not throw if the directory is missing. */
  removeTree(uri: string): Promise<void>;
  addListener(
    event: 'onProgress',
    listener: (e: { phase: 'write' | 'extract'; done: number; total: number }) => void,
  ): { remove(): void };
}

export default requireOptionalNativeModule<MorphArchiveModule>('MorphArchive');
