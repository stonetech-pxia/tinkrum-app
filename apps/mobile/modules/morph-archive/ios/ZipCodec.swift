import Compression
import Foundation

// zip 的读写（D-600），不依赖 Expo，可以单独编译测试（tests/）。
// - 写：边读边写，不把文件读进内存；单个文件和整个压缩包超过 4 GB 时用 Zip64。已经压缩过的文件（照片、视频、PDF 等）
//   只存不压，数据库和文本才压。每个文件写完后回头补本地头里的校验和与大小，所以不用数据描述符。
// - 读：先读中央目录并逐条检查（名字、符号链接、加密、压缩方式、大小），全部通过才解压；解压时边解边数字节，
//   超过声明的大小就停（防压缩炸弹），最后核对校验和。名字不安全、有符号链接的包整个拒绝。
// 取消：每读一块问一次 shouldCancel；取消、出错时由调用方删掉没写完的文件。

// 系统的 libz 里的 crc32（podspec 链接了 -lz）。
@_silgen_name("crc32")
private func zlibCrc32(_ crc: UInt, _ buf: UnsafePointer<UInt8>?, _ len: UInt32) -> UInt

enum ZipFail: Error, Equatable {
  case cancelled
  case notZip
  case damaged(String)
  case unsupported(String)
  case unsafe(String)
  case noSpace
  case io(String)
}

let zipChunk = 1 << 20
let zipMaxEntries = 2_000_000
let zipMaxCentralBytes: UInt64 = 1 << 29
let zipMaxNameBytes = 4096
/** 比这小的单个文件不用 Zip64（留出余量，压缩后略大也不会超过 4 GB）。 */
let zipBigFile: UInt64 = 0xF000_0000

/** 已经是压缩格式的文件：只存不压。 */
let zipStoredExtensions: Set<String> = [
  "jpg", "jpeg", "png", "heic", "heif", "webp", "gif", "avif", "jp2",
  "mp4", "mov", "m4v", "m4a", "mp3", "aac", "opus", "ogg", "flac", "webm", "mkv",
  "pdf", "zip", "docx", "xlsx", "pptx", "gz", "7z",
]

func zipShouldStore(_ name: String) -> Bool {
  let ext = (name as NSString).pathExtension.lowercased()
  return zipStoredExtensions.contains(ext)
}

// MARK: - 小工具

private func put16(_ d: inout Data, _ v: UInt16) {
  d.append(UInt8(v & 0xFF))
  d.append(UInt8(v >> 8))
}

private func put32(_ d: inout Data, _ v: UInt32) {
  for i in 0..<4 { d.append(UInt8((v >> (8 * UInt32(i))) & 0xFF)) }
}

private func put64(_ d: inout Data, _ v: UInt64) {
  for i in 0..<8 { d.append(UInt8((v >> (8 * UInt64(i))) & 0xFF)) }
}

private func get16(_ d: Data, _ o: Int) -> UInt16 {
  UInt16(d[d.startIndex + o]) | UInt16(d[d.startIndex + o + 1]) << 8
}

private func get32(_ d: Data, _ o: Int) -> UInt32 {
  var v: UInt32 = 0
  for i in 0..<4 { v |= UInt32(d[d.startIndex + o + i]) << (8 * UInt32(i)) }
  return v
}

private func get64(_ d: Data, _ o: Int) -> UInt64 {
  var v: UInt64 = 0
  for i in 0..<8 { v |= UInt64(d[d.startIndex + o + i]) << (8 * UInt64(i)) }
  return v
}

private func crcUpdate(_ crc: UInt32, _ data: Data) -> UInt32 {
  data.withUnsafeBytes { raw -> UInt32 in
    guard let base = raw.bindMemory(to: UInt8.self).baseAddress, raw.count > 0 else { return crc }
    var c = UInt(crc)
    var offset = 0
    while offset < raw.count {
      let n = min(raw.count - offset, 1 << 30)
      c = zlibCrc32(c, base + offset, UInt32(n))
      offset += n
    }
    return UInt32(truncatingIfNeeded: c)
  }
}

private func dosDateTime(_ date: Date) -> (time: UInt16, date: UInt16) {
  let c = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
  let year = max(1980, min(2107, c.year ?? 1980))
  let time = UInt16((c.hour ?? 0) << 11 | (c.minute ?? 0) << 5 | ((c.second ?? 0) / 2))
  let day = UInt16((year - 1980) << 9 | (c.month ?? 1) << 5 | (c.day ?? 1))
  return (time, day)
}

// MARK: - 压缩流（Compression 框架的 ZLIB 是不带头的 deflate）

final class Flate {
  private var stream: compression_stream
  private let dst: UnsafeMutablePointer<UInt8>
  private let capacity = 1 << 18

  init(encode: Bool) throws {
    dst = UnsafeMutablePointer<UInt8>.allocate(capacity: capacity)
    stream = compression_stream(dst_ptr: dst, dst_size: 0, src_ptr: UnsafePointer(dst), src_size: 0, state: nil)
    let op = encode ? COMPRESSION_STREAM_ENCODE : COMPRESSION_STREAM_DECODE
    guard compression_stream_init(&stream, op, COMPRESSION_ZLIB) == COMPRESSION_STATUS_OK else {
      dst.deallocate()
      throw ZipFail.io("compression")
    }
  }

  deinit {
    compression_stream_destroy(&stream)
    dst.deallocate()
  }

  /// 喂一块数据；产出交给 sink。final 为 true 表示这是最后一块。返回 true 表示压缩流已经结束。
  func process(_ input: Data, final: Bool, sink: (UnsafeBufferPointer<UInt8>) throws -> Void) throws -> Bool {
    var ended = false
    try input.withUnsafeBytes { (raw: UnsafeRawBufferPointer) throws -> Void in
      let base = raw.bindMemory(to: UInt8.self).baseAddress
      stream.src_ptr = base.map { UnsafePointer($0) } ?? UnsafePointer(dst)
      stream.src_size = raw.count
      let flags = final ? Int32(COMPRESSION_STREAM_FINALIZE.rawValue) : 0
      while true {
        stream.dst_ptr = dst
        stream.dst_size = capacity
        let status = compression_stream_process(&stream, flags)
        let produced = capacity - stream.dst_size
        if produced > 0 { try sink(UnsafeBufferPointer(start: dst, count: produced)) }
        if status == COMPRESSION_STATUS_END {
          ended = true
          return
        }
        if status != COMPRESSION_STATUS_OK { throw ZipFail.damaged("deflate") }
        // 输入吃完、输出没满：这一块处理完了；最后一块要一直处理到 END（没有进展就停，免得空转）。
        if stream.src_size == 0 && stream.dst_size > 0 && (!final || produced == 0) { return }
      }
    }
    return ended
  }
}

// MARK: - 写

struct ZipCentral {
  var name: String
  var method: UInt16
  var crc: UInt32
  var compressed: UInt64
  var size: UInt64
  var offset: UInt64
  var time: UInt16
  var date: UInt16
  var local64: Bool
}

final class ZipWriter {
  private let handle: FileHandle
  private let forceZip64: Bool
  private(set) var offset: UInt64 = 0
  private var central: [ZipCentral] = []
  /// 已写进压缩包的原始字节数（给进度用）。
  private(set) var inputBytes: UInt64 = 0

  init(url: URL, forceZip64: Bool = false) throws {
    FileManager.default.createFile(atPath: url.path, contents: nil)
    guard let h = try? FileHandle(forWritingTo: url) else { throw ZipFail.io("create") }
    handle = h
    self.forceZip64 = forceZip64
  }

  private func write(_ data: Data) throws {
    do {
      try handle.write(contentsOf: data)
    } catch {
      throw Self.mapWrite(error)
    }
    offset += UInt64(data.count)
  }

  static func mapWrite(_ error: Error) -> ZipFail {
    let ns = error as NSError
    if ns.code == NSFileWriteOutOfSpaceError || ns.code == Int(ENOSPC) { return .noSpace }
    if let underlying = ns.userInfo[NSUnderlyingErrorKey] as? NSError, underlying.code == Int(ENOSPC) {
      return .noSpace
    }
    return .io(error.localizedDescription)
  }

  /// 写一个文件进去。read 每次给出下一块（空表示结束）。
  func add(
    name: String, size declared: UInt64, modified: Date, store: Bool,
    read: () throws -> Data, shouldCancel: () -> Bool, progress: (UInt64) -> Void
  ) throws {
    let nameBytes = Data(name.utf8)
    if nameBytes.count > zipMaxNameBytes { throw ZipFail.unsafe("name length") }
    let local64 = forceZip64 || declared >= zipBigFile
    let (time, date) = dosDateTime(modified)
    let start = offset
    var header = Data()
    put32(&header, 0x0403_4b50)
    put16(&header, local64 ? 45 : 20)
    put16(&header, 0x0800)
    put16(&header, store ? 0 : 8)
    put16(&header, time)
    put16(&header, date)
    put32(&header, 0)
    put32(&header, local64 ? 0xFFFF_FFFF : 0)
    put32(&header, local64 ? 0xFFFF_FFFF : 0)
    put16(&header, UInt16(nameBytes.count))
    put16(&header, local64 ? 20 : 0)
    header.append(nameBytes)
    if local64 {
      put16(&header, 1)
      put16(&header, 16)
      put64(&header, 0)
      put64(&header, 0)
    }
    try write(header)

    var crc: UInt32 = 0
    var size: UInt64 = 0
    var packed: UInt64 = 0
    let flate = store ? nil : try Flate(encode: true)
    let sink: (UnsafeBufferPointer<UInt8>) throws -> Void = { buf in
      try self.write(Data(buffer: buf))
      packed += UInt64(buf.count)
    }
    while true {
      if shouldCancel() { throw ZipFail.cancelled }
      let chunk = try read()
      if chunk.isEmpty { break }
      crc = crcUpdate(crc, chunk)
      size += UInt64(chunk.count)
      inputBytes += UInt64(chunk.count)
      if let flate {
        _ = try flate.process(chunk, final: false, sink: sink)
      } else {
        try write(chunk)
        packed += UInt64(chunk.count)
      }
      progress(inputBytes)
    }
    if let flate { _ = try flate.process(Data(), final: true, sink: sink) }

    // 补本地头里的校验和和大小。
    if size >= 0xFFFF_FFFF && !local64 { throw ZipFail.io("file grew while writing") }
    let end = offset
    var patch = Data()
    put32(&patch, crc)
    if local64 {
      put32(&patch, 0xFFFF_FFFF)
      put32(&patch, 0xFFFF_FFFF)
    } else {
      put32(&patch, UInt32(packed))
      put32(&patch, UInt32(size))
    }
    do {
      try handle.seek(toOffset: start + 14)
      try handle.write(contentsOf: patch)
      if local64 {
        var extra = Data()
        put64(&extra, size)
        put64(&extra, packed)
        try handle.seek(toOffset: start + 30 + UInt64(nameBytes.count) + 4)
        try handle.write(contentsOf: extra)
      }
      try handle.seek(toOffset: end)
    } catch {
      throw Self.mapWrite(error)
    }
    central.append(
      ZipCentral(
        name: name, method: store ? 0 : 8, crc: crc, compressed: packed, size: size,
        offset: start, time: time, date: date, local64: local64))
  }

  func addBytes(name: String, bytes: Data, modified: Date, shouldCancel: () -> Bool) throws {
    var given = false
    try add(
      name: name, size: UInt64(bytes.count), modified: modified, store: false,
      read: {
        if given { return Data() }
        given = true
        return bytes
      }, shouldCancel: shouldCancel, progress: { _ in })
  }

  /// 写中央目录和结尾，关掉文件。
  func finish() throws {
    let cdStart = offset
    for e in central {
      let nameBytes = Data(e.name.utf8)
      let big = e.local64 || e.size >= 0xFFFF_FFFF || e.compressed >= 0xFFFF_FFFF || forceZip64
      let bigOffset = e.offset >= 0xFFFF_FFFF || forceZip64
      var extra = Data()
      if big || bigOffset {
        var body = Data()
        if big {
          put64(&body, e.size)
          put64(&body, e.compressed)
        }
        if bigOffset { put64(&body, e.offset) }
        put16(&extra, 1)
        put16(&extra, UInt16(body.count))
        extra.append(body)
      }
      var rec = Data()
      put32(&rec, 0x0201_4b50)
      put16(&rec, 3 << 8 | 45)
      put16(&rec, (big || bigOffset) ? 45 : 20)
      put16(&rec, 0x0800)
      put16(&rec, e.method)
      put16(&rec, e.time)
      put16(&rec, e.date)
      put32(&rec, e.crc)
      put32(&rec, big ? 0xFFFF_FFFF : UInt32(e.compressed))
      put32(&rec, big ? 0xFFFF_FFFF : UInt32(e.size))
      put16(&rec, UInt16(nameBytes.count))
      put16(&rec, UInt16(extra.count))
      put16(&rec, 0)
      put16(&rec, 0)
      put16(&rec, 0)
      put32(&rec, UInt32(0o100644) << 16)
      put32(&rec, bigOffset ? 0xFFFF_FFFF : UInt32(e.offset))
      rec.append(nameBytes)
      rec.append(extra)
      try write(rec)
    }
    let cdSize = offset - cdStart
    let count = UInt64(central.count)
    let needs64 = forceZip64 || count >= 0xFFFF || cdStart >= 0xFFFF_FFFF || cdSize >= 0xFFFF_FFFF
    var tail = Data()
    if needs64 {
      let eocd64 = offset
      put32(&tail, 0x0606_4b50)
      put64(&tail, 44)
      put16(&tail, 3 << 8 | 45)
      put16(&tail, 45)
      put32(&tail, 0)
      put32(&tail, 0)
      put64(&tail, count)
      put64(&tail, count)
      put64(&tail, cdSize)
      put64(&tail, cdStart)
      put32(&tail, 0x0706_4b50)
      put32(&tail, 0)
      put64(&tail, eocd64)
      put32(&tail, 1)
    }
    put32(&tail, 0x0605_4b50)
    put16(&tail, 0)
    put16(&tail, 0)
    put16(&tail, needs64 ? 0xFFFF : UInt16(count))
    put16(&tail, needs64 ? 0xFFFF : UInt16(count))
    put32(&tail, needs64 ? 0xFFFF_FFFF : UInt32(cdSize))
    put32(&tail, needs64 ? 0xFFFF_FFFF : UInt32(cdStart))
    put16(&tail, 0)
    try write(tail)
    do {
      try handle.synchronize()
      try handle.close()
    } catch {
      throw Self.mapWrite(error)
    }
  }

  func abort() {
    try? handle.close()
  }
}

// MARK: - 读

struct ZipEntry {
  let name: String
  let method: UInt16
  let crc: UInt32
  let compressed: UInt64
  let size: UInt64
  let offset: UInt64
}

/** 名字能不能用：只允许相对路径、没有 .. 和 .、没有空段、没有反斜杠、没有盘符。 */
func zipSafeName(_ raw: String) -> Bool {
  if raw.isEmpty || raw.utf8.count > zipMaxNameBytes { return false }
  if raw.contains("\0") || raw.contains("\\") || raw.hasPrefix("/") { return false }
  let scalars = Array(raw.unicodeScalars)
  if scalars.count >= 2, scalars[1] == ":", scalars[0].properties.isAlphabetic { return false }
  var parts = raw.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
  if parts.last == "" { parts.removeLast() }  // 目录条目的结尾斜杠
  if parts.isEmpty { return false }
  return !parts.contains { $0.isEmpty || $0 == "." || $0 == ".." }
}

final class ZipReader {
  private let handle: FileHandle
  let length: UInt64
  private(set) var entries: [ZipEntry] = []
  private(set) var dataEnd: UInt64 = 0

  init(url: URL) throws {
    guard let h = try? FileHandle(forReadingFrom: url) else { throw ZipFail.io("open") }
    handle = h
    guard let end = try? h.seekToEnd() else { throw ZipFail.io("size") }
    length = end
  }

  func close() { try? handle.close() }

  func readAt(_ position: UInt64, _ count: Int) throws -> Data {
    if count == 0 { return Data() }
    if position > length || UInt64(count) > length - position { throw ZipFail.damaged("truncated") }
    do {
      try handle.seek(toOffset: position)
      guard let data = try handle.read(upToCount: count), data.count == count else {
        throw ZipFail.damaged("truncated")
      }
      return data
    } catch let e as ZipFail {
      throw e
    } catch {
      throw ZipFail.io(error.localizedDescription)
    }
  }

  /// 读中央目录并检查每一条。有一条不合格整个压缩包就拒绝。
  func load() throws {
    if length < 22 { throw ZipFail.notZip }
    let tailLength = Int(min(length, 65_557))
    let tail = try readAt(length - UInt64(tailLength), tailLength)
    var eocd = -1
    var i = tailLength - 22
    while i >= 0 {
      if get32(tail, i) == 0x0605_4b50, i + 22 + Int(get16(tail, i + 20)) == tailLength {
        eocd = i
        break
      }
      i -= 1
    }
    if eocd < 0 { throw ZipFail.notZip }
    var total = UInt64(get16(tail, eocd + 10))
    var cdSize = UInt64(get32(tail, eocd + 12))
    var cdOffset = UInt64(get32(tail, eocd + 16))
    if get16(tail, eocd + 4) != 0 || get16(tail, eocd + 6) != 0 { throw ZipFail.unsupported("multi-disk") }
    let eocdPosition = length - UInt64(tailLength) + UInt64(eocd)
    if total == 0xFFFF || cdSize == 0xFFFF_FFFF || cdOffset == 0xFFFF_FFFF {
      guard eocdPosition >= 20 else { throw ZipFail.damaged("zip64 locator") }
      let locator = try readAt(eocdPosition - 20, 20)
      guard get32(locator, 0) == 0x0706_4b50 else { throw ZipFail.damaged("zip64 locator") }
      let record = try readAt(get64(locator, 8), 56)
      guard get32(record, 0) == 0x0606_4b50 else { throw ZipFail.damaged("zip64 record") }
      total = get64(record, 32)
      cdSize = get64(record, 40)
      cdOffset = get64(record, 48)
    }
    if total > UInt64(zipMaxEntries) || cdSize > zipMaxCentralBytes { throw ZipFail.unsafe("too many entries") }
    if cdOffset > length || cdSize > length - cdOffset { throw ZipFail.damaged("central directory") }
    dataEnd = cdOffset
    let cd = try readAt(cdOffset, Int(cdSize))
    var pos = 0
    var seen = Set<String>()
    var list: [ZipEntry] = []
    list.reserveCapacity(Int(total))
    for _ in 0..<total {
      guard pos + 46 <= cd.count, get32(cd, pos) == 0x0201_4b50 else { throw ZipFail.damaged("central entry") }
      let madeBy = get16(cd, pos + 4)
      let flags = get16(cd, pos + 8)
      let method = get16(cd, pos + 10)
      let crc = get32(cd, pos + 16)
      var compressed = UInt64(get32(cd, pos + 20))
      var size = UInt64(get32(cd, pos + 24))
      let nameLength = Int(get16(cd, pos + 28))
      let extraLength = Int(get16(cd, pos + 30))
      let commentLength = Int(get16(cd, pos + 32))
      let external = get32(cd, pos + 38)
      var offset = UInt64(get32(cd, pos + 42))
      let end = pos + 46 + nameLength + extraLength + commentLength
      guard end <= cd.count else { throw ZipFail.damaged("central entry") }
      let nameData = cd.subdata(in: (cd.startIndex + pos + 46)..<(cd.startIndex + pos + 46 + nameLength))
      // 带 Zip64 附加字段的：只有写成 0xFFFFFFFF 的那几项在里面，顺序固定。
      var extra = pos + 46 + nameLength
      let extraEnd = extra + extraLength
      while extra + 4 <= extraEnd {
        let id = get16(cd, extra)
        let n = Int(get16(cd, extra + 2))
        if extra + 4 + n > extraEnd { throw ZipFail.damaged("extra field") }
        if id == 1 {
          var at = extra + 4
          let stop = extra + 4 + n
          func next() throws -> UInt64 {
            guard at + 8 <= stop else { throw ZipFail.damaged("zip64 extra") }
            defer { at += 8 }
            return get64(cd, at)
          }
          if size == 0xFFFF_FFFF { size = try next() }
          if compressed == 0xFFFF_FFFF { compressed = try next() }
          if offset == 0xFFFF_FFFF { offset = try next() }
        }
        extra += 4 + n
      }
      pos = end
      if flags & 0x1 != 0 || flags & 0x40 != 0 { throw ZipFail.unsupported("encrypted") }
      if method != 0 && method != 8 { throw ZipFail.unsupported("method \(method)") }
      // 符号链接和别的特殊文件：整个压缩包拒绝。
      if madeBy >> 8 == 3 {
        let type = (external >> 16) & 0xF000
        if type != 0 && type != 0x8000 && type != 0x4000 { throw ZipFail.unsafe("special file") }
      }
      let name: String
      if let decoded = String(data: nameData, encoding: .utf8) {
        name = decoded
      } else if flags & 0x800 == 0, let latin = String(data: nameData, encoding: .isoLatin1) {
        name = latin
      } else {
        throw ZipFail.unsafe("name encoding")
      }
      guard zipSafeName(name) else { throw ZipFail.unsafe("name") }
      if name.hasSuffix("/") { continue }
      if method == 0 && compressed != size { throw ZipFail.damaged("sizes") }
      if offset >= dataEnd { throw ZipFail.damaged("offset") }
      if !seen.insert(name.lowercased()).inserted { throw ZipFail.unsafe("duplicate name") }
      list.append(ZipEntry(name: name, method: method, crc: crc, compressed: compressed, size: size, offset: offset))
    }
    entries = list
  }

  /// 把一条解到 dest（父目录按需创建）。边解边数字节，超过声明的大小就停；最后核对校验和。
  func extract(
    _ entry: ZipEntry, to dest: URL, shouldCancel: () -> Bool, progress: (UInt64) -> Void
  ) throws {
    let local = try readAt(entry.offset, 30)
    guard get32(local, 0) == 0x0403_4b50 else { throw ZipFail.damaged("local header") }
    let start = entry.offset + 30 + UInt64(get16(local, 26)) + UInt64(get16(local, 28))
    if start > dataEnd || entry.compressed > dataEnd - start { throw ZipFail.damaged("data range") }
    do {
      try FileManager.default.createDirectory(
        at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
    } catch {
      throw ZipWriter.mapWrite(error)
    }
    FileManager.default.createFile(atPath: dest.path, contents: nil)
    guard let out = try? FileHandle(forWritingTo: dest) else { throw ZipFail.io("create") }
    defer { try? out.close() }
    var crc: UInt32 = 0
    var produced: UInt64 = 0
    let emit: (Data) throws -> Void = { data in
      produced += UInt64(data.count)
      if produced > entry.size { throw ZipFail.damaged("size") }
      crc = crcUpdate(crc, data)
      do {
        try out.write(contentsOf: data)
      } catch {
        throw ZipWriter.mapWrite(error)
      }
    }
    let flate = entry.method == 8 ? try Flate(encode: false) : nil
    var consumed: UInt64 = 0
    var ended = false
    while consumed < entry.compressed {
      if shouldCancel() { throw ZipFail.cancelled }
      let n = Int(min(UInt64(zipChunk), entry.compressed - consumed))
      let chunk = try readAt(start + consumed, n)
      consumed += UInt64(n)
      if let flate {
        if ended { throw ZipFail.damaged("trailing data") }
        ended = try flate.process(chunk, final: consumed == entry.compressed) { buf in
          try emit(Data(buffer: buf))
        }
      } else {
        try emit(chunk)
      }
      progress(UInt64(n))
    }
    if flate != nil {
      if !ended && entry.compressed == 0 && entry.size == 0 { ended = true }
      if !ended { throw ZipFail.damaged("deflate") }
    }
    if produced != entry.size { throw ZipFail.damaged("size") }
    if crc != entry.crc { throw ZipFail.damaged("crc") }
  }
}
