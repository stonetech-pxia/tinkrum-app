import CoreImage
#if canImport(DataDetection)
import DataDetection
#endif
import ExpoModulesCore
import ImageIO
import PDFKit
import UIKit
import Vision
import VisionKit

// Text recognition and scanning (D-084): uses only iOS built-in Vision / VisionKit / Core Image,
// processed entirely on-device. Coordinate conventions match JS: pixels, origin at top-left (Vision
// and Core Image origins are at bottom-left, converted here). Recognized text is returned only to
// the app and is not logged.

final class VisionFailedException: GenericException<String>, @unchecked Sendable {
  override var reason: String { "Vision failed: \(param)" }
}

final class UnreadableImageException: Exception, @unchecked Sendable {
  override var reason: String { "Could not read the image" }
}

final class UnsupportedLanguageException: GenericException<String>, @unchecked Sendable {
  override var reason: String { "Text recognition does not support \(param)" }
}

final class DocumentCameraUnavailableException: Exception, @unchecked Sendable {
  override var reason: String { "The document camera is not available on this device" }
}

/** Cancelled via cancelClassify(taskId) (recognized by JS via error.code). */
private func classifyCancelled() -> Exception {
  Exception(name: "VisionCancelled", description: "Cancelled", code: "ERR_VISION_CANCELLED")
}

struct ClassifyOptions: Record {
  @Field var maxResults: Int = 10
  @Field var minConfidence: Double = 0.1
}

struct PointRecord: Record {
  @Field var x: Double = 0
  @Field var y: Double = 0
}

struct QuadRecord: Record {
  @Field var tl = PointRecord()
  @Field var tr = PointRecord()
  @Field var br = PointRecord()
  @Field var bl = PointRecord()
}

public class MorphVisionModule: Module {
  private lazy var ciContext = CIContext(options: [.useSoftwareRenderer: false])
  private var cameraDelegate: DocumentCameraDelegate?
  /** Ongoing image classifications, used for cancellation (protected by classifyLock). */
  private var classifying: [String: VNRequest] = [:]
  private var cancelledClassify: Set<String> = []
  private let classifyLock = NSLock()

  public func definition() -> ModuleDefinition {
    Name("MorphVision")

    Function("isDocumentCameraSupported") { () -> Bool in
      VNDocumentCameraViewController.isSupported
    }

    // Camera availability check: When no camera is available (e.g. on simulator), expo-image-picker throws a native exception that crashes the app, so check beforehand.
    Function("isCameraAvailable") { () -> Bool in
      UIImagePickerController.isSourceTypeAvailable(.camera)
    }

    Function("backgroundRemovalSupported") { () -> Bool in
      if #available(iOS 17.0, *) { return true }
      return false
    }

    AsyncFunction("backgroundStatus") { () -> String in
      if #available(iOS 17.0, *) { return "ready" }
      return "unsupported"
    }

    AsyncFunction("downloadBackgroundModel") { () -> Void in }

    AsyncFunction("removeBackground") { (uri: URL, background: String, output: URL) -> [String: Any] in
      return try self.removeBackground(uri, background: background, output: output)
    }

    // System recognition for "log an expense" prefill, supplementing rules only (D-244): From iOS
    // 26 onwards, DataDetection recognizes dates and amounts; earlier systems use NSDataDetector,
    // recognizing dates only. No download required; language is just a hint.
    AsyncFunction("detectData") { (text: String, language: String, _: Bool) async -> [[String: Any]] in
      await Self.detectData(text, language: language)
    }

    AsyncFunction("dataDetectionStatus") { (_: String) -> String in
      "ready"
    }

    // iOS recognition is built into the system and does not require downloading.
    AsyncFunction("downloadDataModel") { (_: String) in }

    // What is in the photo (used for recommendations on photos without text, not yet integrated
    // into recommendations): Built-in Vision image classification, no model download. Labels are
    // Vision's own English identifiers, which differ from Android ML Kit's terminology.
    AsyncFunction("classifyImage") { (taskId: String, uri: URL, options: ClassifyOptions) -> [String: Any] in
      return try self.classifyImage(taskId, uri: uri, options: options)
    }

    Function("cancelClassify") { (taskId: String) in
      self.cancelClassify(taskId)
    }

    // ID photo / portrait (D-252): Face bounding box (pixels, origin at top-left, adjusted for EXIF orientation) and retaining only the portrait with a solid color background replacement.
    AsyncFunction("detectFaces") { (uri: URL) -> [String: Any] in
      return try self.detectFaces(uri)
    }

    AsyncFunction("replacePersonBackground") { (uri: URL, color: String, output: URL) -> [String: Any] in
      return try self.replacePersonBackground(uri, color: color, output: output)
    }

    AsyncFunction("adjustImage") { (uri: URL, options: [String: Any], format: String, output: URL) -> [String: Any] in
      return try self.adjustImage(uri, options: options, format: format, output: output)
    }

    // iOS can find the four corners of a paper document (Android ML Kit cannot).
    Function("canFindPaper") { () -> Bool in
      true
    }

    // PDF text layer (D-455): PDFKit extracts the entire text; returns nil if there is no text layer or if a password is required. Text is returned only to the app and never written to logs.
    AsyncFunction("pdfText") { (uri: URL) -> String? in
      guard let doc = PDFDocument(url: uri), !doc.isLocked else { return nil }
      guard let text = doc.string?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty
      else { return nil }
      return text
    }

    // Thumbnail of the first page of a PDF (D-451): Rendered natively by PDFKit on a white
    // background, with the long side not exceeding maxSide, saved as JPEG. Throws an error if it
    // cannot be opened (damaged, password required), causing the app to display a PDF icon.
    AsyncFunction("pdfThumbnail") { (uri: URL, output: URL, maxSide: Double) -> [String: Any] in
      guard let doc = PDFDocument(url: uri), !doc.isLocked, let page = doc.page(at: 0) else {
        throw VisionFailedException("PDF can't be opened")
      }
      let box = page.bounds(for: .mediaBox)
      let rotated = page.rotation % 180 != 0
      let w = rotated ? box.height : box.width
      let h = rotated ? box.width : box.height
      guard w > 0, h > 0 else { throw VisionFailedException("PDF page is empty") }
      let scale = maxSide / max(w, h)
      let size = CGSize(width: max(1, (w * scale).rounded()), height: max(1, (h * scale).rounded()))
      let format = UIGraphicsImageRendererFormat()
      format.scale = 1
      format.opaque = true
      let image = UIGraphicsImageRenderer(size: size, format: format).image { ctx in
        UIColor.white.setFill()
        ctx.fill(CGRect(origin: .zero, size: size))
        page.thumbnail(of: size, for: .mediaBox).draw(in: CGRect(origin: .zero, size: size))
      }
      guard let data = image.jpegData(compressionQuality: 0.8) else {
        throw VisionFailedException("JPEG encoding failed")
      }
      try FileManager.default.createDirectory(
        at: output.deletingLastPathComponent(), withIntermediateDirectories: true)
      try data.write(to: output)
      return ["width": Int(size.width), "height": Int(size.height), "pageCount": doc.pageCount]
    }

    // Checks whether the system can recognize a given language (BCP 47); if not, the app falls back to the text recognition package.
    Function("supportsLanguage") { (code: String) -> Bool in
      let supported = (try? VNRecognizeTextRequest().supportedRecognitionLanguages()) ?? []
      return Self.match(code, in: supported) != nil
    }

    // The two PP-OCRv6 models (D-269): paths are files within the pack; inputs and outputs are temporary files for the current run.
    AsyncFunction("ocrLoad") { (det: URL, rec: URL) in
      try OcrRunner.shared.load(det: det.path, rec: rec.path)
    }
    AsyncFunction("ocrDetect") { (input: URL, width: Int, height: Int, output: URL) in
      try OcrRunner.shared.detect(input: input, width: width, height: height, output: output)
    }
    AsyncFunction("ocrRecognize") { (input: URL, count: Int, width: Int, output: URL) -> Int in
      try OcrRunner.shared.recognize(input: input, count: count, width: width, output: output)
    }
    AsyncFunction("ocrUnload") {
      OcrRunner.shared.unload()
    }

    // Scan-flattened UVDoc grid model (D-274): one float32 input and one float32 output, both via temporary files, returning the output shape.
    AsyncFunction("modelRun") { (model: URL, input: URL, shape: [Int], output: URL) -> [Int] in
      try ModelRunner.shared.run(model: model.path, input: input, shape: shape, output: output)
    }
    AsyncFunction("modelUnload") {
      ModelRunner.shared.unload()
    }

    AsyncFunction("supportedLanguages") { () -> [String] in
      try VNRecognizeTextRequest().supportedRecognitionLanguages()
    }

    // Recognize text: accurate level + language correction. languages are BCP 47 codes, prioritized in order.
    AsyncFunction("recognizeText") { (uri: URL, languages: [String]) -> [String: Any] in
      let image = try self.loadImage(uri)
      let request = VNRecognizeTextRequest()
      request.recognitionLevel = .accurate
      request.usesLanguageCorrection = true
      let supported = try request.supportedRecognitionLanguages()
      var chosen: [String] = []
      for code in languages {
        if let found = Self.match(code, in: supported), !chosen.contains(found) { chosen.append(found) }
      }
      // The first language is user-selected and must be supported; subsequent ones (such as English) are merely supplementary.
      if Self.match(languages.first ?? "", in: supported) == nil { throw UnsupportedLanguageException(languages.joined(separator: ",")) }
      request.recognitionLanguages = chosen
      do {
        try VNImageRequestHandler(ciImage: image, options: [:]).perform([request])
      } catch {
        throw VisionFailedException(error.localizedDescription)
      }
      let lines = (request.results ?? []).compactMap { obs -> TextLine? in
        guard let best = obs.topCandidates(1).first else { return nil }
        return TextLine(text: best.string, box: obs.boundingBox, confidence: best.confidence)
      }
      // Line position (D-195, searchable PDF text layer): Pixels, origin at top-left (Vision bounding boxes use 0-1 range with origin at bottom-left).
      let size = image.extent.size
      let items = lines.map { line -> [String: Any] in
        [
          "text": line.text,
          "x": line.box.minX * size.width,
          "y": (1 - line.box.maxY) * size.height,
          "width": line.box.width * size.width,
          "height": line.box.height * size.height,
        ]
      }
      return [
        "text": Self.layout(lines),
        "lines": lines.count,
        "languages": request.recognitionLanguages,
        "width": size.width,
        "height": size.height,
        "items": items,
      ]
    }

    // Find document candidates (D-327): Quadrilaterals from document segmentation (specifically for
    // finding paper) and several quadrilaterals from rectangle detection, plus a grayscale image
    // with a long side of about 500. The app's pickPaper decides which one to select, using the
    // same judgment logic as Android's scanning package (D-326).
    AsyncFunction("detectDocument") { (uri: URL) -> [String: Any] in
      let image = try self.loadImage(uri)
      let size = image.extent.size
      let handler = VNImageRequestHandler(ciImage: image, options: [:])
      let segmentation = VNDetectDocumentSegmentationRequest()
      let rectangles = VNDetectRectanglesRequest()
      rectangles.maximumObservations = 5
      rectangles.minimumSize = 0.2
      rectangles.minimumConfidence = 0.5
      rectangles.minimumAspectRatio = 0.2
      rectangles.maximumAspectRatio = 1.0
      rectangles.quadratureTolerance = 30
      _ = try? handler.perform([segmentation])
      _ = try? handler.perform([rectangles])
      let found = (segmentation.results ?? []).filter { $0.confidence >= 0.5 } + (rectangles.results ?? [])
      let p = { (n: CGPoint) -> [String: Double] in
        ["x": Double(n.x * size.width), "y": Double((1 - n.y) * size.height)]
      }
      return [
        "width": Int(size.width.rounded()),
        "height": Int(size.height.rounded()),
        "candidates": found.map { [p($0.topLeft), p($0.topRight), p($0.bottomRight), p($0.bottomLeft)] },
        "gray": try self.grayThumbnail(image, maxSide: 500),
      ]
    }

    // Straighten using the four corners (Core Image perspective correction), scale to width × height, and save as JPG.
    AsyncFunction("straighten") {
      (uri: URL, quad: QuadRecord, width: Int, height: Int, quality: Double, output: URL) -> [String: Any] in
      let image = try self.loadImage(uri)
      let h = image.extent.height
      let vector = { (p: PointRecord) in CIVector(x: CGFloat(p.x), y: h - CGFloat(p.y)) }
      guard let filter = CIFilter(name: "CIPerspectiveCorrection") else {
        throw VisionFailedException("CIPerspectiveCorrection")
      }
      filter.setValue(image, forKey: kCIInputImageKey)
      filter.setValue(vector(quad.tl), forKey: "inputTopLeft")
      filter.setValue(vector(quad.tr), forKey: "inputTopRight")
      filter.setValue(vector(quad.br), forKey: "inputBottomRight")
      filter.setValue(vector(quad.bl), forKey: "inputBottomLeft")
      guard let corrected = filter.outputImage, corrected.extent.width >= 1, corrected.extent.height >= 1 else {
        throw VisionFailedException("perspective correction")
      }
      let w = CGFloat(max(1, width))
      let ht = CGFloat(max(1, height))
      let moved = corrected.transformed(
        by: CGAffineTransform(translationX: -corrected.extent.minX, y: -corrected.extent.minY))
      let scaled = moved
        .transformed(by: CGAffineTransform(scaleX: w / moved.extent.width, y: ht / moved.extent.height))
        .cropped(to: CGRect(x: 0, y: 0, width: w, height: ht))
      try self.writeJpeg(scaled, to: output, quality: quality)
      return ["width": Int(w), "height": Int(ht), "size": Self.fileSize(output)]
    }

    // System document camera (VisionKit): Real-time edge detection, auto-capture, multi-page,
    // straightened upon capture. Each page is saved as a JPG (long side not exceeding maxSide) in
    // the directory; returns null if the user cancels.
    AsyncFunction("scanDocuments") { (directory: URL, maxSide: Int, quality: Double, promise: Promise) in
      guard VNDocumentCameraViewController.isSupported else {
        promise.reject(DocumentCameraUnavailableException())
        return
      }
      guard let presenter = self.appContext?.utilities?.currentViewController() else {
        promise.reject(DocumentCameraUnavailableException())
        return
      }
      let camera = VNDocumentCameraViewController()
      // Clear cameraDelegate upon completion to break the self ↔ delegate reference cycle.
      let delegate = DocumentCameraDelegate { result in
        camera.dismiss(animated: true)
        self.cameraDelegate = nil
        switch result {
        case .cancelled:
          promise.resolve(nil)
        case .failed(let error):
          promise.reject(VisionFailedException(error.localizedDescription))
        case .finished(let scan):
          // Perform encoding in the background to avoid blocking the UI.
          DispatchQueue.global(qos: .userInitiated).async {
            do {
              promise.resolve(try self.savePages(scan, directory: directory, maxSide: maxSide, quality: quality))
            } catch {
              promise.reject(error)
            }
          }
        }
      }
      self.cameraDelegate = delegate
      camera.delegate = delegate
      presenter.present(camera, animated: true)
    }
    .runOnQueue(DispatchQueue.main)
  }

  // MARK: - Helpers

  private func adjustImage(_ uri: URL, options: [String: Any], format: String, output: URL) throws -> [String: Any] {
    let image = try loadImage(uri)
    let automatic = options["mode"] as? String == "auto"
    var result = image
    if automatic {
      for filter in image.autoAdjustmentFilters(options: [.enhance: true, .redEye: false]) {
        filter.setValue(result, forKey: kCIInputImageKey)
        if let adjusted = filter.outputImage { result = adjusted }
      }
    } else {
      let brightness = (options["brightness"] as? NSNumber)?.doubleValue ?? 0
      let contrast = (options["contrast"] as? NSNumber)?.doubleValue ?? 100
      let saturation = (options["saturation"] as? NSNumber)?.doubleValue ?? 100
      guard brightness.isFinite, contrast.isFinite, saturation.isFinite, (-100...100).contains(brightness), (0...200).contains(contrast), (0...200).contains(saturation) else { throw VisionFailedException("invalid adjustment") }
      result = image.applyingFilter("CIColorControls", parameters: [kCIInputBrightnessKey: brightness/100, kCIInputContrastKey: contrast/100, kCIInputSaturationKey: saturation/100])
    }
    result = result.cropped(to: image.extent)
    try FileManager.default.createDirectory(at: output.deletingLastPathComponent(), withIntermediateDirectories: true)
    if format == "png" {
      try ciContext.writePNGRepresentation(of: result, to: output, format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!)
    } else {
      try writeJpeg(result, to: output, quality: 0.92)
    }
    return ["width": Int(result.extent.width), "height": Int(result.extent.height), "size": (try FileManager.default.attributesOfItem(atPath: output.path)[.size] as? NSNumber)?.intValue ?? 0]
  }

  private func removeBackground(_ uri: URL, background: String, output: URL) throws -> [String: Any] {
    guard #available(iOS 17.0, *) else { throw VisionFailedException("iOS 17 required") }
    let image = try loadImage(uri)
    let handler = VNImageRequestHandler(ciImage: image, options: [:])
    let request = VNGenerateForegroundInstanceMaskRequest()
    do { try handler.perform([request]) } catch { throw VisionFailedException(error.localizedDescription) }
    guard let observation = request.results?.first, !observation.allInstances.isEmpty else { throw VisionFailedException("no subject") }
    let buffer = try observation.generateMaskedImage(ofInstances: observation.allInstances, from: handler, croppedToInstancesExtent: false)
    return try writeCutout(CIImage(cvPixelBuffer: buffer), background: background, output: output)
  }

  private func detectFaces(_ uri: URL) throws -> [String: Any] {
    let image = try loadImage(uri)
    let request = VNDetectFaceRectanglesRequest()
    let handler = VNImageRequestHandler(ciImage: image, options: [:])
    do { try handler.perform([request]) } catch { throw VisionFailedException(error.localizedDescription) }
    let width = image.extent.width
    let height = image.extent.height
    // Vision bounding boxes use 0-1 proportions with origin at bottom-left: convert to pixels with origin at top-left.
    let faces: [[String: Double]] = (request.results ?? []).map { face in
      let box = face.boundingBox
      return [
        "x": Double(box.minX * width),
        "y": Double((1 - box.maxY) * height),
        "width": Double(box.width * width),
        "height": Double(box.height * height),
      ]
    }
    return ["width": Int(width), "height": Int(height), "faces": faces]
  }

  /**
   * Portrait segmentation (iOS 15+, VNGeneratePersonSegmentationRequest, accurate): keep person,
   * replace the rest with a solid color, output PNG. The mask is smaller than the original image;
   * upscale to original size before blending; hair edges have a semi-transparent transition.
   */
  private func replacePersonBackground(_ uri: URL, color: String, output: URL) throws -> [String: Any] {
    guard color.range(of: "^#[0-9A-Fa-f]{6}$", options: .regularExpression) != nil,
          let rgb = UInt32(color.dropFirst(), radix: 16) else { throw VisionFailedException("invalid color") }
    let image = try loadImage(uri)
    let request = VNGeneratePersonSegmentationRequest()
    request.qualityLevel = .accurate
    request.outputPixelFormat = kCVPixelFormatType_OneComponent8
    let handler = VNImageRequestHandler(ciImage: image, options: [:])
    do { try handler.perform([request]) } catch { throw VisionFailedException(error.localizedDescription) }
    guard let buffer = request.results?.first?.pixelBuffer else { throw VisionFailedException("no person") }
    var mask = CIImage(cvPixelBuffer: buffer)
    mask = mask.transformed(by: CGAffineTransform(
      scaleX: image.extent.width / mask.extent.width, y: image.extent.height / mask.extent.height))
    let fill = CIImage(color: CIColor(
      red: CGFloat((rgb >> 16) & 255) / 255, green: CGFloat((rgb >> 8) & 255) / 255, blue: CGFloat(rgb & 255) / 255
    )).cropped(to: image.extent)
    guard let blend = CIFilter(name: "CIBlendWithMask", parameters: [
      kCIInputImageKey: image, kCIInputBackgroundImageKey: fill, kCIInputMaskImageKey: mask,
    ])?.outputImage?.cropped(to: image.extent) else { throw VisionFailedException("blend") }
    try FileManager.default.createDirectory(at: output.deletingLastPathComponent(), withIntermediateDirectories: true)
    try ciContext.writePNGRepresentation(of: blend, to: output, format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!)
    return ["width": Int(blend.extent.width), "height": Int(blend.extent.height), "size": Self.fileSize(output)]
  }

  private func writeCutout(_ foreground: CIImage, background: String, output: URL) throws -> [String: Any] {
    let result: CIImage
    if background == "transparent" {
      result = foreground
    } else {
      guard background.range(of: "^#[0-9A-Fa-f]{6}$", options: .regularExpression) != nil,
            let rgb = UInt32(background.dropFirst(), radix: 16) else { throw VisionFailedException("invalid color") }
      let color = CIColor(red: CGFloat((rgb >> 16) & 255)/255, green: CGFloat((rgb >> 8) & 255)/255, blue: CGFloat(rgb & 255)/255)
      result = foreground.composited(over: CIImage(color: color).cropped(to: foreground.extent))
    }
    try FileManager.default.createDirectory(at: output.deletingLastPathComponent(), withIntermediateDirectories: true)
    try ciContext.writePNGRepresentation(of: result, to: output, format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!)
    return ["width": Int(result.extent.width), "height": Int(result.extent.height), "size": (try FileManager.default.attributesOfItem(atPath: output.path)[.size] as? NSNumber)?.intValue ?? 0]
  }

  /**
   * Positions are in UTF-16 (same as JS strings); dates are formatted as YYYY-MM-DD using the
   * recognized time zone (falling back to local time zone if absent), and amounts are the numbers
   * read by the system (JS normalizes them further against the original text). Text is not
   * written to logs.
   */
  private static func detectData(_ text: String, language: String) async -> [[String: Any]] {
    #if canImport(DataDetection)
    if #available(iOS 26.0, *) {
      var options = DataDetector.Options()
      if !language.isEmpty { options.documentLanguageCode = Locale.LanguageCode(language) }
      var out: [[String: Any]] = []
      for await match in text.dataDetectorMatches([.moneyAmount, .calendarEvent], options: options) {
        guard let range = match.range else { continue }
        let start = text.utf16.distance(from: text.utf16.startIndex, to: range.lowerBound)
        let end = text.utf16.distance(from: text.utf16.startIndex, to: range.upperBound)
        switch match.details {
        case .moneyAmount(let money):
          out.append(["kind": "amount", "start": start, "end": end, "value": "\(money.amount)"])
        case .calendarEvent(let event):
          if let date = event.startDate {
            out.append(["kind": "date", "start": start, "end": end, "value": dayString(date, event.startTimeZone)])
          }
        default:
          break
        }
      }
      return out
    }
    #endif
    guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.date.rawValue) else { return [] }
    let whole = NSRange(text.startIndex..., in: text)
    return detector.matches(in: text, range: whole).compactMap { match -> [String: Any]? in
      guard let date = match.date else { return nil }
      return [
        "kind": "date", "start": match.range.location, "end": match.range.location + match.range.length,
        "value": dayString(date, match.timeZone),
      ]
    }
  }

  private static func dayString(_ date: Date, _ zone: TimeZone?) -> String {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = zone ?? .current
    let c = calendar.dateComponents([.year, .month, .day], from: date)
    return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
  }

  /** Image for classification: A long side of 1024 is sufficient (the model rescales it further); even a 200 MP original image does not need full decoding. */
  private static let classifyMaxSide = 1024

  /**
   * Do not write intermediate files; resized images reside in memory only. cancelClassify cancels
   * the Vision request and terminates this run with ERR_VISION_CANCELLED; cancellations for
   * requests that haven't started or have already finished have no effect (JS resolves or rejects
   * its promise earlier).
   */
  private func classifyImage(_ taskId: String, uri: URL, options: ClassifyOptions) throws -> [String: Any] {
    let request = VNClassifyImageRequest()
    classifyLock.lock()
    classifying[taskId] = request
    classifyLock.unlock()
    defer {
      classifyLock.lock()
      classifying[taskId] = nil
      cancelledClassify.remove(taskId)
      classifyLock.unlock()
    }
    let image = try loadThumbnail(uri, maxSide: Self.classifyMaxSide)
    if isClassifyCancelled(taskId) { throw classifyCancelled() }
    do {
      try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
    } catch {
      if isClassifyCancelled(taskId) { throw classifyCancelled() }
      throw VisionFailedException(error.localizedDescription)
    }
    if isClassifyCancelled(taskId) { throw classifyCancelled() }
    let labels = (request.results ?? [])
      .filter { Double($0.confidence) >= options.minConfidence }
      .sorted { $0.confidence > $1.confidence }
      .prefix(max(0, options.maxResults))
      .map { ["id": $0.identifier, "confidence": Double($0.confidence)] as [String: Any] }
    return ["labels": Array(labels), "width": image.width, "height": image.height]
  }

  private func cancelClassify(_ taskId: String) {
    classifyLock.lock()
    defer { classifyLock.unlock() }
    guard let request = classifying[taskId] else { return }
    cancelledClassify.insert(taskId)
    request.cancel()
  }

  private func isClassifyCancelled(_ taskId: String) -> Bool {
    classifyLock.lock()
    defer { classifyLock.unlock() }
    return cancelledClassify.contains(taskId)
  }

  /** Adjust orientation according to EXIF and decode directly scaled down to maxSide on the long edge (ImageIO thumbnail, avoiding decoding the full original image first). */
  private func loadThumbnail(_ uri: URL, maxSide: Int) throws -> CGImage {
    let options = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceThumbnailMaxPixelSize: maxSide,
      kCGImageSourceShouldCacheImmediately: true,
    ] as CFDictionary
    guard let source = CGImageSourceCreateWithURL(uri as CFURL, nil),
          let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options) else {
      throw UnreadableImageException()
    }
    return image
  }

  /** Small grayscale image for pickPaper (D-327): long side maxSide, one byte per pixel, first row is the top of the image, base64-encoded. */
  private func grayThumbnail(_ image: CIImage, maxSide: Int) throws -> [String: Any] {
    let k = min(1, CGFloat(maxSide) / max(image.extent.width, image.extent.height))
    let w = max(1, Int((image.extent.width * k).rounded()))
    let h = max(1, Int((image.extent.height * k).rounded()))
    let small = image.transformed(by: CGAffineTransform(scaleX: k, y: k))
    guard let cg = ciContext.createCGImage(small, from: CGRect(x: 0, y: 0, width: w, height: h)),
          let context = CGContext(
            data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w,
            space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue),
          let pixels = context.data else {
      throw VisionFailedException("gray thumbnail")
    }
    context.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
    let data = Data(bytes: pixels, count: w * h)
    return ["width": w, "height": h, "data": data.base64EncodedString()]
  }

  private func loadImage(_ uri: URL) throws -> CIImage {
    // Correct orientation according to EXIF direction, matching the direction seen in the app.
    guard let image = CIImage(contentsOf: uri, options: [.applyOrientationProperty: true]) else {
      throw UnreadableImageException()
    }
    // Move the origin to (0, 0).
    return image.transformed(by: CGAffineTransform(translationX: -image.extent.minX, y: -image.extent.minY))
  }

  private func writeJpeg(_ image: CIImage, to url: URL, quality: Double) throws {
    try FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
    let options = [
      CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String): quality
    ]
    do {
      try ciContext.writeJPEGRepresentation(of: image, to: url, colorSpace: colorSpace, options: options)
    } catch {
      throw VisionFailedException(error.localizedDescription)
    }
  }

  private func savePages(_ scan: VNDocumentCameraScan, directory: URL, maxSide: Int, quality: Double) throws -> [[String: Any]] {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    var pages: [[String: Any]] = []
    for i in 0..<scan.pageCount {
      var image = CIImage(image: scan.imageOfPage(at: i)) ?? CIImage()
      let side = max(image.extent.width, image.extent.height)
      if side > CGFloat(maxSide) {
        let k = CGFloat(maxSide) / side
        image = image.transformed(by: CGAffineTransform(scaleX: k, y: k))
      }
      let w = image.extent.width.rounded(.down)
      let h = image.extent.height.rounded(.down)
      image = image
        .transformed(by: CGAffineTransform(translationX: -image.extent.minX, y: -image.extent.minY))
        .cropped(to: CGRect(x: 0, y: 0, width: w, height: h))
      let url = directory.appendingPathComponent("page-\(i + 1).jpg")
      try? FileManager.default.removeItem(at: url)
      try writeJpeg(image, to: url, quality: quality)
      pages.append(["uri": url.absoluteString, "width": Int(w), "height": Int(h), "size": Self.fileSize(url)])
    }
    return pages
  }

  private static func fileSize(_ url: URL) -> Int {
    (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
  }

  /** "vi" can match the system-supported "vi-VT"; "zh-Hans" matches exactly. */
  static func match(_ code: String, in supported: [String]) -> String? {
    if supported.contains(code) { return code }
    let prefix = code.split(separator: "-").first.map(String.init) ?? code
    return supported.first { $0 == prefix || $0.hasPrefix(prefix + "-") }
  }

  struct TextLine {
    let text: String
    let box: CGRect
    let confidence: Float
  }

  /**
   * Arranging recognized text segments into lines: segments at the same vertical height (such as
   * item names and prices on a receipt) are placed on the same line and separated by spaces;
   * leave a blank line (paragraph break) when line spacing increases significantly. Vision
   * coordinate origin is at the bottom-left, so larger y means higher up.
   */
  static func layout(_ lines: [TextLine]) -> String {
    let sorted = lines.sorted { $0.box.midY > $1.box.midY }
    var rows: [[TextLine]] = []
    for line in sorted {
      if let last = rows.last, let first = last.first {
        let overlap = min(first.box.maxY, line.box.maxY) - max(first.box.minY, line.box.minY)
        if overlap >= 0.5 * min(first.box.height, line.box.height) {
          rows[rows.count - 1].append(line)
          continue
        }
      }
      rows.append([line])
    }
    let heights = sorted.map { $0.box.height }.sorted()
    let typical = heights.isEmpty ? 0 : heights[heights.count / 2]
    var out: [String] = []
    var previous: CGRect?
    for row in rows {
      let text = row.sorted { $0.box.minX < $1.box.minX }.map(\.text).joined(separator: " ")
      let box = row.map(\.box).reduce(row[0].box) { $0.union($1) }
      if let prev = previous, prev.minY - box.maxY > 1.2 * typical {
        out.append("")
      }
      out.append(text)
      previous = box
    }
    return out.joined(separator: "\n")
  }
}

enum DocumentCameraResult {
  case finished(VNDocumentCameraScan)
  case cancelled
  case failed(Error)
}

final class DocumentCameraDelegate: NSObject, VNDocumentCameraViewControllerDelegate {
  private let onDone: (DocumentCameraResult) -> Void

  init(onDone: @escaping (DocumentCameraResult) -> Void) {
    self.onDone = onDone
  }

  func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFinishWith scan: VNDocumentCameraScan) {
    onDone(.finished(scan))
  }

  func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) {
    onDone(.cancelled)
  }

  func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFailWithError error: Error) {
    onDone(.failed(error))
  }
}
