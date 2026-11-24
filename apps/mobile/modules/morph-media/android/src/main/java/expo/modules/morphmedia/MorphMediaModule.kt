package expo.modules.morphmedia

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.RectF
import android.media.ExifInterface
import android.media.MediaCodecList
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.OpenableColumns
import androidx.annotation.OptIn
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.ChannelMixingAudioProcessor
import androidx.media3.common.audio.ChannelMixingMatrix
import androidx.media3.common.audio.SonicAudioProcessor
import androidx.media3.common.util.UnstableApi
import androidx.media3.effect.FrameDropEffect
import androidx.media3.effect.Presentation
import androidx.media3.effect.SpeedChangeEffect
import androidx.media3.effect.ScaleAndRotateTransformation
import androidx.media3.transformer.AudioEncoderSettings
import androidx.media3.transformer.Composition
import androidx.media3.transformer.DefaultEncoderFactory
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.EditedMediaItemSequence
import androidx.media3.transformer.Effects
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.FrameworkMuxer
import androidx.media3.transformer.ProgressHolder
import androidx.media3.transformer.Transformer
import androidx.media3.transformer.VideoEncoderSettings
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

// Android implementation for video and audio (D-141): same JS interface as iOS.
// - probe: MediaExtractor (codec, bitrate, sample rate, HDR) + MediaMetadataRetriever (duration,
// width, height, orientation).
// - transcode: Media3 Transformer, H.264 + AAC writing MP4, specified bitrate; scaling uses
// Presentation, frame rate limiting uses FrameDropEffect, HDR uses OpenGL to convert to standard
// video.
// - trim: Transformer's trim optimization (re-encodes only a small segment at the start, copies the
// rest as-is).
// - thumbnails：MediaMetadataRetriever。
// - GIF (D-184): extracts frames using MediaMetadataRetriever for video, reads images using
// BitmapFactory (oriented via EXIF), and encodes using our own GifEncoder (the system lacks a GIF
// encoder). All processed on-device without network. Reads content:// URIs shared in directly
// without copying.

class MediaUnsupportedException(detail: String?) :
  CodedException("ERR_MEDIA_UNSUPPORTED", "This media can't be opened: $detail", null)

class MediaCancelledException : CodedException("ERR_MEDIA_CANCELLED", "Cancelled", null)

class NotImplementedException(what: String) :
  CodedException("ERR_NOT_IMPLEMENTED", "Not implemented yet: $what", null)

class MediaFailedException(detail: String?) :
  CodedException("ERR_MEDIA_FAILED", "Processing failed: $detail", null)

@OptIn(markerClass = [UnstableApi::class])
class MorphMediaModule : Module() {
  private val context: Context
    get() = requireNotNull(appContext.reactContext) { "React Application Context is null" }

  private val main = Handler(Looper.getMainLooper())

  /** Ongoing tasks (read/written on the main thread only). */
  private val jobs = mutableMapOf<String, Transformer>()
  private val cancelled = mutableSetOf<String>()
  // Promises and output files of in-progress Transformer tasks: Transformer.cancel() does not
  // always invoke listeners; when cancelled, ending the promise here prevents the JS side from
  // waiting indefinitely. Whichever thread claims it from here is responsible for finishing it
  // (finishing exactly once).
  private val pending = mutableMapOf<String, Pair<Promise, File>>()
  /** Tasks running on background threads (writing WAV): cancellation flag. */
  private val threadJobs = ConcurrentHashMap<String, AtomicBoolean>()

  override fun definition() = ModuleDefinition {
    Name("MorphMedia")

    Events("progress")

    AsyncFunction("probe") { uri: String, promise: Promise ->
      thread {
        try {
          promise.resolve(probe(Uri.parse(uri)))
        } catch (e: CodedException) {
          promise.reject(e)
        } catch (e: Exception) {
          promise.reject(MediaUnsupportedException(e.message))
        }
      }
    }

    AsyncFunction("transcode") {
      jobId: String, uri: String, output: String, options: Map<String, Any?>, promise: Promise ->
      if (options["video"] == "drop") {
        transcodeAudio(jobId, Uri.parse(uri), File(Uri.parse(output).path!!), options, promise)
        return@AsyncFunction
      }
      try {
        val transformer = buildTranscode(Uri.parse(uri), options)
        run(jobId, transformer.first, transformer.second, File(Uri.parse(output).path!!), promise)
      } catch (e: CodedException) {
        promise.reject(e)
      } catch (e: Exception) {
        promise.reject(MediaFailedException(e.message))
      }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("rotate") {
      jobId: String, uri: String, output: String, degrees: Int, options: Map<String, Any?>, promise: Promise ->
      try {
        if (degrees !in listOf(90, 180, 270)) throw MediaUnsupportedException("invalid rotation")
        @Suppress("UNCHECKED_CAST")
        val video = (options["video"] as? Map<String, Any?> ?: emptyMap()).toMutableMap()
        video["rotationDegrees"] = degrees
        val settings = options.toMutableMap().apply { put("video", video) }
        val (transformer, composition) = buildTranscode(Uri.parse(uri), settings)
        run(jobId, transformer, composition, File(Uri.parse(output).path!!), promise)
      } catch (e: CodedException) { promise.reject(e) }
      catch (e: Exception) { promise.reject(MediaFailedException(e.message)) }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("mixAudio") {
      jobId: String, uri: String, music: String, output: String, options: Map<String, Any?>, promise: Promise ->
      mixVideoAudio(jobId, uri, music, output, options, promise)
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("volume") {
      jobId: String, uri: String, output: String, options: Map<String, Any?>, promise: Promise ->
      val flag = AtomicBoolean(false)
      threadJobs[jobId] = flag
      thread {
        val destination = File(Uri.parse(output).path!!)
        val wave = File(destination.parentFile, "${destination.name}.volume.wav")
        try {
          destination.parentFile?.mkdirs()
          val automatic = options["automatic"] as? Boolean ?: true
          val db = (options["db"] as? Number)?.toDouble() ?: 0.0
          if (!db.isFinite() || db !in -24.0..24.0) throw MediaUnsupportedException("invalid gain")
          AudioVolume.prepare(context, Uri.parse(uri), wave, automatic, db, flag, (probe(Uri.parse(uri))["durationMs"] as? Number)?.toDouble() ?: 0.0) { sendProgress(jobId, it) }
          if (flag.get()) throw MediaCancelledException()
          main.post {
            // Intermediate WAV must wait for subsequent asynchronous encoding to finish, and is deleted upon completion (success or failure).
            val done = promise.deletingAfter(wave)
            try {
              if (flag.get()) throw MediaCancelledException()
              if (options["video"] is Map<*, *>) {
                val mixOptions = options.toMutableMap().apply {
                  put("container", "mp4"); put("audio", mapOf("codec" to "aac", "bitrateKbps" to 192))
                  put("originalVolume", 0); put("loop", false)
                  put("videoDurationMs", probe(Uri.parse(uri))["durationMs"] ?: 0)
                  put("musicDurationMs", probe(Uri.fromFile(wave))["durationMs"] ?: 0)
                }
                mixVideoAudio(jobId, uri, Uri.fromFile(wave).toString(), output, mixOptions, done)
              } else {
                transcodeAudio(jobId, Uri.fromFile(wave), destination,
                  mapOf("container" to "m4a", "video" to "drop", "audio" to mapOf("codec" to "aac", "bitrateKbps" to 192)), done)
              }
            } catch (e: CodedException) { done.reject(e) }
            catch (e: Exception) { done.reject(MediaFailedException(e.message)) }
            finally { threadJobs.remove(jobId) }
          }
        } catch (e: CodedException) { threadJobs.remove(jobId); wave.delete(); promise.reject(e) }
        catch (e: Exception) { threadJobs.remove(jobId); wave.delete(); promise.reject(MediaFailedException(e.message)) }
      }
    }

    AsyncFunction("speechAudio") { jobId: String, uri: String, output: String, promise: Promise ->
      val flag = AtomicBoolean(false); threadJobs[jobId] = flag
      thread {
        val destination = File(Uri.parse(output).path!!)
        try {
          destination.parentFile?.mkdirs()
          val durationMs = (probe(Uri.parse(uri))["durationMs"] as? Number)?.toDouble() ?: 0.0
          val writer = AudioPcm.WavWriter(destination)
          var complete = false; var shown = -1
          try {
            AudioPcm.visitTimeline(context, Uri.parse(uri), durationMs, { flag.get() }) { chunk ->
              writer.write(chunk.samples, chunk.channels, chunk.sampleRate)
              val percent = if (durationMs > 0) (chunk.ptsUs / 10 / durationMs).toInt().coerceIn(0,100) else 0
              if (percent > shown) { shown = percent; sendProgress(jobId, percent/100.0) }
            }
            if (flag.get()) throw MediaCancelledException()
            complete = true
          } finally { if (complete) writer.close() else runCatching { writer.close() } }
          promise.resolve(result(destination))
        } catch (e: CodedException) { destination.delete(); promise.reject(e) }
        catch (e: Exception) { destination.delete(); promise.reject(MediaFailedException(e.message)) }
        finally { threadJobs.remove(jobId) }
      }
    }

    AsyncFunction("denoise") {
      jobId: String, uri: String, output: String, options: Map<String, Any?>, promise: Promise ->
      val flag = AtomicBoolean(false)
      threadJobs[jobId] = flag
      thread {
        val destination = File(Uri.parse(output).path!!)
        val wave = File(destination.parentFile, "${destination.name}.denoise.wav")
        try {
          destination.parentFile?.mkdirs()
          AudioDenoise.prepare(context, Uri.parse(uri), wave, flag, (probe(Uri.parse(uri))["durationMs"] as? Number)?.toDouble() ?: 0.0) { sendProgress(jobId, it) }
          if (flag.get()) throw MediaCancelledException()
          main.post {
            // Intermediate WAV must wait for subsequent asynchronous encoding to finish, and is deleted upon completion (success or failure).
            val done = promise.deletingAfter(wave)
            try {
              if (flag.get()) throw MediaCancelledException()
              if (options["video"] is Map<*, *>) {
                val mixOptions = options.toMutableMap().apply {
                  put("container", "mp4"); put("audio", mapOf("codec" to "aac", "bitrateKbps" to 192))
                  put("originalVolume", 0); put("loop", false)
                  put("videoDurationMs", probe(Uri.parse(uri))["durationMs"] ?: 0)
                  put("musicDurationMs", probe(Uri.fromFile(wave))["durationMs"] ?: 0)
                }
                mixVideoAudio(jobId, uri, Uri.fromFile(wave).toString(), output, mixOptions, done)
              } else {
                transcodeAudio(jobId, Uri.fromFile(wave), destination,
                  mapOf("container" to "m4a", "video" to "drop", "audio" to mapOf("codec" to "aac", "bitrateKbps" to 192)), done)
              }
            } catch (e: CodedException) { done.reject(e) }
            catch (e: Exception) { done.reject(MediaFailedException(e.message)) }
            finally { threadJobs.remove(jobId) }
          }
        } catch (e: CodedException) { threadJobs.remove(jobId); wave.delete(); promise.reject(e) }
        catch (e: Exception) { threadJobs.remove(jobId); wave.delete(); promise.reject(MediaFailedException(e.message)) }
      }
    }

    AsyncFunction("trim") {
      jobId: String, uri: String, output: String, range: Map<String, Double>, promise: Promise ->
      val start = range["startMs"]
      val end = range["endMs"]
      if (start == null || end == null || end <= start) {
        promise.reject(MediaFailedException("range"))
        return@AsyncFunction
      }
      val source = Uri.parse(uri)
      // First reads format in the background: when the phone lacks an encoder capable of encoding
      // that format at native size (e.g., HEVC), Transformer silently falls back to a very small
      // resolution (emulator tests show 1080x1920 HEVC becoming 270x480), in which case we switch
      // to H.264.
      thread {
        val info = try {
          probe(source)
        } catch (e: CodedException) {
          promise.reject(e)
          return@thread
        }
        main.post {
          val item = MediaItem.Builder()
            .setUri(source)
            .setClippingConfiguration(
              MediaItem.ClippingConfiguration.Builder()
                .setStartPositionMs(start.toLong())
                .setEndPositionMs(end.toLong())
                .build()
            )
            .build()
          // No re-encoding, no added effects: re-encodes only the segment from the start to the first keyframe, copying the rest as-is.
          val builder = Transformer.Builder(context).experimentalSetTrimOptimizationEnabled(true)
          val codec = (info["videoCodec"] as? String)?.let { "video/$it" }
          val width = (info["width"] as? Int) ?: 0
          val height = (info["height"] as? Int) ?: 0
          if (codec != null && !canEncode(codec, width, height)) {
            builder.setVideoMimeType(MimeTypes.VIDEO_H264)
          }
          val composition = Composition.Builder(
            EditedMediaItemSequence.withAudioAndVideoFrom(listOf(EditedMediaItem.Builder(item).build()))
          ).build()
          run(jobId, builder.build(), composition, File(Uri.parse(output).path!!), promise)
        }
      }
    }

    AsyncFunction("frame") { uri: String, timeMs: Double, directory: String, promise: Promise ->
      thread {
        try {
          if (!timeMs.isFinite() || timeMs < 0) throw MediaUnsupportedException("invalid frame time")
          promise.resolve(thumbnails(Uri.parse(uri), listOf(timeMs), 0, File(Uri.parse(directory).path!!), true).first())
        } catch (e: CodedException) { promise.reject(e) }
        catch (e: OutOfMemoryError) { promise.reject(MediaFailedException("not enough memory for a full-resolution frame")) }
        catch (e: Exception) { promise.reject(MediaUnsupportedException(e.message)) }
      }
    }

    AsyncFunction("thumbnails") {
      uri: String, timesMs: List<Double>, maxSide: Double, directory: String, promise: Promise ->
      thread {
        try {
          promise.resolve(thumbnails(Uri.parse(uri), timesMs, maxSide.roundToInt(), File(Uri.parse(directory).path!!)))
        } catch (e: CodedException) {
          promise.reject(e)
        } catch (e: Exception) {
          promise.reject(MediaUnsupportedException(e.message))
        }
      }
    }

    // Audio (D-153, D-155, audio sessions): concatenating multiple segments into one (a Media3 sequence), waveforms (decoded manually).
    AsyncFunction("concat") {
      jobId: String, uris: List<String>, output: String, options: Map<String, Any?>, promise: Promise ->
      try {
        if (options["video"] is Map<*, *>) {
          if (uris.size !in 2..10) throw MediaUnsupportedException("expected 2–10 video clips")
          val (transformer, composition) = buildTranscode(Uri.parse(uris.first()), options, uris.map { Uri.parse(it) })
          run(jobId, transformer, composition, File(Uri.parse(output).path!!), promise)
          return@AsyncFunction
        }
        if ((options["container"] as? String ?: "m4a") != "m4a") throw NotImplementedException("concat to WAV")
        @Suppress("UNCHECKED_CAST")
        val audio = options["audio"] as? Map<String, Any?> ?: emptyMap()
        val items = uris.map { audioItem(MediaItem.fromUri(Uri.parse(it)), audio) }
        val composition = Composition.Builder(EditedMediaItemSequence.withAudioFrom(items)).build()
        run(jobId, aacTransformer(audio), composition, File(Uri.parse(output).path!!), promise)
      } catch (e: CodedException) {
        promise.reject(e)
      } catch (e: Exception) {
        promise.reject(MediaFailedException(e.message))
      }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("waveform") { uri: String, buckets: Int, range: Map<String, Double>?, promise: Promise ->
      thread {
        try {
          val start = ((range?.get("startMs") ?: 0.0) * 1000).toLong()
          val end = range?.get("endMs")?.let { (it * 1000).toLong() } ?: Long.MAX_VALUE
          promise.resolve(AudioPcm.waveform(context, Uri.parse(uri), buckets, start, end))
        } catch (e: CodedException) {
          promise.reject(e)
        } catch (e: Exception) {
          promise.reject(MediaUnsupportedException(e.message))
        }
      }
    }

    // Animations (D-184): frame extraction and encoding on a background thread, cancellable.
    AsyncFunction("videoGif") {
      jobId: String, uri: String, output: String, options: Map<String, Double>, promise: Promise ->
      gifJob(jobId, File(Uri.parse(output).path!!), promise) { flag, out ->
        videoGif(jobId, Uri.parse(uri), out, options, flag)
      }
    }

    AsyncFunction("imagesGif") {
      jobId: String, uris: List<String>, output: String, options: Map<String, Double>, promise: Promise ->
      gifJob(jobId, File(Uri.parse(output).path!!), promise) { flag, out ->
        imagesGif(jobId, uris.map { Uri.parse(it) }, out, options, flag)
      }
    }

    Function("cancel") { jobId: String ->
      threadJobs[jobId]?.set(true)
      main.post {
        cancelled.add(jobId)
        jobs.remove(jobId)?.cancel()
        pending.remove(jobId)?.let { (promise, output) ->
          cancelled.remove(jobId)
          output.delete()
          promise.reject(MediaCancelledException())
        }
      }
    }
  }

  // ---- Tasks ----

  /** Starts export on the main thread, polls progress, and reads output file info upon completion. */
  private fun run(
    jobId: String,
    transformer: Transformer,
    composition: Composition,
    output: File,
    promise: Promise,
  ) {
    if (cancelled.remove(jobId)) {
      promise.reject(MediaCancelledException())
      return
    }
    output.parentFile?.mkdirs()
    output.delete()
    val holder = ProgressHolder()
    val poll = object : Runnable {
      override fun run() {
        if (!jobs.containsKey(jobId)) return
        if (transformer.getProgress(holder) == Transformer.PROGRESS_STATE_AVAILABLE) {
          sendProgress(jobId, holder.progress / 100.0)
        }
        main.postDelayed(this, 250)
      }
    }
    transformer.addListener(object : Transformer.Listener {
      override fun onCompleted(composition: Composition, exportResult: ExportResult) {
        jobs.remove(jobId)
        cancelled.remove(jobId)
        if (pending.remove(jobId) == null) return
        sendProgress(jobId, 1.0)
        thread {
          try {
            promise.resolve(result(output))
          } catch (e: Exception) {
            promise.reject(MediaFailedException(e.message))
          }
        }
      }

      override fun onError(
        composition: Composition,
        exportResult: ExportResult,
        exportException: ExportException,
      ) {
        jobs.remove(jobId)
        output.delete()
        if (pending.remove(jobId) == null) return
        if (cancelled.remove(jobId)) {
          promise.reject(MediaCancelledException())
          return
        }
        promise.reject(
          when (exportException.errorCode) {
            ExportException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED,
            ExportException.ERROR_CODE_IO_FILE_NOT_FOUND,
            ExportException.ERROR_CODE_IO_NO_PERMISSION -> MediaUnsupportedException(exportException.message)
            else -> MediaFailedException(exportException.errorCodeName)
          }
        )
      }
    })
    jobs[jobId] = transformer
    pending[jobId] = promise to output
    try {
      transformer.start(composition, output.absolutePath)
    } catch (e: Exception) {
      jobs.remove(jobId)
      pending.remove(jobId)
      promise.reject(MediaFailedException(e.message))
      return
    }
    main.post(poll)
  }

  private fun sendProgress(jobId: String, value: Double) {
    sendEvent("progress", mapOf("jobId" to jobId, "progress" to value.coerceIn(0.0, 1.0)))
  }

  private fun mixVideoAudio(jobId: String, uri: String, music: String, output: String, options: Map<String, Any?>, promise: Promise) {
    try {
      val originalVolume = (options["originalVolume"] as? Number)?.toFloat() ?: 0f
      val videoDuration = (options["videoDurationMs"] as? Number)?.toLong() ?: 0L
      val musicDuration = (options["musicDurationMs"] as? Number)?.toLong() ?: 0L
      if (!originalVolume.isFinite() || originalVolume !in 0f..100f || videoDuration <= 0 || musicDuration <= 0) throw MediaUnsupportedException("invalid music settings")
      val baseOptions = options.toMutableMap()
      if (originalVolume == 0f) baseOptions["audio"] = "drop"
      val (transformer, base) = buildTranscode(Uri.parse(uri), baseOptions)
      val videoItem = base.sequences.first().editedMediaItems.first()
      val volume = ChannelMixingAudioProcessor()
      // Must have a matrix for 1-8 channels, otherwise 5.1 native audio will cause export to fail.
      for (channels in 1..8) volume.putChannelMixingMatrix(ChannelMixingMatrix.createForConstantGain(channels, channels).scaleBy(originalVolume / 100f))
      val editedVideo = videoItem.buildUpon().setEffects(Effects(listOf(volume), videoItem.effects.videoEffects)).build()
      val videoSequence = if (originalVolume == 0f) EditedMediaItemSequence.withVideoFrom(listOf(editedVideo))
        else EditedMediaItemSequence.withAudioAndVideoFrom(listOf(editedVideo))
      val musicItem = MediaItem.Builder().setUri(Uri.parse(music)).setClippingConfiguration(
        MediaItem.ClippingConfiguration.Builder().setEndPositionMs(min(videoDuration, musicDuration)).build()
      ).build()
      val editedMusic = EditedMediaItem.Builder(musicItem).setRemoveVideo(true).build()
      val musicSequence = EditedMediaItemSequence.withAudioFrom(listOf(editedMusic)).buildUpon()
        .setIsLooping(options["loop"] as? Boolean ?: true).build()
      val composition = Composition.Builder(videoSequence, musicSequence)
        .experimentalSetForceAudioTrack(true)
        .setHdrMode(Composition.HDR_MODE_TONE_MAP_HDR_TO_SDR_USING_OPEN_GL).build()
      run(jobId, transformer, composition, File(Uri.parse(output).path!!), promise)
    } catch (e: CodedException) { promise.reject(e) }
    catch (e: Exception) { promise.reject(MediaFailedException(e.message)) }
  }

  @Suppress("UNCHECKED_CAST")
  private fun buildTranscode(uri: Uri, options: Map<String, Any?>, uris: List<Uri> = listOf(uri)): Pair<Transformer, Composition> {
    val container = options["container"] as? String ?: "mp4"
    val video = options["video"] as? Map<String, Any?>
    if (container != "mp4" || video == null) throw NotImplementedException("transcode to $container")
    val audio = options["audio"] as? Map<String, Any?>
    val dropAudio = options["audio"] == "drop"
    if (audio == null && !dropAudio) throw NotImplementedException("audio settings")
    if (audio != null && (audio["codec"] as? String ?: "aac") != "aac") {
      throw NotImplementedException("audio codec ${audio["codec"]}")
    }

    val items = uris.map { inputUri ->
      val itemBuilder = MediaItem.Builder().setUri(inputUri)
      (options["range"] as? Map<String, Any?>)?.let { range ->
        val start = (range["startMs"] as Number).toLong()
        val end = (range["endMs"] as Number).toLong()
        itemBuilder.setClippingConfiguration(
          MediaItem.ClippingConfiguration.Builder().setStartPositionMs(start).setEndPositionMs(end).build()
        )
      }

      val effects = mutableListOf<androidx.media3.common.Effect>()
      val audioProcessors = mutableListOf<AudioProcessor>()
      (video["speed"] as? Number)?.toFloat()?.let { speed ->
        if (!speed.isFinite() || speed !in 0.5f..4f) throw MediaUnsupportedException("invalid speed")
        effects.add(SpeedChangeEffect(speed))
        audioProcessors.add(SonicAudioProcessor().apply { setSpeed(speed); setPitch(speed) })
      }
      // JS provides maxShortSide only when downscaling is required (no upscale); H.264 requires even dimensions.
      (video["maxShortSide"] as? Number)?.toInt()?.let { shortSide ->
        effects.add(Presentation.createForShortSide(shortSide / 2 * 2))
      }
      (video["maxFps"] as? Number)?.toFloat()?.let { fps ->
        effects.add(FrameDropEffect.createDefaultFrameDropEffect(fps))
      }

      (video["aspectRatio"] as? Number)?.toFloat()?.let { ratio ->
        if (!ratio.isFinite() || ratio <= 0f) throw MediaUnsupportedException("invalid aspect ratio")
        effects.add(Presentation.createForAspectRatio(ratio, Presentation.LAYOUT_SCALE_TO_FIT_WITH_CROP))
      }
      (video["rotationDegrees"] as? Number)?.toFloat()?.let { degrees ->
        // Media3 uses positive numbers for counterclockwise, whereas the UI angle is clockwise.
        effects.add(ScaleAndRotateTransformation.Builder().setRotationDegrees(-degrees).build())
      }
      val width = (video["width"] as? Number)?.toInt()
      val height = (video["height"] as? Number)?.toInt()
      if (width != null && height != null) {
        if (width <= 0 || height <= 0 || width % 2 != 0 || height % 2 != 0) throw MediaUnsupportedException("invalid output dimensions")
        effects.add(Presentation.createForWidthAndHeight(width, height, Presentation.LAYOUT_SCALE_TO_FIT))
      }
      EditedMediaItem.Builder(itemBuilder.build())
        .setRemoveAudio(dropAudio)
        .setEffects(Effects(audioProcessors, effects))
        .build()
    }
    val composition = Composition.Builder(
      if (dropAudio) EditedMediaItemSequence.withVideoFrom(items)
      else EditedMediaItemSequence.withAudioAndVideoFrom(items)
    )
      // .experimentalSetForceAudioTrack(!dropAudio && uris.size > 1)
      .experimentalSetForceAudioTrack(!dropAudio && uris.size > 1)
      // Standard video (BT.709): HDR video is converted here, otherwise it will appear grey or underexposed when sent elsewhere.
      .setHdrMode(Composition.HDR_MODE_TONE_MAP_HDR_TO_SDR_USING_OPEN_GL)
      .build()

    val encoders = DefaultEncoderFactory.Builder(context)
      .setEnableFallback(true)
    (video["bitrateKbps"] as? Number)?.let { kbps ->
      encoders.setRequestedVideoEncoderSettings(
        VideoEncoderSettings.Builder().setBitrate((kbps.toDouble() * 1000).roundToInt()).build()
      )
    }
    (audio?.get("bitrateKbps") as? Number)?.let { kbps ->
      encoders.setRequestedAudioEncoderSettings(
        AudioEncoderSettings.Builder().setBitrate((kbps.toDouble() * 1000).roundToInt()).build()
      )
    }
    val transformer = Transformer.Builder(context)
      .setVideoMimeType(MimeTypes.VIDEO_H264)
      .setAudioMimeType(MimeTypes.AUDIO_AAC)
      .setEncoderFactory(encoders.build())
      .build()
    return transformer to composition
  }

  // ---- Audio ----

  /** Removes video, standardizes channels and sample rates (formats must match when concatenating segments; low-bitrate AAC requires mono and low sample rate). */
  private fun audioItem(item: MediaItem, audio: Map<String, Any?>): EditedMediaItem {
    val processors = mutableListOf<AudioProcessor>()
    (audio["channels"] as? Number)?.toInt()?.let { channels ->
      val mix = ChannelMixingAudioProcessor()
      // Media3 only has default mixing between mono and stereo (throws an exception for 3+ channels).
      for (input in 1..2) mix.putChannelMixingMatrix(ChannelMixingMatrix.createForConstantGain(input, channels))
      processors += mix
    }
    (audio["sampleRate"] as? Number)?.toInt()?.let { rate ->
      processors += SonicAudioProcessor().apply { setOutputSampleRateHz(rate) }
    }
    return EditedMediaItem.Builder(item)
      .setRemoveVideo(true)
      .setEffects(Effects(processors, listOf()))
      .build()
  }

  private fun aacTransformer(audio: Map<String, Any?>): Transformer {
    val encoders = DefaultEncoderFactory.Builder(context).setEnableFallback(true)
    (audio["bitrateKbps"] as? Number)?.let { kbps ->
      encoders.setRequestedAudioEncoderSettings(
        AudioEncoderSettings.Builder().setBitrate((kbps.toDouble() * 1000).roundToInt()).build()
      )
    }
    return Transformer.Builder(context)
      .setAudioMimeType(MimeTypes.AUDIO_AAC)
      .setEncoderFactory(encoders.build())
      // Default InAppMp4Muxer reserves about 400 KB for the index in the file header: two voice
      // memos synthesized into a 250 KB audio result in a 650 KB file, and compressing to 2 MB
      // always exceeds the threshold on the first try. System MediaMuxer does not reserve this.
      .setMuxerFactory(FrameworkMuxer.Factory())
      .build()
  }

  /** Audio only: M4A uses Media3 (AAC, writing MP4 container), while WAV and MP3 (D-183, LAME) are decoded and written manually. */
  @Suppress("UNCHECKED_CAST")
  private fun transcodeAudio(jobId: String, uri: Uri, output: File, options: Map<String, Any?>, promise: Promise) {
    val container = options["container"] as? String ?: "m4a"
    val audio = options["audio"] as? Map<String, Any?> ?: emptyMap()
    val range = options["range"] as? Map<String, Any?>
    val startMs = (range?.get("startMs") as? Number)?.toLong()
    val endMs = (range?.get("endMs") as? Number)?.toLong()
    when (container) {
      "m4a" -> main.post {
        try {
          val builder = MediaItem.Builder().setUri(uri)
          if (startMs != null && endMs != null) {
            builder.setClippingConfiguration(
              MediaItem.ClippingConfiguration.Builder().setStartPositionMs(startMs).setEndPositionMs(endMs).build()
            )
          }
          val composition = Composition.Builder(
            EditedMediaItemSequence.withAudioFrom(listOf(audioItem(builder.build(), audio)))
          ).build()
          run(jobId, aacTransformer(audio), composition, output, promise)
        } catch (e: CodedException) {
          promise.reject(e)
        } catch (e: Exception) {
          promise.reject(MediaFailedException(e.message))
        }
      }
      "wav", "mp3" -> {
        val flag = AtomicBoolean(false)
        threadJobs[jobId] = flag
        thread {
          var mp3: Mp3Writer? = null
          try {
            output.parentFile?.mkdirs()
            output.delete()
            val wav = if (container == "wav") AudioPcm.WavWriter(output) else null
            mp3 = if (container == "mp3") Mp3Writer(output, (audio["bitrateKbps"] as? Number)?.toInt() ?: 192) else null
            val wanted = (audio["channels"] as? Number)?.toInt()
            val startUs = (startMs ?: 0L) * 1000
            val endUs = endMs?.let { it * 1000 } ?: Long.MAX_VALUE
            val durationUs = (((probe(uri)["durationMs"] as? Double) ?: 0.0) * 1000).toLong()
            AudioPcm.decode(context, uri, startUs, endUs, { flag.get() }) { chunk ->
              val channels = wanted ?: min(2, chunk.channels)
              val samples = AudioPcm.remix(chunk, channels)
              wav?.write(samples, channels, chunk.sampleRate)
              mp3?.write(samples, channels, chunk.sampleRate)
              val span = (if (endUs == Long.MAX_VALUE) durationUs else endUs) - startUs
              if (span > 0) sendProgress(jobId, (chunk.ptsUs - startUs).toDouble() / span)
            }
            if (flag.get()) {
              mp3?.abort()
              output.delete()
              promise.reject(MediaCancelledException())
              return@thread
            }
            wav?.close()
            mp3?.close()
            sendProgress(jobId, 1.0)
            promise.resolve(result(output))
          } catch (e: CodedException) {
            mp3?.abort()
            output.delete()
            promise.reject(e)
          } catch (e: Exception) {
            mp3?.abort()
            output.delete()
            promise.reject(MediaFailedException(e.message))
          } finally {
            threadJobs.remove(jobId)
          }
        }
      }
      else -> promise.reject(NotImplementedException("audio to $container"))
    }
  }

  /** Checks whether any hardware or software encoder can encode this format at this size (trying both landscape and portrait). */
  private fun canEncode(mime: String, width: Int, height: Int): Boolean {
    if (width <= 0 || height <= 0) return true
    return MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos.any { info ->
      info.isEncoder && info.supportedTypes.any { it.equals(mime, ignoreCase = true) } &&
        runCatching {
          val video = info.getCapabilitiesForType(mime).videoCapabilities
          video != null &&
            (video.isSizeSupported(width, height) || video.isSizeSupported(height, width))
        }.getOrDefault(false)
    }
  }

  // ---- probe ----

  private fun probe(uri: Uri): Map<String, Any?> {
    val info = mutableMapOf<String, Any?>()
    var hasVideo = false
    var hasAudio = false
    val extractor = MediaExtractor()
    try {
      extractor.setDataSource(context, uri, null)
      for (i in 0 until extractor.trackCount) {
        val format = extractor.getTrackFormat(i)
        val mime = format.getString(MediaFormat.KEY_MIME) ?: continue
        if (mime.startsWith("video/") && !hasVideo) {
          hasVideo = true
          info["videoCodec"] = mime.removePrefix("video/")
          if (format.containsKey(MediaFormat.KEY_FRAME_RATE)) {
            info["fps"] = format.getNumber(MediaFormat.KEY_FRAME_RATE)?.toDouble()
          }
          if (format.containsKey(MediaFormat.KEY_BIT_RATE)) {
            info["videoBitrateKbps"] = format.getInteger(MediaFormat.KEY_BIT_RATE) / 1000.0
          }
          if (format.containsKey(MediaFormat.KEY_COLOR_TRANSFER)) {
            val transfer = format.getInteger(MediaFormat.KEY_COLOR_TRANSFER)
            info["hdr"] = transfer == MediaFormat.COLOR_TRANSFER_ST2084 ||
              transfer == MediaFormat.COLOR_TRANSFER_HLG
          } else {
            info["hdr"] = false
          }
        } else if (mime.startsWith("audio/") && !hasAudio) {
          hasAudio = true
          info["audioCodec"] = mime.removePrefix("audio/")
          if (format.containsKey(MediaFormat.KEY_BIT_RATE)) {
            info["audioBitrateKbps"] = format.getInteger(MediaFormat.KEY_BIT_RATE) / 1000.0
          }
          if (format.containsKey(MediaFormat.KEY_SAMPLE_RATE)) {
            info["sampleRate"] = format.getInteger(MediaFormat.KEY_SAMPLE_RATE).toDouble()
          }
          if (format.containsKey(MediaFormat.KEY_CHANNEL_COUNT)) {
            info["channels"] = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
          }
        }
      }
    } catch (e: Exception) {
      throw MediaUnsupportedException(e.message)
    } finally {
      extractor.release()
    }
    if (!hasVideo && !hasAudio) throw MediaUnsupportedException("no tracks")

    val retriever = MediaMetadataRetriever()
    try {
      retriever.setDataSource(context, uri)
      val duration = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toDoubleOrNull() ?: 0.0
      info["durationMs"] = duration
      if (hasVideo) {
        val w = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 0
        val h = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 0
        val rotation = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0
        val turned = rotation == 90 || rotation == 270
        info["width"] = if (turned) h else w
        info["height"] = if (turned) w else h
        info["rotation"] = rotation
        if (info["videoBitrateKbps"] == null) {
          // If video bitrate cannot be read, use the file bitrate minus the audio bitrate.
          val total = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_BITRATE)?.toDoubleOrNull()
          if (total != null) {
            val audioKbps = (info["audioBitrateKbps"] as? Double) ?: 0.0
            info["videoBitrateKbps"] = max(0.0, total / 1000 - audioKbps)
          }
        }
        if (info["fps"] == null && Build.VERSION.SDK_INT >= 28) {
          val frames = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_FRAME_COUNT)?.toDoubleOrNull()
          if (frames != null && duration > 0) info["fps"] = frames / (duration / 1000)
        }
      }
    } catch (e: Exception) {
      throw MediaUnsupportedException(e.message)
    } finally {
      retriever.release()
    }
    info["kind"] = if (hasVideo) "video" else "audio"
    info["hasVideo"] = hasVideo
    info["hasAudio"] = hasAudio
    info["size"] = sizeOf(uri)
    return info
  }

  private fun sizeOf(uri: Uri): Long {
    if (uri.scheme == "file" || uri.scheme == null) return File(uri.path!!).length()
    context.contentResolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { c ->
      if (c.moveToFirst() && !c.isNull(0)) return c.getLong(0)
    }
    return context.contentResolver.openAssetFileDescriptor(uri, "r")?.use { it.length } ?: 0
  }

  private fun result(output: File): Map<String, Any?> {
    val uri = Uri.fromFile(output)
    return mapOf("uri" to uri.toString(), "size" to output.length(), "info" to probe(uri))
  }

  // ---- GIF（D-184）----

  private fun gifJob(
    jobId: String,
    output: File,
    promise: Promise,
    work: (AtomicBoolean, File) -> Map<String, Any?>,
  ) {
    val flag = AtomicBoolean(false)
    threadJobs[jobId] = flag
    thread {
      try {
        output.parentFile?.mkdirs()
        output.delete()
        val result = work(flag, output)
        if (flag.get()) {
          output.delete()
          promise.reject(MediaCancelledException())
        } else {
          sendProgress(jobId, 1.0)
          promise.resolve(result)
        }
      } catch (e: CodedException) {
        output.delete()
        promise.reject(e)
      } catch (e: OutOfMemoryError) {
        output.delete()
        promise.reject(MediaFailedException("out of memory"))
      } catch (e: Exception) {
        output.delete()
        promise.reject(MediaFailedException(e.message))
      } finally {
        threadJobs.remove(jobId)
      }
    }
  }

  private fun pixelsOf(bitmap: Bitmap): IntArray {
    val pixels = IntArray(bitmap.width * bitmap.height)
    bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
    return pixels
  }

  /** Video -> GIF: Extract frames at given fps from start to end (oriented correctly, width not exceeding width); length is checked beforehand by the caller. */
  private fun videoGif(
    jobId: String, uri: Uri, output: File, options: Map<String, Double>, flag: AtomicBoolean,
  ): Map<String, Any?> {
    val maxWidth = (options["width"] ?: 480.0).roundToInt()
    val fps = max(1.0, options["fps"] ?: 12.0)
    val retriever = MediaMetadataRetriever()
    try {
      retriever.setDataSource(context, uri)
      val durationMs = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull()
        ?: throw MediaUnsupportedException("duration")
      val count = max(1, (durationMs / 1000.0 * fps).toInt())
      val delayMs = (1000 / fps).roundToInt()
      var encoder: GifEncoder? = null
      var width = 0
      var height = 0
      FileOutputStream(output).buffered().use { out ->
        for (i in 0 until count) {
          if (flag.get()) return emptyMap()
          val us = (i * 1_000_000L / fps).toLong()
          val frame = (if (Build.VERSION.SDK_INT >= 27) {
            retriever.getScaledFrameAtTime(us, MediaMetadataRetriever.OPTION_CLOSEST, maxWidth, maxWidth * 20)
          } else {
            retriever.getFrameAtTime(us, MediaMetadataRetriever.OPTION_CLOSEST)
          }) ?: if (i == 0) throw MediaUnsupportedException("frame") else continue
          if (encoder == null) {
            // Canvas is determined by the first frame (vertical videos are scaled by width).
            val k = min(1.0, maxWidth.toDouble() / frame.width)
            width = max(1, (frame.width * k).roundToInt())
            height = max(1, (frame.height * k).roundToInt())
            encoder = GifEncoder(out, width, height)
          }
          val fitted = if (frame.width == width && frame.height == height) frame
          else Bitmap.createScaledBitmap(frame, width, height, true).also { frame.recycle() }
          encoder.addFrame(pixelsOf(fitted), delayMs)
          fitted.recycle()
          sendProgress(jobId, (i + 1).toDouble() / count * 0.95)
        }
        encoder?.finish() ?: throw MediaUnsupportedException("no frames")
      }
      return mapOf(
        "uri" to Uri.fromFile(output).toString(), "size" to output.length(),
        "width" to width, "height" to height, "frames" to count,
      )
    } finally {
      retriever.release()
    }
  }

  /** Read an image: Scale long side to around maxSide (first downsample by powers of 2 then precise scale), orient correctly using EXIF. */
  private fun loadImage(uri: Uri, maxSide: Int): Bitmap {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    context.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
    if (bounds.outWidth <= 0) throw MediaUnsupportedException(uri.lastPathSegment)
    var sample = 1
    while (max(bounds.outWidth, bounds.outHeight) / (sample * 2) >= maxSide) sample *= 2
    val bitmap = context.contentResolver.openInputStream(uri)?.use {
      BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sample })
    } ?: throw MediaUnsupportedException(uri.lastPathSegment)
    val orientation = runCatching {
      context.contentResolver.openInputStream(uri)?.use {
        ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
      }
    }.getOrNull() ?: ExifInterface.ORIENTATION_NORMAL
    val matrix = Matrix()
    when (orientation) {
      ExifInterface.ORIENTATION_ROTATE_90 -> matrix.postRotate(90f)
      ExifInterface.ORIENTATION_ROTATE_180 -> matrix.postRotate(180f)
      ExifInterface.ORIENTATION_ROTATE_270 -> matrix.postRotate(270f)
      ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.postScale(-1f, 1f)
      ExifInterface.ORIENTATION_FLIP_VERTICAL -> matrix.postScale(1f, -1f)
    }
    val k = min(1f, maxSide.toFloat() / max(bitmap.width, bitmap.height))
    matrix.postScale(k, k)
    if (matrix.isIdentity) return bitmap
    val out = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
    if (out !== bitmap) bitmap.recycle()
    return out
  }

  /** Images -> GIF: Canvas is the first image (long side scaled to maxSide), each image is centered and scaled proportionally within the canvas, with empty areas filled with white. */
  private fun imagesGif(
    jobId: String, uris: List<Uri>, output: File, options: Map<String, Double>, flag: AtomicBoolean,
  ): Map<String, Any?> {
    val maxSide = (options["maxSide"] ?: 480.0).roundToInt()
    val delayMs = (options["delayMs"] ?: 500.0).roundToInt()
    if (uris.isEmpty()) throw MediaFailedException("no images")
    val first = loadImage(uris[0], maxSide)
    val width = first.width
    val height = first.height
    val canvasBitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(canvasBitmap)
    val paint = Paint(Paint.FILTER_BITMAP_FLAG)
    FileOutputStream(output).buffered().use { out ->
      val encoder = GifEncoder(out, width, height)
      for ((i, uri) in uris.withIndex()) {
        if (flag.get()) return emptyMap()
        val image = if (i == 0) first else loadImage(uri, maxSide)
        val k = min(width.toFloat() / image.width, height.toFloat() / image.height)
        val w = image.width * k
        val h = image.height * k
        canvas.drawColor(Color.WHITE)
        canvas.drawBitmap(image, null, RectF((width - w) / 2, (height - h) / 2, (width + w) / 2, (height + h) / 2), paint)
        image.recycle()
        encoder.addFrame(pixelsOf(canvasBitmap), delayMs)
        sendProgress(jobId, (i + 1).toDouble() / uris.size * 0.95)
      }
      encoder.finish()
    }
    canvasBitmap.recycle()
    return mapOf(
      "uri" to Uri.fromFile(output).toString(), "size" to output.length(),
      "width" to width, "height" to height, "frames" to uris.size,
    )
  }

  // ---- thumbnails ----

  private fun thumbnails(uri: Uri, timesMs: List<Double>, maxSide: Int, directory: File, precise: Boolean = false): List<String> {
    directory.mkdirs()
    val retriever = MediaMetadataRetriever()
    try {
      retriever.setDataSource(context, uri)
      return timesMs.map { ms ->
        val us = (ms * 1000).toLong()
        val frame = (if (precise) {
          retriever.getFrameAtTime(us, MediaMetadataRetriever.OPTION_CLOSEST)
        } else if (Build.VERSION.SDK_INT >= 27) {
          retriever.getScaledFrameAtTime(us, MediaMetadataRetriever.OPTION_CLOSEST_SYNC, maxSide, maxSide)
        } else {
          retriever.getFrameAtTime(us, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)?.let { scaled(it, maxSide) }
        }) ?: throw MediaUnsupportedException("frame at $ms")
        val file = File(directory, "${UUID.randomUUID()}.jpg")
        FileOutputStream(file).use { frame.compress(Bitmap.CompressFormat.JPEG, if (precise) 95 else 70, it) }
        frame.recycle()
        Uri.fromFile(file).toString()
      }
    } finally {
      retriever.release()
    }
  }

  private fun scaled(bitmap: Bitmap, maxSide: Int): Bitmap {
    val k = min(1.0, maxSide.toDouble() / max(bitmap.width, bitmap.height))
    if (k >= 1.0) return bitmap
    val out = Bitmap.createScaledBitmap(
      bitmap, max(1, (bitmap.width * k).roundToInt()), max(1, (bitmap.height * k).roundToInt()), true
    )
    bitmap.recycle()
    return out
  }
}

/** Delete file upon completion (success or failure) before returning the result: used for volume and denoising intermediate WAVs. */
private fun Promise.deletingAfter(file: File): Promise {
  val inner = this
  return object : Promise {
    override fun resolve(value: Any?) {
      file.delete()
      inner.resolve(value)
    }
    override fun reject(code: String?, message: String?, cause: Throwable?) {
      file.delete()
      inner.reject(code, message, cause)
    }
  }
}
