package expo.modules.morphspeech

import android.content.Context
import android.net.Uri
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.io.File
import java.io.FileInputStream
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

// Android implementation of speech-to-text (D-151): when the system cannot recognize an audio file,
// it uses the bundled whisper.cpp on the device for local recognition, with models coming from
// downloads (JS passes the model file path). Same JS interface as iOS. Recognized text is returned
// only to the app and is not logged.

class SpeechException(code: String, message: String) : CodedException(code, message, null)

class TranscribeOptions : Record {
  @Field val taskId: String = ""
  @Field val language: String = ""
  @Field val model: String? = null
  @Field val vad: String? = null
  @Field val prompt: String? = null
  @Field val timed: Boolean = false
}

/** Maximum length of audio fed to whisper at once is 5 minutes (approx. 19 MB), cut at the quietest point in the final 20 seconds. */
private const val CHUNK_SAMPLES = 300 * WHISPER_RATE
private const val SEARCH_SAMPLES = 20 * WHISPER_RATE
private const val QUIET_WINDOW = WHISPER_RATE * 3 / 10

class MorphSpeechModule : Module() {
  private val context: Context
    get() = requireNotNull(appContext.reactContext) { "React Application Context is null" }

  private val cancelled = ConcurrentHashMap<String, AtomicBoolean>()
  private val handles = ConcurrentHashMap<String, Long>()

  override fun definition() = ModuleDefinition {
    Name("MorphSpeech")

    Events("onProgress")

    Constant("engine") { "whisper" }

    AsyncFunction("supportedLanguages") { WhisperNative.languages().toList() }

    // Models are managed via downloads: all languages recognized by whisper count as 'already available'.
    AsyncFunction("languageStatus") { language: String ->
      if (WhisperNative.languages().contains(language)) "installed" else "unsupported"
    }

    AsyncFunction("prepareLanguage") { _: String, _: String -> }

    AsyncFunction("transcribe") { uri: String, options: TranscribeOptions, promise: Promise ->
      val flag = AtomicBoolean(false)
      cancelled[options.taskId] = flag
      thread(name = "morph-speech") {
        try {
          promise.resolve(transcribe(uri, options, flag))
        } catch (e: CodedException) {
          promise.reject(e)
        } catch (e: UnreadableAudio) {
          promise.reject(SpeechException("ERR_SPEECH_UNREADABLE_AUDIO", "Could not read the audio: ${e.message}"))
        } catch (e: Throwable) {
          promise.reject(SpeechException("ERR_SPEECH_FAILED", e.message ?: e.toString()))
        } finally {
          cancelled.remove(options.taskId)
        }
      }
    }

    Function("cancel") { taskId: String ->
      cancelled[taskId]?.set(true)
      handles[taskId]?.let { WhisperNative.cancel(it) }
    }

    // Computes SHA-256 while reading, 1 MB at a time.
    AsyncFunction("sha256File") { uri: String, promise: Promise ->
      thread(name = "morph-sha256") {
        try {
          val digest = MessageDigest.getInstance("SHA-256")
          FileInputStream(fileOf(uri)).use { input ->
            val chunk = ByteArray(1 shl 20)
            while (true) {
              val n = input.read(chunk)
              if (n < 0) break
              digest.update(chunk, 0, n)
            }
          }
          promise.resolve(digest.digest().joinToString("") { "%02x".format(it) })
        } catch (e: Throwable) {
          promise.reject(SpeechException("ERR_SPEECH_FAILED", e.message ?: e.toString()))
        }
      }
    }
  }

  private fun fileOf(uri: String): File = if (uri.startsWith("file://")) File(Uri.parse(uri).path!!) else File(uri)

  private fun transcribe(uri: String, options: TranscribeOptions, flag: AtomicBoolean): Map<String, Any> {
    val modelPath = options.model?.let { fileOf(it).path }
      ?: throw SpeechException("ERR_SPEECH_MODEL", "No speech model")
    if (!WhisperNative.languages().contains(options.language)) {
      throw SpeechException("ERR_SPEECH_UNSUPPORTED_LANGUAGE", "Speech recognition does not support ${options.language}")
    }
    val handle = WhisperNative.init(modelPath, options.vad?.let { fileOf(it).path })
    if (handle == 0L) throw SpeechException("ERR_SPEECH_MODEL", "Could not load the speech model")
    handles[options.taskId] = handle
    try {
      val decoder = AudioDecoder(context, Uri.parse(uri))
      val pending = FloatBuffer()
      val segments = mutableListOf<Map<String, Any>>()
      /** Number of audio samples already transcribed (next segment's time starts from here). */
      var offset = 0L
      val threads = Runtime.getRuntime().availableProcessors().coerceIn(1, 4)

      fun emit(fraction: Double) {
        sendEvent("onProgress", mapOf("taskId" to options.taskId, "fraction" to fraction.coerceIn(0.0, 1.0)))
      }

      fun run(count: Int) {
        if (flag.get()) throw cancelledError()
        val total = (decoder.durationUs * WHISPER_RATE / 1_000_000).coerceAtLeast(offset + count)
        // Whisper's progress callback runs on its own thread: here we check every half second and convert it to overall file progress.
        val done = AtomicBoolean(false)
        val ticker = thread(name = "morph-speech-progress") {
          while (!done.get()) {
            emit((offset + count * WhisperNative.progress(handle) / 100.0) / total)
            try {
              Thread.sleep(500)
            } catch (_: InterruptedException) {
              break
            }
          }
        }
        val n = WhisperNative.transcribe(
          handle, pending.data, count, options.language, options.prompt, threads)
        done.set(true)
        ticker.interrupt()
        if (n == -1 || flag.get()) throw cancelledError()
        if (n < 0) throw SpeechException("ERR_SPEECH_FAILED", "whisper failed")
        val baseMs = offset * 1000 / WHISPER_RATE
        for (i in 0 until n) {
          val text = String(WhisperNative.segmentText(handle, i), Charsets.UTF_8)
          if (text.isBlank()) continue
          segments += mapOf(
            "startMs" to (baseMs + WhisperNative.segmentStart(handle, i)).toDouble(),
            "endMs" to (baseMs + WhisperNative.segmentEnd(handle, i)).toDouble(),
            "text" to text,
          )
        }
        offset += count
        pending.dropFirst(count)
        emit(offset.toDouble() / total)
      }

      decoder.decode({ flag.get() }) { values, count ->
        pending.append(values, count)
        if (pending.size >= CHUNK_SAMPLES + SEARCH_SAMPLES) {
          run(quietestPoint(pending.data, CHUNK_SAMPLES, CHUNK_SAMPLES + SEARCH_SAMPLES, QUIET_WINDOW))
        }
      }
      if (flag.get()) throw cancelledError()
      // Tails shorter than 0.1 seconds are not transcribed.
      if (pending.size > WHISPER_RATE / 10) run(pending.size)
      val durationMs = maxOf(decoder.durationUs / 1000, (offset + pending.size) * 1000 / WHISPER_RATE)
      if (durationMs <= 0) throw UnreadableAudio("empty")
      return mapOf("segments" to segments, "durationMs" to durationMs.toDouble())
    } finally {
      handles.remove(options.taskId)
      WhisperNative.free(handle)
    }
  }

  private fun cancelledError() = SpeechException("ERR_SPEECH_CANCELLED", "Cancelled")
}
