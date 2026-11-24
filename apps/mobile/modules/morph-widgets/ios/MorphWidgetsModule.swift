import ExpoModulesCore
import WidgetKit

// App-side of the home screen widget (D-321–D-323): writes rendering output into the App Group to
// trigger a WidgetKit redraw; retrieves tapped widget actions. iOS cannot automatically place
// widgets on the home screen for the user, so canPin is always false (users use "Edit -> Add
// Widget" on the home screen).

private let appGroup = "group.dev.stonetech.tinkrum"

public class MorphWidgetsModule: Module {
  private var dir: URL? {
    FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)?
      .appendingPathComponent("widgets", isDirectory: true)
  }

  public func definition() -> ModuleDefinition {
    Name("MorphWidgets")

    Events("onQueue")

    AsyncFunction("setSnapshot") { (json: String) in
      guard let dir = self.dir else { return }
      try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
      try Data(json.utf8).write(to: dir.appendingPathComponent("snapshot.json"), options: .atomic)
      WidgetCenter.shared.reloadAllTimelines()
    }

    // Read unhandled tapped actions without deleting them (R07): App executes them one by one,
    // records completion, and then confirms deletion using removeQueue. id is the filename (without
    // .json). Unreadable ones are kept for the next read.
    AsyncFunction("readQueue") { () -> [[String: String]] in
      guard let queue = self.dir?.appendingPathComponent("queue", isDirectory: true),
        let names = try? FileManager.default.contentsOfDirectory(atPath: queue.path)
      else { return [] }
      var out: [[String: String]] = []
      // Process only completed files (.json); partially written .tmp files are left for next time.
      for name in names.sorted() where name.hasSuffix(".json") {
        let url = queue.appendingPathComponent(name)
        if let data = try? Data(contentsOf: url), let text = String(data: data, encoding: .utf8) {
          out.append(["id": String(name.dropLast(".json".count)), "text": text])
        }
      }
      return out
    }

    // Delete processed taps. Only recognizes filenames within the queue directory: paths containing IDs are not deleted.
    AsyncFunction("removeQueue") { (ids: [String]) in
      guard let queue = self.dir?.appendingPathComponent("queue", isDirectory: true) else { return }
      for id in ids where !id.isEmpty && !id.contains("/") && !id.contains("..") {
        try? FileManager.default.removeItem(at: queue.appendingPathComponent("\(id).json"))
      }
    }

    Function("canPin") { false }

    AsyncFunction("pin") { (_: String, _: String) in false }
  }
}
