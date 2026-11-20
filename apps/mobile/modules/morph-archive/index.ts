import { requireOptionalNativeModule } from 'expo';

// 本地 Expo 模块 MorphArchive（D-600）：整体导出和恢复用的 zip 读写。
// iOS 是 ios/MorphArchiveModule.swift + ZipCodec.swift（Foundation、Compression），Android 是 android/…/MorphArchiveModule.kt + ZipCodec.kt
// （java.util.zip 的 Deflater/Inflater/CRC32）。两边是同一套规则：边读边写、不进内存、超过 4 GB 用 Zip64、读之前先逐条检查。
// 只用本机文件，不联网。Expo Go 和测试里是 null。

/** 写进压缩包的东西：一个目录（里面所有文件放在 prefix/ 下）、一个文件，或一段文字。 */
export type ArchiveSource =
  { dir: string; prefix: string } | { file: string; name: string } | { text: string; name: string };

export interface ArchiveEntry {
  name: string;
  size: number;
}

export interface MorphArchiveModule {
  /** 这些目录（file://）里有多少个文件、一共多少字节；不跟随符号链接。 */
  scanTree(uris: readonly string[]): Promise<{ files: number; bytes: number }>;
  /**
   * 写一个标准 zip 到 dest。数据库和文本压缩，照片、视频、PDF 等已经压缩过的只存不压；超过 4 GB 用 Zip64。
   * 出错或取消时删掉没写完的文件。返回条目数和压缩包大小。
   */
  createArchive(
    dest: string,
    sources: readonly ArchiveSource[],
  ): Promise<{ entries: number; bytes: number }>;
  /**
   * 读压缩包的目录并逐条检查，不解压。src 可以是 file:// 或（Android）content://，不会被复制、移动或删除。
   * 返回每个文件的名字和大小，和 tinkrum-backup.json 的内容（没有、或大于 1 MB 时为 null）。
   * 不是 zip（ERR_ARCHIVE_NOT_ZIP）、目录坏了或被截断（ERR_ARCHIVE_DAMAGED）、名字不安全或有符号链接
   * （ERR_ARCHIVE_UNSAFE）、加密或不认识的压缩方式（ERR_ARCHIVE_UNSUPPORTED）时抛出对应代码的错误。
   */
  inspectArchive(
    src: string,
  ): Promise<{ entries: ArchiveEntry[]; bytes: number; manifest: string | null }>;
  /**
   * 把压缩包解到 dest（必须还不存在，会创建）。解的时候核对大小和校验和；出错或取消时 dest 整个删掉。
   * 可能的错误代码同 inspectArchive，另有 ERR_ARCHIVE_NO_SPACE、ERR_ARCHIVE_CANCELLED。
   */
  extractArchive(src: string, dest: string): Promise<{ files: number; bytes: number }>;
  /** 让正在做的事在下一块数据处停下；它的 Promise 以 ERR_ARCHIVE_CANCELLED 结束，没写完的文件已删掉。 */
  cancel(): void;
  /** 改名移动一个目录（同一个卷里，瞬间完成，不复制）；to 必须还不存在，否则抛 ERR_ARCHIVE_IO。 */
  moveTree(from: string, to: string): Promise<void>;
  /** 在后台线程删掉一个目录（很大时不卡界面）。目录不在也不报错。 */
  removeTree(uri: string): Promise<void>;
  addListener(
    event: 'onProgress',
    listener: (e: { phase: 'write' | 'extract'; done: number; total: number }) => void,
  ): { remove(): void };
}

export default requireOptionalNativeModule<MorphArchiveModule>('MorphArchive');
