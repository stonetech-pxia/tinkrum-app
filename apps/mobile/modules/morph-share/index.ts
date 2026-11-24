import { requireOptionalNativeModule } from 'expo';

// Local Expo module MorphShare (D-119, D-120, D-123, D-196): share multiple files at once, save
// files into a folder selected by the user in "Files". iOS is ios/MorphShareModule.swift
// (UIActivityViewController, UIDocumentPickerViewController for folder selection), Android is
// android/.../MorphShareModule.kt (ACTION_SEND_MULTIPLE, Storage Access Framework). Uses system
// frameworks only, no network. Null in Expo Go and tests, callers fall back to individual sharing /
// expo-file-system folder selection.

export interface SavedToFolder {
  saved: number;
  /** Display name of the folder (shown to user, not sent to AI). */
  folder: string;
}

export interface MorphShareModule {
  /** Opens the system share sheet once with all files (local file:// URIs); returns after the sheet is dismissed. */
  shareFiles(uris: readonly string[], mimeTypes: readonly string[]): Promise<void>;
  /**
   * Hand off to other AI apps (D-611): same as shareFiles, with an additional text snippet
   * (prompt) which the receiving app puts into its input box. Older dev builds predating this
   * feature lack it, callers fall back to sending text only.
   */
  shareFilesWithText?(
    text: string,
    uris: readonly string[],
    mimeTypes: readonly string[],
  ): Promise<void>;
  /**
   * Name of the folder (D-196) that this quick action (key) will save to: its own remembered one,
   * falling back to the last picked one (D-123); null if neither exists, or if the folder no
   * longer exists / permission was revoked.
   */
  rememberedFolder(key: string): string | null;
  /**
   * Copies files into a folder: saves directly if useRemembered is true and a remembered folder
   * exists (this quick action's own, falling back to the last picked one which is then recorded),
   * otherwise prompts the user to select one (iCloud Drive, Google Drive, and other "Files"
   * providers are supported), records it for this quick action and as the last picked one. names
   * are filenames (including extension); does not overwrite existing files with the same name in
   * the folder (iOS appends " 2", Android renamed by document provider). Returns count of saved
   * files and folder name; returns null if cancelled by user. Throws an error with code
   * ERR_FOLDER_NOT_WRITABLE when the folder is not writable.
   */
  exportFiles(
    uris: readonly string[],
    names: readonly string[],
    mimeTypes: readonly string[],
    useRemembered: boolean,
    key: string,
  ): Promise<SavedToFolder | null>;
  /**
   * Open a file using the system preview (D-238): on iOS uses QuickLook (title uses name,
   * replacing the original file name); on Android, copies it to the cache and passes it to an app
   * capable of opening it, then returns immediately. On Android, throws an error with code
   * ERR_NO_VIEWER if no app can open it, or ERR_PREVIEW_FAILED if the file cannot be read.
   */
  previewFile(uri: string, mimeType: string, name: string): Promise<void>;
  /** Forget the folders of quick actions that are no longer in keep (the quick actions have been deleted); leaves the last-selected folder untouched. */
  forgetFolders(keep: readonly string[]): void;
  /**
   * Mark these directories (file:// URIs) to be excluded from system backup (D-599; iOS only:
   * both iCloud backup and computer backups skip all contents within the directories). Skips any
   * that cannot be marked. On Android, allowBackup is disabled in app.json and this function does
   * not exist.
   */
  excludeFromBackup?(uris: readonly string[]): Promise<void>;
}

export default requireOptionalNativeModule<MorphShareModule>('MorphShare');
