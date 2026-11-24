import ExpoModulesCore
import NaturalLanguage
import SwiftUI
import Translation
import UIKit

// On-device translation (D-170): Uses only the native iOS Translation framework (iOS 18+) and
// NaturalLanguage (for language recognition), processed entirely on-device without logging text.
// - Starting from iOS 26, when both languages are already downloaded, directly creates
// TranslationSession(installedSource:target:) without a UI;
// - In other cases (languages need downloading, iOS 18-25), sessions can only be obtained via
// SwiftUI's .translationTask: attaches an invisible, 1x1, non-touch-receiving SwiftUI view to the
// current page, which prompts the user for download confirmation when needed and is removed after
// translation completes.

final class TranslateCancelledException: Exception, @unchecked Sendable {
  override var code: String { "ERR_TRANSLATE_CANCELLED" }
  override var reason: String { "The user cancelled the language download" }
}

final class TranslateUnsupportedException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_TRANSLATE_UNSUPPORTED" }
  override var reason: String { "Translation is not available for \(param)" }
}

final class TranslateFailedException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_TRANSLATE_FAILED" }
  override var reason: String { "Translation failed: \(param)" }
}

public class MorphTranslateModule: Module {
  public func definition() -> ModuleDefinition {
    Name("MorphTranslate")

    Function("isSupported") { () -> Bool in
      if #available(iOS 18.0, *) { return true }
      return false
    }

    // Language of each text segment (BCP 47, e.g., en, zh-Hans, ja); returns nil if too short or uncertain, letting the app handle it using the dominant language of the full text.
    AsyncFunction("detectLanguages") { (texts: [String]) -> [String?] in
      texts.map { text in
        let recognizer = NLLanguageRecognizer()
        recognizer.processString(text)
        guard let best = recognizer.languageHypotheses(withMaximum: 1).first,
          best.key != .undetermined, best.value >= 0.5
        else { return nil }
        return best.key.rawValue
      }
    }

    // Languages supported by the system for translation (for debugging; Android has no corresponding list).
    AsyncFunction("supportedLanguages") { () async -> [String] in
      guard #available(iOS 18.0, *) else { return [] }
      return await LanguageAvailability().supportedLanguages.map { $0.maximalIdentifier }
    }

    AsyncFunction("status") { (from: String, to: String) async throws -> [String: Any] in
      guard #available(iOS 18.0, *) else { throw TranslateUnsupportedException("iOS < 18") }
      guard let (source, target) = await Self.resolve(from, to) else {
        return ["status": "unsupported"]
      }
      switch await LanguageAvailability().status(from: source, to: target) {
      case .installed: return ["status": "installed"]
      case .supported: return ["status": "download"]
      default: return ["status": "unsupported"]
      }
    }

    AsyncFunction("translate") { (texts: [String], from: String, to: String) async throws -> [String] in
      guard #available(iOS 18.0, *) else { throw TranslateUnsupportedException("iOS < 18") }
      guard let (source, target) = await Self.resolve(from, to) else {
        throw TranslateUnsupportedException("\(from) → \(to)")
      }
      if texts.isEmpty { return [] }
      let requests = texts.enumerated().map {
        TranslationSession.Request(sourceText: $0.element, clientIdentifier: String($0.offset))
      }
      do {
        let responses: [TranslationSession.Response]
        if #available(iOS 26.0, *),
          await LanguageAvailability().status(from: source, to: target) == .installed
        {
          let session = TranslationSession(installedSource: source, target: target)
          responses = try await session.translations(from: requests)
        } else {
          responses = try await self.withSession(source: source, target: target) { session in
            try await session.translations(from: requests)
          }
        }
        var out = texts
        for response in responses {
          if let id = response.clientIdentifier, let i = Int(id), i < out.count {
            out[i] = response.targetText
          }
        }
        return out
      } catch let error as Exception {
        throw error
      } catch {
        // Language is still not installed if the download was cancelled (or incomplete).
        if await LanguageAvailability().status(from: source, to: target) != .installed {
          throw TranslateCancelledException()
        }
        if TranslationError.unsupportedLanguagePairing ~= error
          || TranslationError.unsupportedSourceLanguage ~= error
          || TranslationError.unsupportedTargetLanguage ~= error
        {
          throw TranslateUnsupportedException("\(from) → \(to)")
        }
        throw TranslateFailedException(error.localizedDescription)
      }
    }

    // Pre-download the specified language pair (system prompts for download confirmation and displays progress): called when the user adds a translation or confirms a download before translating (D-170).
    AsyncFunction("prepare") { (from: String, to: String) async throws in
      guard #available(iOS 18.0, *) else { throw TranslateUnsupportedException("iOS < 18") }
      guard let (source, target) = await Self.resolve(from, to) else {
        throw TranslateUnsupportedException("\(from) → \(to)")
      }
      if await LanguageAvailability().status(from: source, to: target) == .installed { return }
      do {
        try await self.withSession(source: source, target: target) { session in
          try await session.prepareTranslation()
        }
      } catch {
        if await LanguageAvailability().status(from: source, to: target) != .installed {
          throw TranslateCancelledException()
        }
      }
    }
  }

  /**
   * Find a system-supported language matching the app's code: primary language and script
   * (Simplified/Traditional) must match; when a language has multiple regions, prefer the default
   * region for that language (US English, Brazilian Portuguese). List order is unreliable
   * (English is first as en-IN on the simulator).
   */
  @available(iOS 18.0, *)
  private static func resolve(_ from: String, _ to: String) async -> (Locale.Language, Locale.Language)? {
    let supported = await LanguageAvailability().supportedLanguages
    func find(_ code: String) -> Locale.Language? {
      // First look up the default region (en -> en-Latn-US, pt -> pt-Latn-BR, zh-Hans -> zh-Hans-CN), then search for matching language and script.
      let maximal = Locale.Language(identifier: code).maximalIdentifier
      let wanted = Locale.Language(identifier: maximal)
      if let exact = supported.first(where: { $0.maximalIdentifier == maximal }) { return exact }
      return supported.first { lang in
        let full = Locale.Language(identifier: lang.maximalIdentifier)
        return full.languageCode == wanted.languageCode && full.script == wanted.script
      }
    }
    // If the list is empty (unavailable), defer directly to system judgment.
    if supported.isEmpty { return (Locale.Language(identifier: from), Locale.Language(identifier: to)) }
    guard let source = find(from), let target = find(to) else { return nil }
    return (source, target)
  }

  /** Attach an invisible SwiftUI view to obtain the session (system prompts from here if a download is required), and remove it when done. */
  @available(iOS 18.0, *)
  @MainActor
  private func withSession<T: Sendable>(
    source: Locale.Language,
    target: Locale.Language,
    _ body: @escaping (TranslationSession) async throws -> T
  ) async throws -> T {
    guard let parent = appContext?.utilities?.currentViewController() else {
      throw TranslateFailedException("no view controller")
    }
    return try await withCheckedThrowingContinuation { continuation in
      let once = Once(continuation)
      var host: UIHostingController<TranslationHost>?
      let remove = {
        host?.willMove(toParent: nil)
        host?.view.removeFromSuperview()
        host?.removeFromParent()
        host = nil
      }
      let view = TranslationHost(
        configuration: TranslationSession.Configuration(source: source, target: target),
        work: { session in
          do {
            once.resume(.success(try await body(session)))
          } catch {
            once.resume(.failure(error))
          }
          await MainActor.run { remove() }
        },
        gone: { once.resume(.failure(CancellationError())) })
      let controller = UIHostingController(rootView: view)
      controller.view.backgroundColor = .clear
      controller.view.isUserInteractionEnabled = false
      controller.view.frame = CGRect(x: 0, y: 0, width: 1, height: 1)
      parent.addChild(controller)
      parent.view.addSubview(controller.view)
      controller.didMove(toParent: parent)
      host = controller
    }
  }
}

/** Resume only once (both view disappearance and translation completion might trigger it). */
private final class Once<T>: @unchecked Sendable {
  private var continuation: CheckedContinuation<T, Error>?
  private let lock = NSLock()
  init(_ continuation: CheckedContinuation<T, Error>) { self.continuation = continuation }
  func resume(_ result: Result<T, Error>) {
    lock.lock()
    let c = continuation
    continuation = nil
    lock.unlock()
    c?.resume(with: result)
  }
}

@available(iOS 18.0, *)
private struct TranslationHost: View {
  let configuration: TranslationSession.Configuration
  let work: (TranslationSession) async -> Void
  let gone: () -> Void

  var body: some View {
    Color.clear
      .frame(width: 1, height: 1)
      .translationTask(configuration) { session in await work(session) }
      .onDisappear(perform: gone)
  }
}
