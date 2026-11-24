package expo.modules.morphmedia

import android.content.Context
import android.net.Uri
import androidx.media3.common.C
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.SonicAudioProcessor
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.roundToInt
import kotlin.math.roundToLong

/** Streaming resample to 48kHz, channel-by-channel noise reduction, compensating for the 20ms delay of RNNoise. */
object AudioDenoise {
  fun prepare(context: Context, uri: Uri, output: File, cancelled: AtomicBoolean, durationMs: Double, progress: (Double) -> Unit) {
    var handle = 0L
    var rate = 0; var channels = 0
    var processor: SonicAudioProcessor? = null
    var input = FloatArray(0); var filtered = FloatArray(0)
    var filled = 0; var skip = 960; var written = 0L; var shown = -1
    val total = (durationMs * 48).roundToLong()
    val writer = AudioPcm.WavWriter(output)
    var complete = false
    fun process() {
      if (cancelled.get()) throw MediaCancelledException()
      if (AudioDsp.nativeDenoise(handle, input, filtered) != 0) throw MediaFailedException("denoise frame")
      val drop = minOf(480, skip); skip -= drop
      val count = minOf((480 - drop).toLong(), total - written).toInt()
      if (count > 0) {
        val samples = ShortArray(count * channels) { i -> (filtered[drop * channels + i] * 32768).roundToInt().coerceIn(-32768,32767).toShort() }
        writer.write(samples, channels, 48000); written += count
      }
      filled = 0
    }
    fun consume(buffer: ByteBuffer) {
      buffer.order(ByteOrder.nativeOrder())
      while (buffer.remaining() >= channels * 2) {
        for (c in 0 until channels) input[filled * channels + c] = buffer.short / 32768f
        filled++
        if (filled == 480) process()
      }
      if (total > 0) {
        // Noise reduction pass accounts for the first 50% of progress.
        val percent = (written * 50 / total).toInt().coerceIn(0, 50)
        if (percent > shown) { shown = percent; progress(percent / 100.0) }
      }
    }
    fun drain() { processor?.let { consume(it.output) } }
    try {
      AudioPcm.visitTimeline(context, uri, durationMs, { cancelled.get() }) { chunk ->
        // More than two channels (such as 5.1) are first mixed to stereo: even-numbered channels go to the left, odd-numbered to the right, each averaged; just like iOS, only two channels undergo noise reduction.
        val wide = chunk.channels > 2
        val samples = if (wide) downmix(chunk.samples, chunk.count, chunk.channels) else chunk.samples
        val count = if (wide) chunk.count / chunk.channels * 2 else chunk.count
        if (handle == 0L) {
          rate = chunk.sampleRate; channels = if (wide) 2 else chunk.channels
          if (channels !in 1..2) throw MediaUnsupportedException("no audio channels")
          handle = AudioDsp.nativeDenoiseCreate(channels)
          if (handle == 0L) throw MediaFailedException("denoiser")
          input = FloatArray(480 * channels); filtered = input.copyOf()
          if (rate != 48000) processor = SonicAudioProcessor().apply {
            setOutputSampleRateHz(48000)
            configure(AudioProcessor.AudioFormat(rate, channels, C.ENCODING_PCM_16BIT)); flush()
          }
        }
        val buffer = ByteBuffer.allocateDirect(count * 2).order(ByteOrder.nativeOrder())
        buffer.asShortBuffer().put(samples, 0, count)
        if (processor != null) { processor!!.queueInput(buffer); drain() } else consume(buffer)
      }
      if (handle == 0L) throw MediaUnsupportedException("no audio decoded")
      processor?.queueEndOfStream(); drain()
      if (filled > 0) { input.fill(0f, filled * channels); process() }
      input.fill(0f)
      // Pad remaining tail model latency, and up to one sample of rounding error from resampling.
      while (written < total) process()
      complete = true
      if (shown < 50) progress(0.5)
    } finally {
      if (complete) writer.close() else runCatching { writer.close() }
      processor?.reset()
      if (handle != 0L) AudioDsp.nativeDenoiseDestroy(handle)
    }
  }

  private fun downmix(samples: ShortArray, count: Int, channels: Int): ShortArray {
    val frames = count / channels
    val out = ShortArray(frames * 2)
    for (f in 0 until frames) {
      var left = 0; var right = 0; var nl = 0; var nr = 0
      for (c in 0 until channels) {
        val v = samples[f * channels + c].toInt()
        if (c % 2 == 0) { left += v; nl++ } else { right += v; nr++ }
      }
      out[f * 2] = (left / nl).toShort(); out[f * 2 + 1] = (right / nr).toShort()
    }
    return out
  }
}
