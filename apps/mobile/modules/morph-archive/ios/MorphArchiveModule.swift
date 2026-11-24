import ExpoModulesCore
import Foundation

// iOS implementation of full export and restore (D-600): write directories and files into a
// standard ZIP, and safely extract a ZIP to a directory. Both read and write are streaming
// (ZipCodec.swift) without loading files into memory; one task at a time; cancel() stops ongoing
// work at the next data chunk, deletes unfinished files, and terminates with ERR_ARCHIVE_CANCELLED.
// Local files only, no networking. File names and contents are not logged.

final class ArchiveException: Exception, @unchecked Sendable {
  private let errorCode: String
  private let detail: String

  init(_ code: String, _ detail: String) {
    errorCode = code
    self.detail = detail
    super.init()
  }

  override var code: String { errorCode }
  override var reason: String { detail }
}

private struct Item {
  let name: String
  let url: URL?
  let bytes: Data?
  let size: UInt64
  let modified: Date
}

private let manifestName = "tinkrum-backup.json"
private let manifestMaxBytes: UInt64 = 1 << 20

public class MorphArchiveModule: Module {
  private let lock = NSLock()
  private var cancelRequested = false
  private var running = false

  public func definition() -> ModuleDefinition {
    Name("MorphArchive")
    Events("onProgress")

    Function("cancel") {
      self.lock.lock()
      self.cancelRequested = true
      self.lock.unlock()
    }

    // Number of files and total bytes in these directories (does not follow symlinks).
    AsyncFunction("scanTree") { (uris: [URL], promise: Promise) in
      self.perform(promise) {
        var files = 0
        var bytes: UInt64 = 0
        for uri in uris {
          for item in try Self.walk(uri, prefix: "") {
            files += 1
            bytes += item.size
          }
        }
        let result: [String: Any] = ["files": files, "bytes": Double(bytes)]
        return result
      }
    }

    // sources: all files in directory { dir, prefix } placed under prefix/; single file { file, name }; text block { text, name }.
    AsyncFunction("createArchive") { (dest: URL, sources: [[String: Any]], promise: Promise) in
      self.perform(promise) {
        var items: [Item] = []
        for source in sources {
          if let text = source["text"] as? String, let name = source["name"] as? String {
            let bytes = Data(text.utf8)
            items.append(Item(name: name, url: nil, bytes: bytes, size: UInt64(bytes.count), modified: Date()))
          } else if let file = source["file"] as? String, let name = source["name"] as? String,
            let url = URL(string: file)
          {
            let values = try? url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey])
            items.append(
              Item(
                name: name, url: url, bytes: nil, size: UInt64(values?.fileSize ?? 0),
                modified: values?.contentModificationDate ?? Date()))
          } else if let dir = source["dir"] as? String, let url = URL(string: dir) {
            items += try Self.walk(url, prefix: source["prefix"] as? String ?? "")
          }
        }
        return try self.write(items, to: dest)
      }
    }

    // Reads archive directory and inspects entries sequentially (without extraction): name,
    // symlink, encryption, compression method, size. Returns name and size for each file, along
    // with tinkrum-backup.json content (null if absent).
    AsyncFunction("inspectArchive") { (src: URL, promise: Promise) in
      self.perform(promise) {
        try Self.withReading(src) { url -> [String: Any] in
          let reader = try ZipReader(url: url)
          defer { reader.close() }
          try reader.load()
          var manifest: String?
          if let entry = reader.entries.first(where: { $0.name == manifestName }), entry.size <= manifestMaxBytes {
            let temp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            defer { try? FileManager.default.removeItem(at: temp) }
            try reader.extract(entry, to: temp, shouldCancel: { self.isCancelled }, progress: { _ in })
            manifest = String(data: try Data(contentsOf: temp), encoding: .utf8)
          }
          var bytes: UInt64 = 0
          let list = reader.entries.map { e -> [String: Any] in
            bytes += e.size
            return ["name": e.name, "size": Double(e.size)]
          }
          let result: [String: Any] = ["entries": list, "bytes": Double(bytes), "manifest": manifest as Any]
          return result
        }
      }
    }

    // Extracts archive to dest (which must not yet exist). On error or cancellation, dest is completely deleted.
    AsyncFunction("extractArchive") { (src: URL, dest: URL, promise: Promise) in
      self.perform(promise) {
        let fm = FileManager.default
        if fm.fileExists(atPath: dest.path) { throw ArchiveException("ERR_ARCHIVE_IO", "destination exists") }
        do {
          try fm.createDirectory(at: dest, withIntermediateDirectories: true)
          let result = try Self.withReading(src) { url -> [String: Any] in
            let reader = try ZipReader(url: url)
            defer { reader.close() }
            try reader.load()
            var total: UInt64 = 0
            for e in reader.entries { total += e.size }
            let base = dest.standardizedFileURL.path + "/"
            var done: UInt64 = 0
            var lastReport = Date.distantPast
            for entry in reader.entries {
              var target = dest
              for part in entry.name.split(separator: "/") { target = target.appendingPathComponent(String(part)) }
              // The extracted path must reside inside dest (names already checked, blocked here as a secondary safeguard).
              guard target.standardizedFileURL.path.hasPrefix(base) else { throw ZipFail.unsafe("path") }
              try reader.extract(
                entry, to: target, shouldCancel: { self.isCancelled },
                progress: { _ in })
              done += entry.size
              if Date().timeIntervalSince(lastReport) > 0.25 {
                lastReport = Date()
                self.sendEvent("onProgress", ["phase": "extract", "done": Double(done), "total": Double(total)])
              }
            }
            return ["files": reader.entries.count, "bytes": Double(total)]
          }
          return result
        } catch {
          try? fm.removeItem(at: dest)
          throw error
        }
      }
    }

    // Rename/move (in the same volume, instantaneous, no copy): 'to' must not exist yet. Used when changing data directory during restore.
    AsyncFunction("moveTree") { (from: URL, to: URL, promise: Promise) in
      DispatchQueue.global(qos: .utility).async {
        do {
          try FileManager.default.moveItem(at: from, to: to)
          promise.resolve(nil)
        } catch {
          promise.reject(ArchiveException("ERR_ARCHIVE_IO", error.localizedDescription))
        }
      }
    }

    AsyncFunction("removeTree") { (uri: URL, promise: Promise) in
      DispatchQueue.global(qos: .utility).async {
        try? FileManager.default.removeItem(at: uri)
        promise.resolve(nil)
      }
    }
  }

  private var isCancelled: Bool {
    lock.lock()
    defer { lock.unlock() }
    return cancelRequested
  }

  /// Do only one thing at a time; run on a background thread; replace errors with code-bearing exceptions.
  private func perform(_ promise: Promise, _ body: @escaping () throws -> Any?) {
    lock.lock()
    if running {
      lock.unlock()
      promise.reject(ArchiveException("ERR_ARCHIVE_BUSY", "Another archive operation is running"))
      return
    }
    running = true
    cancelRequested = false
    lock.unlock()
    DispatchQueue.global(qos: .userInitiated).async {
      defer {
        self.lock.lock()
        self.running = false
        self.lock.unlock()
      }
      do {
        promise.resolve(try body())
      } catch {
        promise.reject(Self.exception(error))
      }
    }
  }

  private static func exception(_ error: Error) -> Exception {
    if let e = error as? Exception { return e }
    guard let fail = error as? ZipFail else { return ArchiveException("ERR_ARCHIVE_IO", error.localizedDescription) }
    switch fail {
    case .cancelled: return ArchiveException("ERR_ARCHIVE_CANCELLED", "Cancelled")
    case .notZip: return ArchiveException("ERR_ARCHIVE_NOT_ZIP", "Not a zip archive")
    case .damaged(let d): return ArchiveException("ERR_ARCHIVE_DAMAGED", d)
    case .unsupported(let d): return ArchiveException("ERR_ARCHIVE_UNSUPPORTED", d)
    case .unsafe(let d): return ArchiveException("ERR_ARCHIVE_UNSAFE", d)
    case .noSpace: return ArchiveException("ERR_ARCHIVE_NO_SPACE", "Not enough free space")
    case .io(let d): return ArchiveException("ERR_ARCHIVE_IO", d)
    }
  }

  /// Files in iCloud Drive that have not been downloaded yet require file coordination before downloading; original item URLs obtained from pickers must first be accessed within a security-scoped resource.
  private static func withReading<T>(_ url: URL, _ body: (URL) throws -> T) throws -> T {
    let scoped = url.startAccessingSecurityScopedResource()
    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
    var coordinationError: NSError?
    var result: Result<T, Error>?
    NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &coordinationError) { readable in
      result = Result { try body(readable) }
    }
    if let coordinationError { throw ZipFail.io(coordinationError.localizedDescription) }
    guard let result else { throw ZipFail.io("coordination") }
    return try result.get()
  }

  /// All regular files in the directory (including those starting with .), sorted by name; ignore symbolic links and other special files.
  private static func walk(_ dir: URL, prefix: String) throws -> [Item] {
    var items: [Item] = []
    let keys: Set<URLResourceKey> = [.isRegularFileKey, .isDirectoryKey, .isSymbolicLinkKey, .fileSizeKey, .contentModificationDateKey]
    func visit(_ url: URL, _ relative: String) throws {
      guard let children = try? FileManager.default.contentsOfDirectory(at: url, includingPropertiesForKeys: Array(keys)) else {
        return
      }
      for child in children.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
        let name = relative.isEmpty ? child.lastPathComponent : relative + "/" + child.lastPathComponent
        guard let values = try? child.resourceValues(forKeys: keys) else { continue }
        if values.isSymbolicLink == true { continue }
        if values.isDirectory == true {
          try visit(child, name)
        } else if values.isRegularFile == true {
          items.append(
            Item(
              name: name, url: child, bytes: nil, size: UInt64(values.fileSize ?? 0),
              modified: values.contentModificationDate ?? Date()))
        }
      }
    }
    guard FileManager.default.fileExists(atPath: dir.path) else { return [] }
    try visit(dir, prefix.hasSuffix("/") ? String(prefix.dropLast()) : prefix)
    return items
  }

  private func write(_ items: [Item], to dest: URL) throws -> [String: Any] {
    let total = items.reduce(UInt64(0)) { $0 + $1.size }
    let writer = try ZipWriter(url: dest)
    var lastReport = Date.distantPast
    do {
      for item in items {
        if let bytes = item.bytes {
          try writer.addBytes(name: item.name, bytes: bytes, modified: item.modified, shouldCancel: { self.isCancelled })
          continue
        }
        guard let url = item.url, let handle = try? FileHandle(forReadingFrom: url) else {
          throw ZipFail.io("read")
        }
        defer { try? handle.close() }
        try writer.add(
          name: item.name, size: item.size, modified: item.modified, store: zipShouldStore(item.name),
          read: {
            do {
              return try handle.read(upToCount: zipChunk) ?? Data()
            } catch {
              throw ZipFail.io(error.localizedDescription)
            }
          },
          shouldCancel: { self.isCancelled },
          progress: { done in
            if Date().timeIntervalSince(lastReport) > 0.25 {
              lastReport = Date()
              self.sendEvent("onProgress", ["phase": "write", "done": Double(done), "total": Double(total)])
            }
          })
      }
      try writer.finish()
    } catch {
      writer.abort()
      try? FileManager.default.removeItem(at: dest)
      throw error
    }
    let size = (try? FileManager.default.attributesOfItem(atPath: dest.path)[.size] as? UInt64) ?? 0
    return ["entries": items.count, "bytes": Double(size)]
  }
}
