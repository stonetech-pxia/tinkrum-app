import Foundation
import onnxruntime_objc

// The text recognition model (PP-OCRv6, D-269) runs exclusively here, matching Android's
// OcrRunner.kt: inputs and outputs use run-local temporary files, with pre- and post-processing
// handled in JS (@morph/tool-ocr). Finding text lines: input float32 tensor of shape [1, 3, h, w],
// output probability × 255 per pixel (1 byte). Recognizing text: input tensor of shape [n, 3, 48,
// w], output highest-probability category (int32) and probability (float32) for each item and time
// step, arranged as [n, steps].
final class OcrRunner {
  static let shared = OcrRunner()

  private let lock = NSLock()
  private var env: ORTEnv?
  private var loaded: (String, String)?
  private var det: ORTSession?
  private var rec: ORTSession?

  func load(det detPath: String, rec recPath: String) throws {
    lock.lock()
    defer { lock.unlock() }
    if let loaded, loaded == (detPath, recPath) { return }
    let env = try self.env ?? ORTEnv(loggingLevel: .warning)
    self.env = env
    let options = try ORTSessionOptions()
    try options.setIntraOpNumThreads(Int32(min(4, max(1, ProcessInfo.processInfo.activeProcessorCount))))
    det = try ORTSession(env: env, modelPath: detPath, sessionOptions: options)
    rec = try ORTSession(env: env, modelPath: recPath, sessionOptions: options)
    loaded = (detPath, recPath)
  }

  func unload() {
    lock.lock()
    defer { lock.unlock() }
    det = nil
    rec = nil
    loaded = nil
  }

  private func run(_ session: ORTSession, input: URL, shape: [Int]) throws -> ORTValue {
    let data = try Data(contentsOf: input, options: .alwaysMapped)
    let count = shape.reduce(1, *)
    guard data.count == count * 4 else {
      throw NSError(domain: "OcrRunner", code: 1, userInfo: [NSLocalizedDescriptionKey: "input has \(data.count) bytes, expected \(count * 4)"])
    }
    let tensor = try ORTValue(
      tensorData: NSMutableData(data: data),
      elementType: .float,
      shape: shape.map { NSNumber(value: $0) }
    )
    let inputName = try session.inputNames().first ?? "x"
    let outputName = try session.outputNames().first ?? ""
    let outputs = try session.run(withInputs: [inputName: tensor], outputNames: [outputName], runOptions: nil)
    guard let out = outputs[outputName] else {
      throw NSError(domain: "OcrRunner", code: 2, userInfo: [NSLocalizedDescriptionKey: "no output"])
    }
    return out
  }

  func detect(input: URL, width: Int, height: Int, output: URL) throws {
    lock.lock()
    defer { lock.unlock() }
    guard let det else { throw NSError(domain: "OcrRunner", code: 3, userInfo: [NSLocalizedDescriptionKey: "models not loaded"]) }
    let out = try run(det, input: input, shape: [1, 3, height, width])
    let probs = try out.tensorData() as Data
    var bytes = [UInt8](repeating: 0, count: width * height)
    probs.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
      let p = raw.bindMemory(to: Float.self)
      for i in 0..<min(bytes.count, p.count) {
        bytes[i] = UInt8((min(1, max(0, p[i])) * 255).rounded())
      }
    }
    try Data(bytes).write(to: output)
  }

  /** Returns the number of time steps. */
  func recognize(input: URL, count: Int, width: Int, output: URL) throws -> Int {
    lock.lock()
    defer { lock.unlock() }
    guard let rec else { throw NSError(domain: "OcrRunner", code: 3, userInfo: [NSLocalizedDescriptionKey: "models not loaded"]) }
    let out = try run(rec, input: input, shape: [count, 3, 48, width])
    let shape = try out.tensorTypeAndShapeInfo().shape.map { $0.intValue }
    let steps = shape[1]
    let classes = shape[2]
    let probs = try out.tensorData() as Data
    var best = [Int32](repeating: 0, count: count * steps)
    var bestProb = [Float](repeating: 0, count: count * steps)
    probs.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
      let p = raw.bindMemory(to: Float.self)
      for r in 0..<(count * steps) {
        var k = 0
        var v = p[r * classes]
        for c in 1..<classes where p[r * classes + c] > v {
          v = p[r * classes + c]
          k = c
        }
        best[r] = Int32(k)
        bestProb[r] = v
      }
    }
    // First count × steps int32 categories, followed by count × steps float32 probabilities (little-endian, matching JS typed arrays).
    var packed = Data(capacity: count * steps * 8)
    best.withUnsafeBufferPointer { packed.append(Data(buffer: $0)) }
    bestProb.withUnsafeBufferPointer { packed.append(Data(buffer: $0)) }
    try packed.write(to: output)
    return steps
  }
}
