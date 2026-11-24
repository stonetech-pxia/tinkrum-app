import AppIntents
import SwiftUI
import WidgetKit

// Morph desktop widget (D-321). When the user long-presses a widget in the app and selects "Add to
// Desktop", it appears in the "Edit Widget" list; shows the most recently placed one when none is
// selected. Tapping a button or circle: `RunWidgetOp` writes the operation into the App Group's
// `queue/` without opening the app (D-323); the system subsequently redraws, changing the view to
// the app's pre-computed "after tap" version.

// MARK: - Which widget to select

struct WidgetItemEntity: AppEntity {
  let id: String
  let name: String

  static var typeDisplayRepresentation: TypeDisplayRepresentation = "Component"
  static var defaultQuery = WidgetItemQuery()
  var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }
}

struct WidgetItemQuery: EntityQuery {
  private func all() -> [WidgetItemEntity] {
    (SharedFiles.snapshot()?.items ?? []).map { WidgetItemEntity(id: $0.id, name: $0.name) }
  }
  func entities(for identifiers: [String]) async throws -> [WidgetItemEntity] {
    all().filter { identifiers.contains($0.id) }
  }
  func suggestedEntities() async throws -> [WidgetItemEntity] { all().reversed() }
  func defaultResult() async -> WidgetItemEntity? { all().last }
}

struct PickWidgetItem: WidgetConfigurationIntent {
  static var title: LocalizedStringResource = "Choose a component"
  static var description = IntentDescription("Components you added to the Home Screen in Tinkrum.")

  @Parameter(title: "Component")
  var item: WidgetItemEntity?
}

// MARK: - Tap

struct RunWidgetOp: AppIntent {
  static var title: LocalizedStringResource = "Record in Tinkrum"
  static var isDiscoverable = false

  @Parameter(title: "Action")
  var op: String

  init() {}
  init(op: String) { self.op = op }

  func perform() async throws -> some IntentResult {
    // Records only what was tapped; values are calculated based on the tap timestamp when the app opens (D-323).
    if let def = SharedFiles.snapshot()?.ops[op] {
      try SharedFiles.enqueue(
        QueuedOp(
          op: op, component: def.component, record: def.record, hash: def.hash,
          at: Date().timeIntervalSince1970 * 1000))
    }
    return .result()
  }
}

// MARK: - Timeline

struct MorphEntry: TimelineEntry {
  let date: Date
  let view: ItemView?
  let stale: Bool
  let staleText: String
  let palette: SnapshotColors?
  /** No widget has ever been placed (or the app has not been opened yet). */
  let empty: Bool
}

struct MorphProvider: AppIntentTimelineProvider {
  func placeholder(in context: Context) -> MorphEntry {
    MorphEntry(date: Date(), view: nil, stale: false, staleText: "", palette: nil, empty: true)
  }

  func snapshot(for configuration: PickWidgetItem, in context: Context) async -> MorphEntry {
    entry(for: configuration, at: Date())
  }

  func timeline(for configuration: PickWidgetItem, in context: Context) async -> Timeline<
    MorphEntry
  > {
    let now = Date()
    var entries = [entry(for: configuration, at: now)]
    // The app pre-calculated tomorrow's view (day crossing, D-322): Swaps in at the appointed time without waiting for the app to open.
    for state in SharedFiles.snapshot()?.states ?? [] where state.from > now.timeIntervalSince1970 * 1000 {
      entries.append(entry(for: configuration, at: Date(timeIntervalSince1970: state.from / 1000)))
    }
    return Timeline(entries: entries, policy: .atEnd)
  }

  private func entry(for configuration: PickWidgetItem, at date: Date) -> MorphEntry {
    guard let snap = SharedFiles.snapshot(), let fallback = snap.items.last else {
      return MorphEntry(date: date, view: nil, stale: false, staleText: "", palette: nil, empty: true)
    }
    let id = configuration.item?.id ?? fallback.id
    let (view, stale) = resolveView(snap, item: id, at: date, queued: SharedFiles.queued())
    return MorphEntry(
      date: date, view: view, stale: stale, staleText: snap.strings.stale, palette: snap.colors,
      empty: view == nil)
  }
}

// MARK: - Widget

struct MorphWidget: Widget {
  var body: some WidgetConfiguration {
    AppIntentConfiguration(kind: "MorphWidget", intent: PickWidgetItem.self, provider: MorphProvider()) {
      entry in
      MorphWidgetView(entry: entry)
        .containerBackground(.fill.tertiary, for: .widget)
    }
    .configurationDisplayName("Tinkrum")
    .description("A stat, button or list from your Tinkrum pages.")
    .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
  }
}

@main
struct MorphWidgetBundle: WidgetBundle {
  var body: some Widget { MorphWidget() }
}
