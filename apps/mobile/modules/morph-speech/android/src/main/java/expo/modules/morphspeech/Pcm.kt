package expo.modules.morphspeech

import kotlin.math.PI
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

// Pure computation part of audio data (does not depend on Android, unit tests exist in src/test): whisper requires 16 kHz mono float.

const val WHISPER_RATE = 16000

/** Interleaved multi-channel PCM -> mono (averaging channels). */
fun downmix(interleaved: FloatArray, frames: Int, channels: Int): FloatArray {
  if (channels == 1) return interleaved.copyOf(frames)
  val out = FloatArray(frames)
  for (f in 0 until frames) {
    var sum = 0f
    for (c in 0 until channels) sum += interleaved[f * channels + c]
    out[f] = sum / channels
  }
  return out
}

/**
 * Streaming resampler (windowed sinc low-pass + interpolation): during downsampling, filters out
 * frequencies above the Nyquist frequency of the new sample rate to prevent aliasing noise. Feed
 * chunks via push, and output chunks via sink; finally call finish to flush remaining output.
 */
class Resampler(srcRate: Int, private val dstRate: Int = WHISPER_RATE) {
  /** Number of input samples to advance per output sample. */
  private val step = srcRate.toDouble() / dstRate
  /** Cutoff frequency (relative to input Nyquist frequency). */
  private val cutoff = min(1.0, dstRate.toDouble() / srcRate) * 0.95
  /** Number of input samples to use on each side. */
  private val half = ceil(TAPS / cutoff).toInt()
  private val passthrough = srcRate == dstRate

  private var buf = FloatArray(4096)
  private var bufLen = 0
  /** buf[0] corresponds to this input sample index. */
  private var bufStart = 0L
  private var inputTotal = 0L
  private var nextOut = 0L

  fun push(input: FloatArray, count: Int, sink: (FloatArray, Int) -> Unit) {
    if (passthrough) {
      sink(input, count)
      return
    }
    ensure(bufLen + count)
    System.arraycopy(input, 0, buf, bufLen, count)
    bufLen += count
    inputTotal += count
    produce(sink, flush = false)
  }

  fun finish(sink: (FloatArray, Int) -> Unit) {
    if (passthrough) return
    produce(sink, flush = true)
  }

  private fun produce(sink: (FloatArray, Int) -> Unit, flush: Boolean) {
    // Total output count = input count ÷ step (rounded up); when not flushing, only counts when right-side samples are fully available.
    val limit = if (flush) ceil(inputTotal / step).toLong() else Long.MAX_VALUE
    val out = FloatArray(1024)
    var n = 0
    while (nextOut < limit) {
      val t = nextOut * step
      val center = floor(t).toLong()
      if (!flush && center + half >= bufStart + bufLen) break
      out[n++] = sample(t, center)
      nextOut++
      if (n == out.size) {
        sink(out, n)
        n = 0
      }
    }
    if (n > 0) sink(out, n)
    // Discard input no longer needed after dropping.
    val keepFrom = floor(nextOut * step).toLong() - half
    val drop = (keepFrom - bufStart).toInt().coerceIn(0, bufLen)
    if (drop > 0) {
      System.arraycopy(buf, drop, buf, 0, bufLen - drop)
      bufLen -= drop
      bufStart += drop
    }
  }

  private fun sample(t: Double, center: Long): Float {
    var sum = 0.0
    for (k in center - half + 1..center + half) {
      val i = (k - bufStart).toInt()
      if (i < 0 || i >= bufLen) continue
      val x = t - k
      sum += buf[i] * kernel(x)
    }
    return sum.toFloat()
  }

  private fun kernel(x: Double): Double {
    val u = x / half
    if (u <= -1 || u >= 1) return 0.0
    val window = 0.5 * (1 + cos(PI * u))
    val y = cutoff * x
    val sinc = if (y == 0.0) 1.0 else sin(PI * y) / (PI * y)
    return cutoff * sinc * window
  }

  private fun ensure(capacity: Int) {
    if (capacity <= buf.size) return
    buf = buf.copyOf(maxOf(capacity, buf.size * 2))
  }

  private companion object {
    const val TAPS = 8.0
  }
}

/** Dynamically growing float array. */
class FloatBuffer(initial: Int = 1 shl 16) {
  var data = FloatArray(initial)
    private set
  var size = 0
    private set

  fun append(values: FloatArray, count: Int) {
    if (size + count > data.size) data = data.copyOf(maxOf(size + count, data.size * 2))
    System.arraycopy(values, 0, data, size, count)
    size += count
  }

  /** Drop the first count elements. */
  fun dropFirst(count: Int) {
    System.arraycopy(data, count, data, 0, size - count)
    size -= count
  }
}

/**
 * Finds the quietest short segment in [from, to) (window samples, checked via RMS), returning its
 * middle position. When segmenting long recordings for transcription, cuts here to avoid
 * splitting in the middle of a word.
 */
fun quietestPoint(samples: FloatArray, from: Int, to: Int, window: Int): Int {
  if (to - from <= window) return (from + to) / 2
  var energy = 0.0
  for (i in from until from + window) energy += samples[i] * samples[i]
  var best = energy
  var bestStart = from
  for (start in from + 1..to - window) {
    val out = samples[start - 1]
    val inn = samples[start + window - 1]
    energy += inn * inn - out * out
    if (energy < best) {
      best = energy
      bestStart = start
    }
  }
  return bestStart + window / 2
}

/** Root mean square, for testing and debugging. */
fun rms(samples: FloatArray, from: Int = 0, to: Int = samples.size): Double {
  var sum = 0.0
  for (i in from until to) sum += samples[i] * samples[i]
  return sqrt(sum / (to - from))
}
