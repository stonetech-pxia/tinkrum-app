package expo.modules.morphmedia

import java.io.File
import java.io.FileOutputStream

// MP3 output (D-183): Neither Media3 nor the system has an MP3 encoder, so LAME compiled into the
// app (libmorphmp3.so, see src/main/cpp) is used. 16-bit PCM decoded by AudioPcm.decode is passed
// in chunk by chunk, writing to file as it encodes without loading the entire segment into memory.

class Mp3Writer(private val file: File, private val kbps: Int) {
  private val out = FileOutputStream(file)
  private var handle = 0L
  private var channels = 0
  private var buffer = ByteArray(0)

  /** The first chunk determines channels and sample rate (LAME resamples to an MP3-supported sample rate if needed). */
  fun write(samples: ShortArray, channels: Int, rate: Int) {
    if (handle == 0L) {
      handle = Mp3Encoder.nativeInit(rate, channels, kbps)
      if (handle == 0L) {
        out.close()
        throw MediaFailedException("mp3 encoder $rate Hz $channels ch $kbps kbps")
      }
      this.channels = channels
    }
    val frames = samples.size / this.channels
    // Worst-case requirement by LAME: 1.25 * sample count + 7200 bytes.
    val needed = frames * 5 / 4 + 7200
    if (buffer.size < needed) buffer = ByteArray(needed)
    val written = Mp3Encoder.nativeEncode(handle, samples, frames, buffer)
    if (written < 0) throw MediaFailedException("mp3 encode $written")
    out.write(buffer, 0, written)
  }

  fun close() {
    if (handle == 0L) {
      out.close()
      throw MediaUnsupportedException("no audio decoded")
    }
    if (buffer.size < 7200) buffer = ByteArray(7200)
    val written = Mp3Encoder.nativeFlush(handle, buffer)
    if (written > 0) out.write(buffer, 0, written)
    Mp3Encoder.nativeClose(handle)
    handle = 0L
    out.close()
  }

  /** When cancelled or on error: release the encoder and close the file (the file is deleted by the caller). */
  fun abort() {
    if (handle != 0L) Mp3Encoder.nativeClose(handle)
    handle = 0L
    out.close()
  }
}

object Mp3Encoder {
  init {
    System.loadLibrary("morphmp3")
  }

  @JvmStatic external fun nativeInit(sampleRate: Int, channels: Int, kbps: Int): Long

  @JvmStatic external fun nativeEncode(handle: Long, pcm: ShortArray, frames: Int, out: ByteArray): Int

  @JvmStatic external fun nativeFlush(handle: Long, out: ByteArray): Int

  @JvmStatic external fun nativeClose(handle: Long)
}
