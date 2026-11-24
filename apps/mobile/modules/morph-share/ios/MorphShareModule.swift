import ExpoModulesCore
import QuickLook
import UIKit
import UniformTypeIdentifiers

// iOS implementation for sharing and saving to folders (D-119, D-120):
// - Sharing: UIActivityViewController with all files at once (WeChat, WhatsApp, Mail, AirDrop, Save
// to Files, etc.).
// - Save to folder: UIDocumentPickerViewController lets the user select a folder (can create a new
// one; file providers such as iCloud Drive, Google Drive, Dropbox, etc. are synchronized by their
// own apps), then uses NSFileCoordinator to copy files in, appending a sequence number on name
// collisions. Does not use export mode: simulator tests showed that when a file with the same name
// already exists in the folder, the export picker returns OSStatus -8072 and saves nothing.
// Remembers the last-selected folder (P-019, D-123): saves as a security-scoped bookmark
// (UserDefaults) so it can be saved directly next time; if the folder is gone, prompts the user to
// select it again. Each quick action records its own folder (D-196): saves a separate map of "quick
// action ID -> bookmark"; if none exists yet, uses the last-selected one and records it for this
// action.
// - Preview (D-238): QLPreviewController displays a file on the inbox page (PDF, office documents,
// etc.) with system-provided zoom and paging. Morph only passes local files to the system UI and
// user-selected folders, without network access.

final class PresenterMissingException: Exception, @unchecked Sendable {
  override var reason: String { "There is no screen to show the sheet on" }
}

final class SheetBusyException: Exception, @unchecked Sendable {
  override var reason: String { "Another share or save sheet is open" }
}

final class FolderNotWritableException: Exception, @unchecked Sendable {
  override var code: String { "ERR_FOLDER_NOT_WRITABLE" }
  override var reason: String { "Files can't be saved into this folder" }
}

final class ExportFailedException: GenericException<String>, @unchecked Sendable {
  override var reason: String { "Saving failed: \(param)" }
}

private let folderBookmarkKey = "morph.share.folderBookmark"
private let folderBookmarksKey = "morph.share.folderBookmarks"

public class MorphShareModule: Module {
  private var folderDelegate: FolderDelegate?
  private var previewSource: PreviewSource?
  private var busy = false

  public func definition() -> ModuleDefinition {
    Name("MorphShare")

    AsyncFunction("shareFiles") { (uris: [URL], _: [String], promise: Promise) in
      self.presentSheet(uris, promise: promise)
    }
    .runOnQueue(DispatchQueue.main)

    // Hand over to another AI app (D-611): a piece of text (prompt) is placed into the share sheet along with files; the receiving app puts the text into its input field and the files as attachments.
    AsyncFunction("shareFilesWithText") { (text: String, uris: [URL], _: [String], promise: Promise) in
      self.presentSheet([text] + uris, promise: promise)
    }
    .runOnQueue(DispatchQueue.main)

    // Returns immediately after opening the system preview without waiting for the user to close
    // it; mimeType is for Android only. name is the original file name: the copy saved by the share
    // extension has a UUID file name, so the title must display the original one.
    AsyncFunction("previewFile") { (uri: URL, _: String, name: String, promise: Promise) in
      guard let presenter = self.appContext?.utilities?.currentViewController() else {
        promise.reject(PresenterMissingException())
        return
      }
      let source = PreviewSource(uri, title: name)
      self.previewSource = source
      let preview = QLPreviewController()
      preview.dataSource = source
      presenter.present(preview, animated: true)
      promise.resolve(nil)
    }
    .runOnQueue(DispatchQueue.main)

    Function("rememberedFolder") { (key: String) -> String? in
      Self.rememberedFolder(for: key, adopt: false)?.lastPathComponent
    }

    Function("forgetFolders") { (keep: [String]) in
      let kept = Self.bookmarks().filter { keep.contains($0.key) }
      UserDefaults.standard.set(kept, forKey: folderBookmarksKey)
    }

    // Exclude Tinkrum data from system backup (D-599): marks these directories as excluded from
    // backup (both iCloud backup and computer backups skip all contents within the directories).
    // Marked on the directory level: when a file is completely replaced, file-level marks are lost,
    // but directory-level marks are retained. Skips any that cannot be marked without blocking
    // startup.
    AsyncFunction("excludeFromBackup") { (uris: [URL]) in
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      for var uri in uris {
        try? uri.setResourceValues(values)
      }
    }

    // mimeTypes is for Android only. useRemembered: if a remembered folder exists, saves directly into it without displaying a picker. key: quick action ID.
    AsyncFunction("exportFiles") { (uris: [URL], names: [String], _: [String], useRemembered: Bool, key: String, promise: Promise) in
      guard !self.busy else {
        promise.reject(SheetBusyException())
        return
      }
      if useRemembered, let folder = Self.rememberedFolder(for: key, adopt: true) {
        Self.copyInBackground(uris, names: names, into: folder, promise: promise)
        return
      }
      guard let presenter = self.appContext?.utilities?.currentViewController() else {
        promise.reject(PresenterMissingException())
        return
      }
      let picker = UIDocumentPickerViewController(forOpeningContentTypes: [UTType.folder], asCopy: false)
      // Clears folderDelegate upon completion to break the self <-> delegate reference cycle.
      let delegate = FolderDelegate { folder in
        self.folderDelegate = nil
        self.busy = false
        guard let folder else {
          promise.resolve(nil)
          return
        }
        Self.remember(folder, for: key)
        Self.copyInBackground(uris, names: names, into: folder, promise: promise)
      }
      self.folderDelegate = delegate
      picker.delegate = delegate
      picker.presentationController?.delegate = delegate
      Self.anchor(picker, on: presenter)
      self.busy = true
      presenter.present(picker, animated: true)
    }
    .runOnQueue(DispatchQueue.main)
  }

  /** Copies in the background without blocking the UI. Result: count of saved items, folder name. */
  private static func copyInBackground(_ uris: [URL], names: [String], into folder: URL, promise: Promise) {
    DispatchQueue.global(qos: .userInitiated).async {
      do {
        let saved = try copy(uris, names: names, into: folder)
        promise.resolve(["saved": saved, "folder": folder.lastPathComponent])
      } catch let error as Exception {
        promise.reject(error)
      } catch {
        promise.reject(ExportFailedException(error.localizedDescription))
      }
    }
  }

  /** Bookmarks for each quick action: quick action ID -> bookmark. */
  private static func bookmarks() -> [String: Data] {
    UserDefaults.standard.dictionary(forKey: folderBookmarksKey) as? [String: Data] ?? [:]
  }

  private static func setBookmark(_ data: Data?, for key: String) {
    var all = bookmarks()
    all[key] = data
    UserDefaults.standard.set(all, forKey: folderBookmarksKey)
  }

  /**
   * Folder for quick action key: its own folder, or the last-selected one if none exists (when
   * adopt is true, records it for this action, only recording when actually saving). Returns nil
   * if none exist, the bookmark is invalid, or the folder no longer exists (and forgets the
   * invalid one).
   */
  private static func rememberedFolder(for key: String, adopt: Bool) -> URL? {
    if let data = bookmarks()[key] {
      if let url = resolve(data, save: { setBookmark($0, for: key) }) { return url }
      setBookmark(nil, for: key)
    }
    guard let data = UserDefaults.standard.data(forKey: folderBookmarkKey) else { return nil }
    guard let url = resolve(data, save: { UserDefaults.standard.set($0, forKey: folderBookmarkKey) }) else {
      UserDefaults.standard.removeObject(forKey: folderBookmarkKey)
      return nil
    }
    if adopt { setBookmark(UserDefaults.standard.data(forKey: folderBookmarkKey), for: key) }
    return url
  }

  /** Resolves a bookmark; returns nil if the bookmark is invalid or the folder no longer exists. Uses save to store a new bookmark when expired. */
  private static func resolve(_ data: Data, save: (Data) -> Void) -> URL? {
    var stale = false
    guard let url = try? URL(resolvingBookmarkData: data, options: [], relativeTo: nil, bookmarkDataIsStale: &stale),
          url.startAccessingSecurityScopedResource() else {
      return nil
    }
    defer { url.stopAccessingSecurityScopedResource() }
    // Bookmarks follow folders: can also be resolved when moved to the Recently Deleted folder (.Trash), in which case it is treated as if the folder no longer exists.
    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory), isDirectory.boolValue,
          !url.pathComponents.contains(".Trash") else {
      return nil
    }
    if stale, let fresh = try? url.bookmarkData() {
      save(fresh)
    }
    return url
  }

  /** Record for this quick action, and also remember as the last picked one. */
  private static func remember(_ folder: URL, for key: String) {
    guard folder.startAccessingSecurityScopedResource() else { return }
    defer { folder.stopAccessingSecurityScopedResource() }
    if let data = try? folder.bookmarkData() {
      UserDefaults.standard.set(data, forKey: folderBookmarkKey)
      setBookmark(data, for: key)
    }
  }

  private static func copy(_ sources: [URL], names: [String], into folder: URL) throws -> Int {
    guard folder.startAccessingSecurityScopedResource() else { throw FolderNotWritableException() }
    defer { folder.stopAccessingSecurityScopedResource() }
    let coordinator = NSFileCoordinator()
    for (i, source) in sources.enumerated() {
      let dest = freeURL(in: folder, name: i < names.count ? names[i] : source.lastPathComponent)
      var coordinatorError: NSError?
      var copyError: Error?
      // File providers such as iCloud Drive require file coordination when writing.
      coordinator.coordinate(writingItemAt: dest, options: .forReplacing, error: &coordinatorError) { url in
        do {
          try FileManager.default.copyItem(at: source, to: url)
        } catch {
          copyError = error
        }
      }
      if let error = coordinatorError ?? copyError {
        let code = (error as NSError).code
        if code == NSFileWriteNoPermissionError || code == NSFileWriteVolumeReadOnlyError {
          throw FolderNotWritableException()
        }
        throw ExportFailedException(error.localizedDescription)
      }
    }
    return sources.count
  }

  /** Do not overwrite existing files: when "report.pdf" is occupied, tries "report 2.pdf", "report 3.pdf", etc., sequentially (same as the Files app). */
  private static func freeURL(in dir: URL, name: String) -> URL {
    let base = (name as NSString).deletingPathExtension
    let ext = (name as NSString).pathExtension
    var url = dir.appendingPathComponent(name)
    var n = 2
    while FileManager.default.fileExists(atPath: url.path) {
      let candidate = ext.isEmpty ? "\(base) \(n)" : "\(base) \(n).\(ext)"
      url = dir.appendingPathComponent(candidate)
      n += 1
    }
    return url
  }

  /** Opens the share sheet once; returns after the sheet is dismissed. */
  private func presentSheet(_ items: [Any], promise: Promise) {
    guard !busy else {
      promise.reject(SheetBusyException())
      return
    }
    guard let presenter = appContext?.utilities?.currentViewController() else {
      promise.reject(PresenterMissingException())
      return
    }
    let sheet = UIActivityViewController(activityItems: items, applicationActivities: nil)
    sheet.completionWithItemsHandler = { _, _, _, _ in
      self.busy = false
      promise.resolve(nil)
    }
    Self.anchor(sheet, on: presenter)
    busy = true
    presenter.present(sheet, animated: true)
  }

  /** Displays as a popover on iPad, requiring a designated anchor location (center of the screen). */
  private static func anchor(_ controller: UIViewController, on presenter: UIViewController) {
    guard let popover = controller.popoverPresentationController else { return }
    popover.sourceView = presenter.view
    popover.sourceRect = CGRect(x: presenter.view.bounds.midX, y: presenter.view.bounds.midY, width: 0, height: 0)
    popover.permittedArrowDirections = []
  }
}

final class FolderDelegate: NSObject, UIDocumentPickerDelegate, UIAdaptivePresentationControllerDelegate {
  private var onDone: ((URL?) -> Void)?

  init(onDone: @escaping (URL?) -> Void) {
    self.onDone = onDone
  }

  private func finish(_ folder: URL?) {
    onDone?(folder)
    onDone = nil
  }

  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    finish(urls.first)
  }

  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    finish(nil)
  }

  // Swiping down to dismiss the picker is also treated as a cancellation.
  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
    finish(nil)
  }
}

final class PreviewItem: NSObject, QLPreviewItem {
  let previewItemURL: URL?
  let previewItemTitle: String?

  init(_ url: URL, title: String) {
    previewItemURL = url
    previewItemTitle = title
  }
}

final class PreviewSource: NSObject, QLPreviewControllerDataSource {
  private let item: PreviewItem

  init(_ url: URL, title: String) {
    item = PreviewItem(url, title: title)
  }

  func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }

  func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
    item
  }
}
