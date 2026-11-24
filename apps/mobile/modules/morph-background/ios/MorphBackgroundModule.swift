import BackgroundTasks
import ExpoModulesCore
import ExpoNotifications
import UIKit

// iOS part of continuing long-running tasks in the background (D-163): iOS 26
// BGContinuedProcessingTask. Submitted after the user taps run, the system displays progress on the
// lock screen and Dynamic Island, and grants time to continue running when switched to other apps;
// when the system reclaims the time, morph-media is interrupted as "switched to background". When
// disabled, it does nothing, and iOS must stay in Morph just like D-148. Enabled after confirmation
// on a physical iPhone on 2026-10-31.

/** Switch (D-163). */
private let continuedProcessingEnabled = true

/** Notification name agreed upon with morph-media (both modules cannot see each other's code). */
private let changedNotification = Notification.Name("MorphContinuedProcessingChanged")
private let expiredNotification = Notification.Name("MorphContinuedProcessingExpired")

struct DoneNotice: Record {
  @Field var title: String = ""
  @Field var body: String = ""
}

public class MorphBackgroundModule: Module {
  private let lock = NSLock()
  /** Task identifier for this run; nil after end (late system tasks terminate immediately). */
  private var identifier: String?
  /** Task started running by the system (BGContinuedProcessingTask, starting with iOS 26). */
  private var task: AnyObject?
  private var title = ""

  /** Background time holder for reminder buttons (D-318). */
  private let actionHold = ReminderActionHold()

  public func definition() -> ModuleDefinition {
    Name("MorphBackground")

    // Buttons on reminder notifications (D-318) do not open the app: the system pulls or wakes up
    // the app in the background, expo-notifications replies to the system as soon as a click is
    // received, after which the app may be suspended at any time, leaving JS insufficient time to
    // write records. Therefore, background time is requested first, and JS calls releaseActionTime
    // after processing: requested when receiving Morph's button while the app is suspended in the
    // background (delegate); when the app is not running and is pulled up by the system in the
    // background, the click might be consumed by expo-notifications before the delegate is
    // attached, so background time is also requested when the module is created even if the app is
    // in the background (released if JS receives no click within a few seconds).
    OnCreate {
      NotificationCenterManager.shared.addDelegate(self.actionHold)
      DispatchQueue.main.async {
        if UIApplication.shared.applicationState == .background { self.actionHold.hold() }
      }
    }

    OnDestroy {
      NotificationCenterManager.shared.removeDelegate(self.actionHold)
      self.actionHold.release()
    }

    Function("releaseActionTime") {
      DispatchQueue.main.async { self.actionHold.release() }
    }

    Constant("continuesInBackground") { Self.available }

    // iOS does not send our own notifications: progress and completion are both displayed by the system's background task interface.
    AsyncFunction("ensureNotificationPermission") { () -> Bool in false }

    Function("begin") { (title: String, text: String) -> Bool in
      self.begin(title, text)
    }

    Function("update") { (text: String, fraction: Double?) in
      self.update(text, fraction)
    }

    Function("end") { (_: DoneNotice?) in
      self.end()
    }
  }

  private static var available: Bool {
    guard continuedProcessingEnabled else { return false }
    // Simulators do not have BGTaskScheduler (submission reports "not available on this platform").
    #if targetEnvironment(simulator)
      return false
    #else
      if #available(iOS 26.0, *) { return true }
      return false
    #endif
  }

  private func begin(_ title: String, _ text: String) -> Bool {
    guard Self.available else { return false }
    guard #available(iOS 26.0, *) else { return false }
    let bundle = Bundle.main.bundleIdentifier ?? "dev.stonetech.tinkrum"
    // Info.plist's BGTaskSchedulerPermittedIdentifiers contains dev.stonetech.tinkrum.work.*; a new identifier is used each time (registering the same identifier twice causes the system to kill the app).
    let id = "\(bundle).work.\(UUID().uuidString)"
    lock.withLock {
      identifier = id
      task = nil
      self.title = title
    }
    let registered = BGTaskScheduler.shared.register(forTaskWithIdentifier: id, using: nil) {
      [weak self] bgTask in
      guard let self, let bgTask = bgTask as? BGContinuedProcessingTask else {
        bgTask.setTaskCompleted(success: false)
        return
      }
      let current = self.lock.withLock { () -> Bool in
        guard self.identifier == id else { return false }
        self.task = bgTask
        return true
      }
      // Reached only after execution has already ended: terminate immediately.
      guard current else {
        bgTask.setTaskCompleted(success: true)
        return
      }
      bgTask.progress.totalUnitCount = 1000
      bgTask.expirationHandler = { [weak self] in self?.expire(id) }
      NotificationCenter.default.post(name: changedNotification, object: nil, userInfo: ["active": true])
    }
    guard registered else {
      NSLog("[MorphBackground] could not register %@", id)
      lock.withLock { identifier = nil }
      return false
    }
    let request = BGContinuedProcessingTaskRequest(identifier: id, title: title, subtitle: text)
    // Forget about running right now if it cannot run (still inside Morph, run in the foreground as usual) without queueing.
    request.strategy = .fail
    do {
      try BGTaskScheduler.shared.submit(request)
    } catch {
      NSLog("[MorphBackground] submit failed: %@", String(describing: error))
      lock.withLock { identifier = nil }
      return false
    }
    return true
  }

  private func update(_ text: String, _ fraction: Double?) {
    guard #available(iOS 26.0, *) else { return }
    let (task, title) = lock.withLock { (self.task, self.title) }
    guard let task = task as? BGContinuedProcessingTask else { return }
    if let fraction {
      task.progress.completedUnitCount = Int64((min(1, max(0, fraction)) * 1000).rounded())
    }
    task.updateTitle(title, subtitle: text)
  }

  private func end() {
    let task = lock.withLock { () -> AnyObject? in
      identifier = nil
      defer { self.task = nil }
      return self.task
    }
    NotificationCenter.default.post(name: changedNotification, object: nil, userInfo: ["active": false])
    if #available(iOS 26.0, *), let task = task as? BGContinuedProcessingTask {
      task.progress.completedUnitCount = task.progress.totalUnitCount
      task.setTaskCompleted(success: true)
    }
  }

  /** The system reclaimed background time: video and audio currently being processed are interrupted as "switched to background" (ERR_MEDIA_INTERRUPTED). */
  private func expire(_ id: String) {
    let task = lock.withLock { () -> AnyObject? in
      guard identifier == id else { return nil }
      identifier = nil
      defer { self.task = nil }
      return self.task
    }
    NotificationCenter.default.post(name: changedNotification, object: nil, userInfo: ["active": false])
    NotificationCenter.default.post(name: expiredNotification, object: nil)
    if #available(iOS 26.0, *), let task = task as? BGContinuedProcessingTask {
      task.setTaskCompleted(success: false)
    }
  }
}

/** Same as DONE_ACTION and SNOOZE_ACTION in reminders/platform.ts. */
private let reminderActions: Set<String> = ["morph-done", "morph-snooze"]

/**
 * Requests background time from the system upon receiving a click on a reminder button (D-318).
 * Does not count as handling the click (returns false), so the click is still passed to
 * expo-notifications and delivered to JS.
 */
final class ReminderActionHold: NSObject, NotificationDelegate {
  private var task: UIBackgroundTaskIdentifier = .invalid

  func didReceive(_ response: UNNotificationResponse, completionHandler: @escaping () -> Void) -> Bool {
    if reminderActions.contains(response.actionIdentifier) {
      if Thread.isMainThread { hold() } else { DispatchQueue.main.async { self.hold() } }
    }
    return false
  }

  func hold() {
    guard task == .invalid else { return }
    task = UIApplication.shared.beginBackgroundTask(withName: "morph-reminder-action") {
      [weak self] in self?.release()
    }
  }

  func release() {
    guard task != .invalid else { return }
    UIApplication.shared.endBackgroundTask(task)
    task = .invalid
  }
}
