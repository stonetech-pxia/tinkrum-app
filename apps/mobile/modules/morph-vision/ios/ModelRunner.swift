import Foundation
import onnxruntime_objc

// Run an ONNX model with a single float32 input and a single float32 output (D-274: scan-flattened
// UVDoc grid model), same as Android's ModelRunner.kt: inputs and outputs use temporary files for
// the current run (float32 little-endian), with pre- and post-processing in JS. Models are cached
// by path (only one kept at a time; old model released when changing models).
final class ModelRunner {
  static let shared = ModelRunner()

  private let lock = NSLock()
  private var env: ORTEnv?
  private var loaded: String?
  private var session: ORTSession?

  /** Returns output shape; writes output as a float32 file. */
  func run(model: String, input: URL, shape: [Int], output: URL) throws -> [Int] {
    lock.lock()
    defer { lock.unlock() }
    if loaded != model || session == nil {
      session = nil
      let env = try self.env ?? ORTEnv(loggingLevel: .warning)
      self.env = env
      let options = try ORTSessionOptions()
      try options.setIntraOpNumThreads(Int32(min(4, max(1, ProcessInfo.processInfo.activeProcessorCount))))
      session = try ORTSession(env: env, modelPath: model, sessionOptions: options)
      loaded = model
    }
    guard let session else {
      throw NSError(domain: "ModelRunner", code: 3, userInfo: [NSLocalizedDescriptionKey: "model not loaded"])
    }
    let data = try Data(contentsOf: input, options: .alwaysMapped)
    let count = shape.reduce(1, *)
    guard data.count == count * 4 else {
      throw NSError(domain: "ModelRunner", code: 1, userInfo: [NSLocalizedDescriptionKey: "input has \(data.count) bytes, expected \(count * 4)"])
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
      throw NSError(domain: "ModelRunner", code: 2, userInfo: [NSLocalizedDescriptionKey: "no output"])
    }
    let dims = try out.tensorTypeAndShapeInfo().shape.map { $0.intValue }
    try (try out.tensorData() as Data).write(to: output)
    return dims
  }

  func unload() {
    lock.lock()
    defer { lock.unlock() }
    session = nil
    loaded = nil
  }
}
