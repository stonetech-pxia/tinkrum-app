import Foundation

// ZIP codec tests (compiled and run by scripts/test-native-archive.mjs): main <working-dir>
// <python-archive-dir>. Written archives are verified against unzip and python (via script), reads
// python-generated archives and self-generated archives, and tests that malicious archives are
// correctly rejected.

var failures = 0
func check(_ ok: Bool, _ what: String) {
  if !ok {
    failures += 1
    print("FAIL: \(what)")
  }
}

let work = URL(fileURLWithPath: CommandLine.arguments[1])
let samples = URL(fileURLWithPath: CommandLine.arguments[2])

func random(_ n: Int) -> Data {
  var g = SystemRandomNumberGenerator()
  return Data((0..<n).map { _ in UInt8.random(in: 0...255, using: &g) })
}

func sizeOf(_ data: Data) -> Data { data }

func writeArchive(_ url: URL, force: Bool, files: [(String, Data, Bool)]) throws {
  let w = try ZipWriter(url: url, forceZip64: force)
  for (name, data, store) in files {
    var given = false
    try w.add(
      name: name, size: UInt64(data.count), modified: Date(), store: store,
      read: {
        if given { return Data() }
        given = true
        // Supplied in chunks to exercise multi-chunk code paths.
        return data
      }, shouldCancel: { false }, progress: { _ in })
  }
  try w.finish()
}

func readBack(_ url: URL) throws -> [String: Data] {
  let r = try ZipReader(url: url)
  defer { r.close() }
  try r.load()
  let out = work.appendingPathComponent("out-\(UUID().uuidString)")
  var result: [String: Data] = [:]
  for e in r.entries {
    let dest = out.appendingPathComponent(e.name)
    try r.extract(e, to: dest, shouldCancel: { false }, progress: { _ in })
    result[e.name] = try Data(contentsOf: dest)
  }
  try? FileManager.default.removeItem(at: out)
  return result
}

try? FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
let text = Data(String(repeating: "Tinkrum 记录 ", count: 5000).utf8)
let noise = random(3_000_000)
let files: [(String, Data, Bool)] = [
  ("tinkrum-backup.json", Data("{\"a\":1}".utf8), false),
  ("database/morph.db", text, false),
  ("files/assets/ab12/photo.jpg", noise, true),
  ("files/assets/ab12/合同 (final).pdf", noise.prefix(1000), true),
  ("files/assets/ab12/.text.txt", text, false),
  ("files/empty.txt", Data(), false),
  ("files/empty-stored.bin", Data(), true),
]
for (label, force) in [("plain", false), ("zip64", true)] {
  let url = work.appendingPathComponent("\(label).zip")
  try? FileManager.default.removeItem(at: url)
  do {
    try writeArchive(url, force: force, files: files)
    let back = try readBack(url)
    check(back.count == files.count, "\(label): entry count \(back.count)")
    for (name, data, _) in files { check(back[name] == data, "\(label): content of \(name)") }
  } catch {
    check(false, "\(label): \(error)")
  }
}

// Many entries (exceeding 65535 -> Zip64 end record).
do {
  let url = work.appendingPathComponent("many.zip")
  try? FileManager.default.removeItem(at: url)
  let many = (0..<70_000).map { ("files/n/\($0).txt", Data("\($0)".utf8), false) }
  try writeArchive(url, force: false, files: many)
  let r = try ZipReader(url: url)
  try r.load()
  check(r.entries.count == 70_000, "many: \(r.entries.count)")
  r.close()
} catch {
  check(false, "many: \(error)")
}

// Python-generated archives: successfully readable; malicious archives rejected.
let expected: [String: ZipFail?] = [
  "ok-deflate.zip": nil,
  "ok-zip64.zip": nil,
  "ok-stored.zip": nil,
  "bad-dotdot.zip": .unsafe("name"),
  "bad-absolute.zip": .unsafe("name"),
  "bad-backslash.zip": .unsafe("name"),
  "bad-symlink.zip": .unsafe("special file"),
  "bad-duplicate.zip": .unsafe("duplicate name"),
  "bad-encrypted.zip": .unsupported("encrypted"),
  "bad-method.zip": .unsupported("method 12"),
  "bad-notzip.zip": .notZip,
  "bad-truncated.zip": .notZip,
  "bad-crc.zip": .damaged("crc"),
  "bad-size-lie.zip": .damaged("size"),
  "bad-bomb-lie.zip": .damaged("size"),
]
for (name, want) in expected.sorted(by: { $0.key < $1.key }) {
  let url = samples.appendingPathComponent(name)
  do {
    let back = try readBack(url)
    check(want == nil, "\(name): should have been refused, extracted \(back.count)")
    if want == nil { check(back["files/hello.txt"] == Data("hello 你好\n".utf8), "\(name): content") }
  } catch let e as ZipFail {
    check(want != nil && want! == e, "\(name): got \(e), want \(String(describing: want))")
  } catch {
    check(false, "\(name): \(error)")
  }
}

// Cancellation: stop in the middle and throw cancelled.
do {
  let url = work.appendingPathComponent("cancel.zip")
  var calls = 0
  let w = try ZipWriter(url: url)
  var left = 5
  do {
    try w.add(
      name: "a.bin", size: 5_000_000, modified: Date(), store: true,
      read: {
        left -= 1
        return left > 0 ? random(1_000_000) : Data()
      }, shouldCancel: { calls += 1; return calls > 2 }, progress: { _ in })
    check(false, "cancel: not cancelled")
  } catch ZipFail.cancelled {
  }
  w.abort()
} catch {
  check(false, "cancel: \(error)")
}

// Run manually: single file exceeding 4 GB (excluded from npm run check due to slowness). Argument big: write 4.2 GB of zeros (very small after compression) and read back.
if CommandLine.arguments.count > 3, CommandLine.arguments[3] == "big" {
  let url = work.appendingPathComponent("big.zip")
  try? FileManager.default.removeItem(at: url)
  let total: UInt64 = 4_200_000_000
  var sent: UInt64 = 0
  let zeros = Data(count: 1 << 20)
  let w = try ZipWriter(url: url)
  try w.add(
    name: "files/huge.bin", size: total, modified: Date(), store: false,
    read: {
      if sent >= total { return Data() }
      let n = min(UInt64(zeros.count), total - sent)
      sent += n
      return zeros.prefix(Int(n))
    }, shouldCancel: { false }, progress: { _ in })
  try w.finish()
  let r = try ZipReader(url: url)
  try r.load()
  check(r.entries.count == 1 && r.entries[0].size == total, "big: size \(r.entries.first?.size ?? 0)")
  let dest = work.appendingPathComponent("huge.out")
  try r.extract(r.entries[0], to: dest, shouldCancel: { false }, progress: { _ in })
  let attrs = try FileManager.default.attributesOfItem(atPath: dest.path)
  check((attrs[.size] as? UInt64) == total, "big: extracted size")
  try? FileManager.default.removeItem(at: dest)
  r.close()
}

print(failures == 0 ? "OK" : "\(failures) failure(s)")
exit(failures == 0 ? 0 : 1)
