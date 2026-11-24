package expo.modules.morphtts

import android.content.Context
import android.net.Uri
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.io.File
import java.util.Locale
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import kotlin.concurrent.thread

// Android implementation of Text-to-Speech (D-270): System TextToSpeech (Google Voice Services on
// most phones), sharing the same JS interface as iOS. Writes each segment to a WAV file via
// synthesizeToFile (intermediate files placed alongside the output file), joins them via Wav.join
// after reading all segments, and deletes intermediate files on success, failure, or cancellation.
// Missing audio data is not downloaded automatically; throws ERR_TTS_NOT_DOWNLOADED for the user to
// download in system settings. Text is passed exclusively to the system TTS engine and is never
// logged.

class TTSException(code: String, message: String) : CodedException(code, message, null)

private fun noVoice(voice: String) = TTSException("ERR_TTS_NO_VOICE", "No voice for $voice")
private fun notDownloaded(voice: String) =
  TTSException("ERR_TTS_NOT_DOWNLOADED", "The voice data for $voice is not installed")
private fun unavailable() = TTSException("ERR_TTS_UNAVAILABLE", "No text-to-speech engine")
private fun cancelled() = TTSException("ERR_TTS_CANCELLED", "Cancelled")
private fun failed(detail: String) = TTSException("ERR_TTS_FAILED", detail)

class SynthesizeOptions : Record {
  @Field val taskId: String = ""
  @Field val voice: String = ""
  @Field val rate: Double = 1.0
  @Field val output: String = ""
}

/** Maximum wait time for connecting to the TTS engine: initialization callback may never arrive if no engine exists or if the engine is disabled. */
private const val INIT_TIMEOUT_SECONDS = 15L

/** Maximum wait time per segment: engines are typically much faster than real-time; prevents promises from hanging indefinitely when stalled (e.g., engine crash). */
private fun segmentTimeoutSeconds(text: String) = 60L + text.length / 2

/** A TTS job: stops the engine upon cancellation and terminates the currently waiting segment. */
private class TTSJob {
  @Volatile var cancelled = false
  @Volatile var engine: TextToSpeech? = null
  val waiting = ConcurrentHashMap<String, CompletableFuture<Unit>>()

  fun cancel() {
    cancelled = true
    engine?.stop()
    waiting.values.forEach { it.completeExceptionally(InterruptedException("cancelled")) }
  }
}

class MorphTTSModule : Module() {
  private val context: Context
    get() = requireNotNull(appContext.reactContext) { "React Application Context is null" }

  private val jobs = ConcurrentHashMap<String, TTSJob>()

  override fun definition() = ModuleDefinition {
    Name("MorphTTS")

    Events("onProgress")

    AsyncFunction("voiceStatus") { voice: String, promise: Promise ->
      thread(name = "morph-tts-status") {
        val engine = try {
          openEngine()
        } catch (e: Throwable) {
          // No engine, engine disabled, or system error during binding: all treated as having no TTS engine; ensures the Promise always terminates.
          promise.resolve("noEngine")
          return@thread
        }
        try {
          promise.resolve(
            when (engine.isLanguageAvailable(Locale.forLanguageTag(voice))) {
              TextToSpeech.LANG_MISSING_DATA -> "notDownloaded"
              TextToSpeech.LANG_NOT_SUPPORTED -> "unsupported"
              TextToSpeech.LANG_AVAILABLE,
              TextToSpeech.LANG_COUNTRY_AVAILABLE,
              TextToSpeech.LANG_COUNTRY_VAR_AVAILABLE -> "installed"
              else -> "unsupported"
            }
          )
        } catch (e: Throwable) {
          promise.reject(failed(e.message ?: e.toString()))
        } finally {
          engine.shutdown()
        }
      }
    }

    AsyncFunction("synthesize") { segments: List<String>, options: SynthesizeOptions, promise: Promise ->
      // Register before starting the thread: JS cancellation polling might arrive before the thread starts.
      val job = TTSJob()
      jobs[options.taskId] = job
      thread(name = "morph-tts") {
        val output = fileOf(options.output)
        try {
          promise.resolve(synthesize(segments, options, output, job))
        } catch (e: Throwable) {
          output.delete()
          promise.reject(
            when {
              job.cancelled -> cancelled()
              e is CodedException -> e
              else -> failed(e.message ?: e.toString())
            }
          )
        } finally {
          jobs.remove(options.taskId)
        }
      }
    }

    Function("cancel") { taskId: String ->
      jobs[taskId]?.cancel()
    }
  }

  private fun fileOf(uri: String): File =
    if (uri.startsWith("file://")) File(Uri.parse(uri).path!!) else File(uri)

  /** Connect to the system TTS engine (waits for initialization callback on a background thread); throws ERR_TTS_UNAVAILABLE if connection fails. */
  private fun openEngine(): TextToSpeech {
    val ready = CompletableFuture<Int>()
    val engine = TextToSpeech(context) { status -> ready.complete(status) }
    val status = try {
      ready.get(INIT_TIMEOUT_SECONDS, TimeUnit.SECONDS)
    } catch (e: TimeoutException) {
      TextToSpeech.ERROR
    }
    if (status != TextToSpeech.SUCCESS) {
      engine.shutdown()
      throw unavailable()
    }
    return engine
  }

  private fun synthesize(
    segments: List<String>,
    options: SynthesizeOptions,
    output: File,
    job: TTSJob,
  ): Map<String, Any> {
    if (segments.isEmpty()) throw failed("nothing to read")
    val dir = output.parentFile ?: throw failed("no output folder")
    dir.mkdirs()
    val parts = mutableListOf<File>()
    val engine = openEngine()
    job.engine = engine
    try {
      if (job.cancelled) throw cancelled()
      when (engine.setLanguage(Locale.forLanguageTag(options.voice))) {
        TextToSpeech.LANG_MISSING_DATA -> throw notDownloaded(options.voice)
        TextToSpeech.LANG_NOT_SUPPORTED -> throw noVoice(options.voice)
      }
      engine.setSpeechRate(options.rate.toFloat().coerceIn(0.5f, 2f))
      engine.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
        override fun onStart(utteranceId: String) {}

        override fun onDone(utteranceId: String) {
          job.waiting.remove(utteranceId)?.complete(Unit)
        }

        @Deprecated("Deprecated in Java")
        override fun onError(utteranceId: String) {
          job.waiting.remove(utteranceId)?.completeExceptionally(failed("engine error"))
        }

        override fun onError(utteranceId: String, errorCode: Int) {
          job.waiting.remove(utteranceId)?.completeExceptionally(failed("engine error $errorCode"))
        }

        override fun onStop(utteranceId: String, interrupted: Boolean) {
          job.waiting.remove(utteranceId)?.completeExceptionally(InterruptedException("stopped"))
        }
      })

      segments.forEachIndexed { i, text ->
        if (job.cancelled) throw cancelled()
        val part = File(dir, ".tts-${options.taskId}-$i.wav")
        parts += part
        val id = "${options.taskId}-$i"
        val done = CompletableFuture<Unit>()
        job.waiting[id] = done
        if (engine.synthesizeToFile(text, Bundle(), part, id) != TextToSpeech.SUCCESS) {
          job.waiting.remove(id)
          throw failed("synthesizeToFile refused segment $i")
        }
        try {
          done.get(segmentTimeoutSeconds(text), TimeUnit.SECONDS)
        } catch (e: ExecutionException) {
          throw e.cause ?: e
        } catch (e: TimeoutException) {
          job.waiting.remove(id)
          throw failed("segment $i timed out")
        }
        if (job.cancelled) throw cancelled()
        sendEvent(
          "onProgress",
          mapOf("taskId" to options.taskId, "fraction" to (i + 1).toDouble() / segments.size),
        )
      }

      // Skip segments consisting solely of symbols or producing no audio, for which the engine might not write files.
      val written = parts.filter { it.exists() && it.length() > 0 }
      if (written.isEmpty()) throw failed("the engine wrote no audio")
      val info = Wav.join(written, output) { job.cancelled }
      return mapOf(
        "uri" to Uri.fromFile(output).toString(),
        "size" to output.length().toDouble(),
        "durationMs" to info.durationMs,
        "sampleRate" to info.sampleRate,
        "channels" to info.channels,
      )
    } finally {
      job.engine = null
      parts.forEach { it.delete() }
      engine.stop()
      engine.shutdown()
    }
  }
}
