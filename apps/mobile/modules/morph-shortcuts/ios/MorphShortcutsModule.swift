import ExpoModulesCore
import UIKit

// Long-press menu for the Morph icon (D-271): iOS Home Screen Quick Actions. The type of each menu
// item is the quick action ID. When a menu item is tapped: SDK 58's ExpoAppSceneDelegate converts
// both cold starts (connectionOptions.shortcutItem) and taps while the app is running into
// application(_:performActionFor:), received by the subscriber below. If JS is not yet ready (cold
// start), stores it first so it can be retrieved via takeLaunched after startup; if JS is
// listening, emits onOpen directly.

let morphShortcutOpened = Notification.Name("MorphShortcutsOpened")

/** Protected by a lock as it is read and written by both the subscriber (main thread) and the JS thread. */
final class ShortcutLaunch {
  static let shared = ShortcutLaunch()
  private let lock = NSLock()
  private var pending: String?
  private var listening = false

  func setListening(_ on: Bool) {
    lock.lock()
    listening = on
    lock.unlock()
  }

  /** Returns true if JS is listening (the caller emits a notification); if not listening, records it to be retrieved later by takeLaunched. */
  func deliver(_ id: String) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    if listening { return true }
    pending = id
    return false
  }

  func take() -> String? {
    lock.lock()
    defer { lock.unlock() }
    let id = pending
    pending = nil
    return id
  }
}

struct ShortcutItemRecord: Record {
  @Field var id: String = ""
  @Field var title: String = ""
  @Field var symbol: String? = nil
}

public class MorphShortcutsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("MorphShortcuts")

    Events("onOpen")

    AsyncFunction("setItems") { (items: [ShortcutItemRecord], _: String) in
      UIApplication.shared.shortcutItems = items.map { item in
        UIApplicationShortcutItem(
          type: item.id,
          localizedTitle: item.title,
          localizedSubtitle: nil,
          icon: item.symbol.map { UIApplicationShortcutIcon(systemImageName: $0) },
          userInfo: nil
        )
      }
    }.runOnQueue(.main)

    // iOS does not provide an API for apps to place icons on the desktop.
    Function("canPin") { false }

    AsyncFunction("pin") { (_: ShortcutItemRecord) in false }

    Function("takeLaunched") { () -> String? in
      ShortcutLaunch.shared.take()
    }

    OnStartObserving {
      ShortcutLaunch.shared.setListening(true)
      NotificationCenter.default.addObserver(
        self, selector: #selector(self.opened(_:)), name: morphShortcutOpened, object: nil)
    }

    OnStopObserving {
      ShortcutLaunch.shared.setListening(false)
      NotificationCenter.default.removeObserver(self, name: morphShortcutOpened, object: nil)
    }
  }

  @objc
  func opened(_ notification: Notification) {
    guard let id = notification.object as? String else { return }
    sendEvent("onOpen", ["id": id])
  }
}

public class MorphShortcutsAppDelegate: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    performActionFor shortcutItem: UIApplicationShortcutItem,
    completionHandler: @escaping (Bool) -> Void
  ) {
    let id = shortcutItem.type
    if ShortcutLaunch.shared.deliver(id) {
      NotificationCenter.default.post(name: morphShortcutOpened, object: id)
    }
    completionHandler(true)
  }
}
