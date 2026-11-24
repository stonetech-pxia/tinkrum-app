import Foundation

// Widget views written by the app into the App Group (D-321–D-323). See
// `apps/mobile/src/widgets/types.ts` for the format; both sides must be updated together. Texts and
// numbers are computed by the app for the current language; this only selects a view by time and
// selects the "after tap" version for unexecuted taps.

let appGroup = "group.dev.stonetech.tinkrum"

struct WidgetSnapshot: Decodable {
  let v: Int
  let strings: SnapshotStrings
  let colors: SnapshotColors
  let items: [SnapshotItem]
  let ops: [String: SnapshotOp]
  let states: [SnapshotState]
}

struct SnapshotStrings: Decodable {
  let stale: String
}

struct SnapshotPalette: Decodable {
  let primary: String
  let tint: String
  let onPrimary: String
}

struct SnapshotColors: Decodable {
  let light: SnapshotPalette
  let dark: SnapshotPalette
}

struct SnapshotItem: Decodable {
  let id: String
  let name: String
}

struct SnapshotOp: Decodable {
  let component: String
  let record: String?
  let hash: String
}

struct SnapshotState: Decodable {
  let from: Double
  let until: Double
  let views: [String: ItemView]
  /** `after[op][k-1]`: The view of each widget after the same operation is tapped `k` times consecutively. */
  let after: [String: [[String: ItemView]]]
}

/** A widget view: `kind` is `stat`, `button`, `list`, or `message` (unsupported or deleted). */
struct ItemView: Decodable {
  let kind: String
  let title: String
  let value: String?
  let ratio: Double?
  let percent: String?
  let note: String?
  let icon: String?
  let op: String?
  let link: String?
  let display: String?
  let rows: [ItemRow]?
  let empty: String?
}

struct ItemRow: Decodable {
  let id: String
  let title: String
  let trailing: String?
  let op: String?
  let link: String?
  let ratio: Double?
  let full: Bool?
}

/** An operation that was tapped but not yet executed by the app (one file per operation in `queue/`). */
struct QueuedOp: Codable {
  let op: String
  let component: String
  let record: String?
  let hash: String
  let at: Double
}

enum SharedFiles {
  static var dir: URL? {
    FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)?
      .appendingPathComponent("widgets", isDirectory: true)
  }

  static func snapshot() -> WidgetSnapshot? {
    guard let url = dir?.appendingPathComponent("snapshot.json"),
      let data = try? Data(contentsOf: url)
    else { return nil }
    return try? JSONDecoder().decode(WidgetSnapshot.self, from: data)
  }

  static func queued() -> [QueuedOp] {
    guard let queue = dir?.appendingPathComponent("queue", isDirectory: true),
      let names = try? FileManager.default.contentsOfDirectory(atPath: queue.path)
    else { return [] }
    return names.filter { $0.hasSuffix(".json") }.compactMap { name in
      guard let data = try? Data(contentsOf: queue.appendingPathComponent(name)) else { return nil }
      return try? JSONDecoder().decode(QueuedOp.self, from: data)
    }.sorted { $0.at < $1.at }
  }

  /** Enqueues a widget tap operation: writes to a file and then renames it so the app never reads a half-written file. */
  static func enqueue(_ op: QueuedOp) throws {
    guard let queue = dir?.appendingPathComponent("queue", isDirectory: true) else { return }
    try FileManager.default.createDirectory(at: queue, withIntermediateDirectories: true)
    let name = "\(Int64(op.at))-\(UUID().uuidString)"
    let temp = queue.appendingPathComponent("\(name).tmp")
    try JSONEncoder().encode(op).write(to: temp, options: .atomic)
    try FileManager.default.moveItem(at: temp, to: queue.appendingPathComponent("\(name).json"))
  }
}

/** Determines which view this widget should render now; `stale`: Tapped operations cannot be resolved (mixed operations, too many taps, or day crossed), displays a prompt. */
func resolveView(_ snap: WidgetSnapshot, item: String, at date: Date, queued: [QueuedOp]) -> (
  ItemView?, Bool
) {
  let ms = date.timeIntervalSince1970 * 1000
  guard let state = snap.states.first(where: { ms < $0.until }) ?? snap.states.last else {
    return (nil, false)
  }
  let pastEnd = ms >= (snap.states.last?.until ?? 0)
  if queued.isEmpty { return (state.views[item], pastEnd) }
  let keys = Set(queued.map(\.op))
  if keys.count == 1, let key = keys.first, let list = state.after[key], queued.count <= list.count,
    queued.allSatisfy({ $0.at >= state.from })
  {
    return (list[queued.count - 1][item] ?? state.views[item], pastEnd)
  }
  return (state.views[item], true)
}
