import AVFoundation
import ExpoModulesCore
import ImageIO
import MorphLame
import MorphDsp
import UIKit
import UniformTypeIdentifiers

// iOS implementation for video and audio (D-141): Uses AVFoundation exclusively, processing
// everything locally without network requests.
// - probe: Uses AVURLAsset to read duration, dimensions, orientation, framerate, bitrate, codec,
// and HDR status.
// - transcode: Uses AVAssetReader (via AVVideoComposition: orientation correction, scaling,
// framerate limiting, HDR to BT.709) + AVAssetWriter (H.264 + AAC, MP4) with custom bitrate
// specification.
// - trim: Uses AVAssetExportSession Passthrough + timeRange without re-encoding.
// - thumbnails：AVAssetImageGenerator。
// - MP3 (D-183): AVFoundation cannot write MP3; decoded to PCM and passed to the app-embedded LAME
// (MorphLame pod).
// - GIF (D-184): Video uses AVAssetImageGenerator to extract frames at framerate, images are read
// via ImageIO (oriented, scaled), and ImageIO writes the GIF (per-frame custom palettes, looping
// playback). Video encoders cannot be used in the background: switching to another app during
// processing will fail, reporting ERR_MEDIA_INTERRUPTED (D-148). Exception: when morph-background
// acquires an iOS background task (D-163, disabled by default), switching to the background is not
// considered an interruption; when the system reclaims background time, tasks currently in progress
// end as interrupted.

final class MediaUnsupportedException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_MEDIA_UNSUPPORTED" }
  override var reason: String { "This media can't be opened: \(param)" }
}

final class MediaCancelledException: Exception, @unchecked Sendable {
  override var code: String { "ERR_MEDIA_CANCELLED" }
  override var reason: String { "Cancelled" }
}

final class MediaInterruptedException: Exception, @unchecked Sendable {
  override var code: String { "ERR_MEDIA_INTERRUPTED" }
  override var reason: String { "Tinkrum went to the background while processing" }
}

final class NotImplementedException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_NOT_IMPLEMENTED" }
  override var reason: String { "Not implemented yet: \(param)" }
}

final class MediaFailedException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_MEDIA_FAILED" }
  override var reason: String { "Processing failed: \(param)" }
}

/** An ongoing task: can be cancelled, remembers whether it was switched to the background. */
private final class Job: @unchecked Sendable {
  private let lock = NSLock()
  private var _cancelled = false
  private var _backgrounded = false
  private var _interrupted = false
  private var _onCancel: (() -> Void)?

  /** Actions to perform upon cancellation (stop reading/writing or exporting); if already cancelled when set, executes immediately. */
  var onCancel: (() -> Void)? {
    get { lock.withLock { _onCancel } }
    set {
      let run = lock.withLock { () -> Bool in
        _onCancel = newValue
        return _cancelled || _interrupted
      }
      if run { newValue?() }
    }
  }

  var cancelled: Bool { lock.withLock { _cancelled } }
  var backgrounded: Bool { lock.withLock { _backgrounded } }
  var interrupted: Bool { lock.withLock { _interrupted } }

  func cancel() {
    let handler: (() -> Void)? = lock.withLock {
      _cancelled = true
      return _onCancel
    }
    handler?()
  }

  func markBackgrounded() { lock.withLock { _backgrounded = true } }

  /** System reclaimed background time: stop and report an error as "switched to background". */
  func interrupt() {
    let handler: (() -> Void)? = lock.withLock {
      _backgrounded = true
      _interrupted = true
      return _onCancel
    }
    handler?()
  }
}

/** Notification name agreed upon with morph-background (the two modules cannot see each other's code). */
private let continuedChangedNotification = Notification.Name("MorphContinuedProcessingChanged")
private let continuedExpiredNotification = Notification.Name("MorphContinuedProcessingExpired")

public class MorphMediaModule: Module {
  private let jobsLock = NSLock()
  private var jobs: [String: Job] = [:]
  /** morph-background acquired a background task (D-163): switching to background during this period is not considered an interruption. */
  private var continued = false
  private var continuedObservers: [NSObjectProtocol] = []

  public func definition() -> ModuleDefinition {
    Name("MorphMedia")

    Events("progress")

    OnCreate {
      let center = NotificationCenter.default
      self.continuedObservers = [
        center.addObserver(forName: continuedChangedNotification, object: nil, queue: nil) {
          [weak self] note in
          guard let self else { return }
          let active = note.userInfo?["active"] as? Bool ?? false
          self.jobsLock.withLock { self.continued = active }
        },
        center.addObserver(forName: continuedExpiredNotification, object: nil, queue: nil) {
          [weak self] _ in
          guard let self else { return }
          self.jobsLock.withLock { Array(self.jobs.values) }.forEach { $0.interrupt() }
        },
      ]
    }

    OnDestroy {
      self.continuedObservers.forEach { NotificationCenter.default.removeObserver($0) }
      self.continuedObservers = []
    }

    AsyncFunction("probe") { (uri: URL, promise: Promise) in
      Task {
        do {
          promise.resolve(try await Self.probe(uri))
        } catch {
          promise.reject(Self.coded(error))
        }
      }
    }

    AsyncFunction("transcode") {
      (jobId: String, uri: URL, output: URL, options: [String: Any], promise: Promise) in
      let job = self.start(jobId)
      Task {
        defer { self.finish(jobId) }
        do {
          let video = options["video"] as? [String: Any]
          let result: [String: Any]
          if let factor = (video?["speed"] as? NSNumber)?.doubleValue {
            result = try await self.speedVideo(job, jobId: jobId, uri: uri, output: output, options: options, factor: factor)
          } else {
            result = try await self.transcode(job, jobId: jobId, uri: uri, output: output, options: options)
          }
          promise.resolve(result)
        } catch {
          promise.reject(Self.coded(error, job: job))
        }
      }
    }

    AsyncFunction("volume") {
      (jobId: String, uri: URL, output: URL, options: [String: Any], promise: Promise) in
      let job = self.start(jobId)
      Task {
        defer { self.finish(jobId) }
        do { promise.resolve(try await self.adjustVolume(job, jobId: jobId, uri: uri, output: output, options: options)) }
        catch { promise.reject(Self.coded(error, job: job)) }
      }
    }

    AsyncFunction("speechAudio") { (jobId: String, uri: URL, output: URL, promise: Promise) in
      let job = self.start(jobId)
      Task {
        defer { self.finish(jobId) }
        do { promise.resolve(try await self.speechAudio(job, jobId: jobId, uri: uri, output: output)) }
        catch { try? FileManager.default.removeItem(at: output); promise.reject(Self.coded(error, job: job)) }
      }
    }

    AsyncFunction("denoise") {
      (jobId: String, uri: URL, output: URL, options: [String: Any], promise: Promise) in
      let job = self.start(jobId)
      Task {
        defer { self.finish(jobId) }
        do { promise.resolve(try await self.denoiseAudio(job, jobId: jobId, uri: uri, output: output, options: options)) }
        catch { promise.reject(Self.coded(error, job: job)) }
      }
    }

    AsyncFunction("rotate") {
      (jobId: String, uri: URL, output: URL, degrees: Int, _options: [String: Any], promise: Promise) in
      let job = self.start(jobId)
      Task {
        defer { self.finish(jobId) }
        do { promise.resolve(try await self.rotateVideo(job, jobId: jobId, uri: uri, output: output, degrees: degrees)) }
        catch { promise.reject(Self.coded(error, job: job)) }
      }
    }

    AsyncFunction("mute") {
      (jobId: String, uri: URL, output: URL, promise: Promise) in
      let job = self.start(jobId)
      Task {
        defer { self.finish(jobId) }
        do { promise.resolve(try await self.muteVideo(job, jobId: jobId, uri: uri, output: output)) }
        catch { promise.reject(Self.coded(error, job: job)) }
      }
    }

    AsyncFunction("mixAudio") {
      (jobId: String, uri: URL, music: URL, output: URL, options: [String: Any], promise: Promise) in
      let job = self.start(jobId)
      Task {
        defer { self.finish(jobId) }
        do { promise.resolve(try await self.mixVideoAudio(job, jobId: jobId, uri: uri, music: music, output: output, options: options)) }
        catch { promise.reject(Self.coded(error, job: job)) }
      }
    }

    AsyncFunction("trim") {
      (jobId: String, uri: URL, output: URL, range: [String: Double], promise: Promise) in
      let job = self.start(jobId)
      Task {
        defer { self.finish(jobId) }
        do {
          let result = try await self.trim(job, jobId: jobId, uri: uri, output: output, range: range)
          promise.resolve(result)
        } catch {
          promise.reject(Self.coded(error, job: job))
        }
      }
    }

    AsyncFunction("frame") { (uri: URL, timeMs: Double, directory: URL, promise: Promise) in
      Task {
        do {
          guard timeMs.isFinite, timeMs >= 0 else { throw MediaUnsupportedException("invalid frame time") }
          let frames = try await Self.thumbnails(uri, timesMs: [timeMs], maxSide: 0, directory: directory, precise: true)
          promise.resolve(frames[0])
        } catch { promise.reject(Self.coded(error)) }
      }
    }

    AsyncFunction("thumbnails") {
      (uri: URL, timesMs: [Double], maxSide: Double, directory: URL, promise: Promise) in
      Task {
        do {
          promise.resolve(try await Self.thumbnails(uri, timesMs: timesMs, maxSide: maxSide, directory: directory))
        } catch {
          promise.reject(Self.coded(error))
        }
      }
    }

    // Audio (D-153, D-155, audio sessions): concatenating segments, waveforms.
    AsyncFunction("concat") {
      (jobId: String, uris: [URL], output: URL, options: [String: Any], promise: Promise) in
      let job = self.start(jobId)
      Task {
        defer { self.finish(jobId) }
        do {
          let result = try await self.concat(job, jobId: jobId, uris: uris, output: output, options: options)
          promise.resolve(result)
        } catch {
          promise.reject(Self.coded(error, job: job))
        }
      }
    }

    AsyncFunction("waveform") { (uri: URL, buckets: Int, range: [String: Double]?, promise: Promise) in
      Task {
        do {
          promise.resolve(try await Self.waveform(uri, buckets: buckets, range: range))
        } catch {
          promise.reject(Self.coded(error))
        }
      }
    }

    // Animations (D-184)
    AsyncFunction("videoGif") {
      (jobId: String, uri: URL, output: URL, options: [String: Double], promise: Promise) in
      let job = self.start(jobId)
      Task {
        defer { self.finish(jobId) }
        do {
          promise.resolve(try await self.videoGif(job, jobId: jobId, uri: uri, output: output, options: options))
        } catch {
          promise.reject(Self.coded(error, job: job))
        }
      }
    }

    AsyncFunction("imagesGif") {
      (jobId: String, uris: [URL], output: URL, options: [String: Double], promise: Promise) in
      let job = self.start(jobId)
      Task {
        defer { self.finish(jobId) }
        do {
          promise.resolve(try self.imagesGif(job, jobId: jobId, uris: uris, output: output, options: options))
        } catch {
          promise.reject(Self.coded(error, job: job))
        }
      }
    }

    Function("cancel") { (jobId: String) in
      let job = self.jobsLock.withLock { self.jobs[jobId] }
      job?.cancel()
    }
  }

  // MARK: - Tasks

  private func start(_ jobId: String) -> Job {
    let job = Job()
    // Record when switching to background: subsequent encoding failures are caused by this (iOS disallows video encoders in the background). Not counted if a background task is active.
    let token = NotificationCenter.default.addObserver(
      forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: nil
    ) { [weak self] _ in
      let continued = self.map { module in module.jobsLock.withLock { module.continued } } ?? false
      if !continued { job.markBackgrounded() }
    }
    jobsLock.withLock {
      jobs[jobId] = job
      observers[jobId] = token
    }
    return job
  }

  private var observers: [String: NSObjectProtocol] = [:]

  private func finish(_ jobId: String) {
    jobsLock.withLock {
      jobs[jobId] = nil
      if let token = observers.removeValue(forKey: jobId) {
        NotificationCenter.default.removeObserver(token)
      }
    }
  }

  private func progress(_ jobId: String, _ value: Double) {
    sendEvent("progress", ["jobId": jobId, "progress": min(1, max(0, value))])
  }

  private static func coded(_ error: Error, job: Job? = nil) -> Exception {
    if let job, job.cancelled { return MediaCancelledException() }
    if let exception = error as? Exception { return exception }
    if let job, job.backgrounded { return MediaInterruptedException() }
    return MediaFailedException(error.localizedDescription)
  }

  // MARK: - probe

  static func probe(_ url: URL) async throws -> [String: Any] {
    let asset = AVURLAsset(url: url)
    let duration: CMTime
    let tracks: [AVAssetTrack]
    do {
      (duration, tracks) = try await asset.load(.duration, .tracks)
    } catch {
      throw MediaUnsupportedException(error.localizedDescription)
    }
    if (try? await asset.load(.hasProtectedContent)) == true {
      throw MediaUnsupportedException("protected")
    }
    let video = tracks.first { $0.mediaType == .video }
    let audio = tracks.first { $0.mediaType == .audio }
    if video == nil && audio == nil { throw MediaUnsupportedException("no tracks") }
    var info: [String: Any] = [
      "kind": video != nil ? "video" : "audio",
      "durationMs": duration.isNumeric ? duration.seconds * 1000 : 0,
      "size": fileSize(url),
      "hasVideo": video != nil,
      "hasAudio": audio != nil,
    ]
    if let video {
      let (size, transform, fps, rate, formats) = try await video.load(
        .naturalSize, .preferredTransform, .nominalFrameRate, .estimatedDataRate, .formatDescriptions)
      let shown = size.applying(transform)
      info["width"] = Int(abs(shown.width).rounded())
      info["height"] = Int(abs(shown.height).rounded())
      info["rotation"] = rotation(of: transform)
      info["fps"] = Double(fps)
      info["videoBitrateKbps"] = Double(rate) / 1000
      if let format = formats.first {
        info["videoCodec"] = fourCC(CMFormatDescriptionGetMediaSubType(format))
      }
      info["hdr"] = (try? await video.load(.mediaCharacteristics))?.contains(.containsHDRVideo) ?? false
    }
    if let audio {
      let (rate, formats) = try await audio.load(.estimatedDataRate, .formatDescriptions)
      info["audioBitrateKbps"] = Double(rate) / 1000
      if let format = formats.first {
        info["audioCodec"] = fourCC(CMFormatDescriptionGetMediaSubType(format))
        if let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee {
          info["sampleRate"] = asbd.mSampleRate
          info["channels"] = Int(asbd.mChannelsPerFrame)
        }
      }
    }
    return info
  }

  private static func fileSize(_ url: URL) -> Int {
    (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
  }

  private static func rotation(of t: CGAffineTransform) -> Int {
    let degrees = Int((atan2(t.b, t.a) * 180 / .pi).rounded())
    return ((degrees % 360) + 360) % 360
  }

  private static func fourCC(_ code: FourCharCode) -> String {
    let bytes = [24, 16, 8, 0].map { UInt8((code >> $0) & 0xff) }
    let text = String(bytes: bytes, encoding: .ascii) ?? ""
    return text.trimmingCharacters(in: .whitespaces)
  }

  // MARK: - transcode

  private func transcode(
    _ job: Job, jobId: String, uri: URL, output: URL, options: [String: Any],
    sourceAsset: AVAsset? = nil, suppliedComposition: AVVideoComposition? = nil, suppliedAudioMix: AVAudioMix? = nil, suppliedTimePitch: AVAudioTimePitchAlgorithm? = nil
  ) async throws -> [String: Any] {
    let container = options["container"] as? String ?? "mp4"
    if options["video"] as? String == "drop" {
      let asset = AVURLAsset(url: uri)
      let (duration, tracks) = try await asset.load(.duration, .tracks)
      guard let main = await Self.mainAudioTrack(tracks) else { throw MediaUnsupportedException("no audio") }
      let audioTracks = [main]
      var timeRange = CMTimeRange(start: .zero, duration: duration)
      if let range = options["range"] as? [String: Double], let start = range["startMs"], let end = range["endMs"] {
        timeRange = CMTimeRange(
          start: CMTime(seconds: start / 1000, preferredTimescale: 600),
          end: CMTime(seconds: min(end / 1000, duration.seconds), preferredTimescale: 600))
      }
      return try await writeAudio(
        job, jobId: jobId, asset: asset, tracks: audioTracks, timeRange: timeRange, output: output,
        container: container, audio: options["audio"] as? [String: Any] ?? [:])
    }
    guard container == "mp4", let video = options["video"] as? [String: Any] else {
      throw NotImplementedException("transcode to \(container)")
    }
    let audioOptions = options["audio"] as? [String: Any]
    if audioOptions == nil, options["audio"] as? String != "drop" {
      throw NotImplementedException("audio settings")
    }
    if let codec = audioOptions?["codec"] as? String, codec != "aac" {
      throw NotImplementedException("audio codec \(codec)")
    }

    let asset: AVAsset = sourceAsset ?? AVURLAsset(url: uri)
    let (duration, tracks) = try await asset.load(.duration, .tracks)
    guard let videoTrack = tracks.first(where: { $0.mediaType == .video }) else {
      throw MediaUnsupportedException("no video")
    }
    let audioTracks = audioOptions == nil ? [] : await Self.mainAudioTrack(tracks).map { [$0] } ?? []

    var timeRange = CMTimeRange(start: .zero, duration: duration)
    if let range = options["range"] as? [String: Double], let start = range["startMs"], let end = range["endMs"] {
      timeRange = CMTimeRange(
        start: CMTime(seconds: start / 1000, preferredTimescale: 600),
        end: CMTime(seconds: end / 1000, preferredTimescale: 600))
    }

    // Output dimensions: after orientation correction, scale down by the short side without enlarging; H.264 requires even width and height.
    let (natural, transform, nominalFps) = try await videoTrack.load(.naturalSize, .preferredTransform, .nominalFrameRate)
    let shown = natural.applying(transform)
    let frameW = suppliedComposition?.renderSize.width ?? abs(shown.width)
    let frameH = suppliedComposition?.renderSize.height ?? abs(shown.height)
    let ratio = (video["aspectRatio"] as? NSNumber)?.doubleValue
    if let ratio, !ratio.isFinite || ratio <= 0 { throw MediaUnsupportedException("invalid aspect ratio") }
    let shownW = ratio.map { min(frameW, frameH * CGFloat($0)) } ?? frameW
    let shownH = ratio.map { min(frameH, frameW / CGFloat($0)) } ?? frameH
    let shortSide = min(shownW, shownH)
    let maxShort = (video["maxShortSide"] as? Double).map { CGFloat($0) } ?? shortSide
    let scale = min(1, maxShort / max(shortSide, 1))
    let outW = max(2, Int((shownW * scale / 2).rounded()) * 2)
    let outH = max(2, Int((shownH * scale / 2).rounded()) * 2)
    let maxFps = video["maxFps"] as? Double ?? 30
    let fps = min(Double(nominalFps > 0 ? nominalFps : 30), maxFps)

    let composition = AVMutableVideoComposition()
    composition.renderSize = CGSize(width: outW, height: outH)
    composition.frameDuration = CMTime(seconds: 1 / fps, preferredTimescale: 6000)
    // Standard video (BT.709): HDR video is converted here, otherwise it will appear grey or underexposed when sent elsewhere.
    composition.colorPrimaries = AVVideoColorPrimaries_ITU_R_709_2
    composition.colorTransferFunction = AVVideoTransferFunction_ITU_R_709_2
    composition.colorYCbCrMatrix = AVVideoYCbCrMatrix_ITU_R_709_2
    let instruction = AVMutableVideoCompositionInstruction()
    instruction.timeRange = CMTimeRange(start: .zero, duration: duration)
    let layer = AVMutableVideoCompositionLayerInstruction(assetTrack: videoTrack)
    // Orientation correction: preferredTransform does not necessarily include translation (videos
    // not shot on iPhone often only have rotation), move the frame back to the origin based on the
    // post-rotation bounding box, then scale to output dimensions.
    let bounds = CGRect(origin: .zero, size: natural).applying(transform)
    let upright = transform.concatenating(
      CGAffineTransform(translationX: -bounds.minX - (frameW - shownW) / 2, y: -bounds.minY - (frameH - shownH) / 2))
    let sx = CGFloat(outW) / shownW
    let sy = CGFloat(outH) / shownH
    layer.setTransform(upright.concatenating(CGAffineTransform(scaleX: sx, y: sy)), at: .zero)
    instruction.layerInstructions = [layer]
    composition.instructions = [instruction]

    let reader: AVAssetReader
    let writer: AVAssetWriter
    do {
      reader = try AVAssetReader(asset: asset)
      try? FileManager.default.removeItem(at: output)
      try FileManager.default.createDirectory(
        at: output.deletingLastPathComponent(), withIntermediateDirectories: true)
      writer = try AVAssetWriter(outputURL: output, fileType: .mp4)
    } catch {
      throw MediaFailedException(error.localizedDescription)
    }
    reader.timeRange = timeRange
    writer.shouldOptimizeForNetworkUse = true

    let videoOut = AVAssetReaderVideoCompositionOutput(
      videoTracks: tracks.filter { $0.mediaType == .video },
      videoSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange])
    videoOut.videoComposition = suppliedComposition ?? composition
    videoOut.alwaysCopiesSampleData = false
    guard reader.canAdd(videoOut) else { throw MediaUnsupportedException("video output") }
    reader.add(videoOut)

    let bitrate = (video["bitrateKbps"] as? Double ?? 2500) * 1000
    let videoIn = AVAssetWriterInput(
      mediaType: .video,
      outputSettings: [
        AVVideoCodecKey: AVVideoCodecType.h264,
        AVVideoWidthKey: outW,
        AVVideoHeightKey: outH,
        AVVideoColorPropertiesKey: [
          AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
          AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
          AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
        ],
        AVVideoCompressionPropertiesKey: [
          AVVideoAverageBitRateKey: Int(bitrate),
          AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
          AVVideoExpectedSourceFrameRateKey: Int(fps.rounded()),
          AVVideoMaxKeyFrameIntervalDurationKey: 2,
        ],
      ])
    videoIn.expectsMediaDataInRealTime = false
    guard writer.canAdd(videoIn) else { throw MediaFailedException("video input") }
    writer.add(videoIn)

    var audioOut: AVAssetReaderAudioMixOutput?
    var audioIn: AVAssetWriterInput?
    if !audioTracks.isEmpty, let audioOptions {
      let kbps = audioOptions["bitrateKbps"] as? Double ?? 128
      // For low-bitrate AAC, use mono and low sample rate, otherwise the encoder rejects it.
      let channels = (audioOptions["channels"] as? NSNumber)?.intValue ?? (kbps < 64 ? 1 : 2)
      let sampleRate = (audioOptions["sampleRate"] as? Double) ?? (kbps < 64 ? 22050 : 44100)
      let out = AVAssetReaderAudioMixOutput(
        audioTracks: audioTracks,
        audioSettings: [
          AVFormatIDKey: kAudioFormatLinearPCM,
          AVSampleRateKey: sampleRate,
          AVNumberOfChannelsKey: channels,
          AVLinearPCMBitDepthKey: 16,
          AVLinearPCMIsFloatKey: false,
          AVLinearPCMIsBigEndianKey: false,
          AVLinearPCMIsNonInterleaved: false,
        ])
      out.audioMix = suppliedAudioMix
      if let suppliedTimePitch { out.audioTimePitchAlgorithm = suppliedTimePitch }
      let input = AVAssetWriterInput(
        mediaType: .audio,
        outputSettings: [
          AVFormatIDKey: kAudioFormatMPEG4AAC,
          AVSampleRateKey: sampleRate,
          AVNumberOfChannelsKey: channels,
          AVEncoderBitRateKey: Int(kbps * 1000),
        ])
      input.expectsMediaDataInRealTime = false
      if reader.canAdd(out), writer.canAdd(input) {
        reader.add(out)
        writer.add(input)
        audioOut = out
        audioIn = input
      }
    }

    job.onCancel = {
      reader.cancelReading()
      writer.cancelWriting()
    }
    if job.cancelled { throw MediaCancelledException() }
    guard reader.startReading() else {
      throw MediaUnsupportedException(reader.error?.localizedDescription ?? "reader")
    }
    guard writer.startWriting() else {
      throw MediaFailedException(writer.error?.localizedDescription ?? "writer")
    }
    writer.startSession(atSourceTime: timeRange.start)

    let total = max(timeRange.duration.seconds, 0.001)
    let start = timeRange.start.seconds
    var lastReported = -1.0
    let report: (CMTime) -> Void = { time in
      let value = (time.seconds - start) / total
      if value - lastReported >= 0.01 {
        lastReported = value
        self.progress(jobId, value)
      }
    }

    // Two parallel pipelines (video and audio) process on their respective queues, wrapping up only after both finish.
    await withTaskGroup(of: Void.self) { group in
      group.addTask {
        await Self.pump(videoOut, into: videoIn, queue: DispatchQueue(label: "morph.media.video"), onSample: report)
      }
      if let audioOut, let audioIn {
        group.addTask {
          await Self.pump(audioOut, into: audioIn, queue: DispatchQueue(label: "morph.media.audio"), onSample: nil)
        }
      }
    }

    if job.cancelled {
      writer.cancelWriting()
      throw MediaCancelledException()
    }
    if reader.status == .failed {
      writer.cancelWriting()
      if job.backgrounded { throw MediaInterruptedException() }
      throw MediaFailedException(reader.error?.localizedDescription ?? "read")
    }
    await writer.finishWriting()
    if writer.status != .completed {
      if job.backgrounded { throw MediaInterruptedException() }
      throw MediaFailedException(writer.error?.localizedDescription ?? "write")
    }
    progress(jobId, 1)
    return try await Self.result(output)
  }

  /** Pump samples from reader to writer for one stream until reading completes or writing fails. */
  private static func pump(
    _ output: AVAssetReaderOutput, into input: AVAssetWriterInput, queue: DispatchQueue,
    onSample: ((CMTime) -> Void)? = nil
  ) async {
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      var done = false
      input.requestMediaDataWhenReady(on: queue) {
        while input.isReadyForMoreMediaData && !done {
          guard let sample = output.copyNextSampleBuffer() else {
            done = true
            input.markAsFinished()
            continuation.resume()
            return
          }
          onSample?(CMSampleBufferGetPresentationTimeStamp(sample))
          if !input.append(sample) {
            done = true
            input.markAsFinished()
            continuation.resume()
            return
          }
        }
      }
    }
  }

  private static func result(_ url: URL) async throws -> [String: Any] {
    let info = try await probe(url)
    return ["uri": url.absoluteString, "size": fileSize(url), "info": info]
  }

  // MARK: - Audio (D-153, D-155)

  /**
   * Encode multiple audio streams (mixed together, or concatenated head-to-tail during synthesis)
   * into M4A (AAC) or WAV (16-bit PCM). Low-bitrate AAC uses mono and low sample rate, otherwise
   * the encoder rejects it (same as video audio).
   */
  private func writeAudio(
    _ job: Job, jobId: String, asset: AVAsset, tracks: [AVAssetTrack], timeRange: CMTimeRange,
    output: URL, container: String, audio: [String: Any]
  ) async throws -> [String: Any] {
    if container == "mp3" {
      return try await writeMp3(
        job, jobId: jobId, asset: asset, tracks: tracks, timeRange: timeRange, output: output, audio: audio)
    }
    let codec = audio["codec"] as? String ?? (container == "wav" ? "pcm" : "aac")
    guard (container == "m4a" && codec == "aac") || (container == "wav" && codec == "pcm") else {
      throw NotImplementedException("\(container) with \(codec)")
    }
    let kbps = audio["bitrateKbps"] as? Double ?? 128
    // JS numbers are Double here, `as? Int` fails: read using NSNumber.
    let channels = (audio["channels"] as? NSNumber)?.intValue ?? (codec == "aac" && kbps < 64 ? 1 : 2)
    let sampleRate = audio["sampleRate"] as? Double ?? (codec == "aac" && kbps < 48 ? 22050 : 44100)
    let pcm: [String: Any] = [
      AVFormatIDKey: kAudioFormatLinearPCM,
      AVSampleRateKey: sampleRate,
      AVNumberOfChannelsKey: channels,
      AVLinearPCMBitDepthKey: 16,
      AVLinearPCMIsFloatKey: false,
      AVLinearPCMIsBigEndianKey: false,
      AVLinearPCMIsNonInterleaved: false,
    ]
    let settings: [String: Any] =
      codec == "pcm"
      ? pcm
      : [
        AVFormatIDKey: kAudioFormatMPEG4AAC,
        AVSampleRateKey: sampleRate,
        AVNumberOfChannelsKey: channels,
        AVEncoderBitRateKey: Int(kbps * 1000),
      ]

    let reader: AVAssetReader
    let writer: AVAssetWriter
    do {
      reader = try AVAssetReader(asset: asset)
      try? FileManager.default.removeItem(at: output)
      try FileManager.default.createDirectory(
        at: output.deletingLastPathComponent(), withIntermediateDirectories: true)
      writer = try AVAssetWriter(outputURL: output, fileType: container == "wav" ? .wav : .m4a)
    } catch {
      throw MediaFailedException(error.localizedDescription)
    }
    reader.timeRange = timeRange
    let out = AVAssetReaderAudioMixOutput(audioTracks: tracks, audioSettings: pcm)
    out.alwaysCopiesSampleData = false
    guard reader.canAdd(out) else { throw MediaUnsupportedException("audio output") }
    reader.add(out)
    let input = AVAssetWriterInput(mediaType: .audio, outputSettings: settings)
    input.expectsMediaDataInRealTime = false
    guard writer.canAdd(input) else { throw MediaFailedException("audio input \(kbps) kbps \(channels) ch") }
    writer.add(input)

    job.onCancel = {
      reader.cancelReading()
      writer.cancelWriting()
    }
    if job.cancelled { throw MediaCancelledException() }
    guard reader.startReading() else {
      throw MediaUnsupportedException(reader.error?.localizedDescription ?? "reader")
    }
    guard writer.startWriting() else {
      throw MediaFailedException(writer.error?.localizedDescription ?? "writer")
    }
    writer.startSession(atSourceTime: timeRange.start)

    let total = max(timeRange.duration.seconds, 0.001)
    let start = timeRange.start.seconds
    var lastReported = -1.0
    await Self.pump(out, into: input, queue: DispatchQueue(label: "morph.media.audio")) { time in
      let value = (time.seconds - start) / total
      if value - lastReported >= 0.01 {
        lastReported = value
        self.progress(jobId, value)
      }
    }

    if job.cancelled {
      writer.cancelWriting()
      throw MediaCancelledException()
    }
    if reader.status == .failed {
      writer.cancelWriting()
      if job.backgrounded { throw MediaInterruptedException() }
      throw MediaFailedException(reader.error?.localizedDescription ?? "read")
    }
    await writer.finishWriting()
    if writer.status != .completed {
      if job.backgrounded { throw MediaInterruptedException() }
      throw MediaFailedException(writer.error?.localizedDescription ?? "write")
    }
    progress(jobId, 1)
    return try await Self.result(output)
  }

  /**
   * MP3 (D-183): AVAssetReader decodes audio to 44.1 kHz 16-bit PCM (system resampled when
   * needed), LAME encoded, written on-the-fly. LAME quality is set to 2 (high quality, slightly
   * slower than default 5).
   */
  private func writeMp3(
    _ job: Job, jobId: String, asset: AVAsset, tracks: [AVAssetTrack], timeRange: CMTimeRange,
    output: URL, audio: [String: Any]
  ) async throws -> [String: Any] {
    let kbps = Int32(audio["bitrateKbps"] as? Double ?? 192)
    let channels = (audio["channels"] as? NSNumber)?.intValue ?? 2
    let sampleRate = 44100.0
    let reader: AVAssetReader
    do {
      reader = try AVAssetReader(asset: asset)
    } catch {
      throw MediaUnsupportedException(error.localizedDescription)
    }
    reader.timeRange = timeRange
    let out = AVAssetReaderAudioMixOutput(
      audioTracks: tracks,
      audioSettings: [
        AVFormatIDKey: kAudioFormatLinearPCM,
        AVSampleRateKey: sampleRate,
        AVNumberOfChannelsKey: channels,
        AVLinearPCMBitDepthKey: 16,
        AVLinearPCMIsFloatKey: false,
        AVLinearPCMIsBigEndianKey: false,
        AVLinearPCMIsNonInterleaved: false,
      ])
    out.alwaysCopiesSampleData = false
    guard reader.canAdd(out) else { throw MediaUnsupportedException("audio output") }
    reader.add(out)

    guard let lame = lame_init() else { throw MediaFailedException("mp3 encoder") }
    defer { lame_close(lame) }
    lame_set_in_samplerate(lame, Int32(sampleRate))
    lame_set_num_channels(lame, Int32(channels))
    lame_set_mode(lame, channels == 1 ? MONO : JOINT_STEREO)
    lame_set_brate(lame, kbps)
    lame_set_quality(lame, 2)
    guard lame_init_params(lame) >= 0 else {
      throw MediaFailedException("mp3 encoder \(kbps) kbps \(channels) ch")
    }

    try? FileManager.default.removeItem(at: output)
    try FileManager.default.createDirectory(
      at: output.deletingLastPathComponent(), withIntermediateDirectories: true)
    guard FileManager.default.createFile(atPath: output.path, contents: nil),
      let file = try? FileHandle(forWritingTo: output)
    else { throw MediaFailedException("create \(output.lastPathComponent)") }
    defer { try? file.close() }

    job.onCancel = { reader.cancelReading() }
    if job.cancelled { throw MediaCancelledException() }
    guard reader.startReading() else {
      throw MediaUnsupportedException(reader.error?.localizedDescription ?? "reader")
    }

    let total = max(timeRange.duration.seconds, 0.001)
    let start = timeRange.start.seconds
    var lastReported = -1.0
    var mp3 = [UInt8]()
    while let sample = out.copyNextSampleBuffer() {
      if job.cancelled { break }
      guard let block = CMSampleBufferGetDataBuffer(sample) else { continue }
      let length = CMBlockBufferGetDataLength(block)
      var pcm = [Int16](repeating: 0, count: length / 2)
      pcm.withUnsafeMutableBytes { raw in
        _ = CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: raw.baseAddress!)
      }
      let frames = Int32(pcm.count / channels)
      // Worst-case requirement by LAME: 1.25 * sample count + 7200 bytes.
      let capacity = Int(frames) * 5 / 4 + 7200
      if mp3.count < capacity { mp3 = [UInt8](repeating: 0, count: capacity) }
      let written = pcm.withUnsafeMutableBufferPointer { samples in
        mp3.withUnsafeMutableBufferPointer { bytes in
          channels == 1
            ? lame_encode_buffer(lame, samples.baseAddress, samples.baseAddress, frames, bytes.baseAddress, Int32(capacity))
            : lame_encode_buffer_interleaved(lame, samples.baseAddress, frames, bytes.baseAddress, Int32(capacity))
        }
      }
      if written < 0 { throw MediaFailedException("mp3 encode \(written)") }
      file.write(Data(mp3[0..<Int(written)]))
      let value = (CMSampleBufferGetPresentationTimeStamp(sample).seconds - start) / total
      if value - lastReported >= 0.01 {
        lastReported = value
        progress(jobId, value)
      }
    }
    if job.cancelled {
      try? FileManager.default.removeItem(at: output)
      throw MediaCancelledException()
    }
    if reader.status == .failed {
      try? FileManager.default.removeItem(at: output)
      if job.backgrounded { throw MediaInterruptedException() }
      throw MediaFailedException(reader.error?.localizedDescription ?? "read")
    }
    if mp3.count < 7200 { mp3 = [UInt8](repeating: 0, count: 7200) }
    let tail = mp3.withUnsafeMutableBufferPointer { bytes in
      lame_encode_flush(lame, bytes.baseAddress, Int32(bytes.count))
    }
    if tail > 0 { file.write(Data(mp3[0..<Int(tail)])) }
    try? file.close()
    progress(jobId, 1)
    return try await Self.result(output)
  }

  /**
   * The audio track to process in a file. Multi-language and spatial audio (stereo + APAC) videos
   * have multiple tracks, and mixing them all together results in overlapping, hollow sound: take
   * the first enabled track, or the first track if none are enabled.
   */
  static func mainAudioTrack(_ tracks: [AVAssetTrack]) async -> AVAssetTrack? {
    let audio = tracks.filter { $0.mediaType == .audio }
    for track in audio where (try? await track.load(.isEnabled)) == true { return track }
    return audio.first
  }

  /** 1 when the main audio track is mono, 2 otherwise (multi-channel mixed to stereo). Mono duplicated to dual-channel sounds 3 dB louder when measured. */
  private static func pcmChannels(_ uri: URL) async -> Int {
    guard let tracks = try? await AVURLAsset(url: uri).load(.tracks),
          let audio = await mainAudioTrack(tracks),
          let format = (try? await audio.load(.formatDescriptions))?.first,
          let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee else { return 2 }
    return asbd.mChannelsPerFrame == 1 ? 1 : 2
  }

  /** Decoded into 48 kHz, n-channel interleaved Float PCM; insert silence by timestamp so the video sound is not advanced. */
  private func readPcm(_ job: Job, uri: URL, channels: Int = 2, consume: (UnsafePointer<Float>, Int) throws -> Void) async throws {
    if job.cancelled { throw MediaCancelledException() }
    if job.interrupted { throw MediaInterruptedException() }
    let asset = AVURLAsset(url: uri)
    let (duration, tracks) = try await asset.load(.duration, .tracks)
    guard let main = await Self.mainAudioTrack(tracks), duration.seconds > 0, duration.seconds.isFinite, duration.seconds < Double(Int.max) / 48000 else { throw MediaUnsupportedException("no audio") }
    let totalFrames = Int((duration.seconds * 48000).rounded())
    let reader = try AVAssetReader(asset: asset)
    let out = AVAssetReaderAudioMixOutput(audioTracks: [main], audioSettings: [
      AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 48000.0, AVNumberOfChannelsKey: channels,
      AVLinearPCMBitDepthKey: 32, AVLinearPCMIsFloatKey: true, AVLinearPCMIsNonInterleaved: false,
    ])
    guard reader.canAdd(out) else { throw MediaUnsupportedException("PCM reader") }
    reader.add(out)
    job.onCancel = { reader.cancelReading() }
    guard reader.startReading() else {
      if job.cancelled { throw MediaCancelledException() }
      if job.interrupted { throw MediaInterruptedException() }
      throw MediaUnsupportedException(reader.error?.localizedDescription ?? "PCM read")
    }
    defer { if reader.status == .reading { reader.cancelReading() } }
    var cursor = 0
    let silence = [Float](repeating: 0, count: 16384)
    func pad(to frame: Int) throws {
      while cursor < frame {
        if job.cancelled { throw MediaCancelledException() }
        if job.interrupted { throw MediaInterruptedException() }
        let count = min(frame - cursor, silence.count / channels)
        try silence.withUnsafeBufferPointer { try consume($0.baseAddress!, count) }
        cursor += count
      }
    }
    while let sample = out.copyNextSampleBuffer() {
      if job.cancelled { throw MediaCancelledException() }
      if job.interrupted { throw MediaInterruptedException() }
      guard let block = CMSampleBufferGetDataBuffer(sample) else { continue }
      let seconds = CMSampleBufferGetPresentationTimeStamp(sample).seconds
      guard seconds.isFinite else { throw MediaUnsupportedException("audio timestamp") }
      let start = Int((seconds * 48000).rounded())
      try pad(to: min(totalFrames, max(0, start)))
      var contiguous = 0
      var length = 0
      var data: UnsafeMutablePointer<Int8>?
      guard CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: &contiguous, totalLengthOut: &length, dataPointerOut: &data) == kCMBlockBufferNoErr, let data else { throw MediaFailedException("PCM buffer") }
      let skip = max(0, cursor - start)
      let frames = max(0, min(length / (4 * channels) - skip, totalFrames - cursor))
      if frames > 0 {
        if contiguous >= length {
          try consume(UnsafeRawPointer(data).assumingMemoryBound(to: Float.self).advanced(by: skip * channels), frames)
        } else {
          // Discontinuous blocks: copy to a single segment first then read, without crossing the end of the first segment.
          var copy = [Float](repeating: 0, count: length / 4)
          let status = copy.withUnsafeMutableBytes { CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: $0.baseAddress!) }
          guard status == kCMBlockBufferNoErr else { throw MediaFailedException("PCM buffer") }
          try copy.withUnsafeBufferPointer { try consume($0.baseAddress!.advanced(by: skip * channels), frames) }
        }
        cursor += frames
      }
    }
    if job.cancelled { throw MediaCancelledException() }
    if job.interrupted { throw MediaInterruptedException() }
    if reader.status == .cancelled { throw MediaCancelledException() }
    if reader.status == .failed { throw MediaFailedException(reader.error?.localizedDescription ?? "PCM decode") }
    try pad(to: totalFrames)
  }

  /** Speech recognition uses lossless WAV, padding silence along the video timeline; do not drop the initial track delay. */
  private func speechAudio(_ job: Job, jobId: String, uri: URL, output: URL) async throws -> [String: Any] {
    try FileManager.default.createDirectory(at: output.deletingLastPathComponent(), withIntermediateDirectories: true)
    let format = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 2)!
    var writer: AVAudioFile? = try AVAudioFile(forWriting: output, settings: format.settings)
    let duration = try await AVURLAsset(url: uri).load(.duration).seconds
    var done = 0; var shown = -1
    try await readPcm(job, uri: uri) { samples, frames in
      guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)), let channels = buffer.floatChannelData else { throw MediaFailedException("PCM allocation") }
      buffer.frameLength = AVAudioFrameCount(frames)
      for i in 0..<frames { for c in 0..<2 { channels[c][i] = samples[i*2+c] } }
      try writer!.write(from: buffer)
      done += frames
      let percent = duration > 0 ? Int(min(100, Double(done)/48000/duration*100)) : 0
      if percent > shown { shown = percent; progress(jobId, Double(percent)/100) }
    }
    writer = nil
    if job.cancelled { throw MediaCancelledException() }
    return try await Self.result(output)
  }

  private func adjustVolume(_ job: Job, jobId: String, uri: URL, output: URL, options: [String: Any]) async throws -> [String: Any] {
    let automatic = options["automatic"] as? Bool ?? true
    let db = (options["db"] as? NSNumber)?.doubleValue ?? 0
    guard db.isFinite, (-24...24).contains(db) else { throw MediaUnsupportedException("invalid gain") }
    let ch = await Self.pcmChannels(uri)
    guard let meter = morph_meter_create(48000, UInt32(ch)) else { throw MediaFailedException("loudness meter") }
    defer { morph_meter_destroy(meter) }
    let seconds = try await AVURLAsset(url: uri).load(.duration).seconds
    var measured = 0; var shown = -1
    try await readPcm(job, uri: uri, channels: ch) { samples, frames in
      if morph_meter_add_float(meter, samples, frames * ch) != 0 { throw MediaFailedException("loudness analysis") }
      measured += frames
      // First pass (loudness measurement) takes the first 25% of progress.
      let percent = seconds > 0 ? Int(min(25, Double(measured) / 48000 / seconds * 25)) : 0
      if percent > shown { shown = percent; progress(jobId, Double(percent) / 100) }
    }
    let gain = Float(morph_meter_gain(meter, automatic ? 1 : 0, db))
    progress(jobId, 0.25)
    try FileManager.default.createDirectory(at: output.deletingLastPathComponent(), withIntermediateDirectories: true)
    let pcm = output.appendingPathExtension("volume.caf")
    defer { try? FileManager.default.removeItem(at: pcm) }
    let format = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: AVAudioChannelCount(ch))!
    var writer: AVAudioFile? = try AVAudioFile(forWriting: pcm, settings: format.settings)
    try await readPcm(job, uri: uri, channels: ch) { samples, frames in
      guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)), let data = buffer.floatChannelData else { throw MediaFailedException("PCM allocation") }
      buffer.frameLength = AVAudioFrameCount(frames)
      for i in 0..<frames { for c in 0..<ch {
        let value = samples[i * ch + c] * gain
        data[c][i] = value.isFinite ? min(1, max(-1, value)) : 0
      } }
      try writer!.write(from: buffer)
    }
    writer = nil
    progress(jobId, 0.5)
    return try await encodeProcessedAudio(job, jobId: jobId, uri: uri, pcm: pcm, output: output, options: options, channels: ch)
  }

  /** RNNoise processes 10ms chunks; drop the first 20ms algorithmic delay and pad the trailing frame to maintain the original timeline. */
  private func denoiseAudio(_ job: Job, jobId: String, uri: URL, output: URL, options: [String: Any]) async throws -> [String: Any] {
    // Mono runs RNNoise only once; others run as stereo.
    let ch = await Self.pcmChannels(uri)
    guard let denoiser = morph_denoise_create(Int32(ch)) else { throw MediaFailedException("denoiser") }
    defer { morph_denoise_destroy(denoiser) }
    try FileManager.default.createDirectory(at: output.deletingLastPathComponent(), withIntermediateDirectories: true)
    let pcm = output.appendingPathExtension("denoise.caf")
    defer { try? FileManager.default.removeItem(at: pcm) }
    let format = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: AVAudioChannelCount(ch))!
    var writer: AVAudioFile? = try AVAudioFile(forWriting: pcm, settings: format.settings)
    let seconds = try await AVURLAsset(url: uri).load(.duration).seconds
    var shown = -1
    var input = [Float](repeating: 0, count: 480 * ch)
    var filtered = input
    var filled = 0; var skip = 960; var total = 0; var written = 0
    func process() throws {
      if job.cancelled { throw MediaCancelledException() }
      let code = input.withUnsafeBufferPointer { source in filtered.withUnsafeMutableBufferPointer { target in morph_denoise_process(denoiser, source.baseAddress!, target.baseAddress!) } }
      guard code == 0 else { throw MediaFailedException("denoise frame") }
      let drop = min(480, skip); skip -= drop
      let frames = min(480 - drop, total - written)
      if frames > 0 {
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)), let channels = buffer.floatChannelData else { throw MediaFailedException("PCM allocation") }
        buffer.frameLength = AVAudioFrameCount(frames)
        for i in 0..<frames { for c in 0..<ch { channels[c][i] = filtered[(i + drop)*ch+c] } }
        try writer!.write(from: buffer); written += frames
      }
      filled = 0
    }
    try await readPcm(job, uri: uri, channels: ch) { samples, frames in
      total += frames
      var offset = 0
      while offset < frames {
        let count = min(480 - filled, frames - offset)
        for i in 0..<count*ch { input[filled*ch+i] = samples[offset*ch+i] }
        filled += count; offset += count
        if filled == 480 { try process() }
      }
      // Noise reduction pass accounts for the first 50% of progress.
      let percent = seconds > 0 ? Int(min(50, Double(total) / 48000 / seconds * 50)) : 0
      if percent > shown { shown = percent; progress(jobId, Double(percent) / 100) }
    }
    if filled > 0 { for i in filled*ch..<480*ch { input[i] = 0 }; try process() }
    input = [Float](repeating: 0, count: 480 * ch)
    for _ in 0..<2 { try process() }
    guard written == total else { throw MediaFailedException("denoise duration") }
    writer = nil
    progress(jobId, 0.5)
    return try await encodeProcessedAudio(job, jobId: jobId, uri: uri, pcm: pcm, output: output, options: options, channels: ch)
  }

  private func encodeProcessedAudio(_ job: Job, jobId: String, uri: URL, pcm: URL, output: URL, options: [String: Any], channels: Int) async throws -> [String: Any] {
    var encode = options
    encode["container"] = "m4a"
    encode["audio"] = ["codec": "aac", "bitrateKbps": channels == 1 ? 96.0 : 192.0, "sampleRate": 48000.0, "channels": channels]
    if options["video"] is [String: Any] {
      encode["container"] = "mp4"; encode["originalVolume"] = 0; encode["loop"] = false
      return try await mixVideoAudio(job, jobId: jobId, uri: uri, music: pcm, output: output, options: encode)
    }
    encode["video"] = "drop"
    return try await transcode(job, jobId: jobId, uri: pcm, output: output, options: encode)
  }

  /** Speed change scales video and audio time simultaneously; varispeed makes audio pitch shift proportionally. */
  private func speedVideo(_ job: Job, jobId: String, uri: URL, output: URL, options: [String: Any], factor: Double) async throws -> [String: Any] {
    guard factor.isFinite, (0.5...4).contains(factor) else { throw MediaUnsupportedException("invalid speed") }
    if job.cancelled { throw MediaCancelledException() }
    let source = AVURLAsset(url: uri)
    let tracks = try await source.load(.tracks)
    guard let video = tracks.first(where: { $0.mediaType == .video }) else { throw MediaUnsupportedException("no video") }
    let (range, transform) = try await video.load(.timeRange, .preferredTransform)
    guard range.duration.seconds > 0 else { throw MediaUnsupportedException("empty video") }
    let asset = AVMutableComposition()
    guard let target = asset.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else { throw MediaFailedException("video track") }
    try target.insertTimeRange(range, of: video, at: .zero)
    target.preferredTransform = transform
    if let audio = await Self.mainAudioTrack(tracks) {
      let audioRange = try await audio.load(.timeRange)
      let overlap = CMTimeRangeGetIntersection(range, otherRange: audioRange)
      if overlap.duration.seconds > 0 {
        guard let audioTarget = asset.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else { throw MediaFailedException("audio track") }
        try audioTarget.insertTimeRange(overlap, of: audio, at: overlap.start - range.start)
      }
    }
    asset.scaleTimeRange(CMTimeRange(start: .zero, duration: range.duration),
                         toDuration: CMTime(seconds: range.duration.seconds / factor, preferredTimescale: 60000))
    return try await transcode(job, jobId: jobId, uri: uri, output: output, options: options, sourceAsset: asset, suppliedTimePitch: .varispeed)
  }

  /** Background music is chosen by the user at runtime; original audio is mixed in at a specified ratio, music loops, and output duration always follows the video. */
  private func mixVideoAudio(
    _ job: Job, jobId: String, uri: URL, music: URL, output: URL, options: [String: Any]
  ) async throws -> [String: Any] {
    let originalVolume = (options["originalVolume"] as? NSNumber)?.floatValue ?? 0
    let loop = options["loop"] as? Bool ?? true
    guard originalVolume.isFinite, (0...100).contains(originalVolume) else { throw MediaUnsupportedException("invalid original volume") }
    let source = AVURLAsset(url: uri)
    let tracks = try await source.load(.tracks)
    guard let video = tracks.first(where: { $0.mediaType == .video }) else { throw MediaUnsupportedException("no video") }
    let (range, transform) = try await video.load(.timeRange, .preferredTransform)
    guard range.duration.seconds > 0 else { throw MediaUnsupportedException("empty video") }
    let musicAsset = AVURLAsset(url: music)
    let musicTracks = try await musicAsset.load(.tracks)
    guard let musicTrack = musicTracks.first(where: { $0.mediaType == .audio }) else { throw MediaUnsupportedException("no music") }
    let musicRange = try await musicTrack.load(.timeRange)
    guard musicRange.duration.seconds > 0, musicRange.duration.seconds.isFinite else { throw MediaUnsupportedException("empty music") }
    let asset = AVMutableComposition()
    guard let videoTarget = asset.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid),
          let musicTarget = asset.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else { throw MediaFailedException("composition track") }
    try videoTarget.insertTimeRange(range, of: video, at: .zero)
    videoTarget.preferredTransform = transform
    var gains: [AVAudioMixInputParameters] = []
    if originalVolume > 0, let original = tracks.first(where: { $0.mediaType == .audio }) {
      let originalRange = try await original.load(.timeRange)
      let overlap = CMTimeRangeGetIntersection(range, otherRange: originalRange)
      if overlap.duration.seconds > 0 {
        guard let originalTarget = asset.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else { throw MediaFailedException("audio track") }
        try originalTarget.insertTimeRange(overlap, of: original, at: overlap.start - range.start)
        let gain = AVMutableAudioMixInputParameters(track: originalTarget)
        gain.setVolume(originalVolume / 100, at: .zero)
        gains.append(gain)
      }
    }
    var cursor = CMTime.zero
    repeat {
      if job.cancelled { throw MediaCancelledException() }
      let length = CMTimeMinimum(musicRange.duration, range.duration - cursor)
      try musicTarget.insertTimeRange(CMTimeRange(start: musicRange.start, duration: length), of: musicTrack, at: cursor)
      cursor = cursor + length
    } while loop && cursor < range.duration
    let musicGain = AVMutableAudioMixInputParameters(track: musicTarget)
    musicGain.setVolume(1, at: .zero)
    gains.append(musicGain)
    let mix = AVMutableAudioMix()
    mix.inputParameters = gains
    return try await transcode(job, jobId: jobId, uri: uri, output: output, options: options, sourceAsset: asset, suppliedAudioMix: mix)
  }

  /** Video concatenation: each segment is individually straightened and letterboxed proportionally to the first segment's canvas; silent segments do not insert an audio track. */
  private func concatVideo(
    _ job: Job, jobId: String, uris: [URL], output: URL, options: [String: Any]
  ) async throws -> [String: Any] {
    guard (2...10).contains(uris.count), let videoOptions = options["video"] as? [String: Any] else {
      throw MediaUnsupportedException("expected 2–10 video clips")
    }
    let width = (videoOptions["width"] as? NSNumber)?.intValue ?? 0
    let height = (videoOptions["height"] as? NSNumber)?.intValue ?? 0
    let fps = (videoOptions["maxFps"] as? NSNumber)?.doubleValue ?? 30
    guard width > 0, height > 0, width % 2 == 0, height % 2 == 0, fps > 0, fps.isFinite else {
      throw MediaUnsupportedException("invalid output dimensions or frame rate")
    }
    let asset = AVMutableComposition()
    let composition = AVMutableVideoComposition()
    composition.renderSize = CGSize(width: width, height: height)
    composition.frameDuration = CMTime(seconds: 1 / fps, preferredTimescale: 60000)
    composition.colorPrimaries = AVVideoColorPrimaries_ITU_R_709_2
    composition.colorTransferFunction = AVVideoTransferFunction_ITU_R_709_2
    composition.colorYCbCrMatrix = AVVideoYCbCrMatrix_ITU_R_709_2
    var instructions: [AVVideoCompositionInstructionProtocol] = []
    var cursor = CMTime.zero
    for uri in uris {
      if job.cancelled { throw MediaCancelledException() }
      let sourceAsset = AVURLAsset(url: uri)
      let sourceTracks = try await sourceAsset.load(.tracks)
      guard let source = sourceTracks.first(where: { $0.mediaType == .video }),
            let target = asset.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else {
        throw MediaUnsupportedException("no video")
      }
      let (range, natural, transform) = try await source.load(.timeRange, .naturalSize, .preferredTransform)
      guard range.duration.seconds > 0, range.duration.seconds.isFinite else { throw MediaUnsupportedException("empty video") }
      try target.insertTimeRange(range, of: source, at: cursor)
      let bounds = CGRect(origin: .zero, size: natural).applying(transform)
      guard bounds.width > 0, bounds.height > 0 else { throw MediaUnsupportedException("empty frame") }
      let scale = min(CGFloat(width) / bounds.width, CGFloat(height) / bounds.height)
      let position = transform
        .concatenating(CGAffineTransform(translationX: -bounds.minX, y: -bounds.minY))
        .concatenating(CGAffineTransform(scaleX: scale, y: scale))
        .concatenating(CGAffineTransform(translationX: (CGFloat(width) - bounds.width * scale) / 2,
                                       y: (CGFloat(height) - bounds.height * scale) / 2))
      let layer = AVMutableVideoCompositionLayerInstruction(assetTrack: target)
      layer.setTransform(position, at: cursor)
      let instruction = AVMutableVideoCompositionInstruction()
      instruction.timeRange = CMTimeRange(start: cursor, duration: range.duration)
      instruction.backgroundColor = UIColor.black.cgColor
      instruction.layerInstructions = [layer]
      instructions.append(instruction)
      if options["audio"] as? String != "drop", let audio = sourceTracks.first(where: { $0.mediaType == .audio }) {
        let audioRange = try await audio.load(.timeRange)
        let overlap = CMTimeRangeGetIntersection(range, otherRange: audioRange)
        if overlap.duration.seconds > 0 {
          guard let audioTarget = asset.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else { throw MediaFailedException("audio track") }
          try audioTarget.insertTimeRange(overlap, of: audio, at: cursor + overlap.start - range.start)
        }
      }
      cursor = cursor + range.duration
    }
    composition.instructions = instructions
    return try await transcode(job, jobId: jobId, uri: uris[0], output: output, options: options,
                               sourceAsset: asset, suppliedComposition: composition)
  }

  /** Concatenating multiple segments into one: each segment is placed in its own track during composition, connected end-to-end, and mixed into a single track upon reading (formats and sample rates can differ). */
  private func concat(
    _ job: Job, jobId: String, uris: [URL], output: URL, options: [String: Any]
  ) async throws -> [String: Any] {
    if options["video"] is [String: Any] {
      return try await concatVideo(job, jobId: jobId, uris: uris, output: output, options: options)
    }
    let composition = AVMutableComposition()
    var tracks: [AVAssetTrack] = []
    var cursor = CMTime.zero
    for uri in uris {
      let asset = AVURLAsset(url: uri)
      let (duration, sourceTracks) = try await asset.load(.duration, .tracks)
      guard let source = sourceTracks.first(where: { $0.mediaType == .audio }) else {
        throw MediaUnsupportedException("no audio: \(uri.lastPathComponent)")
      }
      guard let track = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else {
        throw MediaFailedException("composition track")
      }
      do {
        try track.insertTimeRange(CMTimeRange(start: .zero, duration: duration), of: source, at: cursor)
      } catch {
        throw MediaUnsupportedException(error.localizedDescription)
      }
      tracks.append(track)
      cursor = cursor + duration
    }
    return try await writeAudio(
      job, jobId: jobId, asset: composition, tracks: tracks,
      timeRange: CMTimeRange(start: .zero, duration: cursor), output: output,
      container: options["container"] as? String ?? "m4a", audio: options["audio"] as? [String: Any] ?? [:])
  }

  /** Waveform: decoded to 8 kHz mono, taking the maximum volume per bucket, then normalized to 0-1 relative to the loudest bucket. */
  static func waveform(_ uri: URL, buckets: Int, range: [String: Double]?) async throws -> [Double] {
    let asset = AVURLAsset(url: uri)
    let (duration, tracks) = try await asset.load(.duration, .tracks)
    let audio = tracks.filter { $0.mediaType == .audio }
    if audio.isEmpty || buckets <= 0 { throw MediaUnsupportedException("no audio") }
    var timeRange = CMTimeRange(start: .zero, duration: duration)
    if let range, let start = range["startMs"], let end = range["endMs"] {
      timeRange = CMTimeRange(
        start: CMTime(seconds: start / 1000, preferredTimescale: 600),
        end: CMTime(seconds: end / 1000, preferredTimescale: 600))
    }
    let rate = 8000.0
    let reader = try AVAssetReader(asset: asset)
    reader.timeRange = timeRange
    let out = AVAssetReaderAudioMixOutput(
      audioTracks: audio,
      audioSettings: [
        AVFormatIDKey: kAudioFormatLinearPCM,
        AVSampleRateKey: rate,
        AVNumberOfChannelsKey: 1,
        AVLinearPCMBitDepthKey: 16,
        AVLinearPCMIsFloatKey: false,
        AVLinearPCMIsBigEndianKey: false,
        AVLinearPCMIsNonInterleaved: false,
      ])
    guard reader.canAdd(out) else { throw MediaUnsupportedException("waveform output") }
    reader.add(out)
    guard reader.startReading() else {
      throw MediaUnsupportedException(reader.error?.localizedDescription ?? "reader")
    }
    let total = max(1, Int(timeRange.duration.seconds * rate))
    var peaks = [Double](repeating: 0, count: buckets)
    var index = 0
    while let sample = out.copyNextSampleBuffer() {
      guard let block = CMSampleBufferGetDataBuffer(sample) else { continue }
      let length = CMBlockBufferGetDataLength(block)
      var data = Data(count: length)
      data.withUnsafeMutableBytes { raw in
        _ = CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: raw.baseAddress!)
      }
      data.withUnsafeBytes { raw in
        for value in raw.bindMemory(to: Int16.self) {
          let bucket = min(buckets - 1, index * buckets / total)
          peaks[bucket] = max(peaks[bucket], abs(Double(value)) / 32768)
          index += 1
        }
      }
    }
    let loudest = peaks.max() ?? 0
    return loudest > 0 ? peaks.map { $0 / loudest } : peaks
  }

  // MARK: - GIF（D-184）

  private static func gifDestination(_ output: URL, frames: Int) throws -> CGImageDestination {
    try? FileManager.default.removeItem(at: output)
    try FileManager.default.createDirectory(
      at: output.deletingLastPathComponent(), withIntermediateDirectories: true)
    guard let dest = CGImageDestinationCreateWithURL(output as CFURL, UTType.gif.identifier as CFString, frames, nil)
    else { throw MediaFailedException("gif destination") }
    CGImageDestinationSetProperties(
      dest, [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFLoopCount: 0]] as CFDictionary)
    return dest
  }

  private static func gifFrame(delay: Double) -> CFDictionary {
    [kCGImagePropertyGIFDictionary: [
      kCGImagePropertyGIFDelayTime: delay, kCGImagePropertyGIFUnclampedDelayTime: delay,
    ]] as CFDictionary
  }

  private static func gifResult(_ output: URL, width: Int, height: Int, frames: Int) -> [String: Any] {
    ["uri": output.absoluteString, "size": fileSize(output), "width": width, "height": height, "frames": frames]
  }

  /** Video to GIF: extracts frames from start to end at the specified fps (already straightened, width not exceeding width), using the entire segment (length checked by caller in advance). */
  private func videoGif(
    _ job: Job, jobId: String, uri: URL, output: URL, options: [String: Double]
  ) async throws -> [String: Any] {
    let width = options["width"] ?? 480
    let fps = max(1, options["fps"] ?? 12)
    let asset = AVURLAsset(url: uri)
    let (duration, tracks) = try await asset.load(.duration, .tracks)
    guard tracks.contains(where: { $0.mediaType == .video }) else { throw MediaUnsupportedException("no video") }
    let count = max(1, Int(duration.seconds * fps))
    let generator = AVAssetImageGenerator(asset: asset)
    generator.appliesPreferredTrackTransform = true
    // Width does not exceed width, height is unlimited (vertical videos are scaled by width).
    generator.maximumSize = CGSize(width: width, height: width * 20)
    let tolerance = CMTime(seconds: 0.5 / fps, preferredTimescale: 600)
    generator.requestedTimeToleranceBefore = tolerance
    generator.requestedTimeToleranceAfter = tolerance
    let dest = try Self.gifDestination(output, frames: count)
    let props = Self.gifFrame(delay: 1 / fps)
    var size = CGSize.zero
    for i in 0..<count {
      if job.cancelled { throw MediaCancelledException() }
      let image: CGImage
      do {
        image = try await generator.image(at: CMTime(seconds: Double(i) / fps, preferredTimescale: 600)).image
      } catch {
        if i == 0 { throw MediaUnsupportedException(error.localizedDescription) }
        continue
      }
      if i == 0 { size = CGSize(width: image.width, height: image.height) }
      CGImageDestinationAddImage(dest, image, props)
      progress(jobId, Double(i + 1) / Double(count) * 0.9)
    }
    guard CGImageDestinationFinalize(dest) else { throw MediaFailedException("gif finalize") }
    progress(jobId, 1)
    return Self.gifResult(output, width: Int(size.width), height: Int(size.height), frames: count)
  }

  /** Images -> GIF: Canvas is the first image (long side scaled to maxSide), each image is centered and scaled proportionally within the canvas, with empty areas filled with white. */
  private func imagesGif(
    _ job: Job, jobId: String, uris: [URL], output: URL, options: [String: Double]
  ) throws -> [String: Any] {
    let maxSide = options["maxSide"] ?? 480
    let delay = (options["delayMs"] ?? 500) / 1000
    func load(_ url: URL) throws -> CGImage {
      guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
        let image = CGImageSourceCreateThumbnailAtIndex(
          source, 0,
          [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxSide,
          ] as CFDictionary)
      else { throw MediaUnsupportedException(url.lastPathComponent) }
      return image
    }
    guard let first = uris.first else { throw MediaFailedException("no images") }
    let firstImage = try load(first)
    let canvas = CGSize(width: firstImage.width, height: firstImage.height)
    let dest = try Self.gifDestination(output, frames: uris.count)
    let props = Self.gifFrame(delay: delay)
    guard
      let context = CGContext(
        data: nil, width: Int(canvas.width), height: Int(canvas.height), bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
    else { throw MediaFailedException("gif canvas") }
    for (i, url) in uris.enumerated() {
      if job.cancelled { throw MediaCancelledException() }
      let image = i == 0 ? firstImage : try load(url)
      let scale = min(canvas.width / CGFloat(image.width), canvas.height / CGFloat(image.height))
      let w = CGFloat(image.width) * scale
      let h = CGFloat(image.height) * scale
      context.setFillColor(UIColor.white.cgColor)
      context.fill(CGRect(origin: .zero, size: canvas))
      context.interpolationQuality = .high
      context.draw(image, in: CGRect(x: (canvas.width - w) / 2, y: (canvas.height - h) / 2, width: w, height: h))
      guard let frame = context.makeImage() else { throw MediaFailedException("gif frame") }
      CGImageDestinationAddImage(dest, frame, props)
      progress(jobId, Double(i + 1) / Double(uris.count) * 0.9)
    }
    guard CGImageDestinationFinalize(dest) else { throw MediaFailedException("gif finalize") }
    progress(jobId, 1)
    return Self.gifResult(output, width: Int(canvas.width), height: Int(canvas.height), frames: uris.count)
  }

  /** iOS only modifies orientation metadata in the container; encoding samples are kept as-is. */
  private func rotateVideo(_ job: Job, jobId: String, uri: URL, output: URL, degrees: Int) async throws -> [String: Any] {
    guard [90, 180, 270].contains(degrees) else { throw MediaUnsupportedException("invalid rotation") }
    if job.cancelled { throw MediaCancelledException() }
    let source = AVURLAsset(url: uri)
    let tracks = try await source.load(.tracks)
    guard let video = tracks.first(where: { $0.mediaType == .video }) else { throw MediaUnsupportedException("no video") }
    let (range, natural, transform) = try await video.load(.timeRange, .naturalSize, .preferredTransform)
    let asset = AVMutableComposition()
    guard let target = asset.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else { throw MediaFailedException("video track") }
    try target.insertTimeRange(range, of: video, at: .zero)
    let rotated = transform.concatenating(CGAffineTransform(rotationAngle: CGFloat(degrees) * .pi / 180))
    let bounds = CGRect(origin: .zero, size: natural).applying(rotated)
    target.preferredTransform = rotated.concatenating(CGAffineTransform(translationX: -bounds.minX, y: -bounds.minY))
    if let audio = await Self.mainAudioTrack(tracks) {
      let audioRange = try await audio.load(.timeRange)
      let overlap = CMTimeRangeGetIntersection(range, otherRange: audioRange)
      if overlap.duration.seconds > 0 {
        guard let audioTarget = asset.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else { throw MediaFailedException("audio track") }
        try audioTarget.insertTimeRange(overlap, of: audio, at: overlap.start - range.start)
      }
    }
    return try await trim(job, jobId: jobId, uri: uri, output: output, range: ["startMs": 0, "endMs": range.duration.seconds * 1000], sourceAsset: asset, metadataFrom: source)
  }

  /** Remove sound: keeps only the video track, exports as-is, without re-encoding (HDR and quality remain unchanged), preserving capture time, location, and other metadata. */
  private func muteVideo(_ job: Job, jobId: String, uri: URL, output: URL) async throws -> [String: Any] {
    if job.cancelled { throw MediaCancelledException() }
    let source = AVURLAsset(url: uri)
    let tracks = try await source.load(.tracks)
    guard let video = tracks.first(where: { $0.mediaType == .video }) else { throw MediaUnsupportedException("no video") }
    let (range, transform) = try await video.load(.timeRange, .preferredTransform)
    guard range.duration.seconds > 0 else { throw MediaUnsupportedException("empty video") }
    let asset = AVMutableComposition()
    guard let target = asset.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else { throw MediaFailedException("video track") }
    try target.insertTimeRange(range, of: video, at: .zero)
    target.preferredTransform = transform
    return try await trim(job, jobId: jobId, uri: uri, output: output, range: ["startMs": 0, "endMs": range.duration.seconds * 1000], sourceAsset: asset, metadataFrom: source)
  }

  // MARK: - trim

  private func trim(
    _ job: Job, jobId: String, uri: URL, output: URL, range: [String: Double], sourceAsset: AVAsset? = nil,
    metadataFrom: AVAsset? = nil
  ) async throws -> [String: Any] {
    guard let startMs = range["startMs"], let endMs = range["endMs"], endMs > startMs else {
      throw MediaFailedException("range")
    }
    let asset: AVAsset = sourceAsset ?? AVURLAsset(url: uri)
    let timeRange = CMTimeRange(
      start: CMTime(seconds: startMs / 1000, preferredTimescale: 600),
      end: CMTime(seconds: endMs / 1000, preferredTimescale: 600))
    try? FileManager.default.createDirectory(
      at: output.deletingLastPathComponent(), withIntermediateDirectories: true)
    // Start with the requested container (usually MP4); switch to MOV when the original audio cannot be placed into MP4 (e.g. PCM).
    var targets = [output]
    if output.pathExtension.lowercased() == "mp4" {
      targets.append(output.deletingPathExtension().appendingPathExtension("mov"))
    }
    // New compositions do not carry the original file's capture time, location, etc.; copy them over from the original file.
    let metadata = metadataFrom == nil ? nil : try? await metadataFrom!.load(.metadata)
    var lastError: Error?
    for target in targets {
      if job.cancelled { throw MediaCancelledException() }
      do {
        try await export(job, jobId: jobId, asset: asset, range: timeRange, to: target, metadata: metadata)
        progress(jobId, 1)
        return try await Self.result(target)
      } catch let error as MediaCancelledException {
        throw error
      } catch {
        lastError = error
      }
    }
    throw lastError ?? MediaFailedException("trim")
  }

  private func export(_ job: Job, jobId: String, asset: AVAsset, range: CMTimeRange, to url: URL, metadata: [AVMetadataItem]? = nil) async throws {
    guard let session = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetPassthrough) else {
      throw MediaUnsupportedException("export")
    }
    let type: AVFileType
    switch url.pathExtension.lowercased() {
    case "mov": type = .mov
    case "m4a": type = .m4a
    default: type = .mp4
    }
    guard session.supportedFileTypes.contains(type) else {
      throw MediaUnsupportedException("container \(type.rawValue)")
    }
    try? FileManager.default.removeItem(at: url)
    session.outputURL = url
    session.outputFileType = type
    session.timeRange = range
    session.shouldOptimizeForNetworkUse = true
    if let metadata { session.metadata = metadata }
    job.onCancel = { session.cancelExport() }
    let timer = DispatchSource.makeTimerSource(queue: .global())
    timer.schedule(deadline: .now(), repeating: .milliseconds(250))
    timer.setEventHandler { self.progress(jobId, Double(session.progress)) }
    timer.resume()
    defer { timer.cancel() }
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      session.exportAsynchronously { continuation.resume() }
    }
    switch session.status {
    case .completed:
      return
    case .cancelled:
      if job.backgrounded && !job.cancelled { throw MediaInterruptedException() }
      throw MediaCancelledException()
    default:
      if job.backgrounded { throw MediaInterruptedException() }
      throw MediaFailedException(session.error?.localizedDescription ?? "export")
    }
  }

  // MARK: - thumbnails

  static func thumbnails(_ uri: URL, timesMs: [Double], maxSide: Double, directory: URL, precise: Bool = false) async throws -> [String] {
    let asset = AVURLAsset(url: uri)
    let generator = AVAssetImageGenerator(asset: asset)
    generator.appliesPreferredTrackTransform = true
    generator.maximumSize = CGSize(width: maxSide, height: maxSide)
    // Thumbnails on the timeline do not need frame accuracy; relaxing the tolerance speeds things up significantly.
    let tolerance = precise ? CMTime.zero : CMTime(seconds: 0.5, preferredTimescale: 600)
    generator.requestedTimeToleranceBefore = tolerance
    generator.requestedTimeToleranceAfter = tolerance
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    var uris: [String] = []
    for ms in timesMs {
      let time = CMTime(seconds: ms / 1000, preferredTimescale: 600)
      let image: CGImage
      do {
        image = try await generator.image(at: time).image
      } catch {
        throw MediaUnsupportedException(error.localizedDescription)
      }
      guard let data = UIImage(cgImage: image).jpegData(compressionQuality: precise ? 0.95 : 0.7) else {
        throw MediaFailedException("jpeg")
      }
      let file = directory.appendingPathComponent("\(UUID().uuidString).jpg")
      try data.write(to: file)
      uris.append(file.absoluteString)
    }
    return uris
  }
}
