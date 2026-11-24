import AVFoundation
import ExpoModulesCore

// Text-to-speech (D-270): uses only the built-in iOS AVSpeechSynthesizer to read text into an audio
// file on-device without playing it. Each segment is an AVSpeechUtterance; PCM data returned by
// write(_:toBufferCallback:) is written sequentially into a single WAV (16-bit). Selects the
// highest quality system voice for the language (preferring enhanced/premium voices downloaded by
// the user in Settings → Accessibility → Spoken Content → Voices), avoiding novelty or personal
// voices like Albert. Text is passed exclusively to the system speech engine and never logged.

private func ttsError(_ code: String, _ reason: String) -> Exception {
  Exception(name: "TTSError", description: reason, code: code)
}

private let noVoice = { (voice: String) in ttsError("ERR_TTS_NO_VOICE", "No voice for \(voice)") }
private let cancelled = { ttsError("ERR_TTS_CANCELLED", "Cancelled") }
private let failed = { (detail: String) in ttsError("ERR_TTS_FAILED", detail) }

/** Duration of silence without new audio before considering a synthesis stalled (system speech is much faster than real-time, so it should not normally pause this long). */
private let stallSeconds: TimeInterval = 30

struct SynthesizeOptions: Record {
  @Field var taskId: String = ""
  @Field var voice: String = ""
  @Field var rate: Double = 1
  @Field var output: String = ""
}

public class MorphTTSModule: Module {
  /** Ongoing speech synthesis tasks, used for cancellation (protected by a lock). */
  private var running: [String: TTSJob] = [:]
  private let lock = NSLock()

  public func definition() -> ModuleDefinition {
    Name("MorphTTS")

    Events("onProgress")

    // iOS voices are managed by the system: present means installed, absent means unsupported (there is no downloadable state queryable).
    AsyncFunction("voiceStatus") { (voice: String) -> String in
      Self.pickVoice(voice) == nil ? "unsupported" : "installed"
    }

    AsyncFunction("synthesize") { (segments: [String], options: SynthesizeOptions) async throws -> [String: Any] in
      try await self.synthesize(segments, options)
    }

    Function("cancel") { (taskId: String) in
      self.lock.lock()
      let job = self.running[taskId]
      self.lock.unlock()
      job?.cancel()
    }
  }

  /** Highest quality system voice for the given language (BCP 47: zh-CN). Chinese does not fall back to other regions (e.g., zh-HK is Cantonese). */
  static func pickVoice(_ tag: String) -> AVSpeechSynthesisVoice? {
    let wanted = tag.lowercased().replacingOccurrences(of: "_", with: "-")
    let base = String(wanted.prefix { $0 != "-" })
    let voices = AVSpeechSynthesisVoice.speechVoices().filter { voice in
      if #available(iOS 17.0, *) {
        if voice.voiceTraits.contains(.isNoveltyVoice) || voice.voiceTraits.contains(.isPersonalVoice) {
          return false
        }
      }
      return true
    }
    let language = { (v: AVSpeechSynthesisVoice) in v.language.lowercased().replacingOccurrences(of: "_", with: "-") }
    var candidates = voices.filter { language($0) == wanted }
    if candidates.isEmpty && base != "zh" {
      candidates = voices.filter { language($0) == base || language($0).hasPrefix(base + "-") }
    }
    return candidates.max { $0.quality.rawValue < $1.quality.rawValue }
  }

  /** 1 is normal speed: AVSpeechUtterance speed is non-linear (default 0.5, range 0–1), scaled separately for values below and above normal. */
  static func utteranceRate(_ rate: Double) -> Float {
    let r = Float(min(2, max(0.5, rate)))
    let normal = AVSpeechUtteranceDefaultSpeechRate
    if r <= 1 { return normal - (normal - AVSpeechUtteranceMinimumSpeechRate) * (1 - r) }
    return normal + (AVSpeechUtteranceMaximumSpeechRate - normal) * (r - 1) / 2
  }

  private static func fileURL(_ uri: String) -> URL {
    if let url = URL(string: uri), url.isFileURL { return url }
    return URL(fileURLWithPath: uri)
  }

  private func synthesize(_ segments: [String], _ options: SynthesizeOptions) async throws -> [String: Any] {
    guard !segments.isEmpty else { throw failed("nothing to read") }
    guard let voice = Self.pickVoice(options.voice) else { throw noVoice(options.voice) }
    let output = Self.fileURL(options.output)
    let taskId = options.taskId
    let job = TTSJob()
    setJob(taskId, job)
    defer { setJob(taskId, nil) }
    let writer = WavWriter(url: output)
    do {
      try FileManager.default.createDirectory(
        at: output.deletingLastPathComponent(), withIntermediateDirectories: true)
      try? FileManager.default.removeItem(at: output)
      for (i, text) in segments.enumerated() {
        if job.isCancelled { throw CancellationError() }
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = voice
        utterance.rate = Self.utteranceRate(options.rate)
        try await job.write(utterance) { buffer in try writer.append(buffer) }
        sendEvent("onProgress", ["taskId": taskId, "fraction": Double(i + 1) / Double(segments.count)])
      }
      if job.isCancelled { throw CancellationError() }
      guard let result = writer.finish() else { throw failed("the voice wrote no audio") }
      let size = (try? FileManager.default.attributesOfItem(atPath: output.path)[.size] as? NSNumber)?.doubleValue ?? 0
      return [
        "uri": output.absoluteString,
        "size": size,
        "durationMs": result.durationMs,
        "sampleRate": result.sampleRate,
        "channels": result.channels,
      ]
    } catch {
      // Neither failure nor cancellation leaves partial files behind.
      _ = writer.finish()
      try? FileManager.default.removeItem(at: output)
      if job.isCancelled || error is CancellationError { throw cancelled() }
      if let exception = error as? Exception { throw exception }
      throw failed(error.localizedDescription)
    }
  }

  private func setJob(_ id: String, _ job: TTSJob?) {
    lock.lock()
    running[id] = job
    lock.unlock()
  }
}

/**
 * A single speech synthesis task: waits for the system to return the final (empty) buffer or
 * didFinish for each segment; cancellation, errors, and stalls all terminate the wait so the
 * synthesize Promise always settles.
 */
private final class TTSJob: NSObject, AVSpeechSynthesizerDelegate, @unchecked Sendable {
  private let synthesizer = AVSpeechSynthesizer()
  private let lock = NSLock()
  private var continuation: CheckedContinuation<Void, Error>?
  /** Currently awaited segment: a late didFinish from a previous segment must not terminate the current one. */
  private var current: AVSpeechUtterance?
  private var cancelled = false
  private var lastActivity = Date()

  override init() {
    super.init()
    synthesizer.delegate = self
  }

  var isCancelled: Bool {
    lock.lock()
    defer { lock.unlock() }
    return cancelled
  }

  func write(_ utterance: AVSpeechUtterance, append: @escaping (AVAudioPCMBuffer) throws -> Void) async throws {
    try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
      lock.lock()
      if cancelled {
        lock.unlock()
        cont.resume(throwing: CancellationError())
        return
      }
      continuation = cont
      current = utterance
      lastActivity = Date()
      lock.unlock()
      watch(utterance)
      synthesizer.write(utterance) { [weak self] buffer in
        guard let self else { return }
        guard let pcm = buffer as? AVAudioPCMBuffer else { return }
        // Final callback received an empty buffer: this segment is complete.
        if pcm.frameLength == 0 {
          self.finish(nil, of: utterance)
          return
        }
        self.touch()
        do {
          try append(pcm)
        } catch {
          self.synthesizer.stopSpeaking(at: .immediate)
          self.finish(error, of: utterance)
        }
      }
    }
  }

  func cancel() {
    lock.lock()
    cancelled = true
    lock.unlock()
    synthesizer.stopSpeaking(at: .immediate)
    finish(CancellationError())
  }

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
    finish(nil, of: utterance)
  }

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
    finish(CancellationError(), of: utterance)
  }

  private func touch() {
    lock.lock()
    lastActivity = Date()
    lock.unlock()
  }

  /** Finishes waiting for this segment (only finishes once, ignoring later calls); does nothing if not the currently awaited segment. */
  private func finish(_ error: Error?, of utterance: AVSpeechUtterance? = nil) {
    lock.lock()
    if let utterance, utterance !== current {
      lock.unlock()
      return
    }
    let cont = continuation
    continuation = nil
    current = nil
    lock.unlock()
    if let error { cont?.resume(throwing: error) } else { cont?.resume() }
  }

  /** Stall check: inspected every second; failing if no new audio is received for too long. */
  private func watch(_ utterance: AVSpeechUtterance) {
    DispatchQueue.global().asyncAfter(deadline: .now() + 1) { [weak self] in
      guard let self else { return }
      self.lock.lock()
      let waiting = self.continuation != nil && self.current === utterance
      let stalled = Date().timeIntervalSince(self.lastActivity) > stallSeconds
      self.lock.unlock()
      guard waiting else { return }
      if stalled {
        self.synthesizer.stopSpeaking(at: .immediate)
        self.finish(failed("the voice stopped responding"), of: utterance)
      } else {
        self.watch(utterance)
      }
    }
  }
}

/** Writes PCM data returned by the system into a 16-bit WAV; if the format changes (very rare), switches to the first segment's format before continuing. */
private final class WavWriter: @unchecked Sendable {
  private let url: URL
  private var file: AVAudioFile?
  private var converter: AVAudioConverter?
  private var frames: AVAudioFramePosition = 0

  init(url: URL) { self.url = url }

  func append(_ buffer: AVAudioPCMBuffer) throws {
    if file == nil {
      let format = buffer.format
      let settings: [String: Any] = [
        AVFormatIDKey: kAudioFormatLinearPCM,
        AVSampleRateKey: format.sampleRate,
        AVNumberOfChannelsKey: format.channelCount,
        AVLinearPCMBitDepthKey: 16,
        AVLinearPCMIsFloatKey: false,
        AVLinearPCMIsBigEndianKey: false,
      ]
      file = try AVAudioFile(
        forWriting: url, settings: settings, commonFormat: format.commonFormat, interleaved: format.isInterleaved)
    }
    guard let file else { return }
    let target = file.processingFormat
    if buffer.format == target {
      try file.write(from: buffer)
    } else {
      try file.write(from: try convert(buffer, to: target))
    }
    frames += AVAudioFramePosition(buffer.frameLength)
  }

  private func convert(_ buffer: AVAudioPCMBuffer, to format: AVAudioFormat) throws -> AVAudioPCMBuffer {
    if converter?.inputFormat != buffer.format { converter = AVAudioConverter(from: buffer.format, to: format) }
    guard let converter else { throw failed("cannot convert \(buffer.format) to \(format)") }
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * format.sampleRate / buffer.format.sampleRate) + 1024
    guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { throw failed("no buffer") }
    var given = false
    var error: NSError?
    converter.convert(to: out, error: &error) { _, status in
      if given {
        status.pointee = .noDataNow
        return nil
      }
      given = true
      status.pointee = .haveData
      return buffer
    }
    if let error { throw failed(error.localizedDescription) }
    return out
  }

  /** Closes the file; returns nil if no audio was written. */
  func finish() -> (durationMs: Double, sampleRate: Double, channels: Int)? {
    guard let file else { return nil }
    let format = file.fileFormat
    let result = (
      durationMs: Double(file.length) / format.sampleRate * 1000,
      sampleRate: format.sampleRate,
      channels: Int(format.channelCount)
    )
    // AVAudioFile writes the WAV header and closes the file upon deallocation.
    self.file = nil
    converter = nil
    return frames > 0 ? result : nil
  }
}
