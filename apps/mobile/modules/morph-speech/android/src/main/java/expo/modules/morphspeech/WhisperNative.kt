package expo.modules.morphspeech

// JNI interface for whisper.cpp (src/main/cpp/morph_whisper.cpp). handle is the native session pointer and must be freed when done.

object WhisperNative {
  init {
    System.loadLibrary("morphwhisper")
  }

  /** CPU backend used by this phone (e.g. libggml-cpu-android_armv8.2_2.so), recorded for empirical logs. */
  external fun backend(): String

  external fun languages(): Array<String>

  /** Loads the model; returns 0 on failure. */
  external fun init(modelPath: String, vadPath: String?): Long

  external fun free(handle: Long)

  /** Causes ongoing transcription to return -1 as soon as possible. */
  external fun cancel(handle: Long)

  /** Progress of the current segment, 0-100. */
  external fun progress(handle: Long): Int

  /** Transcribes a 16 kHz mono audio segment. Returns the number of segments; returns -1 on cancellation, or -2 on failure. */
  external fun transcribe(
    handle: Long,
    samples: FloatArray,
    count: Int,
    language: String,
    prompt: String?,
    threads: Int,
  ): Int

  external fun segmentText(handle: Long, index: Int): ByteArray

  external fun segmentStart(handle: Long, index: Int): Long

  external fun segmentEnd(handle: Long, index: Int): Long
}
