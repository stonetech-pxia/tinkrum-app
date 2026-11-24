import ExpoModulesCore
import PDFKit
import UIKit
import WebKit

// iOS implementation for converting office documents to PDF (D-186): WKWebView opens the document
// (the system automatically formats Word, Excel, PowerPoint, RTF into web pages), and after layout
// stabilizes, UIPrintPageRenderer paginates by paper size and renders into PDF. Entirely local; the
// web view does not connect to the network (reads only this single file). PDF passwords (D-194):
// PDFKit determines whether a password is required, unlocks and saves an unencrypted copy, and adds
// an open password. Passwords are used only in this call.

final class DocUnreadableException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_DOC_UNREADABLE" }
  override var reason: String { "This document can't be opened: \(param)" }
}

final class DocFailedException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_DOC_FAILED" }
  override var reason: String { "Converting failed: \(param)" }
}

public class MorphDocsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("MorphDocs")

    // none: unencrypted; restricted: can be opened without a password, but printing, copying, etc., are restricted (not lifted in P-027); locked: requires a password to open.
    AsyncFunction("pdfLockState") { (uri: URL) -> String in
      guard let doc = PDFDocument(url: uri) else { throw DocUnreadableException(uri.lastPathComponent) }
      return doc.isLocked ? "locked" : doc.isEncrypted ? "restricted" : "none"
    }

    // Returns nil when the password is incorrect.
    AsyncFunction("unlockPdf") { (uri: URL, password: String, output: URL) -> [String: Any]? in
      guard let doc = PDFDocument(url: uri) else { throw DocUnreadableException(uri.lastPathComponent) }
      guard doc.unlock(withPassword: password) else { return nil }
      // Files written directly after unlocking still retain the password (observed on macOS): copy
      // each page (along with annotations and forms on the page) into a new document. Bookmarks,
      // table of contents, and document info are not carried over.
      let copy = PDFDocument()
      for i in 0..<doc.pageCount {
        if let page = doc.page(at: i)?.copy() as? PDFPage { copy.insert(page, at: copy.pageCount) }
      }
      return try Self.write(copy, to: output, options: [:])
    }

    AsyncFunction("protectPdf") { (uri: URL, password: String, output: URL) -> [String: Any] in
      guard let doc = PDFDocument(url: uri), !doc.isLocked else {
        throw DocUnreadableException(uri.lastPathComponent)
      }
      return try Self.write(
        doc, to: output, options: [.userPasswordOption: password, .ownerPasswordOption: password])
    }

    AsyncFunction("toPdf") { (uri: URL, output: URL, page: [String: Double], promise: Promise) in
      Task { @MainActor in
        do {
          let renderer = DocRenderer()
          promise.resolve(try await renderer.render(uri, to: output, page: page))
        } catch let error as Exception {
          promise.reject(error)
        } catch {
          promise.reject(DocFailedException(error.localizedDescription))
        }
      }
    }
  }
}

extension MorphDocsModule {
  fileprivate static func write(
    _ doc: PDFDocument, to output: URL, options: [PDFDocumentWriteOption: Any]
  ) throws -> [String: Any] {
    guard doc.write(to: output, withOptions: options) else { throw DocFailedException("write") }
    let size = (try? FileManager.default.attributesOfItem(atPath: output.path)[.size] as? Int) ?? 0
    return ["uri": output.absoluteString, "size": size]
  }
}

@MainActor
private final class DocRenderer: NSObject, WKNavigationDelegate {
  private var webView: WKWebView?
  private var loaded: CheckedContinuation<Void, Error>?

  func render(_ uri: URL, to output: URL, page: [String: Double]) async throws -> [String: Any] {
    let width = page["width"] ?? 595.28
    let height = page["height"] ?? 841.89
    let margin = page["margin"] ?? 36
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .nonPersistent()
    let view = WKWebView(frame: CGRect(x: 0, y: 0, width: width - margin * 2, height: height), configuration: config)
    view.navigationDelegate = self
    // Some documents fail to lay out when not placed in a window: place off-screen with zero opacity.
    view.alpha = 0
    let window = UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first
    window?.insertSubview(view, at: 0)
    view.frame.origin = CGPoint(x: -10000, y: 0)
    webView = view
    defer {
      view.removeFromSuperview()
      webView = nil
    }

    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      loaded = continuation
      view.loadFileURL(uri, allowingReadAccessTo: uri)
    }
    try await waitForLayout(view)
    // Word documents are laid out within a "single page" frame (fixed width, margins, at least one
    // page high): remove the frame's dimensions and margins so pagination and margins are handled
    // by the print formatter below, otherwise short documents will produce an extra blank page.
    _ = try? await view.evaluateJavaScript(
      """
      (() => {
        const page = document.body.firstElementChild;
        if (!page || page.tagName !== 'DIV') return;
        Object.assign(page.style, { minHeight: '0', height: 'auto', width: 'auto', maxWidth: 'none', padding: '0', margin: '0' });
      })()
      """)
    // Excel (D-513): when the system formats spreadsheets into web pages, there is no spacing
    // between columns, causing right-aligned numbers to touch the text of the column to the right
    // ("433.2Open"), which merges into a single word when recognized (converted to Word) after
    // exporting to PDF. Leave a small gap to the left and right of each cell; after adding gaps, if
    // the table is wider than the page, scale it down to fit the page width without clipping the
    // last column.
    if ["xls", "xlsx"].contains(uri.pathExtension.lowercased()) {
      _ = try? await view.evaluateJavaScript(
        """
        (() => {
          const style = document.createElement('style');
          style.textContent = 'td,th{padding-left:4pt !important;padding-right:4pt !important;box-sizing:border-box}';
          document.head.appendChild(style);
          const wide = document.documentElement.scrollWidth, shown = document.documentElement.clientWidth;
          if (wide > shown && shown > 0) document.body.style.zoom = String(shown / wide);
        })()
        """)
    }
    let paper = CGRect(x: 0, y: 0, width: width, height: height)
    let renderer = UIPrintPageRenderer()
    renderer.addPrintFormatter(view.viewPrintFormatter(), startingAtPageAt: 0)
    renderer.setValue(paper, forKey: "paperRect")
    renderer.setValue(paper.insetBy(dx: margin, dy: margin), forKey: "printableRect")
    renderer.prepare(forDrawingPages: NSRange(location: 0, length: renderer.numberOfPages))
    let pages = renderer.numberOfPages
    if pages == 0 { throw DocUnreadableException("no pages") }
    let data = NSMutableData()
    UIGraphicsBeginPDFContextToData(data, paper, nil)
    for index in 0..<pages {
      UIGraphicsBeginPDFPage()
      renderer.drawPage(at: index, in: UIGraphicsGetPDFContextBounds())
    }
    UIGraphicsEndPDFContext()
    try? FileManager.default.removeItem(at: output)
    try FileManager.default.createDirectory(at: output.deletingLastPathComponent(), withIntermediateDirectories: true)
    guard data.write(to: output, atomically: true) else { throw DocFailedException("write") }
    return ["uri": output.absoluteString, "size": data.length, "pageCount": pages]
  }

  /**
   * After a document is formatted as a web page, its height continues to change for a moment:
   * wait until it remains identical twice in a row (up to 5 seconds). When height cannot be read
   * (document previews do not necessarily execute scripts), continue after a full 1 second; the
   * presence of content is determined by the pagination results.
   */
  private func waitForLayout(_ view: WKWebView) async throws {
    var last = -1.0
    for attempt in 0..<25 {
      try await Task.sleep(nanoseconds: 200_000_000)
      guard let height = try? await view.evaluateJavaScript("document.documentElement.scrollHeight") as? Double
      else {
        if attempt >= 4 { return }
        continue
      }
      if height > 0 && height == last { return }
      last = height
    }
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    loaded?.resume()
    loaded = nil
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    loaded?.resume(throwing: DocUnreadableException(error.localizedDescription))
    loaded = nil
  }

  func webView(
    _ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error
  ) {
    loaded?.resume(throwing: DocUnreadableException(error.localizedDescription))
    loaded = nil
  }

  /** Only allow opening the file itself; links and external images within the document are strictly blocked from loading. */
  func webView(
    _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void
  ) {
    decisionHandler(navigationAction.request.url?.isFileURL == true ? .allow : .cancel)
  }
}
